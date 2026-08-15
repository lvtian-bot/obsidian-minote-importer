/**
 * @file 外部浏览器自动登录服务
 *
 * 原理：
 * 1. 启动一个使用独立用户目录的 Chrome/Edge（带 CDP 远程调试端口）；
 * 2. 在外部浏览器中正常登录小米账号；
 * 3. 插件通过 CDP 轮询浏览器的 Cookie 库（能拿到 HttpOnly Cookie）；
 * 4. 用拿到的 Cookie 请求 i.mi.com 的 profile 接口验证登录；
 * 5. 验证成功后自动保存 Cookie 并关闭调试浏览器。
 */
import { Notice, requestUrl } from 'obsidian';
import { get } from 'svelte/store';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import fs from 'fs';
import { createHash } from 'crypto';
import os from 'os';
import path from 'path';
import WebSocket from 'ws';

import MinoteApi from './minoteApi';
import { settingsStore } from './settings';

export interface LoginResult {
	success: boolean;
	cancelled?: boolean;
	message: string;
}

interface CdpTarget {
	id: string;
	type: string;
	url: string;
	title?: string;
	webSocketDebuggerUrl?: string;
}

interface CdpCookie {
	name: string;
	value: string;
}

interface CdpResponse {
	id?: number;
	result?: {
		cookies?: CdpCookie[];
	};
	error?: { message?: string };
}

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 1500;
const PROFILE_RETRY_INTERVAL_MS = 10_000;

export default class ExternalLoginService {
	private child: ChildProcess | null = null;
	private childExited = false;
	private childExitedAt = 0;
	private cancelled = false;
	private running = false;
	private forcedNavigation = new Set<string>();
	private readonly api = new MinoteApi();
	private readonly profileRoot: string;
	private readonly profileDir: string;

	constructor(vaultPath: string) {
		const resolved = path.resolve(vaultPath);
		const key = createHash('sha256').update(process.platform === 'win32' ? resolved.toLowerCase() : resolved).digest('hex');
		this.profileRoot = path.join(process.env.LOCALAPPDATA || os.homedir(), '.minote-importer');
		this.profileDir = path.join(this.profileRoot, key);
	}

	isRunning(): boolean {
		return this.running;
	}

	/**
	 * 在外部浏览器中登录（打开二维码登录页）。
	 */
	async startLogin(): Promise<LoginResult> {
		return this.runFlow('https://account.xiaomi.com/fe/service/login/qrcode');
	}

	/**
	 * 刷新 Cookie。如果独立浏览器目录里还保持着登录状态，
	 * 会自动直接抓取；否则会打开登录页等待用户登录。
	 */
	async startRefreshCookie(): Promise<LoginResult> {
		return this.runFlow(`https://${get(settingsStore).host}/note/h5`);
	}

	async logout(): Promise<void> {
		if (this.running) {
			new Notice('请先关闭登录窗口，再注销小米云服务');
			return;
		}
		this.running = true;
		settingsStore.actions.clearCookie();
		try {
			await this.clearBrowserProfile();
		} finally {
			this.running = false;
		}
	}

	private ensureProfileDir(): void {
		for (const directory of [this.profileRoot, this.profileDir]) {
			fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
			const stat = fs.lstatSync(directory);
			if (!stat.isDirectory() || stat.isSymbolicLink()) {
				throw new Error('Invalid dedicated browser profile directory');
			}
		}
	}

	dispose(): void {
		this.cancelled = true;
		this.stopBrowser();
	}

	private async runFlow(url: string): Promise<LoginResult> {
		if (this.running) {
			return { success: false, message: '登录流程正在进行中，请稍候' };
		}

		this.running = true;
		this.cancelled = false;
		this.forcedNavigation.clear();
		try {
			const browserPath = this.detectBrowserPath();
			if (!browserPath) {
				return {
					success: false,
					message: '未找到 Chrome/Edge/Chromium，请在插件高级设置里手动指定浏览器路径'
				};
			}

			const host = get(settingsStore).host;
			if (!['i.mi.com', 'eu.i.mi.com', 'us.i.mi.com', 'in.i.mi.com'].includes(host)) {
				return { success: false, message: '请选择有效的小米云服务域名' };
			}
			this.ensureProfileDir();

			const portFile = path.join(this.profileDir, 'DevToolsActivePort');
			fs.rmSync(portFile, { force: true });
			const child = spawn(
				browserPath,
				[
					'--remote-debugging-port=0',
					'--remote-debugging-address=127.0.0.1',
					`--user-data-dir=${this.profileDir}`,
					'--no-first-run',
					'--no-default-browser-check',
					'--disable-infobars',
					'--disable-session-crashed-bubble',
					`--app=${url}`,
					'--window-size=960,720'
				],
				{ stdio: 'ignore' }
			);
			this.child = child;
			this.childExited = false;
			this.childExitedAt = 0;

			child.once('error', (err) => {
				console.error('[minote-importer] failed to start browser', (err as NodeJS.ErrnoException).code);
				this.childExited = true;
				this.childExitedAt = Date.now();
			});

			child.once('exit', () => {
				this.childExited = true;
				this.childExitedAt = Date.now();
			});

			new Notice('Minote Importer：请在打开的浏览器窗口中完成小米账号登录');

			return await this.waitForValidCookie(portFile, host);
		} catch {
			return { success: false, message: '无法启动专用浏览器，请关闭登录窗口或检查浏览器设置后重试' };
		} finally {
			this.running = false;
			this.stopBrowser();
		}
	}

	private async waitForValidCookie(portFile: string, host: string): Promise<LoginResult> {
		const deadline = Date.now() + LOGIN_TIMEOUT_MS;
		let lastCheckedCookie = '';
		let lastCheckedAt = 0;

		while (Date.now() < deadline) {
			if (this.cancelled) {
				return { success: false, cancelled: true, message: '已取消登录' };
			}

			// 浏览器进程提前退出（例如配置目录被旧进程占用）时快速失败，
			// 不要傻等 5 分钟。
			if (this.childExited && Date.now() - this.childExitedAt > 5000) {
				return {
					success: false,
					message: '浏览器进程意外退出。可能已有一个使用相同配置目录的浏览器实例，请关闭后重试'
				};
			}

			try {
				const port = this.readDebugPort(portFile);
				const targets = port ? await this.fetchTargets(port) : [];
				for (const target of targets) {
					if (target.type !== 'page' || !target.webSocketDebuggerUrl?.startsWith(`ws://127.0.0.1:${port}/devtools/page/`)) {
						continue;
					}

					// 小米账号已经登录成功，但页面停在
					// account.xiaomi.com/fe/service/account 时，i.mi.com
					// 的 Cookie 还没有种下。这里复刻原插件的做法：强制把
					// 这个标签页导航到 i.mi.com/note/h5，完成跨域登录交接。
					if (
						target.url.startsWith('https://account.xiaomi.com/fe/service/account?cUserId=') &&
						!this.forcedNavigation.has(target.id)
					) {
						this.forcedNavigation.add(target.id);
						await this.navigatePage(target, `https://${host}/note/h5`);
						continue;
					}

					if (!target.url.startsWith(`https://${host}/`)) {
						continue;
					}
					const cookies = await this.readCookies(target, host);
					const cookieHeader = this.buildCookieHeader(cookies);
					if (this.cancelled || !cookieHeader || (cookieHeader === lastCheckedCookie && Date.now() - lastCheckedAt < PROFILE_RETRY_INTERVAL_MS)) {
						continue;
					}

					lastCheckedCookie = cookieHeader;
					lastCheckedAt = Date.now();
					const profile = await this.api.checkProfile(host, cookieHeader);
					if (profile.ok && !this.cancelled) {
						settingsStore.actions.setLogin(cookieHeader, profile.nickname || '小米账号');
						new Notice('Minote Importer：登录成功');
						return { success: true, message: '登录成功' };
					}
				}
			} catch {
				// 浏览器刚启动时，调试端口可能尚未就绪。
			}

			await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
		}

		return { success: false, message: '等待登录超时（5 分钟），请重试' };
	}

	private async fetchTargets(port: number): Promise<CdpTarget[]> {
		try {
			const resp = await requestUrl({
				url: `http://127.0.0.1:${port}/json`,
				method: 'GET',
				headers: { 'Accept': 'application/json' }
			});
			if (resp.status === 200 && Array.isArray(resp.json)) {
				return resp.json as CdpTarget[];
			}
		} catch (err) {
			// not ready yet
		}
		return [];
	}

	private readCookies(target: CdpTarget, host: string): Promise<CdpCookie[]> {
		return new Promise((resolve) => {
			let settled = false;
			let ws: WebSocket | null = null;
			let nextId = 1;
			const pending = new Map<number, (msg: CdpResponse) => void>();

			const finish = (cookies: CdpCookie[]) => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				try {
					ws?.terminate();
				} catch (_) {
					// ignore
				}
				resolve(cookies);
			};

			const timer = setTimeout(() => finish([]), 5000);

			try {
				ws = new WebSocket(target.webSocketDebuggerUrl as string, {
					handshakeTimeout: 4000,
					maxPayload: 8 * 1024 * 1024
				});
			} catch (_) {
				finish([]);
				return;
			}

			ws.on('open', () => {
				if (!ws) {
					finish([]);
					return;
				}

				// 打开网络域，确保能读取完整 Cookie（包含 HttpOnly）
				const enableId = nextId++;
				ws.send(JSON.stringify({ id: enableId, method: 'Network.enable' }));

				const cookieId = nextId++;
				pending.set(cookieId, (msg) => {
					const cookies = (msg?.result?.cookies || []) as CdpCookie[];
					finish(cookies);
				});
				ws.send(
					JSON.stringify({
						id: cookieId,
						method: 'Network.getCookies',
						params: {
							urls: [
								`https://${host}/`,
								`https://${host}/note/h5`,
								`https://${host}/status/lite/profile`
							]
						}
					})
				);
			});

			ws.on('message', (data: Buffer) => {
				try {
					const msg = JSON.parse(data.toString()) as CdpResponse;
					if (msg.id && pending.has(msg.id)) {
						pending.get(msg.id)?.(msg);
						pending.delete(msg.id);
					}
				} catch (_) {
					// ignore malformed messages
				}
			});

			ws.on('error', () => finish([]));
			ws.on('close', () => finish([]));
		});
	}

	private navigatePage(target: CdpTarget, url: string): Promise<void> {
		return new Promise((resolve) => {
			let settled = false;
			let ws: WebSocket | null = null;
			let nextId = 1;
			const pending = new Map<number, () => void>();

			const finish = () => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				try {
					ws?.terminate();
				} catch (_) {
					// ignore
				}
				resolve();
			};

			const timer = setTimeout(() => finish(), 5000);

			try {
				ws = new WebSocket(target.webSocketDebuggerUrl as string, {
					handshakeTimeout: 4000,
					maxPayload: 2 * 1024 * 1024
				});
			} catch (_) {
				finish();
				return;
			}

			ws.on('open', () => {
				if (!ws) {
					finish();
					return;
				}

				const enableId = nextId++;
				ws.send(JSON.stringify({ id: enableId, method: 'Page.enable' }));

				const navigateId = nextId++;
				pending.set(navigateId, () => finish());
				ws.send(JSON.stringify({ id: navigateId, method: 'Page.navigate', params: { url } }));
			});

			ws.on('message', (data: Buffer) => {
				try {
					const msg = JSON.parse(data.toString()) as CdpResponse;
					if (msg.id && pending.has(msg.id)) {
						pending.get(msg.id)?.();
						pending.delete(msg.id);
					}
				} catch (_) {
					// ignore malformed messages
				}
			});

			ws.on('error', () => finish());
			ws.on('close', () => finish());
		});
	}

	private buildCookieHeader(cookies: CdpCookie[]): string {
		if (!cookies.length) {
			return '';
		}
		return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
	}

	/**
	 * 查找浏览器可执行文件：优先用户设置，其次常见安装位置 / PATH。
	 */
	detectBrowserPath(): string {
		const configured = get(settingsStore).browserPath.trim();
		if (configured && fs.existsSync(configured)) {
			return configured;
		}

		const candidates: string[] = [];
		if (process.platform === 'win32') {
			const pf = process.env['PROGRAMFILES'] || 'C:\\Program Files';
			const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
			const local = process.env['LOCALAPPDATA'] || '';
			candidates.push(
				path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
				path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
				path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
				path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
				path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
				path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
				path.join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
				path.join(pf86, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')
			);
		} else if (process.platform === 'darwin') {
			candidates.push(
				'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
				'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
				'/Applications/Chromium.app/Contents/MacOS/Chromium',
				'/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
				'/Applications/Arc.app/Contents/MacOS/Arc'
			);
		} else {
			for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser']) {
				const found = spawnSync('which', [name], { encoding: 'utf8' });
				const line = found.stdout?.trim();
				if (line) {
					candidates.push(line);
				}
			}
		}

		for (const candidate of candidates) {
			if (candidate && fs.existsSync(candidate)) {
				return candidate;
			}
		}
		return '';
	}

	private readDebugPort(portFile: string): number {
		try {
			const port = Number(fs.readFileSync(portFile, 'utf8').split(/\r?\n/, 1)[0]);
			return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0;
		} catch {
			return 0;
		}
	}

	private stopBrowser(): void {
		const child = this.child;
		this.child = null;
		if (!child) {
			return;
		}

		try {
			child.kill('SIGTERM');
		} catch (_) {
			// already exited
		}

		// 双保险：2 秒后仍未退出则强制结束
		setTimeout(() => {
			if (child.exitCode !== null || child.signalCode !== null) {
				return;
			}
			try {
				child.kill('SIGKILL');
			} catch (_) {
				// already exited
			}
		}, 2000);
	}

	private async clearBrowserProfile(): Promise<void> {
		try {
			this.ensureProfileDir();
			await fs.promises.rm(this.profileDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
			new Notice('Minote Importer：已注销');
		} catch {
			new Notice('Minote Importer：已清除插件登录状态，专用浏览器数据清除失败');
		}
	}
}

/** 外部浏览器登录及小米云网页版笔记读取，源自 Halo0sama 的登录修复。 */
import { Notice, requestUrl } from 'obsidian';
import { get, writable } from 'svelte/store';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import fs from 'fs';
import { createHash } from 'crypto';
import os from 'os';
import path from 'path';
import WebSocket from 'ws';

import MinoteApi from './minoteApi';
import { readWebNote } from './webNote';
import { settingsStore } from './settings';

export interface LoginResult {
	success: boolean;
	message: string;
}

type BrowserSession = { host: string; portFile: string; confirmed: boolean };
type LoginStatus = 'idle' | 'waiting' | 'confirmed' | 'closed' | 'timed-out';

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

const LOGIN_TIMEOUT_MS = 5 * 60_000;
const LOGIN_POLL_MS = 2_000;
const PROFILE_RETRY_MS = 10_000;

export default class ExternalLoginService {
	readonly loginStatus = writable<LoginStatus>('idle');
	private child: ChildProcess | null = null;
	private childExited = false;
	private running = false;
	private session: BrowserSession | null = null;
	private loginTimer?: ReturnType<typeof setTimeout>;
	private loginDeadline = 0;
	private nextProfileCheck = 0;
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

	async startLogin(): Promise<LoginResult> {
		if (this.running) {
			return { success: false, message: '正在验证登录，请稍候' };
		}
		const host = get(settingsStore).host;
		if (!['i.mi.com', 'eu.i.mi.com', 'us.i.mi.com', 'in.i.mi.com'].includes(host)) {
			return { success: false, message: '请选择有效的小米云服务域名' };
		}
		const existing = this.session;
		if (existing?.host === host && !this.childExited) {
			try {
				const target = await this.findNotePage(existing);
				if (target) await this.sendCommand(target, 'Page.bringToFront', {});
			} catch {
				// An existing browser window can still be selected by the user.
			}
			if (!this.isCurrent(existing)) {
				return { success: false, message: '小米云窗口已关闭，请重新打开。' };
			}
			if (get(this.loginStatus) !== 'waiting') {
				this.watchLogin(existing);
			}
			return { success: true, message: '请在已打开的小米云窗口完成验证，Obsidian 会自动识别。' };
		}
		this.dispose();
		try {
			const browserPath = this.detectBrowserPath();
			if (!browserPath) {
				return { success: false, message: '未找到 Chrome 或 Edge，请在高级设置中指定浏览器路径' };
			}
			this.ensureProfileDir();
			const portFile = path.join(this.profileDir, 'DevToolsActivePort');
			fs.rmSync(portFile, { force: true });
			const child = spawn(browserPath, [
				'--remote-debugging-port=0',
				'--remote-debugging-address=127.0.0.1',
				`--user-data-dir=${this.profileDir}`,
				'--no-first-run',
				'--no-default-browser-check',
				`--app=https://${host}/note/h5#/`,
				'--window-size=960,720'
			], { stdio: 'ignore' });
			this.child = child;
			this.childExited = false;
			const onExit = () => {
				if (this.child === child) {
					this.childExited = true;
					clearTimeout(this.loginTimer);
					this.loginStatus.set('closed');
				}
			};
			child.once('error', onExit);
			child.once('exit', onExit);
			this.session = { host, portFile, confirmed: false };
			this.watchLogin(this.session);
			return { success: true, message: '请在小米云网页完成验证。看到 Obsidian 显示已登录后，即可导入笔记。' };
		} catch {
			return { success: false, message: '无法启动专用浏览器，请检查浏览器设置后重试' };
		}
	}

	private watchLogin(session: BrowserSession): void {
		clearTimeout(this.loginTimer);
		session.confirmed = false;
		this.loginDeadline = Date.now() + LOGIN_TIMEOUT_MS;
		this.nextProfileCheck = 0;
		this.loginStatus.set('waiting');
		this.loginTimer = setTimeout(() => void this.pollLogin(session), LOGIN_POLL_MS);
	}

	private async pollLogin(session: BrowserSession): Promise<void> {
		if (!this.isCurrent(session)) return;
		if (Date.now() >= this.loginDeadline) {
			this.loginStatus.set('timed-out');
			return;
		}
		try {
			if (Date.now() >= this.nextProfileCheck) {
				const result = await this.confirmLogin(false);
				if (result.success) new Notice(result.message);
			}
		} finally {
			if (this.isCurrent(session) && !session.confirmed) {
				this.loginTimer = setTimeout(() => void this.pollLogin(session), LOGIN_POLL_MS);
			}
		}
	}

	async confirmLogin(manual = true): Promise<LoginResult> {
		const session = this.session;
		if (!session || !this.isCurrent(session)) {
			return { success: false, message: '请重新打开小米云网页，保持窗口打开后再确认。' };
		}
		if (this.running) {
			return { success: false, message: '正在检查小米云登录状态，请稍候。' };
		}
		if (session.confirmed) {
			return { success: true, message: '小米云已登录，可以导入笔记。' };
		}
		this.running = true;
		try {
			const target = await this.findNotePage(session);
			if (!target || !await this.notesPageReady(target, session.host, manual) || !this.isCurrent(session)) {
				return { success: false, message: '请在小米云网页完成设备验证，打开笔记页面后再确认。' };
			}
			const { cookies } = await this.sendCommand<{ cookies: CdpCookie[] }>(target, 'Network.getCookies', {
				urls: [`https://${session.host}/`, `https://${session.host}/status/lite/profile`, `https://${session.host}/note/note/`]
			});
			const header = cookies.map(({ name, value }) => `${name}=${value}`).join('; ');
			if (!header || !this.isCurrent(session)) {
				return { success: false, message: '尚未读到小米云登录会话，请保持网页打开并重试。' };
			}
			this.nextProfileCheck = Date.now() + PROFILE_RETRY_MS;
			const profile = await this.api.checkProfile(session.host, header);
			if (!profile.ok) {
				return { success: false, message: '小米云未接受当前登录会话，请在网页重新登录后再确认。' };
			}
			if (!this.isCurrent(session) || !await this.notesPageReady(target, session.host, manual) || !this.isCurrent(session)) {
				return { success: false, message: '笔记网页已关闭或仍在验证，请保持网页打开后重试。' };
			}
			session.confirmed = true;
			clearTimeout(this.loginTimer);
			settingsStore.actions.setLogin(header, profile.nickname || '小米账号');
			this.loginStatus.set('confirmed');
			return { success: true, message: 'Minote Importer：小米云已登录，可以导入笔记。' };
		} catch {
			return { success: false, message: '暂时无法连接小米云网页，请保持插件打开的窗口并重试。' };
		} finally {
			this.running = false;
		}
	}

	private isCurrent(session: BrowserSession): boolean {
		return this.session === session && !this.childExited && session.host === get(settingsStore).host;
	}

	private async notesPageReady(target: string, host: string, manual: boolean): Promise<boolean> {
		// The manual action confirms the user can see the note. Automatic detection also checks the rendered layout.
		const page = await this.sendCommand<{ result?: { value?: boolean } }>(target, 'Runtime.evaluate', {
			expression: `location.origin === ${JSON.stringify(`https://${host}`)} &&
				/^\\/note(?:\\/h5)?\\/?$/.test(location.pathname) &&
				!document.querySelector('.e2ee-captcha-input input, #refresh_modal_confirm') &&
				(${manual} || [...document.querySelectorAll('[class*="note-list-"]')].some(list => list.getClientRects().length > 0))`,
			returnByValue: true
		});
		return page.result?.value === true;
	}

	async readEncryptedNote(noteId: string): Promise<string | null> {
		return this.readNotesPage([noteId]);
	}

	async readImage(image: { fileId: string; digest?: string }): Promise<ArrayBuffer | null> {
		const result = await this.readNotesPage(['', image], 45000, 64 * 1024 * 1024);
		if (!result) return null;
		const bytes = Buffer.from(result, 'base64');
		return Uint8Array.from(bytes).buffer;
	}

	private async readNotesPage(args: [string, { fileId: string; digest?: string }?], timeoutMs?: number, maxPayload?: number): Promise<string | null> {
		const session = this.session;
		if (!session?.confirmed || session.host !== get(settingsStore).host) {
			return null;
		}
		try {
			const target = await this.findNotePage(session);
			if (!target) {
				return null;
			}
			const evaluated = await this.sendCommand<{ result?: { value?: unknown }; exceptionDetails?: unknown }>(
				target, 'Runtime.evaluate', {
					expression: `(${readWebNote.toString()})(...${JSON.stringify([session.host, ...args])})`,
					awaitPromise: true,
					returnByValue: true
				}, timeoutMs, maxPayload
			);
			const content = evaluated.result?.value;
			return this.session === session && !evaluated.exceptionDetails && typeof content === 'string' ? content : null;
		} catch {
			return null;
		}
	}

	async logout(): Promise<void> {
		if (this.running) {
			new Notice('请先关闭登录窗口，再注销小米云服务');
			return;
		}
		this.running = true;
		settingsStore.actions.clearCookie();
		this.dispose();
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
		clearTimeout(this.loginTimer);
		this.session = null;
		this.stopBrowser();
		this.loginStatus.set('idle');
	}

	private async findNotePage(session: { host: string; portFile: string }): Promise<string | null> {
		const port = this.readDebugPort(session.portFile);
		if (!port || this.childExited) {
			return null;
		}
		const response = await requestUrl({ url: `http://127.0.0.1:${port}/json` });
		const targets: CdpTarget[] = response.json;
		const page = Array.isArray(targets) && targets.find(target => {
			if (target.type !== 'page' || typeof target.url !== 'string' || !target.url.startsWith('https://')) return false;
			const url = new URL(target.url);
			return url.origin === `https://${session.host}`
				&& /^\/note(?:\/h5)?\/?$/.test(url.pathname)
				&& target.webSocketDebuggerUrl?.startsWith(`ws://127.0.0.1:${port}/devtools/page/`);
		});
		return page && page.webSocketDebuggerUrl || null;
	}

	private sendCommand<T>(endpoint: string, method: string, params: object, timeoutMs = 15000, maxPayload = 8 * 1024 * 1024): Promise<T> {
		return new Promise((resolve, reject) => {
			const socket = new WebSocket(endpoint, { handshakeTimeout: 4000, maxPayload });
			let settled = false;
			const finish = (error: Error | null, result?: T) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				socket.terminate();
				if (error) reject(error);
				else resolve(result as T);
			};
			const timeout = new Error('Browser command unavailable');
			const timer = setTimeout(() => finish(timeout), timeoutMs);
			socket.on('error', () => finish(timeout));
			socket.on('close', () => finish(timeout));
			socket.on('open', () => socket.send(JSON.stringify({ id: 1, method, params })));
			socket.on('message', data => {
				try {
					const message = JSON.parse(data.toString());
					if (message.id === 1) {
						finish(message.error ? timeout : null, message.result);
					}
				} catch {
					finish(timeout);
				}
			});
		});
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

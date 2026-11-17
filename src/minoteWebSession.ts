/** 小米笔记内嵌网页会话；认证凭据仅在请求时读取，不写入插件配置。 */
import { writable } from 'svelte/store';
import { createHash } from 'crypto';
import path from 'path';
import MinoteApi from './minoteApi';
import { readWebNote, type EncryptedNote } from './webNote';
import { ImportCancelledError, WebSessionError, throwIfCancelled, waitFor } from './importControl';

export interface AccountState { loggedIn: boolean; nickname: string; checking: boolean }
export interface WebSessionSnapshot { host: string; cookie: string; accountKey: string; generation: number }
interface BrowserCookie { name: string; value: string; domain: string; path: string }
interface PageState { origin: string; path: string; ready: boolean; challenge: boolean }
interface DebuggerApi {
	isAttached(): boolean;
	attach(version: string): void;
	detach(): void;
	sendCommand(method: string, params: object): Promise<any>;
}
interface WebContents {
	id: number;
	isDestroyed(): boolean;
	debugger: DebuggerApi;
	session: {
		cookies: { get(filter: object): Promise<BrowserCookie[]>; flushStore(): Promise<void> };
		clearStorageData(): Promise<void>;
		clearCache(): Promise<void>;
	};
}
export interface MinoteWebview extends HTMLElement {
	getWebContentsId(): number;
	loadURL(url: string): Promise<void>;
	reload(): void;
}

const HOSTS = new Set(['i.mi.com', 'eu.i.mi.com', 'us.i.mi.com', 'in.i.mi.com']);
const MAX_IMAGE_BYTES = 48 * 1024 * 1024;

export function browserPartition(vaultPath: string, host: string): string {
	const resolved = path.resolve(vaultPath);
	const key = createHash('sha256').update((process.platform === 'win32' ? resolved.toLowerCase() : resolved) + '\n' + host).digest('hex');
	return 'persist:minote-importer-' + key;
}

export default class MinoteWebSession {
	readonly accountState = writable<AccountState>({ loggedIn: false, nickname: '', checking: false });
	private view?: MinoteWebview;
	private contents?: WebContents;
	private generation = 0;
	private attachedDebugger = false;
	private snapshot?: WebSessionSnapshot;
	private signal?: AbortSignal;
	private verified?: { key: string; generation: number; checkedAt: number };
	private retryProfileAt = 0;
	private lastProfileKey = '';
	private profileUnavailable = false;
	private checkPending?: Promise<void>;
	private listeners: (() => void)[] = [];
	private monitor?: ReturnType<typeof setInterval>;
	private invalidated = new Set<() => void>();

	constructor(readonly vaultPath: string, private readonly getHost: () => string) {}

	get host() {
		const host = this.getHost();
		if (!HOSTS.has(host)) throw new WebSessionError('请选择有效的小米云服务域名。');
		return host;
	}
	get url() { return `https://${this.host}/note/h5#/`; }
	get partition() { return browserPartition(this.vaultPath, this.host); }
	get isOpen() { return !!this.view; }

	onInvalidated(callback: () => void): () => void {
		this.invalidated.add(callback);
		return () => this.invalidated.delete(callback);
	}
	private invalidate() {
		const active = !!this.snapshot;
		this.generation++;
		this.snapshot = undefined;
		this.verified = undefined;
		this.retryProfileAt = 0;
		this.lastProfileKey = '';
		this.profileUnavailable = false;
		if (active) for (const callback of this.invalidated) callback();
	}
	attach(view: MinoteWebview): void {
		this.detach();
		this.view = view;
		const listen = (name: string, callback: EventListener) => {
			view.addEventListener(name, callback);
			this.listeners.push(() => view.removeEventListener(name, callback));
		};
		listen('dom-ready', () => {
			try {
				const { remote } = require('electron');
				this.contents = remote.webContents.fromId(view.getWebContentsId());
				void this.refreshAccount();
			} catch { this.contents = undefined; }
		});
		listen('did-navigate-in-page', () => { void this.refreshAccount(); });
		listen('did-start-navigation', event => {
			const navigation = event as Event & { isMainFrame: boolean; isInPlace: boolean };
			if (navigation.isMainFrame && !navigation.isInPlace) this.invalidate();
		});
		listen('render-process-gone', () => this.invalidate());
		listen('destroyed', () => this.invalidate());
		// 平时只追踪本地会话变化；发起导入时才主动复核已知账号。
		this.monitor = setInterval(() => { void this.refreshAccount(); }, 10_000);
	}
	detach(): void {
		this.invalidate();
		clearInterval(this.monitor);
		for (const remove of this.listeners) remove();
		this.listeners = [];
		if (this.attachedDebugger) {
			try { this.contents?.debugger.detach(); } catch { /* 页面已经销毁。 */ }
		}
		this.attachedDebugger = false;
		this.contents = undefined;
		this.view = undefined;
	}
	private getContents(): WebContents {
		if (!this.contents || this.contents.isDestroyed()) throw new WebSessionError();
		return this.contents;
	}
	private async cookie(): Promise<string> {
		const cookies = await this.getContents().session.cookies.get({ url: `https://${this.host}/note/v2/note/` });
		return cookies.sort((a, b) => b.path.length - a.path.length).map(item => `${item.name}=${item.value}`).join('; ');
	}
	private async send<T = any>(method: string, params: object = {}, timeout = 15_000): Promise<T> {
		throwIfCancelled(this.signal);
		const contents = this.getContents();
		const generation = this.generation;
		try {
			if (!contents.debugger.isAttached()) {
				contents.debugger.attach('1.3');
				this.attachedDebugger = true;
			}
			const result = await waitFor(contents.debugger.sendCommand(method, params), timeout, this.signal);
			throwIfCancelled(this.signal);
			if (generation !== this.generation) throw new WebSessionError();
			return result;
		} catch (error) {
			if (error instanceof ImportCancelledError) throw error;
			throw new WebSessionError();
		}
	}
	private async evaluate(expression: string, timeout?: number, allowMissing = false): Promise<any> {
		const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeout);
		if (result.exceptionDetails) {
			if (allowMissing) return null;
			throw new WebSessionError('小米笔记网页暂时无法读取，请重试。');
		}
		return result.result?.value;
	}
	private pageState(): Promise<PageState> {
		return this.evaluate(`({origin:location.origin,path:location.pathname,challenge:!!document.querySelector('.e2ee-captcha-input input,#refresh_modal_confirm'),ready:[...document.querySelectorAll('[class*="note-list-"]')].some(e=>e.getClientRects().length>0)&&!!window.webpackJsonp})`);
	}
	refreshAccount(revalidate = false): Promise<void> {
		if (this.checkPending) return this.checkPending;
		this.checkPending = this.checkAccount(revalidate).finally(() => { this.checkPending = undefined; });
		return this.checkPending;
	}
	private async checkAccount(revalidate: boolean): Promise<void> {
		if (!this.contents || this.contents.isDestroyed()) return;
		const generation = this.generation;
		try {
			const host = this.host;
			const cookie = await this.cookie();
			if (generation !== this.generation) return;
			const api = new MinoteApi({ host, cookie });
			const key = api.accountKey;
			if (this.snapshot && key !== this.snapshot.accountKey) { this.invalidate(); return; }
			if (!key) {
				this.verified = undefined;
				this.retryProfileAt = 0;
				this.lastProfileKey = '';
				this.profileUnavailable = false;
				this.accountState.set({ loggedIn: false, nickname: '', checking: false });
				return;
			}
			if (this.verified?.key === key && !revalidate) return;
			if (!revalidate && this.lastProfileKey === key) return;
			if (this.lastProfileKey === key && Date.now() < this.retryProfileAt) return;
			this.lastProfileKey = key;
			this.retryProfileAt = Date.now() + 20_000;
			this.accountState.update(state => ({ ...state, checking: true }));
			const profile = await waitFor(api.checkProfile(host, cookie), 15_000);
			const current = new MinoteApi({ host, cookie: await this.cookie() });
			if (generation !== this.generation || current.accountKey !== key) return;
			this.profileUnavailable = profile.status === 'unavailable';
			if (profile.ok) {
				this.verified = { key, generation, checkedAt: Date.now() };
				this.accountState.set({ loggedIn: true, nickname: profile.nickname || '小米账号', checking: false });
			} else {
				this.verified = undefined;
				if (profile.status === 'unauthenticated') {
					this.accountState.set({ loggedIn: false, nickname: '', checking: false });
					if (this.snapshot) this.invalidate();
				}
			}
		} catch {
			if (generation === this.generation) {
				this.verified = undefined;
				this.profileUnavailable = true;
			}
		} finally {
			this.accountState.update(state => state.checking ? { ...state, checking: false } : state);
		}
	}
	async ensureReady(options: { signal: AbortSignal; onWaiting: () => void }): Promise<WebSessionSnapshot> {
		this.signal = options.signal;
		this.snapshot = undefined;
		const deadline = Date.now() + 5 * 60_000;
		let redirected = false;
		while (Date.now() < deadline) {
			throwIfCancelled(options.signal);
			if (!this.view) throw new WebSessionError();
			let unavailable = false;
			if (this.contents && !this.contents.isDestroyed()) {
				try {
					const generation = this.generation;
					const host = this.host;
					await waitFor(this.refreshAccount(true), 16_000, options.signal);
					const page = await this.pageState();
					const onNotes = page.origin === `https://${host}` && /^\/note(?:\/h5)?\/?$/.test(page.path);
					if (onNotes && page.ready && !page.challenge) {
						const contents = this.getContents();
						const cookie = await this.cookie();
						const accountKey = new MinoteApi({ host, cookie }).accountKey;
						unavailable = this.profileUnavailable;
						if (accountKey && this.verified?.key === accountKey && this.verified.generation === generation
							&& Date.now() - this.verified.checkedAt < 20_000) {
							await contents.session.cookies.flushStore().catch(() => undefined);
							throwIfCancelled(options.signal);
							if (generation === this.generation && host === this.host && this.verified?.key === accountKey) {
								this.snapshot = { host, cookie, accountKey, generation };
								return this.snapshot;
							}
						}
					}
					// 账号回调已完成但网页未跳转时，仅导航到官方笔记入口。
					if (this.verified?.generation === generation && generation === this.generation
						&& !redirected && page.origin === 'https://account.xiaomi.com' && !/\/login\//.test(page.path)) {
						redirected = true;
						await this.view.loadURL(this.url);
					}
				} catch (error) {
					if (error instanceof ImportCancelledError || options.signal.aborted || !this.view) throw error;
					// 登录跳转会替换文档；准备阶段允许新页面加载后继续检查。
				}
			}
			if (unavailable) throw new WebSessionError('暂时无法检查小米账号，请检查网络后重试。');
			options.onWaiting();
			await waitFor(new Promise<void>(resolve => setTimeout(resolve, 2_000)), 3_000, options.signal);
		}
		throw new WebSessionError('等待小米登录或设备验证超时，请完成验证后重新导入。');
	}
	async assertActive(): Promise<void> {
		throwIfCancelled(this.signal);
		const snapshot = this.snapshot;
		if (!snapshot || snapshot.generation !== this.generation || snapshot.host !== this.host) throw new WebSessionError();
		const current = new MinoteApi({ host: this.host, cookie: await this.cookie() });
		throwIfCancelled(this.signal);
		if (snapshot !== this.snapshot || snapshot.generation !== this.generation || snapshot.host !== this.host) throw new WebSessionError();
		if (current.accountKey !== snapshot.accountKey) {
			this.invalidate();
			throw new WebSessionError('小米账号已变化，本轮导入已停止。');
		}
	}
	finishTask(): void { this.snapshot = undefined; this.signal = undefined; }
	async readEncryptedNote(note: EncryptedNote): Promise<string | null> {
		await this.assertActive();
		const content = await this.evaluate(`(${readWebNote.toString()})(...${JSON.stringify([this.host, note])})`, undefined, true);
		await this.assertActive();
		return typeof content === 'string' ? content : null;
	}
	async readImage(image: { fileId: string; digest?: string }): Promise<ArrayBuffer | null> {
		await this.assertActive();
		const result = await this.evaluate(`(${readWebNote.toString()})(...${JSON.stringify([this.host, null, image])})`, 45_000, true);
		await this.assertActive();
		if (result === 'legacy-image') return this.readLegacyImage(image.fileId);
		if (typeof result !== 'string' || result.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) return null;
		const bytes = Buffer.from(result, 'base64');
		return bytes.length ? Uint8Array.from(bytes).buffer : null;
	}
	private async readLegacyImage(fileId: string): Promise<ArrayBuffer | null> {
		const contents = this.getContents();
		const page = await this.send('Page.getFrameTree');
		const frame = page.frameTree.frame;
		const pageUrl = new URL(frame.url);
		if (pageUrl.origin !== `https://${this.host}` || !/^\/note(?:\/h5)?\/?$/.test(pageUrl.pathname)) throw new WebSessionError();
		const url = `https://${this.host}/file/full?` + new URLSearchParams({ type: 'note_img', fileid: fileId });
		const { resource } = await this.send('Network.loadNetworkResource', {
			frameId: frame.id, url, options: { disableCache: false, includeCredentials: true }
		}, 45_000);
		if (!resource.stream) return null;
		try {
			const contentType = Object.entries(resource.headers ?? {}).find(([key]) => key.toLowerCase() === 'content-type')?.[1];
			if (!resource.success || resource.httpStatusCode !== 200 || !/^image\//i.test(String(contentType ?? ''))) return null;
			const chunks: Buffer[] = [];
			let size = 0;
			while (true) {
				const chunk = await this.send('IO.read', { handle: resource.stream, size: 1024 * 1024 });
				const bytes = Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8');
				chunks.push(bytes); size += bytes.length;
				if (size > MAX_IMAGE_BYTES || (!bytes.length && !chunk.eof)) return null;
				if (chunk.eof) { await this.assertActive(); return size ? Uint8Array.from(Buffer.concat(chunks, size)).buffer : null; }
			}
		} finally {
			// 取消后仍须关闭资源；不能经过会拒绝已取消任务的 send 包装。
			if (!contents.isDestroyed()) {
				try { await waitFor(contents.debugger.sendCommand('IO.close', { handle: resource.stream }), 3_000); }
				catch { /* 页面已经重建或流已关闭。 */ }
			}
		}
	}
	async logout(): Promise<void> {
		this.invalidate();
		const browserSession = this.contents && !this.contents.isDestroyed() ? this.contents.session
			: require('electron').remote.session.fromPartition(this.partition);
		await browserSession.clearStorageData();
		await browserSession.clearCache();
		this.accountState.set({ loggedIn: false, nickname: '', checking: false });
		await this.view?.loadURL(this.url);
	}
	dispose(): void { this.detach(); this.invalidated.clear(); }
}

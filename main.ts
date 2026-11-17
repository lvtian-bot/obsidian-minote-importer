/** 小米官方网页入口及单向导入任务。 */
import { FileSystemAdapter, Menu, Notice, Plugin } from 'obsidian';
import { get } from 'svelte/store';
import { importProgress, runtimeCredentials, settingsStore } from './src/settings';
import { MinoteSettingTab } from './src/settingTab';
import FileManager from './src/fileManager';
import MinoteApi from './src/minoteApi';
import NoteSyncer from './src/noteSyncer';
import MinoteWebSession from './src/minoteWebSession';
import { MINOTE_VIEW_TYPE, MinoteView } from './src/minoteView';
import { assertImportActive, ImportCancelledError, WebSessionError } from './src/importControl';

export default class MinotePlugin extends Plugin {
	webSession!: MinoteWebSession;
	private syncing = false;
	private controller?: AbortController;
	private activeTask?: Promise<void>;
	private opening?: Promise<MinoteView>;

	async onload() {
		await settingsStore.initialize(this);
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) throw new Error('Minote Importer requires a desktop vault');
		this.webSession = new MinoteWebSession(adapter.getBasePath(), () => get(settingsStore).host);
		const settings = get(settingsStore);
		this.webSession.accountState.set({ loggedIn: settings.accountLoggedIn, nickname: settings.user, checking: false });
		this.register(this.webSession.accountState.subscribe(state => {
			settingsStore.actions.setAccountState(state.loggedIn, state.nickname);
		}));
		this.register(this.webSession.onInvalidated(() => this.cancelImport()));
		this.registerView(MINOTE_VIEW_TYPE, leaf => new MinoteView(leaf, this.webSession, {
			import: force => this.startSync(force), cancel: () => this.cancelImport(), isImporting: () => this.syncing
		}));
		const ribbon = this.addRibbonIcon('cloud-download', '打开小米笔记', () => { void this.openMinote().catch(() => new Notice('无法打开小米笔记，请重试。')); });
		this.registerDomEvent(ribbon, 'contextmenu', event => {
			event.preventDefault();
			new Menu()
				.addItem(item => item.setTitle('导入小米笔记').setIcon('refresh-ccw').onClick(() => this.startSync()))
				.addItem(item => item.setTitle('全量导入小米笔记').setIcon('refresh-ccw-dot').onClick(() => this.startSync(true)))
				.showAtMouseEvent(event);
		});
		this.addCommand({ id: 'open', name: '打开小米笔记', callback: () => { void this.openMinote(); } });
		this.addCommand({ id: 'import', name: '导入小米笔记', callback: () => { void this.startSync(); } });
		this.addCommand({ id: 'import-all', name: '全量导入小米笔记', callback: () => { void this.startSync(true); } });
		this.addCommand({ id: 'login', name: '登录小米云服务', callback: () => { void this.openMinote(); } });
		this.addCommand({ id: 'logout', name: '注销小米云服务登录', callback: () => { void this.logout(); } });
		this.addSettingTab(new MinoteSettingTab(this.app, this, this.webSession));
	}

	openMinote(): Promise<MinoteView> {
		return this.opening ??= this.revealMinote().finally(() => { this.opening = undefined; });
	}

	private async revealMinote(): Promise<MinoteView> {
		const leaf = this.app.workspace.getLeavesOfType(MINOTE_VIEW_TYPE)[0] ?? this.app.workspace.getLeaf('tab');
		if (leaf.view.getViewType() !== MINOTE_VIEW_TYPE) await leaf.setViewState({ type: MINOTE_VIEW_TYPE, active: true });
		await this.app.workspace.revealLeaf(leaf);
		return leaf.view as MinoteView;
	}
	isImporting() { return this.syncing; }
	cancelImport(): void { this.controller?.abort(); }
	async logout(): Promise<void> {
		this.cancelImport();
		await this.activeTask;
		try {
			await this.webSession.logout();
			settingsStore.actions.clearCookie();
		} catch { new Notice('退出登录未完成，请重试。'); }
	}
	async switchHost(host: string): Promise<void> {
		if (this.syncing) { new Notice('请先取消导入，再切换小米云服务域名。'); return; }
		this.webSession.detach();
		settingsStore.actions.setHost(host);
		this.webSession.accountState.set({ loggedIn: false, nickname: '', checking: false });
		const leaf = this.app.workspace.getLeavesOfType(MINOTE_VIEW_TYPE)[0];
		if (leaf) await (leaf.view as MinoteView).navigateToCurrentHost();
	}
	startSync(force = false): Promise<void> {
		if (this.syncing) { new Notice('正在导入小米笔记，请勿重复点击'); return this.activeTask ?? Promise.resolve(); }
		this.syncing = true;
		this.controller = new AbortController();
		this.activeTask = this.runImport(force, this.controller.signal);
		return this.activeTask;
	}
	private async runImport(force: boolean, signal: AbortSignal): Promise<void> {
		const { noteLocation } = get(settingsStore);
		const progress = new Notice('正在准备小米云连接…', 0);
		const updateProgress = (message: string) => { importProgress.set(message); progress.setMessage(message); };
		updateProgress('正在准备小米云连接…');
		try {
			await this.openMinote();
			const snapshot = await this.webSession.ensureReady({ signal, onWaiting: () => {
				updateProgress('请在页面中完成登录或设备验证，完成后将自动继续导入。');
			} });
			settingsStore.actions.setLogin(snapshot.cookie, get(this.webSession.accountState).nickname);
			const control = { signal, assertActive: () => this.webSession.assertActive() };
			await assertImportActive(control);
			const vault = this.app.vault;
			const fileManager = new FileManager(vault, vault.adapter as FileSystemAdapter, noteLocation,
				() => assertImportActive(control));
			const syncer = new NoteSyncer(fileManager, new MinoteApi(snapshot), this.webSession,
				record => settingsStore.actions.checkpointMove(fileManager.destination, record));
			updateProgress(`正在读取小米云笔记清单… 保存位置：${fileManager.destination}`);
			let nextUpdate = 0;
			const result = await syncer.sync(force, counts => {
				const processed = counts.count + counts.skipped + counts.locked + counts.failed;
				if (Date.now() < nextUpdate && processed < counts.total) return;
				nextUpdate = Date.now() + 500;
				updateProgress(`正在导入小米笔记，已处理 ${processed}/${counts.total} 篇。保存位置：${fileManager.destination}`);
			}, control);
			const { total, count, skipped, locked, failed, partial, deleted, failuresByStep, synced } = result;
			const status = result.interrupted || (locked || failed || partial ? '导入结束，仍有内容待处理' : '导入完成');
			const breakdown = Object.entries(failuresByStep).map(([step, amount]) => `${step} ${amount} 篇`).join('、');
			const details = breakdown ? ` 失败环节：${breakdown}。` : '';
			const summary = `${status}。保存位置：${fileManager.destination}。共 ${total} 篇，写入 ${count} 篇，已在本地且无变化 ${skipped} 篇，待解密 ${locked} 篇，失败 ${failed} 篇，移至回收站 ${deleted} 篇。已写入的笔记中有 ${partial} 篇图片待补齐。${details}`;
			const preserveHistory = result.interrupted && !synced.length && !count && !deleted;
			await settingsStore.actions.setImportResult(fileManager.destination, summary, preserveHistory ? undefined : synced);
			new Notice(summary, 15000);
		} catch (error) {
			const status = error instanceof ImportCancelledError || signal.aborted ? '导入已取消'
				: error instanceof WebSessionError ? error.message : '导入中断，请检查小米云连接、网络及保存目录后重试。';
			const summary = `${status} 保存位置：${noteLocation}。`;
			await settingsStore.actions.setImportResult(noteLocation, summary).catch(() => undefined);
			new Notice(summary, 10000);
		} finally {
			this.webSession.finishTask();
			runtimeCredentials.set('');
			this.syncing = false;
			this.controller = undefined;
			progress.hide();
			importProgress.set('');
		}
	}
	onunload(): void {
		this.cancelImport();
		this.app.workspace.detachLeavesOfType(MINOTE_VIEW_TYPE);
		this.webSession?.dispose();
	}
}

import { ButtonComponent, ItemView, Menu, Notice, WorkspaceLeaf } from 'obsidian';
import { get } from 'svelte/store';
import MinoteWebSession, { type MinoteWebview } from './minoteWebSession';
import { importProgress, settingsStore } from './settings';

export const MINOTE_VIEW_TYPE = 'minote-web-view';
export interface MinoteViewActions {
	import(force?: boolean): Promise<void>;
	cancel(): void;
	isImporting(): boolean;
}

/** 自行创建网页，不依赖 Obsidian 的网页查看器核心插件。 */
export class MinoteView extends ItemView {
	private webview?: MinoteWebview;
	private unsubscribe: (() => void)[] = [];
	constructor(leaf: WorkspaceLeaf, readonly session: MinoteWebSession, private readonly actions: MinoteViewActions) {
		super(leaf);
	}
	getViewType() { return MINOTE_VIEW_TYPE; }
	getDisplayText() { return '小米笔记'; }
	getIcon() { return 'cloud-download'; }
	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass('minote-web-content');
		this.contentEl.createEl('style', { text: `
.minote-web-content{display:flex;flex-direction:column;padding:0!important;min-height:0;height:100%}
.minote-web-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:10px 12px;border-bottom:1px solid var(--background-modifier-border);background:var(--background-primary)}
.minote-web-account{font-size:var(--font-ui-small);color:var(--text-muted);margin-right:auto;min-width:72px}
.minote-web-toolbar button{flex-shrink:0}
.minote-web-toolbar .minote-web-more{padding-left:7px;padding-right:7px}
.minote-web-frame{display:flex;flex:1;width:100%;min-height:0;border:0}
.minote-web-status{padding:8px 12px;border-top:1px solid var(--background-modifier-border);color:var(--text-muted);font-size:var(--font-ui-small);overflow-wrap:anywhere}
.minote-web-status:empty{display:none}
` });
		const toolbar = this.contentEl.createDiv({ cls: 'minote-web-toolbar' });
		const account = toolbar.createDiv({ cls: 'minote-web-account' });
		const start = new ButtonComponent(toolbar).setButtonText('导入到 Obsidian').setCta().onClick(() => this.actions.import());
		const more = new ButtonComponent(toolbar).setIcon('chevron-down').setTooltip('导入选项').onClick(event => {
			new Menu().addItem(item => item.setTitle('全量导入').setIcon('refresh-cw')
				.onClick(() => this.actions.import(true))).showAtMouseEvent(event);
		});
		more.buttonEl.addClass('minote-web-more');
		const refresh = new ButtonComponent(toolbar).setIcon('refresh-cw').setTooltip('刷新网页').onClick(() => {
			if (this.actions.isImporting()) return;
			this.webview?.reload();
		});
		const cancel = new ButtonComponent(toolbar).setButtonText('取消导入').onClick(() => this.actions.cancel());
		const status = this.contentEl.createDiv({ cls: 'minote-web-status' });
		status.setAttribute('role', 'status');
		this.unsubscribe.push(this.session.accountState.subscribe(state => {
			account.setText((state.loggedIn ? `已登录 · ${state.nickname}` : '未登录') + (state.checking ? ' · 正在检查…' : ''));
			account.toggleClass('is-loading', state.checking);
			account.setAttribute('aria-busy', String(state.checking));
		}));
		const updateStatus = () => {
			const message = get(importProgress);
			const busy = this.actions.isImporting();
			start.setDisabled(busy); more.setDisabled(busy); refresh.setDisabled(busy);
			cancel.buttonEl.toggle(busy);
			status.setText(message || get(settingsStore).lastImportSummary);
		};
		this.unsubscribe.push(importProgress.subscribe(updateStatus), settingsStore.subscribe(updateStatus));
		const frame = this.contentEl.doc.createElement('webview') as MinoteWebview;
		frame.addClass('minote-web-frame');
		frame.setAttribute('partition', this.session.partition);
		frame.setAttribute('webpreferences', 'contextIsolation=yes,nodeIntegration=no,sandbox=yes');
		frame.setAttribute('aria-label', '小米笔记网页');
		this.webview = frame;
		this.session.attach(frame);
		frame.addEventListener('did-fail-load', event => {
			if ((event as Event & { errorCode: number }).errorCode !== -3) status.setText('小米笔记网页加载失败，请刷新后重试。');
		});
		frame.addEventListener('render-process-gone', () => {
			this.actions.cancel();
			status.setText('小米笔记网页已停止，请刷新后重试。');
		});
		// 普通链接保留在专用容器；不把远程网页的 Node 或任意弹窗权限放开。
		frame.setAttribute('src', this.session.url);
		this.contentEl.insertBefore(frame, status);
	}
	async navigateToCurrentHost(): Promise<void> {
		if (this.actions.isImporting()) {
			new Notice('请先取消导入，再切换小米云服务域名。');
			return;
		}
		// partition 只能在首次导航前指定；切域名时重新创建容器。
		this.session.detach();
		for (const unsubscribe of this.unsubscribe) unsubscribe();
		this.unsubscribe = [];
		await this.onOpen();
	}
	async onClose(): Promise<void> {
		this.actions.cancel();
		this.session.detach();
		for (const unsubscribe of this.unsubscribe) unsubscribe();
		this.unsubscribe = [];
		this.webview = undefined;
	}
}

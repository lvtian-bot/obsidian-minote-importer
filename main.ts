/**
 * @file 插件主函数
 * @author Emac (external-browser login contribution by Halo0sama)
 * @date 2025-01-05
 */
import { FileSystemAdapter, Menu, Notice, Plugin } from 'obsidian';
import { get } from 'svelte/store';

import { settingsStore } from './src/settings';
import { MinoteSettingTab } from './src/settingTab';
import FileManager from './src/fileManager';
import MinoteApi from './src/minoteApi';
import NoteSyncer from './src/noteSyncer';
import ExternalLoginService from './src/externalLogin';

export default class MinotePlugin extends Plugin {
	private noteSyncer: NoteSyncer;
	private externalLogin: ExternalLoginService;
	private syncing = false;

	async onload() {
		await settingsStore.initialize(this);

		const fileManager = new FileManager(this.app.vault, this.app.metadataCache);
		const minoteApi = new MinoteApi();
		this.noteSyncer = new NoteSyncer(fileManager, minoteApi);
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) {
			throw new Error('Minote Importer requires a desktop vault');
		}
		this.externalLogin = new ExternalLoginService(adapter.getBasePath());

		const ribbonEl = this.addRibbonIcon('cloud-download', '导入小米笔记', (event) => {
			if (event.button === 0) {
				this.startSync();
			}
		});

		ribbonEl.addEventListener('contextmenu', (event: MouseEvent) => {
			event.preventDefault();
			event.stopPropagation(); // 阻止事件传播

			const preventDefaultMouseDown = (mouseDownEvent: MouseEvent) => {
				mouseDownEvent.preventDefault();
			};

			// 额外阻止mousedown事件的默认行为
			window.addEventListener('mousedown', preventDefaultMouseDown);

			const menu = new Menu();
			menu.addItem((item) =>
				item
					.setTitle('导入小米笔记')
					.setIcon('refresh-ccw')
					.onClick(() => {
						this.startSync();
					})
			);

			menu.addItem((item) =>
				item
					.setTitle('全量导入小米笔记')
					.setIcon('refresh-ccw-dot')
					.onClick(() => {
						this.startSync(true);
					})
			);

			menu.showAtMouseEvent(event);
			menu.onHide(() => {
				window.removeEventListener('mousedown', preventDefaultMouseDown);
			});
		});

		this.addCommand({
			id: 'import',
			name: '导入小米笔记',
			callback: () => {
				this.startSync();
			}
		});

		this.addCommand({
			id: 'import-all',
			name: '全量导入小米笔记',
			callback: () => {
				this.startSync(true);
			}
		});

		this.addCommand({
			id: 'login',
			name: '使用外部浏览器登录小米云服务',
			callback: async () => {
				const result = await this.externalLogin.startLogin();
				if (!result.success) {
					new Notice(`Minote Importer：${result.message}`);
				}
			}
		});

		this.addCommand({
			id: 'refresh-cookie',
			name: '刷新小米云服务 Cookie（外部浏览器）',
			callback: async () => {
				const result = await this.externalLogin.startRefreshCookie();
				if (!result.success) {
					new Notice(`Minote Importer：${result.message}`);
				}
			}
		});

		this.addCommand({
			id: 'logout',
			name: '注销小米云服务登录',
			callback: async () => {
				await this.externalLogin.logout();
			}
		});

		this.addSettingTab(new MinoteSettingTab(this.app, this, this.externalLogin));
	}

	async startSync(force = false) {
		if (this.syncing) {
			new Notice('正在导入小米笔记，请勿重复点击');
			return;
		}
		if (!get(settingsStore).cookie) {
			new Notice('尚未登录小米云服务，请先执行「使用外部浏览器登录小米云服务」');
			return;
		}
		this.syncing = true;
		try {
			new Notice('开始导入小米笔记...');
			const syncedCount = await this.noteSyncer.sync(force);
			new Notice(`已导入 ${syncedCount} 篇小米笔记`);
		} catch (e) {
			new Notice('导入小米笔记失败，请检查网络和登录状态');
			console.error('[minote-importer] failed to import notes');
		} finally {
			this.syncing = false;
		}
	}

	onunload() {
		this.externalLogin?.dispose();
	}
}

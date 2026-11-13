/**
 * @file 插件主函数
 * @author Emac (external-browser login contribution by Halo0sama)
 * @date 2025-01-05
 */
import { FileSystemAdapter, Menu, Notice, Plugin } from 'obsidian';
import { get } from 'svelte/store';

import { importProgress, settingsStore } from './src/settings';
import { MinoteSettingTab } from './src/settingTab';
import FileManager from './src/fileManager';
import MinoteApi from './src/minoteApi';
import NoteSyncer from './src/noteSyncer';
import ExternalLoginService from './src/externalLogin';

export default class MinotePlugin extends Plugin {
	private externalLogin: ExternalLoginService;
	private syncing = false;

	async onload() {
		await settingsStore.initialize(this);

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
				new Notice(`Minote Importer：${result.message}`);
			}
		});

		this.addCommand({
			id: 'confirm-login',
			name: '确认已完成小米云网页验证',
			callback: async () => {
				const result = await this.externalLogin.confirmLogin();
				new Notice(result.message);
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
		const { cookie, noteLocation } = get(settingsStore);
		if (!cookie) {
			new Notice('请打开小米云网页完成验证，等 Obsidian 显示已登录后再导入。');
			return;
		}
		const vault = this.app.vault;
		if (!(vault.adapter instanceof FileSystemAdapter)) return;
		this.syncing = true;
		const initial = `正在读取小米云笔记清单… 保存位置：${noteLocation}`;
		const progress = new Notice(initial, 0);
		importProgress.set(initial);
		try {
			const fileManager = new FileManager(vault, vault.adapter, noteLocation);
			const noteSyncer = new NoteSyncer(fileManager, new MinoteApi(), this.externalLogin);
			let nextUpdate = 0;
			const { total, count, skipped, locked, failed, partial, failuresByStep, synced } = await noteSyncer.sync(force, result => {
				const processed = result.count + result.skipped + result.locked + result.failed;
				if (Date.now() < nextUpdate && processed < result.total) return;
				nextUpdate = Date.now() + 500;
				const message = `正在导入小米笔记，已处理 ${processed}/${result.total} 篇。保存位置：${fileManager.destination}`;
				importProgress.set(message);
				progress.setMessage(message);
			});
			const status = locked || failed || partial ? '导入结束，仍有内容待处理' : '导入完成';
			const breakdown = Object.entries(failuresByStep).map(([step, amount]) => `${step} ${amount} 篇`).join('、');
			const details = breakdown ? ` 失败环节：${breakdown}。` : '';
			const attachments = partial ? ` 已写入的笔记中有 ${partial} 篇图片待补齐。` : '';
			const summary = `${status}。保存位置：${fileManager.destination}。共 ${total} 篇，写入 ${count} 篇，已在本地且无变化 ${skipped} 篇，待解密 ${locked} 篇，失败 ${failed} 篇。${attachments}${details}`;
			settingsStore.actions.setImportResult(fileManager.destination, summary, synced);
			const hint = locked || partial ? '请保持已验证的小米云笔记网页打开，再重试导入。' : '';
			new Notice(summary + hint, 15000);
		} catch {
			const summary = `导入中断。保存位置：${noteLocation}。请检查小米云登录、网络及保存目录后重试。`;
			settingsStore.actions.setImportResult(noteLocation, summary);
			new Notice(summary, 15000);
		} finally {
			progress.hide();
			importProgress.set('');
			this.syncing = false;
		}
	}

	onunload() {
		this.externalLogin?.dispose();
	}
}

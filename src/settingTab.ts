/**
 * @file 插件设置页面
 * @author Emac
 * @date 2025-01-05
 */
import { PluginSettingTab, Setting, Notice, Platform, TFolder } from 'obsidian';
import type { App } from 'obsidian';
import { get } from 'svelte/store';

import MinotePlugin from 'main';
import { importProgress, settingsStore } from './settings';
import type MinoteWebSession from './minoteWebSession';

export class MinoteSettingTab extends PluginSettingTab {
	private unsubscribeBrowser?: () => void;
	private unsubscribeImport?: () => void;
	private unsubscribeDestination?: () => void;

	constructor(app: App, private readonly minotePlugin: MinotePlugin, private readonly webSession: MinoteWebSession) {
		super(app, minotePlugin);
	}

	display(): void {
		this.hide();
		const { containerEl } = this;
		containerEl.empty();

		if (Platform.isDesktopApp) {
			this.showLogin();
		}

		this.notebookFolder();
		this.showImportStatus();
		this.advancedSettings();
	}

	hide(): void {
		this.unsubscribeBrowser?.();
		this.unsubscribeBrowser = undefined;
		this.unsubscribeImport?.();
		this.unsubscribeImport = undefined;
		this.unsubscribeDestination?.();
		this.unsubscribeDestination = undefined;
	}

	private showImportStatus(): void {
		const row = new Setting(this.containerEl).setName('导入状态');
		const update = () => row.setDesc(get(importProgress) || get(settingsStore).lastImportSummary || '暂无导入结果');
		const stopProgress = importProgress.subscribe(update);
		const stopSettings = settingsStore.subscribe(update);
		this.unsubscribeImport = () => { stopProgress(); stopSettings(); };
	}

	private showLogin(): void {
		const row = new Setting(this.containerEl).setName('小米账号');
		let rendered = '';
		const update = () => {
			const state = get(this.webSession.accountState);
			row.setDesc(state.loggedIn ? `已登录 · ${state.nickname}` : '未登录');
			row.settingEl.setAttribute('aria-busy', String(state.checking));
			const key = `${state.loggedIn}:${state.nickname}:${this.minotePlugin.isImporting()}`;
			if (key === rendered) return;
			rendered = key;
			row.controlEl.empty();
			row.addButton(button => button.setButtonText(state.loggedIn ? '打开小米笔记' : '登录')
				.onClick(async () => {
					try {
						await this.minotePlugin.openMinote();
						(this.app as App & { setting?: { close(): void } }).setting?.close();
					}
					catch { new Notice('无法打开小米笔记，请重试。'); }
				}));
			if (state.loggedIn) row.addButton(button => button.setButtonText('退出登录')
				.setDisabled(this.minotePlugin.isImporting()).onClick(async () => {
					button.setDisabled(true);
					await this.minotePlugin.logout();
					button.setDisabled(this.minotePlugin.isImporting());
				}));
		};
		const stopAccount = this.webSession.accountState.subscribe(update);
		const stopProgress = importProgress.subscribe(update);
		this.unsubscribeBrowser = () => { stopAccount(); stopProgress(); };
	}

	private notebookFolder(): void {
		const row = new Setting(this.containerEl)
			.setName('笔记保存位置')
			.addDropdown((dropdown) => {
				const selected = get(settingsStore).noteLocation;
				const folders = new Set(this.app.vault.getAllLoadedFiles()
					.filter((file): file is TFolder => file instanceof TFolder)
					.map(folder => folder.path));
				folders.add('/');
				folders.add(selected);
				for (const folder of [...folders].sort((a, b) => a.localeCompare(b))) {
					dropdown.addOption(folder, folder === '/' ? '笔记库根目录' : folder);
				}
				dropdown.setValue(selected).onChange(value => {
					if (get(importProgress)) {
						dropdown.setValue(get(settingsStore).noteLocation);
					} else {
						settingsStore.actions.setNoteLocationFolder(value);
					}
				});
				this.unsubscribeDestination = importProgress.subscribe(message => dropdown.setDisabled(Boolean(message)));
			});
		row.setDesc('导入只使用这里选中的完整路径。导入过程中暂不能更改。');
	}

	private advancedSettings(): void {
		this.containerEl.createEl('hr');
		const advancedSettings = this.containerEl.createEl('details');
		advancedSettings.createEl('summary', {
			text: '高级设置'
		});

		new Setting(advancedSettings)
			.setName('小米云服务域名')
			.addDropdown((dropdown) => {
				const hosts = ['i.mi.com', 'eu.i.mi.com', 'us.i.mi.com', 'in.i.mi.com'];
				hosts.forEach((val) => {
					dropdown.addOption(val, val);
				});

				return dropdown
					.setValue(get(settingsStore).host)
					.onChange(async (value) => {
						if (this.minotePlugin.isImporting()) {
							new Notice('请先取消导入，再切换小米云服务域名。');
							this.display();
							return;
						}
						await this.minotePlugin.switchHost(value);
						this.display();
					});
			});

	}
}

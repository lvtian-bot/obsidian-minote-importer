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
import type ExternalLoginService from './externalLogin';

export class MinoteSettingTab extends PluginSettingTab {
	private unsubscribeBrowser?: () => void;
	private unsubscribeImport?: () => void;
	private unsubscribeDestination?: () => void;

	constructor(app: App, plugin: MinotePlugin, private readonly externalLogin: ExternalLoginService) {
		super(app, plugin);
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
		const login = new Setting(this.containerEl);
		login.addButton(button => button
			.setButtonText('打开小米云网页')
			.onClick(async () => {
				const result = await this.externalLogin.startLogin();
				new Notice(result.message);
			}))
			.addButton(button => button
				.setButtonText('确认已完成验证')
				.setCta()
				.onClick(async () => {
					button.setDisabled(true);
					try {
						const result = await this.externalLogin.confirmLogin();
						new Notice(result.message);
					} finally {
						button.setDisabled(false);
					}
				}));
		const logout = new Setting(this.containerEl)
			.setName('退出登录')
			.setDesc('清除此笔记库的插件登录状态和专用浏览器数据。')
			.addButton(button => button.setButtonText('退出').onClick(async () => {
				button.setDisabled(true);
				await this.externalLogin.logout();
				this.display();
			}));
		const updateStatus = () => {
			const status = get(this.externalLogin.loginStatus);
			const { isCookieValid } = get(settingsStore);
			logout.settingEl.toggle(isCookieValid);
			if (status === 'confirmed') {
				login.setName('小米云已登录').setDesc('可以导入笔记。导入加密笔记期间请保持网页打开。');
			} else if (status === 'waiting') {
				login.setName('等待小米云网页验证').setDesc('网页能打开笔记正文后，如果这里仍在等待，请保持网页打开，再点「确认已完成验证」。');
			} else if (status === 'timed-out') {
				login.setName('等待登录超时').setDesc('如果网页已能打开笔记，请点「确认已完成验证」。');
			} else if (isCookieValid) {
				login.setName('小米云已登录，网页已关闭').setDesc('可以导入普通笔记。导入加密笔记前请重新打开网页。');
			} else if (status === 'closed') {
				login.setName('小米云网页已关闭').setDesc('请重新打开网页，等 Obsidian 显示已登录。');
			} else {
				login.setName('登录小米云').setDesc('点击打开网页，在小米网页完成验证即可。');
			}
		};
		const stopStatus = this.externalLogin.loginStatus.subscribe(updateStatus);
		const stopSettings = settingsStore.subscribe(updateStatus);
		this.unsubscribeBrowser = () => { stopStatus(); stopSettings(); };
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
						if (this.externalLogin.isRunning()) {
							new Notice('请先关闭登录窗口，再切换小米云服务域名');
							this.display();
							return;
						}
						settingsStore.actions.setHost(value);
						this.display();
					});
			});

		const detectedBrowser = this.externalLogin.detectBrowserPath();
		new Setting(advancedSettings)
			.setName('外部浏览器可执行文件')
			.setDesc(`留空时自动检测。当前检测到：${detectedBrowser || '未找到，请手动填写完整路径'}`)
			.addText((text) => {
				return text
					.setPlaceholder('例如：C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
					.setValue(get(settingsStore).browserPath)
					.onChange(async (value) => {
						settingsStore.actions.setBrowserPath(value.trim());
					});
			});
	}
}

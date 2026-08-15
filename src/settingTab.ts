/**
 * @file 插件设置页面
 * @author Emac
 * @date 2025-01-05
 */
import { PluginSettingTab, Setting, Notice, Platform } from 'obsidian';
import type { App } from 'obsidian';
import { get } from 'svelte/store';
import pickBy from 'lodash.pickby';

import MinotePlugin from 'main';
import { settingsStore } from './settings';
import type ExternalLoginService from './externalLogin';

export class MinoteSettingTab extends PluginSettingTab {
	constructor(app: App, plugin: MinotePlugin, private readonly externalLogin: ExternalLoginService) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const isCookieValid = get(settingsStore).isCookieValid;
		if (Platform.isDesktopApp) {
			if (isCookieValid) {
				this.showLogout();
			} else {
				this.showLogin();
			}
		}

		this.notebookFolder();
		this.advancedSettings();
	}

	private showLogin(): void {
		const desc = document.createRange().createContextualFragment(
			`点击登录后会自动打开外部浏览器（Chrome/Edge），请在插件打开的独立窗口里扫码。`
		);

		new Setting(this.containerEl)
			.setName('登录小米云服务（外部浏览器）')
			.setDesc(desc)
			.addButton((button) => {
				return button
					.setButtonText('登录')
					.setCta()
					.onClick(async () => {
						button.setDisabled(true);
						const result = await this.externalLogin.startLogin();
						if (!result.success) {
							new Notice(`Minote Importer：${result.message}`);
						}
						this.display();
					});
			});
	}

	private showLogout(): void {
		const desc = document.createRange().createContextualFragment(
			`刷新时会打开专用浏览器窗口。如果登录已过期，请重新扫码。<br>
             注销会清除此笔记库的插件登录状态和专用浏览器数据。`
		);

		new Setting(this.containerEl)
			.setName(`小米云服务已登录，用户名：  ${get(settingsStore).user}`)
			.setDesc(desc)
			.addButton((button) => {
				return button
					.setButtonText('刷新Cookie')
					.setCta()
					.onClick(async () => {
						button.setDisabled(true);
						const result = await this.externalLogin.startRefreshCookie();
						if (!result.success) {
							new Notice(`Minote Importer：${result.message}`);
						}
						this.display();
					});
			})
			.addButton((button) => {
				return button
					.setButtonText('注销')
					.setCta()
					.onClick(async () => {
						button.setDisabled(true);
						await this.externalLogin.logout();
						this.display();
					});
			});
	}

	private notebookFolder(): void {
		new Setting(this.containerEl)
			.setName('笔记保存位置')
			.setDesc('请选择 Obsidian Vault 中小米笔记存放的位置')
			.addDropdown((dropdown) => {
				const files = (this.app.vault.adapter as any).files;
				const folders = pickBy(files, (val: any) => {
					return val.type === 'folder';
				});
				Object.keys(folders).forEach((val) => {
					dropdown.addOption(val, val);
				});

				return dropdown
					.setValue(get(settingsStore).noteLocation)
					.onChange(async (value) => {
						settingsStore.actions.setNoteLocationFolder(value);
					});
			});
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

/**
 * @file 刷新Cookie页面
 * @author Emac
 * @date 2025-01-18
 */
const { remote } = require('electron');
import { get } from 'svelte/store';

import { settingsStore } from '../settings';
import { MinoteSettingTab } from '../settingTab';

export default class MinoteRefreshCookieModel {
	private modal: any;
	private settingTab: MinoteSettingTab;

	constructor(settingTab: MinoteSettingTab) {
		this.settingTab = settingTab;

		const { BrowserWindow: RemoteBrowserWindow } = remote;
		this.modal = new RemoteBrowserWindow({
			parent: remote.getCurrentWindow(),
			width: 960,
			height: 540,
			show: false,
			webPreferences: {
				partition: `persist:${this.settingTab.plugin.manifest.id}`
			}
		});

		this.modal.once('ready-to-show', () => {
			this.modal.setTitle('刷新小米云服务Cookie，点击【使用小米账号登录】');
			this.modal.show();
		});

		const webContents = this.modal.webContents;
		const session = webContents.session;

		const cookieFilter = {
			urls: [`https://${get(settingsStore).host}/status/lite/profile?ts=*`]
		};
		session.webRequest.onSendHeaders(cookieFilter, (details: any) => {
			const cookie = details.requestHeaders['Cookie'];
			if (cookie) {
				settingsStore.actions.setCookie(cookie);
				this.settingTab.display();
				this.modal.close();
			} else {
				this.modal.reload();
			}
		});
	}

	async doRefreshCookie() {
		await this.modal.loadURL(`https://${get(settingsStore).host}`);
	}

	onClose() {
		this.modal.close();
	}
}

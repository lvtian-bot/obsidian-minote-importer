/**
 * @file 登录页面
 * @author Emac
 * @date 2025-01-05
 */
const { remote } = require('electron');
import { get } from 'svelte/store';

import { settingsStore } from '../settings';
import { MinoteSettingTab } from '../settingTab';

export default class MinoteLoginModel {
	private modal: any;
	private settingTab: MinoteSettingTab;
	private profileRetrieved: boolean = false;

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
			this.modal.setTitle('登录小米云服务~');
			this.modal.show();
		});

		const webContents = this.modal.webContents;
		const session = webContents.session;

		const loginFilter = {
			urls: ['https://account.xiaomi.com/fe/service/account?cUserId=*', `https://${get(settingsStore).host}/status/lite/profile?ts=*`]
		};
		session.webRequest.onCompleted(loginFilter, async (details: any) => {
			if (details.url.startsWith('https://account.xiaomi.com/fe/service/account')) {
				if (details.statusCode == 200) {
					this.modal.loadURL(`https://${get(settingsStore).host}/note/h5`)
				}
			}
			if (details.url.startsWith(`https://${get(settingsStore).host}/status/lite/profile`)) {
				if (details.statusCode == 200) {
					const startTime = Date.now();
					while (!this.profileRetrieved && Date.now() - startTime < 3000) {
						await new Promise(resolve => setTimeout(resolve, 1000));
					}
					settingTab.display();
					this.modal.close();
				} else {
					this.modal.reload();
				}
			}
		});

		const cookieFilter = {
			urls: [`https://${get(settingsStore).host}/status/lite/profile?ts=*`]
		};
		session.webRequest.onSendHeaders(cookieFilter, (details: any) => {
			const cookie = details.requestHeaders['Cookie'];
			if (cookie) {
				settingsStore.actions.setCookie(cookie);
			} else {
				this.modal.reload();
			}
		});

		this.listenOnProfileResponse(webContents);
	}

	listenOnProfileResponse(webContents: any) {
		try {
			webContents.debugger.attach('1.3');
			webContents.debugger.on('message', (event: any, method: any, params: any) => {
				if (method === 'Network.responseReceived') {
					if (params.response.url.startsWith(`https://${get(settingsStore).host}/status/lite/profile`)) {
						webContents.debugger.sendCommand('Network.getResponseBody', { requestId: params.requestId }).then((response: any) => {
							const profile = JSON.parse(response.body);
							settingsStore.actions.setUser(profile.data.nickname);
							this.profileRetrieved = true;
						});
					}
				}
			});
			webContents.debugger.sendCommand('Network.enable');
		} catch (err) {
			console.error('[minote-importer] debugger attach failed: ', err);
		}
	}

	async doLogin() {
		await this.modal.loadURL('https://account.xiaomi.com/fe/service/login/qrcode');
	}

	onClose() {
		this.modal.close();
	}
}

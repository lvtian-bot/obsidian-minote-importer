/**
 * @file 插件配置
 * @author Emac
 */
import { writable } from 'svelte/store';

import MinotePlugin from 'main';
import type { SyncInfo } from './models';

interface MinotePluginSettings {
	noteLocation: string;
	host: string;
	cookie: string;
	isCookieValid: boolean;
	user: string;
	lastTimeSynced: SyncInfo[];
	// 外部浏览器登录
	browserPath: string;
};

const DEFAULT_SETTINGS: MinotePluginSettings = {
	noteLocation: 'minote-importer',
	host: 'i.mi.com',
	cookie: '',
	isCookieValid: false,
	user: '',
	lastTimeSynced: [],
	browserPath: '',
};

const createSettingsStore = () => {
	const store = writable(DEFAULT_SETTINGS as MinotePluginSettings);

	let _plugin!: MinotePlugin;

	const initialize = async (plugin: MinotePlugin): Promise<void> => {
		_plugin = plugin;

		const data = Object.assign({}, DEFAULT_SETTINGS, await plugin.loadData());
		const settings: MinotePluginSettings = { ...data };
		store.set(settings);
	};

	store.subscribe(async (settings) => {
		if (_plugin) {
			const data = { ...settings };
			await _plugin.saveData(data);
		}
	});

	const setNoteLocationFolder = (value: string) => {
		store.update((state) => {
			state.noteLocation = value;
			return state;
		});
	};

	const setHost = (value: string) => {
		store.update((state) => {
			if (state.host !== value) {
				state.host = value;
				state.cookie = '';
				state.isCookieValid = false;
				state.user = '';
			}
			return state;
		});
	};

	const clearCookie = () => {
		store.update((state) => {
			state.cookie = '';
			state.isCookieValid = false;
			state.user = '';
			return state;
		});
	};

	const setLogin = (cookie: string, user: string) => {
		store.update((state) => {
			state.cookie = cookie;
			state.isCookieValid = true;
			state.user = user;
			return state;
		});
	};

	const setBrowserPath = (value: string) => {
		store.update((state) => {
			state.browserPath = value;
			return state;
		});
	};

	const clearLastTimeSynced = () => {
		store.update((state) => {
			state.lastTimeSynced = [];
			return state;
		});
	};

	const setLastTimeSynced = (synced: SyncInfo[]) => {
		store.update((state) => {
			state.lastTimeSynced = synced;
			return state;
		});
	};

	return {
		subscribe: store.subscribe,
		initialize,
		actions: {
			setNoteLocationFolder,
			setHost,
			clearCookie,
			setLogin,
			setBrowserPath,
			clearLastTimeSynced,
			setLastTimeSynced,
		}
	}
};

export const settingsStore = createSettingsStore()

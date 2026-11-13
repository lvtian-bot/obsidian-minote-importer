/**
 * @file 插件配置
 * @author Emac
 */
import { writable } from 'svelte/store';
import { normalizePath } from 'obsidian';

import MinotePlugin from 'main';
import type { SyncInfo } from './models';

interface MinotePluginSettings {
	noteLocation: string;
	host: string;
	cookie: string;
	isCookieValid: boolean;
	webLoginConfirmed: boolean;
	user: string;
	lastTimeSynced: SyncInfo[];
	lastImportDestination: string;
	lastImportSummary: string;
	// 外部浏览器登录
	browserPath: string;
};

const DEFAULT_SETTINGS: MinotePluginSettings = {
	noteLocation: 'minote-importer',
	host: 'i.mi.com',
	cookie: '',
	isCookieValid: false,
	webLoginConfirmed: false,
	user: '',
	lastTimeSynced: [],
	lastImportDestination: '',
	lastImportSummary: '',
	browserPath: '',
};

const createSettingsStore = () => {
	const store = writable(DEFAULT_SETTINGS as MinotePluginSettings);

	let _plugin!: MinotePlugin;
	let pendingSave = Promise.resolve();

	const initialize = async (plugin: MinotePlugin): Promise<void> => {
		_plugin = plugin;

		const data = Object.assign({}, DEFAULT_SETTINGS, await plugin.loadData());
		const settings: MinotePluginSettings = { ...data };
		settings.noteLocation = normalizePath(settings.noteLocation);
		if (!settings.lastImportDestination && settings.lastTimeSynced.length) {
			// Legacy records have relative paths. Recheck them under the saved destination.
			settings.lastImportDestination = settings.noteLocation;
		}
		if (!settings.webLoginConfirmed) {
			settings.cookie = '';
			settings.isCookieValid = false;
			settings.user = '';
		}
		store.set(settings);
	};

	store.subscribe(settings => {
		if (_plugin) {
			const data = { ...settings };
			const save = pendingSave.catch(() => undefined).then(() => _plugin.saveData(data));
			pendingSave = save;
			void save.catch(() => undefined);
		}
	});

	const setNoteLocationFolder = (value: string) => {
		store.update(state => ({ ...state, noteLocation: normalizePath(value) }));
	};

	const setHost = (value: string) => {
		store.update((state) => {
			if (state.host !== value) {
				state.host = value;
				state.cookie = '';
				state.isCookieValid = false;
				state.webLoginConfirmed = false;
				state.user = '';
			}
			return state;
		});
	};

	const clearCookie = () => {
		store.update((state) => {
			state.cookie = '';
			state.isCookieValid = false;
			state.webLoginConfirmed = false;
			state.user = '';
			return state;
		});
	};

	const setLogin = (cookie: string, user: string) => {
		store.update((state) => {
			state.cookie = cookie;
			state.isCookieValid = true;
			state.webLoginConfirmed = true;
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

	const checkpointMove = (destination: string, record: SyncInfo) => {
		store.update(state => ({
			...state,
			lastImportDestination: destination,
			lastTimeSynced: [
				...state.lastTimeSynced.filter(item => state.lastImportDestination === destination
					&& (item.type !== 'note' || (item.id !== record.id && item.relativePath !== record.relativePath))),
				record,
			],
		}));
		return pendingSave;
	};

	const setImportResult = (destination: string, summary: string, synced?: SyncInfo[]) => {
		store.update(state => ({
			...state,
			lastImportSummary: summary,
			...(synced ? { lastImportDestination: destination, lastTimeSynced: synced } : {}),
		}));
		return pendingSave;
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
			setImportResult,
			checkpointMove,
		}
	}
};

export const settingsStore = createSettingsStore()
export const importProgress = writable('');

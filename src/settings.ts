/**
 * @file 插件配置
 * @author Emac
 */
import { get, writable } from 'svelte/store';
import { normalizePath } from 'obsidian';

import type MinotePlugin from 'main';
import type { SyncInfo } from './models';

interface MinotePluginSettings {
	noteLocation: string;
	host: string;
	accountLoggedIn: boolean;
	user: string;
	lastTimeSynced: SyncInfo[];
	lastImportDestination: string;
	lastImportSummary: string;
};

const DEFAULT_SETTINGS: MinotePluginSettings = {
	noteLocation: 'minote-importer',
	host: 'i.mi.com',
	accountLoggedIn: false,
	user: '',
	lastTimeSynced: [],
	lastImportDestination: '',
	lastImportSummary: '',
};

const createSettingsStore = () => {
	const store = writable(DEFAULT_SETTINGS as MinotePluginSettings);

	let _plugin!: MinotePlugin;
	let pendingSave = Promise.resolve();

	const initialize = async (plugin: MinotePlugin): Promise<void> => {
		_plugin = plugin;

		const raw = await plugin.loadData() ?? {};
		// 不迁移旧浏览器认证；保留其他配置及导入记录，首次保存即移除旧凭据。
		const { cookie: _cookie, webLoginConfirmed: _confirmed, isCookieValid: _valid, browserPath: _browser, ...safe } = raw;
		const data = Object.assign({}, DEFAULT_SETTINGS, safe);
		const settings: MinotePluginSettings = { ...data };
		settings.noteLocation = normalizePath(settings.noteLocation);
		if (!settings.lastImportDestination && settings.lastTimeSynced.length) {
			// Legacy records have relative paths. Recheck them under the saved destination.
			settings.lastImportDestination = settings.noteLocation;
		}
		if (!settings.accountLoggedIn) settings.user = '';
		runtimeCredentials.set('');
		store.set(settings);
		await pendingSave;
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
		runtimeCredentials.set('');
		store.update((state) => {
			if (state.host !== value) {
				state.host = value;
				state.accountLoggedIn = false;
				state.user = '';
			}
			return state;
		});
	};

	const clearCookie = () => {
		runtimeCredentials.set('');
		store.update((state) => {
			state.accountLoggedIn = false;
			state.user = '';
			return state;
		});
	};

	const setAccountState = (loggedIn: boolean, user: string) => {
		const state = get(store);
		if (state.accountLoggedIn === loggedIn && state.user === user) return;
		store.set({ ...state, accountLoggedIn: loggedIn, user });
	};
	const setLogin = (cookie: string, user: string) => {
		runtimeCredentials.set(cookie);
		setAccountState(true, user);
	};

	const checkpointMove = (destination: string, record: SyncInfo) => {
		store.update(state => ({
			...state,
			lastImportDestination: destination,
			lastTimeSynced: [
				...state.lastTimeSynced.filter(item => state.lastImportDestination === destination
					&& (item.type !== 'note' || (item.account && item.account !== record.account)
						|| (item.id !== record.id && item.relativePath !== record.relativePath))),
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
			setAccountState,
			setImportResult,
			checkpointMove,
		}
	}
};

// 仅供本轮请求使用；不属于任何 saveData 的数据对象。
export const runtimeCredentials = writable('');
export const settingsStore = createSettingsStore()
export const importProgress = writable('');

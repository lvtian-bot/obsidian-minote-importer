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
import { creationDateBounds, type ImportMode } from './importOptions';
import { WebSessionError } from './importControl';
import type MinoteWebSession from './minoteWebSession';

export class MinoteSettingTab extends PluginSettingTab {
	private unsubscribeBrowser?: () => void;
	private unsubscribeImport?: () => void;
	private unsubscribeDestination?: () => void;
	private unsubscribeOptions?: () => void;

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
		this.showImportOptions();
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
		this.unsubscribeOptions?.();
		this.unsubscribeOptions = undefined;
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

	private showImportOptions(): void {
		const disableControls: ((disabled: boolean) => void)[] = [];
		new Setting(this.containerEl).setName('导入模式').addDropdown(dropdown => {
			dropdown.addOption('mirror', '镜像模式').addOption('copy', '复制模式')
				.setValue(get(settingsStore).importMode)
				.onChange(value => settingsStore.actions.setImportOptions({ importMode: value as ImportMode }));
			disableControls.push(disabled => dropdown.setDisabled(disabled));
		}).setDesc('镜像模式会将已导入但移出范围或在云端删除的笔记移入本地回收站。复制模式会保留这些笔记。');

		new Setting(this.containerEl).setName('导入范围').setHeading();
		const dateRow = new Setting(this.containerEl).setName('创建日期范围');
		const updateDates = () => {
			try {
				creationDateBounds(get(settingsStore));
				dateRow.setDesc('按北京时间计算，包含起止当天，留空表示不限。');
			} catch (error) {
				if (error instanceof Error) dateRow.setDesc(error.message);
			}
		};
		for (const [key, label] of [['createdFrom', '开始日期'], ['createdThrough', '结束日期']] as const) {
			new Setting(this.containerEl).setName(label).addText(({ inputEl }) => {
				inputEl.type = 'date';
				inputEl.value = get(settingsStore)[key];
				inputEl.setAttribute('aria-label', label);
				inputEl.addEventListener('change', () => {
					if (inputEl.validity.badInput) return;
					settingsStore.actions.setImportOptions({ [key]: inputEl.value });
					updateDates();
				});
				disableControls.push(disabled => { inputEl.disabled = disabled; });
			});
		}
		updateDates();

		const stopFolders = this.showFolderSelection();
		const stopProgress = importProgress.subscribe(message => disableControls.forEach(disable => disable(Boolean(message))));
		this.unsubscribeOptions = () => { stopProgress(); stopFolders(); };
	}

	private showFolderSelection(): () => void {
		const row = new Setting(this.containerEl).setName('文件夹');
		const allButton = row.controlEl.createEl('button', { text: '全部文件夹' });
		const readButton = row.controlEl.createEl('button', { text: '读取文件夹' });
		const list = this.containerEl.createDiv();
		list.setCssStyles({ maxHeight: '14em', overflowY: 'auto' });
		const controller = new AbortController();
		const { signal } = controller;
		let catalog: Awaited<ReturnType<MinoteWebSession['readFolders']>> | undefined;
		let loading = false;
		let errorMessage = '';

		const update = () => {
			const { folderSelection } = get(settingsStore);
			const disabled = Boolean(get(importProgress));
			const sameAccount = folderSelection?.account === catalog?.account;
			allButton.disabled = disabled || !folderSelection;
			readButton.disabled = disabled || loading;
			list.querySelectorAll('input').forEach(input => {
				input.disabled = disabled;
				input.checked = Boolean(sameAccount && folderSelection?.ids.includes(input.value));
			});
			row.setDesc(errorMessage || (loading ? '正在读取小米云文件夹…'
				: folderSelection && catalog && !sameAccount ? '请为当前小米账号重新选择文件夹。'
					: folderSelection ? `已选 ${folderSelection.ids.length} 个文件夹。` : '当前导入全部文件夹。'));
		};

		const render = () => {
			list.empty();
			if (catalog) {
				const { account, folders } = catalog;
				const names = new Map(folders);
				const saved = get(settingsStore).folderSelection;
				if (saved?.account === account) {
					for (const id of saved.ids) if (!names.has(id)) names.set(id, '已移除的文件夹');
				}
				const nameCounts = new Map<string, number>();
				for (const name of names.values()) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
				for (const [id, name] of names) {
					const label = list.createDiv().createEl('label');
					const input = label.createEl('input', { attr: { type: 'checkbox', value: id } });
					label.createSpan({ text: nameCounts.get(name) === 1 ? name : `${name}（编号 ${id}）` });
					input.addEventListener('change', () => {
						const selected = get(settingsStore).folderSelection;
						const ids = new Set(selected?.account === account ? selected.ids : []);
						if (input.checked) ids.add(id);
						else ids.delete(id);
						if (ids.size) settingsStore.actions.setImportOptions({ folderSelection: { account, ids: [...ids] } });
						else new Notice('请选择至少一个文件夹，或点击「全部文件夹」。');
						update();
					});
				}
			}
			update();
		};
		allButton.addEventListener('click', () => {
			settingsStore.actions.setImportOptions({ folderSelection: null });
			render();
		});
		readButton.addEventListener('click', async () => {
			loading = true;
			catalog = undefined;
			errorMessage = '';
			render();
			try {
				catalog = await this.webSession.readFolders(signal);
			} catch (error) {
				errorMessage = error instanceof WebSessionError ? error.message : '无法读取小米云文件夹，请重试。';
			} finally {
				loading = false;
				if (!signal.aborted) render();
			}
		});
		const stopProgress = importProgress.subscribe(update);
		return () => { controller.abort(); stopProgress(); };
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

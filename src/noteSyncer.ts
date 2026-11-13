/**
 * @file 笔记同步引擎
 * @author Emac
 * @date 2025-01-05
 */
import { get } from 'svelte/store';

import { settingsStore } from './settings';
import FileManager from './fileManager';
import MinoteApi from './minoteApi';
import type ExternalLoginService from './externalLogin';
import { isEncryptedNoteContent } from './webNote';
import path from 'path';
import type { Note, Folder, SyncInfo, ImageInfo } from './models';

const originalImage = /☺[^\S\r\n]+[^\s<]+|<img\b[^>]*\bfileid=/i;

interface ImportCounts {
	total: number;
	count: number;
	skipped: number;
	locked: number;
	failed: number;
	partial: number;
	failuresByStep: Record<string, number>;
}

export default class NoteSyncer {
	private fileManager: FileManager;
	private minoteApi: MinoteApi;
	private notes: Note[] = [];
	private folders: Folder[] = [];
	private folderDict: Record<string, string> = {};
	private thisTimeSynced: SyncInfo[] = [];
	private lastSyncedFolders: Record<string, SyncInfo> = {};
	private lastSyncedNotes: Record<string, SyncInfo> = {};

	constructor(fileManager: FileManager, minoteApi: MinoteApi, private readonly externalLogin: ExternalLoginService) {
		this.fileManager = fileManager;
		this.minoteApi = minoteApi;
	}

	public async sync(force: boolean, onProgress: (result: ImportCounts) => void) {
		this.clear();

		const settings = get(settingsStore);
		const history = settings.lastImportDestination === this.fileManager.destination ? settings.lastTimeSynced : [];
		this.lastSyncedFolders = history
			.filter(note => note.type === 'folder')
			.reduce((acc: Record<string, SyncInfo>, note: SyncInfo) => {
				acc[note.id] = { ...note };
				return acc;
			}, {});
		this.lastSyncedNotes = history
			.filter(note => note.type === 'note')
			.reduce((acc: Record<string, SyncInfo>, note: SyncInfo) => {
				acc[note.id] = { ...note };
				return acc;
			}, {});

		await this.fetchNotesAndFolders();
		await this.createFolders();
		const result = await this.syncNotes(force, onProgress);

		return { ...result, synced: this.thisTimeSynced };
	}

	private clear() {
		this.notes = [];
		this.folders = [];
		this.folderDict = {};
		this.thisTimeSynced = [];
	}

	private async fetchNotesAndFolders() {
		const seenNotes = new Set<string>();
		const seenFolders = new Set<string>();
		const pageTokens = new Set<string>();
		// 获取第一页
		let page = await this.minoteApi.fetchPage();
		while (true) {
			for (const entry of page.data.entries) {
				if (entry.type === 'note') {
					const id = String(entry.id);
					if (seenNotes.has(id)) continue;
					seenNotes.add(id);
					// 解析笔记
					let title = '';
					if (entry.extraInfo) {
						try {
							const extra = JSON.parse(entry.extraInfo);
							if (typeof extra?.title === 'string') title = extra.title;
						} catch {
							// Older entries can have incomplete metadata. Use their snippet.
						}
					}
					const encrypted = Boolean(entry.encryptInfo) || (typeof entry.snippet === 'string' && isEncryptedNoteContent(entry.snippet));
					if (!title) {
						const firstLine = !encrypted && typeof entry.snippet === 'string' ? entry.snippet.split('\n')[0] : '';
						title = `${firstLine || '未命名笔记'}_${entry.id}`;
					}
					// 去除标题中的HTML标签
					title = title.replace(/<[^>]+>/g, '');
					// 去除标题中的非法字符 \/:*?"<>| 和换行符
					title = this.safeName(title);

					const note: Note = {
						id,
						title,
						createDate: entry.createDate,
						modifyDate: entry.modifyDate,
						folderId: String(entry.folderId ?? '0'),
						encrypted,
					};
					this.notes.push(note);
				}
			}

			for (const entry of page.data.folders) {
				if (entry.type === 'folder') {
					const id = String(entry.id);
					if (id === '0' || seenFolders.has(id)) continue;
					seenFolders.add(id);
					// 解析文件夹
					const folder: Folder = {
						id,
						name: this.safeName(entry.subject) || '未命名分类',
					};
					this.folders.push(folder);
				}
			}

			// 检查是否需要获取下一页
			if (page.data.lastPage) {
				break;
			}

			// 获取下一页
			const token = page.data.syncTag;
			if (typeof token !== 'string' || !token || pageTokens.has(token)) {
				throw new Error('Xiaomi Notes pagination stopped advancing');
			}
			pageTokens.add(token);
			page = await this.minoteApi.fetchPage(token);
		}
	}

	private async createFolders() {
		// 添加默认文件夹
		this.folders.unshift({ id: '0', name: '未分类' });

		const usedNames = new Set<string>();
		// Reserve the default category before allocating names for cloud folders.
		for (const folder of this.folders) {
			const base = folder.name;
			for (let index = 2; usedNames.has(this.pathKey(folder.name)); index++) {
				folder.name = `${base} (${index})`;
			}
			usedNames.add(this.pathKey(folder.name));
			// 更新文件夹字典
			this.folderDict[folder.id] = folder.name;

			// 如果上次曾同步过
			if (folder.id in this.lastSyncedFolders) {
				const oldFolderName = this.lastSyncedFolders[folder.id].name;
				if (folder.name !== oldFolderName && await this.fileManager.renameFolder(oldFolderName, folder.name)) {
					// 更新笔记路径
					for (const note of Object.values(this.lastSyncedNotes)) {
						const relativePath = note.relativePath.replace(/\\/g, '/');
						if (relativePath.startsWith(oldFolderName + '/')) {
							note.relativePath = folder.name + relativePath.slice(oldFolderName.length);
						}
					}
				}
			}

			// 创建文件夹目录
			await this.fileManager.createFolder(folder.name);

			// 添加到已处理文件夹列表
			this.thisTimeSynced.push({
				id: folder.id,
				type: 'folder',
				name: folder.name,
				relativePath: folder.name,
				syncTime: Date.now()
			});
		}
	}

	private async syncNotes(force: boolean, onProgress: (result: ImportCounts) => void) {
		const result: ImportCounts = {
			total: this.notes.length, count: 0, skipped: 0, locked: 0, failed: 0, partial: 0, failuresByStep: {}
		};
		onProgress(result);

		// 记录此次同步信息
		for (const note of this.notes) {
			const previous = this.lastSyncedNotes[note.id];
			let step = '检查本地文件';
			try {
				const folderPath = this.folderDict[note.folderId] || '未分类';
				const unchanged = !force && previous && note.modifyDate <= previous.syncTime;
				const checked = unchanged && await this.checkPreviousNote(note, previous, folderPath);
				if (checked) {
					this.thisTimeSynced.push({ ...previous, decoded: previous.decoded ?? false, imageFormatChecked: true });
					result.skipped++;
					continue;
				}

				step = '读取云端正文';
				const noteDetails = await this.minoteApi.fetchNoteDetails(note.id);
				const entry = noteDetails.data?.entry;
				if (typeof entry?.content !== 'string') {
					throw new Error('Missing note content');
				}
				const encrypted = note.encrypted || Boolean(entry.encryptInfo) || isEncryptedNoteContent(entry.content);
				let content: string | null = encrypted && entry.content
					? await this.externalLogin.readEncryptedNote({ id: note.id, content: entry.content, encryptInfo: entry.encryptInfo })
					: entry.content;
				if (content === null || (encrypted && entry.content && (content === entry.content || isEncryptedNoteContent(content)))) {
					result.locked++;
					if (previous) {
						this.thisTimeSynced.push(previous);
					}
					continue;
				}

				step = '处理图片';
				const images: ImageInfo[] = [];
				const imgDict = new Map<string, string>();
				let attachmentsPending = false;
				const attachments = entry.setting?.data;
				for (const attachment of Array.isArray(attachments) ? attachments : []) {
					const mime = typeof attachment?.mimeType === 'string' ? attachment.mimeType.toLowerCase() : '';
					const fileId = String(attachment?.fileId ?? '');
					if (!mime.startsWith('image/') || !fileId) continue;
					const subtype = mime.slice(6).split(/[+;]/)[0];
					images.push({
						fileId, fileType: /^[a-z0-9]+$/.test(subtype) ? subtype : 'img',
						digest: typeof attachment.digest === 'string' ? attachment.digest : undefined
					});
				}
				for (const image of images) {
					const imgDir = path.join(folderPath, 'img');
					const safeId = /^[a-zA-Z0-9_-]+$/.test(image.fileId) ? image.fileId : '~' + Buffer.from(image.fileId).toString('hex');
					const fileName = `${this.safeName(safeId)}.${image.fileType}`;
					try {
						await this.fileManager.createFolder(imgDir);
						await this.downloadImage(image, path.join(imgDir, fileName), encrypted);
						imgDict.set(image.fileId, fileName);
					} catch {
						attachmentsPending = true;
					}
				}

				// 转换内容
				// 规则1: 移除<text>标签
				content = content.replace(/<text[^>]*>(.*?)<\/text>/g, '$1');

				// 规则2: 转换background标签
				content = content.replace(
					/<background color="#([^"]*)">(.*?)<\/background>/g,
					'<span style="background-color: #$1">$2</span>'
				);

				// 规则3: 转换图片行 (☺格式)
				content = content.replace(/☺[^\S\r\n]+([^\s<]+)(?:<0\/><\/>)?/g, (match, fileId: string) => {
					return imgDict.has(fileId) ? `![](img/${imgDict.get(fileId)})` : match;
				});

				// 规则4: 转换图片行 (<img>格式)
				content = content.replace(
					/<img\b[^>]*\bfileid=["']([^"']+)["'][^>]*>/gi, (match, fileId: string) => {
						return imgDict.has(fileId) ? `![](img/${imgDict.get(fileId)})` : match;
					}
				);

				// 规则5: 移除<new-format/>标签
				content = content.replace(/<new-format\/>/g, '');
				attachmentsPending ||= originalImage.test(content);

				// 保存转换后的内容
				step = '写入本地文件';
				const notePath = await this.resolveNotePath(folderPath, note, encrypted, previous);
				await this.fileManager.saveFile(notePath, content, note.createDate, note.modifyDate);
				if (previous && this.pathKey(previous.relativePath) !== this.pathKey(notePath)
					&& !Object.values(this.lastSyncedNotes).some(item => item.id !== note.id && this.pathKey(item.relativePath) === this.pathKey(previous.relativePath))) {
					await this.fileManager.deleteFile(previous.relativePath).catch(() => undefined);
				}

				result.count++;
				if (attachmentsPending) result.partial++;
				// 添加到已处理笔记列表
				this.thisTimeSynced.push({
					id: note.id,
					type: 'note',
					name: note.title,
					relativePath: notePath,
					syncTime: note.modifyDate,
					decoded: encrypted,
					imageFormatChecked: true,
					attachmentsPending
				});
			} catch {
				result.failed++;
				result.failuresByStep[step] = (result.failuresByStep[step] || 0) + 1;
				if (previous) {
					this.thisTimeSynced.push(previous);
				}
			} finally {
				onProgress(result);
			}
		}

		return result;
	}

	private async checkPreviousNote(note: Note, previous: SyncInfo, folder: string): Promise<boolean> {
		const relativePath = previous.relativePath.replace(/\\/g, '/');
		if (this.pathKey(path.posix.dirname(relativePath)) !== this.pathKey(folder)
			|| !await this.fileManager.exists(previous.relativePath)) return false;
		if (note.encrypted && previous.decoded !== true) return false;
		if (previous.attachmentsPending) return false;
		if (previous.imageFormatChecked && previous.decoded !== undefined) return true;
		const content = await this.fileManager.readFile(previous.relativePath);
		return !isEncryptedNoteContent(content) && !originalImage.test(content);
	}

	private async resolveNotePath(folder: string, note: Note, encrypted: boolean, previous?: SyncInfo): Promise<string> {
		const occupied = new Set([...Object.values(this.lastSyncedNotes), ...this.thisTimeSynced]
			.filter(item => item.type === 'note' && item.id !== note.id)
			.map(item => this.pathKey(item.relativePath)));
		if (encrypted && previous && this.pathKey(path.dirname(previous.relativePath)) === this.pathKey(folder)
			&& !occupied.has(this.pathKey(previous.relativePath))) {
			return previous.relativePath;
		}
		let stem = '';
		for (const char of note.title || '未命名笔记') {
			if (Buffer.byteLength(stem + char, 'utf8') > 180) break;
			stem += char;
		}
		let candidate = path.join(folder, `${stem}.md`);
		const owns = (value: string) => previous && this.pathKey(previous.relativePath) === this.pathKey(value);
		for (let index = 1; occupied.has(this.pathKey(candidate)) || (!owns(candidate) && await this.fileManager.exists(candidate)); index++) {
			candidate = path.join(folder, `${stem}_${this.safeName(note.id)}_${index}.md`);
		}
		return candidate;
	}

	private safeName(value: string): string {
		const name = value.replace(/[\\/:*?"<>|\x00-\x1f]/g, '').trim().replace(/[. ]+$/, '');
		return /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(name) ? '_' + name : name;
	}

	private pathKey(value: string): string {
		return value.replace(/\\/g, '/').normalize('NFC').toLowerCase();
	}

	private async downloadImage(image: ImageInfo, imgPath: string, encrypted: boolean) {
		if (await this.fileManager.hasBinaryFile(imgPath)) {
			return;
		}
		const webImage = await this.externalLogin.readImage(image);
		if (!webImage && encrypted) throw new Error('Encrypted image unavailable');
		const imgBinary = webImage ?? await this.minoteApi.fetchImage(image.fileId);
		await this.fileManager.saveBinaryFile(imgPath, imgBinary);
	}
}

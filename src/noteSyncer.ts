/**
 * @file 笔记同步引擎
 * @author Emac
 * @date 2025-01-05
 */
import { createHash } from 'crypto';
import { get } from 'svelte/store';

import { settingsStore } from './settings';
import FileManager from './fileManager';
import MinoteApi from './minoteApi';
import type ExternalLoginService from './externalLogin';
import { isEncryptedNoteContent } from './webNote';
import { withNoteProperties } from './noteProperties';
import path from 'path';
import type { Note, Folder, SyncInfo, ImageInfo } from './models';

const originalImage = /☺[^\S\r\n]+[^\s<]+|<img\b[^>]*\bfileid=/i;
const localImage = /!\[(?:\\[^\r\n]|[^\]\\\r\n])*\]\(img\/([a-z\d_~.-]+)\)/gi;
const cloudNoteTypes = new Set(['note', 'mdNote', 'mindMap']);

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
	private folderDict: Record<string, Folder> = {};
	private thisTimeSynced: SyncInfo[] = [];
	private lastSyncedNotes: Record<string, SyncInfo> = {};

	constructor(fileManager: FileManager, minoteApi: MinoteApi, private readonly externalLogin: ExternalLoginService,
		private readonly checkpointMove?: (record: SyncInfo) => Promise<void>) {
		this.fileManager = fileManager;
		this.minoteApi = minoteApi;
	}

	public async sync(force: boolean, onProgress: (result: ImportCounts) => void) {
		this.clear();

		const settings = get(settingsStore);
		const history = settings.lastImportDestination === this.fileManager.destination ? settings.lastTimeSynced : [];
		this.lastSyncedNotes = history
			.filter(note => note.type === 'note')
			.reduce((acc: Record<string, SyncInfo>, note: SyncInfo) => {
				acc[note.id] = { ...note };
				return acc;
			}, {});

		await this.fetchNotesAndFolders();
		this.adoptLegacyHistory();
		await this.createFolders();
		const result = await this.syncNotes(force, onProgress);

		const tracked = new Set(this.thisTimeSynced.filter(item => item.type === 'note').map(item => item.id));
		const retained = Object.values(this.lastSyncedNotes).filter(item => !tracked.has(item.id));
		return { ...result, synced: [...this.thisTimeSynced, ...retained] };
	}

	private adoptLegacyHistory() {
		const cloudIds = new Set(this.notes.map(note => note.id));
		const claimCounts = new Map<string, number>();
		for (const { legacyId } of this.notes) {
			if (legacyId) claimCounts.set(legacyId, (claimCounts.get(legacyId) ?? 0) + 1);
		}
		for (const { id, legacyId } of this.notes) {
			if (!legacyId || !this.lastSyncedNotes[legacyId] || id === legacyId || this.lastSyncedNotes[id]) continue;
			if (cloudIds.has(legacyId) || claimCounts.get(legacyId) !== 1) {
				throw new Error('Conflicting legacy note IDs');
			}
			this.lastSyncedNotes[id] = { ...this.lastSyncedNotes[legacyId], id };
			delete this.lastSyncedNotes[legacyId];
		}
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
			if (!Array.isArray(page.data?.entries) || !Array.isArray(page.data?.folders)) {
				throw new Error('Invalid Xiaomi Notes inventory');
			}
			for (const entry of page.data.entries) {
				if (cloudNoteTypes.has(entry.type)) {
					const id = String(entry.id);
					const folderId = String(entry.folderId ?? '0');
					const extra = this.readExtraInfo(entry.extraInfo);
					if (this.isPrivate(folderId, extra.isPrivate) || entry.status === 'deleted' || entry.status === 'purged'
						|| !/^\d+$/.test(id) || seenNotes.has(id)) continue;
					seenNotes.add(id);
					const encrypted = Boolean(entry.encryptInfo) || (typeof entry.snippet === 'string' && isEncryptedNoteContent(entry.snippet));
					const originalTitle = typeof extra.title === 'string' && !isEncryptedNoteContent(extra.title)
						? extra.title : '';

					const note: Note = {
						id,
						// The legacy ID can be a JSON integer beyond JavaScript's safe range.
						legacyId: this.readLegacyId(entry.extraInfo),
						title: this.noteFileName(originalTitle) ? originalTitle : this.untitledNoteName(entry.createDate, id),
						createDate: entry.createDate,
						modifyDate: entry.modifyDate,
						folderId,
						encrypted,
					};
					this.notes.push(note);
				}
			}

			for (const entry of page.data.folders) {
				if (entry.type === 'folder') {
					const id = String(entry.id);
					if (id === '0' || id === '2' || seenFolders.has(id)) continue;
					seenFolders.add(id);
					// 解析文件夹
					const folder: Folder = {
						id,
						name: this.safeName(entry.subject) || '未命名分类',
						category: entry.subject || '未命名分类',
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

	private readExtraInfo(raw: unknown): { title?: unknown; isPrivate?: unknown; v3SyncId?: unknown } {
		if (typeof raw !== 'string') return {};
		try {
			return JSON.parse(raw) ?? {};
		} catch {
			return {};
		}
	}

	private readLegacyId(raw: unknown): string | undefined {
		if (typeof raw !== 'string') return undefined;
		// Quote the number before parsing so digits inside a title cannot become a top-level ID.
		const extra = this.readExtraInfo(raw.replace(/("v3SyncId"\s*:\s*)(\d+)(?=\s*[,}])/g, '$1"$2"'));
		return typeof extra.v3SyncId === 'string' && /^\d+$/.test(extra.v3SyncId) ? extra.v3SyncId : undefined;
	}

	private isPrivate(folderId: string, flag: unknown): boolean {
		return folderId === '2' || flag === true || flag === 'true' || flag === 1;
	}

	private async createFolders() {
		// 添加默认文件夹
		this.folders.unshift({ id: '0', name: '未分类', category: '未分类' });

		const usedNames = new Set<string>();
		// Reserve the default category before allocating names for cloud folders.
		for (const folder of this.folders) {
			const base = folder.name;
			for (let index = 2; usedNames.has(this.pathKey(folder.name)); index++) {
				folder.name = `${base} (${index})`;
			}
			usedNames.add(this.pathKey(folder.name));
			// 更新文件夹字典
			this.folderDict[folder.id] = folder;

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
				if (previous?.pendingMove) {
					if (!await this.fileManager.exists(previous.relativePath) && await this.fileManager.exists(previous.pendingMove)) {
						previous.relativePath = previous.pendingMove;
					}
					delete previous.pendingMove;
				}
				const folder = this.folderDict[note.folderId];
				if (!folder) throw new Error('Missing cloud folder');
				const folderPath = folder.name;
				const oldPath = previous?.relativePath.replace(/\\/g, '/');
				const sourceFolder = oldPath ? path.posix.dirname(oldPath) : undefined;
				const moved = sourceFolder !== undefined && sourceFolder !== folderPath
					&& (this.pathKey(sourceFolder) !== this.pathKey(folderPath)
						|| await this.fileManager.hasSeparateFolders(sourceFolder, folderPath));
				const unchanged = !force && previous && note.modifyDate <= previous.syncTime;
				if (unchanged && await this.checkPreviousNote(note, previous)) {
					if (moved) {
						step = '更新本地分类';
						previous.relativePath = await this.movePreviousNote(note, previous, folderPath);
					}
					step = '写入本地文件';
					const updated = await this.fileManager.updateFile(previous.relativePath,
						markdown => withNoteProperties(markdown, note, folder.category));
					if (moved || updated) result.count++;
					else result.skipped++;
					this.thisTimeSynced.push({ ...previous, name: note.title, decoded: previous.decoded ?? false, imageFormatChecked: true });
					continue;
				}

				step = '读取云端正文';
				const noteDetails = await this.minoteApi.fetchNoteDetails(note.id);
				const entry = noteDetails.data?.entry;
				if (typeof entry?.content !== 'string' || String(entry.id) !== note.id
					|| this.isPrivate(String(entry.folderId), this.readExtraInfo(entry.extraInfo).isPrivate)) {
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
				const previousMarkdown = previous && !this.pathOwnedByAnother(note.id, previous.relativePath)
					&& await this.fileManager.exists(previous.relativePath)
					? await this.fileManager.readFile(previous.relativePath) : '';
				content = withNoteProperties(previousMarkdown, note, folder.category, content);
				const notePath = await this.availableNotePath(folderPath, note.id, this.noteFileName(note.title),
					moved ? undefined : oldPath);
				const replacing = previous && (moved || previous.relativePath.replace(/\\/g, '/') !== notePath)
					&& !this.pathOwnedByAnother(note.id, previous.relativePath) && await this.fileManager.exists(previous.relativePath);
				if (replacing && attachmentsPending) {
					step = '处理图片';
					throw new Error('Attachments are required before moving an existing note');
				}
				if (replacing) {
					step = '更新本地分类';
					await this.copyPreviousImages(previous.relativePath, folderPath);
					await this.moveTrackedFile(previous, notePath);
					previous.relativePath = notePath;
				}
				step = '写入本地文件';
				await this.fileManager.saveFile(notePath, content, note.createDate, note.modifyDate);

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

	private async checkPreviousNote(note: Note, previous: SyncInfo): Promise<boolean> {
		if (!await this.fileManager.exists(previous.relativePath)
			|| this.pathOwnedByAnother(note.id, previous.relativePath)) return false;
		if (previous.attachmentsPending) return false;
		if (previous.imageFormatChecked && previous.decoded !== undefined) return true;
		const content = await this.fileManager.readFile(previous.relativePath);
		return !isEncryptedNoteContent(content) && !originalImage.test(content);
	}

	private async movePreviousNote(note: Note, previous: SyncInfo, folder: string): Promise<string> {
		const oldPath = previous.relativePath.replace(/\\/g, '/');
		await this.copyPreviousImages(oldPath, folder, true);
		const newPath = await this.availableNotePath(folder, note.id, path.posix.parse(oldPath).name);
		await this.moveTrackedFile(previous, newPath);
		return newPath;
	}

	private async copyPreviousImages(oldPath: string, folder: string, requireImages = false) {
		const oldFolder = path.posix.dirname(oldPath.replace(/\\/g, '/'));
		if (oldFolder === folder) return;
		const content = await this.fileManager.readFile(oldPath);
		for (const fileName of new Set([...content.matchAll(localImage)].map(match => match[1]))) {
			const target = path.posix.join(folder, 'img', fileName);
			if (await this.fileManager.hasBinaryFile(target)) continue;
			const source = path.posix.join(oldFolder, 'img', fileName);
			if (!await this.fileManager.hasBinaryFile(source)) {
				if (requireImages) throw new Error('Missing local attachment');
				continue;
			}
			await this.fileManager.createFolder(path.posix.join(folder, 'img'));
			await this.fileManager.copyFile(source, target);
		}
	}

	private async moveTrackedFile(previous: SyncInfo, newPath: string) {
		await this.checkpointMove?.({ ...previous, pendingMove: newPath });
		await this.fileManager.moveFile(previous.relativePath, newPath);
	}

	private pathOwnedByAnother(noteId: string, filePath: string): boolean {
		const key = this.pathKey(filePath);
		return [...Object.values(this.lastSyncedNotes), ...this.thisTimeSynced]
			.some(item => item.type === 'note' && item.id !== noteId && this.pathKey(item.relativePath) === key);
	}

	private noteFileName(title: string): string {
		return this.safeName(title.replace(/<[^>]+>/g, ''));
	}

	private untitledNoteName(createDate: number, noteId: string): string {
		const date = new Date(createDate);
		const day = Number.isFinite(createDate) && !Number.isNaN(date.getTime())
			? [String(date.getFullYear()).padStart(4, '0'), String(date.getMonth() + 1).padStart(2, '0'),
				String(date.getDate()).padStart(2, '0')].join('-')
			: '无创建日期';
		// 同一篇笔记每次导入得到相同的六位数字，避免反复改名。
		const hash = createHash('sha256').update(noteId).digest().readUInt32BE(0);
		const suffix = String(hash % 1_000_000).padStart(6, '0');
		return `${day}-${suffix}`;
	}

	private async availableNotePath(folder: string, noteId: string, name: string, oldPath?: string): Promise<string> {
		let stem = '';
		for (const char of name) {
			if (Buffer.byteLength(stem + char, 'utf8') > 180) break;
			stem += char;
		}
		let candidate = path.posix.join(folder, `${stem}.md`);
		for (let index = 1; ; index++) {
			if (!this.pathOwnedByAnother(noteId, candidate)) {
				if (oldPath === candidate || !await this.fileManager.exists(candidate)) return candidate;
				if (oldPath && this.pathKey(oldPath) === this.pathKey(candidate)
					&& await this.fileManager.isExistingFileAlias(oldPath, candidate)) return oldPath;
			}
			candidate = path.posix.join(folder, `${stem}_${this.safeName(noteId)}_${index}.md`);
		}
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

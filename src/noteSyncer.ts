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
import { assertImportActive, isTaskInterruption, ImportCancelledError, WebSessionError, waitFor, type ImportControl } from './importControl';
import { isEncryptedNoteContent } from './webNote';
import { formatTime, readNoteId, withNoteProperties } from './noteProperties';
import path from 'path';
import type { Note, Folder, SyncInfo, ImageInfo, NoteContentReader } from './models';

const originalImage = /☺[^\S\r\n]+[^\s<]+|<img\b[^>]*\bfileid=|https?:\/\/com\.miui\.notes\/image\//i;
const localImage = /!\[(?:\\[^\r\n]|[^\]\\\r\n])*\]\(img\/([a-z\d_~.-]+)\)/gi;
const cloudNoteTypes = new Set(['note', 'mdNote', 'mindMap']);

interface ImportCounts {
	total: number;
	count: number;
	skipped: number;
	locked: number;
	failed: number;
	partial: number;
	deleted: number;
	failuresByStep: Record<string, number>;
	cancelled?: boolean;
	interrupted?: string;
}

export default class NoteSyncer {
	private fileManager: FileManager;
	private minoteApi: MinoteApi;
	private notes: Note[] = [];
	private folders: Folder[] = [];
	private folderDict: Record<string, Folder> = {};
	private thisTimeSynced: SyncInfo[] = [];
	private lastSyncedNotes: Record<string, SyncInfo> = {};
	private history: SyncInfo[] = [];
	private account = '';
	private images = new Map<string, SyncInfo>();
	private oldFolders = new Map<string, SyncInfo>();
	private control: ImportControl = {};
	private progressResult?: ImportCounts;

	constructor(fileManager: FileManager, minoteApi: MinoteApi, private readonly contentReader: NoteContentReader,
		private readonly checkpointMove?: (record: SyncInfo) => Promise<void>) {
		this.fileManager = fileManager;
		this.minoteApi = minoteApi;
	}

	public async sync(force: boolean, onProgress: (result: ImportCounts) => void, control: ImportControl = {}) {
		this.clear();
		this.control = control;
		this.progressResult = undefined;

		const settings = get(settingsStore);
		this.account = this.minoteApi.accountKey;
		this.history = settings.lastImportDestination === this.fileManager.destination ? settings.lastTimeSynced : [];
		const history = this.history.filter(item => !item.account || item.account === this.account);
		for (const item of history) {
			if (item.type === 'image') this.images.set(this.pathKey(item.relativePath), { ...item });
			if (item.type === 'folder') this.oldFolders.set(this.pathKey(item.relativePath), { ...item });
		}
		this.lastSyncedNotes = history
			.filter(note => note.type === 'note')
			.reduce((acc: Record<string, SyncInfo>, note: SyncInfo) => {
				acc[note.id] = { ...note };
				return acc;
			}, {});

		let result: ImportCounts = { total: 0, count: 0, skipped: 0, locked: 0, failed: 0, partial: 0, deleted: 0, failuresByStep: {} };
		try {
			await this.assertActive();
			await this.fetchNotesAndFolders();
			result.total = this.notes.length;
			const folderIds = new Set(['0', ...this.folders.map(folder => folder.id)]);
			if (this.notes.some(note => !folderIds.has(note.folderId))) throw new Error('Incomplete cloud folder inventory');
			this.adoptLegacyHistory();
			await this.assertActive();
			await this.createFolders();
			result = await this.syncNotes(force, onProgress);
			await this.assertActive();
			// 正文或附件未处理完时，整轮跳过清理，留待下次完整导入后处理。
			if (!result.locked && !result.failed && !result.partial) await this.cleanRemovedContent(result);
		} catch (error) {
			if (!isTaskInterruption(error) && !control.signal?.aborted) throw error;
			result = this.progressResult ?? result;
			result.cancelled = error instanceof ImportCancelledError || !!control.signal?.aborted;
			result.interrupted = result.cancelled ? '导入已取消'
				: error instanceof WebSessionError ? error.message : '小米笔记连接已变化，导入已停止';
		}

		const tracked = new Set(this.thisTimeSynced.filter(item => item.type === 'note').map(item => item.id));
		const retained = Object.values(this.lastSyncedNotes).filter(item => !tracked.has(item.id));
		const foreign = this.history.filter(item => item.account && item.account !== this.account);
		return { ...result, synced: [...this.thisTimeSynced, ...retained, ...this.images.values(), ...this.oldFolders.values(), ...foreign] };
	}

	private assertActive(): Promise<void> { return assertImportActive(this.control); }

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
		this.images.clear();
		this.oldFolders.clear();
	}

	private async fetchNotesAndFolders() {
		const seenNotes = new Set<string>();
		const seenFolders = new Set<string>();
		const pageTokens = new Set<string>();
		// 获取第一页
		let page = await waitFor(this.minoteApi.fetchPage(), 30_000, this.control.signal);
		while (true) {
			await this.assertActive();
			if ((page.code !== undefined && page.code !== 0) || !Array.isArray(page.data?.entries)
				|| !Array.isArray(page.data?.folders) || typeof page.data.lastPage !== 'boolean') {
				throw new Error('Invalid Xiaomi Notes inventory');
			}
			for (const entry of page.data.entries) {
				if (!entry || !cloudNoteTypes.has(entry.type)) throw new Error('Unknown cloud note type');
				if (cloudNoteTypes.has(entry.type)) {
					const id = String(entry.id);
					const folderId = String(entry.folderId ?? '0');
					const extra = this.readExtraInfo(entry.extraInfo);
					if (!/^\d+$/.test(id) || seenNotes.has(id)) throw new Error('Invalid or repeated cloud note ID');
					seenNotes.add(id);
					if (this.isPrivate(folderId, extra.isPrivate) || entry.status === 'deleted' || entry.status === 'purged') continue;
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
				if (!entry || entry.type !== 'folder' || !/^\d+$/.test(String(entry.id))) throw new Error('Invalid cloud folder');
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
			await this.assertActive();
			page = await waitFor(this.minoteApi.fetchPage(token), 30_000, this.control.signal);
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
			await this.assertActive();
			for (const previous of this.oldFolders.values()) {
				if (previous.id === folder.id && this.account) previous.account = this.account;
			}
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
				account: this.account || undefined,
				syncTime: Date.now()
			});
		}
	}

	private async syncNotes(force: boolean, onProgress: (result: ImportCounts) => void) {
		const result: ImportCounts = {
			total: this.notes.length, count: 0, skipped: 0, locked: 0, failed: 0, partial: 0, deleted: 0, failuresByStep: {}
		};
		this.progressResult = result;
		onProgress(result);

		// 记录此次同步信息
		for (const note of this.notes) {
			const previous = this.lastSyncedNotes[note.id];
			let step = '检查本地文件';
			try {
				await this.assertActive();
				if (previous && this.account) previous.account = this.account;
				if (previous) await this.recoverPendingMove(previous);
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
					const newPath = await this.availableNotePath(folderPath, note.id, this.noteFileName(note.title), moved ? undefined : oldPath);
					const renamed = newPath !== oldPath;
					if (renamed) {
						step = '更新本地分类';
						await this.copyPreviousImages(previous.relativePath, folderPath, true);
						await this.moveTrackedFile(previous, newPath);
						previous.relativePath = newPath;
					}
					step = '写入本地文件';
					const updated = await this.fileManager.updateFile(previous.relativePath,
						markdown => withNoteProperties(markdown, note, folder.category));
					if (renamed || updated) result.count++;
					else result.skipped++;
					this.thisTimeSynced.push({ ...previous, name: note.title, decoded: previous.decoded ?? false, imageFormatChecked: true, imageFormatVersion: 2 });
					continue;
				}

				step = '读取云端正文';
				const noteDetails = await waitFor(this.minoteApi.fetchNoteDetails(note.id), 30_000, this.control.signal);
				await this.assertActive();
				const entry = noteDetails.data?.entry;
				if (typeof entry?.content !== 'string' || String(entry.id) !== note.id
					|| this.isPrivate(String(entry.folderId), this.readExtraInfo(entry.extraInfo).isPrivate)) {
					throw new Error('Missing note content');
				}
				const encrypted = note.encrypted || Boolean(entry.encryptInfo) || isEncryptedNoteContent(entry.content);
				let content: string | null = encrypted && entry.content
					? await this.contentReader.readEncryptedNote({ id: note.id, content: entry.content, encryptInfo: entry.encryptInfo })
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
						this.trackImage(path.posix.join(folderPath, 'img', fileName));
						if (sourceFolder && sourceFolder !== folderPath) {
							const source = path.posix.join(sourceFolder, 'img', fileName);
							if (await this.fileManager.hasBinaryFile(source)) this.trackImage(source);
						}
						imgDict.set(image.fileId, fileName);
						if (image.digest) imgDict.set(image.digest.toLowerCase(), fileName);
					} catch (error) {
						if (isTaskInterruption(error) || this.control.signal?.aborted) throw error;
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
				// Markdown 笔记按摘要引用图片，与旧 XML 中的 fileId 不同。
				content = content.replace(/https?:\/\/com\.miui\.notes\/image\/([a-f\d]{40})(?:\?[^\s)<>"']*)?/gi,
					(url, digest: string) => imgDict.has(digest.toLowerCase()) ? 'img/' + imgDict.get(digest.toLowerCase()) : url);
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
					account: this.account || undefined,
					type: 'note',
					name: note.title,
					relativePath: notePath,
					syncTime: note.modifyDate,
					decoded: encrypted,
					imageFormatChecked: true,
					imageFormatVersion: 2,
					attachmentsPending
				});
			} catch (error) {
				if (isTaskInterruption(error) || this.control.signal?.aborted) throw error;
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
		if (previous.imageFormatVersion === 2 && previous.decoded !== undefined) return true;
		const content = await this.fileManager.readFile(previous.relativePath);
		return !isEncryptedNoteContent(content) && !originalImage.test(content);
	}

	private async copyPreviousImages(oldPath: string, folder: string, requireImages = false) {
		const oldFolder = path.posix.dirname(oldPath.replace(/\\/g, '/'));
		if (oldFolder === folder) return;
		const content = await this.fileManager.readFile(oldPath);
		for (const fileName of new Set([...content.matchAll(localImage)].map(match => match[1]))) {
			const target = path.posix.join(folder, 'img', fileName);
			const source = path.posix.join(oldFolder, 'img', fileName);
			if (this.images.has(this.pathKey(source))) this.trackImage(target);
			if (await this.fileManager.hasBinaryFile(target)) continue;
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
		return [...this.history.filter(item => item.account && item.account !== this.account), ...Object.values(this.lastSyncedNotes), ...this.thisTimeSynced]
			.some(item => item.type === 'note' && (item.id !== noteId || (item.account && item.account !== this.account))
				&& this.pathKey(item.relativePath) === key);
	}

	private trackImage(relativePath: string) {
		if (!this.account) return;
		relativePath = relativePath.replace(/\\/g, '/');
		this.images.set(this.pathKey(relativePath), {
			id: relativePath, type: 'image', name: path.posix.basename(relativePath), relativePath,
			account: this.account, syncTime: Date.now()
		});
	}

	private async recoverPendingMove(previous: SyncInfo) {
		if (!previous.pendingMove) return;
		const sourceExists = await this.fileManager.exists(previous.relativePath);
		const targetExists = await this.fileManager.exists(previous.pendingMove);
		if (sourceExists && targetExists && this.pathKey(previous.relativePath) !== this.pathKey(previous.pendingMove)) {
			throw new Error('Ambiguous interrupted move');
		}
		if (!sourceExists && targetExists) {
			const markdown = await this.fileManager.readFile(previous.pendingMove);
			for (const match of markdown.matchAll(localImage)) {
				const source = path.posix.join(path.posix.dirname(previous.relativePath.replace(/\\/g, '/')), 'img', match[1]);
				if (this.images.has(this.pathKey(source))) {
					this.trackImage(path.posix.join(path.posix.dirname(previous.pendingMove.replace(/\\/g, '/')), 'img', match[1]));
				}
			}
			previous.relativePath = previous.pendingMove;
		}
		delete previous.pendingMove;
	}

	private async cleanRemovedContent(result: ImportCounts) {
		await this.assertActive();
		const cloudIds = new Set(this.notes.map(note => note.id));
		const stale = Object.values(this.lastSyncedNotes).filter(item => !cloudIds.has(item.id));
		const fail = (step: string) => {
			result.failed++;
			result.failuresByStep[step] = (result.failuresByStep[step] || 0) + 1;
		};
		const currentAccount = new MinoteApi().accountKey;
		if (!this.account || currentAccount !== this.account) {
			for (const _ of stale) fail('检查本地文件');
			return;
		}
		for (const previous of stale) {
			try {
				await this.assertActive();
				await this.recoverPendingMove(previous);
				const file = previous.relativePath;
				if (await this.fileManager.exists(file)) {
					if (previous.account !== this.account || this.pathOwnedByAnother(previous.id, file)
						|| readNoteId(await this.fileManager.readFile(file)) !== previous.id) throw new Error('Note identity mismatch');
					await this.fileManager.deleteFile(file);
					result.deleted++;
				}
				delete this.lastSyncedNotes[previous.id];
			} catch (error) {
				if (isTaskInterruption(error) || this.control.signal?.aborted) throw error;
				fail('检查本地文件');
			}
		}
		// 待解密或写入失败时保留附件，避免根据不完整的正文判断图片已经无引用。
		if (!result.locked && !result.partial && !result.failed) {
			try {
				const unused = await this.fileManager.unreferencedImages([...this.images.values()].map(item => item.relativePath));
				for (const image of unused) {
					await this.assertActive();
					await this.fileManager.deleteFile(image);
					this.images.delete(this.pathKey(image));
					await this.fileManager.deleteEmptyFolder(path.posix.dirname(image));
				}
			} catch (error) {
				if (isTaskInterruption(error) || this.control.signal?.aborted) throw error;
				fail('处理图片');
			}
		}
		const currentFolders = new Set(this.thisTimeSynced.filter(item => item.type === 'folder').map(item => this.pathKey(item.relativePath)));
		for (const [key, folder] of this.oldFolders) {
			await this.assertActive();
			if (currentFolders.has(key)) { this.oldFolders.delete(key); continue; }
			if (folder.account !== this.account) continue;
			try {
				await this.fileManager.deleteEmptyFolder(path.posix.join(folder.relativePath, 'img'));
				await this.fileManager.deleteEmptyFolder(folder.relativePath);
				if (!await this.fileManager.exists(folder.relativePath)) this.oldFolders.delete(key);
			} catch (error) {
				if (isTaskInterruption(error) || this.control.signal?.aborted) throw error;
				fail('更新本地分类');
			}
		}
	}

	private noteFileName(title: string): string {
		return this.safeName(title.replace(/<[^>]+>/g, ''));
	}

	private untitledNoteName(createDate: number, noteId: string): string {
		const day = formatTime(createDate)?.split('T')[0] ?? '无创建日期';
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
		const webImage = await this.contentReader.readImage(image);
		if (!webImage && encrypted) throw new Error('Encrypted image unavailable');
		const imgBinary = webImage ?? await waitFor(this.minoteApi.fetchImage(image.fileId), 45_000, this.control.signal);
		await this.fileManager.saveBinaryFile(imgPath, imgBinary);
	}
}

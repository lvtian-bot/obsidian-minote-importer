/**
 * @file Vault 文件管理器
 * @author Emac
 * @date 2025-01-05
 */
import { normalizePath } from 'obsidian';
import type { FileSystemAdapter, Vault } from 'obsidian';
import path from 'path';
import { realpath, rmdir } from 'fs/promises';

export default class FileManager {
	readonly destination: string;

	constructor(private readonly vault: Vault, private readonly adapter: FileSystemAdapter, destination: string,
		private readonly beforeMutation?: () => Promise<void>) {
		this.destination = destination === '/' ? '/' : this.validateRelativePath(destination);
	}

	private validateRelativePath(value: string): string {
		const relative = value.replace(/\\/g, '/');
		if (!relative || relative.startsWith('/') || /[:\0]/.test(relative)
			|| relative.split('/').some(segment => segment === '..' || segment === '.')) {
			throw new Error('Invalid path in note import');
		}
		return normalizePath(relative);
	}

	private vaultPath(relative: string): string {
		const child = this.validateRelativePath(relative);
		return this.destination === '/' ? child : this.destination + '/' + child;
	}

	async exists(filePath: string) {
		if (!filePath) {
			return false;
		}

		return this.adapter.exists(this.vaultPath(filePath));
	}

	async readFile(filePath: string): Promise<string> {
		return this.adapter.read(this.vaultPath(filePath));
	}

	async hasBinaryFile(filePath: string): Promise<boolean> {
		const stat = await this.adapter.stat(this.vaultPath(filePath));
		return stat?.type === 'file' && stat.size > 0;
	}

	async createFolder(folderPath: string) {
		if (!folderPath || await this.exists(folderPath)) {
			return;
		}

		const fullPath = this.vaultPath(folderPath);
		const parent = path.posix.dirname(fullPath);
		if (parent !== '.') {
			await this.ensureDirectory(parent);
		}
		await this.beforeMutation?.();
		await this.vault.createFolder(fullPath);
	}

	private async ensureDirectory(directory: string): Promise<void> {
		if (await this.adapter.exists(directory)) return;
		const parent = path.posix.dirname(directory);
		if (parent !== '.') await this.ensureDirectory(parent);
		await this.beforeMutation?.();
		await this.vault.createFolder(directory);
	}

	async deleteFile(filePath: string) {
		if (!filePath || !await this.exists(filePath)) {
			return;
		}

		await this.beforeMutation?.();
		await this.adapter.trashLocal(this.vaultPath(filePath));
	}

	async deleteEmptyFolder(folderPath: string): Promise<void> {
		if (!await this.exists(folderPath)) return;
		const relative = this.vaultPath(folderPath);
		const children = await this.adapter.list(relative);
		if (children.files.length || children.folders.length) return;
		const root = await realpath(this.adapter.getBasePath());
		const local = await realpath(this.adapter.getFullPath(relative));
		const verified = path.relative(root, local);
		if (!verified || path.isAbsolute(verified) || verified === '..' || verified.startsWith('..' + path.sep)
			|| path.normalize(relative) !== verified) return;
		// Obsidian 的部分版本用 fs.rm 实现 rmdir，非递归调用不能删除目录。
		// 原生 rmdir 只接受空目录，即便检查后又写入文件也不会误删。
		await this.beforeMutation?.();
		await rmdir(local);
	}

	async unreferencedImages(candidates: string[]): Promise<string[]> {
		if (!candidates.length) return [];
		const unused = new Set(candidates);
		const files = new Set<string>();
		const directories = [''];
		while (directories.length) {
			const directory = directories.pop()!;
			// 笔记库可能同时删除或移动目录；不把读不全的扫描结果用于清理。
			const children = await this.adapter.list(directory);
			for (const file of children.files) if (/\.md$/i.test(file)) files.add(file);
			for (const folder of children.folders) {
				if (!['.trash', '.git', this.vault.configDir].includes(folder)) directories.push(folder);
			}
		}
		const knownImage = /!\[(?:\\[^\r\n]|[^\]\\\r\n])*\]\(img\/([a-z\d_~.-]+)\)/gi;
		for (const file of files) {
			if (!unused.size) break;
			if (!await this.adapter.exists(file)) continue;
			const markdown = await this.adapter.read(file);
			const referenced = new Set([...markdown.matchAll(knownImage)].map(match =>
				normalizePath(path.posix.join(path.posix.dirname(file), 'img', match[1])).toLowerCase()));
			// 非插件生成的链接按文件名保守保留，覆盖双链、HTML、引用式链接及转义路径。
			const otherLinks = markdown.replace(knownImage, '').replace(/(?:%[a-f\d]{2})+/gi, encoded => {
				try { return decodeURIComponent(encoded); } catch { return encoded; }
			}).toLowerCase();
			for (const candidate of unused) {
				if (referenced.has(this.vaultPath(candidate).toLowerCase())
					|| otherLinks.includes(path.posix.basename(candidate).toLowerCase())) unused.delete(candidate);
			}
		}
		return [...unused];
	}

	async moveFile(oldPath: string, newPath: string): Promise<void> {
		if (await this.exists(newPath)) throw new Error('Destination already exists');
		await this.beforeMutation?.();
		await this.adapter.rename(this.vaultPath(oldPath), this.vaultPath(newPath));
	}

	async copyFile(oldPath: string, newPath: string): Promise<void> {
		if (await this.exists(newPath)) throw new Error('Destination already exists');
		await this.beforeMutation?.();
		await this.adapter.copy(this.vaultPath(oldPath), this.vaultPath(newPath));
	}

	async hasSeparateFolders(oldFolder: string, newFolder: string): Promise<boolean> {
		const parent = this.destination === '/' ? '' : this.destination;
		const { folders } = await this.adapter.list(parent);
		return folders.includes(this.vaultPath(oldFolder)) && folders.includes(this.vaultPath(newFolder));
	}

	async isExistingFileAlias(oldPath: string, newPath: string): Promise<boolean> {
		if (!await this.exists(oldPath) || !await this.exists(newPath)) return false;
		const { files } = await this.adapter.list(path.posix.dirname(this.vaultPath(oldPath)));
		return !files.includes(this.vaultPath(newPath));
	}

	async updateFile(filePath: string, update: (content: string) => string): Promise<boolean> {
		const fullPath = this.vaultPath(filePath);
		const original = await this.adapter.read(fullPath);
		const replacement = update(original);
		if (replacement === original) return false;
		const stat = await this.adapter.stat(fullPath);
		if (!stat || stat.type !== 'file') throw new Error('Missing note file');
		const times = { ctime: stat.ctime, mtime: stat.mtime };
		if (typeof this.adapter.process !== 'function') {
			// Older supported Obsidian versions have no atomic adapter process method.
			if (await this.adapter.read(fullPath) !== original) throw new Error('Note changed during property update');
			await this.beforeMutation?.();
			await this.adapter.write(fullPath, replacement, times);
			return true;
		}
		let updated = false;
		await this.beforeMutation?.();
		await this.adapter.process(fullPath, content => {
			const result = content === original ? replacement : update(content);
			updated = result !== content;
			return result;
		}, times);
		return updated;
	}

	async saveFile(filePath: string, content: string, createDate: number, modifyDate: number) {
		if (!filePath) {
			return;
		}

		const fullPath = this.vaultPath(filePath);
		await this.beforeMutation?.();
		await this.adapter.write(fullPath, content, {
			ctime: Number.isFinite(createDate) ? createDate : undefined,
			mtime: Number.isFinite(modifyDate) ? modifyDate : undefined,
		});
	}

	async saveBinaryFile(filePath: string, binary: ArrayBuffer) {
		if (!filePath) {
			return;
		}

		await this.beforeMutation?.();
		await this.adapter.writeBinary(this.vaultPath(filePath), binary);
	}
}

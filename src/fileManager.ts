/**
 * @file Vault 文件管理器
 * @author Emac
 * @date 2025-01-05
 */
import { normalizePath } from 'obsidian';
import type { FileSystemAdapter, Vault } from 'obsidian';
import path from 'path';

export default class FileManager {
	readonly destination: string;

	constructor(private readonly vault: Vault, private readonly adapter: FileSystemAdapter, destination: string) {
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
		await this.vault.createFolder(fullPath);
	}

	private async ensureDirectory(directory: string): Promise<void> {
		if (await this.adapter.exists(directory)) return;
		const parent = path.posix.dirname(directory);
		if (parent !== '.') await this.ensureDirectory(parent);
		await this.vault.createFolder(directory);
	}

	async deleteFile(filePath: string) {
		if (!filePath || !await this.exists(filePath)) {
			return;
		}

		await this.adapter.remove(this.vaultPath(filePath));
	}

	async moveFile(oldPath: string, newPath: string): Promise<void> {
		if (await this.exists(newPath)) throw new Error('Destination already exists');
		await this.adapter.rename(this.vaultPath(oldPath), this.vaultPath(newPath));
	}

	async copyFile(oldPath: string, newPath: string): Promise<void> {
		if (await this.exists(newPath)) throw new Error('Destination already exists');
		await this.adapter.copy(this.vaultPath(oldPath), this.vaultPath(newPath));
	}

	async hasSeparateFolders(oldFolder: string, newFolder: string): Promise<boolean> {
		const parent = this.destination === '/' ? '' : this.destination;
		const { folders } = await this.adapter.list(parent);
		return folders.includes(this.vaultPath(oldFolder)) && folders.includes(this.vaultPath(newFolder));
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
			await this.adapter.write(fullPath, replacement, times);
			return true;
		}
		let updated = false;
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
		await this.adapter.write(fullPath, content, {
			ctime: Number.isFinite(createDate) ? createDate : undefined,
			mtime: Number.isFinite(modifyDate) ? modifyDate : undefined,
		});
	}

	async saveBinaryFile(filePath: string, binary: ArrayBuffer) {
		if (!filePath) {
			return;
		}

		await this.adapter.writeBinary(this.vaultPath(filePath), binary);
	}
}

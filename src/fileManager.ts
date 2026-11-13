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

	async renameFolder(oldPath: string, newPath: string): Promise<boolean> {
		if (!oldPath || !newPath) {
			return false;
		}

		if (!await this.exists(oldPath) || await this.exists(newPath)) {
			return false;
		}

		await this.adapter.rename(this.vaultPath(oldPath), this.vaultPath(newPath));
		return true;
	}

	async deleteFile(filePath: string) {
		if (!filePath || !await this.exists(filePath)) {
			return;
		}

		await this.adapter.remove(this.vaultPath(filePath));
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

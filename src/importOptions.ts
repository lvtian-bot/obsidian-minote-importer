import type { Note } from './models';

export type ImportMode = 'mirror' | 'copy';

export interface FolderSelection {
	account: string;
	ids: string[];
}

export interface ImportOptions {
	importMode: ImportMode;
	createdFrom: string;
	createdThrough: string;
	folderSelection: FolderSelection | null;
}

export const defaultImportOptions: ImportOptions = {
	importMode: 'mirror',
	createdFrom: '',
	createdThrough: '',
	folderSelection: null,
};

const hour = 60 * 60 * 1000;
const day = 24 * hour;
function startOfDay(value: string): number {
	const timestamp = Date.parse(value + 'T00:00:00+08:00');
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(timestamp)
		|| new Date(timestamp + 8 * hour).toISOString().slice(0, 10) !== value) {
		throw new ImportOptionsError('请选择有效的创建日期。');
	}
	return timestamp;
}

export class ImportOptionsError extends Error {}

export function creationDateBounds({ createdFrom, createdThrough }: ImportOptions) {
	const from = createdFrom === '' ? -Infinity : startOfDay(createdFrom);
	const until = createdThrough === '' ? Infinity : startOfDay(createdThrough) + day;
	if (from >= until) throw new ImportOptionsError('开始日期不能晚于结束日期。');
	return { from, until };
}

export function importFilter(options: ImportOptions, account: string) {
	if (options.importMode !== 'mirror' && options.importMode !== 'copy') {
		throw new ImportOptionsError('请选择有效的导入模式。');
	}
	const { from, until } = creationDateBounds(options);
	const hasDates = Number.isFinite(from) || Number.isFinite(until);
	const selection = options.folderSelection;
	if (selection !== null && (!account || selection?.account !== account
		|| !Array.isArray(selection.ids) || !selection.ids.length
		|| selection.ids.some(id => typeof id !== 'string' || !/^\d+$/.test(id) || id === '2'))) {
		throw new ImportOptionsError('请为当前小米账号重新选择文件夹，或选择「全部文件夹」。');
	}
	const folders = selection ? new Set(selection.ids) : null;
	if (!hasDates && !folders) return undefined;
	return (note: Note) => {
		if (folders && !folders.has(note.folderId)) return false;
		if (!hasDates) return true;
		if (!Number.isFinite(note.createDate) || !Number.isFinite(new Date(note.createDate).getTime())) {
			throw new ImportOptionsError('部分小米笔记缺少有效的创建日期，本轮导入已停止。');
		}
		return note.createDate >= from && note.createDate < until;
	};
}

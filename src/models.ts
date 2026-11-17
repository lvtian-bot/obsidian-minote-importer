/**
 * @file 同步模型
 * @author Emac
 * @date 2025-01-05
 */
export interface Note {
	id: string;
	legacyId?: string;
	title: string;
	createDate: number;
	modifyDate: number;
	folderId: string;
	encrypted: boolean;
}

export interface Folder {
	id: string;
	name: string;
	category: string;
}

export interface ImageInfo {
	fileId: string;
	fileType: string;
	digest?: string;
}

export interface NoteContentReader {
	readEncryptedNote(note: { id: string; content: string; encryptInfo: unknown }): Promise<string | null>;
	readImage(image: { fileId: string; digest?: string }): Promise<ArrayBuffer | null>;
}

export interface SyncInfo {
	id: string;
	type: string;
	name: string;
	relativePath: string;
	syncTime: number;
	decoded?: boolean;
	imageFormatChecked?: boolean;
	imageFormatVersion?: number;
	attachmentsPending?: boolean;
	pendingMove?: string;
	account?: string;
}

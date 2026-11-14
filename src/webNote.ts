interface NotesWebpackRequire {
	(id: string): Record<string, unknown>;
	m: Record<string, (...args: unknown[]) => unknown>;
	c: Record<string, unknown>;
}

export interface EncryptedNote {
	id: string;
	content: string;
	encryptInfo: unknown;
}

export function isEncryptedNoteContent(content: string): boolean {
	// The official Notes client prepends this 16-byte header before Base64 encoding.
	const prefix = '011112131415161718191a1b1c1d1e7e';
	return Buffer.from(content.trim().slice(0, 24), 'base64').subarray(0, 16).toString('hex') === prefix;
}

// Runs in the verified Xiaomi Notes page using the browser's existing session.
export async function readWebNote(host: string, note: EncryptedNote | null, image?: { fileId: string; digest?: string }): Promise<string | null> {
	if (location.origin !== `https://${host}` || !/^\/note(?:\/h5)?\/?$/.test(location.pathname)
		|| document.querySelector('.e2ee-captcha-input input, #refresh_modal_confirm')) {
		return null;
	}
	const chunks = (window as Window & { webpackJsonp?: unknown[][] }).webpackJsonp;
	if (!chunks) {
		return null;
	}
	const probe = `minote-importer-${Date.now()}-${Math.random()}`;
	let requireModule: NotesWebpackRequire | undefined;
	chunks.push([[probe], {
		[probe]: (_module: unknown, _exports: unknown, runtime: NotesWebpackRequire) => {
			requireModule = runtime;
		}
	}, [[probe]]]);
	const runtime = requireModule as NotesWebpackRequire | undefined;
	if (!runtime?.m) {
		return null;
	}
	delete runtime.m[probe];
	delete runtime.c[probe];
	const detailRoute = /\/note\/(?:v2\/)?note\//;
	const listRoute = /\/note\/(?:v2\/)?full\/page/;
	const moduleId = Object.keys(runtime.m).find(id => {
		const source = String(runtime.m[id]);
		return detailRoute.test(source) && listRoute.test(source) && source.includes('encryptInfo');
	});
	if (!moduleId) {
		return null;
	}
	const exports = Object.values(runtime(moduleId));
	if (image) {
		const getImage = exports.find(value => typeof value === 'function' && String(value).includes('/file/full/v2'));
		if (typeof getImage !== 'function') return null;
		const info = await getImage(image.fileId);
		const storage = info?.kss;
		if (!info?.encryptInfo && typeof storage?.url === 'string') return 'legacy-image';
		if (!Array.isArray(storage?.blocks) || !storage.blocks.length) return null;
		const downloadModule = Object.keys(runtime.m).find(id => String(runtime.m[id]).includes('[getFileLocalUrlByBlocks]'));
		if (!downloadModule) return null;
		const download = Object.values(runtime(downloadModule)).find(value =>
			typeof value === 'function' && String(value).includes('[getFileLocalUrlByBlocks]'));
		if (typeof download !== 'function') return null;
		const url = await download({ sha1: image.digest, blocks: storage.blocks, RC4Key: storage.secure_key }, info.encryptInfo);
		if (typeof url !== 'string' || !url.startsWith('blob:' + location.origin + '/')) return null;
		const response = await fetch(url);
		if (!response.ok) return null;
		const blob = await response.blob();
		if (!blob.size || blob.size > 48 * 1024 * 1024) return null;
		return new Promise<string | null>(resolve => {
			const reader = new FileReader();
			reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result.split(',', 2)[1] ?? null : null);
			reader.onerror = () => resolve(null);
			reader.readAsDataURL(blob);
		});
	}
	const readDetails = exports.find(value => {
		const source = typeof value === 'function' ? String(value) : '';
		return detailRoute.test(source) && source.includes('encryptInfo') && source.includes('.content') && source.includes('.snippet');
	});
	if (typeof readDetails !== 'function' || !note) return null;
	if (note.encryptInfo) {
		// Legacy note IDs may have no v2 entry. Resolve the decrypt function used by the web client's detail handler.
		const call = String(readDetails).match(/Object\(([\w$]+)\.([\w$]+)\)\([\w$]+,[\w$]+\)/);
		const binding = call?.[1];
		const exportName = call?.[2];
		if (binding && exportName) {
			const imports = String(runtime.m[moduleId]).matchAll(/(?:\b(?:var|let|const)\s+|[,;])\s*([\w$]+)\s*=\s*[\w$]+\(\s*(?:["']([\w$-]+)["']|(\d+))\s*\)/g);
			for (const [, name, stringId, numericId] of imports) {
				if (name !== binding) continue;
				try {
					const decrypt = runtime(stringId ?? numericId)[exportName];
					if (typeof decrypt !== 'function') break;
					const content = await decrypt(note.content, note.encryptInfo);
					if (typeof content === 'string' && content !== note.content) return content;
				} catch {
					// Fall back to the v2 detail handler when the legacy entry cannot be decoded directly.
				}
				break;
			}
		}
	}
	const details = await readDetails(note.id);
	const entry = details?.entry;
	return entry?.encryptInfo && String(entry.id) === note.id && typeof entry.content === 'string' ? entry.content : null;
}

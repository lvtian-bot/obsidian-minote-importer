interface NotesWebpackRequire {
	(id: string): Record<string, unknown>;
	m: Record<string, (...args: unknown[]) => unknown>;
	c: Record<string, unknown>;
}

export function isEncryptedNoteContent(content: string): boolean {
	// The official Notes client prepends this 16-byte header before Base64 encoding.
	const prefix = '011112131415161718191a1b1c1d1e7e';
	return Buffer.from(content.trim().slice(0, 24), 'base64').subarray(0, 16).toString('hex') === prefix;
}

// Runs in the verified Xiaomi Notes page using the browser's existing session.
export function readWebNote(host: string, noteId: string, image?: { fileId: string; digest?: string }): Promise<string | null> | null {
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
		const downloadModule = Object.keys(runtime.m).find(id => String(runtime.m[id]).includes('[getFileLocalUrlByBlocks]'));
		if (typeof getImage !== 'function' || !downloadModule) return null;
		const download = Object.values(runtime(downloadModule)).find(value =>
			typeof value === 'function' && String(value).includes('[getFileLocalUrlByBlocks]'));
		if (typeof download !== 'function') return null;
		return Promise.resolve(getImage(image.fileId)).then(info => {
			const storage = info?.kss;
			if (!Array.isArray(storage?.blocks) || !storage.blocks.length) return null;
			return download({ sha1: image.digest, blocks: storage.blocks, RC4Key: storage.secure_key }, info.encryptInfo);
		}).then(url => {
			if (typeof url !== 'string' || !url.startsWith(`blob:${location.origin}/`)) return null;
			return fetch(url).then(response => response.ok ? response.blob() : null);
		}).then(blob => {
			if (!blob?.size) return null;
			return new Promise<string | null>(resolve => {
				const reader = new FileReader();
				reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result.split(',', 2)[1] ?? null : null);
				reader.onerror = () => resolve(null);
				reader.readAsDataURL(blob);
			});
		}).catch(() => null);
	}
	const readDetails = exports.find(value => {
		const source = typeof value === 'function' ? String(value) : '';
		return detailRoute.test(source) && source.includes('encryptInfo') && source.includes('.content') && source.includes('.snippet');
	});
	if (typeof readDetails !== 'function') {
		return null;
	}
	return Promise.resolve(readDetails(noteId)).then(details => {
		const entry = details?.entry;
		return entry?.encryptInfo && String(entry.id) === noteId && typeof entry.content === 'string' ? entry.content : null;
	}).catch(() => null);
}

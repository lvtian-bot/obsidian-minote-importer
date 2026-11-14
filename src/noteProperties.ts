import { Document, isMap, isScalar, parseDocument, Scalar } from 'yaml';
import type { Note } from './models';

const frontmatter = /^(?:\uFEFF)?---[ \t]*\r?\n((?:[^\r\n]*\r?\n)*?)---[ \t]*(?:\r?\n|$)/;
const chinaOffset = 8 * 60 * 60 * 1000;

function formatTime(value: number): string | undefined {
	if (!Number.isFinite(value)) return undefined;
	const time = new Date(value + chinaOffset);
	if (!Number.isFinite(time.getTime())) return undefined;
	return time.toISOString().replace(/\.\d{3}Z$/, '+08:00');
}

export function withNoteProperties(markdown: string, note: Note, category: string, replacementBody?: string): string {
	const existing = frontmatter.exec(markdown);
	const document = existing ? parseDocument(existing[1], { intAsBigInt: true }) : new Document();
	if (document.errors.length || (document.contents !== null && !isMap(document.contents))) {
		throw new Error('Invalid note frontmatter');
	}

	const properties = {
		title: note.title,
		noteId: note.id,
		category,
		created: formatTime(note.createDate),
		modified: formatTime(note.modifyDate),
	};
	let changed = false;
	for (const [name, value] of Object.entries(properties)) {
		if (value === undefined) continue;
		const current = document.get(name, true);
		if (isScalar(current) && current.value === value && current.type === Scalar.QUOTE_DOUBLE) continue;
		if (isScalar(current)) {
			current.value = value;
			current.type = Scalar.QUOTE_DOUBLE;
			current.tag = undefined;
		} else {
			const scalar = new Scalar(value);
			scalar.type = Scalar.QUOTE_DOUBLE;
			document.set(name, scalar);
		}
		changed = true;
	}
	if (!changed && replacementBody === undefined) return markdown;

	const bom = markdown.startsWith('\uFEFF') ? '\uFEFF' : '';
	const body = replacementBody ?? markdown.slice(existing?.[0].length ?? bom.length);
	const newline = existing?.[0].includes('\r\n') || (!existing && body.includes('\r\n')) ? '\r\n' : '\n';
	const yaml = document.toString({ lineWidth: 0, directives: false }).replace(/\n/g, newline);
	return bom + '---' + newline + yaml + '---' + newline + body;
}

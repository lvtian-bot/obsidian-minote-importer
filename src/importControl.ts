/** 导入任务取消及会话失效的统一边界。 */
export class ImportCancelledError extends Error {
	constructor() { super('导入已取消'); this.name = 'ImportCancelledError'; }
}
export class WebSessionError extends Error {
	constructor(message = '小米笔记页面不可用，请重新打开后重试。') { super(message); this.name = 'WebSessionError'; }
}
export interface ImportControl {
	signal?: AbortSignal;
	assertActive?: () => Promise<void>;
}
export function throwIfCancelled(signal?: AbortSignal): void {
	if (signal?.aborted) throw new ImportCancelledError();
}
export function isTaskInterruption(error: unknown): boolean {
	return error instanceof ImportCancelledError || error instanceof WebSessionError;
}
export async function assertImportActive(control: ImportControl): Promise<void> {
	throwIfCancelled(control.signal);
	await control.assertActive?.();
	throwIfCancelled(control.signal);
}
export function waitFor<T>(operation: Promise<T>, timeout: number, signal?: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () => finish(new ImportCancelledError());
		const timer = setTimeout(() => finish(new WebSessionError('连接小米笔记超时，请重试。')), timeout);
		let done = false;
		function finish(error: Error | null, value?: T) {
			if (done) return;
			done = true;
			clearTimeout(timer);
			signal?.removeEventListener('abort', abort);
			if (error) reject(error); else resolve(value as T);
		}
		signal?.addEventListener('abort', abort, { once: true });
		operation.then(value => finish(null, value), error => finish(error instanceof Error ? error : new WebSessionError()));
		if (signal?.aborted) abort();
	});
}

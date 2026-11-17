/**
 * @file 小米笔记 API 代理
 * @author Emac
 * @date 2025-01-05
 */
import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from 'obsidian';
import { get } from 'svelte/store';

import { runtimeCredentials, settingsStore } from './settings';
import { WebSessionError } from './importControl';
import { createHash } from 'crypto';

export interface ProfileCheckResult {
	ok: boolean;
	nickname?: string;
	status?: 'authenticated' | 'unauthenticated' | 'unavailable';
}

export default class MinoteApi {
	// 固定本轮使用的会话，避免分页期间切换登录导致清单混入其他账号。
	constructor(private readonly session = { host: get(settingsStore).host, cookie: get(runtimeCredentials) }) {}

	get accountKey(): string {
		const ids = [...this.session.cookie.matchAll(/(?:^|;\s*)userId=(\d+)(?=;|$)/g)].map(match => match[1]);
		if (!ids.length || new Set(ids).size !== 1) return '';
		return createHash('sha256').update(this.session.host + ':' + ids[0]).digest('hex');
	}

	private getBaseUrl() {
		return `https://${this.session.host}`;
	}

	private getHeaders(cookie = this.session.cookie) {
		return {
			'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/73.0.3683.103 Safari/537.36',
			'Accept-Encoding': 'gzip, deflate, br',
			'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
			'Cookie': cookie
		};
	}

	private async requestImport(options: RequestUrlParam): Promise<RequestUrlResponse> {
		let response: RequestUrlResponse;
		try {
			response = await requestUrl({ ...options, throw: false });
		} catch {
			throw new WebSessionError('暂时无法连接小米笔记，本轮导入已停止。');
		}
		if (response.status === 401 || response.status === 403) {
			throw new WebSessionError('小米云拒绝了本轮读取请求，请检查登录状态后重试。');
		}
		if (response.status === 429 || response.status >= 500) {
			throw new WebSessionError('小米云暂时无法处理请求，本轮导入已停止。');
		}
		if (response.status !== 200) throw new Error('Xiaomi Notes item unavailable');
		return response;
	}

	/**
	 * 用一条 Cookie 验证登录状态并获取昵称。
	 * 区分认证失效与网络暂时不可用。
	 */
	async checkProfile(host: string, cookie: string): Promise<ProfileCheckResult> {
		try {
			const req: RequestUrlParam = {
				url: `https://${host}/status/lite/profile?ts=${Date.now()}`,
				method: 'GET',
				headers: this.getHeaders(cookie),
				throw: false
			};
			const resp: RequestUrlResponse = await requestUrl(req);
			if (resp.status !== 200) {
				return { ok: false, status: resp.status === 401 || resp.status === 403 ? 'unauthenticated' : 'unavailable' };
			}
			const json = resp.json;
			const nickname = json?.data?.nickname;
			if (nickname) {
				return { ok: true, nickname: String(nickname), status: 'authenticated' };
			}
			return { ok: false, status: json?.code === 401 || json?.code === 403 || json?.data === null ? 'unauthenticated' : 'unavailable' };
		} catch {
			return { ok: false, status: 'unavailable' };
		}
	}

	async fetchPage(syncTag = '') {
		const query = new URLSearchParams({ ts: String(Date.now()), syncTag, limit: '200' });
		const req: RequestUrlParam = {
			url: this.getBaseUrl() + '/note/v2/full/page?' + query,
			method: 'GET',
			headers: this.getHeaders()
		};
		const resp = await this.requestImport(req);
		return resp.json;
	}

	async fetchNoteDetails(noteId: string) {
		const req: RequestUrlParam = {
			url: this.getBaseUrl() + `/note/v2/note/${encodeURIComponent(noteId)}/?ts=${Date.now()}`,
			method: 'GET',
			headers: this.getHeaders()
		};
		const resp = await this.requestImport(req);
		const body = resp.json;
		if ([401, 403, 429].includes(Number(body?.code))) throw new WebSessionError('小米云拒绝了本轮读取请求，请稍后重试。');
		return body;
	}

	async fetchImage(fileId: string) {
		const req: RequestUrlParam = {
			url: this.getBaseUrl() + `/file/full?type=note_img&fileid=${encodeURIComponent(fileId)}`,
			method: 'GET',
			headers: this.getHeaders()
		};
		const resp = await this.requestImport(req);
		const type = Object.entries(resp.headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1];
		if (!resp.arrayBuffer.byteLength || /(?:json|text\/html)/i.test(type || '')) {
			throw new Error('Image download did not return an attachment');
		}
		return resp.arrayBuffer;
	}
}

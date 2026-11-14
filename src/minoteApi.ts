/**
 * @file 小米笔记 API 代理
 * @author Emac
 * @date 2025-01-05
 */
import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from 'obsidian';
import { get } from 'svelte/store';

import { settingsStore } from './settings';

export interface ProfileCheckResult {
	ok: boolean;
	nickname?: string;
}

export default class MinoteApi {

	private getBaseUrl() {
		return `https://${get(settingsStore).host}`;
	}

	private getHeaders(cookie = get(settingsStore).cookie) {
		return {
			'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/73.0.3683.103 Safari/537.36',
			'Accept-Encoding': 'gzip, deflate, br',
			'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
			'Cookie': cookie
		};
	}

	/**
	 * 用一条 Cookie 验证登录状态并获取昵称。
	 * 这是外部浏览器登录后自动确认登录成功的关键接口。
	 */
	async checkProfile(host: string, cookie: string): Promise<ProfileCheckResult> {
		try {
			const req: RequestUrlParam = {
				url: `https://${host}/status/lite/profile?ts=${Date.now()}`,
				method: 'GET',
				headers: this.getHeaders(cookie)
			};
			const resp: RequestUrlResponse = await requestUrl(req);
			if (resp.status !== 200) {
				return { ok: false };
			}
			const json = resp.json;
			const nickname = json?.data?.nickname;
			if (nickname) {
				return { ok: true, nickname: String(nickname) };
			}
			return { ok: false };
		} catch {
			return { ok: false };
		}
	}

	async fetchPage(syncTag = '') {
		const query = new URLSearchParams({ ts: String(Date.now()), syncTag, limit: '200' });
		const req: RequestUrlParam = {
			url: this.getBaseUrl() + '/note/v2/full/page?' + query,
			method: 'GET',
			headers: this.getHeaders()
		};
		const resp = await requestUrl(req);
		return resp.json;
	}

	async fetchNoteDetails(noteId: string) {
		const req: RequestUrlParam = {
			url: this.getBaseUrl() + `/note/v2/note/${encodeURIComponent(noteId)}/?ts=${Date.now()}`,
			method: 'GET',
			headers: this.getHeaders()
		};
		const resp = await requestUrl(req);
		return resp.json;
	}

	async fetchImage(fileId: string) {
		const req: RequestUrlParam = {
			url: this.getBaseUrl() + `/file/full?type=note_img&fileid=${encodeURIComponent(fileId)}`,
			method: 'GET',
			headers: this.getHeaders()
		};
		const resp = await requestUrl(req);
		const type = Object.entries(resp.headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1];
		if (!resp.arrayBuffer.byteLength || /(?:json|text\/html)/i.test(type || '')) {
			throw new Error('Image download did not return an attachment');
		}
		return resp.arrayBuffer;
	}
}

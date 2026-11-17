import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import { buildSync } from 'esbuild';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
let transport = async () => ({ status: 200, json: { data: { nickname: '测试账号' } } });
const output = buildSync({ stdin: { resolveDir: root, contents: `
export {default as MinoteWebSession,browserPartition} from './src/minoteWebSession';
export {default as MinoteApi} from './src/minoteApi';
export {waitFor,ImportCancelledError,WebSessionError} from './src/importControl';
export {settingsStore,runtimeCredentials} from './src/settings';
export {get} from 'svelte/store';` }, bundle: true, write: false, platform: 'node', format: 'cjs',
  conditions: ['production'], external: ['obsidian', 'electron'] }).outputFiles[0].text;
const module = { exports: {} };
vm.runInThisContext(`(function(require,module,exports){${output}\n})`)(name => name === 'obsidian'
  ? { normalizePath: value => path.posix.normalize(value.replaceAll('\\', '/')), requestUrl: options => transport(options) }
  : require(name), module, module.exports);
const { MinoteWebSession, browserPartition, MinoteApi, waitFor, ImportCancelledError, WebSessionError,
  settingsStore, runtimeCredentials, get } = module.exports;

function fakeSession() {
  const service = new MinoteWebSession('D:/验收笔记库', () => 'i.mi.com');
  let userId = '42';
  let challenge = false;
  let evaluations = 0;
  const contents = { isDestroyed: () => false,
    debugger: { isAttached: () => true, sendCommand: async () => {
      evaluations++;
      return { result: { value: { origin: 'https://i.mi.com', path: '/note', ready: true, challenge } } };
    } },
    session: { cookies: { get: async () => [{ name: 'userId', value: userId, path: '/' }], flushStore: async () => {} } }
  };
  service.contents = contents;
  service.view = {};
  return { service, setUser: value => { userId = value; }, setChallenge: value => { challenge = value; }, evaluations: () => evaluations };
}

test('专用会话按笔记库完整路径及服务域名隔离', () => {
  assert.notEqual(browserPartition('D:/甲/笔记库', 'i.mi.com'), browserPartition('D:/乙/笔记库', 'i.mi.com'));
  assert.notEqual(browserPartition('D:/甲/笔记库', 'i.mi.com'), browserPartition('D:/甲/笔记库', 'eu.i.mi.com'));
  if (process.platform === 'win32') assert.equal(browserPartition('D:/甲/笔记库', 'i.mi.com'), browserPartition('d:/甲/笔记库', 'i.mi.com'));
});

test('迁移删除旧认证字段，保留路径和导入历史，新凭据仅在内存', async () => {
  let saved;
  const fixture = { host: 'i.mi.com', noteLocation: '我的导入', cookie: 'userId=42', webLoginConfirmed: true,
    isCookieValid: true, browserPath: 'fixture-browser', user: '旧账号', lastImportDestination: '我的导入',
    lastTimeSynced: [{ id: '1', type: 'note', relativePath: '甲.md' }] };
  await settingsStore.initialize({ loadData: async () => fixture, saveData: async data => { saved = data; } });
  assert.equal(saved.noteLocation, '我的导入');
  assert.equal(saved.lastTimeSynced.length, 1);
  for (const key of ['cookie','webLoginConfirmed','isCookieValid','browserPath']) assert.equal(key in saved, false);
  assert.equal(get(runtimeCredentials), '');
  settingsStore.actions.setLogin('userId=42', '测试账号');
  await settingsStore.actions.setImportResult('我的导入', '完成');
  assert.equal(get(runtimeCredentials), 'userId=42');
  assert.equal('cookie' in saved, false);
});

test('账号检查区分明确未登录和网络不可用', async () => {
  const api = new MinoteApi({ host: 'i.mi.com', cookie: '' });
  transport = async () => ({ status: 401 });
  assert.equal((await api.checkProfile('i.mi.com','')).status, 'unauthenticated');
  transport = async () => { throw Error('断网'); };
  assert.equal((await api.checkProfile('i.mi.com','')).status, 'unavailable');
});

test('云端限流会中止本轮导入，而非继续逐篇请求', async () => {
  transport = async () => ({ status: 429 });
  const api = new MinoteApi({ host: 'i.mi.com', cookie: '' });
  await assert.rejects(api.fetchNoteDetails('123'), WebSessionError);
});

test('断网保留上次已验证状态，不错误显示为退出登录', async () => {
  const { service } = fakeSession();
  service.accountState.set({ loggedIn: true, nickname: '测试账号', checking: false });
  transport = async () => { throw Error('断网'); };
  await service.refreshAccount();
  assert.equal(get(service.accountState).loggedIn, true);
  assert.equal(get(service.accountState).checking, false);
});

test('就绪检查固定会话，账号变化时在正文执行前停止', async () => {
  transport = async () => ({ status: 200, json: { data: { nickname: '测试账号' } } });
  const fixture = fakeSession();
  const snapshot = await fixture.service.ensureReady({ signal: new AbortController().signal, onWaiting: () => {} });
  assert.ok(snapshot.accountKey);
  const count = fixture.evaluations();
  fixture.setUser('43');
  await assert.rejects(fixture.service.readEncryptedNote({ id: '1', content: '', encryptInfo: null }), WebSessionError);
  assert.equal(fixture.evaluations(), count);
});

test('设备验证未完成时等待，验证通过后自动返回就绪会话', async () => {
  let profileRequests = 0;
  transport = async () => {
    profileRequests++;
    return { status: 200, json: { data: { nickname: '测试账号' } } };
  };
  const fixture = fakeSession();
  fixture.setChallenge(true);
  let waiting = 0;
  const snapshot = await fixture.service.ensureReady({ signal: new AbortController().signal, onWaiting: () => {
    waiting++;
    fixture.setChallenge(false);
  } });
  assert.ok(snapshot.accountKey);
  assert.equal(waiting, 1);
  assert.equal(profileRequests, 1);
});

test('取消等待能立即结束，晚到的操作结果不继续任务', async () => {
  const controller = new AbortController();
  let complete;
  const pending = waitFor(new Promise(resolve => { complete = resolve; }), 30_000, controller.signal);
  controller.abort();
  await assert.rejects(pending, ImportCancelledError);
  complete('晚到结果');
});

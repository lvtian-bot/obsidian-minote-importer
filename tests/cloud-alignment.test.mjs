import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import { buildSync } from 'esbuild';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const output = buildSync({
  stdin: { contents: `export {default as NoteSyncer} from './src/noteSyncer';
    export {default as FileManager} from './src/fileManager';
    export {default as MinoteApi} from './src/minoteApi';
    export {settingsStore} from './src/settings';
    export {ImportCancelledError, WebSessionError} from './src/importControl';
    export {withNoteProperties} from './src/noteProperties';`, resolveDir: root },
  bundle: true, write: false, platform: 'node', format: 'cjs', conditions: ['production'], external: ['obsidian']
}).outputFiles[0].text;
const module = { exports: {} };
const normalizePath = value => path.posix.normalize(value.replaceAll('\\', '/')).replace(/\/$/, '');
vm.runInThisContext(`(function(require,module,exports){${output}\n})`)(
  name => name === 'obsidian' ? { normalizePath } : name === 'fs/promises' ? {
    realpath: async target => path.resolve(target),
    rmdir: async target => memoryVault.adapter.removeEmptyFolder(
      path.relative(root, target).split(path.sep).join('/'))
  } : require(name), module, module.exports);
const { NoteSyncer, FileManager, MinoteApi, settingsStore, withNoteProperties, ImportCancelledError, WebSessionError } = module.exports;

const time = 1_700_000_000_000;
const cloudNote = (id = '101', title = '笔记', folderId = '10', extra = {}) => ({
  id, type: 'note', folderId, createDate: time, modifyDate: time + 100,
  extraInfo: JSON.stringify({ title }), content: '云端正文', ...extra
});
const cloudFolder = (id = '10', subject = '分类') => ({ id, type: 'folder', subject });
const page = (entries = [], folders = [], lastPage = true, syncTag = '') => ({
  code: 0, data: { entries, folders, lastPage, syncTag }
});
const markdown = (entry = cloudNote(), body = '原有正文', category = '分类') =>
  withNoteProperties('', { ...entry, title: JSON.parse(entry.extraInfo).title }, category, body);

let memoryVault;
class MemoryVault {
  files = new Map();
  folders = new Set(['']);
  archived = [];
  failArchive = new Set();
  writes = [];
  constructor() {
    const vault = this;
    this.adapter = {
      exists: async file => vault.files.has(file) || vault.folders.has(file),
      stat: async file => vault.files.has(file)
        ? { type: 'file', size: Buffer.byteLength(vault.files.get(file)), ctime: time, mtime: time }
        : vault.folders.has(file) ? { type: 'folder' } : null,
      read: async file => {
        if (!vault.files.has(file)) throw Error('文件不存在');
        return vault.files.get(file);
      },
      write: async (file, body) => { vault.put(file, body); vault.writes.push(file); },
      writeBinary: async (file, binary) => vault.put(file, Buffer.from(binary)),
      process: async (file, transform) => vault.put(file, transform(vault.files.get(file))),
      list: async parent => ({
        files: [...vault.files.keys()].filter(file => path.posix.dirname(file).replace(/^\.$/, '') === parent),
        folders: [...vault.folders].filter(file => file && path.posix.dirname(file).replace(/^\.$/, '') === parent)
      }),
      getBasePath: () => root,
      getFullPath: folder => path.join(root, folder),
      removeEmptyFolder: async folder => {
        assert.equal([...vault.files.keys(), ...vault.folders].some(file => file.startsWith(folder + '/')), false);
        vault.folders.delete(folder);
      },
      rename: async (source, target) => {
        if (vault.failArchive.has(source)) throw Error('移动失败');
        assert.equal(vault.files.has(target), false);
        vault.put(target, vault.files.get(source));
        vault.files.delete(source);
        if (target.startsWith(vault.destination + '-delete/')) vault.archived.push(source);
      },
      copy: async (source, target) => vault.put(target, vault.files.get(source))
    };
  }
  put(file, body) {
    assert.ok(body !== undefined);
    for (let folder = path.posix.dirname(file); folder !== '.'; folder = path.posix.dirname(folder)) this.folders.add(folder);
    this.files.set(file, body);
  }
  async createFolder(folder) { this.folders.add(folder); }
  configDir = '.obsidian';
  getMarkdownFiles() { return [...this.files.keys()].filter(file => file.endsWith('.md')).map(path => ({ path })); }
}

async function setup({ entries = [], folders = [], pages, history = [], files = {}, destination = '导入', cookie = 'userId=42' } = {}) {
  const vault = memoryVault = new MemoryVault();
  vault.destination = destination;
  for (const [file, body] of Object.entries(files)) vault.put(file, body);
  let saved;
  await settingsStore.initialize({ loadData: async () => ({
    cookie, host: 'i.mi.com', webLoginConfirmed: true, lastImportDestination: destination, lastTimeSynced: history
  }), saveData: async data => { saved = structuredClone(data); } });
  settingsStore.actions.setLogin(cookie, '测试账号');
  const api = new MinoteApi();
  const inventory = pages ?? [page(entries, folders)];
  const pageCalls = [];
  const detailCalls = [];
  let pageIndex = 0;
  api.fetchPage = async token => {
    if (!token) pageIndex = 0;
    pageCalls.push(token ?? '');
    const response = inventory[pageIndex++];
    if (response instanceof Error) throw response;
    return response;
  };
  api.fetchNoteDetails = async id => {
    detailCalls.push(id);
    const entry = entries.find(note => note.id === id);
    if (!entry) throw Error('正文读取失败');
    return { data: { entry } };
  };
  api.fetchImage = async () => new Uint8Array([1, 2, 3]).buffer;
  const external = { readEncryptedNote: async () => null, readImage: async () => null };
  const manager = new FileManager(vault, vault.adapter, destination);
  const record = (entry = cloudNote(), relativePath = '分类/笔记.md', extra = {}) => ({
    id: entry.id, type: 'note', name: JSON.parse(entry.extraInfo).title, relativePath,
    syncTime: entry.modifyDate, decoded: false, imageFormatChecked: true, account: api.accountKey, ...extra
  });
  const image = relativePath => ({
    id: relativePath, type: 'image', name: path.posix.basename(relativePath), relativePath, account: api.accountKey, syncTime: time
  });
  const folder = (relativePath = '分类', id = '10', extra = {}) => ({
    id, type: 'folder', name: relativePath, relativePath, account: api.accountKey, syncTime: time, ...extra
  });
  const setHistory = async records => {
    await settingsStore.actions.setImportResult(destination, '', records);
  };
  const sync = async (force = false, control = {}, onProgress = () => {}) => {
    const syncer = new NoteSyncer(manager, api, external,
      record => settingsStore.actions.checkpointMove(destination, record));
    const result = await syncer.sync(force, onProgress, control);
    await settingsStore.actions.setImportResult(destination, '', result.synced);
    return result;
  };
  return { vault, api, manager, external, record, image, folder, setHistory, sync, pageCalls, detailCalls, saved: () => saved };
}

for (const force of [false, true]) {
  const mode = force ? '全量' : '增量';
  test(`${mode}读取全部分页，备份云端消失的笔记和自行创建的文件`, async () => {
    const note = cloudNote();
    const env = await setup({ entries: [note], pages: [page([], [cloudFolder()], false, 'next'), page([note])],
      files: { '导入/分类/笔记.md': markdown(note), '导入/分类/已删除.md': markdown(cloudNote('102')),
        '导入/分类/自行创建.md': '私人内容' } });
    await env.setHistory([env.record(), env.record(cloudNote('102'), '分类/已删除.md')]);
    const result = await env.sync(force);
    assert.deepEqual(env.pageCalls, ['', 'next']);
    assert.equal(result.archived, 2);
    assert.equal(result.failed, 0);
    assert.deepEqual(env.vault.archived.sort(), ['导入/分类/已删除.md', '导入/分类/自行创建.md'].sort());
    assert.equal(env.vault.files.get(result.backup + '/分类/自行创建.md'), '私人内容');
    assert.equal(env.detailCalls.length, force ? 1 : 0);
    assert.equal(result.synced.some(item => item.id === '102'), false);
  });

  test(`${mode}在云端清单为空时仍删除已确认归属的导入笔记`, async () => {
    const env = await setup({ files: { '导入/分类/笔记.md': markdown() } });
    await env.setHistory([env.record(), env.folder()]);
    const result = await env.sync(force);
    assert.equal(result.total, 0);
    assert.equal(result.archived, 1);
    assert.equal(env.vault.folders.has('导入/分类'), false);
  });

  test(`${mode}按北京时间取创建日期与所选文件夹的交集`, async () => {
    const from = Date.parse('2026-11-18T00:00:00+08:00');
    const until = Date.parse('2026-11-19T00:00:00+08:00');
    const entries = [
      cloudNote('101', '当天第一篇', '10', { createDate: from }),
      cloudNote('102', '当天最后一篇', '0', { createDate: until - 1 }),
      cloudNote('103', '前一天', '10', { createDate: from - 1, modifyDate: from }),
      cloudNote('104', '后一天', '10', { createDate: until }),
      cloudNote('105', '其他文件夹', '20', { createDate: from }),
    ];
    const env = await setup({ entries, folders: [cloudFolder(), cloudFolder('20', '其他')] });
    settingsStore.actions.setImportOptions({ createdFrom: '2026-11-18', createdThrough: '2026-11-18',
      folderSelection: { account: env.api.accountKey, ids: ['10', '0'] } });
    const result = await env.sync(force);
    assert.equal(result.total, 2);
    assert.equal(result.failed, 0);
    assert.deepEqual(env.detailCalls, ['101', '102']);
    assert.deepEqual([...env.vault.files.keys()], ['导入/分类/当天第一篇.md', '导入/未分类/当天最后一篇.md']);
    assert.equal(env.vault.folders.has('导入/其他'), false);
  });
}

test('缩小范围时复制模式保留历史及图片，改用镜像模式后清理已移出范围或已删除的笔记', async () => {
  const included = cloudNote('101', '保留');
  const outside = cloudNote('102', '已移出范围', '20');
  const deleted = cloudNote('103', '云端已删除', '20');
  const env = await setup({ entries: [included, outside], folders: [cloudFolder(), cloudFolder('20', '其他')], files: {
    '导入/其他/已移出范围.md': markdown(outside, '![](img/old.png)', '其他'),
    '导入/其他/云端已删除.md': markdown(deleted, '正文', '其他'),
    '导入/其他/img/old.png': '图片',
    '导入/其他/自行创建.md': '自己的内容',
  } });
  await env.setHistory([env.record(outside, '其他/已移出范围.md'), env.record(deleted, '其他/云端已删除.md'),
    env.folder('其他', '20'), env.image('其他/img/old.png')]);
  settingsStore.actions.setImportOptions({ importMode: 'copy', folderSelection: { account: env.api.accountKey, ids: ['10'] } });
  const copy = await env.sync();
  assert.equal(copy.count, 1);
  assert.equal(copy.archived, 0);
  assert.deepEqual(env.vault.archived, []);
  assert.ok(copy.synced.some(item => item.id === outside.id));
  assert.ok(copy.synced.some(item => item.id === deleted.id));
  settingsStore.actions.setImportOptions({ importMode: 'mirror' });
  const mirror = await env.sync();
  assert.equal(mirror.failed, 0);
  assert.equal(mirror.archived, 4);
  assert.deepEqual(env.vault.archived.sort(), [
    '导入/其他/img/old.png', '导入/其他/云端已删除.md', '导入/其他/已移出范围.md', '导入/其他/自行创建.md'
  ].sort());
  assert.deepEqual([...env.vault.files.keys()].filter(file => file.startsWith('导入/')), ['导入/分类/保留.md']);
  assert.equal(env.vault.files.get(mirror.backup + '/其他/img/old.png'), '图片');
});

test('所选文件夹没有匹配笔记时，镜像模式仍清理已确认归属的历史笔记', async () => {
  const entry = cloudNote();
  const env = await setup({ entries: [entry], folders: [cloudFolder()], files: { '导入/分类/笔记.md': markdown(entry) } });
  await env.setHistory([env.record()]);
  settingsStore.actions.setImportOptions({ folderSelection: { account: env.api.accountKey, ids: ['0'] } });
  const result = await env.sync();
  assert.equal(result.total, 0);
  assert.equal(result.archived, 1);
  assert.equal(result.failed, 0);
  assert.deepEqual(env.detailCalls, []);
});

test('其他账号的文件夹选择、无效日期范围和缺失的创建时间均阻止写入和清理', async () => {
  const entry = cloudNote('101', '笔记', '10', { createDate: null });
  const env = await setup({ entries: [entry], folders: [cloudFolder()], files: { '导入/分类/笔记.md': markdown() } });
  await env.setHistory([env.record()]);
  settingsStore.actions.setImportOptions({ folderSelection: { account: 'another-account', ids: ['10'] } });
  await assert.rejects(env.sync(), /当前小米账号/);
  settingsStore.actions.setImportOptions({ folderSelection: null, createdFrom: '2026-11-19', createdThrough: '2026-11-18' });
  await assert.rejects(env.sync(), /开始日期不能晚于结束日期/);
  settingsStore.actions.setImportOptions({ createdFrom: '2026-02-30', createdThrough: '' });
  await assert.rejects(env.sync(), /有效的创建日期/);
  settingsStore.actions.setImportOptions({ createdFrom: '2026-11-18' });
  await assert.rejects(env.sync(), /小米笔记缺少有效的创建日期/);
  assert.deepEqual(env.detailCalls, []);
  assert.deepEqual(env.vault.writes, []);
  assert.deepEqual(env.vault.archived, []);
});

test('文件夹选择可读取全部分页，保留未分类与同名文件夹并排除私密文件夹', async () => {
  const env = await setup({ pages: [
    page([], [cloudFolder('2', '私密笔记'), cloudFolder('10', '文件夹')], false, 'next'),
    page([], [cloudFolder('20', '文件夹'), cloudFolder('10', '文件夹')]),
  ] });
  assert.deepEqual([...await env.api.listFolders({})], [['0', '未分类'], ['10', '文件夹'], ['20', '文件夹']]);
  assert.deepEqual(env.pageCalls, ['', 'next']);
  assert.deepEqual(env.detailCalls, []);
});

test('正文修改时间未变时仍同步标题和文件名，并保留本地正文', async () => {
  const entry = cloudNote('101', '新标题');
  const env = await setup({ entries: [entry], folders: [cloudFolder()], files: { '导入/分类/笔记.md': markdown() } });
  await env.setHistory([env.record()]);
  const result = await env.sync();
  assert.equal(result.count, 1);
  assert.equal(env.detailCalls.length, 0);
  assert.equal(env.vault.files.has('导入/分类/笔记.md'), false);
  assert.match(env.vault.files.get('导入/分类/新标题.md'), /原有正文/);
  assert.match(env.vault.files.get('导入/分类/新标题.md'), /title: "新标题"/);
});

test('移动分类时复制受管理图片，并清理旧图片和空目录', async () => {
  const entry = cloudNote('101', '笔记', '20');
  const env = await setup({ entries: [entry], folders: [cloudFolder('20', '新分类')], files: {
    '导入/分类/笔记.md': markdown(cloudNote(), '![](img/photo.png)'), '导入/分类/img/photo.png': '图片'
  } });
  await env.setHistory([env.record(), env.image('分类/img/photo.png'), env.folder()]);
  const result = await env.sync();
  assert.equal(result.failed, 0);
  assert.equal(env.vault.files.get('导入/新分类/img/photo.png'), '图片');
  assert.equal(env.vault.files.has('导入/分类/img/photo.png'), false);
  assert.equal(env.vault.folders.has('导入/分类'), false);
  assert.ok(result.synced.some(item => item.type === 'image' && item.relativePath === '新分类/img/photo.png'));
});

test('分类改名后备份旧分类中自行创建的文件', async () => {
  const env = await setup({ entries: [cloudNote()], folders: [cloudFolder('10', '新分类')], files: {
    '导入/分类/笔记.md': markdown(), '导入/分类/自行创建.md': '自己的内容'
  } });
  await env.setHistory([env.record(), env.folder()]);
  const result = await env.sync();
  assert.equal(result.failed, 0);
  assert.equal(env.vault.files.has('导入/新分类/笔记.md'), true);
  assert.equal(env.vault.files.get(result.backup + '/分类/自行创建.md'), '自己的内容');
  assert.equal(env.vault.folders.has('导入/分类'), false);
});

test('首次下载记录图片归属，后续删除笔记会清理无引用图片', async () => {
  const entry = cloudNote('101', '笔记', '10', { content: '<img fileid="photo">', setting: { data: [{ fileId: 'photo', mimeType: 'image/png' }] } });
  const env = await setup({ entries: [entry], folders: [cloudFolder()] });
  const first = await env.sync();
  assert.equal(first.failed, 0);
  assert.ok(first.synced.some(item => item.type === 'image' && item.relativePath === '分类/img/photo.png'));
  env.api.fetchPage = async () => page([], []);
  const second = await env.sync();
  assert.equal(second.archived, 2);
  assert.deepEqual(env.vault.archived.sort(), ['导入/分类/img/photo.png', '导入/分类/笔记.md'].sort());
});

test('图片仍被导入目录外的笔记引用时保留', async () => {
  const env = await setup({ files: {
    '导入/分类/笔记.md': markdown(cloudNote(), '![](img/photo.png)'),
    '导入/分类/img/photo.png': '图片', '其他/引用.md': '![[导入/分类/img/photo.png]]'
  } });
  await env.setHistory([env.record(), env.image('分类/img/photo.png')]);
  const result = await env.sync();
  assert.equal(result.archived, 1);
  assert.equal(env.vault.files.has('导入/分类/img/photo.png'), true);
});

test('未登记的旧图片按仍在使用的引用决定是否移出', async () => {
  const env = await setup({ entries: [cloudNote()], folders: [cloudFolder()], files: {
    '导入/分类/笔记.md': markdown(cloudNote(), '![](img/used.png)'),
    '导入/分类/img/used.png': '仍在使用',
    '导入/分类/img/unknown.png': '未知图片'
  } });
  await env.setHistory([env.record()]);
  const result = await env.sync();
  assert.equal(result.archived, 1);
  assert.equal(env.vault.files.get(result.backup + '/分类/img/unknown.png'), '未知图片');
  assert.equal(env.vault.files.get('导入/分类/img/used.png'), '仍在使用');
});

for (const invalid of [new Error('分页请求失败'), page([], [], false, 'same'),
  { code: 0, data: { entries: [], folders: [], lastPage: 'true' } },
  { code: 401, data: { entries: [], folders: [], lastPage: true } },
  page([{ id: '101', type: 'unknown' }]), page([cloudNote(), cloudNote()])]) {
  test(`清单异常时停止同步且不删除本地：${invalid instanceof Error ? invalid.message : JSON.stringify(invalid)}`, async () => {
    const env = await setup({ pages: [page([], [], false, 'same'), invalid], files: { '导入/分类/笔记.md': markdown() } });
    await env.setHistory([env.record()]);
    await assert.rejects(env.sync());
    assert.equal(env.vault.files.has('导入/分类/笔记.md'), true);
    assert.equal(env.vault.archived.length, 0);
  });
}

test('旧记录缺少账号和笔记编号时仍可移到同级备份目录', async () => {
  const destination = '附件/备份/minote';
  const env = await setup({ destination, files: { [destination + '/分类/笔记.md']: '旧版正文' } });
  await env.setHistory([env.record(cloudNote(), '分类/笔记.md', { account: undefined })]);
  const result = await env.sync();
  assert.equal(result.archived, 1);
  assert.equal(result.failed, 0);
  assert.ok(result.backup.startsWith(destination + '-delete/'));
  assert.equal(env.vault.files.get(result.backup + '/分类/笔记.md'), '旧版正文');
  assert.equal(result.synced.some(item => item.id === '101'), false);
  env.vault.put(destination + '/分类/笔记.md', '后来的文件');
  const next = await env.sync();
  assert.notEqual(next.backup, result.backup);
  assert.equal(env.vault.files.get(result.backup + '/分类/笔记.md'), '旧版正文');
  assert.equal(env.vault.files.get(next.backup + '/分类/笔记.md'), '后来的文件');
});

test('旧记录仍能通过当前云端 ID 确认归属，后续可以同步删除', async () => {
  const env = await setup({ entries: [cloudNote()], folders: [cloudFolder()], files: { '导入/分类/笔记.md': markdown() } });
  await env.setHistory([env.record(cloudNote(), '分类/笔记.md', { account: undefined })]);
  const first = await env.sync();
  assert.equal(first.synced.find(item => item.type === 'note').account, env.api.accountKey);
  env.api.fetchPage = async () => page();
  assert.equal((await env.sync()).archived, 1);
});

test('切换账号不删除原账号的记录和文件', async () => {
  const env = await setup({ files: { '导入/分类/笔记.md': markdown() } });
  await env.setHistory([env.record(cloudNote(), '分类/笔记.md', { account: 'other-account' })]);
  const result = await env.sync();
  assert.equal(result.archived, 0);
  assert.equal(env.vault.files.has('导入/分类/笔记.md'), true);
  assert.ok(result.synced.some(item => item.account === 'other-account'));
});

test('同步期间切换账号时不执行清理，API 继续使用开始时的账号', async () => {
  const env = await setup({ files: { '导入/分类/笔记.md': markdown() } });
  await env.setHistory([env.record()]);
  const originalKey = env.api.accountKey;
  env.api.fetchPage = async () => {
    settingsStore.actions.setLogin('userId=99', '测试账号');
    return page();
  };
  const result = await env.sync();
  assert.equal(env.api.accountKey, originalKey);
  assert.equal(result.failed, 1);
  assert.equal(env.vault.archived.length, 0);
});

test('无法读取稳定账号编号时不删除文件', async () => {
  const env = await setup({ cookie: '', files: { '导入/分类/笔记.md': markdown() } });
  await env.setHistory([env.record()]);
  assert.equal((await env.sync()).archived, 0);
  assert.equal(env.vault.archived.length, 0);
});

test('已不在导入范围的路径被手动替换时原样备份替换后的文件', async () => {
  const manual = markdown(cloudNote('999'));
  const env = await setup({ files: { '导入/分类/笔记.md': manual } });
  await env.setHistory([env.record()]);
  const result = await env.sync();
  assert.equal(result.archived, 1);
  assert.equal(result.failed, 0);
  assert.equal(env.vault.files.get(result.backup + '/分类/笔记.md'), manual);
});

test('中断移动已完成时根据待移动路径清理云端已删除的笔记', async () => {
  const env = await setup({ files: { '导入/新分类/笔记.md': markdown() } });
  await env.setHistory([env.record(cloudNote(), '分类/笔记.md', { pendingMove: '新分类/笔记.md' })]);
  assert.equal((await env.sync()).archived, 1);
  assert.deepEqual(env.vault.archived, ['导入/新分类/笔记.md']);
});

test('中断移动的两个位置都存在时不猜测删除', async () => {
  const env = await setup({ files: { '导入/分类/笔记.md': markdown(), '导入/新分类/笔记.md': markdown() } });
  await env.setHistory([env.record(cloudNote(), '分类/笔记.md', { pendingMove: '新分类/笔记.md' })]);
  const result = await env.sync();
  assert.equal(result.failed, 1);
  assert.equal(env.vault.archived.length, 0);
});

test('备份移动失败时保留导入记录以便重试', async () => {
  const env = await setup({ files: { '导入/分类/笔记.md': markdown() } });
  await env.setHistory([env.record()]);
  env.vault.failArchive.add('导入/分类/笔记.md');
  const first = await env.sync();
  assert.equal(first.failed, 1);
  assert.ok(first.synced.some(item => item.id === '101'));
  env.vault.failArchive.clear();
  assert.equal((await env.sync()).archived, 1);
});

test('旧编号迁移后仍能移动和更新，不误判为其他笔记占用', async () => {
  const entry = cloudNote('201', '新标题', '10', { extraInfo: JSON.stringify({ title: '新标题', v3SyncId: '101' }) });
  const env = await setup({ entries: [entry], folders: [cloudFolder()], files: { '导入/分类/笔记.md': markdown() } });
  await env.setHistory([env.record()]);
  const result = await env.sync();
  assert.equal(result.failed, 0);
  assert.equal(env.vault.files.has('导入/分类/笔记.md'), false);
  assert.match(env.vault.files.get('导入/分类/新标题.md'), /noteId: "201"/);
});

test('加密正文暂时无法解密时保留文件和附件', async () => {
  const entry = cloudNote('101', '笔记', '10', { modifyDate: time + 200, encryptInfo: {} });
  const env = await setup({ entries: [entry], folders: [cloudFolder()], files: {
    '导入/分类/笔记.md': markdown(), '导入/分类/img/photo.png': '图片',
    '导入/分类/云端已删除.md': markdown(cloudNote('102'))
  } });
  await env.setHistory([env.record(), env.image('分类/img/photo.png'), env.record(cloudNote('102'), '分类/云端已删除.md')]);
  const result = await env.sync();
  assert.equal(result.locked, 1);
  assert.equal(result.archived, 0);
  assert.equal(env.vault.archived.length, 0);
  assert.equal(env.vault.files.has('导入/分类/云端已删除.md'), true);
});

test('保存位置不同不复用原目录的导入记录，也不移出目录以外的文件', async () => {
  const env = await setup({ entries: [cloudNote()], folders: [cloudFolder()],
    files: { '其他目录/分类/笔记.md': markdown() } });
  await settingsStore.actions.setImportResult('其他目录', '', [env.record()]);
  assert.equal((await env.sync()).archived, 0);
  assert.deepEqual(env.detailCalls, ['101']);
  assert.ok(env.vault.files.has('其他目录/分类/笔记.md'));
});

test('镜像模式拒绝笔记库根目录，复制模式仍可使用根目录', async () => {
  const env = await setup({ destination: '/', files: { '分类/笔记.md': markdown(), '其他.md': '自建内容' } });
  await env.setHistory([env.record()]);
  await assert.rejects(env.sync(), /镜像模式需要选择笔记库内的子文件夹/);
  assert.deepEqual(env.pageCalls, []);
  await settingsStore.actions.setImportOptions({ importMode: 'copy' });
  assert.equal((await env.sync()).archived, 0);
  assert.equal(env.vault.files.get('其他.md'), '自建内容');
});

test('异常的历史路径不能越过保存目录', async () => {
  const env = await setup({ files: { '外部.md': markdown() } });
  await env.setHistory([env.record(cloudNote(), '../外部.md')]);
  assert.equal((await env.sync()).failed, 1);
  assert.equal(env.vault.files.has('外部.md'), true);
});

test('增量导入发现本地文件缺失时重新下载', async () => {
  const env = await setup({ entries: [cloudNote()], folders: [cloudFolder()] });
  await env.setHistory([env.record()]);
  const result = await env.sync();
  assert.equal(result.count, 1);
  assert.deepEqual(env.detailCalls, ['101']);
  assert.match(env.vault.files.get('导入/分类/笔记.md'), /云端正文/);
});

test('同名分类与同名笔记分别分配路径，不覆盖其他笔记', async () => {
  const entries = [cloudNote('101'), cloudNote('102'), cloudNote('103', '笔记', '20')];
  const env = await setup({ entries, folders: [cloudFolder(), cloudFolder('20', '分类')] });
  const result = await env.sync();
  assert.equal(result.failed, 0);
  const notes = result.synced.filter(item => item.type === 'note');
  assert.equal(new Set(notes.map(item => item.relativePath)).size, 3);
  assert.equal(notes.find(item => item.id === '103').relativePath, '分类 (2)/笔记.md');
});

test('图片未下载完整时保留旧笔记和旧图片，下次继续重试', async () => {
  const entry = cloudNote('101', '笔记', '20', { modifyDate: time + 200,
    content: '<img fileid="new-photo">', setting: { data: [{ fileId: 'new-photo', mimeType: 'image/png' }] } });
  const env = await setup({ entries: [entry], folders: [cloudFolder('20', '新分类')], files: {
    '导入/分类/笔记.md': markdown(cloudNote(), '![](img/old-photo.png)'),
    '导入/分类/img/old-photo.png': '图片'
  } });
  await env.setHistory([env.record(), env.image('分类/img/old-photo.png')]);
  env.api.fetchImage = async () => { throw Error('图片下载失败'); };
  const result = await env.sync();
  assert.equal(result.failed, 1);
  assert.equal(env.vault.files.has('导入/分类/笔记.md'), true);
  assert.equal(env.vault.files.has('导入/分类/img/old-photo.png'), true);
  assert.equal(env.vault.archived.length, 0);
});

test('移动完成后进程中断，重试删除时恢复目标图片归属', async () => {
  const env = await setup({ files: {
    '导入/新分类/笔记.md': markdown(cloudNote(), '![](img/photo.png)'),
    '导入/分类/img/photo.png': '图片', '导入/新分类/img/photo.png': '图片'
  } });
  await env.setHistory([env.record(cloudNote(), '分类/笔记.md', { pendingMove: '新分类/笔记.md' }),
    env.image('分类/img/photo.png')]);
  const result = await env.sync();
  assert.equal(result.archived, 3);
  assert.equal(env.vault.files.has('导入/新分类/img/photo.png'), false);
});

test('笔记库索引尚未发现外部引用文件时仍然保留其图片', async () => {
  const env = await setup({ files: {
    '导入/分类/笔记.md': markdown(), '导入/分类/img/photo.png': '图片',
    '其他/刚写入.md': '![[导入/分类/img/photo.png]]'
  } });
  env.vault.getMarkdownFiles = () => [];
  await env.setHistory([env.record(), env.image('分类/img/photo.png')]);
  await env.sync();
  assert.equal(env.vault.files.has('导入/分类/img/photo.png'), true);
});

test('Markdown 笔记按图片摘要替换小米图片地址并保留图片', async () => {
  const digest = 'a'.repeat(40);
  const entry = cloudNote('101', '笔记', '10', { type: 'mdNote',
    content: `正文\n![图片](https://com.miui.notes/image/${digest}?size=full)`,
    setting: { data: [{ mimeType: 'image/jpeg', fileId: 'photo', digest }] } });
  const env = await setup({ entries: [entry], folders: [cloudFolder()] });
  const result = await env.sync();
  assert.equal(result.failed, 0);
  assert.equal(result.partial, 0);
  assert.match(env.vault.files.get('导入/分类/笔记.md'), /!\[图片\]\(img\/photo.jpeg\)/);
  assert.equal(env.vault.files.has('导入/分类/img/photo.jpeg'), true);
});

test('图片下载失败时将 Markdown 小米图片引用记为待补并保留旧图片', async () => {
  const digest = 'b'.repeat(40);
  const entry = cloudNote('101', '笔记', '10', { content: `![](https://com.miui.notes/image/${digest})`,
    setting: { data: [{ mimeType: 'image/jpeg', fileId: 'photo', digest }] } });
  const env = await setup({ entries: [entry], folders: [cloudFolder()], files: { '导入/分类/img/old.jpeg': '旧图' } });
  await env.setHistory([env.image('分类/img/old.jpeg')]);
  env.api.fetchImage = async () => { throw Error('下载失败'); };
  const result = await env.sync();
  assert.equal(result.partial, 1);
  assert.equal(env.vault.files.has('导入/分类/img/old.jpeg'), true);
  assert.equal(result.synced.find(item => item.type === 'note').attachmentsPending, true);
});

test('升级后重新检查旧版标为完成但仍引用云端图片的笔记', async () => {
  const digest = 'c'.repeat(40);
  const body = `![](https://com.miui.notes/image/${digest}?size=full)`;
  const entry = cloudNote('101', '笔记', '10', { content: body,
    setting: { data: [{ mimeType: 'image/jpeg', fileId: 'photo', digest }] } });
  const env = await setup({ entries: [entry], folders: [cloudFolder()], files: { '导入/分类/笔记.md': markdown(entry, body) } });
  await env.setHistory([env.record()]);
  const result = await env.sync();
  assert.equal(env.detailCalls.length, 1);
  assert.match(env.vault.files.get('导入/分类/笔记.md'), /!\[\]\(img\/photo.jpeg\)/);
  assert.equal(result.synced.find(item => item.type === 'note').imageFormatVersion, 2);
});

test('取消未开始的导入时不读取清单、不写入、不清理并保留历史', async () => {
  const env = await setup({ files: { '导入/分类/笔记.md': markdown() } });
  await env.setHistory([env.record()]);
  const controller = new AbortController(); controller.abort();
  const result = await env.sync(false, { signal: controller.signal });
  assert.equal(result.cancelled, true);
  assert.equal(env.pageCalls.length, 0);
  assert.equal(env.vault.writes.length, 0);
  assert.equal(env.vault.archived.length, 0);
  assert.ok(result.synced.some(item => item.id === '101'));
});

test('正文读取期间取消时保留已完成记录和未处理文件，不执行删除清理', async () => {
  const entries = [cloudNote(), cloudNote('102', '第二篇')];
  const env = await setup({ entries, folders: [cloudFolder()], files: {
    '导入/分类/第二篇.md': markdown(entries[1]), '导入/分类/旧笔记.md': markdown(cloudNote('103', '旧笔记'))
  } });
  await env.setHistory([env.record(entries[1], '分类/第二篇.md', { syncTime: 0 }),
    env.record(cloudNote('103', '旧笔记'), '分类/旧笔记.md')]);
  const controller = new AbortController();
  const fetch = env.api.fetchNoteDetails;
  env.api.fetchNoteDetails = async id => { const value = await fetch(id); if (id === '102') controller.abort(); return value; };
  const result = await env.sync(false, { signal: controller.signal });
  assert.equal(result.cancelled, true);
  assert.equal(result.count, 1);
  assert.equal(result.failed, 0);
  assert.equal(env.vault.archived.length, 0);
  assert.ok(result.synced.some(item => item.id === '101'));
  assert.ok(result.synced.some(item => item.id === '102'));
  assert.ok(env.vault.files.has('导入/分类/旧笔记.md'));
});

test('处理完最后一篇时取消也不会进入云端删除清理', async () => {
  const env = await setup({ entries: [cloudNote()], folders: [cloudFolder()],
    files: { '导入/分类/旧笔记.md': markdown(cloudNote('102', '旧笔记')) } });
  await env.setHistory([env.record(cloudNote('102', '旧笔记'), '分类/旧笔记.md')]);
  const controller = new AbortController();
  const result = await env.sync(false, { signal: controller.signal }, counts => { if (counts.count) controller.abort(); });
  assert.equal(result.count, 1);
  assert.equal(result.cancelled, true);
  assert.equal(result.archived, 0);
  assert.equal(env.vault.archived.length, 0);
});

test('读取后会话变化立即停止，不把连接失效吞成逐篇失败', async () => {
  const env = await setup({ entries: [cloudNote()], folders: [cloudFolder()] });
  let current = true;
  const fetch = env.api.fetchNoteDetails;
  env.api.fetchNoteDetails = async id => { const value = await fetch(id); current = false; return value; };
  const result = await env.sync(false, { assertActive: async () => { if (!current) throw new WebSessionError(); } });
  assert.ok(result.interrupted);
  assert.equal(result.cancelled, false);
  assert.equal(result.failed, 0);
  assert.equal(env.vault.writes.length, 0);
});

test('文件写入与备份移动均受取消保护', async () => {
  const env = await setup({ files: { '导入/分类/笔记.md': markdown() } });
  const manager = new FileManager(env.vault, env.vault.adapter, '导入', async () => { throw new ImportCancelledError(); });
  await assert.rejects(manager.saveFile('分类/笔记.md', '新正文', time, time), ImportCancelledError);
  await assert.rejects(manager.archiveMirrorFile('分类/笔记.md', '取消的批次'), ImportCancelledError);
  assert.equal(env.vault.writes.length, 0);
  assert.equal(env.vault.archived.length, 0);
});

test('清单请求未返回时取消也能结束，并忽略晚到的清单', async () => {
  const env = await setup({ files: { '导入/分类/笔记.md': markdown() } });
  await env.setHistory([env.record()]);
  let complete;
  env.api.fetchPage = () => new Promise(resolve => { complete = resolve; });
  const controller = new AbortController();
  const pending = env.sync(false, { signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  const result = await pending;
  assert.equal(result.cancelled, true);
  assert.equal(env.vault.archived.length, 0);
  complete(page());
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(env.vault.archived.length, 0);
});

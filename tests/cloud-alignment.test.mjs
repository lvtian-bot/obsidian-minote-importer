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
  trashed = [];
  failTrash = new Set();
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
      trashLocal: async file => {
        if (vault.failTrash.has(file)) throw Error('回收站写入失败');
        if (!vault.files.has(file)) throw Error('禁止递归删除');
        vault.trashed.push(file);
        vault.files.delete(file);
      },
      getBasePath: () => root,
      getFullPath: folder => path.join(root, folder),
      removeEmptyFolder: async folder => {
        assert.equal([...vault.files.keys(), ...vault.folders].some(file => file.startsWith(folder + '/')), false);
        vault.folders.delete(folder);
      },
      rename: async (source, target) => {
        assert.equal(vault.files.has(target), false);
        vault.put(target, vault.files.get(source));
        vault.files.delete(source);
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
  test(`${mode}读取全部分页，删除云端消失的笔记并保留自行创建的文件`, async () => {
    const note = cloudNote();
    const env = await setup({ entries: [note], pages: [page([], [cloudFolder()], false, 'next'), page([note])],
      files: { '导入/分类/笔记.md': markdown(note), '导入/分类/已删除.md': markdown(cloudNote('102')),
        '导入/分类/自行创建.md': '私人内容' } });
    await env.setHistory([env.record(), env.record(cloudNote('102'), '分类/已删除.md')]);
    const result = await env.sync(force);
    assert.deepEqual(env.pageCalls, ['', 'next']);
    assert.equal(result.deleted, 1);
    assert.equal(result.failed, 0);
    assert.deepEqual(env.vault.trashed, ['导入/分类/已删除.md']);
    assert.equal(env.vault.files.get('导入/分类/自行创建.md'), '私人内容');
    assert.equal(env.detailCalls.length, force ? 1 : 0);
    assert.equal(result.synced.some(item => item.id === '102'), false);
  });

  test(`${mode}在云端清单为空时仍删除已确认归属的导入笔记`, async () => {
    const env = await setup({ files: { '导入/分类/笔记.md': markdown() } });
    await env.setHistory([env.record(), env.folder()]);
    const result = await env.sync(force);
    assert.equal(result.total, 0);
    assert.equal(result.deleted, 1);
    assert.equal(env.vault.folders.has('导入/分类'), false);
  });
}

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

test('分类改名后保留旧分类中自行创建的文件', async () => {
  const env = await setup({ entries: [cloudNote()], folders: [cloudFolder('10', '新分类')], files: {
    '导入/分类/笔记.md': markdown(), '导入/分类/自行创建.md': '自己的内容'
  } });
  await env.setHistory([env.record(), env.folder()]);
  const result = await env.sync();
  assert.equal(result.failed, 0);
  assert.equal(env.vault.files.has('导入/新分类/笔记.md'), true);
  assert.equal(env.vault.files.get('导入/分类/自行创建.md'), '自己的内容');
});

test('首次下载记录图片归属，后续删除笔记会清理无引用图片', async () => {
  const entry = cloudNote('101', '笔记', '10', { content: '<img fileid="photo">', setting: { data: [{ fileId: 'photo', mimeType: 'image/png' }] } });
  const env = await setup({ entries: [entry], folders: [cloudFolder()] });
  const first = await env.sync();
  assert.equal(first.failed, 0);
  assert.ok(first.synced.some(item => item.type === 'image' && item.relativePath === '分类/img/photo.png'));
  env.api.fetchPage = async () => page([], []);
  const second = await env.sync();
  assert.equal(second.deleted, 1);
  assert.deepEqual(env.vault.trashed.sort(), ['导入/分类/img/photo.png', '导入/分类/笔记.md'].sort());
});

test('图片仍被导入目录外的笔记引用时保留', async () => {
  const env = await setup({ files: {
    '导入/分类/笔记.md': markdown(cloudNote(), '![](img/photo.png)'),
    '导入/分类/img/photo.png': '图片', '其他/引用.md': '![[导入/分类/img/photo.png]]'
  } });
  await env.setHistory([env.record(), env.image('分类/img/photo.png')]);
  const result = await env.sync();
  assert.equal(result.deleted, 1);
  assert.equal(env.vault.files.has('导入/分类/img/photo.png'), true);
});

test('未登记归属的旧图片保留', async () => {
  const env = await setup({ files: { '导入/分类/笔记.md': markdown(), '导入/分类/img/unknown.png': '未知图片' } });
  await env.setHistory([env.record()]);
  await env.sync();
  assert.equal(env.vault.files.has('导入/分类/img/unknown.png'), true);
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
    assert.equal(env.vault.trashed.length, 0);
  });
}

test('旧记录的账号归属不明时保留文件并报告未完成', async () => {
  const env = await setup({ files: { '导入/分类/笔记.md': markdown() } });
  await env.setHistory([env.record(cloudNote(), '分类/笔记.md', { account: undefined })]);
  const result = await env.sync();
  assert.equal(result.deleted, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.synced.find(item => item.id === '101').account, undefined);
});

test('旧记录仍能通过当前云端 ID 确认归属，后续可以同步删除', async () => {
  const env = await setup({ entries: [cloudNote()], folders: [cloudFolder()], files: { '导入/分类/笔记.md': markdown() } });
  await env.setHistory([env.record(cloudNote(), '分类/笔记.md', { account: undefined })]);
  const first = await env.sync();
  assert.equal(first.synced.find(item => item.type === 'note').account, env.api.accountKey);
  env.api.fetchPage = async () => page();
  assert.equal((await env.sync()).deleted, 1);
});

test('切换账号不删除原账号的记录和文件', async () => {
  const env = await setup({ files: { '导入/分类/笔记.md': markdown() } });
  await env.setHistory([env.record(cloudNote(), '分类/笔记.md', { account: 'other-account' })]);
  const result = await env.sync();
  assert.equal(result.deleted, 0);
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
  assert.equal(env.vault.trashed.length, 0);
});

test('无法读取稳定账号编号时不删除文件', async () => {
  const env = await setup({ cookie: '', files: { '导入/分类/笔记.md': markdown() } });
  await env.setHistory([env.record()]);
  assert.equal((await env.sync()).deleted, 0);
  assert.equal(env.vault.trashed.length, 0);
});

test('本地路径已被其他笔记替换时不删除', async () => {
  const env = await setup({ files: { '导入/分类/笔记.md': markdown(cloudNote('999')) } });
  await env.setHistory([env.record()]);
  const result = await env.sync();
  assert.equal(result.deleted, 0);
  assert.equal(result.failed, 1);
  assert.equal(env.vault.trashed.length, 0);
});

test('中断移动已完成时根据待移动路径清理云端已删除的笔记', async () => {
  const env = await setup({ files: { '导入/新分类/笔记.md': markdown() } });
  await env.setHistory([env.record(cloudNote(), '分类/笔记.md', { pendingMove: '新分类/笔记.md' })]);
  assert.equal((await env.sync()).deleted, 1);
  assert.deepEqual(env.vault.trashed, ['导入/新分类/笔记.md']);
});

test('中断移动的两个位置都存在时不猜测删除', async () => {
  const env = await setup({ files: { '导入/分类/笔记.md': markdown(), '导入/新分类/笔记.md': markdown() } });
  await env.setHistory([env.record(cloudNote(), '分类/笔记.md', { pendingMove: '新分类/笔记.md' })]);
  const result = await env.sync();
  assert.equal(result.failed, 1);
  assert.equal(env.vault.trashed.length, 0);
});

test('回收站操作失败时保留导入记录以便重试', async () => {
  const env = await setup({ files: { '导入/分类/笔记.md': markdown() } });
  await env.setHistory([env.record()]);
  env.vault.failTrash.add('导入/分类/笔记.md');
  const first = await env.sync();
  assert.equal(first.failed, 1);
  assert.ok(first.synced.some(item => item.id === '101'));
  env.vault.failTrash.clear();
  assert.equal((await env.sync()).deleted, 1);
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
  assert.equal(result.deleted, 0);
  assert.equal(env.vault.trashed.length, 0);
  assert.equal(env.vault.files.has('导入/分类/云端已删除.md'), true);
});

test('保存位置不同不复用原目录的导入记录', async () => {
  const env = await setup({ files: { '导入/分类/笔记.md': markdown() } });
  await settingsStore.actions.setImportResult('其他目录', '', [env.record()]);
  assert.equal((await env.sync()).deleted, 0);
  assert.equal(env.vault.trashed.length, 0);
});

test('保存到笔记库根目录时只删除登记的笔记', async () => {
  const env = await setup({ destination: '/', files: { '分类/笔记.md': markdown(), '其他.md': '自建内容' } });
  await env.setHistory([env.record()]);
  assert.equal((await env.sync()).deleted, 1);
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
  assert.equal(env.vault.trashed.length, 0);
});

test('移动完成后进程中断，重试删除时恢复目标图片归属', async () => {
  const env = await setup({ files: {
    '导入/新分类/笔记.md': markdown(cloudNote(), '![](img/photo.png)'),
    '导入/分类/img/photo.png': '图片', '导入/新分类/img/photo.png': '图片'
  } });
  await env.setHistory([env.record(cloudNote(), '分类/笔记.md', { pendingMove: '新分类/笔记.md' }),
    env.image('分类/img/photo.png')]);
  const result = await env.sync();
  assert.equal(result.deleted, 1);
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
  assert.equal(env.vault.trashed.length, 0);
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
  assert.equal(env.vault.trashed.length, 0);
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
  assert.equal(result.deleted, 0);
  assert.equal(env.vault.trashed.length, 0);
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

test('文件写入与回收站操作均受取消保护', async () => {
  const env = await setup({ files: { '导入/分类/笔记.md': markdown() } });
  const manager = new FileManager(env.vault, env.vault.adapter, '导入', async () => { throw new ImportCancelledError(); });
  await assert.rejects(manager.saveFile('分类/笔记.md', '新正文', time, time), ImportCancelledError);
  await assert.rejects(manager.deleteFile('分类/笔记.md'), ImportCancelledError);
  assert.equal(env.vault.writes.length, 0);
  assert.equal(env.vault.trashed.length, 0);
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
  assert.equal(env.vault.trashed.length, 0);
  complete(page());
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(env.vault.trashed.length, 0);
});

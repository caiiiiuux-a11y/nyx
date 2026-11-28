import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { memoryLabExample } from '../room/memory-lab-example.mjs';
import { openStore, RequestError } from './store.mjs';
import { ProviderContextError } from './usage.mjs';

test('live windows migrate the old Gemini route and keep duplicate model IDs tied to their supplier', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'haven-routes-'));
  const file = join(directory, 'chat.sqlite');
  const legacyModel = 'vertex_ai/gemini-3.8-flash';
  const mock = 'iris-demo-a';
  let store = openStore(file, { models: [mock, legacyModel], archiveRecall: false });
  t.after(async () => {
    store.close();
    await rm(directory, { force: true, recursive: true });
  });
  store.selectModel({ model: legacyModel });
  assert.equal(store.createWindow({ sourceThread: 'window' }).window.model, mock);
  const legacy = await store.send({ model: legacyModel, text: '合成问候', requestId: 'legacy' });
  store.close();

  const catalogs = { mock: [mock], gemini: [legacyModel], first: ['shared'], second: ['shared'] };
  const calls = [];
  const options = { models: catalogs.mock, modelsForRoute: route => catalogs[route], supportsWindowKey: true,
    archiveRecall: false, resumePendingOnRead: false, complete(request) {
      calls.push(request.route);
      if (calls.length === 1) throw new RequestError(503, '合成错误');
      return { text: '合成问候' };
    } };
  store = openStore(file, options);
  assert.equal(store.windowRoute(), 'gemini');
  const [iris, adrian] = legacy.messages;
  assert.deepEqual((await store.history()).messages, [{ ...iris, meta: { ...iris.meta, route: 'gemini' } }, adrian]);
  assert.equal(store.createWindow({}).window.route, 'mock');
  const inherited = store.createWindow({ sourceThread: 'window', requestId: 'new-from-chat' }).window;
  assert.equal(inherited.route, 'gemini');
  assert.equal(inherited.model, legacyModel);
  assert.equal(store.createWindow({ sourceThread: 'window', requestId: 'new-from-chat' }).window.id, inherited.id);
  assert.deepEqual((await store.history({ thread: inherited.id })).messages, []);
  assert.throws(() => store.createWindow({ sourceThread: 'no-such-window' }), { status: 404 });
  assert.deepEqual(calls, []);

  store.selectModel({ route: 'first', model: 'shared' });
  store.setDefaultWindowKey({ enabled: true, route: 'first' });
  const original = { route: 'first', model: 'shared', text: '同名模型', requestId: 'pending' };
  await assert.rejects(store.send(original), { status: 503 });
  store.selectModel({ route: 'second', model: 'shared' });
  assert.equal(store.defaultWindowKey(), false);
  assert.throws(() => store.setDefaultWindowKey({ enabled: true, route: 'first' }), { status: 409 });
  await assert.rejects(store.send(original), { status: 409 });
  await assert.rejects(store.send({ ...original, route: 'second' }), { status: 409 });
  const response = await store.send({ ...original, route: 'second', requestId: 'second' });
  const reroll = { id: response.messages[1].id, route: 'second', model: 'shared', requestId: 'reroll-second' };
  await store.regenerate(reroll);
  assert.equal((await store.history()).messages[2].meta.retryRoute, 'first');
  store.close();
  store = openStore(file, options);
  assert.equal(store.windowRoute(), 'second');
  store.selectModel({ route: 'first', model: 'shared' });
  assert.equal(store.defaultWindowKey(), true);
  await assert.rejects(store.regenerate({ ...reroll, route: 'first' }), { status: 409 });
  const retry = await store.send(original);
  assert.equal(retry.messages[1].meta.route, 'first');
  assert.deepEqual(calls, ['first', 'second', 'second', 'first']);
});

test('reopening live history or sending via mock never replays a failed paid request', async t => {
  const requests = [];
  let ready = false;
  const store = openStore(':memory:', {
    models: ['mock', 'gemini'], archiveRecall: false, resumePendingOnRead: false,
    complete(request) {
      requests.push(request);
      if (request.model === 'gemini' && !ready) throw new RequestError(503, '线路暂不可用');
      return { text: '合成回复', provider: request.model, reportedModel: request.model + '-v1' };
    }
  });
  t.after(() => store.close());
  const draft = { text: '查旧聊天：蓝色书签', requestId: 'paid', model: 'gemini' };
  store.selectModel({ model: 'gemini' });
  await assert.rejects(store.send(draft), { status: 503 });
  const pending = (await store.history()).messages;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].meta.retryRequestId, draft.requestId);
  assert.equal(pending[0].meta.retryModel, draft.model);
  store.selectModel({ model: 'mock' });
  await store.send({ text: '一条合成消息', requestId: 'local' });
  assert.deepEqual(requests.map(r => r.model), ['gemini', 'mock']);
  store.selectModel({ model: 'gemini' });
  ready = true;
  const retry = await store.send(draft);
  assert.equal(retry.messages[0].id, 1);
  assert.equal(retry.messages[1].meta.reportedModel, 'gemini-v1');
  assert.equal(retry.messages[1].meta.provider, 'gemini');
  assert.equal(requests.at(-1).messages.length, 2);
  assert.ok(requests.every(request => !request.archive && !request.tools));
  assert.equal((await store.history()).messages.length, 4);
});

test('migrates the original window and reopens independent transcripts with only relevant cross-window excerpts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'haven-windows-'));
  const file = join(directory, 'fixture.sqlite');
  const original = new DatabaseSync(file);
  original.exec(`CREATE TABLE settings(name TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT INTO settings VALUES('model','月桂');
    CREATE TABLE turns(id INTEGER PRIMARY KEY,request_id TEXT UNIQUE NOT NULL,
      draft TEXT NOT NULL,model TEXT NOT NULL,created TEXT NOT NULL,answer TEXT);`);
  const ts = '2025-01-02T00:00:00Z';
  original.prepare('INSERT INTO turns VALUES(?,?,?,?,?,?)').run(4, 'old',
    JSON.stringify({ text: '绿色书签', media: null, quote: null, model: null }), '月桂', ts,
    JSON.stringify({ id: 8, from: 'ai', text: '原来的回复', ts, meta: { thread: 'window' } }));
  original.close();
  const requests = [];
  const options = { provider: 'home-fixture', supportsWindowKey: true, embedder: false, complete: request => {
    requests.push(request);
    return { text: '新回复' };
  } };
  let store = openStore(file, options);
  t.after(async () => {
    store.close();
    await rm(directory, { force: true, recursive: true });
  });
  assert.deepEqual((await store.history()).messages.map(m => m.id), [7, 8]);
  assert.equal((await store.history()).model, '月桂');
  store.configureContext({ contextBudget: 4096, cacheMode: 'window' });
  const receipt = store.createWindow({ requestId: 'create' });
  const child = receipt.window.id;
  assert.deepEqual(store.createWindow({ requestId: 'create' }), receipt);
  store.configureContext({ thread: child, contextBudget: 0, cacheMode: 'auto' });
  const blank = store.createWindow({}).window.id;
  store.selectModel({ thread: child, model: '云杉' });
  await store.regenerate({ id: 8, requestId: 'old-reroll' });
  await store.send({ text: '后来才说的', requestId: 'later' });
  await store.send({ thread: blank, text: '黄色松果', requestId: 'blank' });
  assert.deepEqual(requests.at(-1).messages.slice(1).map(m => m.content), ['黄色松果']);
  assert.equal(requests.at(-1).archive, undefined);
  assert.deepEqual((await store.history({ thread: child })).messages, []);
  const draft = { thread: child, text: '绿色书签', requestId: 'child' };
  const result = await store.send(draft);
  assert.equal(requests.at(-1).model, '云杉');
  assert.deepEqual(requests.at(-1).messages.slice(1).map(m => m.content), ['绿色书签']);
  assert.equal(requests.at(-1).archive.automatic, true);
  assert.deepEqual(result.messages[1].meta.sourceRefs.map(source => [source.thread, source.messageId]), [['window', 7]]);
  assert.equal(requests.at(-1).cacheMode, 'auto');
  assert.equal((await store.history({ thread: blank })).cacheMode, 'auto');
  assert.equal((await store.history()).model, '月桂');
  await assert.rejects(store.send({ ...draft, thread: blank }), { status: 409 });
  await assert.rejects(store.regenerate({ thread: child, id: 8, requestId: 'old-reroll' }), { status: 404 });
  assert.throws(() => store.readArchiveSource({ thread: child, messageId: 7 }), { status: 404 });
  assert.throws(() => store.bindEvidence({ thread: child, messageIds: [7], memoryId: 'synthetic' }), { status: 400 });
  assert.ok((await store.searchArchive({ thread: child, query: '绿色书签' })).hits.every(hit => hit.thread === child));
  await store.send({ thread: blank, requestId: 'future', text: '绿色书签装进纸盒' });
  const reroll = await store.regenerate({ thread: child, id: result.messages[1].id, requestId: 'child-reroll' });
  assert.ok(reroll.message.meta.sourceRefs.every(ref => ref.messageId < result.messages[0].id));
  store.close();
  store = openStore(file, options);
  assert.equal(store.listWindows().windows.find(w => w.id === child).title, '绿色书签');
  const reopened = await store.history({ thread: child });
  assert.deepEqual(reopened.messages, [result.messages[0], reroll.message]);
  assert.equal(reopened.contextBudget, 0);
  assert.equal((await store.history({ thread: blank })).contextBudget, 8192);
  assert.equal((await store.history()).contextBudget, 4096);
  assert.deepEqual(reopened.usage, reroll.message.meta.usage);
});

test('an oversized message cannot prevent later turns or leak a pending turn into another window', async t => {
  const store = openStore(':memory:', { embedder: false, complete: request => {
    if (request.contextBudget === 1024 && request.messages.at(-1).content === '工具用量') throw new RangeError();
    return { text: '合成回复' };
  } });
  t.after(() => store.close());
  store.configureContext({ contextBudget: 1024, cacheMode: 'auto' });
  await assert.rejects(store.send({ requestId: 'large', text: '字'.repeat(3000) }), { status: 413 });
  assert.equal((await store.history()).messages.length, 0);
  const blocked = { requestId: 'tool', text: '工具用量' };
  await assert.rejects(store.send(blocked), { status: 413 });
  const { window } = store.createWindow({});
  assert.equal((await store.history({ thread: window.id })).messages.length, 0);
  await store.send({ requestId: 'next', text: '另一件事' });
  store.configureContext({ contextBudget: 0, cacheMode: 'auto' });
  const retry = await store.send(blocked);
  assert.equal(retry.messages[0].id, 1);
  assert.equal((await store.history()).messages.length, 4);
});

test('unlimited includes all completed turns before the reply, with recovery after a provider limit', async t => {
  let request;
  let rejectNext = false;
  const store = openStore(':memory:', { embedder: false, complete(input) {
    request = input;
    if (rejectNext) { rejectNext = false; throw new ProviderContextError(); }
    return { text: '合成回音' };
  } });
  t.after(() => store.close());
  const configure = contextBudget => store.configureContext({ contextBudget, cacheMode: 'auto' });
  assert.throws(() => configure(-1), { status: 400 });
  configure(0);
  const first = '长'.repeat(25000);
  await store.send({ requestId: 'long', text: first });
  for (let i = 0; i < 13; i++) await store.send({ requestId: 'short-' + i, text: '好' });
  const target = await store.send({ requestId: 'target', text: '目标' });
  assert.equal(request.messages.length, 30);
  assert.equal(request.messages[1].content, first);
  await store.send({ requestId: 'later', text: '稍后写的消息' });
  await store.regenerate({ requestId: 'reroll', id: target.messages[1].id });
  assert.equal(request.messages.length, 30);
  assert.equal(request.messages.at(-1).content, '目标');
  const pending = { requestId: 'oversize', text: '超出模型长度' };
  rejectNext = true;
  await assert.rejects(store.send(pending), { status: 413, message: /模型线路/ });
  await store.send({ requestId: 'after-rejection', text: '好' });
  assert.ok(!request.messages.some(message => message.content === pending.text));
  configure(1024);
  const recovered = await store.history();
  assert.equal(request.contextBudget, 1024);
  assert.equal(request.messages.at(-1).content, pending.text);
  assert.ok(!request.messages.some(message => message.content === first));
  assert.equal(recovered.messages.filter(message => message.text === pending.text).length, 1);
  assert.deepEqual((await store.send(pending)).messages.map(message => message.text), [pending.text, '合成回音']);
});

test('a confirmed shared memory carries its excerpt across windows without opening the old transcript', async t => {
  const store = openStore(':memory:', { memoryLab: { callTool: () => ({ text: memoryLabExample.fact, bucketId: 'test-bucket' }) } });
  t.after(() => store.close());
  const original = await store.send({ requestId: 'hold', text: memoryLabExample.hold });
  const { window } = store.createWindow({});
  const recalled = await store.send({ thread: window.id, requestId: 'recall', text: memoryLabExample.search });
  assert.deepEqual(recalled.messages[1].meta.sourceRefs, original.messages[1].meta.sourceRefs);
  assert.deepEqual(store.evidence({ thread: window.id, memoryId: 'test-bucket' }).sources, []);
  assert.throws(() => store.readArchiveSource({ thread: window.id, messageId: original.messages[0].id }), { status: 404 });
});

test('the provider default and each window override resolve once for a send or reroll, including after a restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'haven-cache-'));
  const file = join(directory, 'synthetic.sqlite');
  const original = new DatabaseSync(file);
  original.exec(`CREATE TABLE turns (id INTEGER PRIMARY KEY, request_id TEXT UNIQUE NOT NULL,
    draft TEXT NOT NULL, model TEXT NOT NULL, created TEXT NOT NULL, answer TEXT);
    CREATE TABLE regenerations (request_id TEXT PRIMARY KEY, message_id INTEGER NOT NULL, model TEXT, answer TEXT NOT NULL);`);
  original.prepare('INSERT INTO turns VALUES(1,?,?,?,?,NULL)').run('older-pending',
    JSON.stringify({ text: '旧草稿', media: null, quote: null, model: null }), '月桂', new Date().toISOString());
  original.close();
  let failNext = false;
  const calls = [];
  const options = { provider: 'home-fixture', supportsWindowKey: true, embedder: false, complete(request) {
    calls.push(request.cacheMode);
    if (failNext) { failNext = false; throw new Error('synthetic outage'); }
    return { text: '合成回复' };
  } };
  let store = openStore(file, options);
  t.after(async () => { store.close(); await rm(directory, { force: true, recursive: true }); });
  const first = store.createWindow({}).window.id;
  const second = store.createWindow({}).window.id;
  const send = (thread, requestId) => store.send({ thread, requestId, text: '好' });
  const configure = (thread, cacheMode) => store.configureContext({ thread, cacheMode, contextBudget: 8192 });
  const fresh = await store.history({ thread: first });
  assert.deepEqual(fresh.cacheCapabilities, { windowKey: true });
  assert.equal(fresh.defaultWindowKey, false);
  assert.throws(() => store.setDefaultWindowKey({ enabled: 'false' }), { status: 400 });
  await send(first, 'default-off');
  store.setDefaultWindowKey({ enabled: true });
  await store.history(); // The migrated pending turn predates the new default.
  await send(first, 'inherit-on');
  configure(second, 'provider');
  await send(second, 'override-off');
  configure(second, 'window');
  store.setDefaultWindowKey({ enabled: false });
  const answer = await send(second, 'override-on');
  assert.deepEqual(calls, ['auto', 'auto', 'window', 'auto', 'window']);
  configure(second, 'auto');
  store.setDefaultWindowKey({ enabled: true });
  failNext = true;
  await assert.rejects(send(second, 'retry-send'), { status: 503 });
  store.setDefaultWindowKey({ enabled: false });
  store.close();
  store = openStore(file, options);
  await send(second, 'retry-send');
  assert.deepEqual(calls.slice(-2), ['window', 'window']);
  const reroll = { thread: second, id: answer.messages[1].id, requestId: 'retry-reroll' };
  failNext = true;
  await assert.rejects(store.regenerate(reroll), { status: 503 });
  store.setDefaultWindowKey({ enabled: true });
  store.close();
  store = openStore(file, options);
  const recovered = await store.regenerate(reroll);
  const count = calls.length;
  assert.deepEqual(await store.regenerate(reroll), recovered);
  assert.equal(calls.length, count);
  assert.deepEqual(calls.slice(-2), ['auto', 'auto']);
  assert.equal((await store.history({ thread: second })).defaultWindowKey, true);
  assert.equal((await store.history({ thread: second })).cacheMode, 'auto');
  const mock = openStore(':memory:');
  try {
    assert.deepEqual((await mock.history()).cacheCapabilities, { windowKey: false });
    assert.throws(() => mock.setDefaultWindowKey({ enabled: true }), { status: 404 });
  } finally { mock.close(); }
});

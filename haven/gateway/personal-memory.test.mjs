import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createLiveRoutes } from './live-routes.mjs';
import { firstOmbreExcerpt } from './ombre-search.mjs';
import { openStore } from './store.mjs';

function frame(header, body, metadata = '') {
  const tail = metadata + '\n' + body;
  const payload = header + tail;
  const hash = createHash('sha256').update(payload).digest('hex');
  return header + ' [content_role:stored_memory_data] [instructions:false] [may_call_tools:false]' +
    ' [boundary_id:' + 'a'.repeat(24) + '] [payload_chars:' + [...payload].length + '] [payload_sha256:' + hash + ']' +
    tail + '\n👣 Footprint：仅供本机查看';
}

test('uses Ombre ranking and verified verbatim excerpts, keeping metadata and unrelated associations local', () => {
  const first = frame('[语义关联] [bucket_id:木屋_12]', '🌿'.repeat(195) + '窗台上放着一朵星形花。', '\n🖼️ media: private/path');
  const next = frame('[bucket_id:second]', '星形花是另一条记录。');
  const drift = frame('[联想浮现·非检索命中] [bucket_id:drift]', '偶然想到。\n' + next);
  const hit = firstOmbreExcerpt([drift, first, next].join('\n---\n'), '星形花');
  assert.equal(hit.bucketId, '木屋_12');
  assert.equal(hit.semantic, true);
  assert.ok(hit.excerpt.endsWith('窗台上放着一朵星形花。'));
  assert.ok([...hit.excerpt].length <= 180 && hit.excerpt.isWellFormed());
  const archived = firstOmbreExcerpt(frame('[query 命中·已删除到档案] [bucket_id:old] [状态:已退出日常记忆，原文仍保留]', '当年的花园。'), '花园');
  assert.deepEqual(archived, { bucketId: 'old', excerpt: '当年的花园。', archived: true });
  const morning = frame('📌 [核心准则] [bucket_id:pinned]', '先打开窗户。', '\n💭 meaning: 私有元数据');
  assert.deepEqual(firstOmbreExcerpt(morning + '\n---\n' + next), { bucketId: 'pinned', excerpt: '先打开窗户。' });
  const long = frame('[bucket_id:long]', '确实是那朵花。' + '第二句很长'.repeat(60));
  assert.equal(firstOmbreExcerpt(long, '那朵花').excerpt, '确实是那朵花。');
  assert.equal(firstOmbreExcerpt(drift, '花'), null);
  assert.equal(firstOmbreExcerpt('权重池暂时平静——我手上没什么需要主动浮现的东西。'), null);
  assert.equal(firstOmbreExcerpt('没有匹配到「花」相关的记忆。', '花'), null);
  assert.throws(() => firstOmbreExcerpt(first.replace('星形花', '三色花'), '花'), /Incomplete/);
  assert.throws(() => firstOmbreExcerpt('[OB-E004] unrelated diagnostics', '花'), /Unrecognized/);
});

const model = 'vertex_ai/gemini-fixture';
const endpoint = 'https://trial.example/v1';
const opening = { bucketId: 'morning', excerpt: '要记得给花浇水。' };
const found = { bucketId: 'flower', excerpt: '花瓣是浅黄色的。' };
function stream(delta, finish_reason = 'stop') {
  const chunk = { choices: [{ delta, finish_reason }] };
  return new Response('data: ' + JSON.stringify(chunk) + '\n\ndata: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } });
}
function storeFor(routes, db = ':memory:') {
  return openStore(db, { complete: routes.complete, models: routes.active('mock').models,
    modelsForRoute: id => routes.active(id).models, resumePendingOnRead: false, embedder: false });
}

test('all windows share the saved provider choice, with one opening breath and on-demand searches', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'haven-ombre-'));
  let surfaces = 0, searches = 0, failFirst = false;
  const requests = [];
  const settings = { baseURL: endpoint, model, apiKey: 'test-only', profileFile: join(dir, 'routes.json'),
    personalMemory: { surface() { surfaces++; return opening; }, search(query, domain) {
      assert.equal(query, '星形花'); assert.equal(domain, 'garden'); searches++; return found;
    } },
    async fetchImpl(_, opts) {
      const body = JSON.parse(opts.body);
      requests.push(body);
      if (failFirst) { failFirst = false; return new Response(null, { status: 502 }); }
      const last = body.messages.at(-1);
      if (last.role === 'tool') return stream({ content: JSON.parse(last.content).excerpt });
      if (last.content.includes('查花瓣')) return stream({ tool_calls: [{ type: 'function', id: 'call-flower',
        function: { name: 'breath_search', arguments: '{"query":"星形花","domain":"garden"}' } }] }, 'tool_calls');
      return stream({ content: '你好。' });
    } };
  let routes = createLiveRoutes(settings);
  const db = join(dir, 'store.sqlite');
  let store = storeFor(routes, db);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  routes.select(store, { route: 'gemini', model });
  assert.equal(routes.active('gemini').memorySource, 'synthetic');
  await store.send({ requestId: 'before-enable', text: '你好' });
  const thread = store.createWindow({ sourceThread: 'window' }).window.id;
  routes.setMemorySource(store, { route: 'gemini', source: 'personal' });
  assert.equal(routes.memoryScope('gemini', 'other-model'), null);
  assert.throws(() => routes.setMemorySource(store, { route: 'mock', source: 'personal' }));
  const existing = await store.send({ requestId: 'existing', text: '查花瓣' });
  assert.equal(existing.messages[1].meta.memoryTool.scope, 'personal');
  assert.equal(surfaces, 0);
  const draft = { thread, requestId: 'opening', text: '查花瓣' };
  failFirst = true;
  await assert.rejects(store.send(draft), { status: 503 });
  assert.equal(surfaces, 1);
  store.close();
  routes = createLiveRoutes(settings);
  store = storeFor(routes, db);
  assert.equal(routes.active('gemini').memorySource, 'personal');
  assert.equal((await store.history({ thread })).messages.length, 1);
  const resumed = await store.send(draft);
  const [, answer] = resumed.messages;
  assert.equal(answer.text, found.excerpt);
  assert.deepEqual(answer.meta.openingMemory, { name: 'breath', scope: 'personal', status: 'ok', ...opening });
  assert.equal(answer.meta.memoryTool.bucketId, found.bucketId);
  assert.equal(surfaces, 1);
  assert.equal(searches, 2);
  assert.equal(requests.at(-2).tools[0].function.name, 'breath_search');
  assert.ok(requests.at(-2).messages.at(-1).content.includes(opening.excerpt));
  assert.deepEqual(JSON.parse(requests.at(-1).messages.at(-1).content), { found: true, ...found });
  const count = requests.length;
  assert.deepEqual((await store.send(draft)).messages, resumed.messages);
  assert.deepEqual((await store.history({ thread })).messages, resumed.messages);
  assert.equal(requests.length, count);
  const follow = await store.send({ thread, requestId: 'next', text: '谢谢' });
  assert.equal(follow.messages[1].meta.openingMemory, undefined);
  assert.equal(follow.messages[1].meta.memoryTool, undefined);
  assert.equal(surfaces, 1);
  assert.equal(searches, 2);
  routes.setMemorySource(store, { route: 'gemini', source: 'synthetic' });
  const other = store.createWindow({ sourceThread: thread }).window.id;
  await store.send({ thread: other, requestId: 'disabled', text: '你好' });
  assert.equal(surfaces, 1);
  assert.equal(requests.at(-1).tools, undefined);
  routes.setMemorySource(store, { route: 'gemini', source: 'personal' });
  const moved = createLiveRoutes({ ...settings, baseURL: 'https://different.example/v1' });
  assert.equal(moved.memoryScope('gemini', model), null);
  const newProfile = moved.status(store, thread).routes.find(p => p.endpoint?.startsWith('https://different.example'));
  assert.equal(newProfile.memorySource, 'synthetic');
});

test('turning off personal memory during a read prevents sending the retrieved result', async t => {
  let notify, release;
  const started = new Promise(resolve => { notify = resolve; });
  const result = new Promise(resolve => { release = resolve; });
  const wire = [];
  const routes = createLiveRoutes({ baseURL: endpoint, apiKey: 'test-only', model,
    personalMemory: { surface: () => null, async search() { notify(); return result; } },
    async fetchImpl(_, options) {
      wire.push(options.body);
      return stream({ tool_calls: [{ id: 'asked', type: 'function',
        function: { name: 'breath_search', arguments: '{"query":"花"}' } }] }, 'tool_calls');
    } });
  const store = storeFor(routes);
  t.after(() => store.close());
  routes.select(store, { route: 'gemini', model });
  routes.setMemorySource(store, { route: 'gemini', source: 'personal' });
  const pending = store.send({ requestId: 'look', text: '查花瓣' });
  await started;
  routes.setMemorySource(store, { route: 'gemini', source: 'synthetic' });
  release(found);
  await assert.rejects(pending, { status: 409 });
  assert.equal(wire.length, 1);
  assert.ok(!wire[0].includes(found.excerpt));
});

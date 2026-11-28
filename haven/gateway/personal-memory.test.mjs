import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createLiveRoutes } from './live-routes.mjs';
import { firstOmbreExcerpt } from './ombre-search.mjs';
import { openStore } from './store.mjs';
import { ombreReceipt } from './ombre-tools.mjs';

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
const definitions = [
  { name: 'breath_search', parameters: { type: 'object', properties: { query: { type: 'string' }, domain: { type: 'string' } }, required: ['query'] } },
  { name: 'breath', parameters: { type: 'object', properties: {} } },
  { name: 'hold', parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] } }
];
const sampleHit = { text: frame('[bucket_id:flower]', found.excerpt) };
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
    personalMemory: { listTools: () => definitions, surface() { surfaces++; return opening; }, callTool(name, {query, domain}) {
      assert.equal(name, 'breath_search'); assert.equal(query, '星形花'); assert.equal(domain, 'garden'); searches++; return sampleHit;
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
  assert.ok(requests.at(-2).tools.some(t => t.function.name === 'breath_search'));
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
    personalMemory: { listTools: () => definitions, surface: () => null, async callTool() { notify(); return result; } },
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
  release(sampleHit);
  await assert.rejects(pending, { status: 409 });
  assert.equal(wire.length, 1);
  assert.ok(!wire[0].includes(found.excerpt));
});

function toolCall(name, args = {}, index = 0) {
  return { type: 'function', index, id: 'call-' + name, function: { name, arguments: JSON.stringify(args) } };
}

test('the window catalog and the model share discovered tools, including new names and a mid-chat breath', async t => {
  const extra = { name: 'future_tool', description: '演示未来接入的工具', parameters: { type: 'object', properties: {} } };
  const executed = [], wire = [];
  let openings = 0;
  const routes = createLiveRoutes({ baseURL: endpoint, apiKey: 'test-only', model, personalMemory: {
    listTools: () => [...definitions, extra], surface() { openings++; return opening; },
    callTool(name, args) { executed.push([name, args]); return sampleHit; }
  }, async fetchImpl(_, opts) {
    const body = JSON.parse(opts.body); wire.push(body);
    if (body.messages.at(-1).role === 'tool') return stream({ content: '收到。' });
    return stream({ tool_calls: [toolCall('breath')] }, 'tool_calls');
  } });
  const store = storeFor(routes); t.after(() => store.close());
  assert.deepEqual((await routes.toolList(store)).groups, []);
  routes.select(store, { route: 'gemini', model });
  routes.setMemorySource(store, { route: 'gemini', source: 'personal' });
  const catalog = await routes.toolList(store);
  assert.ok(catalog.groups[0].tools.some(x => x.name === 'future_tool' && x.description === extra.description));
  assert.equal(executed.length, 0); assert.equal(openings, 0);
  const first = await store.send({ requestId: 'first', text: 'breath' });
  assert.equal(first.messages[1].meta.openingMemory.bucketId, 'morning');
  assert.equal(first.messages[1].meta.memoryTool, undefined);
  assert.equal(JSON.parse(wire.at(-1).messages.at(-1).content).bucketId, 'morning');
  const next = await store.send({ requestId: 'again', text: '再 breath 一次。' });
  assert.equal(next.messages[1].meta.memoryTool.name, 'breath');
  assert.equal(next.messages[1].meta.memoryTool.bucketId, found.bucketId);
  assert.equal(next.messages[1].meta.openingMemory, undefined);
  assert.equal(openings, 1); assert.deepEqual(executed, [['breath', {}]]);
  assert.deepEqual(wire[0].tools.map(t => t.function.name), catalog.groups[0].tools.map(t => t.name));
  assert.equal(ombreReceipt('breath', {}, { text: 'unverified body' }).receipt.status, 'error');
  assert.ok(!JSON.stringify(ombreReceipt('breath', {}, { text: 'unverified body' })).includes('unverified body'));
});

test('a paid reply can fail after several tools; retry after restart and regeneration replay receipts without writing again', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'haven-tool-journal-'));
  const db = join(dir, 'store.sqlite');
  const ran = [];
  let fail = true;
  const settings = { baseURL: endpoint, apiKey: 'test-only', model, profileFile: join(dir, 'routes.json'),
    personalMemory: { listTools: () => definitions, surface: () => null, callTool(name, args) {
      ran.push([name, args]); return name === 'hold' ? { text: '新建测试记录' } : sampleHit;
    } }, async fetchImpl(_, opts) {
      const body = JSON.parse(opts.body);
      if (!body.tools) {
        assert.ok(body.messages.at(-1).content.includes('新建测试记录'));
        return stream({ content: '已收到两条回执' });
      }
      if (body.messages.at(-1).role === 'tool') {
        assert.equal(body.messages.at(-3).tool_calls.length, 2);
        assert.deepEqual(body.messages.slice(-2).map(m => m.tool_call_id), ['call-hold', 'call-breath_search']);
        if (fail) { fail = false; return new Response(null, { status: 502 }); }
        throw Error('The recorded batch must never be executed a second time');
      }
      return stream({ tool_calls: [toolCall('hold', { content: '合成小花' }), toolCall('breath_search', { query: '小花' }, 1)] }, 'tool_calls');
    } };
  let routes = createLiveRoutes(settings);
  let store = storeFor(routes, db);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  routes.select(store, { route: 'gemini', model });
  routes.setMemorySource(store, { route: 'gemini', source: 'personal' });
  const input = { requestId: 'save-and-find', text: '记下来，再查小花。' };
  await assert.rejects(store.send(input), { status: 503 });
  assert.equal(ran.length, 2);
  store.close(); routes = createLiveRoutes(settings); store = storeFor(routes, db);
  const { messages } = await store.send(input);
  assert.deepEqual(messages[1].meta.memoryTools.map(r => [r.name, r.status]), [['hold', 'ok'], ['breath_search', 'ok']]);
  assert.ok(messages[1].meta.memoryTools[0].output.includes('新建测试记录'));
  await store.regenerate({ requestId: 'reword', id: messages[1].id });
  assert.equal(ran.length, 2);
});

test('a small window can discover any native function and receives a budgeted native report', async t => {
  const large = Array.from({ length: 24 }, (_, i) => ({ name: 'extra_' + i, description: '演示工具说明'.repeat(8),
    parameters: { type: 'object', properties: {} } }));
  const pulse = { name: 'pulse', parameters: { type: 'object', properties: {} } };
  let invoked = 0, sawResult = false;
  const routes = createLiveRoutes({ baseURL: endpoint, apiKey: 'test-only', model,
    personalMemory: { listTools: () => [...large, pulse], surface: () => null,
      callTool(name) { assert.equal(name, 'pulse'); invoked++; return { text: '系统摘要。'.repeat(750) }; } },
    async fetchImpl(_, opts) {
      const body = JSON.parse(opts.body), last = body.messages.at(-1);
      if (last.role === 'user') {
        assert.deepEqual(body.tools.map(x => x.function.name), ['select_ombre_tool']);
        return stream({ tool_calls: [toolCall('select_ombre_tool', { name: 'pulse' })] }, 'tool_calls');
      }
      if (last.tool_call_id === 'call-select_ombre_tool') {
        assert.ok(body.tools.some(x => x.function.name === 'pulse'));
        return stream({ tool_calls: [toolCall('pulse')] }, 'tool_calls');
      }
      const report = JSON.parse(last.content);
      assert.equal(report.truncated, true); assert.ok(report.result.startsWith('系统摘要'));
      sawResult = true; return stream({ content: '已读到摘要。' });
    } });
  const store = storeFor(routes); t.after(() => store.close());
  routes.select(store, { route: 'gemini', model });
  routes.setMemorySource(store, { route: 'gemini', source: 'personal' });
  store.configureContext({ contextBudget: 1024, cacheMode: 'auto' });
  const { messages } = await store.send({ requestId: 'small', text: '看一眼系统状态。' });
  assert.equal(invoked, 1); assert.equal(sawResult, true); assert.equal(messages[1].meta.memoryTool.name, 'pulse');
});

test('a lost native write result stays uncertain and explicit multi-result search cites the direct matches', async t => {
  const output = frame('[bucket_id:f1]', '一朵花。') + '\n' + frame('[联想浮现·非检索命中] [bucket_id:x]', '另一件事。') +
    '\n' + frame('[bucket_id:f2]', '两朵花。');
  const multi = ombreReceipt('breath_search', { query: '花', max_results: 2 }, { text: output });
  assert.deepEqual([multi.receipt.bucketId, ...multi.receipt.alsoFound.map(hit => hit.bucketId)], ['f1', 'f2']);
  assert.ok(!JSON.stringify(multi.evidence).includes('另一件事'));
  let writes = 0;
  const routes = createLiveRoutes({ baseURL: endpoint, apiKey: 'test-only', model, personalMemory: {
    listTools: () => definitions, surface: () => null, callTool() { writes++; throw Error('断开'); }
  }, async fetchImpl(_, opts) {
    const body = JSON.parse(opts.body);
    if (!body.tools || body.messages.at(-1).role === 'tool') return stream({ content: '结果待核对。' });
    return stream({ tool_calls: [toolCall('hold', { content: '合成记录' })] }, 'tool_calls');
  } });
  const store = storeFor(routes); t.after(() => store.close());
  routes.select(store, { route: 'gemini', model });
  routes.setMemorySource(store, { route: 'gemini', source: 'personal' });
  const { messages } = await store.send({ requestId: 'uncertain', text: '记下这件事。' });
  assert.equal(messages[1].meta.memoryTool.status, 'uncertain');
  await store.regenerate({ requestId: 'again', id: messages[1].id });
  assert.equal(writes, 1);
});

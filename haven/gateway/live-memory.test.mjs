import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryLabExample } from '../room/memory-lab-example.mjs';
import { createLiveRoutes } from './live-routes.mjs';
import { liveFixtureHit, searchLiveFixture } from './ombre-lab.mjs';
import { completeMemoryTurn, liveSearchTool } from './provider-turn.mjs';
import { openStore } from './store.mjs';

const bucketId = '12cc34dd56ee';
const excerpt = memoryLabExample.fact;
const lookup = '观测站';
const question = '阿川，上次观测站收起来的东西是什么，放在哪儿了？';
const raw = { text: '[bucket_id:145ba63d87cc]\n另一个桶的材料\n---\n[bucket_id:' + bucketId + ']\n' + excerpt };
const model = 'vertex_ai/gemini-fixture';

function stream(delta, finish_reason) {
  const frame = { choices: [{ delta, finish_reason }], model, usage: { prompt_tokens: 21, completion_tokens: 9 } };
  return new Response('data: ' + JSON.stringify(frame) + '\n\ndata: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } });
}

test('a fresh Gemini window searches on demand, streams the answer, and reopens the saved fixture receipt', async t => {
  const sent = [];
  const searches = [];
  const call = { type: 'function', id: 'model-call-27__thought__opaque-roundtrip',
    function: { name: 'memory_search', arguments: JSON.stringify({ query: lookup }) },
    extra_content: { google: { thought_signature: 'opaque-roundtrip' } },
    provider_specific_fields: { thought_signature: 'opaque-roundtrip' } };
  const routes = createLiveRoutes({ baseURL: 'https://trial.example/v1', model, apiKey: 'only-for-tests',
    searchMemory(query) { searches.push(query); return liveFixtureHit(raw, query); },
    async fetchImpl(url, options) {
      if (options.method === 'GET') return Response.json({ data: [{ id: model }] });
      const body = JSON.parse(options.body);
      sent.push(body);
      const last = body.messages.at(-1);
      if (last.role === 'tool') {
        assert.equal(last.tool_call_id, call.id);
        assert.deepEqual(body.messages.at(-2).tool_calls, [call]);
        assert.deepEqual(body.tools, sent[0].tools);
        assert.equal(body.tool_choice, 'none');
        const evidence = JSON.parse(last.content);
        assert.deepEqual(evidence, { found: true, bucketId, excerpt });
        return stream({ content: evidence.excerpt }, 'stop');
      }
      assert.doesNotMatch(JSON.stringify(body), /Paperfinch|纸雀|薄荷|纽扣|三号抽屉|12cc34dd56ee|另一个桶/);
      if (url.host !== 'trial.example') {
        assert.equal(body.tools, undefined);
        return stream({ content: '另一条线路。' }, 'stop');
      }
      assert.deepEqual(body.tools.map(t => t.function.name), ['memory_search']);
      assert.equal(body.tool_choice, undefined);
      if (!last.content.includes(question)) return stream({ content: '你好。' }, 'stop');
      return stream({ content: '我想想。', tool_calls: [call] }, 'stop');
    } });
  const store = openStore(':memory:', { complete: routes.complete, models: routes.active('mock').models,
    modelsForRoute: id => routes.active(id).models, resumePendingOnRead: false, embedder: false });
  t.after(() => store.close());
  routes.select(store, { route: 'gemini', model });
  await store.send({ requestId: 'hello', text: '你好' });
  assert.deepEqual(searches, []);
  const thread = store.createWindow({ sourceThread: 'window' }).window.id;
  assert.deepEqual((await store.history({ thread })).messages, []);
  const draft = { requestId: 'question', thread, text: question };
  const deltas = [];
  const { messages: [, answer] } = await store.send(draft, text => deltas.push(text));
  assert.deepEqual(searches, [lookup]);
  assert.equal(deltas.join(''), answer.text);
  assert.equal(answer.text, '我想想。\n\n' + excerpt);
  assert.equal(answer.meta.model, model);
  assert.deepEqual(answer.meta.memoryTool, { name: 'breath_search', scope: 'synthetic', status: 'ok',
    query: lookup, callId: 'model-call-27', bucketId, excerpt });
  assert.equal(answer.meta.usage.calls, 2);
  assert.equal(answer.meta.usage.totalTokens, 60);
  assert.equal(answer.meta.sourceRefs, undefined);
  assert.ok(!JSON.stringify(answer).includes('opaque-roundtrip'));
  assert.deepEqual((await store.history({ thread })).messages[1], answer);
  assert.deepEqual((await store.send(draft)).messages[1], answer);
  assert.equal(sent.length, 3);

  // A later fresh window should be able to cite Ombre again, even after the first answer is in chat.
  const another = store.createWindow({ sourceThread: thread }).window.id;
  await store.send({ thread: another, requestId: 'repeat', text: question });
  assert.deepEqual(searches, [lookup, lookup]);
  const { addedRoute } = await routes.add(store, { label: '其他', baseURL: 'https://other.example/v1' });
  routes.select(store, { thread: another, route: addedRoute, model });
  await store.send({ thread: another, requestId: 'elsewhere', text: question });
  assert.equal(searches.length, 2);
});

test('a Gemini route that repeats a lookup after a miss finishes the same turn with one search', async t => {
  const call = { id: 'first-lookup', type: 'function',
    function: { name: 'memory_search', arguments: JSON.stringify({ query: '苹果树' }) } };
  const payloads = [];
  const lookups = [];
  const reply = '这次没有找到苹果树的记录。';
  const routes = createLiveRoutes({ baseURL: 'https://fixture.example/v1', model, apiKey: 'local-test-key',
    searchMemory(query) { lookups.push(query); return null; },
    async fetchImpl(_, options) {
      const body = JSON.parse(options.body);
      payloads.push(body);
      if (body.tools) {
        const preamble = body.messages.at(-1).role === 'tool' ? '让我想想。' : '我查一下。';
        return stream({ content: preamble, tool_calls: [call] }, 'tool_calls');
      }
      return stream({ content: reply }, 'stop');
    } });
  const store = openStore(':memory:', { complete: routes.complete, models: routes.active('mock').models,
    modelsForRoute: id => routes.active(id).models, resumePendingOnRead: false, embedder: false });
  t.after(() => store.close());
  routes.select(store, { route: 'gemini', model });
  const draft = { requestId: 'garden-question', text: '还记得那棵苹果树吗？' };
  const deltas = [];
  const result = await store.send(draft, delta => deltas.push(delta));
  assert.equal(payloads.length, 3);
  assert.equal(payloads[0].tool_choice, undefined);
  assert.deepEqual(payloads[1].tools, payloads[0].tools);
  assert.equal(payloads[1].tool_choice, 'none');
  assert.deepEqual(payloads[1].messages.at(-1), { role: 'tool', tool_call_id: call.id, content: '{"found":false}' });
  assert.equal(payloads[2].tools, undefined);
  assert.deepEqual(payloads[2].messages.map(message => message.role), ['system', 'user']);
  assert.ok(payloads[2].messages.at(-1).content.endsWith('{"found":false}'));
  assert.doesNotMatch(JSON.stringify(payloads[2]), /first-lookup|memory_search/);
  assert.deepEqual(lookups, ['苹果树']);
  const [, answer] = result.messages;
  assert.equal(answer.text, '我查一下。\n\n让我想想。\n\n' + reply);
  assert.equal(deltas.join(''), answer.text);
  assert.equal(answer.meta.memoryTool.status, 'empty');
  assert.equal(answer.meta.memoryTool.bucketId, undefined);
  assert.equal(answer.meta.memoryTool.excerpt, undefined);
  assert.equal(answer.meta.usage.calls, 3);
  assert.equal(answer.meta.usage.totalTokens, 90);
  assert.deepEqual((await store.send(draft)).messages, result.messages);
  assert.deepEqual((await store.history()).messages, result.messages);
  assert.equal(payloads.length, 3);
});

test('only relevant direct hits on the one synthetic text can leave the lab', () => {
  assert.deepEqual(liveFixtureHit(raw, lookup), { bucketId, excerpt });
  assert.equal(liveFixtureHit(raw, '火车轮距'), null);
  assert.equal(liveFixtureHit({ text: '[联想浮现·非检索命中] ' + raw.text.split('---\n')[1] }, lookup), null);
  assert.equal(liveFixtureHit({ text: raw.text.replace(excerpt, '另外一条观测站记忆') }, lookup), null);
  assert.equal(liveFixtureHit({ text: '没有匹配。' }, lookup), null);
  assert.throws(() => liveFixtureHit({ text: '[OB-E004]' }, lookup));
});

test('a lexical retry only uses words the model actually requested', async () => {
  const queries = [];
  const hit = await searchLiveFixture('观测站 收起来', async (name, args) => {
    assert.equal(name, 'breath_search');
    queries.push(args.query);
    return args.query === lookup ? raw : { text: '没有匹配。' };
  });
  assert.deepEqual(queries, ['观测站 收起来', lookup]);
  assert.deepEqual(hit, { bucketId, excerpt, matchedQuery: lookup });
});

test('misses and service failures get distinct tool replies and no citation, invalid calls never execute', async () => {
  const call = { id: 'synthetic-call', name: 'memory_search', arguments: { query: lookup } };
  const input = { messages: [{ role: 'user', content: question }] };
  for (const [search, status, expected] of [
    [() => null, 'empty', { found: false }],
    [() => { throw Error('internal details'); }, 'error', { error: 'memory_unavailable' }]
  ]) {
    const answer = await completeMemoryTurn(async ({ messages }) => {
      const last = messages.at(-1);
      if (last.role === 'user') return { toolCall: call };
      assert.deepEqual(JSON.parse(last.content), expected);
      return { text: '我还不能确认。' };
    }, input, liveSearchTool, search);
    assert.equal(answer.memoryTool.status, status);
    assert.equal(answer.memoryTool.bucketId, undefined);
    assert.equal(answer.memoryTool.excerpt, undefined);
  }
  let searches = 0;
  for (const invalid of [{ name: 'hold' }, { arguments: { query: ' ' } }, { arguments: { query: 'a'.repeat(401) } },
    { arguments: { query: lookup, endpoint: 'other' } }]) {
    await assert.rejects(completeMemoryTurn(async () => ({ toolCall: { ...call, ...invalid } }), input, liveSearchTool,
      () => { searches++; }), /outside this lab/);
  }
  assert.equal(searches, 0);
});

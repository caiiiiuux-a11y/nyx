import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { anniversaryQuestion, approvedExcerpt, createAnniversaryTrial } from './anniversary-trial.mjs';
import { createLiveRoutes } from './live-routes.mjs';

const thread = '10000000-aaaa-aaaa-aaaa-100000000000';
const model = 'gemini-fixture';
const excerpt = '虚构小镇在九月九日挂起了钟。';
const bucketId = 'ab12cd34ef56';
const selection = { bucketId, length: excerpt.length, sha256: createHash('sha256').update(excerpt).digest('hex') };
const raw = '[bucket_id:' + bucketId + ']\n旁边的文字。' + excerpt + '另一段私人记录。\n👣 Footprint：示例';

test('a live excerpt needs the selected direct bucket and the exact digest of its current text', () => {
  assert.deepEqual(approvedExcerpt(raw, selection), { bucketId, excerpt });
  for (const other of [raw.replace(bucketId, 'other'), raw.replace('挂起', '摘下'), '[联想浮现·非检索命中] ' + raw,
    '[bucket_id:' + bucketId + ']\n正文\n👣 Footprint：' + excerpt]) assert.equal(approvedExcerpt(other, selection), null);
});

test('a private lookup is limited to the approved question, window and model and sends only the verified excerpt', async () => {
  const lookups = [], sent = [];
  const trial = createAnniversaryTrial(thread, 'http://127.0.0.1:8002', selection, async (_, query) => {
    lookups.push(query); return approvedExcerpt(raw, selection);
  });
  const routes = createLiveRoutes({ baseURL: 'https://fixture.example', model, apiKey: 'synthetic-key', memoryTrial: { ...trial, model },
    async fetchImpl(_, opts) {
      const payload = JSON.parse(opts.body);
      sent.push(payload);
      const searching = Boolean(payload.tools) && payload.tool_choice !== 'none';
      const delta = searching ? { tool_calls: [{ index: 0, id: 'fixture-call', type: 'function',
        function: { name: 'memory_search', arguments: '{"query":"纪念日"}' } }] } : { content: '回复' };
      return new Response('data: ' + JSON.stringify({ choices: [{delta, finish_reason: searching ? 'tool_calls' : 'stop'}] }) +
        '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    } });
  const system = { role: 'system', content: '房间规则' };
  const current = { role: 'user', content: anniversaryQuestion };
  const request = { model, thread, route: 'gemini', messages: [system, {role:'user',content:'旧窗口内容'},
    {role:'assistant',content:'较早的回复'}, current], archive: { hits: [{ text:'旧聊天摘录' }] } };
  const answer = await routes.complete(request);
  assert.deepEqual(sent[0].messages, [system, current]);
  assert.doesNotMatch(JSON.stringify(sent[0]), /虚构小镇|ab12cd34ef56/);
  assert.doesNotMatch(JSON.stringify(sent[1]), /私人记录|旧聊天摘录|较早的回复/);
  assert.deepEqual(JSON.parse(sent[1].messages.at(-1).content), { found: true, bucketId, excerpt });
  assert.equal(answer.memoryTool.scope, 'personal');
  assert.deepEqual(answer.archiveHits, []);
  await trial.search('纪念日');
  assert.deepEqual(lookups, ['纪念日']);
  assert.throws(() => trial.search('其他事情'), /Outside/);
  await routes.complete({ ...request, thread: 'unapproved' });
  assert.equal(sent.at(-1).tools, undefined);
  await routes.complete({ ...request, messages: [system, { role: 'user', content: '另一个问题' }] });
  assert.equal(sent.at(-1).tools, undefined);
});

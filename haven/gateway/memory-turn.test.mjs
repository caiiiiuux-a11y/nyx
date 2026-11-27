import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { memoryLabExample as example } from '../room/memory-lab-example.mjs';
import { generateMockReply } from './model.mjs';
import { openStore } from './store.mjs';

test('a saved hold receipt survives a lost final answer and is reused on regeneration', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'haven-lab-turn-'));
  const filename = join(directory, 'chat.sqlite');
  const events = [];
  const memoryLab = { async callTool(name, args) {
    events.push([name, args]);
    if (name === 'hold') return { text: '新建→test-bucket', bucketId: 'test-bucket' };
    return name === 'dream' ? { text: '来自梦的回执：' + example.fact, bucketId: 'test-bucket' } : { text: '没有命中' };
  } };
  let store = openStore(filename, { memoryLab, complete(request, options) {
    if (request.messages.at(-1).role === 'tool') throw new Error('lost final response');
    return generateMockReply(request, options);
  } });
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const hold = { requestId: 'hold', text: example.hold };
  await assert.rejects(() => store.send(hold), /已保存/u);
  store.close();
  const requests = [];
  store = openStore(filename, { memoryLab, complete(request, options) {
    requests.push(request);
    return generateMockReply(request, options);
  } });
  const answer = (await store.send(hold)).messages[1];
  assert.equal(answer.meta.memoryTool.status, 'ok');
  assert.equal(answer.meta.memoryTool.sourceMessageId, 1);
  assert.match(answer.text, /已.*记进/u);
  assert.equal(store.evidence({ memoryId: 'test-bucket' }).sources[0].text, example.hold);
  await store.regenerate({ id: answer.id, requestId: 'reroll' });
  const search = (await store.send({ requestId: 'search', text: example.search })).messages[1];
  assert.match(search.text, /没有查到/u);
  assert.ok(!search.text.includes(example.fact));
  assert.deepEqual(requests.at(-1).messages.map(m => m.role), ['user', 'assistant', 'tool']);
  const dream = (await store.send({ requestId: 'dream', text: example.dream })).messages[1];
  assert.ok(dream.text.includes(example.fact));
  assert.equal(dream.meta.sourceRefs[0].messageId, answer.meta.memoryTool.sourceMessageId);
  assert.deepEqual(events, [['hold', { content: example.fact }], ['breath_search', { query: example.keyword }], ['dream', {}]]);
});

test('only the three exact unquoted examples can invoke tools, and failed writes are never replayed', async t => {
  let writes = 0;
  const store = openStore(':memory:', { memoryLab: { async callTool() {
    writes++;
    throw new Error('lost connection');
  } } });
  t.after(() => store.close());
  const unrelated = await store.send({ requestId: 'unrelated', text: '记下合成记忆：任意输入' });
  assert.equal(unrelated.messages[1].meta.memoryTool, undefined);
  await store.send({ requestId: 'quote', text: example.hold, quote: { id: 1, who: 'Iris', text: '引用内容' } });
  assert.equal(writes, 0);
  const hold = await store.send({ requestId: 'hold', text: example.hold });
  assert.equal(hold.messages[1].meta.memoryTool.status, 'uncertain');
  const reroll = await store.regenerate({ requestId: 'again', id: hold.messages[1].id });
  assert.equal(reroll.message.meta.memoryTool.status, 'uncertain');
  assert.equal(writes, 1);
});

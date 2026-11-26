import assert from 'node:assert/strict';
import test from 'node:test';
import { generateMockReply } from './model.mjs';
import { openStore } from './store.mjs';

test('an explicit chat lookup passes cited evidence beyond the recent window and respects the historical cutoff', async t => {
  const requests = [];
  let embeddings = 0;
  const store = openStore(':memory:', {
    embedder: {
      identity: 'test-only/archive',
      async embed(texts) {
        embeddings++;
        return texts.map(text => /蓝色车票|留着的票根/u.test(text) ? [1, 0] : [0, 1]);
      }
    },
    complete(request) { requests.push(request); return generateMockReply(request); }
  });
  t.after(() => store.close());
  const send = (id, text) => store.send({ requestId: id, text });
  const first = await send('ticket', '相册第二页夹着蓝色车票。');
  for (let i = 0; i < 13; i++) await send('other-' + i, '浇花记录 ' + i);
  assert.equal(embeddings, 0);
  const { messages } = await send('search', '帮我查旧聊天：留着的票根');
  const request = requests.at(-1);
  const ref = messages[1].meta.sourceRefs.find(source => source.messageId === first.messages[0].id);
  assert.ok(embeddings > 0);
  assert.ok(ref);
  assert.ok(request.archive.hits.length);
  assert.ok(!request.messages.some(message => message.content.includes('蓝色车票')));
  assert.ok(messages[1].text.includes(ref.excerpt));
  assert.equal(store.readArchiveSource({ messageId: ref.messageId }).message.text.slice(ref.start, ref.end), ref.excerpt);
  const repeated = await send('same-question', '查旧聊天：留着的票根');
  assert.deepEqual(repeated.messages[1].meta.sourceRefs.map(source => source.messageId), [first.messages[0].id]);
  const direct = await store.searchArchive({ query: '留着的票根' });
  assert.deepEqual(direct.hits.map(hit => hit.messageId), [first.messages[0].id]);
  await send('future', '蓝色车票在未来的那一页。');
  await store.regenerate({ requestId: 'regenerate-search', id: messages[1].id });
  assert.ok(requests.at(-1).archive.hits.every(hit => hit.messageId < messages[0].id));
});

test('memory bindings are atomic, idempotent and retain the cited reply after regeneration', async t => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  const { messages } = await store.send({ requestId: 'start', text: '去窗边吧。' });
  const memoryId = 'scene:test-window';
  const messageId = messages[1].id;
  assert.throws(() => store.bindEvidence({ memoryId, messageIds: [messageId, 201] }));
  assert.deepEqual(store.evidence({ memoryId }).sources, []);
  const bound = store.bindEvidence({ memoryId, messageIds: [messageId] });
  assert.equal(bound.sources[0].changed, false);
  assert.deepEqual(store.bindEvidence({ memoryId, messageIds: [messageId, messageId] }), bound);
  const rerolled = await store.regenerate({ requestId: 'reroll', id: messageId });
  assert.notEqual(rerolled.message.text, messages[1].text);
  const [proof] = store.evidence({ memoryId }).sources;
  assert.equal(proof.text, messages[1].text);
  assert.equal(proof.changed, true);
});

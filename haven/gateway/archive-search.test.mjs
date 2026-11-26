import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createArchiveSearch, createLocalEmbedder } from './archive-search.mjs';

const first = '想给我们的聊天留个自己的地方。';
const boxes = '周六搬家，先把书装箱。';
const question = '最早为什么想给对话安个家？';
const line = (id, text, thread = 'window') => ({
  id, text, from: 'human', ts: '2026-01-15T13:00:00Z', meta: { thread }
});
function database(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  return db;
}

test('hybrid search recovers a paraphrase, scopes evidence and reuses only the current passages and model', async t => {
  const messages = [line(1, first), line(2, boxes), line(3, first, 'elsewhere'), line(4, first)];
  const batches = [];
  const embedder = {
    identity: 'synthetic-fixture-a',
    async embed(input) {
      batches.push(input);
      return input.map(text => [first, question].includes(text) ? [1, 0] : [0, 1]);
    }
  };
  const db = database(t);
  const archive = createArchiveSearch(db, { embedder, readMessages: () => messages });
  const search = () => archive.search({ query: question, beforeId: 4 });
  const raw = await search();
  assert.equal(raw.mode, 'hybrid');
  assert.deepEqual(raw.hits.map(x => x.messageId), [1]);
  assert.equal(raw.hits[0].text, messages[0].text.slice(raw.hits[0].start, raw.hits[0].end));
  assert.deepEqual(raw.hits[0].context.map(x => x.id), [2]);
  assert.deepEqual(batches, [[question], [first, boxes]]);
  await search();
  assert.deepEqual(batches.slice(2), [[question]]);
  messages[0].text = '改写后的测试内容。';
  assert.deepEqual((await search()).hits, []);
  assert.deepEqual(batches.at(-1), [messages[0].text]);
  embedder.identity = 'synthetic-fixture-b';
  await search();
  assert.deepEqual(batches.at(-1), [messages[0].text, boxes]);
});

test('when offline, literal matches still cite the exact raw slice, with no fabricated vectors', async t => {
  const db = database(t);
  const message = line(1, '纸'.repeat(970) + boxes);
  const archive = createArchiveSearch(db, {
    embedder: { identity: 'offline', async embed() { throw new Error('offline'); } },
    readMessages: () => [message]
  });
  const result = await archive.search({ query: '把书装箱' });
  assert.equal(result.mode, 'lexical');
  assert.ok(result.notice);
  assert.ok(result.hits[0].start > 0);
  assert.equal(result.hits[0].text, message.text.slice(result.hits[0].start, result.hits[0].end));
  assert.equal((await archive.search({ query: question })).hits.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM archive_passage_vectors').get().n, 0);
  assert.throws(() => createLocalEmbedder({ url: 'https://example.org/v1/embeddings', container: '' }));
});

test('a hit edited during asynchronous indexing carries no stale quote', async t => {
  const message = line(1, first);
  const archive = createArchiveSearch(database(t), {
    readMessages: () => [message],
    embedder: { identity: 'fixture', async embed(texts) {
      if (texts.includes(first)) message.text = boxes;
      return texts.map(() => [1, 0]);
    } }
  });
  assert.deepEqual((await archive.search({ query: question })).hits, []);
});

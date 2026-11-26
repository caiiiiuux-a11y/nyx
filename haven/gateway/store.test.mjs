import assert from 'node:assert/strict';
import { mkdtemp, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openStore } from './store.mjs';

test('retry after a provider failure and restart reuses the saved turn and sends the right history', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'haven-chat-test-'));
  const filename = join(directory, 'test.sqlite');
  const first = { requestId: 'first', text: '我们读到第 43 页了。', model: '月桂' };
  let store = openStore(filename, { complete: async () => { throw new Error('test offline'); } });
  t.after(async () => {
    store.close();
    await Promise.all(['', '-wal', '-shm'].map(suffix => rm(filename + suffix, { force: true })));
    await rmdir(directory);
  });
  await assert.rejects(() => store.send(first));
  const interrupted = await store.history();
  assert.deepEqual(interrupted.messages.map(m => m.text), [first.text]);
  store.close();

  const received = [];
  store = openStore(filename, {
    async complete(request) {
      received.push(request);
      return { text: `测试回复 ${received.length}` };
    }
  });
  const completed = await Promise.all([store.send(first), store.send(first)]);
  assert.deepEqual(completed[0], completed[1]);
  assert.equal(received.length, 1);
  assert.equal(completed[0].messages[1].meta.model, '月桂');
  await store.send({ requestId: 'next', text: '读到哪一页了？', model: '云杉' });
  assert.equal(received[1].model, '云杉');
  assert.deepEqual(received[1].messages.slice(1), [
    { role: 'user', content: first.text },
    { role: 'assistant', content: '测试回复 1' },
    { role: 'user', content: '读到哪一页了？' }
  ]);
  const answerId = completed[0].messages[1].id;
  await store.regenerate({ requestId: 'retry-first', id: answerId, model: '月桂' });
  assert.deepEqual(received[2].messages.slice(1), [{ role: 'user', content: first.text }]);
  assert.equal((await store.history()).messages.length, 4);
});

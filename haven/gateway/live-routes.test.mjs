import assert from 'node:assert/strict';
import test from 'node:test';
import { createLiveRoutes } from './live-routes.mjs';
import { openStore } from './store.mjs';

test('a rejected old credential cannot clear its replacement or switch the saved model', async t => {
  let release, received;
  const arrived = new Promise(resolve => { received = resolve; });
  const failing = new Promise(resolve => { release = resolve; });
  const attempts = [];
  const routes = createLiveRoutes({
    baseURL: 'http://127.0.0.1/v1',
    async fetchImpl(url, { headers, body }) {
      attempts.push({ url: url.href, key: headers.Authorization, body: JSON.parse(body) });
      if (attempts.length === 1) { received(); await failing; }
      return new Response('upstream error deliberately hidden', { status: 401 });
    }
  });
  const store = openStore(':memory:', { models: routes.models, archiveRecall: false, resumePendingOnRead: false, complete: routes.complete });
  t.after(() => store.close());
  assert.equal(routes.status(store).route, 'mock');
  assert.throws(() => routes.select(store, { route: 'gemini' }), { status: 400 });
  const { model } = routes.select(store, { route: 'gemini', apiKey: 'old-fixture' });
  const draft = { text: '合成测试', requestId: 'test-live-401', model };
  const pending = store.send(draft);
  await arrived;
  const status = routes.select(store, { route: 'gemini', apiKey: 'replacement-fixture' });
  assert.ok(!JSON.stringify(status).includes('fixture'));
  release();
  await assert.rejects(pending, { status: 401 });
  assert.ok(routes.status(store).hasKey);
  assert.equal((await store.history()).messages.length, 1);
  assert.equal(attempts.length, 1);
  await assert.rejects(store.send(draft), { status: 401 });
  assert.deepEqual(attempts.map(item => item.key), ['Bearer old-fixture', 'Bearer replacement-fixture']);
  assert.ok(attempts.every(item => item.url === 'http://127.0.0.1/v1/chat/completions' && !item.body.tools));
  assert.equal(routes.status(store).hasKey, false);
  assert.equal(routes.status(store).model, model);
  routes.select(store, { route: 'mock' });
  const local = await store.send({ text: '本机模拟', requestId: 'test-live-mock' });
  assert.equal(local.messages[1].meta.provider, 'mock');
  assert.equal(attempts.length, 2);
});

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createLiveRoutes } from './live-routes.mjs';
import { openStore } from './store.mjs';

test('a rejected old credential cannot clear its replacement or switch the saved model', async t => {
  let release, received;
  const arrived = new Promise(resolve => { received = resolve; });
  const failing = new Promise(resolve => { release = resolve; });
  const attempts = [];
  const routes = createLiveRoutes({
    baseURL: 'http://127.0.0.1/v1', model: 'gemini-fixture',
    async fetchImpl(url, { headers, body }) {
      attempts.push({ url: url.href, key: headers.Authorization, body: JSON.parse(body) });
      if (attempts.length === 1) { received(); await failing; }
      return new Response('upstream error deliberately hidden', { status: 401 });
    }
  });
  const store = openStore(':memory:', { models: routes.active('mock').models,
    modelsForRoute: id => routes.active(id).models, archiveRecall: false, resumePendingOnRead: false, complete: routes.complete });
  t.after(() => store.close());
  assert.equal(routes.status(store).route, 'mock');
  assert.throws(() => routes.select(store, { route: 'gemini' }), { status: 400 });
  const { model } = routes.select(store, { route: 'gemini', apiKey: 'old-fixture' });
  const draft = { text: '合成测试', requestId: 'test-live-401', model };
  const pending = store.send(draft);
  await arrived;
  const status = routes.select(store, { route: 'gemini', apiKey: 'replacement-fixture' });
  assert.ok(!JSON.stringify(status).includes('replacement-fixture'));
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

test('profiles discover full catalogs, keep duplicate model names scoped, persist metadata and drop keys on restart', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'haven-catalog-'));
  const profileFile = join(dir, 'providers.json');
  const calls = [];
  let empty = false;
  const fetchImpl = async (url, options) => {
    calls.push({ url: url.href, key: options.headers.Authorization });
    assert.equal(options.redirect, 'error');
    if (options.headers.Authorization === 'Bearer wrong-fixture-key') return new Response(null, { status: 401 });
    const list = empty ? [] : ['shared', 'other/provider:free', '图像 [预览]', ...Array.from({length: 130}, (_, i) => 'custom-' + i)];
    if (!empty && !url.searchParams.has('after')) {
      return Response.json({ data: list.map(id => ({ id })), last_id: list.at(-1), has_more: true });
    }
    return Response.json({ data: empty ? [] : [{ id: 'shared' }, { id: 'last model' }] });
  };
  let routes = createLiveRoutes({ profileFile, fetchImpl });
  const store = openStore(join(dir, 'synthetic.sqlite'), { models: routes.active('mock').models,
    modelsForRoute: id => routes.active(id).models, archiveRecall: false, resumePendingOnRead: false });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.deepEqual(routes.status(store).routes.map(route => route.id), ['mock']);
  const a = await routes.add(store, { label: '线路 A', baseURL: 'https://a.example/v1', apiKey: 'fixture-secret-a' });
  const b = await routes.add(store, { label: '线路 B', baseURL: 'http://127.0.0.1:8765/v1' });
  assert.equal(a.route, 'mock');
  assert.equal(routes.active(a.addedRoute).models.length, 134);
  assert.ok(routes.active(a.addedRoute).models.includes('图像 [预览]'));
  assert.equal(routes.active(b.addedRoute).requiresKey, false);
  assert.ok(calls.filter(c => c.url.startsWith('https://a.')).every(c => c.key === 'Bearer fixture-secret-a'));
  assert.ok(calls.filter(c => c.url.startsWith('http://127.')).every(c => c.key === undefined));
  const chosen = routes.select(store, { route: a.addedRoute, model: 'shared' });
  assert.equal(chosen.route, a.addedRoute);
  await assert.rejects(routes.refresh(store, { route: a.addedRoute, apiKey: 'wrong-fixture-key' }), {status: 401});
  assert.equal(routes.active(a.addedRoute).hasKey, true);
  assert.equal(routes.active(a.addedRoute).models.length, 134);
  empty = true;
  await routes.refresh(store, { route: b.addedRoute });
  assert.deepEqual(routes.active(b.addedRoute).models, []);
  assert.equal(routes.status(store).model, 'shared');
  assert.ok(!readFileSync(profileFile, 'utf8').includes('fixture-secret-a'));
  routes = createLiveRoutes({ profileFile, fetchImpl });
  assert.equal(routes.status(store).route, a.addedRoute);
  assert.equal(routes.active(a.addedRoute).models.length, 134);
  assert.equal(routes.active(a.addedRoute).hasKey, false);
});

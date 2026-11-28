import assert from 'node:assert/strict';
import test from 'node:test';
import { createOmbreBuckets } from './ombre-buckets.mjs';

const origin = 'http://127.0.0.1:18700';
const session = 'ombre_session=drawer-test';
const params = values => new URLSearchParams(values);

function dashboard() {
  const notes = new Map();
  for (let i = 1; i <= 14; i++) {
    notes.set('id-' + i, { name: '合成记忆 ' + i, tags: ['星星'], pinned: false, content_preview: '一枚书签' });
  }
  notes.set('旧 纸条', { name: '合成的旧纸条', tags: '示例, 纸', pinned: 'yes', protected: false,
    importance: 10, content_preview: '桌上的小灯', created: '2026-01-02' });
  notes.set('archived', { name: '合成归档', type: 'archived' });
  notes.set('deleted', { name: '合成删除', tombstone: '1' });
  const requests = [];
  const adapter = createOmbreBuckets(origin, { async fetchImpl(url, options) {
    requests.push({ path: url.pathname, method: options.method });
    assert.equal(url.origin, origin);
    assert.deepEqual(Object.keys(options.headers).sort(), options.body ? ['Accept', 'Content-Type', 'Cookie'] : ['Accept', 'Cookie']);
    assert.equal(options.redirect, 'error');
    if (options.headers.Cookie !== session) return Response.json({}, { status: 401 });
    if (url.pathname === '/api/buckets') {
      assert.equal(url.searchParams.get('sort'), 'created_desc');
      return Response.json(Array.from(notes, ([id, metadata]) => ({ id, ...metadata })));
    }
    if (url.pathname === '/api/network') {
      assert.equal(url.searchParams.get('mode'), 'concept');
      return Response.json({ nodes: [
        { id: 'stars', label: '星星', buckets: [...notes.keys()], kind: 'mixed', anchor: true },
        { id: 'lamp', label: '灯', buckets: ['旧 纸条', 'id-3', 'archived'], kind: 'wiki' },
        { id: 'out', label: '已移走', buckets: ['archived', 'deleted'], kind: 'tag' },
      ], edges: [{ source: 'lamp', target: 'stars', weight: 3 }, { source: 'out', target: 'stars' }] });
    }
    const [, , type, encodedId, operation] = url.pathname.split('/');
    assert.equal(type, 'bucket');
    const id = decodeURIComponent(encodedId);
    const metadata = notes.get(id);
    if (!metadata) return Response.json({}, { status: 404 });
    if (operation) {
      assert.equal(operation, 'edit');
      assert.equal(options.method, 'POST');
      Object.assign(metadata, JSON.parse(options.body));
      return Response.json({ id, ok: true });
    }
    return Response.json({ id, metadata, content: '原文中的[[小灯]]', display_content: '原文中的小灯' });
  } });
  return { adapter, requests, notes };
}

test('the drawer requires the local Ombre session and expires with that session', async () => {
  const { adapter, requests } = dashboard();
  await assert.rejects(adapter.list(''), { status: 401 });
  assert.equal(requests.length, 0);
  await assert.rejects(adapter.list('ombre_session=expired'), { status: 401 });
  assert.equal(requests.length, 1);
  assert.throws(() => createOmbreBuckets('https://example.com'));
});

test('list paginates visible buckets, searches previews and tags, and opens legacy IDs', async () => {
  const { adapter } = dashboard();
  assert.equal((await adapter.list(session, params({ pageSize: '5', page: '2' }))).buckets[0].id, 'id-6');
  const paper = await adapter.list(session, params({ q: '小灯', pinned: '1' }));
  assert.equal(paper.total, 1);
  assert.deepEqual(paper.buckets[0].tags, ['示例', '纸']);
  assert.equal((await adapter.list(session, params({ q: '纸' }))).total, 1);
  assert.equal((await adapter.detail(session, paper.buckets[0].id)).bucket.content, '原文中的小灯');
  await assert.rejects(adapter.detail(session, 'deleted'), { status: 404 });
  await assert.rejects(adapter.detail(session, '../'), { status: 400 });
  assert.equal((await adapter.detail(session, 'archived')).canPin, false);
});

test('concept graph and all its pages reference active visible buckets with shared weights', async () => {
  const { adapter } = dashboard();
  const network = await adapter.network(session);
  assert.deepEqual(network.nodes.map(({id, freq, kind, anchor}) => ({id, freq, kind, anchor})), [
    { id: 'stars', freq: 15, kind: 'mixed', anchor: true }, { id: 'lamp', freq: 2, kind: 'wiki', anchor: false }
  ]);
  assert.deepEqual(network.edges, [{ source: 'lamp', target: 'stars', weight: 2 }]);
  const lastPage = await adapter.list(session, params({concept: 'stars', page: '2', pageSize: '12'}));
  assert.equal(lastPage.total, 15);
  assert.deepEqual(lastPage.buckets.map(row => row.id), ['id-13','id-14','旧 纸条']);
  assert.equal((await adapter.list(session, params({concept: 'out'}))).total, 0);
});

test('pin changes are explicit, reread from Ombre, and retries never toggle them back', async () => {
  const { adapter, requests, notes } = dashboard();
  const writes = () => requests.filter(request => request.method === 'POST').length;
  await assert.rejects(adapter.pin(session, '旧 纸条', {pinned: false}), {status: 400});
  assert.equal(writes(), 0);
  const result = await adapter.pin(session, '旧 纸条', {pinned: false, importance: 6});
  assert.equal(result.bucket.pinned, false);
  assert.equal(result.bucket.importance, 6);
  assert.match(requests.at(-1).path, /\/api\/bucket\//);
  assert.equal(requests.at(-1).method, 'GET');
  await adapter.pin(session, '旧 纸条', {pinned: false, importance: 6});
  assert.equal(writes(), 1);
  assert.equal((await adapter.pin(session, '旧 纸条', {pinned: true})).bucket.pinned, true);
  notes.get('旧 纸条').protected = true;
  await assert.rejects(adapter.pin(session, '旧 纸条', {pinned: false, importance: 2}), {status: 409});
  assert.equal((await adapter.pin(session, '旧 纸条', {pinned: false})).bucket.pinned, false);
  await assert.rejects(adapter.pin(session, 'archived', {pinned: true}), {status: 409});
});

import { createMemoryGraph } from './adrian-graph.js';

const byId = id => document.getElementById(id);
const localDrawer = document.documentElement.dataset.memoryDrawer === 'local';
const graph = createMemoryGraph({ onSelect: selectConcept });
let view = 'buckets';
let pinned = false;
let page = 1;
let concept = null;
let entryId = null;
let entry = null;
let requestNumber = 0;
let reader;
let pendingWrite = Promise.resolve();

for (let value = 1; value <= 10; value++) byId('importance').add(new Option(String(value), String(value)));

function clearRows() {
  byId('bucket-list').replaceChildren();
  byId('list-status').textContent = '';
  byId('page-number').textContent = '';
  byId('pagination').hidden = true;
}

function clearEntry() {
  entry = null;
  byId('entry').hidden = true;
  byId('entry-title').textContent = '';
  byId('entry-meta').textContent = '';
  byId('entry-content').textContent = '';
  byId('entry-status').textContent = '';
  byId('unpin-form').hidden = true;
  byId('pin-entry').hidden = true;
}

function clearView() {
  clearRows();
  clearEntry();
  concept = null;
  entryId = null;
  graph.clear();
  byId('shelf').hidden = true;
  byId('graph').hidden = true;
  byId('sign-in').hidden = true;
  byId('drawer-status').textContent = '';
}

// A late response from an earlier page or from a closed drawer must not repaint it.
function invalidate() {
  reader?.abort();
  reader = null;
  return ++requestNumber;
}

async function fetchMemory(path, signal, body) {
  const options = {
    headers: { Accept: 'application/json', 'X-Haven-Drawer': '1' },
    credentials: 'same-origin', cache: 'no-store', mode: 'same-origin', redirect: 'error', signal
  };
  if (body) {
    options.method = 'POST';
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await fetch('/app/memory/' + path, options);
  const result = await response.json().catch(() => null);
  if (!response.ok || !result) {
    const error = new Error(result?.error || '记忆抽屉暂时无法读取，请刷新重试。');
    error.status = response.status;
    throw error;
  }
  return result;
}

async function load(path, apply, { body, onError } = {}) {
  if (!localDrawer) return;
  const number = invalidate();
  byId('drawer-status').textContent = body ? '正在保存…' : '正在读取…';
  byId('sign-in').hidden = true;
  // Let a pin operation finish even if the user moves on. The next read sees the saved state.
  const previousWrite = pendingWrite;
  const signal = body ? undefined : (reader = new AbortController()).signal;
  const work = previousWrite.then(() => fetchMemory(path, signal, body));
  if (body) pendingWrite = work.then(() => {}, () => {});
  try {
    const result = await work;
    if (number !== requestNumber) return;
    byId('drawer-status').textContent = '';
    apply(result);
  } catch (error) {
    if (number !== requestNumber) return;
    if (error.status === 401 || error.status === 403) {
      clearView();
      byId('search').value = '';
      byId('sign-in').hidden = error.status !== 401;
    } else {
      onError?.(error);
    }
    byId('drawer-status').textContent = error.status ? error.message : '暂时连不上记忆抽屉，请刷新重试。';
  }
}

function changeView(next) {
  invalidate();
  clearView();
  page = 1;
  view = next;
  byId('show-buckets').setAttribute('aria-pressed', String(view === 'buckets'));
  byId('show-graph').setAttribute('aria-pressed', String(view === 'graph'));
  if (view === 'buckets') return showList();
  load('network', data => {
    byId('graph').hidden = false;
    graph.setData(data);
  });
}

function selectConcept(node) {
  if (view !== 'graph' || byId('graph').hidden) return;
  invalidate();
  concept = node;
  page = 1;
  clearRows();
  byId('drawer-status').textContent = '';
  byId('shelf').hidden = !node;
  if (node) showList();
}

function appendText(parent, className, value) {
  if (!value) return;
  const span = document.createElement('span');
  span.className = className;
  span.textContent = value;
  parent.append(span);
}

function metadata(bucket) {
  const tags = bucket.tags.map(tag => '#' + tag).join(' ');
  return [bucket.pinned ? '已钉选' : '', tags, bucket.updatedAt?.slice(0, 10)].filter(Boolean).join(' · ');
}

function showList(focusId) {
  const inGraph = view === 'graph';
  entryId = null;
  clearEntry();
  clearRows();
  byId('shelf').hidden = false;
  byId('graph').hidden = !inGraph;
  byId('search-form').hidden = inGraph;
  document.querySelector('.shelf-tools').hidden = inGraph;
  byId('all').setAttribute('aria-pressed', String(!pinned));
  byId('pinned').setAttribute('aria-pressed', String(pinned));
  const params = new URLSearchParams({ page: String(page), pageSize: '12' });
  if (inGraph) {
    if (!concept) { byId('shelf').hidden = true; return; }
    params.set('concept', concept.id);
    graph.redraw();
  } else {
    if (pinned) params.set('pinned', '1');
    const query = byId('search').value.trim();
    if (query) params.set('q', query);
  }
  load('buckets?' + params, result => {
    page = result.page;
    byId('list-status').textContent = result.total ? result.total + ' 条记忆' : '没有找到记忆。';
    for (const bucket of result.buckets) {
      const row = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      appendText(button, 'bucket-title', bucket.title);
      appendText(button, 'bucket-excerpt', bucket.excerpt);
      appendText(button, 'bucket-meta', metadata(bucket));
      button.addEventListener('click', () => showEntry(bucket.id));
      row.append(button);
      byId('bucket-list').append(row);
      if (bucket.id === focusId) button.focus();
    }
    const pages = Math.ceil(result.total / result.pageSize);
    byId('pagination').hidden = pages <= 1;
    byId('previous').disabled = page <= 1;
    byId('next').disabled = page >= pages;
    byId('page-number').textContent = page + ' / ' + pages;
  });
}

function displayEntry(result) {
  entry = result.bucket;
  byId('entry-title').textContent = entry.title;
  byId('entry-meta').textContent = metadata(entry);
  byId('entry-content').textContent = entry.content;
  byId('pin-entry').hidden = !result.canPin;
  byId('pin-entry').disabled = false;
  byId('pin-entry').textContent = entry.pinned ? '取消钉选' : '钉选';
  byId('pin-entry').setAttribute('aria-pressed', String(entry.pinned));
  byId('unpin-form').hidden = true;
  byId('importance').value = String(entry.importance);
}

function showEntry(id) {
  clearRows();
  clearEntry();
  entryId = id;
  byId('graph').hidden = true;
  byId('shelf').hidden = true;
  byId('entry').hidden = false;
  byId('back-list').textContent = view === 'graph' ? '‹ 返回星图' : '‹ 记忆目录';
  load('buckets/' + encodeURIComponent(id), result => {
    displayEntry(result);
    byId('entry-title').focus();
  });
}

function savePin(body) {
  byId('unpin-form').hidden = true;
  byId('pin-entry').disabled = true;
  byId('entry-status').textContent = '';
  load('buckets/' + encodeURIComponent(entryId) + '/pin', result => {
    displayEntry(result);
    byId('entry-status').textContent = result.bucket.pinned ? '已钉选。' : '已取消钉选。';
  }, { body, onError: () => { byId('pin-entry').disabled = false; } });
}

byId('show-buckets').addEventListener('click', () => changeView('buckets'));
byId('show-graph').addEventListener('click', () => changeView('graph'));
byId('refresh').addEventListener('click', () => {
  if (entryId) return showEntry(entryId);
  if (view === 'graph') return changeView('graph');
  showList();
});
byId('search-form').addEventListener('submit', event => {
  event.preventDefault();
  page = 1;
  showList();
});
for (const filter of ['all', 'pinned']) byId(filter).addEventListener('click', () => {
  pinned = filter === 'pinned';
  page = 1;
  showList();
});
byId('previous').addEventListener('click', () => { page--; showList(); });
byId('next').addEventListener('click', () => { page++; showList(); });
byId('back-list').addEventListener('click', () => showList(entryId));
byId('pin-entry').addEventListener('click', () => {
  if (!entry) return;
  if (!entry.pinned || entry.protected) return savePin({ pinned: !entry.pinned });
  byId('unpin-form').hidden = false;
  byId('importance').focus();
});
byId('cancel-unpin').addEventListener('click', () => {
  byId('unpin-form').hidden = true;
  byId('pin-entry').focus();
});
byId('unpin-form').addEventListener('submit', event => {
  event.preventDefault();
  if (entry?.pinned) savePin({ pinned: false, importance: Number(byId('importance').value) });
});
byId('private-notice').hidden = localDrawer;
byId('drawer-tools').hidden = !localDrawer;
if (localDrawer) {
  changeView('buckets');
  window.addEventListener('pagehide', () => {
    invalidate();
    clearView();
    byId('search').value = '';
    pinned = false;
  });
  // A history restore must check the current Ombre session before showing memories again.
  window.addEventListener('pageshow', event => {
    if (event.persisted) changeView('buckets');
  });
}

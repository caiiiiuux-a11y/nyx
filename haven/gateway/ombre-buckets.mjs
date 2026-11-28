import { RequestError } from './store.mjs';

const listPath = '/api/buckets?sort=created_desc';
const missing = () => new RequestError(404, '这条记忆已移走或不存在。');
const invalidReply = () => new RequestError(502, 'Ombre 返回的记忆数据暂时无法读取。');
const text = value => typeof value === 'string' ? value : '';
const flag = value => value === true || value === 1 || /^(true|1|yes|on|y)$/i.test(text(value).trim());
const archived = meta => text(meta.type).trim().toLowerCase() === 'archived';
const deleted = meta => Boolean(meta.deleted_at) || flag(meta.tombstone);

function validId(id) {
  // Older imports can use readable names, including spaces, punctuation and non-Latin scripts.
  return typeof id === 'string' && id.trim() !== '' && id.length <= 256 && id.isWellFormed() &&
    id !== '.' && id !== '..' && !/[\/\\\x00-\x1f\x7f]/u.test(id);
}

function bucketPath(id) {
  if (!validId(id)) throw new RequestError(400, '记忆编号无效。');
  return '/api/bucket/' + encodeURIComponent(id);
}

function labels(value) {
  const parts = typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value : [];
  return [...new Set(parts.map(item => text(item).trim()).filter(Boolean))];
}

function summary(id, meta) {
  return { id, title: text(meta.title) || text(meta.name) || id, tags: labels(meta.tags), pinned: flag(meta.pinned),
    updatedAt: text(meta.updated_at) || text(meta.last_active) || text(meta.created) };
}

function positiveInteger(value, fallback, max) {
  if (value === null) return fallback;
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 1 || number > max) {
    throw new RequestError(400, '分页参数无效。');
  }
  return number;
}

export function createOmbreBuckets(origin, { fetchImpl = fetch } = {}) {
  if (!/^http:\/\/127\.0\.0\.1(?::[1-9]\d{0,4})?\/?$/.test(origin)) {
    throw new Error('Ombre 连接需要本机回环 HTTP 地址。');
  }
  const base = new URL(origin);

  async function request(cookie, path, body) {
    if (typeof cookie !== 'string' || !/^ombre_session=[A-Za-z0-9._~+/=-]+$/.test(cookie)) {
      throw new RequestError(401, '请先登录本机 Ombre，再回到抽屉刷新。');
    }
    const headers = { Accept: 'application/json', Cookie: cookie };
    if (body) headers['Content-Type'] = 'application/json';
    let response;
    try {
      response = await fetchImpl(new URL(path, base), { method: body ? 'POST' : 'GET', headers,
        ...(body && {body: JSON.stringify(body)}), redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000) });
      if (response.ok) return await response.json();
      if (response.status === 400 && body) {
        const reason = text((await response.json().catch(() => ({})))?.error);
        if (/pinned 桶已达上限/.test(reason)) throw new RequestError(409, 'Ombre 的钉选名额已满，请先取消其他钉选。');
      }
    } catch (error) {
      if (error instanceof RequestError) throw error;
      if (response?.ok && error instanceof SyntaxError) throw invalidReply();
      throw new RequestError(503, '暂时连不上本机 Ombre，请稍后刷新。');
    }
    if (response.status === 401) throw new RequestError(401, '请先登录本机 Ombre，再回到抽屉刷新。');
    if (response.status === 403) throw new RequestError(403, '当前 Ombre 会话没有这项权限。');
    if (response.status === 404) throw missing();
    if (response.status === 409) throw new RequestError(409, '这条记忆的状态已改变，请刷新后重试。');
    if (response.status === 429) throw new RequestError(429, 'Ombre 正忙，请稍后再试。');
    if (response.status === 400) throw new RequestError(400, 'Ombre 未接受这项修改，请核对记忆状态。');
    throw invalidReply();
  }

  async function visibleRows(cookie) {
    const rows = await request(cookie, listPath);
    if (!Array.isArray(rows)) throw invalidReply();
    return rows.filter(row => row && validId(row.id) && !deleted(row));
  }

  async function conceptGraph(cookie) {
    const graph = await request(cookie, '/api/network?mode=concept');
    if (!Array.isArray(graph?.nodes) || !Array.isArray(graph.edges)) throw invalidReply();
    return graph;
  }

  async function list(cookie, params = new URLSearchParams()) {
    const ids = params.getAll('id');
    const concept = params.get('concept');
    const q = (params.get('q') || '').trim().toLocaleLowerCase();
    if (ids.length > 12 || !ids.every(validId) || q.length > 500) throw new RequestError(400, '请缩小记忆筛选范围。');
    const pinOnly = params.get('pinned') === '1';
    const pageSize = positiveInteger(params.get('pageSize'), 20, 100);
    const requestedPage = positiveInteger(params.get('page'), 1, Number.MAX_SAFE_INTEGER);
    const [allRows, graph] = await Promise.all([visibleRows(cookie), concept === null ? null : conceptGraph(cookie)]);
    const members = graph && new Set(graph.nodes.find(node => node?.id === concept)?.buckets || []);
    const rows = allRows.filter(row => {
      if (members && (archived(row) || !members.has(row.id))) return false;
      if ((ids.length && !ids.includes(row.id)) || (pinOnly && !flag(row.pinned))) return false;
      if (!q) return true;
      return [row.title, row.name, row.content_preview, ...labels(row.tags), ...labels(row.domain)]
        .some(value => text(value).toLocaleLowerCase().includes(q));
    });
    const page = Math.min(requestedPage, Math.max(1, Math.ceil(rows.length / pageSize)));
    const start = (page - 1) * pageSize;
    const buckets = rows.slice(start, start + pageSize).map(row => ({
      ...summary(row.id, row), excerpt: text(row.content_preview)
    }));
    return { buckets, total: rows.length, page, pageSize, canPin: true };
  }

  async function detail(cookie, id) {
    const value = await request(cookie, bucketPath(id));
    if (!value || value.id !== id || !value.metadata || typeof value.metadata !== 'object' ||
        typeof value.content !== 'string') throw invalidReply();
    const meta = value.metadata;
    if (deleted(meta)) throw missing();
    const importance = Number(meta.importance);
    return { bucket: { ...summary(id, meta), content: typeof value.display_content === 'string' ? value.display_content : value.content,
      protected: flag(meta.protected), importance: Number.isInteger(importance) && importance >= 1 && importance <= 10 ? importance : 5 },
      canPin: !archived(meta) };
  }

  async function pin(cookie, id, input) {
    if (!input || typeof input.pinned !== 'boolean' || Object.keys(input).some(key => !['pinned', 'importance'].includes(key)) ||
        (input.importance !== undefined && (input.pinned || !Number.isInteger(input.importance) || input.importance < 1 || input.importance > 10))) {
      throw new RequestError(400, '请提供钉选状态，取消普通记忆的钉选时请选择 1 至 10 的重要度。');
    }
    const current = await detail(cookie, id);
    if (!current.canPin) throw new RequestError(409, '归档的记忆无法更改钉选。');
    if (current.bucket.pinned === input.pinned) return current;
    const body = { pinned: input.pinned };
    if (!body.pinned && !current.bucket.protected) {
      if (input.importance === undefined) throw new RequestError(400, '取消钉选时请选择 1 至 10 的重要度。');
      body.importance = input.importance;
    } else if (!body.pinned && input.importance !== undefined && input.importance !== current.bucket.importance) {
      throw new RequestError(409, '这条记忆受保护，重要度已锁定。');
    }
    const receipt = await request(cookie, bucketPath(id) + '/edit', body);
    if (!receipt?.ok || receipt.id !== id) throw invalidReply();
    const committed = await detail(cookie, id);
    if (committed.bucket.pinned !== input.pinned) throw new RequestError(409, '钉选状态已改变，请刷新后查看。');
    return committed;
  }

  async function network(cookie) {
    const [graph, rows] = await Promise.all([conceptGraph(cookie), visibleRows(cookie)]);
    const visible = new Set(rows.filter(row => !archived(row)).map(row => row.id));
    const memberships = new Map();
    const nodes = [];
    for (const node of graph.nodes) {
      if (!text(node?.id) || !text(node.label) || !Array.isArray(node.buckets) || memberships.has(node.id)) continue;
      const ids = new Set(node.buckets.filter(id => visible.has(id)));
      if (!ids.size) continue;
      memberships.set(node.id, ids);
      nodes.push({ id: node.id, label: node.label, buckets: [...ids], anchor: flag(node.anchor),
        kind: ['tag', 'wiki', 'mixed'].includes(node.kind) ? node.kind : 'wiki', freq: ids.size });
    }
    const edges = [];
    for (const edge of graph.edges) {
      const left = memberships.get(edge?.source);
      const right = memberships.get(edge?.target);
      if (!left || !right || left === right) continue;
      const weight = left.intersection(right).size;
      if (weight) edges.push({ source: edge.source, target: edge.target, weight });
    }
    return { nodes, edges };
  }
  return { list, detail, pin, network };
}

import { createHash } from 'node:crypto';
import { createDockerEmbedder } from './docker-embed.mjs';

const batchSize = 16;
const passageSize = 640;
const overlap = 80;
const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
const stopWords = new Set(['我们', '你们', '那个', '这个', '之前', '以前', '记得', '什么', '怎么', '时候', '一下', 'the', 'that', 'what', 'with']);

// Only explicitly local inference is supported. Never forward chat excerpts on a redirect.
export function createLocalEmbedder({
  url = process.env.HAVEN_EMBED_URL || 'http://127.0.0.1:11434/api/embed',
  model = process.env.HAVEN_EMBED_MODEL || 'bge-m3',
  container = process.env.HAVEN_EMBEDDING_CONTAINER
} = {}) {
  if (container) return createDockerEmbedder({ container, model });
  const endpoint = new URL(url);
  const ollama = endpoint.pathname === '/api/embed';
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname)
      || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      || (!ollama && endpoint.pathname !== '/v1/embeddings')) {
    throw new Error('向量服务须使用本机的 /api/embed 或 /v1/embeddings 地址');
  }
  let identity;
  const tagName = model.includes(':') ? model : model + ':latest';
  return {
    get identity() { return identity; },
    async embed(input) {
      let digest;
      if (ollama) {
        const tags = await fetch(new URL('/api/tags', endpoint), { redirect: 'error', signal: AbortSignal.timeout(5000) });
        if (!tags.ok) throw new Error('本机向量服务未返回模型信息');
        digest = (await tags.json()).models.find(tag => tag.name === tagName)?.digest;
        if (!digest) throw new Error('本机向量服务中没有所选模型');
      }
      const response = await fetch(endpoint, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ollama ? { model, input, truncate: false } : { model, input })
      });
      if (!response.ok) throw new Error('本机向量服务未完成请求');
      const body = await response.json();
      if (ollama) {
        identity = JSON.stringify(['raw-v1', 'ollama', tagName, digest]);
        return body.embeddings;
      }
      identity = JSON.stringify(['raw-v1', endpoint.href, model, body.model ?? model, process.env.HAVEN_EMBED_REVISION || '']);
      const ordered = body.data.toSorted((a, b) => a.index - b.index);
      if (ordered.some((item, i) => item.index !== i)) throw new Error('向量返回顺序异常');
      return ordered.map(item => item.embedding);
    }
  };
}

function unitVectors(values, expected, dimensions) {
  if (!Array.isArray(values) || values.length !== expected) throw new Error('向量数量异常');
  return values.map(value => {
    if (!Array.isArray(value) || !value.length || value.length > 16384
        || (dimensions && value.length !== dimensions) || !value.every(Number.isFinite)) {
      throw new Error('向量格式异常');
    }
    const length = Math.sqrt(value.reduce((sum, v) => sum + v * v, 0));
    if (!length || !Number.isFinite(length)) throw new Error('向量长度异常');
    return Float32Array.from(value, v => v / length);
  });
}

// Keep UTF-16 offsets for exact String.slice replay. Do not split surrogate pairs.
function boundary(text, offset) {
  const code = text.charCodeAt(offset);
  return code >= 0xdc00 && code <= 0xdfff ? offset - 1 : offset;
}

function passages(messages) {
  const result = [];
  for (const message of messages) {
    const text = message.text;
    if (!text?.trim()) continue;
    for (let start = 0; start < text.length;) {
      const end = boundary(text, Math.min(start + passageSize, text.length));
      const excerpt = text.slice(start, end);
      result.push({
        thread: message.meta.thread, messageId: message.id, start, end, text: excerpt,
        hash: createHash('sha256').update(excerpt).digest('hex')
      });
      if (end === text.length) break;
      start = boundary(text, end - overlap);
    }
  }
  return result;
}

function normalize(text) {
  return text.normalize('NFKC').toLowerCase();
}

function lexicalQuery(query) {
  const normalized = normalize(query);
  const tokens = new Set([...segmenter.segment(normalized)]
    .filter(({ segment, isWordLike }) => isWordLike && segment.length > 1 && !stopWords.has(segment))
    .map(({ segment }) => segment));
  return text => {
    const content = normalize(text);
    const exact = content.includes(normalized);
    let count = 0;
    for (const token of tokens) if (content.includes(token)) count++;
    return { exact, coverage: tokens.size ? count / tokens.size : 0, count };
  };
}

function neighbor(message, previous) {
  const text = message.text || '';
  const start = previous ? boundary(text, Math.max(0, text.length - 180)) : 0;
  const end = previous ? text.length : boundary(text, Math.min(180, text.length));
  return { id: message.id, from: message.from, ts: message.ts, text: text.slice(start, end), start, end };
}

export function createArchiveSearch(db, { embedder, readMessages, readRelatedMessages }) {
  db.exec(`CREATE TABLE IF NOT EXISTS archive_passage_vectors (
    thread TEXT NOT NULL, message_id INTEGER NOT NULL, start INTEGER NOT NULL,
    digest TEXT NOT NULL, space TEXT NOT NULL, vector BLOB NOT NULL,
    PRIMARY KEY (thread, message_id, start)
  )`);
  const lookup = db.prepare('SELECT vector FROM archive_passage_vectors WHERE thread=? AND message_id=? AND start=? AND digest=? AND space=?');
  const save = db.prepare('INSERT OR REPLACE INTO archive_passage_vectors (thread,message_id,start,digest,space,vector) VALUES(?,?,?,?,?,?)');
  const indexed = db.prepare('SELECT message_id,start,digest FROM archive_passage_vectors WHERE thread=? AND message_id<?');
  const forget = db.prepare('DELETE FROM archive_passage_vectors WHERE thread=? AND message_id=? AND start=? AND digest=?');

  function prune(thread, beforeId, items) {
    const live = new Map(items.map(p => [p.messageId + ':' + p.start, p.hash]));
    for (const row of indexed.all(thread, beforeId)) {
      if (live.get(row.message_id + ':' + row.start) !== row.digest) {
        forget.run(thread, row.message_id, row.start, row.digest);
      }
    }
  }

  async function semanticScores(items, query) {
    embedder ??= createLocalEmbedder();
    const [question] = unitVectors(await embedder.embed([query]), 1);
    const space = embedder.identity;
    if (typeof space !== 'string' || !space) throw new Error('向量模型缺少标识');
    const scores = new Map();
    function score(item, vector) {
      let cosine = 0;
      for (let i = 0; i < question.length; i++) cosine += question[i] * vector[i];
      scores.set(item, cosine);
    }
    const missing = [];
    for (const item of items) {
      const cached = lookup.get(item.thread, item.messageId, item.start, item.hash, space)?.vector;
      if (cached?.byteLength === question.byteLength) {
        const data = cached.buffer.slice(cached.byteOffset, cached.byteOffset + cached.byteLength);
        score(item, new Float32Array(data));
      } else {
        missing.push(item);
      }
    }
    for (let offset = 0; offset < missing.length; offset += batchSize) {
      const batch = missing.slice(offset, offset + batchSize);
      const vectors = unitVectors(await embedder.embed(batch.map(row => row.text)), batch.length, question.length);
      if (embedder.identity !== space) throw new Error('检索过程中向量模型发生变化');
      db.exec('BEGIN');
      try {
        for (const [index, item] of batch.entries()) {
          const vector = vectors[index];
          save.run(item.thread, item.messageId, item.start, item.hash, space, Buffer.from(vector.buffer));
          score(item, vector);
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
    return scores;
  }

  async function search({ query, thread = 'window', beforeId = Number.MAX_SAFE_INTEGER, limit = 3,
    excludeMessageIds = [], excludeCurrentThread = false }, automatic) {
    if (typeof query !== 'string' || !query.trim() || query.length > 1000) throw new RangeError('请输入 1 至 1000 字的检索内容');
    if (!Number.isSafeInteger(beforeId) || beforeId < 1 || !Number.isInteger(limit) || limit < 1 || limit > 10) {
      throw new RangeError('检索范围有误');
    }
    const excluded = new Set(excludeMessageIds);
    const read = automatic
      ? () => readRelatedMessages(beforeId, excludeCurrentThread ? thread : undefined).filter(m => m.id < beforeId && !excluded.has(m.id))
      : () => readMessages(thread, beforeId).filter(m => m.meta?.thread === thread && m.id < beforeId);
    const items = passages(read());
    // Only an exhaustive single-window read can prune that window's stale index entries.
    if (!automatic) prune(thread, beforeId, items);
    if (!items.length) return { mode: 'empty', hits: [] };
    query = query.trim();
    let scores;
    try {
      if (embedder !== false) scores = await semanticScores(items, query);
    } catch (error) {
      // A model outage permits a literal-only result. Storage faults must be reported.
      if (error.code?.startsWith('ERR_SQLITE')) throw error;
    }
    const lexical = lexicalQuery(query);
    const candidates = [];
    for (const item of items) {
      const { exact, count, coverage } = lexical(item.text);
      const similarity = scores?.get(item) ?? 0;
      const semanticMatch = scores && similarity >= (automatic ? 0.65 : 0.58);
      const wordMatch = count >= 2 && coverage >= 0.75;
      if (!(exact || semanticMatch || wordMatch)) continue;
      const weighted = scores ? similarity * 0.85 + coverage * 0.15 : coverage * 0.8;
      candidates.push({ item, score: Math.min(1, exact ? Math.max(weighted, 0.85) : weighted) });
    }
    candidates.sort((a, b) => b.score - a.score || b.item.messageId - a.item.messageId || a.item.start - b.item.start);
    // Re-read the authoritative texts after asynchronous inference. A regeneration
    // during indexing must never return stale text under a live source identifier.
    const current = read();
    const positions = new Map(current.map((message, i) => [message.id, i]));
    const hits = [];
    const seen = new Set();
    for (const { item, score } of candidates) {
      if (seen.has(item.messageId)) continue;
      const i = positions.get(item.messageId);
      const message = current[i];
      if (!message || message.text.slice(item.start, item.end) !== item.text) continue;
      const context = [];
      if (!automatic && i > 0) context.push(neighbor(current[i - 1], true));
      if (!automatic && i + 1 < current.length) context.push(neighbor(current[i + 1], false));
      hits.push({ ...item, from: message.from, ts: message.ts, score, context });
      seen.add(item.messageId);
      if (hits.length === limit) break;
    }
    return { mode: scores ? 'hybrid' : 'lexical', hits,
      ...(!scores && { notice: embedder === false ? '本次按文字检索试验聊天。' : '本机向量服务暂不可用，本次仅按文字检索。' }) };
  }
  return {
    search: options => search(options, false),
    async searchRelated(options) {
      const raw = options.query?.trim() || '';
      const query = raw.length > 1000 ? raw.slice(0, 499) + '…' + raw.slice(-500) : raw;
      // A greeting or bare acknowledgement carries too little evidence for a historical match.
      if ([...query.replace(/[\p{P}\p{Z}\s]/gu, '')].length < 2 ||
          /^(你好|早上好|晚上好|晚安|谢谢|好的|嗯嗯|好吧|知道了|继续|是吗|为什么|然后呢|hello|okay|thank you)[呀啊哦呢啦～~！!。.？?\s]*$/iu.test(query)) {
        return { automatic: true, mode: 'empty', hits: [] };
      }
      return { ...await search({ ...options, query, limit: 2 }, true), automatic: true };
    }
  };
}

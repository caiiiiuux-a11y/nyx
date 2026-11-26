import { DatabaseSync } from 'node:sqlite';
import { assets, models } from '../room/catalog.mjs';
import { archiveQuery, buildModelRequest, generateMockReply, RECENT_TURN_LIMIT } from './model.mjs';
import { createArchiveSearch } from './archive-search.mjs';
import { createEvidenceStore } from './evidence.mjs';
import { createPocketStore } from './pocket.mjs';

const thread = 'window';

export class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function checkedModel(model) {
  if (!models.includes(model)) throw new RequestError(400, '请选择可用的模拟模型');
  return model;
}

function checkedRequestId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) {
    throw new RequestError(400, '请求缺少有效的发送编号');
  }
  return id;
}

function checkedDraft(input) {
  const text = input.text ?? '';
  const media = input.media || null;
  if (typeof text !== 'string' || text.length > 32000 || (!text.trim() && !media)) {
    throw new RequestError(400, '请输入 32000 字以内的消息或选择样例附件');
  }
  if (media !== null && (typeof media !== 'string' || !Object.hasOwn(assets, media))) {
    throw new RequestError(400, '附件不可用');
  }
  let quote = null;
  if (input.quote != null) {
    const { id, who, text: excerpt } = input.quote;
    if (!Number.isSafeInteger(id) || id < 1 || !['Iris', 'Adrian'].includes(who) ||
        typeof excerpt !== 'string' || excerpt.length > 500) {
      throw new RequestError(400, '引用格式有误');
    }
    quote = { id, who, text: excerpt };
  }
  return { text, media, quote, model: input.model == null ? null : checkedModel(input.model) };
}

function humanMessage(turn) {
  const draft = JSON.parse(turn.draft);
  return {
    id: turn.id * 2 - 1, from: 'human', text: draft.text, ts: turn.created,
    meta: { thread, attachments: draft.media ? [assets[draft.media]] : [], quote: draft.quote }
  };
}

function messagesFromTurn(turn) {
  const messages = [humanMessage(turn)];
  if (turn.answer) messages.push(JSON.parse(turn.answer));
  return messages;
}

// The local preview has one private room. Each turn owns two stable message IDs.
// A committed turn without an answer survives an interrupted process.
export function openStore(filename, { complete = generateMockReply, embedder } = {}) {
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA busy_timeout=5000;
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS turns (
      id INTEGER PRIMARY KEY, request_id TEXT UNIQUE NOT NULL,
      draft TEXT NOT NULL, model TEXT NOT NULL, created TEXT NOT NULL, answer TEXT
    );
    CREATE TABLE IF NOT EXISTS regenerations (
      request_id TEXT PRIMARY KEY, message_id INTEGER NOT NULL, model TEXT, answer TEXT NOT NULL
    );
  `);
  const currentModel = () => db.prepare("SELECT value FROM settings WHERE name='model'").get()?.value ?? models[0];
  const turnById = id => db.prepare('SELECT * FROM turns WHERE id=?').get(id);
  let queue = Promise.resolve();
  let jobs = 0;
  function inRoomOrder(work) {
    jobs++;
    const job = queue.then(work).finally(() => { jobs--; });
    queue = job.catch(() => {});
    return job;
  }

  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function readMessage(id) {
    if (!Number.isSafeInteger(id) || id < 1) throw new RequestError(400, '消息编号无效');
    const row = turnById(Math.ceil(id / 2));
    return row && messagesFromTurn(row).find(message => message.id === id);
  }

  function readArchiveSource({ messageId }) {
    const message = readMessage(messageId);
    if (!message) throw new RequestError(404, '找不到这条消息');
    const context = [];
    for (let id = Math.max(1, messageId - 2); id <= Math.min(Number.MAX_SAFE_INTEGER - 1, messageId + 2); id++) {
      const entry = readMessage(id);
      if (entry) context.push(entry);
    }
    return { thread, message, context };
  }

  const sources = createEvidenceStore(db, { readMessage, transaction, invalid: text => new RequestError(400, text) });
  const archiveIndex = createArchiveSearch(db, { embedder, readMessages(requestedThread, beforeId) {
    if (requestedThread !== thread) return [];
    return db.prepare('SELECT * FROM turns WHERE id <= ? ORDER BY id').all(Math.floor(beforeId / 2))
      .filter(row => archiveQuery(JSON.parse(row.draft).text) === null)
      .flatMap(messagesFromTurn).filter(message => message.id < beforeId);
  } });

  function searchArchive({ query, limit = 3 }, beforeId = Number.MAX_SAFE_INTEGER) {
    if (typeof query !== 'string' || !query.trim() || query.length > 1000) {
      throw new RequestError(400, '请输入 1 至 1000 字的旧聊天线索');
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5) throw new RequestError(400, '搜索结果数量需为 1 至 5');
    return archiveIndex.search({ query: query.trim(), limit, thread, beforeId });
  }

  async function makeAnswer(turn, model, previousAnswer) {
    const prior = db.prepare('SELECT * FROM turns WHERE id < ? ORDER BY id DESC LIMIT ?')
      .all(turn.id, RECENT_TURN_LIMIT).reverse();
    const messages = prior.flatMap(messagesFromTurn);
    const human = humanMessage(turn);
    messages.push(human);
    const query = archiveQuery(human.text);
    let archive;
    if (query !== null) {
      archive = query.length > 0 && query.length <= 1000
        ? await searchArchive({ query }, human.id)
        : { hits: [], notice: '试试「查旧聊天：当时你想找的事情」。线索最多 1000 字。' };
    }
    const request = buildModelRequest({ model, messages, archive });
    let result;
    try {
      result = await complete(request, {
        regenerating: Boolean(previousAnswer), previousText: previousAnswer?.text
      });
      if (typeof result?.text !== 'string') throw new Error('Invalid completion');
    } catch {
      throw new RequestError(503, '消息已保存，模拟回复暂时不可用，请重试');
    }
    return {
      id: turn.id * 2, from: 'ai', text: result.text,
      ts: previousAnswer?.ts ?? new Date().toISOString(),
      meta: {
        speaker: 'Adrian', provider: 'mock', model, thread, fallback: false, attachments: [],
        ...(archive && { sourceRefs: archive.hits.map(({ thread, messageId, start, end, text }) => ({
          thread, messageId, start, end, excerpt: text
        })) })
      }
    };
  }

  async function finishPending(throughId) {
    const pending = db.prepare('SELECT * FROM turns WHERE answer IS NULL AND id <= ? ORDER BY id');
    const save = db.prepare('UPDATE turns SET answer=? WHERE id=? AND answer IS NULL');
    for (const turn of pending.all(throughId)) {
      const answer = await makeAnswer(turn, turn.model);
      save.run(JSON.stringify(answer), turn.id);
    }
  }

  async function history({ since = 0, limit } = {}) {
    // Recover a turn interrupted by a restart. While a send is running, return the
    // already committed user message immediately instead of waiting for the provider.
    if (!jobs && db.prepare('SELECT 1 FROM turns WHERE answer IS NULL LIMIT 1').get()) {
      try { await inRoomOrder(() => finishPending(Number.MAX_SAFE_INTEGER)); }
      catch (error) {
        if (!(error instanceof RequestError) || error.status !== 503) throw error;
      }
    }
    let query = 'SELECT * FROM turns WHERE id >= ? ORDER BY id';
    const params = [Math.floor(since / 2) + 1];
    if (limit != null) {
      query += ' LIMIT ?';
      params.push(Math.ceil(limit / 2) + 1);
    }
    const messages = db.prepare(query).all(...params).flatMap(messagesFromTurn).filter(m => m.id > since);
    return { messages: limit == null ? messages : messages.slice(0, limit), thread, model: currentModel(), models };
  }

  async function send(input) {
    const key = checkedRequestId(input.requestId);
    const draft = checkedDraft(input);
    const encoded = JSON.stringify(draft);
    const id = transaction(() => {
      const existing = db.prepare('SELECT id, draft FROM turns WHERE request_id=?').get(key);
      if (existing) {
        if (existing.draft !== encoded) throw new RequestError(409, '发送编号已用于不同的消息');
        return existing.id;
      }
      const result = db.prepare('INSERT INTO turns(request_id,draft,model,created) VALUES(?,?,?,?)')
        .run(key, encoded, draft.model ?? currentModel(), new Date().toISOString());
      return Number(result.lastInsertRowid);
    });
    // Commit the human message before invoking the adapter, including on the first attempt.
    await inRoomOrder(() => finishPending(id));
    return { messages: messagesFromTurn(turnById(id)) };
  }

  async function regenerate(input) {
    const key = checkedRequestId(input.requestId);
    const { id } = input;
    if (!Number.isSafeInteger(id) || id < 2 || id % 2) throw new RequestError(400, '请选择 Adrian 的回复');
    const model = input.model == null ? null : checkedModel(input.model);
    const selected = model ?? currentModel();
    return inRoomOrder(async () => {
      const old = db.prepare('SELECT * FROM regenerations WHERE request_id=?').get(key);
      if (old) {
        if (old.message_id !== id || old.model !== model) throw new RequestError(409, '重试编号已用于不同的回复');
        return { message: JSON.parse(old.answer) };
      }
      await finishPending(id / 2);
      const turn = turnById(id / 2);
      if (!turn) throw new RequestError(404, '找不到这条回复');
      const answer = await makeAnswer(turn, selected, JSON.parse(turn.answer));
      const encoded = JSON.stringify(answer);
      transaction(() => {
        db.prepare('UPDATE turns SET answer=? WHERE id=?').run(encoded, turn.id);
        db.prepare('INSERT INTO regenerations(request_id,message_id,model,answer) VALUES(?,?,?,?)').run(key, id, model, encoded);
      });
      return { message: answer };
    });
  }

  function selectModel(input) {
    const model = checkedModel(input.model);
    db.prepare("INSERT INTO settings(name,value) VALUES('model',?) ON CONFLICT(name) DO UPDATE SET value=excluded.value")
      .run(model);
    return { model };
  }
  return {
    pocket: createPocketStore(db, RequestError),
    history, send, regenerate, selectModel, searchArchive: input => inRoomOrder(() => searchArchive(input)),
    readArchiveSource, bindEvidence: sources.bind, evidence: sources.evidence, close: () => db.close()
  };
}

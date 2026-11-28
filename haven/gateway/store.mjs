import { DatabaseSync } from 'node:sqlite';
import { assets, models as mockModels } from '../room/catalog.mjs';
import { archiveQuery, buildModelRequest, generateMockReply } from './model.mjs';
import { combineUsage, estimatedUsage, fitHistory, ProviderContextError } from './usage.mjs';
import { createArchiveSearch } from './archive-search.mjs';
import { createEvidenceStore } from './evidence.mjs';
import { createPocketStore } from './pocket.mjs';
import { createLabTurns, labModelRequest } from './memory-turn.mjs';
import { createWindowStore } from './windows.mjs';

export class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function checkedModel(model, models) {
  if (!models.includes(model)) throw new RequestError(400, '请选择当前线路提供的模型');
  return model;
}

function checkedRequestId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) {
    throw new RequestError(400, '请求缺少有效的发送编号');
  }
  return id;
}

function checkedDraft(input, models) {
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
  return { text, media, quote, model: input.model == null ? null : checkedModel(input.model, models) };
}

function humanMessage(turn) {
  const draft = JSON.parse(turn.draft);
  return {
    id: turn.id * 2 - 1, from: 'human', text: draft.text, ts: turn.created,
    meta: { thread: turn.thread, ...(turn.route && { route: turn.route }), attachments: draft.media ? [assets[draft.media]] : [], quote: draft.quote }
  };
}

// A confirmed hold cites its own immutable draft, including on older saved replies.
function withHoldSource(answer, human) {
  const receipt = answer.meta?.memoryTool;
  if (receipt?.name === 'hold' && receipt.status === 'ok' && receipt.bucketId &&
      receipt.sourceMessageId === human.id && !answer.meta.sourceRefs?.length) {
    answer.meta.sourceRefs = [{
      thread: human.meta.thread, messageId: human.id, start: 0, end: human.text.length, excerpt: human.text
    }];
  }
  return answer;
}

function messagesFromTurn(turn) {
  const human = humanMessage(turn);
  const messages = [human];
  if (turn.answer) messages.push(withHoldSource(JSON.parse(turn.answer), human));
  return messages;
}

// The local preview has one private room. Each turn owns two stable message IDs.
// A committed turn without an answer survives an interrupted process.
export function openStore(filename, { complete = generateMockReply, embedder, memoryLab, models = mockModels, modelsForRoute,
  provider = 'mock', supportsWindowKey = false, archiveRecall = true, resumePendingOnRead = true } = {}) {
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
  const defaultRoute = modelsForRoute ? 'mock' : null;
  if (modelsForRoute) db.exec(`CREATE TABLE IF NOT EXISTS opening_memory_receipts (
    thread TEXT PRIMARY KEY, turn_id INTEGER NOT NULL, route TEXT NOT NULL, receipt TEXT
  )`);
  const availableModels = route => modelsForRoute ? modelsForRoute(route) : models;
  const windows = createWindowStore(db, { models, messagesFromTurn, transaction, RequestError, provider, supportsWindowKey, defaultRoute });
  transaction(() => {
    const columns = new Set(db.prepare('PRAGMA table_info(regenerations)').all().map(row => row.name));
    if (!columns.has('cache_mode')) db.exec('ALTER TABLE regenerations ADD COLUMN cache_mode TEXT');
    if (!columns.has('selected_model')) db.exec('ALTER TABLE regenerations ADD COLUMN selected_model TEXT');
    if (!columns.has('route')) db.exec('ALTER TABLE regenerations ADD COLUMN route TEXT');
    if (modelsForRoute) {
      db.exec(`UPDATE regenerations SET route=CASE WHEN COALESCE(selected_model, model)='iris-demo-a' THEN 'mock' ELSE 'gemini' END
        WHERE route IS NULL`);
    }
  });
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

  function readArchiveSource({ messageId, thread: selected }) {
    const { id: thread } = windows.get(selected);
    const message = readMessage(messageId);
    if (message?.meta.thread !== thread) throw new RequestError(404, '找不到这条消息');
    const turn = Math.ceil(messageId / 2);
    const previous = db.prepare('SELECT * FROM turns WHERE thread=? AND id<? ORDER BY id DESC LIMIT 2').all(thread, turn).reverse();
    const next = db.prepare('SELECT * FROM turns WHERE thread=? AND id>=? ORDER BY id LIMIT 3').all(thread, turn);
    const neighbors = [...previous, ...next].flatMap(messagesFromTurn);
    const index = neighbors.findIndex(entry => entry.id === messageId);
    const context = neighbors.slice(Math.max(0, index - 2), index + 3);
    return { thread, message, context };
  }

  const sources = createEvidenceStore(db, { readMessage, transaction, invalid: text => new RequestError(400, text) });
  function evidence(input) {
    const { id: thread } = windows.get(input.thread);
    const result = sources.evidence(input);
    return { ...result, sources: result.sources.filter(source => source.thread === thread) };
  }
  function bindEvidence(input) {
    const { id: thread } = windows.get(input.thread);
    if (Array.isArray(input.messageIds) && input.messageIds.some(id => readMessage(id)?.meta.thread !== thread)) {
      throw new RequestError(400, '请选择当前窗口中的来源消息');
    }
    sources.bind(input);
    return evidence(input);
  }
  const executeLabTool = memoryLab && createLabTurns(db, memoryLab);
  function ordinaryMessages(turns, beforeId) {
    return turns.filter(row => archiveQuery(JSON.parse(row.draft).text) === null)
      .flatMap(messagesFromTurn).filter(message => message.id < beforeId);
  }
  const archiveIndex = archiveRecall && createArchiveSearch(db, {
    embedder,
    readMessages(thread, beforeId) {
      const rows = db.prepare('SELECT * FROM turns WHERE thread=? AND id <= ? ORDER BY id').all(thread, Math.floor(beforeId / 2));
      return ordinaryMessages(rows, beforeId);
    },
    readRelatedMessages(beforeId, excludedThread, route) {
      const through = Math.floor(beforeId / 2);
      let query = 'SELECT * FROM turns WHERE answer IS NOT NULL AND id<=?';
      const params = [through];
      if (route) {
        query += " AND route=? AND COALESCE(json_extract(answer,'$.meta.route'),json_extract(answer,'$.meta.provider'),route)=?";
        params.push(route, route);
      }
      if (excludedThread) { query += ' AND thread!=?'; params.push(excludedThread); }
      const rows = db.prepare(query + ' ORDER BY id').all(...params);
      // Recalled quotations already have their own source; don't index the model echoing them again.
      return ordinaryMessages(rows, beforeId).filter(message => !(message.from === 'ai' && message.meta?.automaticRecall &&
        message.meta.sourceRefs?.some(source => source.excerpt?.trim() && message.text.includes(source.excerpt))));
    }
  });

  function searchArchive({ query, limit = 3, thread: selected }, beforeId = Number.MAX_SAFE_INTEGER) {
    if (!archiveIndex) throw new RequestError(404, '这个试聊库没有开启旧聊天检索');
    const { id: thread } = windows.get(selected);
    if (typeof query !== 'string' || !query.trim() || query.length > 1000) {
      throw new RequestError(400, '请输入 1 至 1000 字的旧聊天线索');
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5) throw new RequestError(400, '搜索结果数量需为 1 至 5');
    return archiveIndex.search({ query: query.trim(), limit, thread, beforeId });
  }

  async function openingMemory(turn, route, regenerating, surface) {
    const saved = db.prepare('SELECT * FROM opening_memory_receipts WHERE thread=?').get(turn.thread);
    const base = { name: 'breath', scope: 'personal' };
    if (saved) {
      if (saved.turn_id !== turn.id || saved.route !== route) return null;
      return saved.receipt ? JSON.parse(saved.receipt) : { ...base, status: 'uncertain' };
    }
    if (regenerating || turn.route !== route) return null;
    const claimed = db.prepare(`INSERT OR IGNORE INTO opening_memory_receipts(thread,turn_id,route)
      SELECT ?,?,? WHERE NOT EXISTS (SELECT 1 FROM turns WHERE thread=? AND id<?)`)
      .run(turn.thread, turn.id, route, turn.thread, turn.id);
    if (!claimed.changes) return null;
    let receipt;
    try {
      const hit = await surface();
      receipt = hit ? { ...base, status: 'ok', bucketId: hit.bucketId, excerpt: hit.excerpt } : { ...base, status: 'empty' };
    } catch { receipt = { ...base, status: 'error' }; }
    db.prepare('UPDATE opening_memory_receipts SET receipt=? WHERE thread=? AND turn_id=?')
      .run(JSON.stringify(receipt), turn.thread, turn.id);
    return receipt;
  }

  async function makeAnswer(turn, model, onText, previousAnswer, prefs = { contextBudget: turn.context_budget, cacheMode: turn.cache_mode }) {
    const thread = turn.thread;
    const route = modelsForRoute ? prefs.route ?? turn.route : null;
    const human = humanMessage(turn);
    let archive;
    let request;
    if (executeLabTool) {
      request = { ...labModelRequest(model, human), ...prefs, thread };
      request.messages = fitHistory(request.messages, prefs.contextBudget, request.tools);
    } else {
      const prior = windows.recent(thread, turn.id, prefs.contextBudget, route);
      // Older live versions allowed quoting messages written on another route.
      // Preserve the saved transcript; omit those quotations from outgoing context.
      if (route) {
        for (const message of [...prior, human]) {
          const quote = message.meta.quote;
          if (!quote) continue;
          const original = readMessage(quote.id);
          if ((original?.meta.route ?? original?.meta.provider) !== route) message.meta.quote = null;
        }
      }
      request = buildModelRequest({ model, messages: [...prior, human], thread, ...prefs });
      const query = archiveIndex ? archiveQuery(human.text) : null;
      if (query !== null && !route) {
        archive = query.length > 0 && query.length <= 1000
          ? await searchArchive({ query, thread }, human.id)
          : { hits: [], notice: '试试「查旧聊天：当时你想找的事情」。线索最多 1000 字。' };
      } else if (archiveIndex && human.text.trim() && route !== 'mock') {
        const included = request.messages.length - 2;
        const excludeCurrentThread = prefs.contextBudget === 0;
        const excludeMessageIds = excludeCurrentThread ? [] : prior.slice(prior.length - included).map(message => message.id);
        const related = await archiveIndex.searchRelated({ query: query || human.text, thread, route, explicit: query !== null,
          beforeId: human.id, excludeMessageIds, excludeCurrentThread });
        if (related.hits.length || (route && !related.skipped)) archive = related;
      }
      if (archive) request.archive = archive;
    }
    if (modelsForRoute) request.route = prefs.route ?? turn.route;
    const options = { regenerating: Boolean(previousAnswer), previousText: previousAnswer?.text, onText };
    if (modelsForRoute) options.openingMemory = surface => openingMemory(turn, route, options.regenerating, surface);
    let result;
    let usage;
    let memoryTool;
    let memorySources;
    try {
      const started = performance.now();
      result = await complete(request, options);
      usage = result?.usage ?? estimatedUsage(request.messages, request.tools, result);
      memoryTool = result?.memoryTool;
      if (executeLabTool && result?.toolCall) {
        const call = result.toolCall;
        const receipt = await executeLabTool(turn.id, human, call);
        memoryTool = { name: call.name, status: receipt.status, sourceMessageId: human.id };
        if (receipt.bucketId) {
          memoryTool.bucketId = receipt.bucketId;
          if (call.name === 'hold') bindEvidence({ memoryId: receipt.bucketId, messageIds: [human.id], thread });
          // A confirmed receipt from the room's shared memory may cite a saved source
          // from an older window. Only these frozen excerpts accompany the reply.
          else memorySources = sources.evidence({ memoryId: receipt.bucketId }).sources
            .filter(source => source.id < human.id)
            .map(source => ({ thread: source.thread, messageId: source.id, start: 0,
              end: source.text.length, excerpt: source.text }));
        }
        const messages = fitHistory([...request.messages,
          { role: 'assistant', toolCall: call },
          { role: 'tool', name: call.name, content: JSON.stringify(receipt) }
        ], prefs.contextBudget);
        const beforeSecondMs = performance.now() - started;
        result = await complete({ ...request, messages, tools: [] }, options);
        usage = combineUsage(usage, result?.usage ?? estimatedUsage(messages, [], result), beforeSecondMs);
      }
      if (result?.toolCall || typeof result?.text !== 'string') throw new Error('Invalid completion');
    } catch (error) {
      if (error instanceof RangeError || error instanceof RequestError) throw error;
      throw new RequestError(503, '消息已保存，当前模型暂时无法完成回复，请重试');
    }
    const archiveHits = result.archiveHits ?? archive?.hits;
    return {
      id: turn.id * 2, from: 'ai', text: result.text,
      ts: previousAnswer?.ts ?? new Date().toISOString(),
      meta: {
        speaker: 'Adrian', provider: result.provider ?? provider, model, thread, fallback: false, attachments: [],
        ...(request.route && { route: request.route }),
        ...(result.reportedModel && { reportedModel: result.reportedModel }),
        usage,
        ...(memoryTool && { memoryTool }),
        ...(result.openingMemory && { openingMemory: result.openingMemory }),
        ...(memorySources?.length && { sourceRefs: memorySources }),
        ...(archiveHits?.length && { archiveMode: archive.mode, automaticRecall: Boolean(archive.automatic) }),
        ...(archiveHits?.length && { sourceRefs: archiveHits.map(({ thread, messageId, start, end, text, from }) => ({
          thread, messageId, start, end, excerpt: text, ...(from && { from })
        })) })
      }
    };
  }

  async function finishPending(thread, throughId, onText) {
    // An explicit-only provider retries just the selected turn, even after a route change.
    const idCondition = resumePendingOnRead ? 'id <= ?' : 'id = ?';
    const pending = db.prepare('SELECT * FROM turns WHERE thread=? AND answer IS NULL AND budget_blocked=0 AND ' + idCondition + ' ORDER BY id');
    const save = db.prepare('UPDATE turns SET answer=? WHERE id=? AND answer IS NULL');
    for (const turn of pending.all(thread, throughId)) {
      try {
        const answer = await makeAnswer(turn, turn.model, turn.id === throughId ? onText : undefined);
        transaction(() => {
          if (save.run(JSON.stringify(answer), turn.id).changes) windows.recordAnswer(thread, turn.id);
        });
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        const reason = error instanceof ProviderContextError ? 2 : 1;
        db.prepare('UPDATE turns SET budget_blocked=? WHERE id=?').run(reason, turn.id);
        if (turn.id === throughId) throw budgetError(reason);
      }
    }
  }

  function budgetError(reason = 1) {
    return new RequestError(413, reason === 2 ? new ProviderContextError().message :
      '这条消息超出了当前上下文预算，请缩短文字或提高预算后重试');
  }
  async function history({ since = 0, limit, thread: selected } = {}) {
    const window = windows.get(selected);
    const thread = window.id;
    // Recover a turn interrupted by a restart. While a send is running, return the
    // already committed user message immediately instead of waiting for the provider.
    if (resumePendingOnRead && !jobs && db.prepare('SELECT 1 FROM turns WHERE thread=? AND answer IS NULL AND budget_blocked=0 LIMIT 1').get(thread)) {
      try { await inRoomOrder(() => finishPending(thread, Number.MAX_SAFE_INTEGER)); }
      catch (error) {
        if (!(error instanceof RequestError) || error.status !== 503) throw error;
      }
    }
    let query = 'SELECT * FROM turns WHERE thread=? AND id >= ? ORDER BY id';
    const params = [thread, Math.floor(since / 2) + 1];
    if (limit != null) {
      query += ' LIMIT ?';
      params.push(Math.ceil(limit / 2) + 1);
    }
    const messages = db.prepare(query).all(...params).flatMap(turn => {
      const entries = messagesFromTurn(turn);
      if (!resumePendingOnRead && !turn.answer) {
        // Reuse exactly the original payload when a user retries after reopening the page.
        entries[0].meta.retryRequestId = turn.request_id;
        entries[0].meta.retryModel = JSON.parse(turn.draft).model;
        if (turn.route) entries[0].meta.retryRoute = turn.route;
      }
      return entries;
    }).filter(m => m.id > since);
    return { messages: limit == null ? messages : messages.slice(0, limit), thread, model: window.model,
      ...(window.route && { route: window.route }), models: availableModels(window.route),
      contextBudget: window.contextBudget, cacheMode: window.cacheMode,
      cacheCapabilities: { windowKey: supportsWindowKey && window.route !== 'mock' }, defaultWindowKey: windows.defaultWindowKey(window.route),
      usage: windows.latestUsage(thread) };
  }

  async function send(input, onText) {
    const window = windows.get(input.thread);
    const key = checkedRequestId(input.requestId);
    if (modelsForRoute && input.route !== undefined && input.route !== window.route) throw new RequestError(409, '本窗口的线路已经改变');
    const draft = checkedDraft(input, availableModels(window.route));
    const encoded = JSON.stringify(draft);
    const id = transaction(() => {
      const existing = db.prepare('SELECT id,thread,route,draft,budget_blocked FROM turns WHERE request_id=?').get(key);
      if (existing) {
        if (existing.thread !== window.id || existing.draft !== encoded || (modelsForRoute && existing.route !== window.route)) {
          throw new RequestError(409, '发送编号已用于不同的消息或线路');
        }
        if (!existing.budget_blocked) return existing.id;
      }
      if (draft.quote) {
        const source = readMessage(draft.quote.id);
        if (source?.meta.thread !== window.id) throw new RequestError(400, '请选择当前窗口中的引用');
        if (modelsForRoute && (source.meta.route ?? source.meta.provider) !== window.route) {
          throw new RequestError(409, '引用这条消息前，请切回它原来的线路。');
        }
      }
      const now = new Date().toISOString();
      const model = draft.model ?? window.model;
      const human = humanMessage({ id: 1, thread: window.id, draft: encoded, created: now });
      try {
        buildModelRequest({ model, messages: [human], thread: window.id, contextBudget: window.contextBudget, cacheMode: window.cacheMode });
      } catch (error) {
        if (error instanceof RangeError) throw budgetError();
        throw error;
      }
      if (existing) {
        db.prepare('UPDATE turns SET budget_blocked=0,context_budget=? WHERE id=?')
          .run(window.contextBudget, existing.id);
        return existing.id;
      }
      windows.recordTurn(window, draft, now);
      const result = db.prepare('INSERT INTO turns(thread,request_id,draft,model,created,context_budget,cache_mode,route) VALUES(?,?,?,?,?,?,?,?)')
        .run(window.id, key, encoded, model, now, window.contextBudget, windows.requestCacheMode(window), window.route ?? null);
      return Number(result.lastInsertRowid);
    });
    // Commit the human message before invoking the adapter, including on the first attempt.
    await inRoomOrder(() => finishPending(window.id, id, onText));
    const turn = turnById(id);
    if (turn.budget_blocked) throw budgetError(turn.budget_blocked);
    return { messages: messagesFromTurn(turn) };
  }

  async function regenerate(input, onText) {
    const window = windows.get(input.thread);
    const key = checkedRequestId(input.requestId);
    const { id } = input;
    if (!Number.isSafeInteger(id) || id < 2 || id % 2) throw new RequestError(400, '请选择 Adrian 的回复');
    if (modelsForRoute && input.route !== undefined && input.route !== window.route) throw new RequestError(409, '本窗口的线路已经改变');
    const model = input.model == null ? null : checkedModel(input.model, availableModels(window.route));
    const selected = model ?? window.model;
    const cacheMode = windows.requestCacheMode(window);
    return inRoomOrder(async () => {
      const turn = turnById(id / 2);
      if (!turn || turn.thread !== window.id) throw new RequestError(404, '找不到这条回复');
      if (modelsForRoute && turn.route !== window.route) throw new RequestError(409, '重新生成前，请切回这条消息原来的线路。');
      const old = db.prepare('SELECT * FROM regenerations WHERE request_id=?').get(key);
      if (old) {
        if (old.message_id !== id || old.model !== model || (modelsForRoute && old.route !== window.route)) {
          throw new RequestError(409, '重试编号已用于不同的回复或线路');
        }
        if (old.answer) return { message: withHoldSource(JSON.parse(old.answer), humanMessage(turn)) };
      }
      await finishPending(window.id, turn.id);
      const prior = turnById(turn.id);
      if (prior.budget_blocked) throw budgetError(prior.budget_blocked);
      // A failed upstream call can be retried after restart or after settings change.
      if (!old) {
        db.prepare(`INSERT INTO regenerations(request_id,message_id,model,selected_model,cache_mode,route,answer)
          VALUES(?,?,?,?,?,?,'')`).run(key, id, model, selected, cacheMode, window.route ?? null);
      }
      let answer;
      try {
        answer = await makeAnswer(prior, old?.selected_model ?? selected, onText, JSON.parse(prior.answer),
          { contextBudget: window.contextBudget, cacheMode: old?.cache_mode ?? cacheMode, route: old?.route ?? window.route });
      } catch (error) {
        if (error instanceof RangeError) throw budgetError(error instanceof ProviderContextError ? 2 : 1);
        throw error;
      }
      const encoded = JSON.stringify(answer);
      transaction(() => {
        db.prepare('UPDATE turns SET answer=? WHERE id=?').run(encoded, turn.id);
        db.prepare('UPDATE regenerations SET answer=? WHERE request_id=?').run(encoded, key);
        windows.recordAnswer(window.id, turn.id);
      });
      return { message: withHoldSource(answer, humanMessage(turn)) };
    });
  }

  function selectModel(input) {
    const window = windows.get(input.thread);
    const route = modelsForRoute ? (input.route ?? window.route) : null;
    const model = checkedModel(input.model, availableModels(route));
    db.prepare('UPDATE chat_windows SET model=?,route=? WHERE id=?').run(model, route, window.id);
    return { model, ...(route && { route }) };
  }
  const pocket = createPocketStore(db, RequestError);
  return {
    pocket: { ...pocket, create(input) {
      if (input.source != null) {
        const source = readMessage(input.source.id);
        if (!source || source.meta.thread !== (input.source.thread ?? 'window') || source.ts !== input.source.ts ||
            source.from !== input.source.from) throw new RequestError(400, '找不到纸条的原消息');
      }
      return pocket.create(input);
    } },
    listWindows: windows.list, windowModel: thread => windows.get(thread).model,
    windowRoute: thread => windows.get(thread).route, createWindow: windows.create,
    configureContext: windows.configure,
    setDefaultWindowKey: windows.setDefaultWindowKey,
    defaultWindowKey: thread => windows.defaultWindowKey(modelsForRoute ? windows.get(thread).route : null),
    history, send, regenerate, selectModel, searchArchive: input => inRoomOrder(() => searchArchive(input)),
    readArchiveSource, bindEvidence, evidence, close: () => db.close()
  };
}

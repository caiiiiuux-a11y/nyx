import { randomUUID } from 'node:crypto';
import { RECENT_TURN_LIMIT } from './model.mjs';

const budgets = [1024, 4096, 8192, 16384, 32768];
const defaultThread = 'window';
const emptyTitle = '新对话';

function draftTitle(draft) {
  const text = draft.text.trim().replace(/\s+/gu, ' ');
  return [...text].slice(0, 30).join('') || (draft.media ? '附件对话' : emptyTitle);
}

export function createWindowStore(db, { models, messagesFromTurn, transaction, RequestError, provider, supportsWindowKey }) {
  transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS chat_windows (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL,
      model TEXT NOT NULL, context_budget INTEGER NOT NULL DEFAULT 8192, cache_mode TEXT NOT NULL DEFAULT 'auto',
      request_id TEXT UNIQUE, last_answer_id INTEGER
    )`);
    if (!db.prepare('PRAGMA table_info(chat_windows)').all().some(row => row.name === 'last_answer_id')) {
      db.exec('ALTER TABLE chat_windows ADD COLUMN last_answer_id INTEGER');
    }
    const columns = new Set(db.prepare('PRAGMA table_info(turns)').all().map(row => row.name));
    if (!columns.has('thread')) db.exec("ALTER TABLE turns ADD COLUMN thread TEXT NOT NULL DEFAULT 'window'");
    if (!columns.has('context_budget')) db.exec('ALTER TABLE turns ADD COLUMN context_budget INTEGER NOT NULL DEFAULT 8192');
    if (!columns.has('cache_mode')) db.exec("ALTER TABLE turns ADD COLUMN cache_mode TEXT NOT NULL DEFAULT 'auto'");
    if (!columns.has('budget_blocked')) db.exec('ALTER TABLE turns ADD COLUMN budget_blocked INTEGER NOT NULL DEFAULT 0');
    db.exec('CREATE INDEX IF NOT EXISTS turns_by_window ON turns(thread,id)');
    if (db.prepare('SELECT 1 FROM chat_windows WHERE id=?').get(defaultThread)) return;
    const first = db.prepare('SELECT draft,created FROM turns WHERE thread=? ORDER BY id LIMIT 1').get(defaultThread);
    const last = db.prepare('SELECT created FROM turns WHERE thread=? ORDER BY id DESC LIMIT 1').get(defaultThread);
    const model = db.prepare("SELECT value FROM settings WHERE name='model'").get()?.value;
    const now = new Date().toISOString();
    db.prepare('INSERT INTO chat_windows(id,title,created,updated,model) VALUES(?,?,?,?,?)')
      .run(defaultThread, first ? draftTitle(JSON.parse(first.draft)) : emptyTitle,
        first?.created ?? now, last?.created ?? now, models.includes(model) ? model : models[0]);
  });

  const fields = 'id,title,created,updated,model,context_budget AS contextBudget,cache_mode AS cacheMode';
  const byId = db.prepare('SELECT ' + fields + ' FROM chat_windows WHERE id=?');
  function get(id = defaultThread) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new RequestError(400, '窗口编号无效');
    const window = byId.get(id);
    if (!window) throw new RequestError(404, '找不到这个窗口');
    return window;
  }
  function recent(thread, before = Number.MAX_SAFE_INTEGER) {
    return db.prepare('SELECT * FROM turns WHERE thread=? AND id<? AND answer IS NOT NULL ORDER BY id DESC LIMIT ?')
      .all(thread, before, RECENT_TURN_LIMIT).reverse().flatMap(messagesFromTurn);
  }
  function create({ requestId = null } = {}) {
    if (requestId !== null && (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(requestId))) {
      throw new RequestError(400, '新窗口请求编号无效');
    }
    return transaction(() => {
      if (requestId) {
        const existing = db.prepare('SELECT id FROM chat_windows WHERE request_id=?').get(requestId);
        if (existing) return { window: get(existing.id) };
      }
      const id = randomUUID();
      const now = new Date().toISOString();
      db.prepare('INSERT INTO chat_windows(id,title,created,updated,model,request_id) VALUES(?,?,?,?,?,?)')
        .run(id, emptyTitle, now, now, models[0], requestId);
      return { window: get(id) };
    });
  }
  function configure({ thread, contextBudget, cacheMode }) {
    const window = get(thread);
    if (!budgets.includes(contextBudget) || !['auto', 'window', 'provider'].includes(cacheMode)) {
      throw new RequestError(400, '请选择可用的上下文预算和缓存策略');
    }
    if (!supportsWindowKey && cacheMode !== 'auto' && cacheMode !== window.cacheMode) {
      throw new RequestError(400, '这条线路没有会话缓存键设置');
    }
    transaction(() => {
      db.prepare('UPDATE chat_windows SET context_budget=?,cache_mode=? WHERE id=?').run(contextBudget, cacheMode, window.id);
      // A provider may discover an oversized tool exchange after the draft is stored.
      // A higher budget unlocks that same turn even after the browser was closed.
      db.prepare(`UPDATE turns SET budget_blocked=0,context_budget=?
        WHERE thread=? AND budget_blocked=1 AND context_budget<?`).run(contextBudget, window.id, contextBudget);
    });
    return { thread: window.id, contextBudget, cacheMode };
  }
  const cacheSetting = provider + '.prompt_cache_key';
  function defaultWindowKey() {
    return supportsWindowKey && db.prepare('SELECT value FROM settings WHERE name=?').get(cacheSetting)?.value === '1';
  }
  function setDefaultWindowKey({ enabled }) {
    if (!supportsWindowKey) throw new RequestError(404, '这条线路没有会话缓存键设置');
    if (typeof enabled !== 'boolean') throw new RequestError(400, '请选择是否发送会话缓存键');
    db.prepare('INSERT INTO settings(name,value) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value')
      .run(cacheSetting, enabled ? '1' : '0');
    return { defaultWindowKey: enabled };
  }
  // Persist the wire decision. Old turns with "auto" already meant omission on the wire.
  function requestCacheMode(mode) {
    return supportsWindowKey && (mode === 'window' || (mode === 'auto' && defaultWindowKey())) ? 'window' : 'auto';
  }
  function recordTurn(window, draft, now) {
    const first = !db.prepare('SELECT 1 FROM turns WHERE thread=? LIMIT 1').get(window.id);
    db.prepare('UPDATE chat_windows SET updated=?,title=? WHERE id=?')
      .run(now, first ? draftTitle(draft) : window.title, window.id);
  }
  function recordAnswer(thread, turnId) {
    db.prepare('UPDATE chat_windows SET updated=?,last_answer_id=? WHERE id=?').run(new Date().toISOString(), turnId, thread);
  }
  function latestUsage(thread) {
    const latest = db.prepare(`SELECT t.answer FROM chat_windows w JOIN turns t ON t.id=w.last_answer_id AND t.thread=w.id
      WHERE w.id=?`).get(thread);
    return latest ? JSON.parse(latest.answer).meta?.usage ?? null : null;
  }
  return {
    get, create, recent, configure, recordTurn, recordAnswer, latestUsage, defaultWindowKey, setDefaultWindowKey, requestCacheMode,
    list: () => ({ windows: db.prepare('SELECT ' + fields + ' FROM chat_windows ORDER BY updated DESC,rowid DESC').all() })
  };
}

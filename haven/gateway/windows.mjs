import { randomUUID } from 'node:crypto';
import { RECENT_TURN_LIMIT } from './model.mjs';

const budgets = [0, 1024, 4096, 8192, 16384, 32768];
const defaultThread = 'window';
const emptyTitle = '新对话';

function draftTitle(draft) {
  const text = draft.text.trim().replace(/\s+/gu, ' ');
  return [...text].slice(0, 30).join('') || (draft.media ? '附件对话' : emptyTitle);
}

export function createWindowStore(db, { models, messagesFromTurn, transaction, RequestError, provider, supportsWindowKey, defaultRoute, enableCalendar }) {
  transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS chat_windows (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL,
      model TEXT NOT NULL, context_budget INTEGER NOT NULL DEFAULT 8192, cache_mode TEXT NOT NULL DEFAULT 'auto',
      request_id TEXT UNIQUE, last_answer_id INTEGER
    )`);
    const windowColumns = new Set(db.prepare('PRAGMA table_info(chat_windows)').all().map(row => row.name));
    if (!windowColumns.has('last_answer_id')) {
      db.exec('ALTER TABLE chat_windows ADD COLUMN last_answer_id INTEGER');
    }
    if (!windowColumns.has('route')) db.exec('ALTER TABLE chat_windows ADD COLUMN route TEXT');
    const columns = new Set(db.prepare('PRAGMA table_info(turns)').all().map(row => row.name));
    if (!columns.has('thread')) db.exec("ALTER TABLE turns ADD COLUMN thread TEXT NOT NULL DEFAULT 'window'");
    if (!columns.has('context_budget')) db.exec('ALTER TABLE turns ADD COLUMN context_budget INTEGER NOT NULL DEFAULT 8192');
    if (!columns.has('cache_mode')) db.exec("ALTER TABLE turns ADD COLUMN cache_mode TEXT NOT NULL DEFAULT 'auto'");
    if (!columns.has('budget_blocked')) db.exec('ALTER TABLE turns ADD COLUMN budget_blocked INTEGER NOT NULL DEFAULT 0');
    if (!columns.has('route')) db.exec('ALTER TABLE turns ADD COLUMN route TEXT');
    if (defaultRoute) {
      // The previous live lab offered exactly one local model and one Gemini model.
      for (const table of ['chat_windows', 'turns']) {
        db.exec(`UPDATE ${table} SET route=CASE WHEN model='iris-demo-a' THEN 'mock' ELSE 'gemini' END WHERE route IS NULL`);
      }
    }
    db.exec('CREATE INDEX IF NOT EXISTS turns_by_window ON turns(thread,id)');
    if (db.prepare('SELECT 1 FROM chat_windows WHERE id=?').get(defaultThread)) return;
    const first = db.prepare('SELECT draft,created FROM turns WHERE thread=? ORDER BY id LIMIT 1').get(defaultThread);
    const last = db.prepare('SELECT created FROM turns WHERE thread=? ORDER BY id DESC LIMIT 1').get(defaultThread);
    const model = db.prepare("SELECT value FROM settings WHERE name='model'").get()?.value;
    const now = new Date().toISOString();
    db.prepare('INSERT INTO chat_windows(id,title,created,updated,model,route) VALUES(?,?,?,?,?,?)')
      .run(defaultThread, first ? draftTitle(JSON.parse(first.draft)) : emptyTitle,
        first?.created ?? now, last?.created ?? now, models.includes(model) ? model : models[0], defaultRoute);
  });

  const fields = 'id,title,created,updated,model,context_budget AS contextBudget,cache_mode AS cacheMode' + (defaultRoute ? ',route' : '');
  const byId = db.prepare('SELECT ' + fields + ' FROM chat_windows WHERE id=?');
  function get(id = defaultThread) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new RequestError(400, '窗口编号无效');
    const window = byId.get(id);
    if (!window) throw new RequestError(404, '找不到这个窗口');
    return window;
  }
  function recent(thread, before, contextBudget, route) {
    const where = 'SELECT * FROM turns WHERE thread=? AND id<? AND answer IS NOT NULL';
    const scoped = route ? " AND route=? AND COALESCE(json_extract(answer,'$.meta.route'),json_extract(answer,'$.meta.provider'),route)=?" : '';
    return db.prepare(where + scoped + ' ORDER BY id DESC LIMIT ?')
      .all(thread, before, ...(route ? [route, route] : []), contextBudget === 0 ? -1 : RECENT_TURN_LIMIT)
      .reverse().flatMap(messagesFromTurn);
  }
  function insert(title, model, route, requestId = null) {
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare('INSERT INTO chat_windows(id,title,created,updated,model,request_id,route) VALUES(?,?,?,?,?,?,?)')
      .run(id, title, now, now, model, requestId, route);
    return id;
  }
  function create({ requestId = null, sourceThread } = {}) {
    if (requestId !== null && (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(requestId))) {
      throw new RequestError(400, '新窗口请求编号无效');
    }
    return transaction(() => {
      const source = defaultRoute && sourceThread !== undefined ? get(sourceThread) : null;
      if (requestId) {
        const existing = db.prepare('SELECT id FROM chat_windows WHERE request_id=?').get(requestId);
        if (existing) return { window: get(existing.id) };
      }
      const id = insert(emptyTitle, source?.model ?? models[0], source?.route ?? defaultRoute, requestId);
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
      // Local size failures can retry with more room. A provider length rejection
      // needs less history instead. Zero means unlimited in either comparison.
      db.prepare(`UPDATE turns SET budget_blocked=0,context_budget=:budget
        WHERE thread=:thread AND context_budget!=:budget AND (
          (budget_blocked=1 AND (:budget=0 OR (context_budget!=0 AND context_budget<:budget))) OR
          (budget_blocked=2 AND :budget!=0 AND (context_budget=0 OR context_budget>:budget))
        )`).run({ budget: contextBudget, thread: window.id });
    });
    return { thread: window.id, contextBudget, cacheMode };
  }
  function cacheSetting(route) {
    // Gemini was the only external provider using the original live-lab preference.
    return (route && route !== 'gemini' ? provider + '.' + route : provider) + '.prompt_cache_key';
  }
  function defaultWindowKey(route) {
    return supportsWindowKey && route !== 'mock' &&
      db.prepare('SELECT value FROM settings WHERE name=?').get(cacheSetting(route))?.value === '1';
  }
  function setDefaultWindowKey({ enabled, thread, route: expected }) {
    const route = defaultRoute ? get(thread).route : null;
    if (expected !== undefined && expected !== route && defaultRoute) throw new RequestError(409, '窗口线路已改变');
    if (!supportsWindowKey || route === 'mock') throw new RequestError(404, '这条线路没有会话缓存键设置');
    if (typeof enabled !== 'boolean') throw new RequestError(400, '请选择是否发送会话缓存键');
    db.prepare('INSERT INTO settings(name,value) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value')
      .run(cacheSetting(route), enabled ? '1' : '0');
    return { defaultWindowKey: enabled };
  }
  // Persist the wire decision. Old turns with "auto" already meant omission on the wire.
  function requestCacheMode(window) {
    return supportsWindowKey && window.route !== 'mock' &&
      (window.cacheMode === 'window' || (window.cacheMode === 'auto' && defaultWindowKey(window.route))) ? 'window' : 'auto';
  }
  function recordTurn(window, draft, now) {
    const first = !db.prepare('SELECT 1 FROM turns WHERE thread=? LIMIT 1').get(window.id);
    db.prepare('UPDATE chat_windows SET updated=?,title=? WHERE id=?')
      .run(now, first && window.title === emptyTitle ? draftTitle(draft) : window.title, window.id);
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
    get, create, insert, recent, configure, recordTurn, recordAnswer, latestUsage, defaultWindowKey, setDefaultWindowKey, requestCacheMode,
    list: () => ({ windows: db.prepare('SELECT ' + fields + ' FROM chat_windows' +
      (enableCalendar ? ' WHERE id NOT IN (SELECT thread FROM calendar_bound_windows)' : '') + ' ORDER BY updated DESC,rowid DESC').all() })
  };
}

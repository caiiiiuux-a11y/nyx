import { mealLabels, periodLabels, validDay } from '../room/diary-records.mjs';

export const calendarTool = {
  name: 'calendar_read', scope: 'calendar', description: '读取小屋指定日期的餐食、经期标记或阿川自己留下的署名便签。',
  parameters: { type: 'object', properties: {
    date: { type: 'string', description: '要查看的本地日期，格式 YYYY-MM-DD。' },
    category: { type: 'string', enum: ['meals', 'period', 'notes'], description: 'meals 是餐食，period 是经期，notes 是阿川的便签。每次只读一类。' }
  }, required: ['date', 'category'], additionalProperties: false }
};

function datedTextParameters(description) {
  return { type: 'object', properties: {
    date: { type: 'string', description: '这段文字所属的本地日期 YYYY-MM-DD。' },
    text: { type: 'string', description }
  }, required: ['date', 'text'], additionalProperties: false };
}

export const calendarReplyTool = {
  name: 'calendar_reply', scope: 'calendar',
  description: '在阿川自己的日记本写一篇指定日期的日记，并在日历上贴纸星。是否动笔、写什么由你决定。用第一人称记下自己的感受，想象的画面写成联想。涉及当天的餐食或经期记录时，先用 calendar_read 核对。',
  parameters: datedTextParameters('阿川写给自己的第一人称日记正文，最多 1200 字。')
};

export const calendarNoteTool = {
  name: 'calendar_note', scope: 'calendar',
  description: '在指定日期给 Iris 留一张署名便签。想和她分享一句话、一个约定或一件小事时，阿川可以主动落笔。',
  parameters: datedTextParameters('阿川写给 Iris 的便签正文，最多 1200 字。')
};

export function createCalendarStore(db, { transaction, windows, RequestError }) {
  db.exec(`CREATE TABLE IF NOT EXISTS calendar_fields (
    day TEXT NOT NULL, field TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(day,field));
    CREATE TABLE IF NOT EXISTS calendar_windows (
    day TEXT NOT NULL, route TEXT NOT NULL, thread TEXT NOT NULL UNIQUE, PRIMARY KEY(day,route));
    CREATE TABLE IF NOT EXISTS calendar_storybooks (route TEXT PRIMARY KEY, thread TEXT NOT NULL UNIQUE);
    CREATE VIEW IF NOT EXISTS calendar_bound_windows AS
      SELECT day,route,thread,'day' AS kind FROM calendar_windows UNION ALL
      SELECT NULL,route,thread,'storybook' FROM calendar_storybooks;
    CREATE TABLE IF NOT EXISTS calendar_replies (
    day TEXT NOT NULL, turn_id INTEGER NOT NULL, route TEXT NOT NULL, thread TEXT NOT NULL,
    text TEXT NOT NULL, created TEXT NOT NULL, PRIMARY KEY(day,turn_id));
    CREATE TABLE IF NOT EXISTS calendar_notes (
    id INTEGER PRIMARY KEY, day TEXT NOT NULL, route TEXT NOT NULL, operation TEXT NOT NULL,
    text TEXT NOT NULL, created TEXT NOT NULL, UNIQUE(day,route,operation));`);
  function checkDay(day) {
    if (!validDay(day)) throw new RequestError(400, '请选择有效的日历日期。');
    return day;
  }
  function fields(day) {
    return Object.fromEntries(db.prepare('SELECT field,value FROM calendar_fields WHERE day=?').all(checkDay(day))
      .map(row => [row.field, row.value]));
  }
  function save({ date, field, value, previous }) {
    checkDay(date);
    if (typeof field !== 'string' || !(field === 'period' || Object.hasOwn(mealLabels, field)) || typeof previous !== 'string' ||
        typeof value !== 'string' || value.length > 500 || (field === 'period' && value && !Object.hasOwn(periodLabels, value))) {
      throw new RequestError(400, '请检查日期、记录类型和内容。');
    }
    const next = value.trim();
    return transaction(() => {
      const current = fields(date)[field] ?? '';
      if (current !== previous && current !== next) throw new RequestError(409, '这一项刚在另一页改过。已保留你的草稿，请核对最新记录。');
      if (next) db.prepare('INSERT INTO calendar_fields(day,field,value) VALUES(?,?,?) ON CONFLICT(day,field) DO UPDATE SET value=excluded.value').run(date, field, next);
      else db.prepare('DELETE FROM calendar_fields WHERE day=? AND field=?').run(date, field);
      return { date, fields: fields(date) };
    });
  }
  function month(month, route) {
    if (typeof month !== 'string' || !validDay(month + '-01')) throw new RequestError(400, '请选择有效的月份。');
    const marks = {};
    const rows = db.prepare(`SELECT day, CASE WHEN field='period' THEN 'period' ELSE 'meals' END AS kind
      FROM calendar_fields WHERE day BETWEEN :first AND :last GROUP BY day,kind
      UNION SELECT day,'star' FROM calendar_replies WHERE route=:route AND day BETWEEN :first AND :last
      UNION SELECT day,'note' FROM calendar_notes WHERE route=:route AND day BETWEEN :first AND :last`)
      .all({ first: month + '-01', last: month + '-31', route: route ?? '' });
    for (const { day, kind } of rows) (marks[day] ??= {})[kind] = true;
    return { month, marks };
  }
  const threadFor = (day, route) => db.prepare('SELECT thread FROM calendar_windows WHERE day=? AND route=?').get(checkDay(day), route ?? '')?.thread;
  const binding = thread => db.prepare('SELECT day,route,kind FROM calendar_bound_windows WHERE thread=?').get(thread);
  const storyThreadFor = route => db.prepare('SELECT thread FROM calendar_storybooks WHERE route=?').get(route ?? '')?.thread;
  function openStorybook(target) {
    return transaction(() => {
      const existing = storyThreadFor(target.route);
      if (existing) return existing;
      const thread = windows.insert('故事本', target.model, target.route);
      db.prepare('INSERT INTO calendar_storybooks(route,thread) VALUES(?,?)').run(target.route, thread);
      return thread;
    });
  }
  function openDay(day, target) {
    const existing = threadFor(day, target.route);
    if (existing) return existing;
    return transaction(() => {
      const other = threadFor(day, target.route);
      if (other) return other;
      const id = windows.insert(day + ' · 阿川的日记本', target.model, target.route);
      db.prepare('INSERT INTO calendar_windows(day,route,thread) VALUES(?,?,?)').run(day, target.route, id);
      return id;
    });
  }
  function notes(day, route) {
    return db.prepare('SELECT id,text,created FROM calendar_notes WHERE day=? AND route=? ORDER BY id').all(checkDay(day), route ?? '');
  }
  function read(args, boundDate, route) {
    const { date, category } = args;
    const receipt = { name: calendarTool.name, scope: 'calendar', status: 'error' };
    if (!validDay(date) || (boundDate && date !== boundDate) || !['meals', 'period', 'notes'].includes(category)) {
      return { receipt, evidence: { error: 'invalid_calendar_request', ...(boundDate && { selectedDate: boundDate }) } };
    }
    let records;
    if (category === 'notes') records = notes(date, route).map(note => note.text);
    else {
      const saved = fields(date);
      records = category === 'period' ? (saved.period ? [periodLabels[saved.period]] : [])
        : Object.entries(mealLabels).filter(([key]) => saved[key]).map(([key, label]) => label + '　' + saved[key]);
    }
    Object.assign(receipt, { date, category, status: records.length ? 'ok' : 'empty' });
    receipt.output = records.join('\n');
    return { receipt, evidence: { date, category, status: receipt.status, records } };
  }
  function write({ date, text }, { boundDate, route, thread, turnId, operation }, name) {
    const receipt = { name, scope: 'calendar', status: 'error' };
    if (!validDay(date) || (boundDate && date !== boundDate) || typeof text !== 'string' || !text.trim() || text.length > 1200) {
      return { receipt, evidence: { error: 'invalid_calendar_entry', ...(boundDate && { selectedDate: boundDate }) } };
    }
    return transaction(() => {
      const now = new Date().toISOString();
      let saved;
      if (name === calendarNoteTool.name) {
        // The caller supplies a stable action ID. A notebook entry also works outside a chat turn.
        if (typeof operation !== 'string' || !operation) throw new Error('Missing calendar note operation');
        db.prepare('INSERT OR IGNORE INTO calendar_notes(day,route,operation,text,created) VALUES(?,?,?,?,?)')
          .run(date, route, operation, text.trim(), now);
        saved = db.prepare('SELECT id,text FROM calendar_notes WHERE day=? AND route=? AND operation=?').get(date, route, operation);
      } else {
        db.prepare('INSERT OR IGNORE INTO calendar_replies(day,turn_id,route,thread,text,created) VALUES(?,?,?,?,?,?)')
          .run(date, turnId, route, thread, text.trim(), now);
        saved = db.prepare('SELECT text FROM calendar_replies WHERE day=? AND turn_id=?').get(date, turnId);
      }
      return { receipt: { ...receipt, date, status: 'ok', output: saved.text, ...(saved.id && { noteId: saved.id }) },
        evidence: { date, posted: true, text: saved.text, ...(saved.id && { noteId: saved.id }) } };
    });
  }
  function stars(day, route, dayThread) {
    // A completed day turn already carries its star. An interrupted turn may have saved only the diary entry.
    return db.prepare(`SELECT turn_id,text,created FROM calendar_replies AS entry WHERE day=? AND route=?
      AND (thread!=? OR NOT EXISTS (SELECT 1 FROM turns WHERE id=entry.turn_id AND answer IS NOT NULL)) ORDER BY turn_id`)
      .all(checkDay(day), route ?? '', dayThread ?? '').map(row => ({ id: row.turn_id * 2, from: 'ai', text: row.text,
        ts: row.created, meta: { calendarStar: true } }));
  }
  return { fields, save, month, read, notes, stars, binding, threadFor, openDay, storyThreadFor, openStorybook,
    post: (args, source) => write(args, source, calendarReplyTool.name),
    note: (args, source) => write(args, source, calendarNoteTool.name) };
}

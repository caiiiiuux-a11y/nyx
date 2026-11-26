const handwrittenId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const chatNoteId = /^msg-[0-9a-f]{64}$/;

function validDate(value) {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value);
}

export function createPocketStore(db, RequestError) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pocket_notes (
      id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, snapshot TEXT NOT NULL,
      discussed INTEGER NOT NULL DEFAULT 0
    )
  `);
  const byId = db.prepare('SELECT snapshot, discussed FROM pocket_notes WHERE id=?');
  const all = db.prepare('SELECT snapshot, discussed FROM pocket_notes ORDER BY created_at DESC, rowid DESC');
  const insert = db.prepare('INSERT INTO pocket_notes(id,created_at,snapshot) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING');
  const mark = db.prepare('UPDATE pocket_notes SET discussed=? WHERE id=?');

  const unpack = row => ({ ...JSON.parse(row.snapshot), discussed: Boolean(row.discussed) });
  function read(id) {
    const row = byId.get(id);
    if (!row) throw new RequestError(404, '这张纸条找不到了');
    return { note: unpack(row) };
  }

  function create(input) {
    const { id, text, author, createdAt, discussed, attachmentNames } = input;
    const raw = input.source;
    if (typeof id !== 'string' || !(raw == null ? handwrittenId : chatNoteId).test(id) ||
        !['Iris', 'Adrian'].includes(author) || !validDate(createdAt) || discussed !== false) {
      throw new RequestError(400, '纸条编号、署名、日期或状态无效');
    }
    if (!Array.isArray(attachmentNames) || attachmentNames.length > 64 ||
        attachmentNames.some(name => typeof name !== 'string' || !name.trim() || name.length > 512)) {
      throw new RequestError(400, '纸条的附件名称无效');
    }
    if (typeof text !== 'string' || text.length > (raw == null ? 4000 : 64000) ||
        (!text.trim() && (raw == null || !attachmentNames.length))) {
      throw new RequestError(400, '请检查纸条内容和长度');
    }
    let source = null;
    if (raw != null) {
      if (raw.scope !== 'gateway' || !Number.isSafeInteger(raw.id) || raw.id < 1 ||
          !validDate(raw.ts) || raw.from !== (author === 'Iris' ? 'human' : 'ai') ||
          (raw.thread != null && (typeof raw.thread !== 'string' || !raw.thread.trim() || raw.thread.length > 200))) {
        throw new RequestError(400, '纸条的原消息位置无效');
      }
      source = { scope: 'gateway', id: raw.id, ts: raw.ts, from: raw.from };
      if (raw.thread != null) source.thread = raw.thread;
    }
    const snapshot = { id, text, author, createdAt, source, attachmentNames };
    const result = insert.run(id, Date.parse(createdAt), JSON.stringify(snapshot));
    return { ...read(id), created: result.changes === 1 };
  }

  function setDiscussed(id, { discussed }) {
    if (typeof discussed !== 'boolean') throw new RequestError(400, '请选择纸条的状态');
    mark.run(Number(discussed), id);
    return read(id);
  }
  return { list: () => ({ notes: all.all().map(unpack) }), read, create, setDiscussed };
}

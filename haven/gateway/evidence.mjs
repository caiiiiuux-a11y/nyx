// Local source links for a future memory adapter. Capture the selected version:
// regenerating a reply reuses its message ID, but must not silently rewrite a citation.
export function createEvidenceStore(db, { readMessage, transaction, invalid }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_evidence (
      memory_id TEXT NOT NULL, message_id INTEGER NOT NULL, source_json TEXT NOT NULL,
      PRIMARY KEY(memory_id,message_id)
    )
  `);
  const rows = db.prepare('SELECT source_json FROM memory_evidence WHERE memory_id=? ORDER BY message_id');
  const insert = db.prepare('INSERT OR IGNORE INTO memory_evidence(memory_id,message_id,source_json) VALUES(?,?,?)');

  function checkedMemoryId(input) {
    if (typeof input !== 'string' || !input.trim() || input.length > 200) throw invalid('记忆编号无效');
    return input.trim();
  }
  function evidence({ memoryId }) {
    const key = checkedMemoryId(memoryId);
    const sources = rows.all(key).map(row => {
      const source = JSON.parse(row.source_json);
      const current = readMessage(source.id);
      return { ...source, changed: !current || current.text !== source.text };
    });
    return { memoryId: key, sources };
  }
  function bind({ memoryId, messageIds }) {
    const key = checkedMemoryId(memoryId);
    if (!Array.isArray(messageIds) || !messageIds.length || messageIds.length > 20) {
      throw invalid('请选择 1 至 20 条来源消息');
    }
    transaction(() => {
      for (const id of messageIds) {
        const message = readMessage(id);
        if (!message || !message.text.trim()) throw invalid('来源消息不存在或没有文字');
        insert.run(key, id, JSON.stringify({
          thread: message.meta.thread, id, from: message.from, text: message.text, ts: message.ts
        }));
      }
    });
    return evidence({ memoryId: key });
  }
  return { bind, evidence };
}

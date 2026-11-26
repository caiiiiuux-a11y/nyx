// The loopback gateway opts in on the pages it serves. A static build stays offline.
const gateway = document.documentElement.dataset.chatStore === 'gateway';
const updates = typeof BroadcastChannel === 'function' ? new BroadcastChannel('haven.room.pocket.v1') : null;

async function request(id = '', body) {
  const response = await fetch('/app/pocket' + (id ? '/' + encodeURIComponent(id) : ''), {
    method: body ? 'POST' : 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    ...(body && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  });
  if (response.status === 404 && id && !body) return { note: null };
  if (!response.ok) throw new Error('纸条暂时无法读写。');
  return response.json();
}

let database;
function openPreview() {
  if (!database) {
    database = new Promise((resolve, reject) => {
      const open = indexedDB.open('haven.room.pocket', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('notes', { keyPath: 'id' });
      open.onsuccess = () => {
        const db = open.result;
        db.onversionchange = () => { db.close(); database = undefined; };
        resolve(db);
      };
      open.onerror = () => reject(open.error);
    }).catch(error => { database = undefined; throw error; });
  }
  return database;
}

// Wait for commit before telling the UI a note is safe. Read/modify/write on the
// same store is serialized even when two preview tabs are open at once.
async function inPreview(mode, work) {
  const db = await openPreview();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('notes', mode);
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error || new Error('纸条保存中断。'));
    work(tx.objectStore('notes'), value => { result = value; });
  });
}

export async function listNotes() {
  if (gateway) return (await request()).notes;
  const notes = await inPreview('readonly', (store, done) => {
    const read = store.getAll();
    read.onsuccess = () => done(read.result);
  });
  return notes.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

export async function getNote(id) {
  if (gateway) return (await request(id)).note;
  return inPreview('readonly', (store, done) => {
    const read = store.get(id);
    read.onsuccess = () => done(read.result || null);
  });
}

async function insert(note) {
  let result;
  if (gateway) {
    result = await request('', note);
  } else {
    result = await inPreview('readwrite', (store, done) => {
      const read = store.get(note.id);
      read.onsuccess = () => {
        if (!read.result) store.add(note);
        done({ note: read.result || note, created: !read.result });
      };
    });
  }
  if (result.created) updates?.postMessage('changed');
  return result;
}

let pendingDraft;
export async function addNote(input) {
  const text = input.trim();
  if (!text || text.length > 4000) throw new Error('请写下 4000 字以内的纸条。');
  if (pendingDraft?.text !== text) {
    pendingDraft = { id: crypto.randomUUID(), text, author: 'Iris', createdAt: new Date().toISOString(),
      discussed: false, source: null, attachmentNames: [] };
  }
  const draft = pendingDraft;
  const { note } = await insert(draft);
  if (pendingDraft === draft) pendingDraft = undefined;
  return note;
}

export async function saveMessage(scope, message) {
  const source = { scope, id: message.id, ts: message.ts, from: message.from, thread: message.meta?.thread || 'window' };
  const text = message.text || '';
  const attachmentNames = (message.meta?.attachments || []).map(item => item.name);
  // The same snapshot has one ID across tabs and retries. A regenerated reply
  // with different words gets its own slip, preserving both versions.
  const bytes = new TextEncoder().encode(JSON.stringify([source, text, attachmentNames]));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return insert({ id: 'msg-' + hex, source, text, attachmentNames, discussed: false,
    createdAt: new Date().toISOString(), author: message.from === 'human' ? 'Iris' : 'Adrian' });
}

export async function setDiscussed(id, discussed) {
  let note;
  if (gateway) {
    note = (await request(id, { discussed })).note;
  } else {
    note = await inPreview('readwrite', (store, done) => {
      const read = store.get(id);
      read.onsuccess = () => {
        if (!read.result) return done(null);
        const updated = { ...read.result, discussed };
        store.put(updated);
        done(updated);
      };
    });
  }
  if (!note) throw new Error('找不到这张纸条。');
  updates?.postMessage('changed');
  return note;
}

export function subscribeNotes(fn) {
  updates?.addEventListener('message', fn);
  return () => updates?.removeEventListener('message', fn);
}

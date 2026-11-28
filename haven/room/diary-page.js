import { dayMarks, mealLabels, periodLabels } from './diary-records.mjs';

const $ = id => document.getElementById(id);
const live = document.documentElement.hasAttribute('data-live-lab');
const previewPrefix = 'haven.room.stickers.v1.';
const editorButtons = [...document.querySelectorAll('[data-editor]')];
const previewFields = day => JSON.parse(localStorage.getItem(previewPrefix + day) || '{}');
const noteTime = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

async function api(path, input) {
  const response = await fetch('/app/calendar/' + path, input ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input)
  } : {});
  const body = await response.json();
  if (!response.ok) throw Object.assign(new Error(body.error), { status: response.status });
  return body;
}

export function createDiaryPage(repaint) {
  let day, shownMonth, monthMarks = {}, detailOpen = false, linkedNote = null;
  let monthVersion = 0, dayVersion = 0;
  let fields = {}, messages = [], loaded = false, editor;
  const drafts = new Map(), writing = new Set();

  // A locally served preview can share this origin with the live room after an upgrade.
  function forgetPreview(date, field, expected) {
    if (expected === undefined) return;
    try {
      const saved = previewFields(date);
      if (saved[field] !== expected) return;
      delete saved[field];
      if (Object.keys(saved).length) localStorage.setItem(previewPrefix + date, JSON.stringify(saved));
      else localStorage.removeItem(previewPrefix + date);
    } catch { /* The gateway copy has already been committed. */ }
  }

  async function adoptPreview(date, data) {
    let saved;
    try { saved = previewFields(date); } catch { return; }
    for (const [field, value] of Object.entries(saved ?? {})) {
      if (typeof value !== 'string' || !value || value.length > 500 ||
          !(Object.hasOwn(mealLabels, field) || (field === 'period' && Object.hasOwn(periodLabels, value)))) continue;
      if (!data.fields[field]) {
        try { data.fields = (await api('record', { date, field, value, previous: '' })).fields; }
        catch (error) {
          if (error.status !== 409) throw error;
          data.fields = (await api('day?date=' + date)).fields;
        }
      }
      if (data.fields[field] === value) forgetPreview(date, field, value);
      else if (!drafts.has(date + field)) {
        drafts.set(date + field, { value, previous: data.fields[field] ?? '', preview: value });
        if (date === day) $('record-status').textContent = '这天还有一条浏览器草稿，打开对应贴纸可核对后保存。';
      }
    }
    if (Object.keys(saved ?? {}).length && date.startsWith(shownMonth)) await refreshMonth();
  }

  async function refreshMonth() {
    const month = shownMonth;
    const ticket = ++monthVersion;
    try {
      const marks = {};
      if (live) Object.assign(marks, (await api('month?month=' + month)).marks);
      for (let n = 1; n <= 31; n++) {
        const date = month + '-' + String(n).padStart(2, '0');
        let preview;
        try { preview = dayMarks(previewFields(date)); } catch { continue; }
        for (const kind of ['meals', 'period']) if (preview[kind]) (marks[date] ??= {})[kind] = true;
      }
      if (ticket !== monthVersion) return;
      monthMarks = marks;
      $('month-status').textContent = '';
      repaint();
    } catch {
      if (ticket === monthVersion) $('month-status').textContent = '暂时读不到这个月的贴纸，请再翻开这个月。';
      if (ticket === monthVersion) $('reload-day').hidden = false;
    }
  }

  function syncButtons() {
    for (const button of editorButtons) button.disabled = !loaded || writing.has(day);
    for (const control of $('record-form').elements) control.disabled = writing.has(day) || !loaded;
  }

  function renderRecords() {
    const rows = [];
    for (const [key, label] of Object.entries({ ...mealLabels, period: '经期' })) {
      if (!fields[key]) continue;
      const row = document.createElement('p');
      const name = document.createElement('b');
      name.textContent = label;
      const text = document.createElement('span');
      text.textContent = key === 'period' ? periodLabels[fields[key]] : fields[key];
      row.append(name, text);
      rows.push(row);
    }
    $('day-summary').replaceChildren(...rows);
  }

  function renderMessages() {
    const entries = [], prompts = [];
    for (const message of messages) {
      const meta = message.meta ?? {};
      const receipts = meta.memoryTools ?? (meta.memoryTool ? [meta.memoryTool] : []);
      const star = receipts.find(r => r.name === 'calendar_reply' && r.status === 'ok' && r.date === day);
      const isEntry = message.from === 'ai' && (meta.calendarStar || star);
      const row = document.createElement(isEntry ? 'article' : 'div');
      row.className = isEntry ? 'diary-entry' : 'prompt-message';
      const who = document.createElement('strong'), text = document.createElement('p');
      who.textContent = message.from === 'human' ? 'Iris' : '阿川';
      text.textContent = star?.output ?? message.text;
      row.append(who, text);
      if (isEntry) {
        const seal = document.createElement('img');
        seal.className = 'message-star'; seal.alt = '日记纸星'; seal.src = '/room/assets/paper-star.webp';
        who.prepend(seal);
        const written = new Date(message.ts);
        if (message.ts && Number.isFinite(written.getTime())) {
          const time = document.createElement('time');
          time.dateTime = written.toISOString();
          time.textContent = noteTime.format(written);
          who.after(time);
        }
      }
      for (const receipt of receipts.filter(r => r.name === 'calendar_read')) {
        const note = document.createElement('small');
        const status = { ok: '查过', empty: '当天未记', error: '未能读取', uncertain: '待核对' }[receipt.status];
        note.textContent = [status, receipt.date, { meals: '餐食', period: '经期', notes: '阿川的便签' }[receipt.category]].filter(Boolean).join(' · ');
        row.append(note);
      }
      if (isEntry) entries.push(row);
      else prompts.push(row);
    }
    $('day-messages').replaceChildren(...entries);
    $('day-prompts').replaceChildren(...prompts);
    $('journal-prompts').hidden = !prompts.length;
    $('journal-empty').hidden = !loaded || entries.length > 0;
    syncButtons();
  }

  function renderSignedNotes(notes) {
    const rows = notes.map(note => {
      const row = document.createElement('article'), text = document.createElement('p'), signature = document.createElement('time');
      row.className = 'signed-note';
      row.id = 'signed-note-' + note.id;
      row.tabIndex = -1;
      text.textContent = note.text;
      signature.dateTime = note.created;
      signature.textContent = '阿川留于 ' + noteTime.format(new Date(note.created));
      row.append(text, signature);
      return row;
    });
    $('signed-notes').replaceChildren(...rows);
    $('read-day-notes').hidden = !notes.length;
    $('read-day-notes').href = '/diary/?date=' + day + '#signed-notes';
    $('read-day-notes').querySelector('span').textContent = '阿川留了 ' + notes.length + ' 张便签';
  }

  async function refreshNotes() {
    const date = day, ticket = ++dayVersion;
    try {
      const notes = live ? (await api('day?date=' + date + '&view=notes')).notes : [];
      if (ticket !== dayVersion) return;
      renderSignedNotes(notes);
      $('memo-load-status').textContent = '';
      $('reload-notes').hidden = true;
      if (linkedNote) {
        const target = $(linkedNote) ?? $('signed-notes');
        linkedNote = null;
        target.focus({ preventScroll: true });
        target.scrollIntoView({ block: 'nearest' });
      }
    } catch {
      if (ticket !== dayVersion) return;
      $('memo-load-status').textContent = '暂时读不到阿川的署名便签。';
      $('reload-notes').hidden = false;
    }
  }

  function editorField() { return editor === 'meals' ? $('meal-field').value : 'period'; }
  function editorInput() { return editor === 'meals' ? $('meal-text') : $('period-value'); }
  function renderEditor() {
    $('record-form').hidden = !editor;
    for (const button of editorButtons) button.setAttribute('aria-expanded', String(editor === button.dataset.editor));
    if (!editor) return;
    const field = editorField();
    $('meal-choice').hidden = $('meal-entry').hidden = editor !== 'meals';
    $('period-choice').hidden = editor !== 'period';
    editorInput().value = drafts.get(day + field)?.value ?? fields[field] ?? '';
    $('remove-record').hidden = !fields[field];
  }

  async function refreshDay() {
    if (!detailOpen) return refreshNotes();
    const date = day, ticket = ++dayVersion;
    try {
      const data = live ? await api('day?date=' + date) : { fields: previewFields(date), messages: [] };
      if (ticket !== dayVersion) return;
      if (live) await adoptPreview(date, data);
      if (ticket !== dayVersion) return;
      fields = data.fields;
      messages = data.messages;
      loaded = true;
      $('reload-day').hidden = !$('month-status').textContent;
      renderRecords();
      renderEditor();
      renderSignedNotes(data.notes ?? []);
      renderMessages();
    } catch {
      if (ticket !== dayVersion) return;
      loaded = false;
      $('record-status').textContent = '暂时读不到这一天的记录，请重新读取。';
      $('reload-day').hidden = false;
      syncButtons();
    }
  }

  function select(date, open, noteTarget) {
    const month = date.slice(0, 7);
    const changed = shownMonth !== month;
    const returning = detailOpen && !open;
    day = date;
    detailOpen = open;
    linkedNote = noteTarget;
    ++dayVersion;
    if (changed) { shownMonth = month; monthMarks = {}; $('month-status').textContent = ''; }
    fields = {}; messages = []; loaded = false; editor = null;
    $('meal-field').value = 'lunch';
    $('record-status').textContent = '';
    $('memo-load-status').textContent = '';
    $('reload-notes').hidden = true;
    $('journal-prompts').open = false;
    $('reload-day').hidden = true;
    renderRecords(); renderEditor(); renderSignedNotes([]); renderMessages();
    if (changed || returning) refreshMonth();
    refreshDay();
  }

  for (const button of editorButtons) button.onclick = () => {
    editor = editor === button.dataset.editor ? null : button.dataset.editor;
    $('record-status').textContent = '';
    renderEditor();
    if (editor) editorInput().focus();
  };
  $('meal-field').onchange = renderEditor;
  function keepDraft() {
    const field = editorField(), key = day + field;
    drafts.set(key, { ...drafts.get(key), value: editorInput().value, previous: drafts.get(key)?.previous ?? fields[field] ?? '' });
  }
  $('meal-text').oninput = $('period-value').onchange = keepDraft;
  async function save(value) {
    const date = day, field = editorField(), key = date + field;
    if (!loaded || writing.has(date)) return;
    const previous = drafts.get(key)?.previous ?? fields[field] ?? '';
    const preview = drafts.get(key)?.preview;
    writing.add(date); syncButtons();
    try {
      let updated;
      if (live) updated = (await api('record', { date, field, previous, value })).fields;
      else {
        updated = previewFields(date);
        if ((updated[field] ?? '') !== previous && (updated[field] ?? '') !== value) throw Object.assign(new Error('另一页刚改了这条记录。请核对后再保存。'), { status: 409 });
        if (value) updated[field] = value; else delete updated[field];
        if (Object.keys(updated).length) localStorage.setItem(previewPrefix + date, JSON.stringify(updated));
        else localStorage.removeItem(previewPrefix + date);
      }
      drafts.delete(key);
      if (live) forgetPreview(date, field, preview);
      if (date === day) {
        fields = updated; editor = null;
        $('record-status').textContent = value ? '贴纸已保存' : '已移除这条记录';
        renderRecords(); renderEditor();
        await refreshDay();
      }
      if (date.startsWith(shownMonth)) await refreshMonth();
    } catch (error) {
      if (date === day) {
        await refreshDay();
        if (date !== day) return;
        if (error.status === 409) drafts.set(key, { value, previous: fields[field] ?? '', preview });
        renderEditor();
        $('record-status').textContent = error.status ? error.message : '这条记录没有保存成功，可以再试一次。';
      }
    } finally { writing.delete(date); syncButtons(); }
  }
  $('record-form').onsubmit = event => { event.preventDefault(); save(editorInput().value.trim()); };
  $('remove-record').onclick = () => save('');

  $('reload-day').onclick = () => { $('record-status').textContent = ''; refreshMonth(); refreshDay(); };
  $('reload-notes').onclick = refreshNotes;
  window.addEventListener('storage', event => {
    if (!live && (event.key === null || event.key.startsWith(previewPrefix))) { refreshMonth(); if (detailOpen) refreshDay(); }
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { refreshMonth(); refreshDay(); }
  });
  return { select, marks: date => monthMarks[date] ?? {} };
}

import { dayMarks, mealLabels, periodLabels } from './diary-records.mjs';
import { windowLocation } from './window-location.js';

const $ = id => document.getElementById(id);
const live = document.documentElement.hasAttribute('data-live-lab');
const previewPrefix = 'haven.room.stickers.v1.';
const editorButtons = [...document.querySelectorAll('[data-editor]')];
const previewFields = day => JSON.parse(localStorage.getItem(previewPrefix + day) || '{}');

async function api(path, input) {
  const response = await fetch('/app/calendar/' + path, input ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input)
  } : {});
  const body = await response.json();
  if (!response.ok) throw Object.assign(new Error(body.error), { status: response.status });
  return body;
}

export function createDiaryPage(repaint) {
  let day, shownMonth, monthMarks = {}, detailOpen = false;
  let monthVersion = 0, dayVersion = 0;
  let fields = {}, messages = [], loaded = false, canAsk = false, editor;
  const drafts = new Map(), questions = new Map(), writing = new Set(), asking = new Set();

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
    const pending = messages.some(m => m.meta?.retryRequestId);
    for (const button of editorButtons) button.disabled = !loaded || writing.has(day);
    for (const control of $('record-form').elements) control.disabled = writing.has(day) || !loaded;
    $('ask-text').disabled = !canAsk || asking.has(day) || pending;
    $('ask-form').querySelector('button').disabled = $('ask-text').disabled;
    for (const button of $('day-messages').querySelectorAll('button')) button.disabled = !canAsk || asking.has(day);
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
    const rows = messages.map(message => {
      const row = document.createElement('div');
      row.className = 'day-message';
      const who = document.createElement('strong'), text = document.createElement('p');
      who.textContent = message.from === 'human' ? 'Iris' : '阿川';
      text.textContent = message.text;
      row.append(who, text);
      const meta = message.meta ?? {};
      const receipts = meta.memoryTools ?? (meta.memoryTool ? [meta.memoryTool] : []);
      for (const receipt of receipts.filter(r => r.name === 'calendar_read')) {
        const note = document.createElement('small');
        const status = { ok: '查过', empty: '当天未记', error: '未能读取', uncertain: '待核对' }[receipt.status];
        note.textContent = [status, receipt.date, { meals: '餐食', period: '经期', notes: '阿川的便签' }[receipt.category]].filter(Boolean).join(' · ');
        row.append(note);
      }
      if (meta.calendarStar || receipts.some(r => r.name === 'calendar_reply' && r.status === 'ok')) {
        const seal = document.createElement('img');
        seal.className = 'message-star'; seal.alt = '阿川贴的纸星'; seal.src = '/room/assets/paper-star.webp';
        who.prepend(seal);
      }
      if (meta.retryRequestId) {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'text-button';
        retry.textContent = '重试这条留言';
        retry.onclick = () => ask(message.text, meta.retryRequestId);
        row.append(retry);
      }
      return row;
    });
    $('day-messages').replaceChildren(...rows);
    syncButtons();
  }

  function renderSignedNotes(notes) {
    const rows = notes.map(note => {
      const row = document.createElement('article'), text = document.createElement('p'), signature = document.createElement('small');
      row.className = 'signed-note';
      text.textContent = note.text;
      signature.textContent = '阿川留于 ' + new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(note.created));
      row.append(text, signature);
      return row;
    });
    $('signed-notes').replaceChildren(...rows);
    $('day-note-count').hidden = !notes.length;
    $('day-note-count').textContent = notes.length + ' 张署名便签';
    $('read-day-notes').hidden = !notes.length;
    $('read-day-notes').querySelector('span').textContent = '阿川留了 ' + notes.length + ' 张便签';
    document.querySelector('.adrian-note').classList.toggle('has-signed-notes', notes.length > 0);
  }
  $('read-day-notes').onclick = () => {
    const folder = document.querySelector('.adrian-note');
    folder.open = true;
    folder.querySelector('summary').focus();
    folder.scrollIntoView({ block: 'center' });
  };

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
    const date = day, ticket = ++dayVersion;
    try {
      const data = live ? await api('day?date=' + date) : { fields: previewFields(date), messages: [], canAsk: false };
      if (ticket !== dayVersion) return;
      if (live) await adoptPreview(date, data);
      if (ticket !== dayVersion) return;
      fields = data.fields;
      messages = data.messages;
      canAsk = data.canAsk;
      loaded = true;
      $('reload-day').hidden = !$('month-status').textContent;
      if (!canAsk) $('ask-status').textContent = live ? '在杂物间连接 Gemini 后，就能在这页留言。' : '在本机小屋打开日历，就能向阿川留言。';
      renderRecords();
      renderEditor();
      renderSignedNotes(data.notes ?? []);
      renderMessages();
    } catch {
      if (ticket !== dayVersion) return;
      loaded = false; canAsk = false;
      $('record-status').textContent = '暂时读不到这一天的记录，请重新读取。';
      $('reload-day').hidden = false;
      syncButtons();
    }
  }

  function select(date, open) {
    const month = date.slice(0, 7);
    const changed = shownMonth !== month;
    day = date;
    detailOpen = open;
    ++dayVersion;
    if (changed) { shownMonth = month; monthMarks = {}; $('month-status').textContent = ''; }
    fields = {}; messages = []; loaded = false; canAsk = false; editor = null;
    $('meal-field').value = 'lunch';
    $('record-status').textContent = '';
    $('ask-status').textContent = asking.has(day) ? '阿川正在写…' : '';
    $('ask-text').value = questions.get(day)?.text ?? '';
    $('reload-day').hidden = true;
    renderRecords(); renderEditor(); renderSignedNotes([]); renderMessages();
    if (changed || !open) refreshMonth();
    if (open) refreshDay();
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

  async function ask(text, requestId) {
    const date = day;
    if (!text || !canAsk || asking.has(date)) return;
    asking.add(date); syncButtons();
    $('ask-status').textContent = '阿川正在写…';
    let errorText = '';
    try {
      const { gatewayRequest } = await import('./gateway-adapter.js');
      await gatewayRequest('send', { calendarDate: date, text, requestId, sourceThread: windowLocation('haven.gateway.last-window.v1').id });
      questions.delete(date);
      if (date === day) $('ask-text').value = '';
      if (date.startsWith(shownMonth)) await refreshMonth();
    } catch (error) { errorText = error.notice || '没有收到回复，请重试这条留言。'; }
    finally {
      asking.delete(date);
      if (date === day) {
        await refreshDay();
        if (date === day) {
          if (messages.some(m => m.meta?.retryRequestId === requestId)) {
            questions.delete(date); $('ask-text').value = '';
          }
          $('ask-status').textContent = errorText;
          syncButtons();
        }
      }
    }
  }
  $('ask-text').oninput = () => questions.set(day, { text: $('ask-text').value });
  $('ask-form').onsubmit = event => {
    event.preventDefault();
    const text = $('ask-text').value.trim();
    if (!text) return;
    const requestId = questions.get(day)?.requestId ?? crypto.randomUUID();
    questions.set(day, { text, requestId });
    ask(text, requestId);
  };
  $('reload-day').onclick = () => { $('record-status').textContent = ''; refreshMonth(); refreshDay(); };
  window.addEventListener('storage', event => {
    if (!live && (event.key === null || event.key.startsWith(previewPrefix))) { refreshMonth(); if (detailOpen) refreshDay(); }
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { refreshMonth(); if (detailOpen) refreshDay(); }
  });
  return { select, marks: date => monthMarks[date] ?? {} };
}

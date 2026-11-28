import { dateKey, readNote, writeNote } from './calendar-store.js';
import { createDiaryPage } from './diary-page.js';

const byId = id => document.getElementById(id);
const monthName = new Intl.DateTimeFormat('en', { month: 'short' });
const weekName = new Intl.DateTimeFormat('zh-CN', { weekday: 'short' });
const label = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
const requested = new URLSearchParams(location.search).get('date') || '';
const parsed = new Date(requested + 'T12:00:00');
let selected = /^\d{4}-\d\d-\d\d$/.test(requested) && dateKey(parsed) === requested ? parsed : new Date();
let entry = readNote(selected);
let unsaved = false;
let detail = new URLSearchParams(location.search).get('view') === 'day';
const notes = document.querySelectorAll('[data-note-field]');
const stickers = {
  meals: ['餐食', 'blue-rim-teacup.webp'], period: ['经期', 'pin-rabbit.png'],
  note: ['便签或待办', 'mini-blue-book.webp'], star: ['页边留言', 'paper-star.webp']
};
const page = createDiaryPage(paintCalendar);
let filter = null;

function paintNote(note) {
  const text = entry[note.dataset.noteField];
  const field = note.querySelector('textarea');
  const body = note.querySelector('.handwritten');
  const button = note.querySelector('.memo-edit');
  const editing = !field.hidden;
  const author = note.querySelector('h3').textContent;
  body.textContent = text;
  body.hidden = editing || !text.trim();
  button.textContent = editing ? '写好了' : text.trim() ? '编辑' : '写一笔';
  button.setAttribute('aria-expanded', String(editing));
  button.setAttribute('aria-label', editing ? '完成 ' + author + ' 的手写便签' : (text.trim() ? '编辑 ' : '写 ') + author + ' 的手写便签');
  if (field.value !== text) field.value = text;
}

function persist(change) {
  entry = unsaved ? entry : readNote(selected);
  change(entry);
  const status = byId(detail ? 'save-status' : 'memo-save-status');
  try {
    writeNote(selected, entry);
    unsaved = false;
    status.textContent = '已保存在本机';
  } catch {
    unsaved = true;
    status.textContent = '本机未能保存，请先保留这一页。';
  }
  paintCalendar();
}

function decorate(cell, date, record) {
  const flags = { ...page.marks(dateKey(date)) };
  flags.note ||= Boolean(record.memo || record.adrianMemo || record.tasks.length);
  const names = [], marks = document.createElement('span');
  marks.className = 'marks';
  for (const [kind, [name, file]] of Object.entries(stickers)) {
    if (!flags[kind]) continue;
    names.push(name);
    if (kind === 'period') continue; // The date itself is the rabbit stamp.
    const icon = document.createElement('img');
    icon.src = '/room/assets/' + file; icon.alt = '';
    marks.append(icon);
  }
  cell.classList.toggle('has-record', names.length > 0);
  cell.classList.toggle('period-day', Boolean(flags.period));
  cell.classList.toggle('dim', Boolean(filter && !flags[filter]));
  cell.classList.toggle('weekend', [0, 6].includes(date.getDay()));
  cell.setAttribute('aria-label', [label.format(date), ...names].join('，'));
  cell.append(marks);
}

function paintCalendar() {
  const grid = byId('diary-days');
  const focusedDay = grid.contains(document.activeElement) && document.activeElement.dataset.day;
  const y = selected.getFullYear(), m = selected.getMonth();
  const first = (new Date(y, m, 1).getDay() + 6) % 7;
  const last = new Date(y, m + 1, 0).getDate();
  const days = document.createDocumentFragment();
  byId('month-name').textContent = monthName.format(selected);
  byId('month-year').textContent = y;
  for (let d = 1; d <= last; d++) {
    const date = new Date(y, m, d);
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'day-cell';
    cell.dataset.day = d;
    if (d === 1) cell.style.gridColumnStart = first + 1;
    const number = document.createElement('span');
    number.className = 'stamp';
    const shape = document.createElement('span');
    shape.className = 'stamp-shape';
    shape.setAttribute('aria-hidden', 'true');
    const digits = document.createElement('span');
    digits.className = 'digits';
    digits.textContent = d;
    number.append(shape, digits);
    cell.append(number);
    cell.setAttribute('aria-pressed', String(d === selected.getDate()));
    if (dateKey(date) === dateKey(new Date())) cell.setAttribute('aria-current', 'date');
    decorate(cell, date, d === selected.getDate() ? entry : readNote(date));
    days.append(cell);
  }
  grid.replaceChildren(days);
  if (focusedDay) grid.querySelector('[data-day="' + focusedDay + '"]')?.focus({ preventScroll: true });
}

function paintTasks() {
  const list = document.createDocumentFragment();
  entry.tasks.forEach((task, index) => {
    const row = document.createElement('li');
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = Boolean(task.done);
    checkbox.onchange = () => {
      persist(record => { if (record.tasks[index]) record.tasks[index].done = checkbox.checked; });
    };
    const name = document.createElement('span');
    name.textContent = task.text;
    label.append(checkbox, name);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove-task';
    remove.textContent = '×';
    remove.setAttribute('aria-label', '移除待办：' + task.text);
    remove.onclick = () => {
      persist(record => record.tasks.splice(index, 1));
      paintTasks();
    };
    row.append(label, remove);
    list.append(row);
  });
  byId('day-tasks').replaceChildren(list);
}

function paintDay() {
  paintCalendar();
  const key = dateKey(selected);
  byId('memo-date').dateTime = key;
  byId('memo-date').textContent = byId('day-heading').textContent = key.slice(5).replace('-', '.');
  const weekday = weekName.format(selected);
  byId('memo-week').textContent = weekday;
  byId('day-week').textContent = weekday + (key === dateKey(new Date()) ? ' · 今天' : '');
  byId('open-detail').setAttribute('aria-label', '打开' + label.format(selected) + '的明细');
  for (const note of notes) paintNote(note);
  paintTasks();
}

function selectDay(date, open = detail, mode = 'replace', hash = '') {
  if (unsaved) {
    persist(() => {});
    if (unsaved) return false;
  }
  const noteTarget = /^#(?:signed-notes|signed-note-\d+)$/.test(hash) ? hash.slice(1) : null;
  if (noteTarget) open = false;
  selected = date;
  detail = open;
  entry = readNote(selected);
  const url = new URL(location.href);
  url.searchParams.set('date', dateKey(date));
  if (open) url.searchParams.set('view', 'day');
  else url.searchParams.delete('view');
  url.hash = hash;
  if (mode === 'push') history.pushState({ fromMonth: true }, '', url);
  else if (mode === 'replace' || url.href !== location.href) history.replaceState(history.state, '', url);
  byId('month-page').hidden = open;
  byId('detail-page').hidden = !open;
  byId('new-task').value = '';
  byId('save-status').textContent = '';
  byId('memo-save-status').textContent = '';
  for (const note of notes) note.querySelector('textarea').hidden = true;
  page.select(dateKey(date), open, noteTarget);
  paintDay();
  return true;
}

function openDetails(date) {
  if (!selectDay(date, true, detail ? 'replace' : 'push')) return;
  window.scrollTo(0, 0);
  byId('day-heading').focus({ preventScroll: true });
}

function changeMonth(offset) {
  const y = selected.getFullYear(), m = selected.getMonth() + offset;
  const last = new Date(y, m + 1, 0).getDate();
  selectDay(new Date(y, m, Math.min(last, selected.getDate())));
}

byId('previous').onclick = () => changeMonth(-1);
byId('next').onclick = () => changeMonth(1);
byId('today').onclick = () => {
  if (!selectDay(new Date(), detail)) return;
  const target = detail ? byId('day-heading') : byId('diary-days').querySelector('[aria-current="date"]');
  target?.focus({ preventScroll: true });
  window.scrollTo(0, 0);
};
byId('open-detail').onclick = () => openDetails(selected);
byId('back-month').onclick = () => {
  if (history.state?.fromMonth) history.back();
  else { selectDay(selected, false); window.scrollTo(0, 0); byId('open-detail').focus({ preventScroll: true }); }
};
window.addEventListener('popstate', () => {
  const params = new URLSearchParams(location.search);
  const next = new Date(params.get('date') + 'T12:00:00');
  selectDay(dateKey(next) === params.get('date') ? next : new Date(), params.get('view') === 'day', null, location.hash);
  if (location.hash) return;
  window.scrollTo(0, 0);
  (detail ? byId('day-heading') : byId('diary-days').querySelector('[aria-pressed="true"]'))?.focus({ preventScroll: true });
});
for (const button of document.querySelectorAll('.legend button')) button.onclick = () => {
  filter = filter === button.dataset.kind ? null : button.dataset.kind;
  for (const item of document.querySelectorAll('.legend button')) item.setAttribute('aria-pressed', String(filter === item.dataset.kind));
  paintCalendar();
};
byId('diary-days').onclick = event => {
  const cell = event.target.closest('button[data-day]');
  if (!cell) return;
  selectDay(new Date(selected.getFullYear(), selected.getMonth(), Number(cell.dataset.day)), false);
};
for (const note of notes) {
  const field = note.querySelector('textarea');
  const button = note.querySelector('.memo-edit');
  button.onclick = () => {
    if (!field.hidden && unsaved) { persist(() => {}); if (unsaved) return; }
    field.hidden = !field.hidden;
    paintNote(note);
    (field.hidden ? button : field).focus();
  };
  field.oninput = event => {
    persist(record => { record[note.dataset.noteField] = event.target.value; });
    paintNote(note);
  };
}
byId('task-form').onsubmit = event => {
  event.preventDefault();
  const field = byId('new-task');
  const text = field.value.trim();
  if (!text) return;
  persist(record => record.tasks.push({ text, done: false }));
  field.value = '';
  paintTasks();
};
window.addEventListener('storage', event => {
  if (unsaved || (event.key !== null && !event.key.startsWith('haven.room.calendar.v1.'))) return;
  entry = readNote(selected);
  paintDay();
});
selectDay(selected, detail, 'replace', location.hash);

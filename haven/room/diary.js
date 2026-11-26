import { dateKey, readNote, writeNote } from './calendar-store.js';

const byId = id => document.getElementById(id);
const monthName = new Intl.DateTimeFormat('en', { month: 'long' });
const weekName = new Intl.DateTimeFormat('en', { weekday: 'long' });
const label = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
const requested = new URLSearchParams(location.search).get('date') || '';
const parsed = new Date(requested + 'T12:00:00');
let selected = /^\d{4}-\d\d-\d\d$/.test(requested) && dateKey(parsed) === requested ? parsed : new Date();
let entry = readNote(selected);
let unsaved = false;

function persist(change) {
  entry = unsaved ? entry : readNote(selected);
  change(entry);
  try {
    writeNote(selected, entry);
    unsaved = false;
    byId('save-status').textContent = '已保存在本机';
  } catch {
    unsaved = true;
    byId('save-status').textContent = '本机未能保存，请先保留这一页。';
  }
  updateDayCell(byId('diary-days').querySelector('[aria-pressed="true"]'), entry);
}

function updateDayCell(button, record) {
  const preview = record.tasks.find(task => !task.done)?.text || record.memo || record.tasks[0]?.text || '';
  button.lastElementChild.textContent = preview;
}

function paintCalendar() {
  const y = selected.getFullYear(), m = selected.getMonth();
  const first = new Date(y, m, 1).getDay();
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
    number.textContent = d;
    const preview = document.createElement('small');
    cell.append(number, preview);
    cell.setAttribute('aria-label', label.format(date));
    cell.setAttribute('aria-pressed', String(d === selected.getDate()));
    if (dateKey(date) === dateKey(new Date())) cell.setAttribute('aria-current', 'date');
    updateDayCell(cell, d === selected.getDate() ? entry : readNote(date));
    days.append(cell);
  }
  byId('diary-days').replaceChildren(days);
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
  byId('day-heading').textContent = (selected.getMonth() + 1) + '月' + selected.getDate() + '日';
  byId('day-week').textContent = weekName.format(selected);
  byId('day-memo').value = entry.memo;
  paintTasks();
}

function selectDay(date) {
  if (unsaved) {
    persist(() => {});
    if (unsaved) return;
  }
  selected = date;
  entry = readNote(selected);
  const url = new URL(location.href);
  url.searchParams.set('date', dateKey(date));
  history.replaceState(null, '', url);
  byId('new-task').value = '';
  byId('save-status').textContent = '';
  paintDay();
}

function changeMonth(offset) {
  const y = selected.getFullYear(), m = selected.getMonth() + offset;
  const last = new Date(y, m + 1, 0).getDate();
  selectDay(new Date(y, m, Math.min(last, selected.getDate())));
}

byId('previous').onclick = () => changeMonth(-1);
byId('next').onclick = () => changeMonth(1);
byId('today').onclick = () => selectDay(new Date());
byId('diary-days').onclick = event => {
  const cell = event.target.closest('button[data-day]');
  if (!cell) return;
  selectDay(new Date(selected.getFullYear(), selected.getMonth(), Number(cell.dataset.day)));
  if (event.detail === 0) byId('diary-days').querySelector('[aria-pressed="true"]').focus();
};
byId('day-memo').oninput = event => persist(record => { record.memo = event.target.value; });
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
paintDay();

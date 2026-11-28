// Link recognition, pocket status filters and the keyboard shortcut are adapted
// from StarFold146/nyx ta/pocket.js (CC BY-NC 4.0). See /credits.html.
import { addNote, listNotes, setDiscussed, subscribeNotes } from './pocket-store.js';

const form = document.getElementById('note-form');
const input = document.getElementById('new-note');
const save = document.getElementById('save-note');
const list = document.getElementById('note-list');
const filters = document.querySelectorAll('.pocket-filters button');
const empty = document.getElementById('empty-pocket');
const readError = document.getElementById('read-error');
const notice = document.getElementById('pocket-notice');
const stampIdea = document.getElementById('stamp-idea');
const dateFormat = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' });
const updating = new Set();
let notes = [];
let showDiscussed = false;
let saving = false;
let readVersion = 0;

const URL_RE = /https?:\/\/[^\s<>"'，。！？；、（）【】「」]+/g;
function sharedLink(note) {
  const link = (note.text.match(URL_RE) || [])[0];
  if (!link) return null;
  try {
    const url = new URL(link);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const anchor = element('a', 'source-link', url.hostname.replace(/^www\./, ''));
    anchor.href = url.href;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.setAttribute('aria-label', '打开链接：' + anchor.textContent);
    return anchor;
  } catch {
    return null;
  }
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function noteBody(text) {
  const body = element('p', 'topic-text', text);
  if (text.length <= 120 && text.split('\n').length <= 4) return body;
  const details = element('details', 'long-slip');
  const toggle = element('summary');
  toggle.append(element('span', 'text-preview', text), element('span', 'closed-label', '展开全文'), element('span', 'open-label', '收起全文'));
  details.append(toggle, body);
  return details;
}

function card(note) {
  const row = element('li', 'topic-slip');
  const adrian = note.author === 'Adrian';
  row.classList.toggle('adrian', adrian);
  row.classList.toggle('done', note.discussed);

  const head = element('div', 'topic-top');
  const by = element('span', 'topic-by');
  by.lang = 'en';
  const pin = element('img');
  pin.src = '/room/assets/' + (adrian ? 'pin-fawn.png' : 'pin-rabbit.png');
  pin.alt = '';
  by.append(pin, note.author);
  const date = element('time', '', dateFormat.format(new Date(note.createdAt)));
  date.dateTime = note.createdAt;
  head.append(by, date);
  row.append(head);

  if (note.text) row.append(noteBody(note.text));
  if (note.attachmentNames?.length) {
    row.append(element('p', 'topic-media', '附件 · ' + note.attachmentNames.join('、')));
  }
  const actions = element('div', 'topic-actions');
  const link = sharedLink(note);
  if (link) actions.append(link);
  if (note.source) {
    const original = element('a', '', '回到原话');
    original.href = '/chat/?' + new URLSearchParams({ thread: note.source.thread || 'window', note: note.id });
    actions.append(original);
  }
  const change = element('button', '', note.discussed ? '放回待聊' : '标为聊过');
  change.type = 'button';
  change.disabled = updating.has(note.id);
  change.addEventListener('click', async () => {
    if (updating.has(note.id)) return;
    updating.add(note.id);
    change.disabled = true;
    try {
      await setDiscussed(note.id, !note.discussed);
      notice.textContent = note.discussed ? '已放回待聊。' : '已收进「聊过」。';
      await refresh();
      if (document.activeElement === document.body) {
        document.querySelector('.pocket-filters [aria-pressed="true"]').focus({ preventScroll: true });
      }
    } catch {
      notice.textContent = '纸条状态没能保存，请再试一次。';
    } finally {
      updating.delete(note.id);
      change.disabled = false;
    }
  });
  actions.append(change);
  row.append(actions);
  return row;
}

function render() {
  for (const button of filters) {
    const discussed = button.dataset.discussed === 'true';
    button.setAttribute('aria-pressed', String(discussed === showDiscussed));
    button.querySelector('span').textContent = String(notes.filter(note => note.discussed === discussed).length);
  }
  const shown = notes.filter(note => note.discussed === showDiscussed);
  list.replaceChildren(...shown.map(card));
  list.setAttribute('aria-label', showDiscussed ? '聊过的纸条' : '待聊的纸条');
  empty.hidden = shown.length > 0 || !readError.hidden;
  empty.textContent = showDiscussed ? '聊过的纸条会收在这一格。' : '还没有待聊的纸条。也可以从聊天的「···」里收一张。';
  updateForm();
}

async function refresh() {
  const version = ++readVersion;
  try {
    const result = await listNotes();
    if (version !== readVersion) return;
    notes = result;
    readError.hidden = true;
    render();
  } catch {
    if (version !== readVersion) return;
    readError.hidden = false;
    empty.hidden = true;
    stampIdea.hidden = true;
  }
}

for (const button of filters) {
  button.addEventListener('click', () => {
    showDiscussed = button.dataset.discussed === 'true';
    notice.textContent = '';
    render();
  });
}
function updateForm() {
  save.disabled = saving || !input.value.trim();
  stampIdea.hidden = empty.hidden || showDiscussed || notes.length > 0 || input.value.length > 0;
}
stampIdea.addEventListener('click', () => {
  input.value = '给小屋画一对同一扇窗的邮票，一张清晨，一张亮灯。';
  input.focus();
  updateForm();
});
input.addEventListener('input', updateForm);
input.addEventListener('keydown', event => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing) {
    event.preventDefault();
    form.requestSubmit();
  }
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  const draft = input.value;
  if (saving || !draft.trim()) return;
  saving = true;
  updateForm();
  try {
    await addNote(draft.trim());
    if (input.value === draft) input.value = '';
    showDiscussed = false;
    notice.textContent = '纸条已收好。';
    await refresh();
  } catch {
    notice.textContent = '纸条没能保存，写下的内容还在。';
  } finally {
    saving = false;
    updateForm();
  }
});
document.getElementById('retry-read').addEventListener('click', refresh);
subscribeNotes(refresh);
window.addEventListener('pageshow', event => { if (event.persisted) refresh(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
updateForm();
refresh();

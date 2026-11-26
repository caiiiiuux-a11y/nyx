// Adapted from StarFold146/nyx app.js: build, quote, message timestamps,
// context-menu/long-press handling, auto-growing input and IME-safe submit.
// Noncommercial use under CC BY-NC 4.0. See /credits.html.
import { chatService } from './service.js';

const $ = id => document.getElementById(id);
const room = chatService.room();
const composer = $('composer');
const say = $('say');
const log = $('messages');
const picker = $('model');
const quoteChip = $('quote-chip');
const attachmentChip = $('attachment-chip');
const touchInput = matchMedia('(pointer: coarse)').matches;
let quote = null;
let media = '';
let playing = null;
let feedbackTimer;
function element(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
}
function icon(key) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', '#i-' + key);
  svg.append(use);
  return svg;
}
function control(label, action, glyph) {
  const button = element('button', '', glyph ? '' : label);
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.title = label;
  if (glyph) button.append(icon(glyph));
  button.onclick = action;
  return button;
}
function toast(text) {
  $('feedback').textContent = text;
  clearTimeout(feedbackTimer);
  feedbackTimer = setTimeout(() => { $('feedback').textContent = ''; }, 1800);
}
function hm(ts) {
  const d = new Date(ts);
  return isNaN(d) ? '' : String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
function audioTime(seconds) {
  return Math.floor(seconds / 60) + ':' + String(Math.floor(seconds % 60)).padStart(2, '0');
}
function caption(m) {
  return m.text || m.meta?.attachments?.[0]?.name || '';
}
function showChoices(title, items) {
  $('choice-title').textContent = title;
  $('choice-list').replaceChildren(...items.map(([label, run]) => control(label, () => {
    $('choices').close();
    run();
  })));
  $('choices').showModal();
}
function setQuote(value) {
  quote = value;
  quoteChip.hidden = !value;
  quoteChip.textContent = value ? '×　引用 ' + value.who + ' · ' + value.text : '';
  if (value) say.focus();
}
function quoteMessage(m) {
  setQuote({ id: m.id, who: m.from === 'human' ? 'Iris' : 'Adrian', text: caption(m).slice(0, 120) });
}
async function copy(m) {
  const text = caption(m);
  if (navigator.clipboard) {
    try { await navigator.clipboard.writeText(text); toast('已复制'); return; }
    catch { /* Try selection-based copying on older WebViews. */ }
  }
  const field = element('textarea');
  field.style.cssText = 'position:fixed;top:-1000px;opacity:0';
  field.value = text;
  document.body.append(field);
  field.select();
  const copied = document.execCommand('copy');
  field.remove();
  toast(copied ? '已复制' : '请长按文字复制');
}
function menu(m) {
  const source = m.from === 'ai' ? 'Adrian · 模拟 ' + m.meta.model : 'Iris';
  showChoices(source, [['引用', () => quoteMessage(m)], ['复制', () => copy(m)]]);
}
function addGestureMenu(node, m) {
  let timer, sx, sy;
  const stop = () => clearTimeout(timer);
  node.tabIndex = 0;
  node.setAttribute('aria-haspopup', 'dialog');
  node.onkeydown = ev => {
    if (ev.target !== node || !['Enter', 'ContextMenu'].includes(ev.key)) return;
    ev.preventDefault();
    menu(m);
  };
  node.oncontextmenu = ev => {
    if (ev.target.closest('button,input')) return;
    ev.preventDefault();
    stop();
    if (!$('choices').open) menu(m);
  };
  node.addEventListener('pointerdown', ev => {
    if (ev.target.closest('button,input')) return;
    sx = ev.clientX;
    sy = ev.clientY;
    stop();
    timer = setTimeout(() => { if (!$('choices').open) menu(m); }, 520);
  });
  node.addEventListener('pointermove', ev => {
    if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > 8) stop();
  });
  for (const event of ['pointerup', 'pointercancel', 'pointerleave']) node.addEventListener(event, stop);
  node.ondblclick = ev => {
    if (!ev.target.closest('button,input')) quoteMessage(m);
  };
}
function imageCard(a) {
  const button = control('查看图片：' + a.name, () => {
    $('large-photo').src = a.src;
    $('large-photo').alt = a.name;
    $('photo').showModal();
  });
  button.className = 'photo-button';
  button.replaceChildren();
  const img = element('img');
  img.src = a.src;
  img.alt = a.name;
  button.append(img);
  return button;
}
function voiceCard(a) {
  const audio = element('audio');
  audio.src = a.src;
  audio.preload = 'metadata';
  const row = element('div', 'voice');
  const play = control('播放声音样例', async () => {
    if (!audio.paused) return audio.pause();
    if (playing !== audio) playing?.pause();
    playing = audio;
    try { await audio.play(); }
    catch { toast('声音样例暂时无法播放'); }
  });
  play.textContent = '▶';
  const seek = element('input');
  seek.type = 'range';
  seek.min = '0';
  seek.step = '0.1';
  seek.value = '0';
  seek.disabled = true;
  seek.setAttribute('aria-label', '播放进度');
  const display = element('output', '', '—');
  const sync = () => {
    if (!Number.isFinite(audio.duration)) return;
    seek.disabled = false;
    seek.max = audio.duration;
    seek.value = audio.currentTime;
    display.textContent = audioTime(audio.currentTime && !audio.ended ? audio.currentTime : audio.duration);
    play.textContent = audio.paused ? '▶' : 'Ⅱ';
    play.setAttribute('aria-label', audio.paused ? '播放声音样例' : '暂停声音样例');
  };
  for (const event of ['play', 'pause', 'ended', 'loadedmetadata', 'timeupdate']) audio.addEventListener(event, sync);
  seek.oninput = () => { audio.currentTime = Number(seek.value); };
  row.append(audio, play, seek, display);
  return row;
}
function build(m) {
  const me = m.from === 'human';
  const row = element('article', 'msg ' + (me ? 'me' : 'ai'));
  row.dataset.id = m.id;
  row.dataset.from = m.from;
  row.dataset.ts = m.ts;
  row.setAttribute('aria-label', me ? 'Iris 的消息' : 'Adrian 的消息');
  if (!me) {
    const deer = element('img', 'deer');
    deer.src = '/room/assets/pin-fawn.png';
    deer.alt = '';
    row.append(deer);
  }
  const content = element('div', 'msg-content');
  const attachments = m.meta.attachments || [];
  const imageOnly = attachments.length === 1 && attachments[0].kind === 'image' && !m.text && !m.meta.quote;
  const body = element('div', imageOnly ? 'image-message' : 'bubble');
  if (m.meta.quote) body.append(element('blockquote', '', m.meta.quote.who + ' · ' + m.meta.quote.text));
  for (const a of attachments) {
    if (a.kind === 'image') body.append(imageCard(a));
    if (a.kind === 'audio') {
      body.classList.add('media-bubble');
      body.append(voiceCard(a), element('small', 'sample-caption', a.name));
    }
  }
  if (m.text) body.append(element('span', 'words', m.text));
  const stamp = element('time', imageOnly ? 'image-time' : '', hm(m.ts));
  stamp.dateTime = m.ts;
  body.append(stamp);
  content.append(body);
  if (!me) {
    const actions = element('div', 'message-actions');
    actions.append(control('复制消息', () => copy(m), 'copy'));
    if (m.text) actions.append(control('重新生成示例回复', () => {
      const updated = chatService.regenerate(m.id);
      if (updated) row.replaceWith(build(updated));
    }, 'retry'));
    actions.append(control('引用或查看消息来源', () => menu(m), 'more'));
    content.append(actions);
  }
  addGestureMenu(body, m);
  row.append(content);
  return row;
}
function updateComposer() {
  say.style.height = 'auto';
  say.style.height = Math.min(say.scrollHeight + 2, 108) + 'px';
  const ready = !!(say.value.trim() || media);
  $('send').querySelector('use').setAttribute('href', ready ? '#i-send' : '#i-mic');
  $('send').setAttribute('aria-label', ready ? '发送消息' : '使用声音样例');
  attachmentChip.hidden = !media;
  attachmentChip.textContent = media ? '×　' + room.media[media].name : '';
}
function attach(kind) {
  media = kind;
  updateComposer();
}
function send() {
  const text = say.value.trim();
  if (!text && !media) {
    showChoices('声音样例', [['附上本地样音', () => attach('audio')]]);
    return;
  }
  for (const m of chatService.send(text, media, quote)) log.append(build(m));
  say.value = '';
  setQuote(null);
  attach('');
  log.scrollTop = log.scrollHeight;
}
quoteChip.onclick = () => setQuote(null);
attachmentChip.onclick = () => attach('');
$('attach').onclick = () => showChoices('添加附件', [
  ['窗边的兔子 · 图片', () => attach('image')], ['声音样例 · 音频', () => attach('audio')]
]);
composer.onsubmit = ev => { ev.preventDefault(); send(); };
say.oninput = updateComposer;
if (touchInput) say.setAttribute('enterkeyhint', 'enter');
say.onkeydown = ev => {
  if (ev.key === 'Enter' && !ev.shiftKey && !touchInput && !ev.isComposing && ev.keyCode !== 229) {
    ev.preventDefault();
    if (say.value.trim() || media) send();
  }
};
$('room-date').dateTime = room.date.toLocaleDateString('sv-SE');
$('room-date').textContent = room.date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
log.append(...room.messages.map(build));
if (room.messages.length > 5) requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });
for (const model of room.models) picker.add(new Option(model, model));
picker.value = room.model;
picker.onchange = () => chatService.selectModel(picker.value);
$('options').onclick = () => $('settings').showModal();
const deer = $('show-deer');
try { deer.checked = localStorage.getItem('haven.room.deer') !== 'off'; } catch {}
document.body.classList.toggle('hide-deer', !deer.checked);
deer.onchange = () => {
  document.body.classList.toggle('hide-deer', !deer.checked);
  try { localStorage.setItem('haven.room.deer', deer.checked ? 'on' : 'off'); } catch {}
};

// Preserve the existing local wallpaper preference from the earlier static mock.
const wallpaperKey = 'haven.chat.wallpaper';
const wallpaper = $('wallpaper');
const reset = $('reset-wallpaper');
function applyWallpaper(data) {
  document.body.classList.toggle('has-wallpaper', !!data);
  document.body.style.setProperty('--chat-wallpaper', data ? 'url("' + data + '")' : 'none');
}
try {
  const data = localStorage.getItem(wallpaperKey);
  if (data?.startsWith('data:image/jpeg;base64,')) applyWallpaper(data);
} catch {}
reset.onclick = () => {
  try {
    localStorage.removeItem(wallpaperKey);
    applyWallpaper(null);
    $('settings-status').textContent = '已恢复纸纹。';
  } catch { $('settings-status').textContent = '浏览器未允许清除底图。'; }
};
wallpaper.onchange = async () => {
  const file = wallpaper.files[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  wallpaper.disabled = reset.disabled = true;
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, 1440 / Math.max(img.width, img.height));
    const canvas = element('canvas');
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#faf2e9';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL('image/jpeg', .78);
    localStorage.setItem(wallpaperKey, data);
    applyWallpaper(data);
    $('settings-status').textContent = '底图已保存在此浏览器。';
  } catch { $('settings-status').textContent = '图片无法保存，请试试较小的 JPEG 或 PNG。'; }
  finally { URL.revokeObjectURL(url); wallpaper.value = ''; wallpaper.disabled = reset.disabled = false; }
};

const vp = window.visualViewport;
function fitViewport() {
  if (!vp) return;
  const keyboard = document.activeElement === say && innerHeight - vp.height > 120;
  document.body.classList.toggle('keyboard-open', keyboard);
  document.body.style.setProperty('--view-height', vp.height + 'px');
  document.body.style.setProperty('--view-top', vp.offsetTop + 'px');
}
vp?.addEventListener('resize', fitViewport);
vp?.addEventListener('scroll', fitViewport);
say.addEventListener('blur', fitViewport);
fitViewport();
updateComposer();

// Adapted from StarFold146/nyx app.js: build, quote, message timestamps,
// context-menu/long-press handling, auto-growing input and IME-safe submit.
// Noncommercial use under CC BY-NC 4.0. See /credits.html.
import { chatService } from './service.js';
import { avatarButton } from './avatars.js';

const $ = id => document.getElementById(id);
let room = null;
let busy = false;
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
let reading = null;
const speech = window.speechSynthesis;
speech?.getVoices(); // Some engines populate the installed voice list asynchronously.
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
function storeStatus(message, retry) {
  $('store-status').hidden = !message;
  $('store-message').textContent = message;
  const button = $('store-retry');
  button.hidden = !retry;
  button.onclick = retry || null;
}
function setBusy(value) {
  busy = value;
  const locked = busy || !room;
  for (const control of [$('send'), $('attach'), picker, quoteChip, attachmentChip]) {
    control.disabled = locked;
  }
  say.readOnly = locked;
}
async function writeChat(action, failure, retry) {
  if (!room || busy) return;
  setBusy(true);
  storeStatus('');
  try { await action(); }
  catch (error) {
    const rejected = error.status >= 400 && error.status < 500;
    storeStatus(error.notice || failure, rejected ? null : retry);
  }
  finally {
    setBusy(false);
    picker.value = room.model;
  }
}
function hm(ts) {
  const d = new Date(ts);
  return isNaN(d) ? '' : String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
function audioTime(seconds) {
  return Math.floor(seconds / 60) + ':' + String(Math.floor(seconds % 60)).padStart(2, '0');
}
function setReadingButton(button, active) {
  button.setAttribute('aria-pressed', String(active));
  button.title = active ? '停止朗读' : '朗读消息';
  button.setAttribute('aria-label', button.title);
  button.replaceChildren(icon(active ? 'stop' : 'read'));
}
function stopReading() {
  if (!reading) return;
  const { button, audio } = reading;
  reading = null;
  setReadingButton(button, false);
  if (audio) audio.pause();
  else speech?.cancel();
}
function readAloud(text, button) {
  const toggleOff = reading?.button === button;
  stopReading();
  if (toggleOff) return;
  const voice = speech?.getVoices().find(v => v.localService && /^(zh|cmn)([-_]|$)/i.test(v.lang));
  playing?.pause();
  const session = { button };
  reading = session;
  setReadingButton(button, true);
  const finish = failed => {
    if (reading !== session) return;
    reading = null;
    setReadingButton(button, false);
    if (failed) toast('设备暂时无法朗读这条消息。');
  };
  const playRecording = () => {
    if (reading !== session) return;
    const src = chatService.readingFor(text);
    if (!src) {
      finish(true);
      return;
    }
    const audio = new Audio(src);
    session.audio = audio;
    audio.onended = () => finish(false);
    audio.onerror = () => finish(true);
    audio.play().catch(() => finish(true));
  };
  if (!voice || !window.SpeechSynthesisUtterance) {
    playRecording();
    return;
  }
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.voice = voice;
  utterance.lang = voice.lang;
  session.utterance = utterance;
  utterance.onend = () => finish(false);
  utterance.onerror = playRecording;
  try { speech.speak(utterance); }
  catch { playRecording(); }
}
window.addEventListener('pagehide', stopReading);
function caption(m) {
  return m.text || m.meta?.attachments?.[0]?.name || '';
}
// A non-modal dialog keeps the input and scroller active behind the anchored panel.
let panel = null;
function dismissPanel() {
  if (!panel) return;
  const { dialog, anchor } = panel;
  panel = null;
  anchor.setAttribute('aria-expanded', 'false');
  dialog.close();
}
function openPanel(dialog, anchor) {
  const same = panel?.dialog === dialog && panel.anchor === anchor;
  dismissPanel();
  if (same) return;
  panel = { dialog, anchor };
  anchor.setAttribute('aria-expanded', 'true');
  dialog.show();
  const rect = anchor.getBoundingClientRect();
  const viewport = window.visualViewport;
  const left = (viewport?.offsetLeft || 0) + 8;
  const top = (viewport?.offsetTop || 0) + 8;
  const right = left + (viewport?.width || innerWidth) - 16;
  const bottom = top + (viewport?.height || innerHeight) - 16;
  const box = dialog.getBoundingClientRect();
  const below = rect.bottom + 5;
  const y = below + box.height <= bottom ? below : rect.top - box.height - 5;
  const x = rect.left + rect.width / 2 > (left + right) / 2 ? rect.right - box.width : rect.left;
  dialog.style.left = Math.max(left, Math.min(x, right - box.width)) + 'px';
  dialog.style.top = Math.max(top, Math.min(y, bottom - box.height)) + 'px';
}
document.addEventListener('pointerdown', event => {
  if (panel && !panel.dialog.contains(event.target) && !panel.anchor.contains(event.target)) dismissPanel();
}, true);
document.addEventListener('keydown', event => {
  if (panel && event.key === 'Escape') {
    event.preventDefault();
    const anchor = panel.anchor;
    dismissPanel();
    anchor.focus({ preventScroll: true });
  }
});
document.addEventListener('focusin', event => {
  if (panel && !panel.dialog.contains(event.target) && !panel.anchor.contains(event.target)) dismissPanel();
});
log.addEventListener('scroll', dismissPanel, { passive: true });
window.addEventListener('resize', dismissPanel);
window.visualViewport?.addEventListener('resize', dismissPanel);
window.visualViewport?.addEventListener('scroll', dismissPanel);
for (const dialog of [$('choices'), $('settings')]) {
  dialog.addEventListener('close', () => {
    if (!dialog.open && panel?.dialog === dialog) dismissPanel();
  });
}
function showChoices(title, items, anchor) {
  $('choice-title').textContent = title;
  $('choice-list').replaceChildren(...items.map(([label, run, glyph]) => {
    const button = control(label, () => { dismissPanel(); run(); }, glyph);
    if (glyph) button.append(label);
    return button;
  }));
  openPanel($('choices'), anchor);
}
function setQuote(value) {
  quote = value;
  quoteChip.hidden = !value;
  quoteChip.textContent = value ? '×　引用 ' + value.who + ' · ' + value.text : '';
  if (value) say.focus();
}
function quoteMessage(m) {
  if (busy) return;
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
function retryMessage(m) {
  return writeChat(async () => {
    const row = log.querySelector('[data-id="' + m.id + '"]');
    if (!row) return;
    const updated = await chatService.regenerate(m.id);
    if (!updated) return;
    const hadFocus = row.contains(document.activeElement);
    if (reading && row.contains(reading.button)) stopReading();
    if (playing && row.contains(playing)) { playing.pause(); playing = null; }
    const replacement = build(updated);
    row.replaceWith(replacement);
    if (hadFocus) replacement.querySelector('.message-actions button').focus({ preventScroll: true });
    if (updated.meta.attachments.some(a => a.kind === 'audio')) toast('已重新生成语音');
  }, '未能确认重新生成的结果。', () => retryMessage(m));
}
function menu(m, anchor) {
  const source = m.from === 'ai' ? 'Adrian · 模拟 ' + m.meta.model : 'Iris';
  const items = [];
  if (m.from === 'ai') items.push(['重试', () => retryMessage(m), 'retry']);
  items.push(['引用', () => quoteMessage(m), 'quote'], ['复制', () => copy(m), 'copy']);
  showChoices(hm(m.ts) + ' · ' + source, items, anchor);
}
function addGestureMenu(node, m) {
  let timer, sx, sy;
  const stop = () => clearTimeout(timer);
  node.tabIndex = 0;
  node.setAttribute('aria-haspopup', 'dialog');
  node.onkeydown = ev => {
    if (ev.target !== node || !['Enter', 'ContextMenu'].includes(ev.key)) return;
    ev.preventDefault();
    menu(m, node);
  };
  node.oncontextmenu = ev => {
    if (ev.target.closest('button,input')) return;
    ev.preventDefault();
    stop();
    if (!$('choices').open) menu(m, node);
  };
  node.addEventListener('pointerdown', ev => {
    if (ev.target.closest('button,input')) return;
    sx = ev.clientX;
    sy = ev.clientY;
    stop();
    timer = setTimeout(() => { if (!$('choices').open) menu(m, node); }, 520);
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
    stopReading();
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
  row.append(avatarButton(me ? 'iris' : 'adrian'));
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
  const dated = new Date(m.ts);
  const showDay = dated.toDateString() !== new Date().toDateString();
  const timeLabel = (showDay ? dated.toLocaleDateString('zh-CN') + ' ' : '') + hm(m.ts);
  const stamp = element('time', imageOnly ? 'image-time' : '', timeLabel);
  stamp.dateTime = m.ts;
  body.append(stamp);
  content.append(body);
  if (m.meta.sourceRefs?.length) {
    const sources = element('div', 'message-sources');
    for (const ref of m.meta.sourceRefs) {
      const button = control('查看原话 #' + ref.messageId, () => {
        const source = log.querySelector('[data-id="' + Number(ref.messageId) + '"]');
        if (!source) return toast('本页未载入这条原话。');
        const current = source.querySelector('.words')?.textContent || '';
        if (current.slice(ref.start, ref.end) !== ref.excerpt) toast('这条消息后来修改过，引用保留当时的文字。');
        source.tabIndex = -1;
        source.focus({ preventScroll: true });
        source.scrollIntoView({ block: 'center' });
      });
      button.textContent = '原话 #' + ref.messageId;
      sources.append(button);
    }
    content.append(sources);
  }
  if (!me) {
    const actions = element('div', 'message-actions');
    actions.append(control('复制消息', () => copy(m), 'copy'));
    actions.append(control('重新生成示例回复', () => retryMessage(m), 'retry'));
    if (m.text) {
      const read = control('朗读消息', event => readAloud(m.text, event.currentTarget), 'read');
      read.setAttribute('aria-pressed', 'false');
      actions.append(read);
    }
    const more = control('更多消息操作', event => menu(m, event.currentTarget), 'more');
    more.setAttribute('aria-haspopup', 'dialog');
    more.setAttribute('aria-controls', 'choices');
    more.setAttribute('aria-expanded', 'false');
    actions.append(more);
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
  if (!room || busy) return;
  const text = say.value.trim();
  if (!text && !media) {
    showChoices('声音样例', [['附上本地样音', () => attach('audio')]], $('send'));
    return;
  }
  return writeChat(async () => {
    const additions = await chatService.send(text, media, quote);
    log.querySelector('.chat-empty')?.remove();
    for (const m of additions) log.append(build(m));
    say.value = '';
    setQuote(null);
    attach('');
    log.scrollTop = log.scrollHeight;
  }, '未能确认发送结果，输入已保留。', send);
}
quoteChip.onclick = () => setQuote(null);
attachmentChip.onclick = () => attach('');
$('attach').onclick = () => showChoices('添加附件', [
  ['窗边的兔子 · 图片', () => attach('image')], ['声音样例 · 音频', () => attach('audio')]
], $('attach'));
composer.onsubmit = ev => { ev.preventDefault(); send(); };
say.oninput = updateComposer;
if (touchInput) say.setAttribute('enterkeyhint', 'enter');
say.onkeydown = ev => {
  if (ev.key === 'Enter' && !ev.shiftKey && !touchInput && !ev.isComposing && ev.keyCode !== 229) {
    ev.preventDefault();
    if (say.value.trim() || media) send();
  }
};
async function loadRoom() {
  setBusy(true);
  log.setAttribute('aria-busy', 'true');
  storeStatus(chatService.persistent ? '正在读取本机对话…' : '');
  try {
    room = await chatService.room();
    $('room-date').dateTime = room.date.toLocaleDateString('sv-SE');
    $('room-date').textContent = room.date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    if (chatService.persistent) say.placeholder = '写一条本机测试消息…';
    log.replaceChildren();
    for (const message of room.messages) log.append(build(message));
    if (!room.messages.length) log.append(element('p', 'chat-empty', '在这里发一条测试消息。模拟对话会保存在这台电脑上。'));
    if (room.messages.length > 5 || chatService.persistent) requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });
    picker.replaceChildren(...room.models.map(model => new Option(model, model)));
    picker.value = room.model;
    storeStatus('');
  } catch {
    room = null;
    storeStatus('暂时读不到本机对话。请确认本地服务已启动。', loadRoom);
  } finally {
    log.setAttribute('aria-busy', 'false');
    setBusy(false);
  }
}
function changeModel(value) {
  return writeChat(async () => {
    await chatService.selectModel(value);
    room.model = value;
  }, '模拟模型的选择尚未确认。', () => changeModel(value));
}
picker.onchange = () => changeModel(picker.value);
$('options').onclick = () => openPanel($('settings'), $('options'));

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
loadRoom();
window.addEventListener('pageshow', event => {
  if (event.persisted && chatService.persistent && !busy) loadRoom();
});

// Adapted from StarFold146/nyx app.js: build, quote, message timestamps,
// context-menu/long-press handling, auto-growing input and IME-safe submit.
// Noncommercial use under CC BY-NC 4.0. See /credits.html.
import { chatService } from './service.js';
import { usageReceipt } from './usage-receipt.js';
import { avatarButton } from './avatars.js';
import { getNote, saveMessage } from './pocket-store.js';

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
const chatScope = chatService.persistent ? 'gateway' : 'preview';
const memoryLab = document.documentElement.hasAttribute('data-memory-lab');
const providerLab = document.documentElement.hasAttribute('data-provider-lab');
const liveLab = document.documentElement.hasAttribute('data-live-lab');
const requestedNote = new URLSearchParams(location.search).get('note');
$('back-to-pocket').hidden = requestedNote === null;
const drafts = new Map();
const issues = new Map();
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
function setBusy(value, lockDraft = true) {
  busy = value;
  const locked = busy || !room;
  for (const control of [$('send'), $('attach'), picker, quoteChip, attachmentChip,
    $('new-window'), $('context-budget'), $('cache-mode'), $('default-window-key')]) {
    control.disabled = locked;
  }
  $('open-windows').disabled = busy;
  say.readOnly = !room || (busy && lockDraft);
}
async function writeChat(action, failure, retry, { preserveIssue = false, allowTyping = false } = {}) {
  if (!room || busy) return;
  setBusy(true, !allowTyping && !preserveIssue);
  if (!preserveIssue || issues.get(room.thread)?.operation === failure) issues.delete(room.thread);
  storeStatus('');
  try {
    await action();
    const issue = issues.get(room.thread);
    if (issue) storeStatus(issue.message, issue.retry);
  }
  catch (error) {
    const rejected = error.status >= 400 && error.status < 500 && !error.retryable;
    const issue = { operation: failure, message: error.notice || failure, retry: rejected ? null : retry };
    issues.set(room.thread, issue);
    storeStatus(issue.message, issue.retry);
  }
  finally {
    setBusy(false);
    if (room) picker.value = room.model;
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
  positionPanel();
}
function positionPanel() {
  if (!panel) return;
  const { dialog, anchor } = panel;
  const rect = anchor.getBoundingClientRect();
  const viewport = window.visualViewport;
  const left = (viewport?.offsetLeft || 0) + 8;
  const top = (viewport?.offsetTop || 0) + 8;
  const right = left + (viewport?.width || innerWidth) - 16;
  const bottom = top + (viewport?.height || innerHeight) - 16;
  const box = dialog.getBoundingClientRect();
  const below = rect.bottom + 5;
  const above = rect.top - box.height - 5;
  const preferAbove = dialog.id === 'usage-details' && above >= top;
  const y = preferAbove || below + box.height > bottom ? above : below;
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
window.addEventListener('resize', positionPanel);
window.visualViewport?.addEventListener('resize', positionPanel);
window.visualViewport?.addEventListener('scroll', positionPanel);
for (const dialog of [$('choices'), $('settings'), $('memory-details'), $('usage-details')]) {
  dialog.addEventListener('close', () => {
    if (!dialog.open && panel?.dialog === dialog) dismissPanel();
  });
}
$('close-usage').onclick = $('close-memory').onclick = () => {
  const anchor = panel?.anchor;
  dismissPanel();
  anchor?.focus({ preventScroll: true });
};
function usageButton(m) {
  const receipt = usageReceipt(m.meta.usage, !chatService.persistent);
  const button = control(receipt.label, () => {
    const details = $('usage-content');
    details.replaceChildren();
    if (receipt.rows.length) {
      const list = element('dl', 'usage-list');
      for (const [name, value] of receipt.rows) list.append(element('dt', '', name), element('dd', '', value));
      details.append(list);
    }
    if (receipt.note) details.append(element('p', 'usage-note', receipt.note));
    openPanel($('usage-details'), button);
  });
  button.className = 'usage-button';
  button.setAttribute('aria-label', '本条回复用量，' + receipt.label);
  button.setAttribute('aria-controls', 'usage-details');
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', 'false');
  return button;
}
function appendMemoryReceipt(content, tool, opening = false) {
  if (tool.scope === 'calendar') {
    if (tool.name === 'calendar_reply' || tool.name === 'calendar_note') {
      const action = tool.name === 'calendar_note' ? '已留下署名便签' : '已贴纸星';
      content.append(element('p', 'receipt-status', ['日历手账', tool.date, tool.status === 'ok' ? action : '留言待核对'].filter(Boolean).join(' · ')));
      if (tool.output) content.append(element('blockquote', '', tool.output));
      if (tool.status === 'ok' && /^\d{4}-\d{2}-\d{2}$/.test(tool.date)) {
        const day = element('a', 'receipt-caption', '打开这天的明细 ›');
        day.href = '/diary/?date=' + tool.date + '&view=day' + (tool.name === 'calendar_note' ? '#signed-notes' : '#star-heading');
        content.append(day);
      }
      return;
    }
    const category = { meals: '餐食', period: '经期', notes: '阿川的便签' }[tool.category];
    const status = { ok: '已读取', empty: '这天还没记', error: '未能读取', uncertain: '结果待核对' }[tool.status];
    content.append(element('p', 'receipt-status', ['日历手账', tool.date, category, status].filter(Boolean).join(' · ')));
    if (tool.output) content.append(element('blockquote', '', tool.output));
    return;
  }
  const action = opening ? '开窗浮现' : ({ hold: '写入', breath: '主动浮现', breath_search: '查找', dream: '做梦' }[tool.name] || tool.name);
  const status = { ok: '已收到回执', empty: tool.name === 'breath' ? '没有浮现的记忆' : '没有匹配的记忆',
    error: '未完成', uncertain: '结果待核对', budget: '本轮预算不足，未附摘录' }[tool.status];
  const origin = { synthetic: 'Ombre 隔离库', personal: 'Ombre 真实库' }[tool.scope] || 'Ombre';
  content.append(element('p', 'receipt-status', [origin, action, status].filter(Boolean).join(' · ')));
  if (tool.scope === 'personal' && action !== tool.name) content.append(element('code', 'receipt-id', tool.name));
  if (tool.query) content.append(element('p', 'receipt-caption', '查询词「' + tool.query + '」'));
  if (tool.domain) content.append(element('p', 'receipt-caption', '主题域「' + tool.domain + '」'));
  if (tool.matchedQuery) content.append(element('p', 'receipt-caption', '命中词「' + tool.matchedQuery + '」'));
  if (tool.archived || tool.semantic) content.append(element('p', 'receipt-caption', tool.archived ? '归档的历史记录' : '语义关联'));
  if (tool.excerpt) content.append(element('p', 'receipt-caption', '记忆库摘录'), element('blockquote', '', tool.excerpt));
  if (tool.bucketId) content.append(element('p', 'receipt-id', '记忆编号 ' + tool.bucketId));
  for (const hit of tool.alsoFound ?? []) {
    content.append(element('blockquote', '', hit.excerpt), element('p', 'receipt-id', '记忆编号 ' + hit.bucketId));
  }
  if (tool.output) content.append(element('p', 'receipt-caption', '工具返回摘录'), element('blockquote', '', tool.output));
}
function showMemoryDetails(anchor, tools, refs, archiveMode, opening) {
  $('memory-title').textContent = anchor.getAttribute('aria-label');
  const content = $('memory-content');
  content.replaceChildren();
  if (opening) appendMemoryReceipt(content, opening, true);
  for (const tool of tools) appendMemoryReceipt(content, tool);
  if (archiveMode === 'hybrid' || archiveMode === 'lexical') {
    const method = archiveMode === 'hybrid' ? '语义和文字匹配' : '文字匹配';
    content.append(element('p', 'receipt-caption', '聊天原文 · ' + method));
  } else if (refs.length && (tools.length || opening)) content.append(element('p', 'receipt-caption', '原话摘录'));
  for (const ref of refs) {
    const characters = Array.from(ref.excerpt.trim());
    const text = characters.length > 96 ? characters.slice(0, 96).join('') + '…' : characters.join('');
    content.append(element('blockquote', '', text));
  }
  openPanel($('memory-details'), anchor);
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
function setQuote(value, focus = true) {
  quote = value;
  quoteChip.hidden = !value;
  quoteChip.textContent = value ? '×　引用 ' + value.who + ' · ' + value.text : '';
  if (value && focus) say.focus();
  updateComposer();
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
    row.classList.add('regenerating');
    let updated;
    try { updated = await withReplyStream(row, onText => chatService.regenerate(m.id, onText)); }
    finally { row.classList.remove('regenerating'); }
    if (!updated) return;
    const index = room.messages.findIndex(message => message.id === m.id);
    if (index >= 0) room.messages[index] = updated;
    const hadFocus = row.contains(document.activeElement);
    if (reading && row.contains(reading.button)) stopReading();
    if (playing && row.contains(playing)) { playing.pause(); playing = null; }
    const replacement = build(updated);
    row.replaceWith(replacement);
    if (hadFocus) replacement.querySelector('.message-actions button').focus({ preventScroll: true });
    if (updated.meta.attachments.some(a => a.kind === 'audio')) toast('已重新生成语音');
  }, '未能确认重新生成的结果。', () => retryMessage(m), { allowTyping: true });
}
async function keepForLater(message) {
  try {
    const { created } = await saveMessage(chatScope, message);
    toast(created ? '已放进客厅的回头聊' : '这条已经在回头聊里了');
  } catch {
    toast('纸条暂时没能保存，请再试一次。');
  }
}
function menu(m, anchor) {
  const line = { 'home-fixture': '合成 API · ', mock: '模拟 · ' }[m.meta.provider] || '';
  const source = m.from === 'ai' ? 'Adrian · ' + line + m.meta.model : 'Iris';
  const items = [];
  if (m.from === 'ai') items.push(['重试', () => retryMessage(m), 'retry']);
  items.push(['放进回头聊', () => keepForLater(m), 'keep'],
    ['引用', () => quoteMessage(m), 'quote'], ['复制', () => copy(m), 'copy']);
  showChoices(hm(m.ts) + ' · ' + source, items, anchor);
}
function addGestureMenu(node, m) {
  let timer, sx, sy;
  let heldPhoto = false;
  const stop = () => clearTimeout(timer);
  const interactiveMediaControl = target => target.closest('button:not(.photo-button),input');
  node.tabIndex = 0;
  node.setAttribute('aria-haspopup', 'dialog');
  node.onkeydown = ev => {
    if (ev.target !== node || !['Enter', 'ContextMenu'].includes(ev.key)) return;
    ev.preventDefault();
    menu(m, node);
  };
  node.oncontextmenu = ev => {
    if (interactiveMediaControl(ev.target)) return;
    ev.preventDefault();
    heldPhoto = !!ev.target.closest('.photo-button');
    stop();
    if (!$('choices').open) menu(m, node);
  };
  node.addEventListener('pointerdown', ev => {
    heldPhoto = false;
    if (interactiveMediaControl(ev.target)) return;
    const isPhoto = !!ev.target.closest('.photo-button');
    sx = ev.clientX;
    sy = ev.clientY;
    stop();
    timer = setTimeout(() => {
      heldPhoto = isPhoto;
      if (!$('choices').open) menu(m, node);
    }, 520);
  });
  node.addEventListener('click', ev => {
    if (heldPhoto && ev.detail && ev.target.closest('.photo-button')) {
      heldPhoto = false;
      ev.preventDefault();
      ev.stopPropagation();
    }
  }, true);
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
// Adapted from Nyx ta/chat.js scrollToPara / jumpTo: leave the following
// conversation visible below the source and mark the exact message.
function focusSource(row, smooth) {
  row.tabIndex = -1;
  row.focus({ preventScroll: true });
  const viewport = log.getBoundingClientRect();
  const top = log.scrollTop + row.getBoundingClientRect().top - viewport.top - viewport.height / 3;
  const animate = smooth && !matchMedia('(prefers-reduced-motion: reduce)').matches;
  log.scrollTo({ top, behavior: animate ? 'smooth' : 'instant' });
}
async function returnToNote() {
  let note;
  try {
    note = await getNote(requestedNote);
  } catch {
    storeStatus('暂时读不到这张纸条。', returnToNote);
    return;
  }
  if (!note?.source) {
    storeStatus('这张纸条没有可定位的聊天原话。');
    return;
  }
  const source = note.source;
  const message = room.messages.find(m => m.id === source.id);
  if (source.scope !== chatScope || !message || message.from !== source.from || message.ts !== source.ts ||
      (source.thread && source.thread !== (message.meta?.thread || room.thread || 'window'))) {
    storeStatus('这条原话不在当前对话中。留存的摘录在客厅「回头聊」。');
    return;
  }
  const attachments = message.meta?.attachments || [];
  if (message.text !== note.text || attachments.length !== note.attachmentNames.length ||
      attachments.some((a, index) => a.name !== note.attachmentNames[index])) {
    storeStatus('原消息的内容已经变了。收藏时的摘录在客厅「回头聊」。');
    return;
  }
  storeStatus('');
  focusSource(log.querySelector('[data-id="' + message.id + '"]'), false);
}
function build(m) {
  const me = m.from === 'human';
  const row = element('article', 'msg ' + (me ? 'me' : 'ai'));
  if (m.id != null) row.dataset.id = m.id;
  row.dataset.from = m.from;
  row.dataset.ts = m.ts;
  row.setAttribute('aria-label', me ? 'Iris 的消息' : 'Adrian 的消息');
  const byline = element('div', 'msg-byline');
  byline.append(avatarButton(me ? 'iris' : 'adrian'));
  const tools = m.meta.memoryTools ?? (m.meta.memoryTool ? [m.meta.memoryTool] : []);
  const opening = m.meta.openingMemory;
  const refs = (m.meta.sourceRefs || []).filter(ref => typeof ref.excerpt === 'string' && ref.excerpt.trim());
  if (tools.length || opening || refs.length) {
    const caption = tools.some(tool => tool.scope === 'calendar') ? '这次用到的手账记录' : tools.length || opening ? '这次用到的记忆' : '原话摘录';
    const trigger = control(caption,
      event => showMemoryDetails(event.currentTarget, tools, refs, m.meta.archiveMode, opening), 'more');
    trigger.className = 'memory-trigger';
    trigger.setAttribute('aria-haspopup', 'dialog');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', 'memory-details');
    byline.append(trigger);
  }
  row.append(byline);
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
  if (m.id == null) {
    row.append(content);
    return row;
  }
  const actions = element('div', 'message-actions');
  if (me && liveLab && m.meta.retryRequestId) {
    const retry = control('重试这条未完成的消息', () => retryPending(m));
    retry.textContent = '重试回复';
    retry.className = 'pending-retry';
    actions.append(retry);
  }
  if (!me) {
    actions.append(control('复制消息', () => copy(m), 'copy'));
    actions.append(control('重新生成回复', () => retryMessage(m), 'retry'));
    if (m.text) {
      const read = control('朗读消息', event => readAloud(m.text, event.currentTarget), 'read');
      read.setAttribute('aria-pressed', 'false');
      actions.append(read);
    }
  }
  const more = control('更多消息操作', event => menu(m, event.currentTarget), 'more');
  more.setAttribute('aria-haspopup', 'dialog');
  more.setAttribute('aria-controls', 'choices');
  more.setAttribute('aria-expanded', 'false');
  actions.append(more);
  if (!me) actions.append(usageButton(m));
  content.append(actions);
  addGestureMenu(body, m);
  row.append(content);
  return row;
}
function updateComposer() {
  const atBottom = log.scrollHeight - log.clientHeight - log.scrollTop < 4;
  const writing = document.activeElement === say || document.activeElement === picker ||
    !!(say.value || media || quote);
  composer.classList.toggle('is-writing', writing);
  say.style.height = 'auto';
  say.style.height = Math.min(say.scrollHeight + 2, 108) + 'px';
  const ready = !!(say.value.trim() || media);
  $('send').querySelector('use').setAttribute('href', ready ? '#i-send' : '#i-mic');
  $('send').setAttribute('aria-label', ready ? '发送消息' : '使用声音样例');
  attachmentChip.hidden = !media;
  attachmentChip.textContent = media ? '×　' + room.media[media].name : '';
  if (atBottom) log.scrollTop = log.scrollHeight;
}

function draftKey() { return 'haven.room.draft.' + chatScope + '.' + room.thread; }
function saveDraft() {
  if (!room) return;
  const key = draftKey();
  if (say.value || media || quote) {
    const draft = { text: say.value, media, quote };
    drafts.set(key, draft);
    try { sessionStorage.setItem(key, JSON.stringify(draft)); } catch {}
  } else {
    drafts.delete(key);
    try { sessionStorage.removeItem(key); } catch {}
  }
}
function restoreDraft() {
  const key = draftKey();
  let draft = drafts.get(key);
  if (!draft) {
    try { draft = JSON.parse(sessionStorage.getItem(key)); } catch {}
  }
  say.value = draft?.text || '';
  media = room.media[draft?.media] ? draft.media : '';
  setQuote(draft?.quote || null, false);
}

async function showMemoryLab() {
  const { memoryLabExample } = await import('./memory-lab-example.mjs');
  const panel = element('details', 'memory-lab-guide');
  panel.append(element('summary', '', '隔离记忆试验'));
  panel.append(element('p', '', '选一句放入输入框，再点发送。回复由模拟模型生成，记忆工具使用合成测试库。'));
  const actions = element('div', 'lab-examples');
  for (const [key, label] of [['hold', '记下'], ['search', '找回'], ['dream', '做梦']]) {
    actions.append(control(label, () => {
      if (!room || busy) return;
      if (say.value.trim() && !Object.values(memoryLabExample).includes(say.value.trim())) {
        toast('输入框里还有草稿，清空后可以选择示例。');
        return;
      }
      say.value = memoryLabExample[key];
      panel.open = false;
      updateComposer();
      say.focus();
    }));
  }
  panel.append(actions);
  document.querySelector('.chat-date').replaceWith(panel);
  say.placeholder = '从上方选择一句试验消息…';
}
function attach(kind) {
  media = kind;
  updateComposer();
}

function displayConfirmed(additions) {
  log.querySelector('.chat-empty')?.remove();
  for (const message of additions) {
    const index = room.messages.findIndex(previous => previous.id >= message.id);
    if (index < 0) {
      room.messages.push(message);
      log.append(build(message));
      continue;
    }
    const previous = room.messages[index];
    const row = log.querySelector('[data-id="' + previous.id + '"]');
    if (previous.id !== message.id) {
      room.messages.splice(index, 0, message);
      row.before(build(message));
    } else if (previous.meta.retryRequestId) {
      room.messages[index] = message;
      row.replaceWith(build(message));
    }
  }
}

function clearDraft() {
  say.value = '';
  setQuote(null);
  attach('');
  saveDraft();
}

// Render provider deltas on the next paint. Only the final, stored reply gets actions and a receipt.
async function withReplyStream(anchor, request) {
  const row = build({ from: 'ai', text: 'Adrian 正在回复…', ts: new Date().toISOString(), meta: {} });
  row.classList.add('stream-reply', 'waiting');
  row.querySelector('time').remove();
  anchor.after(row);
  const words = row.querySelector('.words');
  const output = document.createTextNode('');
  let frame = 0;
  let pending = '';
  function paint() {
    frame = 0;
    const follow = log.scrollHeight - log.clientHeight - log.scrollTop < 64;
    if (row.classList.contains('waiting')) {
      row.classList.remove('waiting');
      words.replaceChildren(output);
    }
    output.appendData(pending);
    pending = '';
    if (follow) log.scrollTop = log.scrollHeight;
  }
  try {
    return await request(text => {
      pending += text;
      if (!frame) frame = requestAnimationFrame(paint);
    });
  } finally {
    cancelAnimationFrame(frame);
    row.remove();
  }
}

function retryPending(message) {
  return writeChat(async () => {
    const anchor = log.querySelector('[data-id="' + message.id + '"]');
    const additions = await withReplyStream(anchor, onText => chatService.retryPending(message, onText));
    displayConfirmed(additions);
    if (message.text === say.value.trim() && (message.meta.attachments[0]?.kind || '') === media &&
        (message.meta.quote?.id ?? null) === (quote?.id ?? null)) clearDraft();
  }, '还没有收到这条消息的回复。', () => retryPending(message), { allowTyping: true });
}

function send() {
  if (!room || busy) return;
  const text = say.value.trim();
  if (!text && !media) {
    showChoices('声音样例', [['附上本地样音', () => attach('audio')]], $('send'));
    return;
  }
  return sendDraft({ text, media, quote, model: room.model, route: room.route });
}

function sendDraft(draft, previousRow) {
  if (room.model !== draft.model || room.route !== draft.route) {
    toast('请先切回这条消息原来的线路和模型。');
    return;
  }
  let pendingRow;
  const retry = () => sendDraft(draft, pendingRow);
  return writeChat(async () => {
    previousRow?.remove();
    const attachments = draft.media ? [room.media[draft.media]] : [];
    pendingRow = build({ from: 'human', text: draft.text, ts: new Date().toISOString(), meta: { attachments, quote: draft.quote } });
    log.querySelector('.chat-empty')?.remove();
    log.append(pendingRow);
    if (say.value.trim() === draft.text && media === draft.media && quote?.id === draft.quote?.id) clearDraft();
    const sending = withReplyStream(pendingRow, onText => chatService.send(draft.text, draft.media, draft.quote, onText));
    log.scrollTop = log.scrollHeight;
    try {
      const messages = await sending;
      const follow = log.scrollHeight - log.clientHeight - log.scrollTop < 64;
      pendingRow.remove();
      displayConfirmed(messages);
      if (follow) log.scrollTop = log.scrollHeight;
    } catch (error) {
      if (!say.value && !media && !quote) {
        pendingRow.remove();
        say.value = draft.text;
        media = draft.media;
        setQuote(draft.quote, false);
        saveDraft();
      } else {
        const actions = element('div', 'message-actions');
        actions.append(element('small', '', '发送未确认'), control('重试', retry));
        pendingRow.querySelector('.msg-content').append(actions);
      }
      throw error;
    }
  }, '未能确认发送结果，请重试。', retry, { allowTyping: true });
}
quoteChip.onclick = () => setQuote(null);
attachmentChip.onclick = () => attach('');
$('attach').onclick = () => showChoices('添加附件', [
  ['窗边的兔子 · 图片', () => attach('image')], ['声音样例 · 音频', () => attach('audio')]
], $('attach'));
composer.onsubmit = ev => { ev.preventDefault(); send(); };
$('send').addEventListener('pointerdown', event => {
  if (document.activeElement === say) event.preventDefault();
});
say.oninput = updateComposer;
say.addEventListener('focus', updateComposer);
composer.addEventListener('focusout', event => {
  if (!composer.contains(event.relatedTarget)) requestAnimationFrame(updateComposer);
});
window.addEventListener('pagehide', saveDraft);
if (touchInput) say.setAttribute('enterkeyhint', 'enter');
say.onkeydown = ev => {
  if (ev.key === 'Enter' && !ev.shiftKey && !touchInput && !ev.isComposing && ev.keyCode !== 229) {
    ev.preventDefault();
    if (say.value.trim() || media) send();
  }
};
function liveEmptyMessage() {
  if (room.anniversaryTrial) return '这个窗口可以核对你们的纪念日。';
  return room.memoryScope === 'personal' ? '跟阿川说句话吧。' : '写下一个虚构的小故事，下一轮可以接着聊。';
}
function showLiveMemoryScope() {
  const label = room.anniversaryTrial ? '纪念日试聊' : room.memoryScope === 'personal' ? 'Ombre 真实库' :
    room.memoryScope === 'synthetic' ? 'Ombre 隔离库' : '本机试聊';
  const list = element('a', 'tools-link', '工具清单');
  list.href = '/other/?thread=' + encodeURIComponent(room.thread) + '#tools';
  document.querySelector('.chat-date').replaceChildren((room.routeLabel || room.model) + ' · ' + label, list);
  log.setAttribute('aria-label', '与 Adrian 的对话 · ' + label);
  say.placeholder = room.anniversaryTrial ? '问问阿川我们的纪念日…' :
    room.memoryScope === 'synthetic' ? '写一句合成测试消息…' : '写给 Adrian…';
  const empty = log.querySelector('.chat-empty');
  if (empty) empty.textContent = liveEmptyMessage();
}
if (liveLab) document.addEventListener('visibilitychange', async () => {
  const target = room;
  if (document.hidden || !target) return;
  const current = await chatService.routes().catch(() => null);
  if (!current || room !== target || current.thread !== target.thread || current.route !== target.route || current.model !== target.model) return;
  target.memoryScope = current.memoryScope;
  target.anniversaryTrial = current.anniversaryTrial;
  showLiveMemoryScope();
});
async function loadRoom({ select, create = false, locateNote = false } = {}) {
  if (busy) return;
  saveDraft();
  dismissPanel();
  if ($('window-drawer').open) $('window-drawer').close();
  stopReading();
  playing?.pause();
  playing = null;
  setBusy(true);
  log.setAttribute('aria-busy', 'true');
  storeStatus(chatService.persistent ? '正在读取本机对话…' : '');
  let selected = false;
  try {
    if (create) select = (await chatService.createWindow()).id;
    if (select) {
      await chatService.openWindow(select);
      selected = true;
    }
    room = await chatService.room();
    document.querySelector('#room-nav a[href^="/other/"]').href = '/other/?thread=' + encodeURIComponent(room.thread);
    restoreDraft();
    if (memoryLab) {
      if (!document.querySelector('.memory-lab-guide')) await showMemoryLab();
    } else if (liveLab) {
      showLiveMemoryScope();
    } else if (providerLab) {
      document.querySelector('.chat-date').textContent = 'Gateway · 旧家园合成 API';
      say.placeholder = '写一句合成测试消息…';
    } else {
      $('room-date').dateTime = room.date.toLocaleDateString('sv-SE');
      $('room-date').textContent = room.date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
      if (chatService.persistent) say.placeholder = '写一条本机测试消息…';
    }
    log.replaceChildren();
    for (const message of room.messages) log.append(build(message));
    if (!room.messages.length) log.append(element('p', 'chat-empty',
      liveLab ? liveEmptyMessage() :
        memoryLab ? '点上方「隔离记忆试验」，从「记下」开始。' : providerLab
        ? '发一句测试消息，再问「Winterfern 灯塔的标记是什么？」'
        : '写给 Adrian…'));
    displayModels();
    if (liveLab && room.catalogReady === false && room.hasKey) refreshChatModels();
    renderContext(room);
    const issue = issues.get(room.thread);
    storeStatus(issue?.message || '', issue?.retry);
    if (locateNote && requestedNote !== null) await returnToNote();
    else if (room.messages.length > 5 || chatService.persistent) requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });
    else log.scrollTop = 0;
  } catch (error) {
    if ((!select && !create) || selected || !room) {
      room = null;
      log.replaceChildren();
      say.value = media = '';
      setQuote(null, false);
    }
    const message = create && !select ? '未能确认新窗口，请从窗口列表查看。' : '暂时读不到这个聊天窗口。';
    storeStatus(error.notice || message, select || !create ? () => loadRoom({ select, locateNote }) : null);
  } finally {
    log.setAttribute('aria-busy', 'false');
    setBusy(false);
  }
}
function displayModels() {
  picker.replaceChildren(...room.models.map(model => new Option(model, model)));
  if (liveLab && room.route !== 'mock' && room.catalogReady !== undefined) {
    if (!room.models.includes(room.model)) {
      const missing = new Option('请选择回复模型', room.model);
      missing.disabled = true;
      picker.prepend(missing);
    }
    const more = document.createElement('optgroup');
    more.label = '线路';
    const refresh = new Option('刷新模型列表', '');
    refresh.dataset.refresh = 'true';
    more.append(refresh);
    picker.append(more);
  }
  picker.value = room.model;
}

let catalogLoading;
async function refreshChatModels() {
  const target = room;
  if (!target || catalogLoading === target) return;
  catalogLoading = target;
  try {
    const state = await chatService.refreshModels({ route: target.route });
    if (room !== target) return;
    if (state.route !== room.route) {
      storeStatus('线路已在其他页面切换，请重新读取。', () => loadRoom());
      return;
    }
    const directory = state.routes.find(entry => entry.id === target.route);
    target.models = directory.models;
    target.catalogReady = directory.catalogReady;
    displayModels();
    toast('已读取 ' + directory.models.length + ' 个模型');
  } catch (error) {
    if (room === target) toast(error.notice || '暂时读不到模型目录，请到杂物间核对线路。');
  } finally {
    if (catalogLoading === target) catalogLoading = null;
  }
}

function changeModel(value) {
  return writeChat(async () => {
    const selected = await chatService.selectModel(value);
    room.model = value;
    if (liveLab) { Object.assign(room, selected); showLiveMemoryScope(); }
  }, '模型的选择尚未确认。', () => changeModel(value), { preserveIssue: true });
}
picker.onchange = () => {
  say.focus({ preventScroll: true });
  if (picker.selectedOptions[0]?.dataset.refresh) {
    picker.value = room.model;
    refreshChatModels();
    return;
  }
  changeModel(picker.value);
};

const drawer = $('window-drawer');
let listVersion = 0;
async function showWindows() {
  if (busy) return;
  dismissPanel();
  const list = $('window-list');
  const version = ++listVersion;
  list.textContent = '正在读取窗口…';
  if (!drawer.open) drawer.showModal();
  $('open-windows').setAttribute('aria-expanded', 'true');
  try {
    const windows = await chatService.windows();
    if (version !== listVersion || !drawer.open) return;
    list.replaceChildren(...windows.map(({ id, title }) => {
      const button = control(title || '新窗口', () => loadRoom({ select: id }));
      if (id === room?.thread) button.setAttribute('aria-current', 'true');
      return button;
    }));
    if (!windows.length) list.textContent = '还没有已保存的窗口。';
  } catch {
    if (version === listVersion && drawer.open) list.replaceChildren(control('重新读取窗口', showWindows));
  }
}
$('open-windows').onclick = showWindows;
$('close-windows').onclick = () => drawer.close();
drawer.addEventListener('close', () => $('open-windows').setAttribute('aria-expanded', 'false'));
drawer.addEventListener('click', event => {
  if (event.target !== drawer) return;
  const bounds = drawer.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) drawer.close();
});
$('new-window').onclick = () => loadRoom({ create: true });

const budget = $('context-budget');
const cache = $('cache-mode');
const defaultKey = $('default-window-key');
for (const limit of [1024, 4096, 8192, 16384, 32768]) budget.add(new Option(limit.toLocaleString('zh-CN'), limit));
budget.add(new Option('不限制', 0));
cache.add(new Option('跟随线路', 'auto'));
cache.add(new Option('发送窗口键', 'window'));
cache.add(new Option('不发送窗口键', 'provider'));
function renderContext(state) {
  if (!state) return;
  budget.value = state.contextBudget;
  cache.value = state.cacheMode;
  defaultKey.checked = state.defaultWindowKey === true;
  $('cache-controls').hidden = !state.cacheCapabilities?.windowKey;
  $('cache-unavailable').hidden = !!state.cacheCapabilities?.windowKey;
}
function changeContext(settings) {
  return writeChat(async () => {
    await chatService.setContext(settings);
    Object.assign(room, settings);
  }, '窗口设置尚未保存。', () => changeContext(settings), { preserveIssue: true }).finally(() => renderContext(room));
}
budget.onchange = cache.onchange = () => changeContext({ contextBudget: Number(budget.value), cacheMode: cache.value });
let lineRevision = 0;
async function refreshLineDefault() {
  if (!room?.cacheCapabilities?.windowKey || !$('settings').open || !$('context-settings').open) return;
  const active = room;
  const revision = ++lineRevision;
  try {
    const enabled = await chatService.defaultWindowKey();
    if (room === active && revision === lineRevision) defaultKey.checked = room.defaultWindowKey = enabled;
  } catch { /* Keep the last configuration confirmed by the gateway. */ }
}
function changeLineDefault(enabled) {
  lineRevision++;
  return writeChat(async () => {
    await chatService.setDefaultWindowKey(enabled);
    room.defaultWindowKey = enabled;
  }, '线路默认设置尚未保存。', () => changeLineDefault(enabled), { preserveIssue: true }).finally(() => renderContext(room));
}
defaultKey.onchange = () => changeLineDefault(defaultKey.checked);
$('context-settings').ontoggle = () => { positionPanel(); refreshLineDefault(); };
$('options').onclick = () => { openPanel($('settings'), $('options')); refreshLineDefault(); };

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
loadRoom({ locateNote: true });
window.addEventListener('pageshow', event => {
  if (event.persisted && chatService.persistent && !busy) loadRoom();
});

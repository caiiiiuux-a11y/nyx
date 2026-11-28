// The public preview uses synthetic messages and packaged media. Only HTML served
// by the private local gateway opts into its persistent adapter.
import { assets, models } from './catalog.mjs';
import { windowLocation } from './window-location.js';

const localGateway = globalThis.document?.documentElement.dataset.chatStore === 'gateway';
const sessionKey = 'haven.room.demo.v1';
const examples = [
  ['human', '今天的云很漂亮，\n想分一点给你。', '10:27'],
  ['ai', '我在窗边看到了。\n也想听听你的声音。', '10:28'],
  ['ai', '', '10:29', 'audio'],
  ['human', '那就给你留一句，\n今天也很想你。', '10:30'],
  ['human', '', '10:30', 'image']
];
const replies = [
  '我把靠窗的位置给你留着。坐一会儿吧，等那朵云慢慢走过去。',
  '窗台上刚好有一小块阳光，我想把它留给你。你可以慢慢说，我会把你写下来的每一句都读完。等到天色暗下来，我们再一起把窗帘拉上。'
];
// On devices without an installed Mandarin voice, play the offline recording
// for this exact mock message (including messages restored from sessionStorage).
const recordedReadings = new Map([
  [examples[1][1], '/room/assets/read-0.mp3'],
  [replies[0], '/room/assets/read-1.mp3'],
  [replies[1], '/room/assets/read-2.mp3']
]);
const today = new Date();
const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
const timeToday = time => {
  const d = new Date(midnight);
  const [h, m] = time.split(':').map(Number);
  d.setHours(h, m);
  return d.toISOString();
};
const initial = examples.map(([from, text, time, media], i) => ({
  id: i + 1, from, text, ts: timeToday(time),
  meta: {
    ...(from === 'ai' && { speaker: 'Adrian', provider: 'mock', model: models[0], thread: 'window', fallback: false }),
    attachments: media ? [assets[media]] : []
  }
}));
function createPreview() {
  const active = windowLocation('haven.preview.last-window.v1');
  const prefix = 'haven.preview.window.v2.';
  const scratch = new Map();
  const now = () => new Date().toISOString();

  function save(room) {
    scratch.set(room.id, room);
    try { localStorage.setItem(prefix + room.id, JSON.stringify(room)); } catch { /* In-memory fallback. */ }
  }
  function read(id = active.id) {
    try {
      const stored = JSON.parse(localStorage.getItem(prefix + id));
      if (stored?.id === id && Array.isArray(stored.messages)) return stored;
    } catch { /* In-memory fallback. */ }
    return scratch.get(id);
  }
  function record(id, title) {
    return { id, title, created: now(), updated: now(), messages: [], model: models[0],
      contextBudget: 8192, cacheMode: 'auto' };
  }
  if (!read('window')) {
    const original = record('window', '窗边的对话');
    original.messages = initial;
    try {
      const saved = JSON.parse(sessionStorage.getItem(sessionKey));
      if (Array.isArray(saved?.messages) && models.includes(saved.model)) {
        original.messages = saved.messages;
        original.model = saved.model;
      }
    } catch { /* Older previews only saved this tab. */ }
    save(original);
  }
  function room() {
    const current = read();
    if (!current) throw new Error('找不到这个窗口，请打开对话列表重新选择。');
    return current;
  }
  function summary({ id, title, created, updated }) { return { id, title, created, updated }; }
  function reply(current, id, text) {
    return { id, text, from: 'ai', ts: now(), meta: {
      speaker: 'Adrian', provider: 'mock', model: current.model, thread: current.id, fallback: false, attachments: []
    } };
  }
  return {
    windows() {
      const ids = new Set(scratch.keys());
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key?.startsWith(prefix)) ids.add(key.slice(prefix.length));
        }
      } catch { /* Only this page's windows are available. */ }
      return [...ids].map(read).filter(Boolean).map(summary).sort((a, b) => b.updated.localeCompare(a.updated));
    },
    createWindow() {
      const next = record(crypto.randomUUID(), '新窗口');
      save(next);
      return summary(next);
    },
    openWindow(id) { active.select(id); },
    room() {
      const current = room();
      if (!new URL(location.href).searchParams.has('thread')) active.select(current.id, false);
      return { ...current, thread: current.id, messages: [...current.messages], models, date: midnight, media: assets, usage: null };
    },
    selectModel(value) {
      if (!models.includes(value)) throw new Error('模型不可用');
      const current = room();
      save({ ...current, model: value });
    },
    setContext(settings) { save({ ...room(), contextBudget: settings.contextBudget, cacheMode: settings.cacheMode }); },
    send(text, media, quote) {
      const current = room();
      const id = (current.messages.at(-1)?.id || 0) + 1;
      const human = { id, from: 'human', text, ts: now(), meta: {
        thread: current.id, attachments: media ? [assets[media]] : [], quote
      } };
      let answer = replies[id % replies.length];
      let source;
      if (/(读到|看到).{0,8}(哪|几页)/u.test(text)) {
        // A small, deterministic example demonstrates recall even in the offline preview.
        for (const other of [current, ...this.windows().filter(w => w.id !== current.id).map(w => read(w.id))]) {
          for (const message of [...other.messages].reverse()) {
            const match = message.from === 'human' && /(?:读到|看到)了?\s*第?\s*(\d{1,6})\s*页/u.exec(message.text);
            if (match) {
              source = { thread: other.id, messageId: message.id, excerpt: message.text, start: 0, end: message.text.length };
              answer = '上次读到第 ' + match[1] + ' 页。';
              break;
            }
          }
          if (source) break;
        }
        if (!source) answer = '最近的对话里还没有记下页码。';
      }
      const response = reply(current, id + 1, answer);
      if (source) response.meta.sourceRefs = [source];
      const added = [human, response];
      if (!current.messages.length && text.trim()) current.title = [...text.trim()].slice(0, 22).join('');
      current.messages.push(...added);
      current.updated = now();
      save(current);
      return added;
    },
    regenerate(id) {
      const current = room();
      const index = current.messages.findIndex(m => m.id === id && m.from === 'ai');
      if (index < 0) return;
      const old = current.messages[index];
      const audio = old.meta.attachments.some(a => a.kind === 'audio');
      const next = reply(current, id, audio ? old.text : replies[(replies.indexOf(old.text) + 1) % replies.length]);
      if (audio) next.meta.attachments = [...old.meta.attachments];
      current.messages[index] = next;
      current.updated = now();
      save(current);
      return next;
    }
  };
}

const adapter = localGateway
  ? (await import('./gateway-adapter.js')).createGatewayChat(assets)
  : createPreview();
export const chatService = {
  ...adapter,
  readingFor(text) { return recordedReadings.get(text); }
};

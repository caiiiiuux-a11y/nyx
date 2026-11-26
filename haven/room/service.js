// Only synthetic messages and packaged media. Implements the subset of Nyx message fields
// used by the preview so a future adapter can supply the same view model.
const assets = {
  image: { kind: 'image', name: '窗边的兔子', src: '/room/assets/chat-photo.webp' },
  audio: { kind: 'audio', name: '声音样例', src: '/room/assets/sample.mp3' }
};
const models = ['云杉', '月桂'];
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
let messages = initial;
let model = models[0];
try {
  const saved = JSON.parse(sessionStorage.getItem(sessionKey));
  if (saved && Array.isArray(saved.messages) && saved.date === midnight.getTime() && models.includes(saved.model)) {
    messages = saved.messages;
    model = saved.model;
  }
} catch { /* Storage is optional for an offline preview. */ }
function persist() {
  try { sessionStorage.setItem(sessionKey, JSON.stringify({ date: midnight.getTime(), messages, model })); }
  catch { /* A full or unavailable store leaves this tab usable. */ }
}
function reply(id, text) {
  return { id, text, from: 'ai', ts: new Date().toISOString(), meta: {
    speaker: 'Adrian', provider: 'mock', model, thread: 'window', fallback: false, attachments: []
  } };
}

export const chatService = {
  room() { return { messages: [...messages], model, models, date: midnight, media: assets }; },
  selectModel(value) {
    if (!models.includes(value)) throw new Error('模型不可用');
    model = value;
    persist();
  },
  send(text, media, quote) {
    const id = messages.at(-1).id + 1;
    const human = { id, from: 'human', text, ts: new Date().toISOString(), meta: {
      attachments: media ? [assets[media]] : [], quote
    } };
    const added = [human, reply(id + 1, replies[id % replies.length])];
    messages.push(...added);
    persist();
    return added;
  },
  regenerate(id) {
    const index = messages.findIndex(m => m.id === id && m.from === 'ai');
    if (index < 0) return;
    const old = messages[index];
    const next = replies[(replies.indexOf(old.text) + 1) % replies.length];
    const updated = reply(id, next);
    messages[index] = updated;
    persist();
    return updated;
  }
};

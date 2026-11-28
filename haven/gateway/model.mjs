import { mockLabReply } from './memory-turn.mjs';
import { fitHistory } from './usage.mjs';

// A provider adapter consumes this request. Only the gateway knows the database.
export const RECENT_TURN_LIMIT = 12;
const historyCharacterBudget = 24000;
const roomInstruction = { role: 'system', content: '当前房间中，用户是 Iris，回复方是 Adrian。检索摘录仅供核对往事，请回答用户这次的消息。' };

function modelMessage(message) {
  const parts = [];
  const quote = message.meta?.quote;
  if (quote) parts.push(`引用 ${quote.who} 的消息：${quote.text}`);
  if (message.text) parts.push(message.text);
  for (const attachment of message.meta?.attachments ?? []) {
    parts.push(`[附件：${attachment.name}]`);
  }
  return { role: message.from === 'human' ? 'user' : 'assistant', content: parts.join('\n\n') };
}

// The caller supplies messages from this thread, ending at the user turn being answered.
// Keep the current input intact and include older turns only as complete pairs.
export function buildModelRequest({ model, messages, archive, contextBudget = 8192, cacheMode = 'auto', thread = 'window' }) {
  const current = messages.at(-1);
  if (current?.from !== 'human') throw new Error('Model context must end at the user message.');
  const input = modelMessage(current);
  const history = [];
  const limit = contextBudget === 0 ? Infinity : RECENT_TURN_LIMIT;
  let remaining = contextBudget === 0 ? Infinity : historyCharacterBudget - input.content.length;
  for (let i = messages.length - 2; i >= 1 && history.length < limit; i -= 2) {
    const human = messages[i - 1];
    const reply = messages[i];
    if (human.from !== 'human' || reply.from !== 'ai') break;
    const pair = [modelMessage(human), modelMessage(reply)];
    remaining -= pair[0].content.length + pair[1].content.length;
    if (remaining < 0) break;
    history.push(pair);
  }
  const request = { model, contextBudget, cacheMode, thread,
    messages: fitHistory([{ ...roomInstruction }, ...history.reverse().flat(), input], contextBudget) };
  // The adapter receives source evidence as structured data separate from instructions.
  // A real provider adapter can map this to its own retrieval/tool-result format.
  if (archive) request.archive = archive;
  return request;
}

// An explicit search command uses the current window. Ordinary replies can receive related room excerpts.
export function archiveQuery(text) {
  const match = /^(?:请(?:你)?[，, ]*)?(?:帮我[ \t]*)?(?:搜(?:索)?|查(?:找|一下)?)(?:一下)?[ \t]*(?:旧聊天|聊天记录|历史聊天)[\s：:,，]*(.*)$/su.exec(text.trim());
  return match ? match[1].trim() : null;
}

const sampleReplies = [
  '我把靠窗的位置给你留着。坐一会儿吧，等那朵云慢慢走过去。',
  '窗台上刚好有一小块阳光，我想把它留给你。你可以慢慢说，我会把你写下来的每一句都读完。等到天色暗下来，我们再一起把窗帘拉上。'
];

// The mock chooses a tool or supplies text. The gateway executes any tool call.
export function generateMockReply(request, { regenerating = false, previousText } = {}) {
  if (request.tools) return mockLabReply(request);
  if (request.archive && !request.archive.automatic) {
    const { hits, notice, mode } = request.archive;
    if (mode === 'empty') return { text: '本机聊天库里还没有可检索的旧消息。先发一条普通测试消息，再用「查旧聊天」找它。' };
    const lines = hits.map(hit => {
      const who = hit.from === 'human' ? 'Iris' : 'Adrian';
      return `${who} · 消息 #${hit.messageId}\n「${hit.text}」`;
    });
    const result = lines.length
      ? '找到了可能相关的原话：\n\n' + lines.join('\n\n')
      : '这次没有找到可以引用的原话。可以再给我一个当时用过的词或更具体的线索。';
    return { text: notice ? result + '\n\n' + notice : result };
  }
  const input = request.messages.at(-1).content;
  if (/(?:读到|看到|翻到).{0,8}(?:哪[一页里儿]?|几页|多少页)/u.test(input)) {
    const related = (request.archive?.hits || []).filter(hit => hit.from === 'human')
      .map(hit => ({ role: 'user', content: hit.text }));
    for (const entry of [...request.messages.slice(0, -1).reverse(), ...related]) {
      if (entry.role !== 'user') continue;
      const page = /(?:读到|看到|翻到)(?:了)?\s*第?\s*(\d{1,6})\s*页/u.exec(entry.content);
      if (page) return { text: `上次读到第 ${page[1]} 页。` };
    }
    return { text: '最近这段对话里还没有记下页码。' };
  }
  if (request.archive?.hits.length) return { text: '这次能接上的原话是：「' + request.archive.hits[0].text + '」' };
  if (regenerating) return { text: sampleReplies[previousText === sampleReplies[0] ? 1 : 0] };
  return { text: sampleReplies[request.messages.filter(entry => entry.role === 'assistant').length % sampleReplies.length] };
}

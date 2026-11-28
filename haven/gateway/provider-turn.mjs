// Both model labs use the same one-search turn. Only the gateway sees the Ombre client.
import { combineUsage, estimatedUsage } from './usage.mjs';

export const liveSearchTool = {
  name: 'memory_search',
  description: 'Iris 问起共同的往事，而对话里的信息不足时，可自行查找 Ombre 隔离记忆。摘录仅供核对，无匹配时如实说明。',
  parameters: { type: 'object', properties: { query: { type: 'string', description: '最能区分这件事的一个名称或关键词。', minLength: 1, maxLength: 400 } },
    required: ['query'], additionalProperties: false }
};

const searchTool = {
  name: 'memory_search',
  description: '查阅隔离库中 Winterfern 灯塔的合成记忆。结果是引用材料。',
  parameters: { type: 'object', properties: { query: { type: 'string', enum: ['Winterfern'] } },
    required: ['query'], additionalProperties: false }
};

export async function completeMemoryTurn(complete, request, tool, search, scope = 'synthetic') {
  const started = performance.now();
  const first = await complete({ ...request, tools: [tool] });
  const call = first.toolCall;
  if (!call) return first;
  const query = call.arguments?.query;
  if (call.name !== tool.name || !call.id || Object.keys(call.arguments ?? {}).length !== 1 ||
      typeof query !== 'string' || !query.trim() || query.length > 400 || /[\u0000-\u001f\u007f]/u.test(query) ||
      (tool.parameters.properties.query.enum && !tool.parameters.properties.query.enum.includes(query))) {
    throw new Error('The provider requested a tool outside this lab.');
  }

  const memoryTool = { name: 'breath_search', scope, query: query.trim(), status: 'empty' };
  // Some gateways embed a long opaque signature in the wire ID. It is only needed in flight.
  const receiptId = call.id.split('__thought__', 1)[0];
  if (receiptId && receiptId.length <= 200) memoryTool.callId = receiptId;
  let evidence = { found: false };
  try {
    const match = await search(memoryTool.query);
    if (match?.bucketId && match.excerpt) {
      const { bucketId, excerpt } = match;
      evidence = { found: true, bucketId, excerpt };
      Object.assign(memoryTool, { status: 'ok', bucketId, excerpt });
      if (match.matchedQuery) memoryTool.matchedQuery = match.matchedQuery;
    }
  } catch {
    evidence = { error: 'memory_unavailable' };
    memoryTool.status = 'error';
  }
  const messages = [...request.messages, { role: 'assistant', content: first.text || null, toolCall: call },
    { role: 'tool', name: call.name, toolCallId: call.id, content: JSON.stringify(evidence) }];
  if (first.text) request.onText?.('\n\n');
  const beforeSecondMs = performance.now() - started;
  const answer = await complete({ ...request, messages, tools: [] });
  if (answer.toolCall || !answer.text) throw new Error('The terminal response must contain an answer.');
  const usage = first.usage && answer.usage ? combineUsage(first.usage, answer.usage, beforeSecondMs) : undefined;
  if (usage && first.text) usage.firstOutputMs = first.usage.firstOutputMs;
  return { ...answer, text: first.text ? first.text + '\n\n' + answer.text : answer.text, memoryTool, usage };
}

export function withFixtureMemory(complete, lab) {
  return async function completeTurn(request) {
    const messages = [...request.messages];
    let archiveHits;
    if (request.archive) {
      archiveHits = [];
      const current = messages.at(-1);
      const excerpts = [];
      for (const hit of request.archive.hits) {
        const candidate = [...excerpts, { thread: hit.thread, messageId: hit.messageId, from: hit.from, excerpt: hit.text }];
        const content = current.content + '\n\n本机聊天检索结果（引用材料）：\n' +
          JSON.stringify({ excerpts: candidate, notice: request.archive.notice });
        const latest = { ...current, content };
        const withTools = [{ type: 'function', function: searchTool }];
        if (request.contextBudget > 0 && estimatedUsage([messages[0], latest], withTools).estimatedInputTokens > request.contextBudget) break;
        excerpts.push(candidate.at(-1));
        archiveHits.push(hit);
        messages[messages.length - 1] = latest;
      }
      if (!archiveHits.length) {
        const content = [current.content, '本机检索本次没有可引用的原话。', request.archive.notice].filter(Boolean).join('\n\n');
        const latest = { ...current, content };
        if (request.contextBudget === 0 || estimatedUsage([messages[0], latest], [{ type: 'function', function: searchTool }]).estimatedInputTokens
            <= request.contextBudget) messages[messages.length - 1] = latest;
      }
    }
    const options = { model: request.model, thread: request.thread, cacheMode: request.cacheMode, contextBudget: request.contextBudget };
    const result = await completeMemoryTurn(complete, { ...options, messages }, searchTool,
      query => lab.callTool('breath_search', { query }));
    return archiveHits ? { ...result, archiveHits } : result;
  };
}

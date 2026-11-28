// The model can request the old home's one searchable fixture. Only the
// gateway sees the Ombre client; the provider receives the matched excerpt.
import { combineUsage, estimatedUsage } from './usage.mjs';

const searchTool = {
  name: 'memory_search',
  description: '查阅隔离库中 Winterfern 灯塔的合成记忆。结果是引用材料。',
  parameters: { type: 'object', properties: { query: { type: 'string', enum: ['Winterfern'] } },
    required: ['query'], additionalProperties: false }
};

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
        if (estimatedUsage([messages[0], latest], withTools).estimatedInputTokens > request.contextBudget) break;
        excerpts.push(candidate.at(-1));
        archiveHits.push(hit);
        messages[messages.length - 1] = latest;
      }
      if (!archiveHits.length) {
        const content = [current.content, '本机检索本次没有可引用的原话。', request.archive.notice].filter(Boolean).join('\n\n');
        const latest = { ...current, content };
        if (estimatedUsage([messages[0], latest], [{ type: 'function', function: searchTool }]).estimatedInputTokens
            <= request.contextBudget) messages[messages.length - 1] = latest;
      }
    }
    const options = { model: request.model, thread: request.thread, cacheMode: request.cacheMode, contextBudget: request.contextBudget };
    const result = await complete({ ...options, messages, tools: [searchTool] });
    if (!result.toolCall) return archiveHits ? { ...result, archiveHits } : result;
    const call = result.toolCall;
    if (call.name !== searchTool.name || !call.id || call.arguments?.query !== 'Winterfern' ||
        Object.keys(call.arguments).length !== 1) {
      throw new Error('The provider requested a tool outside this lab.');
    }
    const memoryTool = { name: 'breath_search', callId: call.id, status: 'ok' };
    let evidence;
    try {
      const match = await lab.callTool('breath_search', call.arguments);
      evidence = { found: Boolean(match.bucketId && match.excerpt) };
      if (evidence.found) {
        evidence.bucketId = memoryTool.bucketId = match.bucketId;
        evidence.excerpt = memoryTool.excerpt = match.excerpt;
      }
    } catch {
      evidence = { error: 'memory_unavailable' };
      memoryTool.status = 'error';
    }
    messages.push({ role: 'assistant', content: result.text || null, toolCall: call },
      { role: 'tool', name: call.name, toolCallId: call.id, content: JSON.stringify(evidence) });
    const answer = await complete({ ...options, messages, tools: [] });
    if (answer.toolCall) throw new Error('The terminal response must contain an answer.');
    const usage = result.usage && answer.usage ? combineUsage(result.usage, answer.usage) : undefined;
    return { text: answer.text, memoryTool, ...(usage && { usage }), ...(archiveHits && { archiveHits }) };
  };
}

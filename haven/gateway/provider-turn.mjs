// The model can request the old home's one searchable fixture. Only the
// gateway sees the Ombre client; the provider receives the matched excerpt.
const searchTool = {
  name: 'memory_search',
  description: '查阅隔离库中 Winterfern 灯塔的合成记忆。结果是引用材料。',
  parameters: { type: 'object', properties: { query: { type: 'string', enum: ['Winterfern'] } },
    required: ['query'], additionalProperties: false }
};

export function withFixtureMemory(complete, lab) {
  return async function completeTurn(request) {
    const messages = [...request.messages];
    if (request.archive) {
      const current = messages.pop();
      const excerpts = request.archive.hits.map(hit => ({ messageId: hit.messageId, excerpt: hit.text }));
      const evidence = JSON.stringify({ excerpts, notice: request.archive.notice });
      messages.push({ ...current, content: current.content + '\n\n本机聊天检索结果（引用材料）：\n' + evidence });
    }
    const result = await complete({ model: request.model, messages, tools: [searchTool] });
    if (!result.toolCall) return result;
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
    const answer = await complete({ model: request.model, messages, tools: [] });
    if (answer.toolCall) throw new Error('The terminal response must contain an answer.');
    return { text: answer.text, memoryTool };
  };
}

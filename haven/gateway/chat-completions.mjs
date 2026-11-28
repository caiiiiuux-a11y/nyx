// Server-side adapter for the streaming Chat Completions wire format.
// The Gateway owns the transcript, permissions, and execution of tool calls.
import { estimatedUsage, fitHistory, providerUsage } from './usage.mjs';

const maxResponseBytes = 2 * 1024 * 1024;

function invalidResponse() {
  return new Error('模型服务返回的内容不完整或格式不兼容');
}

function wireMessage(message) {
  if (message.role === 'tool') {
    if (!message.toolCallId) throw new Error('工具结果缺少调用编号');
    return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
  }
  if (message.role === 'assistant' && message.toolCall) {
    const { id, name, arguments: args } = message.toolCall;
    if (!id || !name) throw new Error('缺少模型请求的工具或调用编号');
    return {
      role: 'assistant', content: message.content ?? null,
      tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }]
    };
  }
  return { role: message.role, content: message.content };
}

async function* eventData(body) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let partial = '';
  let skipLF = false;
  let data = [];
  let size = 0;
  for await (const bytes of body) {
    size += bytes.byteLength;
    if (size > maxResponseBytes) throw invalidResponse();
    let block = decoder.decode(bytes, { stream: true });
    if (!block) continue;
    // A CRLF can itself be split across packets.
    if (skipLF && block.startsWith('\n')) block = block.slice(1);
    if (!block) { skipLF = false; continue; }
    skipLF = block.endsWith('\r');
    const lines = block.split(/\r\n|\r|\n/);
    lines[0] = partial + lines[0];
    partial = lines.pop();
    for (const line of lines) {
      if (!line && data.length) {
        yield data.join('\n');
        data = [];
      } else if (line.startsWith('data:')) {
        data.push(line.slice(5).replace(/^ /, ''));
      }
    }
  }
  decoder.decode();
}

async function readCompletion(body, model, tools, usage) {
  let text = '';
  let call;
  let finish;
  for await (const data of eventData(body)) {
    if (data === '[DONE]') {
      if (finish === 'stop' && !call && text.trim()) return { text };
      if (finish !== 'tool_calls' || !call?.id.trim() || !tools.some(tool => tool.name === call.name)) {
        throw invalidResponse();
      }
      const args = JSON.parse(call.arguments);
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw invalidResponse();
      const toolCall = { id: call.id, name: call.name, arguments: args };
      return text ? { text, toolCall } : { toolCall };
    }
    const chunk = JSON.parse(data);
    if (chunk.error || (chunk.model !== undefined && chunk.model !== model) || !Array.isArray(chunk.choices)) {
      throw invalidResponse();
    }
    // Providers may send a final usage-only chunk after the choice is finished.
    if (chunk.usage && typeof chunk.usage === 'object') Object.assign(usage, providerUsage(chunk.usage));
    if (!chunk.choices.length) continue;
    const [choice] = chunk.choices;
    if (chunk.choices.length !== 1 || (choice.index ?? 0) !== 0 || finish) throw invalidResponse();
    const delta = choice.delta;
    if (delta.content != null) {
      if (typeof delta.content !== 'string') throw invalidResponse();
      text += delta.content;
    }
    if (delta.tool_calls != null) {
      if (!Array.isArray(delta.tool_calls) || delta.tool_calls.length !== 1) throw invalidResponse();
      const [fragment] = delta.tool_calls;
      if (fragment.index !== 0 || (fragment.type != null && fragment.type !== 'function')) throw invalidResponse();
      call ??= { id: '', name: '', arguments: '' };
      if (fragment.id != null) {
        if (typeof fragment.id !== 'string' || (call.id && call.id !== fragment.id)) throw invalidResponse();
        call.id = fragment.id;
      }
      for (const key of ['name', 'arguments']) {
        const value = fragment.function?.[key];
        if (value != null) {
          if (typeof value !== 'string') throw invalidResponse();
          call[key] += value;
        }
      }
    }
    finish = choice.finish_reason;
  }
  throw invalidResponse();
}

export function createChatCompletions({ baseURL, apiKey, fetchImpl = fetch }) {
  const endpoint = new URL(baseURL);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      !(endpoint.protocol === 'https:' || (endpoint.protocol === 'http:' && loopback))) {
    throw new Error('模型服务地址无效');
  }
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, '') + '/chat/completions';
  return async function complete({ model, messages, tools = [], contextBudget = 8192, cacheMode = 'auto', thread = 'window' }) {
    const definitions = tools.map(({ name, description, parameters }) => ({
      type: 'function', function: { name, description, parameters }
    }));
    const outgoing = fitHistory(messages.map(wireMessage), contextBudget, definitions);
    const usage = estimatedUsage(outgoing, definitions);
    const payload = { model, messages: outgoing, stream: true, stream_options: { include_usage: true } };
    if (definitions.length) payload.tools = definitions;
    if (cacheMode === 'window') payload.prompt_cache_key = 'haven-' + thread;
    const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
    if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
    const response = await fetchImpl(endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60_000), headers, body: JSON.stringify(payload)
    }).catch(() => { throw new Error('连接模型服务失败'); });
    if (!response.ok || !response.body || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'text/event-stream') {
      await response.body?.cancel();
      throw new Error('模型服务未返回可用的事件流（HTTP ' + response.status + '）');
    }
    // Neither a supplier error body nor a JSON parser error should reach the transcript.
    const result = await readCompletion(response.body, model, tools, usage).catch(() => { throw invalidResponse(); });
    return { ...result, usage };
  };
}

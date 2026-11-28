// Server-side adapter for the streaming Chat Completions wire format.
// The Gateway owns the transcript, permissions, and execution of tool calls.
import { averageSpeed, estimatedOutput, estimatedUsage, fitHistory, ProviderContextError, providerUsage } from './usage.mjs';

const maxResponseBytes = 2 * 1024 * 1024;

function invalidResponse() {
  return new Error('模型服务返回的内容不完整或格式不兼容');
}

function contextRejected(error) {
  return ['context_length_exceeded', 'context_window_exceeded', 'input_too_long'].includes(error?.code) ||
    (typeof error?.message === 'string' &&
      /maximum context length|input token count.{0,50}exceeds the maximum|input is too long for (?:this|the) model/i.test(error.message));
}

async function rejectedForLength(response) {
  if (response.status === 413) return true;
  if (![400, 422].includes(response.status) || !response.headers.get('content-type')?.includes('json')) return false;
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > 16384) return false;
      chunks.push(chunk);
    }
    return contextRejected(JSON.parse(Buffer.concat(chunks).toString('utf8')).error);
  } catch { return false; }
}

function wireMessage(message) {
  if (message.role === 'tool') {
    if (!message.toolCallId) throw new Error('工具结果缺少调用编号');
    return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
  }
  if (message.role === 'assistant' && message.toolCall) {
    const { id, name, arguments: args, thoughtSignature, providerSignature } = message.toolCall;
    if (!id || !name) throw new Error('缺少模型请求的工具或调用编号');
    return {
      role: 'assistant', content: message.content ?? null,
      tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) },
        ...(thoughtSignature && { extra_content: { google: { thought_signature: thoughtSignature } } }),
        ...(providerSignature && { provider_specific_fields: { thought_signature: providerSignature } }) }]
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

// Keep a possible credential prefix out of the UI, even when split across frames.
function streamedText(onText, credential) {
  if (!onText) return null;
  let held = '';
  return (delta, finished = false) => {
    const text = held + delta;
    if (credential && text.includes(credential)) throw invalidResponse();
    let cut = text.length;
    if (credential && !finished) {
      let overlap = Math.min(credential.length - 1, text.length);
      while (overlap && !text.endsWith(credential.slice(0, overlap))) overlap--;
      cut -= overlap;
    }
    held = text.slice(cut);
    if (cut) onText(text.slice(0, cut));
  };
}

async function readCompletion(body, model, allowReportedAlias, tools, usage, elapsed, emit) {
  let text = '';
  let reportedModel = null;
  let call;
  let finish;
  for await (const data of eventData(body)) {
    usage.firstResponseMs ??= elapsed();
    if (data === '[DONE]') {
      if (finish === 'stop' && !call && text.trim()) {
        emit?.('', true);
        return allowReportedAlias ? { text, reportedModel } : { text };
      }
      // Gemini-compatible streams can end a complete single function call with "stop".
      if (!['tool_calls', 'stop'].includes(finish) || !call?.id.trim() || !tools.some(tool => tool.name === call.name)) {
        throw invalidResponse();
      }
      const args = JSON.parse(call.arguments);
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw invalidResponse();
      const toolCall = { ...call, arguments: args };
      emit?.('', true);
      return text ? { text, toolCall } : { toolCall };
    }
    const chunk = JSON.parse(data);
    if (contextRejected(chunk.error)) throw new ProviderContextError();
    if (chunk.model !== undefined) {
      if (typeof chunk.model !== 'string' || !chunk.model.trim() || chunk.model.length > 512 ||
          (reportedModel !== null && chunk.model !== reportedModel) || (!allowReportedAlias && chunk.model !== model)) {
        throw invalidResponse();
      }
      reportedModel = chunk.model;
    }
    if (chunk.error || !Array.isArray(chunk.choices)) {
      throw invalidResponse();
    }
    // Providers may send a final usage-only chunk after the choice is finished.
    if (chunk.usage && typeof chunk.usage === 'object') Object.assign(usage, providerUsage(chunk.usage, usage));
    if (!chunk.choices.length) continue;
    const [choice] = chunk.choices;
    if (chunk.choices.length !== 1 || (choice.index ?? 0) !== 0 || finish) throw invalidResponse();
    const delta = choice.delta;
    if (delta.content != null) {
      if (typeof delta.content !== 'string') throw invalidResponse();
      text += delta.content;
      if (delta.content.length) usage.firstOutputMs ??= elapsed();
      if (delta.content.length) emit?.(delta.content);
    }
    if (delta.tool_calls != null) {
      if (!Array.isArray(delta.tool_calls) || delta.tool_calls.length !== 1) throw invalidResponse();
      const [fragment] = delta.tool_calls;
      if ((fragment.index ?? 0) !== 0 || (fragment.type != null && fragment.type !== 'function')) throw invalidResponse();
      call ??= { id: '', name: '', arguments: '' };
      // Vertex and LiteLLM use different envelopes for the same in-flight proof.
      for (const [key, signature] of [['thoughtSignature', fragment.extra_content?.google?.thought_signature],
        ['providerSignature', fragment.provider_specific_fields?.thought_signature]]) {
        if (signature == null) continue;
        if (typeof signature !== 'string' || (call[key] && signature !== call[key])) throw invalidResponse();
        call[key] = signature;
      }
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

export function chatCompletionsEndpoint(baseURL) {
  const address = typeof baseURL === 'string' ? baseURL.trim() : '';
  if (!/^https?:\/\//i.test(address) || /[\\?#\s]/u.test(address) || !URL.canParse(address)) {
    throw new Error('模型服务地址无效');
  }
  const endpoint = new URL(address);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      !(endpoint.protocol === 'https:' || (endpoint.protocol === 'http:' && loopback))) {
    throw new Error('模型服务地址无效');
  }
  const path = endpoint.pathname.replace(/\/+$/, '');
  endpoint.pathname = path.endsWith('/chat/completions') ? path : path + '/chat/completions';
  return endpoint;
}

export function createChatCompletions({ baseURL, apiKey, fetchImpl = fetch, allowReportedAlias = false }) {
  const endpoint = chatCompletionsEndpoint(baseURL);
  return async function complete({ model, messages, tools = [], contextBudget = 8192, cacheMode = 'auto', thread = 'window', maxTokens, onText }) {
    const definitions = tools.map(({ name, description, parameters }) => ({
      type: 'function', function: { name, description, parameters }
    }));
    const outgoing = fitHistory(messages.map(wireMessage), contextBudget, definitions);
    const usage = estimatedUsage(outgoing, definitions);
    const payload = { model, messages: outgoing, stream: true, stream_options: { include_usage: true } };
    if (maxTokens !== undefined) {
      if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new RangeError('输出预算无效');
      payload.max_tokens = maxTokens;
    }
    if (definitions.length) payload.tools = definitions;
    if (cacheMode === 'window') payload.prompt_cache_key = 'haven-' + thread;
    usage.windowKeySent = Object.hasOwn(payload, 'prompt_cache_key');
    const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
    if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
    const started = performance.now();
    const elapsed = () => performance.now() - started;
    const response = await fetchImpl(endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60_000), headers, body: JSON.stringify(payload)
    }).catch(() => { throw new Error('连接模型服务失败'); });
    if (!response.ok || !response.body || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'text/event-stream') {
      const tooLong = await rejectedForLength(response);
      if (!response.bodyUsed) await response.body?.cancel();
      if (tooLong) throw new ProviderContextError();
      throw new Error('模型服务未返回可用的事件流（HTTP ' + response.status + '）');
    }
    // Neither a supplier error body nor a JSON parser error should reach the transcript.
    const emit = streamedText(onText, apiKey);
    const result = await readCompletion(response.body, model, allowReportedAlias, tools, usage, elapsed, emit).catch(error => {
      if (error instanceof ProviderContextError) throw error;
      throw invalidResponse();
    });
    usage.durationMs = elapsed();
    usage.tokensPerSecond = averageSpeed(usage.outputTokens, usage.durationMs);
    usage.estimatedOutputTokens = estimatedOutput(result);
    if (usage.totalTokens == null && usage.inputTokens != null && usage.outputTokens != null) {
      usage.totalTokens = usage.inputTokens + usage.outputTokens;
    }
    return { ...result, usage };
  };
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { createChatCompletions } from './chat-completions.mjs';
import { withFixtureMemory } from './provider-turn.mjs';
import { combineUsage, ProviderContextError } from './usage.mjs';

const model = 'iris-demo-a';
const tool = { name: 'memory_search', parameters: { type: 'object', properties: { query: { type: 'string' } } } };
const base = { model, messages: [{ role: 'user', content: '看看灯塔。' }], tools: [tool] };
const callId = 'test-call-01';

function choice(delta, finish_reason = null) {
  return { model, choices: [{ index: 0, delta, finish_reason }] };
}

function eventStream(events) {
  const text = events.map(e => 'data: ' + (typeof e === 'string' ? e : JSON.stringify(e)) + '\r\n\r\n').join('');
  const input = new TextEncoder().encode(text);
  // Split both UTF-8 code points and SSE boundaries.
  let i = 0;
  const stream = new ReadableStream({ pull(controller) {
    if (i < input.length) controller.enqueue(input.subarray(i, ++i));
    else controller.close();
  } });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}

test('preserves context and matches the original tool call ID on the second model request', async () => {
  const sent = [];
  const complete = createChatCompletions({ baseURL: 'http://127.0.0.1:17654/v1/', apiKey: 'fixture',
    async fetchImpl(url, options) {
      assert.equal(url.href, 'http://127.0.0.1:17654/v1/chat/completions');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, 'Bearer fixture');
      sent.push(JSON.parse(options.body));
      if (sent.length === 1) return eventStream([
        choice({ tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: tool.name, arguments: '{"query":' } }] }),
        choice({ tool_calls: [{ index: 0, function: { arguments: '"灯塔"}' } }] }),
        choice({}, 'tool_calls'), '[DONE]'
      ]);
      return eventStream([choice({ content: '找到' }), choice({ content: '灯塔。' }), choice({}, 'stop'), '[DONE]']);
    }
  });
  const history = [{ role: 'system', content: 'Iris / Adrian' }, { role: 'user', content: '我们昨天读书。' },
    { role: 'assistant', content: '已读到第三页。' }, ...base.messages];
  const { toolCall } = await complete({ ...base, messages: history });
  assert.deepEqual(toolCall, { id: callId, name: tool.name, arguments: { query: '灯塔' } });
  assert.deepEqual(sent[0].messages, history);
  assert.deepEqual(sent[0].tools, [{ type: 'function', function: tool }]);
  const answer = await complete({ model, messages: [...history,
    { role: 'assistant', toolCall },
    { role: 'tool', toolCallId: toolCall.id, name: toolCall.name, content: '虚构灯塔' }
  ] });
  assert.equal(answer.text, '找到灯塔。');
  assert.equal(answer.usage.inputTokens, null);
  assert.equal(answer.usage.cachedTokens, null);
  assert.equal(answer.usage.totalTokens, null);
  assert.equal(answer.usage.tokensPerSecond, null);
  assert.ok(answer.usage.estimatedInputTokens > 0);
  assert.ok(answer.usage.estimatedOutputTokens > 0);
  assert.ok(answer.usage.firstResponseMs <= answer.usage.firstOutputMs);
  assert.ok(answer.usage.firstOutputMs <= answer.usage.durationMs);
  assert.deepEqual(sent[1].messages.slice(-2), [
    { role: 'assistant', content: null, tool_calls: [{ type: 'function', id: callId,
      function: { name: tool.name, arguments: '{"query":"灯塔"}' } }] },
    { role: 'tool', tool_call_id: callId, content: '虚构灯塔' }
  ]);
});

test('window cache routing and streamed usage distinguish zero hits from an absent receipt', async () => {
  const sent = [];
  const complete = createChatCompletions({ baseURL: 'http://localhost/v1', fetchImpl: async (_, opts) => {
    sent.push(JSON.parse(opts.body));
    return eventStream([choice({ role: 'assistant' }), choice({ content: '合成回复' }, 'stop'), { model, choices: [],
      usage: { prompt_tokens: 80, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 11 } } },
      { choices: [], usage: { completion_tokens: 9, total_tokens: 89, cost: 0.004, cost_currency: 'USD' } }, '[DONE]']);
  } });
  const result = await complete({ ...base, thread: 'sample-a', cacheMode: 'window' });
  assert.equal(sent[0].prompt_cache_key, 'haven-sample-a');
  assert.equal(result.usage.windowKeySent, true);
  assert.deepEqual(sent[0].stream_options, { include_usage: true });
  assert.deepEqual([result.usage.inputTokens, result.usage.outputTokens, result.usage.cachedTokens], [80, 9, 0]);
  assert.equal(result.usage.cacheWriteTokens, 11);
  assert.equal(result.usage.totalTokens, 89);
  assert.deepEqual(result.usage.cost, { amount: 0.004, currency: 'USD' });
  assert.equal(result.usage.tokensPerSecond, 9000 / result.usage.durationMs);
  assert.equal((await complete(base)).usage.windowKeySent, false);
  assert.ok(!Object.hasOwn(sent[1], 'prompt_cache_key'));
});

test('rejects interrupted or ambiguous responses before a tool can run', async () => {
  const fragment = { index: 0, id: callId, type: 'function', function: { name: tool.name, arguments: '{}' } };
  const call = (...fragments) => choice({ tool_calls: fragments }, 'tool_calls');
  for (const events of [
    [choice({ content: '截断' })], [choice({ content: '截断' }), '[DONE]'],
    [choice({ content: ' ' }, 'stop'), '[DONE]'], [{ ...choice({ content: 'x' }, 'stop'), model: 'unselected' }, '[DONE]'],
    [call(fragment, { ...fragment, index: 1 }), '[DONE]'], [call({ ...fragment, id: undefined }), '[DONE]'],
    [call({ ...fragment, function: { name: tool.name, arguments: '[]' } }), '[DONE]'],
    [call({ ...fragment, function: { name: 'other_tool', arguments: '{}' } }), '[DONE]']
  ]) {
    const complete = createChatCompletions({ baseURL: 'http://localhost/v1', fetchImpl: async () => eventStream(events) });
    await assert.rejects(complete(base), /模型服务返回的内容不完整或格式不兼容/);
  }
});

test('a two-call memory turn accounts for both receipts and keeps the same cache route', async () => {
  const sent = [];
  const transport = createChatCompletions({ baseURL: 'http://localhost/v1', fetchImpl: async (_, options) => {
    sent.push(JSON.parse(options.body));
    const start = sent.length === 1;
    const part = start ? choice({ tool_calls: [{ index: 0, id: callId, type: 'function',
      function: { name: 'memory_search', arguments: '{"query":"Winterfern"}' } }] }, 'tool_calls')
      : choice({ content: '找到了。' }, 'stop');
    const receipt = { prompt_tokens: start ? 135 : 160, completion_tokens: start ? 14 : 5,
      prompt_tokens_details: { cached_tokens: start ? 0 : 12 } };
    return eventStream([part, { choices: [], usage: receipt }, '[DONE]']);
  } });
  const turn = withFixtureMemory(transport, { callTool: async () => ({ bucketId: 'test', excerpt: '合成回执' }) });
  const history = { role: 'user', content: '长记录'.repeat(4000) };
  const hit = { thread: 'other', messageId: 5, from: 'human', text: '合成检索摘录' };
  const answer = await turn({ model, messages: [{ role: 'system', content: '合成材料' }, history,
    { role: 'assistant', content: '好' }, ...base.messages], archive: { hits: [hit] },
    thread: 'sample-a', cacheMode: 'window', contextBudget: 0 });
  for (const request of sent) {
    assert.deepEqual(request.messages[1], history);
    assert.ok(request.messages[3].content.includes(hit.text));
  }
  assert.deepEqual(answer.archiveHits, [hit]);
  assert.equal(answer.usage.calls, 2);
  assert.equal(answer.usage.windowKeySent, true);
  assert.deepEqual([answer.usage.inputTokens, answer.usage.outputTokens, answer.usage.cachedTokens], [295, 19, 12]);
  assert.equal(answer.usage.totalTokens, 314);
  assert.equal(answer.usage.cacheWriteTokens, null);
  assert.ok(answer.usage.firstResponseMs <= answer.usage.firstOutputMs);
  assert.ok(answer.usage.firstOutputMs <= answer.usage.durationMs);
  assert.ok(answer.usage.estimatedOutputTokens > 5);
  assert.equal(answer.usage.tokensPerSecond, 19000 / answer.usage.durationMs);
  assert.deepEqual(sent.map(r => r.prompt_cache_key), ['haven-sample-a', 'haven-sample-a']);
});

test('an incomplete or differently denominated tool receipt does not report a complete bill', () => {
  const first = { calls: 1, inputTokens: 12, outputTokens: 3, totalTokens: 15, cachedTokens: 4,
    cost: { amount: 0.021, currency: 'USD' }, firstResponseMs: 10, firstOutputMs: 20, durationMs: 100 };
  const other = { calls: 1, outputTokens: 7, cost: { amount: 2, currency: 'JPY' },
    firstResponseMs: 15, firstOutputMs: 25, durationMs: 150 };
  const turn = combineUsage(first, other, 300);
  assert.deepEqual([turn.totalTokens, turn.inputTokens, turn.cachedTokens, turn.cost], [null, null, null, null]);
  assert.deepEqual([turn.firstResponseMs, turn.firstOutputMs, turn.durationMs], [10, 325, 450]);
  assert.equal(turn.tokensPerSecond, 10000 / 450);
  assert.equal(combineUsage({ ...first, windowKeySent: true }, { ...other, windowKeySent: false }, 300).windowKeySent, undefined);
});

test('reports the HTTP status without exposing an upstream error body', async () => {
  const complete = createChatCompletions({ baseURL: 'http://localhost/v1',
    fetchImpl: async () => new Response('synthetic-private-detail', { status: 401 }) });
  await assert.rejects(complete(base), error =>
    error.message.includes('401') && !error.message.includes('synthetic-private-detail'));
});

test('provider length errors on HTTP or SSE use the same recoverable, sanitized error', async () => {
  const responses = [
    new Response(null, { status: 413 }),
    Response.json({ error: { code: 'context_length_exceeded', message: 'private-fixture' } }, { status: 400 }),
    Response.json({ error: { message: 'The input token count (9000) exceeds the maximum number of tokens allowed (8000).' } }, { status: 400 }),
    eventStream([{ error: { code: 'context_length_exceeded' } }])
  ];
  for (const response of responses) {
    const adapter = createChatCompletions({ baseURL: 'http://localhost', fetchImpl: async () => response });
    await assert.rejects(adapter(base), ProviderContextError);
  }
});

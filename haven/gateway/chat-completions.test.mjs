import assert from 'node:assert/strict';
import test from 'node:test';
import { createChatCompletions } from './chat-completions.mjs';

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
  assert.deepEqual(answer, { text: '找到灯塔。' });
  assert.deepEqual(sent[1].messages.slice(-2), [
    { role: 'assistant', content: null, tool_calls: [{ type: 'function', id: callId,
      function: { name: tool.name, arguments: '{"query":"灯塔"}' } }] },
    { role: 'tool', tool_call_id: callId, content: '虚构灯塔' }
  ]);
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

test('reports the HTTP status without exposing an upstream error body', async () => {
  const complete = createChatCompletions({ baseURL: 'http://localhost/v1',
    fetchImpl: async () => new Response('synthetic-private-detail', { status: 401 }) });
  await assert.rejects(complete(base), error =>
    error.message.includes('401') && !error.message.includes('synthetic-private-detail'));
});

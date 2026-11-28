import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { listTrialModels, normalizeTrialEndpoint, TRIAL_MESSAGE, runGeminiTrial } from './gemini-trial.mjs';

const model = 'vertex_ai/gemini-fixture';
const reportedModel = 'publishers/google/models/gemini-fixture-001';

test('one isolated greeting reaches the provider with an output ceiling and returns its own receipt', async t => {
  const requests = [];
  const fixture = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.method === 'GET') {
      assert.equal(req.url, '/region/v1/models');
      assert.equal(req.headers.authorization, 'Bearer fixture-only');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: model }, { id: 'unrelated' }, { id: model }, { id: 'other/GEMINI:free' }] }));
      return;
    }
    requests.push({ method: req.method, path: req.url, auth: req.headers.authorization,
      payload: JSON.parse(Buffer.concat(chunks)) });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end([
      { model: reportedModel, choices: [{ delta: { content: '你好。' }, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 13, completion_tokens: 2, total_tokens: 15 } }, '[DONE]'
    ].map(event => 'data: ' + (typeof event === 'string' ? event : JSON.stringify(event)) + '\n\n').join(''));
  });
  fixture.listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  t.after(() => new Promise(resolve => fixture.close(resolve)));
  const baseURL = 'http://127.0.0.1:' + fixture.address().port + '/region/v1/';
  const expected = baseURL + 'chat/completions';
  assert.equal(normalizeTrialEndpoint(baseURL), expected);
  assert.equal(normalizeTrialEndpoint(expected + '/'), expected);
  const transport = { fetchImpl(url, options) {
    assert.equal(options.redirect, 'error');
    assert.equal(url.origin, new URL(expected).origin);
    return fetch(url, options);
  } };
  assert.deepEqual(await listTrialModels({ baseURL: expected, apiKey: 'fixture-only' }, transport), [model, 'other/GEMINI:free']);
  const result = await runGeminiTrial({ baseURL, apiKey: 'fixture-only', model }, transport);
  assert.deepEqual(requests, [{ method: 'POST', path: '/region/v1/chat/completions', auth: 'Bearer fixture-only',
    payload: { model, stream: true, stream_options: { include_usage: true }, max_tokens: 256,
      messages: [{ role: 'user', content: TRIAL_MESSAGE }] } }]);
  assert.equal(result.model, model);
  assert.equal(result.reportedModel, reportedModel);
  assert.equal(result.text, '你好。');
  assert.equal(result.usage.totalTokens, 15);
  assert.equal(result.usage.calls, 1);
  assert.equal(result.usage.windowKeySent, false);
});

test('missing credentials and unsafe model IDs never reach the transport', async () => {
  const transport = { fetchImpl: () => assert.fail('unexpected provider request') };
  await assert.rejects(runGeminiTrial({ apiKey: '' }, transport), /密钥/);
  await assert.rejects(runGeminiTrial({ apiKey: 'fixture-only', model: 'https://elsewhere.invalid' }, transport), /模型 ID/);
  for (const baseURL of ['', 'http://gateway.invalid/v1', 'https://bad:secret@example.invalid', 'https://example.invalid/v1?', 'https://example.invalid/v1#part']) {
    await assert.rejects(runGeminiTrial({ baseURL, model, apiKey: 'fixture-only' }, transport), /地址/);
    await assert.rejects(listTrialModels({ baseURL, apiKey: 'fixture-only' }, transport), /地址/);
  }
  assert.equal(normalizeTrialEndpoint('https://gateway.example/v1/'), 'https://gateway.example/v1/chat/completions');
});

test('a stream may omit the reported model, but may not change identity between chunks', async () => {
  const events = [{ choices: [{ delta: { content: '你' }, finish_reason: null }] },
    { choices: [{ delta: { content: '好' }, finish_reason: 'stop' }] }];
  const fetchImpl = async () => new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('') + 'data: [DONE]\n\n', {
    headers: { 'Content-Type': 'text/event-stream' }
  });
  const config = { baseURL: 'http://localhost', model, apiKey: 'fixture-only' };
  assert.equal((await runGeminiTrial(config, { fetchImpl })).reportedModel, null);
  events[0].model = reportedModel;
  events[1].model = 'another-model';
  await assert.rejects(runGeminiTrial(config, { fetchImpl }), /不完整|格式不兼容/);
});

import { chatCompletionsEndpoint, createChatCompletions } from './chat-completions.mjs';

export const TRIAL_MESSAGE = '你好，请只回复一句简短的中文问候。';

export function normalizeTrialEndpoint(baseURL) {
  return chatCompletionsEndpoint(baseURL).href;
}

function trialKey(apiKey) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!key || !/^[!-~]+$/.test(key)) throw new Error('请填写此网关的 API 密钥。');
  return key;
}

function isModelId(id) {
  return typeof id === 'string' && /^[\p{L}\p{N}][\p{L}\p{N}._/:@+-]{0,255}$/u.test(id) && !id.includes('://');
}

// OpenAI-compatible gateways use their own ID namespaces. Model IDs are data
// in a JSON field, including any provider prefixes and display punctuation.
function catalogId(id) {
  return typeof id === 'string' && id.trim() === id && id.length > 0 && id.length <= 512 &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(id);
}

export async function listProviderModels({ baseURL, apiKey }, { fetchImpl = fetch } = {}) {
  const key = apiKey ? trialKey(apiKey) : null;
  const endpoint = new URL(normalizeTrialEndpoint(baseURL));
  endpoint.pathname = endpoint.pathname.replace(/\/chat\/completions$/, '/models');
  const signal = AbortSignal.timeout(20_000);
  const headers = { Accept: 'application/json' };
  if (key) headers.Authorization = 'Bearer ' + key;
  const ids = new Set();
  const cursors = new Set();
  let size = 0;
  for (;;) {
    const response = await fetchImpl(endpoint, { method: 'GET', redirect: 'error', signal, headers })
      .catch(() => { throw new Error('连接模型目录失败'); });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error('无法读取模型目录（HTTP ' + response.status + '）');
    }
    const chunks = [];
    let page;
    try {
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > 16 * 1024 * 1024) throw new Error();
        chunks.push(chunk);
      }
      page = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!Array.isArray(page.data)) throw new Error();
    } catch { throw new Error('模型目录过大或格式不兼容'); }
    for (const entry of page.data) {
      const id = entry?.id;
      if (catalogId(id) && !(key && (id === key || (key.length >= 8 && id.includes(key))))) ids.add(id);
    }
    if (page.has_more !== true) return [...ids];
    const cursor = page.last_id ?? page.data.at(-1)?.id;
    if (!catalogId(cursor) || cursors.has(cursor)) throw new Error('模型目录分页无效');
    cursors.add(cursor);
    endpoint.searchParams.set('after', cursor);
  }
}

export async function listTrialModels({ baseURL, apiKey }, transport) {
  const models = await listProviderModels({ baseURL, apiKey: trialKey(apiKey) }, transport);
  return models.filter(id => /gemini/i.test(id));
}

// This entry point has no transcript, memory tools, or persistent storage.
export async function runGeminiTrial({ baseURL, model, apiKey }, { fetchImpl = fetch } = {}) {
  const key = trialKey(apiKey);
  if (!isModelId(model)) throw new Error('请输入网关提供的完整模型 ID。');
  const complete = createChatCompletions({ baseURL, apiKey: key, fetchImpl, allowReportedAlias: true });
  const result = await complete({ model, messages: [{ role: 'user', content: TRIAL_MESSAGE }], maxTokens: 256 });
  if (result.text.includes(key) || result.reportedModel?.includes(key)) {
    throw new Error('试连回复中出现了凭据，已略去该回复。');
  }
  return { model, reportedModel: result.reportedModel, text: result.text, usage: result.usage };
}

if (import.meta.main) {
  const { HAVEN_TRIAL_BASE_URL: baseURL, HAVEN_TRIAL_MODEL: model, HAVEN_TRIAL_API_KEY: apiKey } = process.env;
  if (process.argv.length > 2 || !baseURL || !model || !apiKey) {
    console.error('请设置 HAVEN_TRIAL_BASE_URL 后打开本机试连页，或为命令行同时设置 HAVEN_TRIAL_MODEL 和 HAVEN_TRIAL_API_KEY。');
    process.exitCode = 1;
  } else {
    try {
      const result = await runGeminiTrial({ baseURL, model, apiKey });
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}

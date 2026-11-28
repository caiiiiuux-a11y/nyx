import { createChatCompletions, chatCompletionsEndpoint } from './chat-completions.mjs';
import { generateMockReply } from './model.mjs';
import { RequestError } from './store.mjs';

const geminiModel = 'vertex_ai/gemini-3.8-flash';
const routes = [
  { id: 'mock', label: '本机模拟', models: ['iris-demo-a'] },
  { id: 'gemini', label: 'Vertex Gemini', models: [geminiModel] }
];

function validKey(key) {
  if (typeof key !== 'string' || !/^[!-~]{1,2048}$/.test(key.trim())) {
    throw new RequestError(400, '请输入这条线路的有效 API Key。');
  }
  return key.trim();
}

export function createLiveRoutes({ baseURL, apiKey, fetchImpl }) {
  const endpoint = chatCompletionsEndpoint(baseURL).href;
  let key = apiKey ? validKey(apiKey) : null;
  const models = routes.flatMap(route => route.models);
  function active(model) {
    const route = routes.find(item => item.models.includes(model));
    if (!route) throw new RequestError(400, '请选择已配置的聊天线路。');
    return route;
  }
  function status(store, thread = 'window') {
    const model = store.windowModel(thread);
    return { thread, route: active(model).id, model, routes, endpoint, hasKey: Boolean(key) };
  }
  function select(store, { route: id, thread = 'window', model, apiKey: inputKey }) {
    const route = routes.find(item => item.id === id);
    if (!route || (model !== undefined && !route.models.includes(model))) {
      throw new RequestError(400, '请选择线路下的模型。');
    }
    if (id === 'mock' && inputKey !== undefined) throw new RequestError(400, '本机模拟无需密钥。');
    const replacement = inputKey === undefined ? null : validKey(inputKey);
    if (id === 'gemini' && !replacement && !key) throw new RequestError(400, '请在杂物间填写 Gemini 线路密钥。');
    store.selectModel({ thread, model: model ?? route.models[0] });
    if (replacement) key = replacement;
    return status(store, thread);
  }
  async function complete(request, options) {
    if (active(request.model).id === 'mock') return { ...generateMockReply(request, options), provider: 'mock' };
    const credential = key;
    if (!credential) throw new RequestError(409, '请在杂物间填写 Gemini 线路密钥，再重试这条消息。');
    const upstream = createChatCompletions({ baseURL: endpoint, apiKey: credential, allowReportedAlias: true, fetchImpl });
    try {
      const result = await upstream({ model: request.model, messages: request.messages, contextBudget: request.contextBudget,
        cacheMode: request.cacheMode, thread: request.thread, maxTokens: 1024 });
      if (result.text.includes(credential) || result.reportedModel?.includes(credential)) {
        throw new RequestError(502, '模型回复包含线路凭据，已丢弃。');
      }
      return { ...result, provider: 'gemini' };
    } catch (error) {
      if (/HTTP 401\b/.test(error.message)) {
        if (key === credential) key = null;
        throw new RequestError(401, '线路拒绝了这个密钥，请在杂物间重新填写后重试。');
      }
      if (/HTTP 403\b/.test(error.message)) throw new RequestError(403, '这条线路拒绝访问所选模型，请核对模型权限。');
      if (/HTTP 429\b/.test(error.message)) throw new RequestError(429, '线路暂时达到限额，请稍后重试。');
      throw error;
    }
  }
  return { status, select, active, models, complete };
}

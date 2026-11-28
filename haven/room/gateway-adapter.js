// The loopback server selects this adapter. The public preview never imports it.
import { windowLocation } from './window-location.js';

function requestFailure(status, notice) {
  const failure = new Error('Local chat request failed (' + status + ')');
  failure.status = status;
  if (typeof notice === 'string') failure.notice = notice;
  failure.retryable = [401, 403, 408, 413, 429].includes(status) ||
    (status === 409 && /线路|密钥/.test(failure.notice || ''));
  return failure;
}

async function readChatStream(body, onText) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw requestFailure(503, '回复途中连接断开，请重试以确认结果。');
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.type === 'text') onText(event.text);
        else if (event.type === 'done') return event.result;
        else if (event.type === 'error') throw requestFailure(event.status, event.error);
      }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function createGatewayChat(mediaAssets) {
  const active = windowLocation('haven.gateway.last-window.v1');
  const modelByThread = new Map();
  const routeByThread = new Map();
  const unconfirmed = new Map();

  async function request(path, payload, onText) {
    const options = { cache: 'no-store', credentials: 'same-origin' };
    if (payload) {
      options.method = 'POST';
      options.headers = { 'Content-Type': 'application/json' };
      if (onText) options.headers.Accept = 'application/x-ndjson';
      options.body = JSON.stringify(payload);
    }
    const response = await fetch('/app/' + path, options);
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw requestFailure(response.status, body?.error);
    }
    if (onText && response.headers.get('Content-Type')?.startsWith('application/x-ndjson')) {
      return readChatStream(response.body, onText);
    }
    return response.json();
  }

  // On one route a retry has the same identity. Sending the same draft on a
  // different model starts a new request, even if an earlier turn is pending.
  function savedInput(message) {
    return { text: message.text, media: message.meta.attachments[0]?.kind || '', quote: message.meta.quote ?? null };
  }

  function savedRequest(message) {
    return { ...savedInput(message), thread: message.meta.thread, model: message.meta.retryModel,
      route: message.meta.retryRoute,
      requestId: message.meta.retryRequestId };
  }

  async function submit(path, input, original, onText) {
    const thread = active.id;
    const model = original ? original.model : modelByThread.get(thread);
    const route = original ? original.route : routeByThread.get(thread);
    const key = JSON.stringify([thread, path, route, model, input]);
    let payload = original ?? unconfirmed.get(key);
    if (!payload) {
      payload = { ...input, thread, route, model, requestId: crypto.randomUUID() };
    }
    unconfirmed.set(key, payload);
    try {
      const result = await request(path, payload, onText);
      unconfirmed.delete(key);
      return result;
    } catch (error) {
      if (error.status >= 400 && error.status < 500 && !error.retryable) unconfirmed.delete(key);
      throw error;
    }
  }

  return {
    persistent: true,
    async windows() { return (await request('windows')).windows; },
    async createWindow(options = {}) {
      const id = 'create:' + JSON.stringify([active.id, options]);
      const requestId = unconfirmed.get(id) ?? crypto.randomUUID();
      unconfirmed.set(id, requestId);
      try {
        const inheritRoute = document.documentElement.hasAttribute('data-live-lab');
        const result = await request('windows', { ...options, requestId, ...(inheritRoute && { sourceThread: active.id }) });
        unconfirmed.delete(id);
        return result.window;
      } catch (error) {
        if (error.status >= 400 && error.status < 500) unconfirmed.delete(id);
        throw error;
      }
    },
    openWindow(id) { active.select(id); },
    routes() { return request('routes?thread=' + encodeURIComponent(active.id)); },
    refreshModels(settings) { return request('routes/models', { ...settings, thread: active.id }); },
    forgetKey(route) { return request('routes/forget-key', { route, thread: active.id }); },
    addProvider(settings) { return request('routes/providers', { ...settings, thread: active.id }); },
    async selectRoute(settings) {
      const thread = active.id;
      const state = await request('routes', { ...settings, thread });
      modelByThread.set(thread, state.model);
      routeByThread.set(thread, state.route);
      return state;
    },
    async room() {
      const thread = active.id;
      const room = await request('history?thread=' + encodeURIComponent(thread));
      modelByThread.set(thread, room.model);
      routeByThread.set(thread, room.route);
      for (const message of room.messages) {
        if (message.meta.retryRequestId) {
          const original = savedRequest(message);
          unconfirmed.set(JSON.stringify([thread, 'send', original.route, original.model, savedInput(message)]), original);
        }
      }
      if (active.id === thread && !new URL(location.href).searchParams.has('thread')) active.select(thread, false);
      return { ...room, date: new Date(), media: mediaAssets };
    },
    setContext(options) { return request('context', { ...options, thread: active.id }); },
    async defaultWindowKey() {
      return (await request('provider-cache?thread=' + encodeURIComponent(active.id))).defaultWindowKey;
    },
    setDefaultWindowKey(enabled) {
      return request('provider-cache', { thread: active.id, route: routeByThread.get(active.id), enabled });
    },
    async selectModel(value) {
      const thread = active.id;
      const result = await request('model', { thread, route: routeByThread.get(thread), model: value });
      modelByThread.set(thread, result.model);
    },
    async send(text, media, quote, onText) {
      const result = await submit('send', { text, media, quote }, undefined, onText);
      return result.messages;
    },
    async retryPending(message, onText) {
      const result = await submit('send', savedInput(message), savedRequest(message), onText);
      return result.messages;
    },
    async regenerate(id, onText) {
      const result = await submit('regenerate', { id }, undefined, onText);
      return result.message;
    }
  };
}

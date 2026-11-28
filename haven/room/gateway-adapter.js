// The loopback server selects this adapter. The public preview never imports it.
import { windowLocation } from './window-location.js';

export function createGatewayChat(mediaAssets) {
  const active = windowLocation('haven.gateway.last-window.v1');
  const modelByThread = new Map();
  const unconfirmed = new Map();

  async function request(path, payload) {
    const options = { cache: 'no-store', credentials: 'same-origin' };
    if (payload) {
      options.method = 'POST';
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify(payload);
    }
    const response = await fetch('/app/' + path, options);
    if (!response.ok) {
      const failure = new Error('Local chat request failed (' + response.status + ')');
      failure.status = response.status;
      const body = await response.json().catch(() => null);
      if (typeof body?.error === 'string') failure.notice = body.error;
      failure.retryable = [401, 403, 408, 413, 429].includes(response.status) ||
        (response.status === 409 && /线路|密钥/.test(failure.notice || ''));
      throw failure;
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
      requestId: message.meta.retryRequestId };
  }

  async function submit(path, input, original) {
    const thread = active.id;
    const model = original ? original.model : modelByThread.get(thread);
    const key = JSON.stringify([thread, path, model, input]);
    let payload = original ?? unconfirmed.get(key);
    if (!payload) {
      payload = { ...input, thread, model, requestId: crypto.randomUUID() };
    }
    unconfirmed.set(key, payload);
    try {
      const result = await request(path, payload);
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
        const result = await request('windows', { ...options, requestId });
        unconfirmed.delete(id);
        return result.window;
      } catch (error) {
        if (error.status >= 400 && error.status < 500) unconfirmed.delete(id);
        throw error;
      }
    },
    openWindow(id) { active.select(id); },
    routes() { return request('routes?thread=' + encodeURIComponent(active.id)); },
    async selectRoute(settings) {
      const thread = active.id;
      const state = await request('routes', { ...settings, thread });
      modelByThread.set(thread, state.model);
      return state;
    },
    async room() {
      const thread = active.id;
      const room = await request('history?thread=' + encodeURIComponent(thread));
      modelByThread.set(thread, room.model);
      for (const message of room.messages) {
        if (message.meta.retryRequestId) {
          const original = savedRequest(message);
          unconfirmed.set(JSON.stringify([thread, 'send', original.model, savedInput(message)]), original);
        }
      }
      if (active.id === thread && !new URL(location.href).searchParams.has('thread')) active.select(thread, false);
      return { ...room, date: new Date(), media: mediaAssets };
    },
    setContext(options) { return request('context', { ...options, thread: active.id }); },
    async defaultWindowKey() { return (await request('provider-cache')).defaultWindowKey; },
    setDefaultWindowKey(enabled) { return request('provider-cache', { enabled }); },
    async selectModel(value) {
      const thread = active.id;
      const result = await request('model', { thread, model: value });
      modelByThread.set(thread, result.model);
    },
    async send(text, media, quote) {
      const result = await submit('send', { text, media, quote });
      return result.messages;
    },
    async retryPending(message) {
      const result = await submit('send', savedInput(message), savedRequest(message));
      return result.messages;
    },
    async regenerate(id) {
      const result = await submit('regenerate', { id });
      return result.message;
    }
  };
}

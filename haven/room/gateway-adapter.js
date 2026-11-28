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
      throw failure;
    }
    return response.json();
  }

  // Reuse the ID and the originally selected model if the response was lost.
  async function submit(path, input) {
    const thread = active.id;
    const key = JSON.stringify([thread, path, input]);
    let payload = unconfirmed.get(key);
    if (!payload) {
      payload = { ...input, thread, model: modelByThread.get(thread), requestId: crypto.randomUUID() };
      unconfirmed.set(key, payload);
    }
    try {
      const result = await request(path, payload);
      unconfirmed.delete(key);
      return result;
    } catch (error) {
      if (error.status >= 400 && error.status < 500 && error.status !== 413) unconfirmed.delete(key);
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
    async room() {
      const thread = active.id;
      const room = await request('history?thread=' + encodeURIComponent(thread));
      modelByThread.set(thread, room.model);
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
    async regenerate(id) {
      const result = await submit('regenerate', { id });
      return result.message;
    }
  };
}

// The loopback server selects this adapter. The public preview never imports it.
export function createGatewayChat(mediaAssets) {
  let model;
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
    const key = JSON.stringify([path, input]);
    let payload = unconfirmed.get(key);
    if (!payload) {
      payload = { ...input, model, requestId: crypto.randomUUID() };
      unconfirmed.set(key, payload);
    }
    try {
      const result = await request(path, payload);
      unconfirmed.delete(key);
      return result;
    } catch (error) {
      if (error.status >= 400 && error.status < 500) unconfirmed.delete(key);
      throw error;
    }
  }

  return {
    persistent: true,
    async room() {
      const history = await request('history');
      model = history.model;
      return { ...history, date: new Date(), media: mediaAssets };
    },
    async selectModel(value) {
      const result = await request('model', { model: value });
      model = result.model;
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

import { windowLocation } from './window-location.js';

export function setupStorybook() {
  const book = document.getElementById('storybook');
  const list = document.getElementById('story-list');
  const form = document.getElementById('story-form');
  const prompt = document.getElementById('story-prompt');
  const status = document.getElementById('story-status');
  const reload = document.getElementById('reload-stories');
  const live = document.documentElement.hasAttribute('data-live-lab');
  let ready = false, sending = false, pending = false, version = 0, draftId;

  function syncControls() {
    prompt.disabled = form.querySelector('button').disabled = !ready || sending || pending;
    for (const button of list.querySelectorAll('button')) button.disabled = !ready || sending;
  }

  function render(messages) {
    const opened = new Set([...list.querySelectorAll('details[open]')].map(row => row.dataset.turn));
    const previous = list.lastElementChild?.dataset.turn;
    const answers = new Map(messages.filter(m => m.from === 'ai').map(m => [m.id - 1, m]));
    const topics = messages.filter(m => m.from === 'human');
    pending = topics.some(topic => topic.meta?.retryRequestId);
    const rows = topics.map((topic, i) => {
      const row = document.createElement('details');
      row.className = 'story-entry';
      row.dataset.turn = String(topic.id);
      const title = document.createElement('summary');
      title.textContent = topic.text;
      row.append(title);
      const answer = answers.get(topic.id);
      if (answer) {
        const story = document.createElement('p');
        story.textContent = answer.text;
        row.append(story);
      } else if (topic.meta?.retryRequestId) {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'text-button';
        retry.textContent = '用原题再试一次';
        retry.onclick = () => send(topic.text, topic.meta.retryRequestId);
        row.append(retry);
      }
      row.open = !answer || opened.has(row.dataset.turn) || (i === topics.length - 1 && previous !== row.dataset.turn);
      return row;
    });
    list.replaceChildren(...rows);
  }

  async function read() {
    const ticket = ++version;
    reload.hidden = true;
    if (!live) { status.textContent = '在本机小屋打开故事本，就能请阿川讲故事。'; return; }
    try {
      const { gatewayRequest } = await import('./gateway-adapter.js');
      const { messages, canAsk } = await gatewayRequest('calendar/storybook');
      if (ticket !== version) return;
      ready = canAsk;
      render(messages);
      status.textContent = ready ? '' : '在杂物间连接 Gemini 后，就能请阿川讲故事。';
    } catch {
      if (ticket !== version) return;
      ready = false;
      status.textContent = '暂时读不到故事本。';
      reload.hidden = false;
    }
    syncControls();
  }

  async function send(text, requestId) {
    if (!ready || sending || !text) return;
    ++version;
    sending = true;
    syncControls();
    status.textContent = '阿川正在写故事…';
    let notice;
    try {
      const { gatewayRequest } = await import('./gateway-adapter.js');
      await gatewayRequest('send', { storybook: true, text, requestId, sourceThread: windowLocation('haven.gateway.last-window.v1').id });
      prompt.value = '';
      draftId = undefined;
    } catch { notice = '这篇故事还没读到，可以用原题再试一次。'; }
    await read();
    if (notice && reload.hidden) status.textContent = notice;
    if (pending) { prompt.value = ''; draftId = undefined; }
    sending = false;
    syncControls();
  }

  prompt.oninput = () => { draftId = undefined; };
  form.onsubmit = event => {
    event.preventDefault();
    const text = prompt.value.trim();
    if (text) send(text, draftId ??= crypto.randomUUID());
  };
  reload.onclick = read;
  book.ontoggle = () => { if (book.open && !sending) read(); };
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && book.open && book.getClientRects().length && !sending) read();
  });
}

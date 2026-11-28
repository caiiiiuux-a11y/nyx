import { chatService } from './service.js';

const $ = id => document.getElementById(id);
const form = $('route-form');
const provider = $('route-provider');
const model = $('route-model');
const key = $('route-key');
const createForm = $('provider-form');
const newKey = $('provider-key');
const live = document.documentElement.hasAttribute('data-live-lab');
let state;
let busy = false;

function status(message, error = false) {
  $('route-status').textContent = message;
  $('route-status').classList.toggle('error', error);
}

function selectedRoute() { return state.routes.find(option => option.id === provider.value); }

function storageHint(storage) {
  return storage === 'device'
    ? '密钥会加密保存在这台电脑的 Windows 账户中。'
    : '密钥保留到本次服务退出。';
}

async function perform(progress, work) {
  if (busy) return;
  busy = true;
  $('route-fields').disabled = $('provider-fields').disabled = $('new-provider').disabled = true;
  $('chat-memory-source').disabled = true;
  status(progress);
  try { await work(); }
  catch (error) { status(error.notice || '线路未能更新，请核对连接并重试。', true); }
  finally {
    busy = false;
    $('route-fields').disabled = !state;
    $('provider-fields').disabled = $('new-provider').disabled = false;
    $('chat-memory-source').disabled = false;
  }
}

function showProvider(preferredModel) {
  const route = selectedRoute();
  const models = route.models;
  const selected = preferredModel ?? (route.id === state.route ? state.model : models[0]);
  model.replaceChildren(...models.map(id => new Option(id, id)));
  if (!selected || !models.includes(selected)) {
    const placeholder = !models.length ? '请先读取线路模型' : '请选择可用模型';
    const empty = new Option(placeholder, '', false, true);
    empty.disabled = true;
    model.prepend(empty);
    model.value = '';
  } else {
    model.value = selected;
  }
  const remote = live && route.id !== 'mock';
  $('chat-memory-setting').hidden = !remote || !route.memorySource;
  $('chat-memory-source').value = route.memorySource ?? 'synthetic';
  $('chat-memory-source').querySelector('[value="personal"]').disabled = !route.personalMemoryAvailable;
  const hasKey = route.hasKey ?? state.hasKey;
  const keyStorage = route.keyStorage ?? state.keyStorage;
  $('refresh-models').hidden = !remote || route.catalogReady === undefined;
  $('route-connection').hidden = !remote;
  $('route-connection').open = remote && !hasKey && route.requiresKey !== false;
  $('route-endpoint').textContent = route.endpoint || state.endpoint || '';
  key.value = '';
  key.placeholder = hasKey ? '留空沿用，输入可替换' : '粘贴 API Key';
  key.disabled = !remote;
  key.required = remote && !hasKey && route.requiresKey !== false;
  model.required = models.length > 0;
  $('route-save').disabled = !models.length;
  $('forget-key').hidden = !remote || !keyStorage || !(hasKey || route.keySaved);
  $('route-key-hint').textContent = route.keySaved
    ? '已保存在这台电脑，重启后可继续使用。'
    : storageHint(keyStorage);
}

function render(next, chosenRoute = next.route, chosenModel) {
  state = next;
  provider.replaceChildren(...state.routes.map(route => new Option(route.label, route.id)));
  provider.value = chosenRoute;
  provider.disabled = state.routes.length === 1;
  $('provider-tools').hidden = !live || !state.routes.some(route => route.catalogReady !== undefined);
  const href = '/chat/?thread=' + encodeURIComponent(state.thread);
  document.querySelector('#room-nav a[href^="/chat/"]').href = href;
  $('provider-key-hint').textContent = storageHint(next.keyStorage);
  showProvider(chosenModel);
}

function toggleCreate(open) {
  createForm.reset();
  key.value = '';
  createForm.hidden = !open;
  $('new-provider').setAttribute('aria-expanded', String(open));
  if (open) $('provider-name').focus();
}

async function refreshModels(quiet = false) {
  const route = selectedRoute();
  if (!quiet && !key.reportValidity()) { $('route-connection').open = true; return; }
  const preferred = model.value || undefined;
  const credential = key.value.trim();
  key.value = '';
  await perform('正在从线路读取模型…', async () => {
    const next = await chatService.refreshModels({ route: route.id, ...(credential && { apiKey: credential }) });
    render(next, route.id, preferred);
    const size = selectedRoute().models.length;
    status(size ? '已读取 ' + size + ' 个模型。' : '这条线路没有返回模型。');
  });
}

function initialDiscovery() {
  const route = selectedRoute();
  if (live && route.catalogReady === false && route.hasKey) return refreshModels(true);
}

async function load() {
  await perform('', async () => { render(await chatService.routes()); status(''); });
  if (state) await initialDiscovery();
}

provider.onchange = () => {
  toggleCreate(false);
  showProvider();
  status('');
  initialDiscovery();
};
$('refresh-models').onclick = () => refreshModels();
$('chat-memory-source').onchange = () => {
  const route = selectedRoute();
  const source = $('chat-memory-source').value;
  const selected = model.value;
  perform('正在切换记忆库…', async () => {
    $('chat-memory-source').value = route.memorySource;
    render(await chatService.setMemorySource(route.id, source), route.id, selected);
    status('记忆库设置已应用到这条线路的所有 Gemini 窗口。');
  });
};
$('forget-key').onclick = async () => {
  const route = selectedRoute();
  const preferred = model.value;
  await perform('正在移除密钥…', async () => {
    render(await chatService.forgetKey(route.id), route.id, preferred);
    $('route-connection').open = true;
    status('已忘记这条线路的密钥。');
  });
  if (!selectedRoute().hasKey) key.focus();
};
key.oninvalid = () => { $('route-connection').open = true; };
$('new-provider').onclick = () => toggleCreate(createForm.hidden);
$('cancel-provider').onclick = () => { toggleCreate(false); $('new-provider').focus(); };
$('provider-url').oninput = () => { newKey.value = ''; };

createForm.onsubmit = event => {
  event.preventDefault();
  const credential = newKey.value.trim();
  const input = { label: $('provider-name').value.trim(), baseURL: $('provider-url').value.trim(),
    ...(credential && { apiKey: credential }) };
  newKey.value = '';
  perform('正在读取新供应商的模型…', async () => {
    const next = await chatService.addProvider(input);
    toggleCreate(false);
    render(next, next.addedRoute);
    status('供应商已添加。选好回复模型后，保存到当前窗口。');
  });
};

form.onsubmit = event => {
  event.preventDefault();
  if (!state || !model.value) return;
  const route = selectedRoute();
  const desired = model.value;
  const credential = key.value.trim();
  key.value = '';
  perform('正在保存…', async () => {
    if (live) {
      if (credential && route.catalogReady !== undefined) {
        const next = await chatService.refreshModels({ route: route.id, apiKey: credential });
        render(next, route.id, desired);
        if (!model.value) { status('这个密钥的模型目录已更新，请重新选择回复模型。'); return; }
      }
      const selection = { route: route.id, model: desired };
      if (credential && route.catalogReady === undefined) selection.apiKey = credential;
      render(await chatService.selectRoute(selection));
    } else {
      await chatService.selectModel(desired);
      render(await chatService.routes());
    }
    status('已保存到当前聊天窗口。');
  });
};

window.addEventListener('pagehide', () => { key.value = newKey.value = ''; });
window.addEventListener('pageshow', event => { if (event.persisted) load(); });
if (chatService.persistent && !live) $('live-room-link').hidden = false;
load();

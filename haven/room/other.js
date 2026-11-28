import { chatService } from './service.js';

const $ = id => document.getElementById(id);
const form = $('route-form');
const provider = $('route-provider');
const model = $('route-model');
const connection = $('route-connection');
const key = $('route-key');
const live = document.documentElement.hasAttribute('data-live-lab');
let state;

function status(message, error = false) {
  $('route-status').textContent = message;
  $('route-status').classList.toggle('error', error);
}

function showProvider() {
  const route = state.routes.find(option => option.id === provider.value);
  model.replaceChildren(...route.models.map(value => new Option(value, value)));
  model.value = route.id === state.route ? state.model : route.models[0];
  const needsConnection = live && route.id === 'gemini';
  connection.hidden = !needsConnection;
  connection.open = needsConnection && !state.hasKey;
  key.value = '';
  key.disabled = !needsConnection;
  key.required = needsConnection && !state.hasKey;
  $('route-key-hint').textContent = state.hasKey
    ? '已为本次服务保存密钥。留空沿用，输入可替换。'
    : '密钥只留在本机服务内存，服务重启后需重新填写。';
}

function render(next) {
  state = next;
  provider.replaceChildren(...state.routes.map(route => new Option(route.label, route.id)));
  provider.value = state.route;
  provider.disabled = state.routes.length === 1;
  $('route-endpoint').textContent = state.endpoint || '';
  const href = '/chat/?thread=' + encodeURIComponent(state.thread);
  $('route-chat').href = href;
  document.querySelector('#room-nav a[href^="/chat/"]').href = href;
  showProvider();
}

async function load() {
  $('route-fields').disabled = true;
  try {
    render(await chatService.routes());
    $('route-fields').disabled = false;
    status('');
  } catch (error) {
    status(error.notice || '暂时读不到这个窗口的线路。请重新打开聊天窗口，或刷新重试。', true);
  }
}

provider.onchange = () => { showProvider(); status(''); };
model.onchange = () => status('');
key.oninput = () => status('');
key.oninvalid = () => { connection.open = true; };
window.addEventListener('pagehide', () => { key.value = ''; });
window.addEventListener('pageshow', event => { if (event.persisted) load(); });
form.onsubmit = async event => {
  event.preventDefault();
  if (!state || $('route-fields').disabled) return;
  const selection = { route: provider.value, model: model.value };
  if (live && selection.route === 'gemini' && key.value.trim()) selection.apiKey = key.value.trim();
  key.value = '';
  $('route-fields').disabled = true;
  status('正在保存…');
  try {
    if (live) {
      render(await chatService.selectRoute(selection));
    } else {
      await chatService.selectModel(selection.model);
      render(await chatService.routes());
    }
    status('已保存到当前聊天窗口。');
  } catch (error) {
    status(error.notice || '线路尚未保存，请重试。', true);
  } finally {
    $('route-fields').disabled = false;
  }
};
if (chatService.persistent && !live) $('live-room-link').hidden = false;
load();

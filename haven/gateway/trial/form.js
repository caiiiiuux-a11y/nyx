const $ = id => document.getElementById(id);
const result = $('result');
try {
  const config = await fetch('/trial-info');
  if (!config.ok) throw new Error();
  const { endpoint, model, message } = await config.json();
  $('endpoint').textContent = endpoint;
  $('model').value = model;
  $('message').textContent = message;
  $('send').disabled = false;
  $('load-models').disabled = false;
} catch {
  result.textContent = '请刷新后重新读取试连设置。';
}

async function requestTrial(listOnly) {
  if ($('send').disabled) return;
  if (!$('key').reportValidity()) return;
  $('send').disabled = $('load-models').disabled = true;
  result.textContent = listOnly ? '正在读取模型列表…' : '正在等待 Gemini 回复…';
  const payload = JSON.stringify({ apiKey: $('key').value.trim(), model: $('model').value.trim() });
  if (!listOnly) $('key').value = '';
  try {
    const response = await fetch(listOnly ? '/models' : '/trial', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, cache: 'no-store'
    });
    const data = await response.json();
    if (!response.ok) { result.textContent = data.error || '试连未完成。'; return; }
    if (listOnly) {
      $('model-options').replaceChildren(...data.models.map(id => new Option(id, id)));
      if (data.models.length === 1) $('model').value = data.models[0];
      result.textContent = data.models.length ? '找到 ' + data.models.length + ' 个 Gemini 模型。' : '列表里没有 Gemini，也可以手动输入模型 ID。';
      $('model').focus();
      return;
    }
    const total = data.usage?.totalTokens;
    const served = data.reportedModel && data.reportedModel !== data.model ? '接口回报模型 · ' + data.reportedModel : '';
    result.textContent = [data.text, served, Number.isSafeInteger(total) ? total + ' tokens' : '接口未回报总用量'].filter(Boolean).join('\n');
  } catch {
    result.textContent = '连接已中断，未能确认结果。';
  } finally {
    $('send').disabled = $('load-models').disabled = false;
  }
}
$('load-models').onclick = () => requestTrial(true);
$('trial-form').addEventListener('submit', event => { event.preventDefault(); requestTrial(false); });

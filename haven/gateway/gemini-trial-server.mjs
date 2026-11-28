import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TRIAL_MESSAGE, runGeminiTrial, normalizeTrialEndpoint, listTrialModels } from './gemini-trial.mjs';

// An isolated loopback form for the first real request. No chat store or memory tools are loaded.
const html = readFileSync(new URL('./trial/form.html', import.meta.url));
const script = readFileSync(new URL('./trial/form.js', import.meta.url));
const policy = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'";

export function createTrialServer({ baseURL, model = '', run = runGeminiTrial, list = listTrialModels }) {
  const endpoint = normalizeTrialEndpoint(baseURL);
  return createServer(async (req, res) => {
    const headers = { 'Cache-Control': 'no-store', 'Content-Security-Policy': policy,
      'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' };
    function reply(status, type, body) {
      res.writeHead(status, { ...headers, 'Content-Type': type });
      res.end(body);
    }
    const json = (status, body) => reply(status, 'application/json; charset=utf-8', JSON.stringify(body));
    const origin = 'http://127.0.0.1:' + req.socket.localPort;
    if ('http://' + req.headers.host !== origin) return json(403, { error: '请使用本机试连地址。' });
    if (req.method === 'GET') {
      if (req.url === '/') return reply(200, 'text/html; charset=utf-8', html);
      if (req.url === '/form.js') return reply(200, 'text/javascript; charset=utf-8', script);
      if (req.url === '/trial-info') return json(200, { endpoint, model, message: TRIAL_MESSAGE });
      if (req.url === '/favicon.ico') return reply(204, 'image/x-icon', '');
    }
    if (!['/trial', '/models'].includes(req.url) || req.method !== 'POST') return json(404, { error: '找不到这个入口。' });
    if (req.headers.origin !== origin || req.headers['sec-fetch-site'] === 'cross-site') {
      return json(403, { error: '请从本机试连页发送。' });
    }
    if (req.headers['content-type']?.split(';')[0] !== 'application/json') return json(415, { error: '请求格式有误。' });
    let key, requestedModel;
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 4096) return json(413, { error: '输入过长。' });
        chunks.push(chunk);
      }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (typeof data?.apiKey !== 'string' || !data.apiKey.trim() || /\s/.test(data.apiKey.trim())) {
        return json(400, { error: '请输入这条线路的 API Key。' });
      }
      key = data.apiKey.trim();
      requestedModel = typeof data.model === 'string' ? data.model.trim() : '';
      if (req.url === '/trial' && (!requestedModel || requestedModel.length > 256)) return json(400, { error: '请填写线路上的模型 ID。' });
    } catch { return json(400, { error: '无法读取输入。' }); }
    try {
      if (req.url === '/models') return json(200, { models: await list({ baseURL: endpoint, apiKey: key }) });
      const { model, reportedModel, text, usage } = await run({ baseURL: endpoint, apiKey: key, model: requestedModel });
      return json(200, { model, reportedModel, text, usage });
    } catch (error) {
      // Extract the status only. Never return request headers or an upstream response body.
      const status = /\bHTTP\s+(\d{3})\b/i.exec(error.message)?.[1];
      const reason = { 400: '请检查模型 ID 与请求权限。', 401: '请使用这条线路的 API Key。', 403: '请检查线路权限。',
        404: '该线路可能没有开放这个接口或模型。', 429: '请检查线路配额，稍后再试。' }[status];
      return json(502, { error: status ? '线路返回 HTTP ' + status + '。' + (reason || '请稍后再试。') :
        '未收到可用的线路回执，请核对模型 ID 和连接。' });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = createTrialServer({ baseURL: process.env.HAVEN_TRIAL_BASE_URL, model: process.env.HAVEN_TRIAL_MODEL });
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? '4193 端口已在使用。' : '本机试连页启动失败。');
    process.exitCode = 1;
  });
  server.listen(4193, '127.0.0.1', () => console.log('Gemini 单次试连 · http://127.0.0.1:4193/'));
}

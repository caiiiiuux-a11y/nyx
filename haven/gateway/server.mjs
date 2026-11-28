import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { openStore, RequestError } from './store.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const { values } = parseArgs({ options: {
  port: { type: 'string' }, db: { type: 'string' }, 'memory-lab': { type: 'boolean' }, 'provider-lab': { type: 'boolean' }
} });
const memoryMode = values['memory-lab'] === true;
const providerMode = values['provider-lab'] === true;
if (memoryMode && providerMode) throw new Error('Choose one lab per process.');
const labMode = memoryMode || providerMode;
const portOption = values.port ?? (providerMode ? '4192' : memoryMode ? '4191' : '4190');
const port = Number(portOption);
if (!/^\d+$/.test(portOption) || !Number.isInteger(port) || port > 65535) throw new Error('Invalid --port');
if (labMode && (values.db !== undefined || port === 4190 || (providerMode && port === 4191) || (memoryMode && port === 4192))) {
  throw new Error('Use the dedicated lab database and a separate port.');
}
const labDir = providerMode ? 'provider-lab' : 'ombre-lab';
const database = labMode ? resolve(root, '.haven-local', labDir, 'chat.sqlite') : resolve(values.db ?? resolve(root, '.haven-local/room.sqlite'));
const dist = resolve(root, 'dist');
if (!existsSync(resolve(dist, 'chat/index.html'))) throw new Error('Run npm run build first.');

function inside(dir, path) {
  const part = relative(dir, path);
  return part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part);
}

if (inside(dist, database)) throw new Error('The private database must be outside dist.');
mkdirSync(dirname(database), { recursive: true, mode: 0o700 });
const lab = labMode ? (await import('./ombre-lab.mjs')).createOmbreLab() : undefined;
const storeOptions = memoryMode ? { memoryLab: lab } : {};
let fixture;
if (providerMode) {
  const { startProviderFixture } = await import('./provider-fixture.mjs');
  const { createChatCompletions } = await import('./chat-completions.mjs');
  const { withFixtureMemory } = await import('./provider-turn.mjs');
  fixture = await startProviderFixture();
  Object.assign(storeOptions, { models: fixture.models, provider: 'home-fixture', embedder: false,
    complete: withFixtureMemory(createChatCompletions(fixture), lab) });
}
const store = openStore(database, storeOptions);
const config = JSON.parse(readFileSync(resolve(root, 'vercel.json'), 'utf8'));
const baseHeaders = Object.fromEntries(config.headers[0].headers.map(({ key, value }) => [key, value]));
baseHeaders['X-Content-Type-Options'] = 'nosniff';
baseHeaders['Cache-Control'] = 'no-store';
baseHeaders['Cross-Origin-Resource-Policy'] = 'same-origin';
const privateCsp = baseHeaders['Content-Security-Policy'].replace("connect-src 'none'", "connect-src 'self'");
const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.webp': 'image/webp', '.mp3': 'audio/mpeg'
};

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

async function readJson(req) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new RequestError(415, '需要 JSON 请求');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256 * 1024) throw new RequestError(413, '消息过长');
    chunks.push(chunk);
  }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new RequestError(400, 'JSON 格式有误'); }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new RequestError(400, '请求内容有误');
  return data;
}

function historyOptions(params) {
  const options = {};
  for (const name of ['since', 'limit']) {
    if (!params.has(name)) continue;
    const value = params.get(name);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new RequestError(400, '无效的历史范围');
    options[name] = Number(value);
  }
  return options;
}

async function api(req, res, url) {
  if (labMode && !['/app/history', '/app/send', '/app/regenerate', '/app/model'].includes(url.pathname)) {
    throw new RequestError(404, '试验线路只开放聊天');
  }
  if (url.pathname === '/app/history' && req.method === 'GET') {
    return json(res, 200, await store.history(historyOptions(url.searchParams)));
  }
  const origin = req.headers.origin;
  if ((origin && origin !== url.origin) || req.headers['sec-fetch-site'] === 'cross-site') {
    throw new RequestError(403, '此操作仅在本机小屋可用');
  }
  const pocket = /^\/app\/pocket(?:\/([^/]+))?$/.exec(url.pathname);
  if (pocket) {
    const id = pocket[1];
    if (req.method === 'GET') return json(res, 200, id ? store.pocket.read(id) : store.pocket.list());
    if (req.method !== 'POST') throw new RequestError(405, '请求方法有误');
    const input = await readJson(req);
    return json(res, 200, id ? store.pocket.setDiscussed(id, input) : store.pocket.create(input));
  }
  const handlers = new Map([
    ['/app/send', store.send], ['/app/model', store.selectModel], ['/app/regenerate', store.regenerate],
    ['/app/archive/search', store.searchArchive], ['/app/archive/read', store.readArchiveSource],
    ['/app/archive/bind', store.bindEvidence], ['/app/archive/evidence', store.evidence]
  ]);
  const action = handlers.get(url.pathname);
  if (!action) throw new RequestError(404, '接口不存在');
  if (req.method !== 'POST') throw new RequestError(405, '请求方法有误');
  return json(res, 200, await action(await readJson(req)));
}

function asset(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new RequestError(405, '请求方法有误');
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); }
  catch { throw new RequestError(400, '路径错误'); }
  if (/[\\:\0]/.test(pathname)) throw new RequestError(404, '找不到页面');
  let file = resolve(dist, '.' + pathname);
  if (!inside(dist, file)) throw new RequestError(404, '找不到页面');
  if (['/chat', '/diary', '/living', '/living/pocket'].includes(pathname) || pathname.endsWith('/')) file = resolve(file, 'index.html');
  if (!existsSync(file) || !inside(realpathSync(dist), realpathSync(file)) || !statSync(file).isFile()) {
    throw new RequestError(404, '找不到页面');
  }
  const ext = extname(file);
  res.setHeader('Content-Type', mime[ext] ?? 'application/octet-stream');
  if (file === resolve(dist, 'chat/index.html') || (!labMode && file === resolve(dist, 'living/pocket/index.html'))) {
    res.setHeader('Content-Security-Policy', privateCsp);
    const mode = 'data-chat-store="gateway" ' + (memoryMode ? 'data-memory-lab ' : providerMode ? 'data-provider-lab ' : '');
    const html = readFileSync(file, 'utf8').replace('<html ', '<html ' + mode);
    res.end(req.method === 'HEAD' ? undefined : html);
    return;
  }
  // Safari requests audio in byte ranges for playing and seeking the packaged sample.
  const size = statSync(file).size;
  let range;
  if (ext === '.mp3') {
    res.setHeader('Accept-Ranges', 'bytes');
    if (req.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (match && (match[1] || match[2])) {
        const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
        const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
        if (start <= end && start < size) range = { start, end };
      }
      if (!range) {
        res.writeHead(416, { 'Content-Range': 'bytes */' + size });
        return res.end();
      }
      res.statusCode = 206;
      res.setHeader('Content-Range', 'bytes ' + range.start + '-' + range.end + '/' + size);
    }
  }
  res.setHeader('Content-Length', range ? range.end - range.start + 1 : size);
  if (req.method === 'HEAD') return res.end();
  const stream = createReadStream(file, range);
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

const server = createServer(async (req, res) => {
  try {
    for (const [key, value] of Object.entries(baseHeaders)) res.setHeader(key, value);
    const host = req.headers.host;
    const localPort = server.address().port;
    if (host !== '127.0.0.1:' + localPort && host !== 'localhost:' + localPort) {
      throw new RequestError(403, '仅允许本机访问');
    }
    const origin = 'http://' + host;
    const url = new URL(req.url, origin);
    if (url.origin !== origin) throw new RequestError(400, '请求地址错误');
    if (url.pathname.startsWith('/app/')) await api(req, res, url);
    else asset(req, res, url);
  } catch (error) {
    if (res.headersSent) return res.destroy();
    const expected = error instanceof RequestError;
    if (!expected) console.error('Local gateway error:', error.code ?? error.name);
    json(res, expected ? error.status : 500, { error: expected ? error.message : '本机服务暂时不可用' });
  }
});
server.on('close', () => { store.close(); fixture?.close(); });
if (fixture) {
  server.on('error', error => { fixture.close(); throw error; });
  process.once('SIGINT', () => server.close());
  process.once('SIGTERM', () => server.close());
}
server.listen(port, '127.0.0.1', () => {
  console.log((providerMode ? 'Haven provider lab' : memoryMode ? 'Haven memory lab' : 'Haven local mock') + ': http://127.0.0.1:' + server.address().port + '/chat/');
});

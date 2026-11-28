import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { openStore, RequestError } from './store.mjs';
import { models as mockModels } from '../room/catalog.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const { values } = parseArgs({ options: {
  port: { type: 'string' }, db: { type: 'string' }, 'memory-lab': { type: 'boolean' },
  'provider-lab': { type: 'boolean' }, 'live-lab': { type: 'boolean' }, 'anniversary-trial': { type: 'boolean' }
} });
const memoryMode = values['memory-lab'] === true;
const providerMode = values['provider-lab'] === true;
const liveMode = values['live-lab'] === true;
if (values['anniversary-trial'] && (!liveMode || values.db !== undefined)) throw Error('Use the local live chat for this trial.');
if ([memoryMode, providerMode, liveMode].filter(Boolean).length > 1) throw new Error('Choose one lab per process.');
const labMode = memoryMode || providerMode || liveMode;
const defaultPort = liveMode ? 4194 : providerMode ? 4192 : memoryMode ? 4191 : 4190;
const portOption = values.port ?? String(defaultPort);
const port = Number(portOption);
if (!/^\d+$/.test(portOption) || !Number.isInteger(port) || port > 65535) throw new Error('Invalid --port');
if (labMode && ([4190,4191,4192,4193,4194].includes(port) && port !== defaultPort || (values.db !== undefined && !liveMode))) {
  throw new Error('Use the dedicated lab database and a separate port.');
}
const labDir = liveMode ? 'live-lab' : providerMode ? 'provider-lab' : 'ombre-lab';
const database = resolve(values.db ?? (labMode ? resolve(root, '.haven-local', labDir, 'chat.sqlite') : resolve(root, '.haven-local/room.sqlite')));
const dist = resolve(root, 'dist');
if (!existsSync(resolve(dist, 'chat/index.html'))) throw new Error('Run npm run build first.');

function inside(dir, path) {
  const part = relative(dir, path);
  return part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part);
}

if (inside(dist, database)) throw new Error('The private database must be outside dist.');
if (liveMode && values.db !== undefined) {
  // Isolated integration tests can use a disposable database with a loopback-only provider.
  const endpoint = new URL(process.env.HAVEN_TRIAL_BASE_URL);
  if (!['127.0.0.1','[::1]'].includes(endpoint.hostname) ||
      !inside(realpathSync(tmpdir()), realpathSync(dirname(database))) ||
      (existsSync(database) && !inside(realpathSync(tmpdir()), realpathSync(database)))) {
    throw new Error('A live lab database override requires a temporary database and a local test provider.');
  }
}
mkdirSync(dirname(database), { recursive: true, mode: 0o700 });
const lab = (memoryMode || providerMode) ? (await import('./ombre-lab.mjs')).createOmbreLab() : undefined;
const storeOptions = memoryMode ? { memoryLab: lab } : {};
let fixture;
let live;
let memoryDrawer;
let memoryDashboard;
if (liveMode) {
  if (process.env.HAVEN_MEMORY_DASHBOARD_ORIGIN) {
    memoryDashboard = new URL(process.env.HAVEN_MEMORY_DASHBOARD_ORIGIN);
    if (memoryDashboard.protocol !== 'http:' || memoryDashboard.hostname !== '127.0.0.1' ||
        memoryDashboard.href !== memoryDashboard.origin + '/') {
      throw new Error('The memory drawer requires a loopback dashboard origin.');
    }
    if (values.db !== undefined && memoryDashboard.port === '8002') {
      throw new Error('Use a separate dashboard fixture with a temporary chat database.');
    }
    const { createOmbreBuckets } = await import('./ombre-buckets.mjs');
    memoryDrawer = createOmbreBuckets(memoryDashboard.origin);
  }
  const { createLiveRoutes } = await import('./live-routes.mjs');
  const { searchLiveFixture } = await import('./ombre-lab.mjs');
  const { createPersonalOmbre } = await import('./ombre-search.mjs');
  let memoryTrial;
  if (values['anniversary-trial']) {
    const { createAnniversaryTrial } = await import('./anniversary-trial.mjs');
    const grant = JSON.parse(readFileSync(resolve(dirname(database), 'anniversary-trial.json'), 'utf8'));
    memoryTrial = { ...createAnniversaryTrial(grant.thread, memoryDashboard?.origin, grant.selection), model: grant.model };
  }
  const { createLocalCredentialStore } = await import('./local-credential-store.mjs');
  live = createLiveRoutes({ baseURL: process.env.HAVEN_TRIAL_BASE_URL, apiKey: process.env.HAVEN_TRIAL_API_KEY,
    credentialStore: createLocalCredentialStore(dirname(database)), searchMemory: searchLiveFixture, memoryTrial,
    readCalendar: memoryTrial ? undefined : (args, day, route) => store.calendar.read(args, day, route),
    personalMemory: memoryDashboard && !memoryTrial && values.db === undefined ? createPersonalOmbre(memoryDashboard.origin) : undefined,
    model: process.env.HAVEN_TRIAL_MODEL, profileFile: resolve(dirname(database), 'providers.json') });
  Object.assign(storeOptions, { provider: 'live-lab', models: live.active('mock').models,
    modelsForRoute: route => live.active(route).models,
    supportsWindowKey: true, resumePendingOnRead: false, enableCalendar: !memoryTrial,
    ...(values.db !== undefined && { embedder: false }),
    complete(request, options) {
      if (request.route !== store.windowRoute(request.thread) || request.model !== store.windowModel(request.thread)) {
        throw new RequestError(409, '本窗口的线路已经改变。请切回原线路后重试这条消息。');
      }
      return live.complete(request, options);
    } });
}
if (providerMode) {
  const { startProviderFixture } = await import('./provider-fixture.mjs');
  const { createChatCompletions } = await import('./chat-completions.mjs');
  const { withFixtureMemory } = await import('./provider-turn.mjs');
  fixture = await startProviderFixture();
  Object.assign(storeOptions, { models: fixture.models, provider: 'home-fixture', supportsWindowKey: true,
    complete: withFixtureMemory(createChatCompletions(fixture), lab) });
}
const store = openStore(database, storeOptions);
const config = JSON.parse(readFileSync(resolve(root, 'vercel.json'), 'utf8'));
const baseHeaders = Object.fromEntries(config.headers[0].headers.map(({ key, value }) => [key, value]));
baseHeaders['X-Content-Type-Options'] = 'nosniff';
baseHeaders['Cache-Control'] = 'no-store';
baseHeaders['Cross-Origin-Resource-Policy'] = 'same-origin';
if (liveMode) {
  baseHeaders['Referrer-Policy'] = 'no-referrer';
  baseHeaders['X-Frame-Options'] = 'DENY';
  baseHeaders['Content-Security-Policy'] += "; frame-ancestors 'none'";
}
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

async function streamChat(res, action, input) {
  function frame(event) {
    if (res.destroyed) return; // The accepted turn still finishes and saves if the tab closes.
    if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
    res.write(JSON.stringify(event) + '\n');
  }
  try {
    const result = await action(input, text => frame({ type: 'text', text }));
    frame({ type: 'done', result }); // The store has committed the completed message and its usage.
  } catch (error) {
    if (!res.headersSent) throw error;
    const expected = error instanceof RequestError;
    frame({ type: 'error', status: expected ? error.status : 500,
      error: expected ? error.message : '回复中断了，请重试。' });
  }
  if (!res.destroyed) res.end();
}

async function readJson(req, maxBytes = 256 * 1024) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new RequestError(415, '需要 JSON 请求');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new RequestError(413, '消息过长');
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
  if (params.has('thread')) options.thread = params.get('thread');
  for (const name of ['since', 'limit']) {
    if (!params.has(name)) continue;
    const value = params.get(name);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new RequestError(400, '无效的历史范围');
    options[name] = Number(value);
  }
  return options;
}

async function api(req, res, url) {
  const origin = req.headers.origin;
  if ((origin && origin !== url.origin) || req.headers['sec-fetch-site'] === 'cross-site') {
    throw new RequestError(403, '此操作仅在本机小屋可用');
  }
  if (live && req.method === 'POST' && origin !== url.origin) {
    throw new RequestError(403, '请从本机小屋内操作。');
  }
  if (url.pathname.startsWith('/app/calendar/')) {
    if (!store.calendar) throw new RequestError(404, '这个小屋没有连接本机日历。');
    const target = live.calendarTarget(store);
    if (url.pathname === '/app/calendar/storybook' && req.method === 'GET') {
      const thread = store.calendar.storyThreadFor(target.route);
      const messages = thread ? (await store.history({ thread })).messages : [];
      return json(res, 200, { messages, canAsk: target.ready });
    }
    if (url.pathname === '/app/calendar/month' && req.method === 'GET') {
      return json(res, 200, store.calendar.month(url.searchParams.get('month'), target.route));
    }
    if (url.pathname === '/app/calendar/day' && req.method === 'GET') {
      const date = url.searchParams.get('date');
      const notes = store.calendar.notes(date, target.route);
      if (url.searchParams.get('view') === 'notes') return json(res, 200, { date, notes });
      const fields = store.calendar.fields(date);
      const thread = store.calendar.threadFor(date, target.route);
      const messages = thread ? (await store.history({ thread })).messages : [];
      messages.push(...store.calendar.stars(date, target.route, thread));
      messages.sort((a, b) => a.id - b.id);
      return json(res, 200, { date, fields, messages, notes, canAsk: false });
    }
    if (req.method !== 'POST') throw new RequestError(405, '请求方法有误。');
    const input = await readJson(req, 8192);
    if (url.pathname === '/app/calendar/record') return json(res, 200, store.calendar.save(input));
    throw new RequestError(404, '日历接口不存在。');
  }
  if (url.pathname.startsWith('/app/memory/')) {
    if (!memoryDrawer) throw new RequestError(404, '这个小屋没有连接本机记忆柜。');
    if (url.pathname === '/app/memory/dashboard' && req.method === 'GET') {
      // Ombre issues a host-only session cookie. Stay on the hostname used by this browser.
      const target = new URL(memoryDashboard);
      target.hostname = url.hostname;
      res.writeHead(302, { Location: target.href });
      return res.end();
    }
    if (req.headers['x-haven-drawer'] !== '1') throw new RequestError(403, '请从本机记忆抽屉打开。');
    const path = /^\/app\/memory\/(network|buckets)(?:\/([^/]+)(\/pin)?)?$/.exec(url.pathname);
    if (!path || (path[1] === 'network' && path[2])) throw new RequestError(404, '记忆接口不存在。');
    if (req.method !== (path[3] ? 'POST' : 'GET')) throw new RequestError(405, '请求方法有误。');
    // Only the dashboard's own browser session goes to the configured loopback service.
    const session = (req.headers.cookie || '').split(';').map(part => part.trim())
      .find(part => /^ombre_session=[A-Za-z0-9_-]{1,256}$/.test(part));
    if (!session) throw new RequestError(401, '请先登录本机 Ombre，再刷新抽屉。');
    if (path[1] === 'network') return json(res, 200, await memoryDrawer.network(session));
    if (!path[2]) return json(res, 200, await memoryDrawer.list(session, url.searchParams));
    let id;
    try { id = decodeURIComponent(path[2]); }
    catch { throw new RequestError(400, '记忆编号无效。'); }
    const result = path[3] ? await memoryDrawer.pin(session, id, await readJson(req, 512))
      : await memoryDrawer.detail(session, id);
    return json(res, 200, result);
  }
  if (labMode && !['/app/history', '/app/send', '/app/regenerate', '/app/model', '/app/windows', '/app/context',
    '/app/routes', '/app/routes/providers', '/app/routes/models', '/app/routes/forget-key', '/app/routes/memory', '/app/tools', '/app/provider-cache'].includes(url.pathname)) {
    throw new RequestError(404, '接口不存在。');
  }
  if (live && url.pathname === '/app/tools' && req.method === 'GET') {
    return json(res, 200, await live.toolList(store, url.searchParams.get('thread') ?? 'window', url.searchParams.get('refresh') === '1'));
  }
  if (live && url.pathname.startsWith('/app/routes/')) {
    if (req.method !== 'POST') throw new RequestError(405, '请求方法有误');
    const action = { '/app/routes/providers': live.add, '/app/routes/models': live.refresh,
      '/app/routes/forget-key': live.forgetKey, '/app/routes/memory': live.setMemorySource }[url.pathname];
    if (!action) throw new RequestError(404, '接口不存在');
    return json(res, 200, await action(store, await readJson(req, 8192)));
  }
  if (url.pathname === '/app/routes') {
    if (req.method === 'GET') {
      const thread = url.searchParams.get('thread') ?? 'window';
      if (live) return json(res, 200, live.status(store, thread));
      return json(res, 200, { thread, model: store.windowModel(thread), route: 'mock', endpoint: null, hasKey: false,
        routes: [{ id: 'mock', label: providerMode ? '合成 API' : '本机模拟', models: storeOptions.models ?? mockModels }] });
    }
    if (live && req.method === 'POST') return json(res, 200, live.select(store, await readJson(req, 8192)));
    throw new RequestError(405, '请求方法有误');
  }
  if (url.pathname === '/app/history' && req.method === 'GET') {
    const history = await store.history(historyOptions(url.searchParams));
    if (live) {
      const route = live.active(history.route);
      history.routeLabel = route.label;
      history.hasKey = route.hasKey;
      history.requiresKey = route.requiresKey;
      history.catalogReady = route.catalogReady;
      history.memoryScope = live.memoryScope(route.id, history.model);
      if (live.isAnniversaryWindow(history.thread, route.id, history.model)) history.anniversaryTrial = true;
    }
    return json(res, 200, history);
  }
  if (url.pathname === '/app/windows' && req.method === 'GET') return json(res, 200, store.listWindows());
  if (url.pathname === '/app/provider-cache' && req.method === 'GET') {
    return json(res, 200, { defaultWindowKey: store.defaultWindowKey(url.searchParams.get('thread') ?? undefined) });
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
    ['/app/windows', store.createWindow], ['/app/context', store.configureContext],
    ['/app/provider-cache', store.setDefaultWindowKey],
    ['/app/archive/search', store.searchArchive], ['/app/archive/read', store.readArchiveSource],
    ['/app/archive/bind', store.bindEvidence], ['/app/archive/evidence', store.evidence]
  ]);
  const action = handlers.get(url.pathname);
  if (!action) throw new RequestError(404, '接口不存在');
  if (req.method !== 'POST') throw new RequestError(405, '请求方法有误');
  let input = await readJson(req);
  if (url.pathname === '/app/send' && input.calendarDate !== undefined) {
    throw new RequestError(410, '阿川的日记本已改为翻阅。想给他出题，请刷新后打开故事本。');
  }
  if (url.pathname === '/app/send' && input.storybook === true) {
    if (!store.calendar) throw new RequestError(404, '这个小屋没有连接本机日历。');
    const target = live.calendarTarget(store, input.sourceThread);
    if (!target.ready) throw new RequestError(409, '请先在杂物间连接小屋的 Gemini 线路。');
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 1200 ||
        typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.requestId)) {
      throw new RequestError(400, '请填写 1200 字以内的故事题目，并带上发送编号。');
    }
    const thread = store.calendar.openStorybook(target);
    input = { thread, route: target.route, text: input.text, requestId: input.requestId };
  }
  if (live && ['/app/send', '/app/regenerate', '/app/model'].includes(url.pathname)) {
    const route = live.active(store.windowRoute(input.thread));
    const model = input.model ?? store.windowModel(input.thread);
    // Pre-directory clients could only select these two exact route/model pairs.
    const legacyRoute = model === 'iris-demo-a' ? 'mock' : model === 'vertex_ai/gemini-3.8-flash' ? 'gemini' : null;
    if ((input.route ?? legacyRoute) !== route.id || !route.models.includes(model)) {
      throw new RequestError(409, '本窗口的线路已经改变，请重新打开聊天框。');
    }
    if (url.pathname !== '/app/model' && route.requiresKey && !route.hasKey) {
      throw new RequestError(409, '请在杂物间为当前线路填写密钥。');
    }
  }
  if (req.headers.accept === 'application/x-ndjson' && ['/app/send', '/app/regenerate'].includes(url.pathname)) {
    return streamChat(res, action, input);
  }
  const result = await action(input);
  if (live && url.pathname === '/app/model') {
    result.memoryScope = live.memoryScope(result.route, result.model);
    result.anniversaryTrial = live.isAnniversaryWindow(input.thread, result.route, result.model);
  }
  return json(res, 200, result);
}

function asset(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new RequestError(405, '请求方法有误');
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); }
  catch { throw new RequestError(400, '路径错误'); }
  if (/[\\:\0]/.test(pathname)) throw new RequestError(404, '找不到页面');
  let file = resolve(dist, '.' + pathname);
  if (!inside(dist, file)) throw new RequestError(404, '找不到页面');
  if (['/chat', '/diary', '/living', '/living/pocket', '/living/adrian', '/living/adrian/memory', '/other'].includes(pathname) || pathname.endsWith('/')) file = resolve(file, 'index.html');
  if (!existsSync(file) || !inside(realpathSync(dist), realpathSync(file)) || !statSync(file).isFile()) {
    throw new RequestError(404, '找不到页面');
  }
  const ext = extname(file);
  res.setHeader('Content-Type', mime[ext] ?? 'application/octet-stream');
  if (memoryDrawer && file === resolve(dist, 'living/adrian/memory/index.html')) {
    res.setHeader('Content-Security-Policy', privateCsp);
    const html = readFileSync(file, 'utf8').replace('<html ', '<html data-memory-drawer="local" ');
    return res.end(req.method === 'HEAD' ? undefined : html);
  }
  if (file === resolve(dist, 'chat/index.html') || file === resolve(dist, 'other/index.html') ||
      (store.calendar && file === resolve(dist, 'diary/index.html')) ||
      (!labMode && file === resolve(dist, 'living/pocket/index.html'))) {
    res.setHeader('Content-Security-Policy', privateCsp);
    const mode = 'data-chat-store="gateway" ' + (liveMode ? 'data-live-lab ' : memoryMode ? 'data-memory-lab ' : providerMode ? 'data-provider-lab ' : '');
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
  const title = liveMode ? 'Haven Gemini chat' : providerMode ? 'Haven provider lab' : memoryMode ? 'Haven memory lab' : 'Haven local mock';
  console.log(title + ': http://127.0.0.1:' + server.address().port + (liveMode ? '/other/' : '/chat/'));
});

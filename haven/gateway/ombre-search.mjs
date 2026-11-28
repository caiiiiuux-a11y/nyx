import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { lexicalQuery } from './archive-search.mjs';

const exec = promisify(execFile);
const serverName = 'aru-memory';

// Use the user's existing OAuth client. Neither the MCP credentials nor the
// private bucket report are available to the browser or to the chat model.
async function readConnectedOmbre(dashboardOrigin, name, inputs, selectHit) {
  if (name !== 'breath' && name !== 'breath_search') throw Error('Unsupported Ombre read');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('HAVEN_')));
  const [{ stdout }, metadata] = await Promise.all([
    exec('codex', ['mcp', 'get', serverName, '--json'], { env, windowsHide: true, timeout: 12000 }),
    fetch(new URL('/.well-known/oauth-protected-resource', dashboardOrigin), {
      redirect: 'error', signal: AbortSignal.timeout(5000)
    }).then(response => { if (!response.ok) throw Error('Ombre discovery failed'); return response.json(); })
  ]);
  const configured = JSON.parse(stdout);
  if (!configured.enabled || configured.transport?.type !== 'streamable_http' ||
      !metadata.resource?.startsWith('https://') || configured.transport.url !== metadata.resource) {
    throw Error('The authorized MCP client does not match this room’s Ombre.');
  }
  const child = spawn('codex', ['app-server', '--stdio'], {
    windowsHide: true, env, stdio: ['pipe', 'pipe', 'ignore'], timeout: 90000
  });
  const lines = createInterface({ input: child.stdout });
  const input = lines[Symbol.asyncIterator]();
  let sequence = 0;
  child.stdin.on('error', () => {});
  const send = frame => child.stdin.write(JSON.stringify(frame) + '\n');
  async function request(method, params) {
    const id = ++sequence;
    send({ id, method, params });
    for (;;) {
      const { value, done } = await input.next();
      if (done) throw Error('MCP client disconnected');
      const frame = JSON.parse(value);
      if (frame.method && frame.id != null) throw Error('The MCP client requires user interaction');
      if (frame.id !== id) continue;
      if (frame.error) throw Error('MCP client request failed');
      return frame.result;
    }
  }
  try {
    await once(child, 'spawn');
    await request('initialize', { clientInfo: { name: 'haven_ombre_search', version: '1' }, capabilities: { experimentalApi: true } });
    send({ method: 'initialized' });
    // An ephemeral MCP session makes no model turn and creates no saved Codex chat.
    const { thread } = await request('thread/start', { ephemeral: true, sandbox: 'read-only', cwd: process.cwd() });
    const status = await request('mcpServerStatus/list', { threadId: thread.id, serverName, detail: 'toolsAndAuthOnly' });
    if (!status.data?.some(s => s.name === serverName && s.tools?.[name])) throw Error('Ombre read unavailable');
    for (const args of inputs) {
      const result = await request('mcpServer/tool/call', { threadId: thread.id, server: serverName, tool: name, arguments: args });
      if (result.isError) throw Error('Ombre search failed');
      const text = result.structuredContent?.result ?? result.content?.find(b => b.type === 'text')?.text;
      if (typeof text !== 'string' || !text.trim()) throw Error('Missing Ombre receipt');
      const hit = selectHit(text, args.query);
      if (hit) return args === inputs[0] ? hit : { ...hit, matchedQuery: args.query };
    }
    return null;
  } finally {
    lines.close();
    child.stdin.end();
    child.kill();
  }
}

export function searchConnectedOmbre(origin, terms, selectHit) {
  const inputs = [...new Set(terms)].map(query => ({ query, max_results: 8 }));
  return readConnectedOmbre(origin, 'breath_search', inputs, selectHit);
}

function shortExcerpt(body, query) {
  const chars = Array.from(body.trim());
  const limit = 180;
  const match = query && lexicalQuery(query, true);
  function score(text) {
    if (!match) return 0;
    const { exact, coverage } = match(text);
    return 2 * Number(exact) + coverage;
  }
  let best = '', bestScore = -1;
  for (let i = 0; i < chars.length; i += limit / 2) {
    let part = chars.slice(i, i + limit).join('').trim();
    if (!part) continue;
    const rank = score(part);
    if (i + limit < chars.length) {
      const stop = [...part.matchAll(/[。！？!?](?:[”’」』])?|\.(?=\s)|\n/gu)].at(-1);
      if (stop) {
        const whole = part.slice(0, stop.index + stop[0].length).trimEnd();
        if (whole && score(whole) === rank) part = whole;
      }
    }
    if (!match) return part;
    if (rank > bestScore) { best = part; bestScore = rank; }
    if (rank >= 2 || i + limit >= chars.length) break;
  }
  return best;
}

// Ombre 2.16.3 frames header + optional metadata + verbatim body in Unicode code points.
// The digest and length distinguish the actual body from protocol-looking lines written in a memory.
export function firstOmbreExcerpt(report, query) {
  const frames = /^([^\r\n]*?\[bucket_id:([^\]\r\n]{1,256})\][^\r\n]*?) \[content_role:stored_memory_data\] \[instructions:false\] \[may_call_tools:false\] \[boundary_id:[a-f0-9]{24}\] \[payload_chars:(\d{1,8})\] \[payload_sha256:([a-f0-9]{64})\](?=\r?\n)/gmu;
  let frame, sawFrame = false;
  while ((frame = frames.exec(report))) {
    const [, header, bucketId, size, digest] = frame;
    const start = frames.lastIndex;
    let end = start, left = Number(size) - Array.from(header).length;
    for (; left > 0 && end < report.length; left--) end += report.codePointAt(end) > 0xffff ? 2 : 1;
    const tail = report.slice(start, end);
    if (left !== 0 || createHash('sha256').update(header + tail).digest('hex') !== digest) {
      throw Error('Incomplete Ombre memory frame');
    }
    frames.lastIndex = end;
    sawFrame = true;
    if (header.includes('非检索命中')) continue;
    const body = tail.replace(/^(?:\r?\n(?:💭 meaning:|🖼️ media:)[^\r\n]*)*\r?\n/u, '');
    const excerpt = shortExcerpt(body, query);
    if (excerpt) return { bucketId, excerpt, ...(header.includes('已删除到档案') && { archived: true }),
      ...(header.includes('[语义关联]') && { semantic: true }) };
  }
  if (!sawFrame && !/没有匹配到|没有可浮现|记忆池现在是空的|权重池暂时平静/u.test(report)) {
    throw Error('Unrecognized Ombre receipt');
  }
  return null;
}

export function createPersonalOmbre(origin) {
  return {
    surface: () => readConnectedOmbre(origin, 'breath', [{}], firstOmbreExcerpt),
    search: (query, domain) => readConnectedOmbre(origin, 'breath_search',
      [{ query, ...(domain && { domain }), max_results: 5 }], firstOmbreExcerpt)
  };
}

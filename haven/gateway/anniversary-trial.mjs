import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const serverName = 'aru-memory';
export const anniversaryQuestion = '阿川，我们的纪念日是哪一天？';
const keywords = ['纪念日', '确认恋爱关系'];

// Use the user's existing OAuth client. Neither the MCP credentials nor the
// private bucket report are available to the browser or to the chat model.
async function searchConnectedMemory(dashboardOrigin, query, allowed) {
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
    await request('initialize', { clientInfo: { name: 'haven_memory_trial', version: '1' }, capabilities: { experimentalApi: true } });
    send({ method: 'initialized' });
    // An ephemeral MCP session makes no model turn and creates no saved Codex chat.
    const { thread } = await request('thread/start', { ephemeral: true, sandbox: 'read-only', cwd: process.cwd() });
    const status = await request('mcpServerStatus/list', { threadId: thread.id, serverName, detail: 'toolsAndAuthOnly' });
    if (!status.data?.some(s => s.name === serverName && s.tools?.breath_search)) throw Error('Search unavailable');
    for (const term of new Set([query, ...keywords])) {
      const result = await request('mcpServer/tool/call', { threadId: thread.id, server: serverName, tool: 'breath_search',
        arguments: { query: term, max_results: 8 } });
      if (result.isError) throw Error('Ombre search failed');
      const text = result.structuredContent?.result ?? result.content?.find(b => b.type === 'text')?.text;
      if (typeof text !== 'string' || !text.trim()) throw Error('Missing Ombre receipt');
      const hit = approvedExcerpt(text, allowed);
      if (hit) return term === query ? hit : { ...hit, matchedQuery: term };
    }
    return null;
  } finally {
    lines.close();
    child.stdin.end();
    child.kill();
  }
}

// A local selection contains only an ID, length and digest. The characters
// shown in the citation must be read from a direct match in this live call.
export function approvedExcerpt(raw, allowed) {
  const entries = raw.split(/(?=^[^\r\n]*?\[bucket_id:[^\]\r\n]+\][^\r\n]*\r?$)/m);
  for (const entry of entries) {
    const end = entry.indexOf('\n');
    const header = entry.slice(0, end);
    if (end < 0 || !header.includes('[bucket_id:' + allowed.bucketId + ']') || header.includes('非检索命中')) continue;
    const body = entry.slice(end + 1).split(/\r?\n(?:👣 Footprint|---(?:\r?\n|$))/u, 1)[0];
    for (let start = 0; start + allowed.length <= Math.min(body.length, 32768); start++) {
      const excerpt = body.slice(start, start + allowed.length);
      if (createHash('sha256').update(excerpt).digest('hex') === allowed.sha256) {
        return { bucketId: allowed.bucketId, excerpt };
      }
    }
  }
  return null;
}

export function createAnniversaryTrial(thread, dashboardOrigin, allowed, lookup = searchConnectedMemory) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(thread) || !dashboardOrigin ||
      !allowed || typeof allowed.bucketId !== 'string' || !/^[a-z\d_-]{1,80}$/i.test(allowed.bucketId) ||
      !Number.isSafeInteger(allowed.length) || allowed.length < 2 || allowed.length > 160 ||
      typeof allowed.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(allowed.sha256)) {
    throw Error('The anniversary trial requires a window and a short, private excerpt selection.');
  }
  let receipt;
  return { thread, question: anniversaryQuestion,
    tool: { name: 'memory_search', description: '按本轮授权查阅真实 Ombre，以返回的原文核对纪念日。缺少确切日期时如实说明。',
      parameters: { type: 'object', properties: { query: { type: 'string', enum: keywords } }, required: ['query'], additionalProperties: false } },
    search(query) {
      if (!keywords.includes(query)) throw Error('Outside this trial');
      // A retry of this question reuses the confirmed result. A transport failure is retryable.
      return receipt ??= lookup(dashboardOrigin, query, allowed).catch(error => { receipt = undefined; throw error; });
    }
  };
}

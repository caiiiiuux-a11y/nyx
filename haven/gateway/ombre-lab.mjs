import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { memoryLabExample } from '../room/memory-lab-example.mjs';

const labName = 'iris-memory-lab';
const provider = labName + '-provider';
const providerImage = 'sha256:c7c42dc89c99339d40c724f98e669aeffee89ac41948371d3e223adcb930b36d';
const dockerHost = process.platform === 'win32' ? 'npipe:////./pipe/docker_engine' : 'unix:///var/run/docker.sock';
const oldClients = new URL('../../../iris-adrian-home-phase2/server/', import.meta.url);
const clientFiles = ['capability_client.py', 'memory_oauth_client.py'];

function docker(args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile('docker', ['--host', dockerHost, ...args], {
      windowsHide: true, timeout: 35_000, maxBuffer: 768 * 1024, encoding: 'utf8'
    }, (error, stdout) => {
      // Child process errors contain argv and stderr. Only publish the lab-level failure.
      if (error) reject(new Error('旧家园的隔离记忆服务未完成调用，请检查本机测试容器和合成证书'));
      else resolve(stdout.trim());
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function requireIsolation(condition) {
  if (!condition) throw new Error('旧家园测试容器的隔离配置不匹配，调用已停止');
}

// Allow the old launcher's read-only program mounts and its two dedicated data volumes.
const mounts = new Map([
  ['/memory-lab', '/phase2/memory-lab'], ['/lab-pin.json', '/design/chatgpt-memory.pin.json'],
  ...['src', 'frontend', 'VERSION', 'requirements.lock.txt', '.seeded_image_version', '.seeded_image_fingerprint']
    .map(part => ['/runtime/' + part, '/buckets-chatgpt/_app/' + part]),
  ['/runtime/src/server.py', '/patches/async-grow/server.py'],
  ['/runtime/src/tools/grow/jobs.py', '/patches/async-grow/jobs.py'],
  ['/app/buckets', labName + '-vault'], ['/lab-tls', labName + '-tls']
]);

async function isolatedContainer() {
  const fields = [
    '.Id', '.Image', '.State.Running', '.Config.Labels', '.Config.Entrypoint', '.Config.Cmd',
    '.Mounts', '.NetworkSettings.Networks', '.NetworkSettings.Ports', '.HostConfig.Privileged'
  ];
  const report = await docker(['container', 'inspect', '--format', fields.map(f => '{{json ' + f + '}}').join('\n'), provider]);
  const [id, image, running, labels, entrypoint, cmd, actualMounts, networks, ports, privileged] =
    report.split(/\r?\n/).map(line => JSON.parse(line));
  requireIsolation(/^[0-9a-f]{64}$/.test(id) && image === providerImage && running && !privileged &&
    labels?.['local.iris.memory-lab'] === 'synthetic' &&
    JSON.stringify(entrypoint) === '["python"]' && JSON.stringify(cmd) === '["/memory-lab/provider.py"]');
  requireIsolation(actualMounts.length === mounts.size &&
    new Set(actualMounts.map(mount => mount.Destination)).size === mounts.size);
  for (const mount of actualMounts) {
    const expected = mounts.get(mount.Destination);
    requireIsolation(expected && (expected.startsWith('/')
      ? mount.Type === 'bind' && !mount.RW && mount.Source.replaceAll('\\', '/').endsWith(expected)
      : mount.Type === 'volume' && mount.RW && mount.Name === expected && mount.Driver === 'local'));
  }
  const names = Object.keys(networks);
  requireIsolation(names.length === 1 && Object.values(ports ?? {}).every(bindings => !bindings?.length));
  if (names[0] !== 'none') {
    requireIsolation(names[0] === labName + '-private' &&
      await docker(['network', 'inspect', '--format', '{{.Internal}}', names[0]]) === 'true');
  }
  const volumes = JSON.parse(await docker(['volume', 'inspect', labName + '-vault', labName + '-tls']));
  requireIsolation(volumes.length === 2 && volumes.every(v => v.Driver === 'local' && !Object.keys(v.Options ?? {}).length));
  return id;
}

export function fixtureArguments(name, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('合成测试参数无效');
  const keys = Object.keys(args);
  if (name === 'hold' && keys.length === 1 && args.content === memoryLabExample.fact) {
    return { content: args.content, title: 'Paperfinch', tags: 'synthetic,haven-lab', importance: 5 };
  }
  if (name === 'breath_search' && keys.length === 1 && args.query === memoryLabExample.keyword) {
    return { query: args.query, max_results: 5 };
  }
  if (name === 'dream' && keys.length === 0) return { window_hours: 48, inspiration: false };
  throw new Error('隔离记忆只接受约定的合成示例');
}

export function fixtureReceipt(name, { text }) {
  if (typeof text !== 'string' || !text.trim() || /\[OB-E004\]/.test(text)) throw new Error('Ombre 未能完成合成记忆操作');
  let bucketId;
  if (name === 'hold') {
    bucketId = /^(?:新建|合并)→([^\s]{1,200})(?:\s|$)/m.exec(text)?.[1];
    if (!bucketId) throw new Error('Ombre 没有确认保存这条合成记忆');
  } else if (name === 'breath_search') {
    // Only bind a real hit to its own body. Ombre can append unrelated associations.
    const entries = text.matchAll(/^([^\n]*?\[bucket_id:([^\]\r\n]{1,200})\][^\n]*)\r?\n([^\r\n]+)/gm);
    for (const [, header, id, body] of entries) {
      if (!header.includes('非检索命中') && body === memoryLabExample.fact) bucketId = id;
    }
  } else if (name === 'dream') {
    const blocks = text.matchAll(/<<<STORED_MEMORY_DATA boundary="([0-9a-f]+)">>>([\s\S]*?)<<<END_STORED_MEMORY_DATA boundary="\1">>>/g);
    for (const [, , block] of blocks) {
      const body = block.split('payload_begin:\n')[1];
      if (!body?.includes(memoryLabExample.fact)) continue;
      const provenance = /^provenance: (\{[^\n]*\})$/m.exec(block)?.[1];
      if (provenance) bucketId = JSON.parse(provenance).bucket_id;
    }
  }
  return typeof bucketId === 'string' && bucketId.length <= 200 ? { text, bucketId } : { text };
}

export function createOmbreLab() {
  return {
    async callTool(name, args) {
      const toolArgs = fixtureArguments(name, args);
      const id = await isolatedContainer();
      const helper = await readFile(new URL('./ombre_lab_client.py', import.meta.url), 'utf8');
      const clients = {};
      for (const file of clientFiles) clients[file] = await readFile(new URL(file, oldClients), 'utf8');
      const payload = JSON.stringify({ name, arguments: toolArgs, clients });
      const raw = await docker(['exec', '-i', id, 'python', '-I', '-B', '-c', helper], payload);
      return fixtureReceipt(name, JSON.parse(raw));
    }
  };
}

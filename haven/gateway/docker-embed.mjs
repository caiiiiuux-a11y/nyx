import { execFile } from 'node:child_process';

// Use Ollama's batch HTTP API inside its existing container without publishing a port.
// Only this constant command runs in bash. Model names and all text travel in stdin.
const relay = 'exec 3<>/dev/tcp/127.0.0.1/11434 || exit 1; cat >&3 || exit 1; cat <&3';
const localDocker = process.platform === 'win32' ? 'npipe:////./pipe/docker_engine' : 'unix:///var/run/docker.sock';

async function ollama(container, path, data) {
  const body = data ? Buffer.from(JSON.stringify(data)) : Buffer.alloc(0);
  const headers = [
    (data ? 'POST ' : 'GET ') + path + ' HTTP/1.0',
    'Host: localhost', 'Connection: close', 'Content-Type: application/json',
    'Content-Length: ' + body.length, '', ''
  ].join('\r\n');
  const output = await new Promise((resolve, reject) => {
    const child = execFile('docker', ['--host', localDocker, 'exec', '-i', container, 'bash', '-c', relay], {
      timeout: 90000, maxBuffer: 12 * 1024 * 1024, windowsHide: true
    }, (error, stdout) => {
      if (error) reject(new Error('本机容器内的向量服务不可用'));
      else resolve(stdout);
    });
    child.stdin.on('error', reject);
    child.stdin.end(Buffer.concat([Buffer.from(headers), body]));
  });
  const split = output.indexOf('\r\n\r\n');
  if (split < 0 || !/^HTTP\/1\.[01] 200\b/.test(output)) throw new Error('本机向量服务未完成请求');
  return JSON.parse(output.slice(split + 4));
}

export function createDockerEmbedder({ container, model }) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(container)) throw new Error('无效的本机容器名称');
  const name = model.includes(':') ? model : model + ':latest';
  let identity;
  return {
    get identity() { return identity; },
    async embed(input) {
      const tags = await ollama(container, '/api/tags');
      const tag = tags.models.find(item => item.name === name);
      if (!tag?.digest) throw new Error('本机容器中没有所选的向量模型');
      const result = await ollama(container, '/api/embed', { model: name, input, truncate: false });
      identity = JSON.stringify(['raw-v1', 'ollama', name, tag.digest]);
      return result.embeddings;
    }
  };
}

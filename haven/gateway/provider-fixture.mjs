import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

// Use the tested provider from the old house without starting its Flask app or database.
export async function startProviderFixture() {
  const helper = fileURLToPath(new URL('./provider_fixture.py', import.meta.url));
  const child = spawn(process.platform === 'win32' ? 'python' : 'python3', ['-I', '-S', '-B', '-u', helper], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'inherit']
  });
  const exited = new Promise(resolve => child.once('close', resolve));
  const lines = createInterface({ input: child.stdout });
  let timer;
  try {
    const firstLine = await new Promise((resolve, reject) => {
      child.once('error', reject);
      lines.once('line', resolve);
      lines.once('close', () => reject(new Error('旧家园的合成模型未能启动，请检查相邻工作树和 Python。')));
      timer = setTimeout(() => reject(new Error('启动合成模型超时。')), 10_000);
    });
    const { port, apiKey, models } = JSON.parse(firstLine);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !apiKey || !Array.isArray(models) || !models.length) {
      throw new Error('合成模型的启动回执无效。');
    }
    return {
      baseURL: 'http://127.0.0.1:' + port + '/v1', apiKey, models,
      close() { child.stdin.end(); return exited; }
    };
  } catch (error) {
    child.kill();
    throw error;
  } finally {
    clearTimeout(timer);
    lines.close();
  }
}

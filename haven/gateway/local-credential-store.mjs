import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Windows PowerShell ships the .NET Framework DPAPI wrapper. Only this fixed
// program is visible on the command line. Its input and output use private pipes.
function transform(powershell, operation, binding, bytes) {
  const program = `
    $ErrorActionPreference = 'Stop'
    try {
      Add-Type -AssemblyName System.Security
      $binding = [Convert]::FromBase64String([Console]::ReadLine())
      $bytes = [Convert]::FromBase64String([Console]::ReadLine())
      $result = [Security.Cryptography.ProtectedData]::${operation}($bytes, $binding, [Security.Cryptography.DataProtectionScope]::CurrentUser)
      $outputPipe = [Console]::OpenStandardOutput()
      $outputPipe.Write($result, 0, $result.Length)
    } catch { exit 1 }
  `;
  const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', program], {
    input: binding.toString('base64') + '\n' + bytes.toString('base64') + '\n',
    stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, timeout: 10000, maxBuffer: 64 * 1024
  });
  if (result.error || result.status !== 0 || !result.stdout?.length) throw new Error('Windows 密钥保护操作失败。');
  return result.stdout;
}

export function createLocalCredentialStore(directory) {
  const powershell = process.platform === 'win32' && process.env.SystemRoot &&
    join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const available = Boolean(powershell && existsSync(powershell));
  const folder = join(directory, 'provider-keys');

  function location(id, endpoint) {
    const binding = createHash('sha256').update(JSON.stringify(['haven-route-key-v1', id, endpoint])).digest();
    return { binding, file: join(folder, binding.toString('hex') + '.dpapi') };
  }

  return {
    available,
    read(id, endpoint) {
      if (!available) return null;
      const { binding, file } = location(id, endpoint);
      try {
        return transform(powershell, 'Unprotect', binding, readFileSync(file)).toString('utf8');
      } catch {
        // A copied profile, damaged file, or different Windows account can re-enter the key.
        return null;
      }
    },
    write(id, endpoint, key) {
      if (!available) throw new Error('当前系统无法保存 Windows 账户密钥。');
      const { binding, file } = location(id, endpoint);
      const temp = file + '.' + randomUUID() + '.tmp';
      try {
        const ciphertext = transform(powershell, 'Protect', binding, Buffer.from(key, 'utf8'));
        mkdirSync(folder, {recursive: true, mode: 0o700});
        writeFileSync(temp, ciphertext, {flag: 'wx', mode: 0o600, flush: true});
        renameSync(temp, file);
      } catch {
        try { rmSync(temp, {force: true}); } catch { /* The temporary file contains only ciphertext. */ }
        throw new Error('未能在本机安全保存线路密钥。');
      }
    },
    remove(id, endpoint) {
      if (!available) return;
      const { file } = location(id, endpoint);
      try {
        rmSync(file, {force: true});
      } catch {
        throw new Error('未能移除本机保存的线路密钥。');
      }
    }
  };
}

import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';

const out = 'dist/ta';
await mkdir(out, { recursive: true });
for (const name of await readdir('ta')) {
  const source = 'ta/' + name;
  if (!name.endsWith('.html')) {
    await cp(source, out + '/' + name);
    continue;
  }
  // Nyx reads the query synchronously during startup, including after room transitions.
  const page = (await readFile(source, 'utf8'))
    .replace(/<link[^>]+https:\/\/fonts\.(?:googleapis|gstatic)\.com[^>]*>/g, '')
    .replace('<head>', `<head>
<meta name="robots" content="noindex, nofollow">
<link rel="license" href="/credits.html">
<script>
  const previewUrl = new URL(location.href);
  previewUrl.searchParams.set('demo', '1');
  history.replaceState(history.state, '', previewUrl);
</script>`);
  await writeFile(out + '/' + name, page);
}
await cp('LICENSE', 'dist/LICENSE.txt');
await cp('haven/credits.html', 'dist/credits.html');
await writeFile('dist/robots.txt', 'User-agent: *\nDisallow: /\n');
await writeFile('dist/index.html', '<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex, nofollow"><meta http-equiv="refresh" content="0;url=/ta/index.html"><a href="/ta/index.html">鸟 · 月 · 眼</a>');

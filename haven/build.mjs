import { cp, mkdir, readdir, writeFile } from 'node:fs/promises';

await Promise.all(['dist/chat', 'dist/room', 'dist/diary', 'dist/living/pocket', 'dist/living/adrian', 'dist/other'].map(dir => mkdir(dir, { recursive: true })));
for (const name of await readdir('haven/room')) {
  if (name === 'assets' || /\.(css|m?js)$/.test(name)) {
    await cp('haven/room/' + name, 'dist/room/' + name, { recursive: true });
  }
}
await cp('haven/room/home.html', 'dist/index.html');
await cp('haven/room/chat.html', 'dist/chat/index.html');
await cp('haven/room/diary.html', 'dist/diary/index.html');
await cp('haven/room/living-hub.html', 'dist/living/index.html');
await cp('haven/room/living.html', 'dist/living/pocket/index.html');
await cp('haven/room/adrian.html', 'dist/living/adrian/index.html');
await cp('haven/room/other.html', 'dist/other/index.html');
await cp('LICENSE', 'dist/LICENSE.txt');
await cp('haven/credits.html', 'dist/credits.html');
await writeFile('dist/robots.txt', 'User-agent: *\nDisallow: /\n');

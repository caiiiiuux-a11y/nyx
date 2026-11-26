const people = {
  adrian: { name: 'Adrian', animal: '小鹿', image: '/room/assets/pin-fawn.png' },
  iris: { name: 'Iris', animal: '白兔', image: '/room/assets/pin-rabbit.png' }
};
const byId = id => document.getElementById(id);
const dialog = byId('avatar-editor');
const fileInput = byId('avatar-file');
const reset = byId('avatar-default');
const status = byId('avatar-status');
const visible = byId('show-avatars');
const storageKey = person => 'haven.room.avatar.' + person;
const saved = new Map();
let selected;
let revision = 0;

try {
  for (const person of Object.keys(people)) {
    const data = localStorage.getItem(storageKey(person));
    if (data?.startsWith('data:image/jpeg;base64,')) saved.set(person, data);
  }
  // Existing users may already have opted out of the original deer marker.
  visible.checked = localStorage.getItem('haven.room.deer') !== 'off';
} catch { /* Browsers with storage disabled can still use the preview. */ }
document.body.classList.toggle('hide-avatars', !visible.checked);
visible.onchange = () => {
  document.body.classList.toggle('hide-avatars', !visible.checked);
  try { localStorage.setItem('haven.room.deer', visible.checked ? 'on' : 'off'); } catch {}
};

function paint(img, person) {
  img.src = saved.get(person) || people[person].image;
  img.classList.toggle('custom-portrait', saved.has(person));
}

export function avatarButton(person) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'chat-avatar';
  button.dataset.person = person;
  button.setAttribute('aria-label', '更换 ' + people[person].name + ' 的头像');
  button.setAttribute('aria-haspopup', 'dialog');
  const image = document.createElement('img');
  image.alt = '';
  paint(image, person);
  button.append(image);
  button.onclick = () => {
    selected = person;
    byId('avatar-title').textContent = people[person].name + ' 的头像';
    paint(byId('avatar-preview'), person);
    reset.textContent = '恢复默认' + people[person].animal;
    status.textContent = '头像仅保存在此浏览器。';
    dialog.showModal();
  };
  return button;
}

function update(data) {
  const key = storageKey(selected);
  if (data) {
    localStorage.setItem(key, data);
    saved.set(selected, data);
  } else {
    localStorage.removeItem(key);
    saved.delete(selected);
  }
  for (const button of document.querySelectorAll('.chat-avatar')) {
    if (button.dataset.person === selected) paint(button.firstElementChild, selected);
  }
  paint(byId('avatar-preview'), selected);
}

reset.onclick = () => {
  try {
    update(null);
    status.textContent = '已恢复默认头像。';
  } catch { status.textContent = '此浏览器无法清除已保存的头像。'; }
};
dialog.addEventListener('close', () => {
  revision++;
  fileInput.value = '';
  fileInput.disabled = reset.disabled = false;
});

fileInput.onchange = async () => {
  const file = fileInput.files[0];
  if (!file) return;
  const version = ++revision;
  const url = URL.createObjectURL(file);
  fileInput.disabled = reset.disabled = true;
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    if (version !== revision || !dialog.open) return;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    const ctx = canvas.getContext('2d');
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    ctx.fillStyle = '#faf2e9';
    ctx.fillRect(0, 0, 256, 256);
    ctx.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, 256, 256);
    update(canvas.toDataURL('image/jpeg', .85));
    status.textContent = '头像已保存。';
  } catch {
    if (version === revision) status.textContent = '图片无法读取或保存，请尝试较小的 JPEG 或 PNG。';
  } finally {
    URL.revokeObjectURL(url);
    if (version === revision) {
      fileInput.value = '';
      fileInput.disabled = reset.disabled = false;
    }
  }
};

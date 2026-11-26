const roomNav = document.getElementById('room-nav');
const rooms = [
  { key: 'home', name: 'Home', label: '首页', icon: 'home', href: '/' },
  { key: 'chat', name: 'Chat', label: '聊天', icon: 'chat', href: '/chat/' },
  { key: 'living', name: 'Living', label: '客厅', icon: 'memory', note: '一起看书、听歌和记忆柜会在这里。' },
  { key: 'other', name: 'Other', label: '杂物间', icon: 'other', note: '这里留给以后的设置与小工具。' }
];
const destination = document.createElement('dialog');
destination.className = 'room-destination';
destination.setAttribute('aria-labelledby','destination-name');
destination.innerHTML = '<h2 id="destination-name"></h2><p></p><a href="/credits.html">素材与署名</a><button type="button">知道了</button>';
document.body.append(destination);
destination.querySelector('button').onclick = () => destination.close();
for (const room of rooms) {
  const item = document.createElement(room.href ? 'a' : 'button');
  if (room.href) {
    item.href = room.href;
  } else {
    item.type = 'button';
    item.setAttribute('aria-haspopup','dialog');
    item.onclick = () => {
      destination.querySelector('h2').textContent = room.label;
      destination.querySelector('p').textContent = room.note;
      destination.showModal();
    };
  }
  if (document.body.dataset.page === room.key) item.setAttribute('aria-current','page');
  item.innerHTML = `<img alt="" src="/room/assets/nav-${room.icon}.png"><span lang="en">${room.name}</span><span class="nav-zh">${room.label}</span>`;
  roomNav.append(item);
}

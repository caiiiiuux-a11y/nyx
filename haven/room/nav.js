const roomNav = document.getElementById('room-nav');
const rooms = [
  { key: 'home', name: 'Home', label: '首页', icon: 'home', href: '/' },
  { key: 'chat', name: 'Chat', label: '聊天', icon: 'chat', href: '/chat/' },
  { key: 'living', name: 'Living', label: '客厅', icon: 'memory', href: '/living/' },
  { key: 'other', name: 'Other', label: '杂物间', icon: 'other', href: '/other/' }
];
for (const room of rooms) {
  const item = document.createElement('a');
  item.href = room.href;
  if (document.body.dataset.page === room.key) item.setAttribute('aria-current','page');
  item.innerHTML = `<img alt="" src="/room/assets/nav-${room.icon}.png"><span lang="en">${room.name}</span><span class="nav-zh">${room.label}</span>`;
  roomNav.append(item);
}

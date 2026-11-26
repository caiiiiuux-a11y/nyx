let opening = null;
let navigation;
const shelf = document.querySelector('.drawer-shelf');

function resetDrawer() {
  clearTimeout(navigation);
  opening?.classList.remove('is-opening');
  opening = null;
}

shelf.addEventListener('click', event => {
  const drawer = event.target.closest('a.room-drawer');
  if (!drawer || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey ||
      event.shiftKey || event.altKey || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  event.preventDefault();
  if (opening === drawer) return;
  resetDrawer();
  opening = drawer;
  drawer.classList.add('is-opening');
  navigation = setTimeout(() => location.assign(drawer.href), 255);
});
window.addEventListener('pagehide', resetDrawer);
window.addEventListener('pageshow', resetDrawer);

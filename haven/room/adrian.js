const drawer = document.getElementById('drawer');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let navigation;

drawer.addEventListener('click', event => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey ||
      event.shiftKey || event.altKey || reducedMotion.matches) return;
  event.preventDefault();
  if (navigation !== undefined) return;
  drawer.classList.add('is-opening');
  navigation = setTimeout(() => location.assign(drawer.href), 240);
});

window.addEventListener('pagehide', () => {
  clearTimeout(navigation);
  navigation = undefined;
  drawer.classList.remove('is-opening');
});

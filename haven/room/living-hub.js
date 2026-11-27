const doors = document.querySelector('.room-doors');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let selected = null;
let navigation;

function closeDoor() {
  clearTimeout(navigation);
  if (!selected) return;
  selected.classList.remove('is-open');
  if (selected.matches('button')) selected.setAttribute('aria-pressed', 'false');
  selected = null;
}

doors.addEventListener('click', async event => {
  const door = event.target.closest('.room-door');
  if (!door || event.defaultPrevented) return;
  const link = door.matches('a');
  if (link && (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || reducedMotion.matches)) return;
  if (link) event.preventDefault();
  if (door === selected) {
    if (!link) closeDoor();
    return;
  }
  closeDoor();
  selected = door;

  const frame = door.querySelector('.open-frame');
  if (!frame.complete) {
    // A slow or missing illustration must never block the real room link.
    const ready = frame.decode().catch(() => {});
    if (link) await Promise.race([ready, new Promise(resolve => setTimeout(resolve, 250))]);
    else await ready;
    if (selected !== door) return;
  }
  if (!frame.naturalWidth) {
    closeDoor();
    if (link) location.assign(door.href);
    return;
  }
  door.classList.add('is-open');
  if (link) navigation = setTimeout(() => location.assign(door.href), 320);
  else door.setAttribute('aria-pressed', 'true');
});
window.addEventListener('pagehide', closeDoor);
window.addEventListener('pageshow', closeDoor);

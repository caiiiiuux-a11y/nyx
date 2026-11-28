// A copied address names its conversation. A fresh visit resumes the most recently opened one.
export function windowLocation(key) {
  const url = new URL(location.href);
  let saved;
  try { saved = localStorage.getItem(key); } catch { /* Private browsing. */ }
  let current = url.searchParams.get('thread') || (url.searchParams.has('note') ? 'window' : saved) || 'window';

  function select(id, switching = true) {
    const next = new URL(location.href);
    next.searchParams.set('thread', id);
    if (switching) next.searchParams.delete('note');
    history.replaceState(history.state, '', next);
    current = id;
    try { localStorage.setItem(key, id); } catch { /* The URL still preserves the window. */ }
  }
  return { get id() { return current; }, select };
}

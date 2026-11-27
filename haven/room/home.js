import { dateKey, readNote } from './calendar-store.js';

(() => {
  const byId = id => document.getElementById(id);
  const weekday = new Intl.DateTimeFormat('en-GB', { weekday: 'long' });
  const dateLabel = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const monthLabel = new Intl.DateTimeFormat('en-GB', { month: 'long' });
  const sheetLabel = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
  const now = new Date();
  let visibleMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  let clockDay = '';

  function refreshClock() {
    const date = new Date();
    const key = dateKey(date);
    byId('local-time').textContent = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    byId('local-time').dateTime = date.toISOString();
    if (clockDay === key) return;
    clockDay = key;
    byId('weekday').textContent = weekday.format(date);
    byId('full-date').textContent = dateLabel.format(date);
    // Compare civil dates, so the counter is independent of local DST transitions.
    const day = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
    const count = Math.max(0, Math.round((day - Date.UTC(2026, 4, 5)) / 86400000) + 1);
    byId('together').textContent = count;
    byId('together').setAttribute('aria-label', '相伴第 ' + count + ' 天');
    paintMonth();
  }

  function paintMonth() {
    const month = visibleMonth.getMonth();
    const year = visibleMonth.getFullYear();
    const last = new Date(year, month + 1, 0).getDate();
    const yearText = document.createElement('small');
    yearText.textContent = year;
    byId('month-label').replaceChildren(monthLabel.format(visibleMonth) + ' ', yearText);
    const days = document.createDocumentFragment();
    for (let day = 1; day <= last; day++) {
      const date = new Date(year, month, day);
      const note = readNote(date);
      const btn = document.createElement('a');
      btn.href = '/diary/?date=' + dateKey(date);
      btn.textContent = day;
      btn.setAttribute('aria-label', sheetLabel.format(date) + '，打开当日日记');
      if (dateKey(date) === clockDay) btn.setAttribute('aria-current', 'date');
      if (note.memo || note.adrianMemo || note.tasks.length) btn.dataset.note = '';
      if (day === 1) btn.style.gridColumnStart = String(date.getDay() + 1);
      days.append(btn);
    }
    byId('month-days').replaceChildren(days);
  }

  // An inert snapshot keeps the old dates on the lifting sheet as the new month appears.
  function snapshotMonth() {
    const paper = document.querySelector('.calendar-paper');
    const leaf = document.createElement('div');
    leaf.className = 'calendar-leaf';
    leaf.inert = true;
    leaf.setAttribute('aria-hidden', 'true');
    for (const selector of ['.month-heading', '.weekdays', '#month-days']) {
      const part = paper.querySelector(selector).cloneNode(true);
      if (selector === '#month-days') part.classList.add('leaf-days');
      part.removeAttribute('id');
      part.removeAttribute('aria-labelledby');
      for (const child of part.querySelectorAll('[id]')) child.removeAttribute('id');
      leaf.append(part);
    }
    paper.append(leaf);
    return leaf;
  }

  function turnLeaf(leaf, reverse, underlay) {
    const animation = leaf.animate([
      { transform: 'perspective(600px) rotateX(0deg)', opacity: 1 },
      { transform: 'perspective(600px) rotateX(44deg)', opacity: .97, offset: .55 },
      { transform: 'perspective(600px) rotateX(88deg)', opacity: .35 }
    ], { duration: 390, direction: reverse ? 'reverse' : 'normal', easing: 'ease-in-out' });
    animation.onfinish = () => {
      leaf.remove();
      underlay?.remove();
    };
  }

  function shiftMonth(offset) {
    const paper = document.querySelector('.calendar-paper');
    paper.querySelectorAll('.calendar-leaf').forEach(leaf => leaf.remove());
    const motion = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    const previous = motion ? snapshotMonth() : null;
    visibleMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + offset, 1);
    paintMonth();
    if (!previous) return;
    if (offset > 0) turnLeaf(previous, false);
    else turnLeaf(snapshotMonth(), true, previous);
  }

  byId('prev-month').addEventListener('click', () => shiftMonth(-1));
  byId('next-month').addEventListener('click', () => shiftMonth(1));
  window.addEventListener('pageshow', paintMonth);
  window.addEventListener('storage', paintMonth);
  refreshClock();
  setInterval(refreshClock, 10000);
})();

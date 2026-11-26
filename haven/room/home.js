(() => {
  const byId = id => document.getElementById(id);
  const weekday = new Intl.DateTimeFormat('en-GB', { weekday: 'long' });
  const dateLabel = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const monthLabel = new Intl.DateTimeFormat('en-GB', { month: 'long' });
  const sheetLabel = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
  const todayKey = date => [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
  const storeKey = date => 'haven.room.calendar.v1.' + todayKey(date);
  const daySheet = byId('day-sheet');
  const now = new Date();
  let visibleMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  let selectedDay = null;
  let tasks = [];
  let clockDay = '';

  function readNote(date) {
    try {
      const data = JSON.parse(localStorage.getItem(storeKey(date)));
      return {
        memo: typeof data?.memo === 'string' ? data.memo : '',
        tasks: Array.isArray(data?.tasks)
          ? data.tasks.filter(task => task && typeof task.text === 'string')
          : [],
      };
    } catch {
      return { memo: '', tasks: [] };
    }
  }

  function refreshClock() {
    const date = new Date();
    const key = todayKey(date);
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
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = day;
      btn.setAttribute('aria-label', sheetLabel.format(date) + '，打开便签与待办');
      if (todayKey(date) === clockDay) btn.setAttribute('aria-current', 'date');
      if (note.memo || note.tasks.length) btn.dataset.note = '';
      if (day === 1) btn.style.gridColumnStart = String(date.getDay() + 1);
      btn.addEventListener('click', () => openDay(date));
      days.append(btn);
    }
    byId('month-days').replaceChildren(days);
  }

  function turnCorner(back) {
    const paper = document.querySelector('.calendar-paper');
    paper.querySelector('.page-corner')?.remove();
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const corner = document.createElement('span');
    corner.className = back ? 'page-corner back' : 'page-corner';
    corner.setAttribute('aria-hidden', 'true');
    paper.append(corner);
    const turn = corner.animate([
      { transform: 'scale(.12)', opacity: 0 },
      { transform: 'scale(1)', opacity: .96, offset: .42 },
      { transform: 'scale(.15)', opacity: 0 }
    ], { duration: 320, easing: 'ease-in-out' });
    turn.onfinish = () => corner.remove();
  }

  function shiftMonth(offset) {
    turnCorner(offset < 0);
    visibleMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + offset, 1);
    paintMonth();
  }

  function paintTasks() {
    const list = document.createDocumentFragment();
    tasks.forEach((task, index) => {
      const li = document.createElement('li');
      const label = document.createElement('label');
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = Boolean(task.done);
      check.addEventListener('change', () => { task.done = check.checked; });
      const text = document.createElement('span');
      text.textContent = task.text;
      label.append(check, text);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.setAttribute('aria-label', '移除待办：' + task.text);
      remove.textContent = '×';
      remove.addEventListener('click', () => {
        tasks.splice(index, 1);
        paintTasks();
      });
      li.append(label, remove);
      list.append(li);
    });
    byId('day-tasks').replaceChildren(list);
  }

  function openDay(date) {
    selectedDay = date;
    const note = readNote(date);
    tasks = note.tasks;
    byId('sheet-heading').textContent = sheetLabel.format(date);
    byId('day-memo').value = note.memo;
    byId('new-task').value = '';
    byId('day-feedback').textContent = '';
    paintTasks();
    daySheet.showModal();
    byId('close-sheet').focus();
  }

  function addTask() {
    const field = byId('new-task');
    const text = field.value.trim();
    if (!text) return;
    tasks.push({ text, done: false });
    field.value = '';
    paintTasks();
  }

  byId('day-form').addEventListener('submit', event => {
    event.preventDefault();
    addTask();
    const memo = byId('day-memo').value.trim();
    try {
      const key = storeKey(selectedDay);
      if (memo || tasks.length) localStorage.setItem(key, JSON.stringify({ memo, tasks }));
      else localStorage.removeItem(key);
    } catch {
      byId('day-feedback').textContent = '浏览器未能保存，请保留这张便签并稍后重试。';
      return;
    }
    daySheet.close();
    paintMonth();
    byId('month-days').querySelectorAll('button')[selectedDay.getDate() - 1]?.focus({ preventScroll: true });
  });
  byId('add-task').addEventListener('click', addTask);
  byId('new-task').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      addTask();
    }
  });
  byId('close-sheet').addEventListener('click', () => daySheet.close());
  byId('prev-month').addEventListener('click', () => shiftMonth(-1));
  byId('next-month').addEventListener('click', () => shiftMonth(1));
  refreshClock();
  setInterval(refreshClock, 10000);
})();

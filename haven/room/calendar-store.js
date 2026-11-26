const prefix = 'haven.room.calendar.v1.';

export function dateKey(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

export function readNote(date) {
  try {
    const data = JSON.parse(localStorage.getItem(prefix + dateKey(date)));
    return {
      memo: typeof data?.memo === 'string' ? data.memo : '',
      tasks: Array.isArray(data?.tasks) ? data.tasks.filter(task => typeof task?.text === 'string') : []
    };
  } catch {
    return { memo: '', tasks: [] };
  }
}

export function writeNote(date, entry) {
  const key = prefix + dateKey(date);
  if (entry.memo || entry.tasks.length) localStorage.setItem(key, JSON.stringify(entry));
  else localStorage.removeItem(key);
}

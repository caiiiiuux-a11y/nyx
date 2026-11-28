export const mealLabels = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐' };
export const periodLabels = { start: '开始了', ongoing: '经期中', end: '结束了' };

export function validDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/.test(value)) return false;
  const day = new Date(value + 'T12:00:00Z');
  return Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === value;
}

export function dayMarks(fields) {
  return { meals: Object.keys(mealLabels).some(field => Boolean(fields[field])), period: Boolean(fields.period) };
}

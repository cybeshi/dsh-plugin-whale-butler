// 日期小工具：一律按 UTC 算，避免时区把日期差一天。

export function addDays(date, days) {
  const [year, month, day] = String(date).split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1, day + days));
  return value.toISOString().slice(0, 10);
}

export function addMonths(date, months) {
  const [year, month, day] = String(date).split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1 + months, day));
  return value.toISOString().slice(0, 10);
}

export function daysBetween(from, to) {
  const [y1, m1, d1] = String(from).split('-').map(Number);
  const [y2, m2, d2] = String(to).split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}

/** 整月数：不到一个整月不算。 */
export function fullMonthsBetween(from, to) {
  const [y1, m1, d1] = String(from).split('-').map(Number);
  const [y2, m2, d2] = String(to).split('-').map(Number);
  let months = (y2 - y1) * 12 + (m2 - m1);
  if (d2 < d1) months -= 1;
  return Math.max(0, months);
}

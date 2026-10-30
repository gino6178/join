// Dates and times as the platform passes them around: dates are "YYYY-MM-DD" in the town's local calendar, times are
// "HH:MM", and arithmetic is done in minutes since midnight.
export const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad = (n) => String(n).padStart(2, "0");
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const hm = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
export const toMin = (s) => { const [h, m] = String(s).split(":").map(Number); return h * 60 + (m || 0); };
export const dateOf = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
export const addDays = (s, n) => { const d = dateOf(s); d.setDate(d.getDate() + n); return ymd(d); };
export const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && ymd(dateOf(s)) === s;
export const isTime = (s) => typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
// when a booking starts, as a Date (local time)
export const startOf = (date, start) => { const d = dateOf(date); d.setMinutes(toMin(start)); return d; };

// A player's usual free times, written "Thu 18-22": the windows, as minutes on a weekday
export const windows = (list) => (list || []).map((w) => {
  const m = String(w).match(/^(\w{3})\s+(\d{1,2})-(\d{1,2})$/);
  return m ? { day: DAYS.indexOf(m[1]), from: +m[2] * 60, to: +m[3] * 60 } : null;
}).filter((w) => w && w.day >= 0);
export const freeAt = (wins, date, start, minutes) => wins.some((w) => w.day === date.getDay() && w.from <= start && start + minutes <= w.to);

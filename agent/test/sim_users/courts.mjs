// The sample venues' court timetable, as agent/src/play.js demoVenues answers it (the same hash, the same busy
// rates), for the counterfactual baseline: without Serve, a person searching for a court finds the same courts free as
// Serve's agents would, less the ones booked in the baseline's own world. sim_users_unit.mjs checks it against play.js.
const toMin = (s) => { const [h, m] = String(s).split(":").map(Number); return h * 60 + (m || 0); };
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const hash = (s) => {
  let h = 2166136261;
  for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
};
const hours = (v, date) => ([0, 6].includes(date.getDay()) && v.weekendOpen) || v.open;
const forSport = (v, sport) => (v.sports ? (v.sports[sport] ? { ...v, courts: v.sports[sport].courts, price: v.sports[sport].price } : null) : sport === "badminton" ? v : null);
// free courts at a venue for a date ("YYYY-MM-DD"), a start in minutes and a length; booked: [{ venue, date, start, minutes, court }]
export function freeCourts(v0, dateStr, start, minutes, { sport = "badminton", booked = [] } = {}) {
  const v = forSport(v0, sport);
  if (!v) return [];
  const [y, m, d] = dateStr.split("-").map(Number), date = new Date(y, m - 1, d);
  const [o, c] = hours(v, date).map(toMin);
  if (start < o || start + minutes > c) return [];
  const peak = (start >= 18 * 60 && start < 21 * 60) || [0, 6].includes(date.getDay());
  const busy = (peak ? v.peakBusy : v.offBusy) * 0.6, out = [];
  const taken = new Set(booked.filter((b) => b.venue === v.id && b.date === dateStr && toMin(b.start) < start + minutes && start < toMin(b.start) + (b.minutes || 90)).map((b) => b.court));
  for (let k = 1; k <= v.courts; k++) {
    let free = !taken.has(k);
    for (let t = Math.floor(start / 60) * 60; t < start + minutes; t += 60) if (hash(`${v.id}|${ymd(date)}|${t}|${k}`) < busy) { free = false; break; }
    if (free) out.push(k);
  }
  return out;
}
export const travelMin = (a, b) => Math.round(5 + 3 * Math.hypot(a.x - b.x, a.y - b.y) * 1.25);

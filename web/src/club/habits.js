// What the Autopilot learns from your games, computed the same way as on the gateway (agent/src/autopilot.js), so the
// app can show it before a run: the times you keep playing at, and who you play best with (games that run past the
// booking).
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const dateOf = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };

export function habits(history = []) {
  if (!history.length) return [];
  const last = history.map((h) => h.date).sort().at(-1), since = dateOf(last); since.setDate(since.getDate() - 55);
  const g = {};
  for (const h of history.filter((x) => dateOf(x.date) >= since)) {
    const day = DAYS[dateOf(h.date).getDay()], k = `${day} ${h.start}`;
    (g[k] ||= { day, start: h.start, count: 0, played: [], sports: {} }).count++;
    g[k].played.push(h.played || h.booked || 90);
    g[k].sports[h.sport || "badminton"] = (g[k].sports[h.sport || "badminton"] || 0) + 1;
  }
  return Object.values(g).map((x) => ({ day: x.day, start: x.start, count: x.count, weeks: 8, minutes: Math.round(x.played.reduce((a, b) => a + b, 0) / x.played.length), sport: Object.entries(x.sports).sort((a, b) => b[1] - a[1])[0][0] }))
    .sort((a, b) => b.count - a.count);
}
export function chemistry(history = []) {
  const per = {};
  for (const h of history) for (const id of h.with || []) {
    const x = (per[id] ||= { n: 0, ext: [] }); x.n++;
    if (h.booked && h.played) x.ext.push(h.played / h.booked - 1);
  }
  return Object.entries(per).map(([id, x]) => {
    const ext = x.ext.length ? x.ext.reduce((a, b) => a + b, 0) / x.ext.length : 0;
    return { id, n: x.n, ext: Math.round(ext * 100), score: Math.min(1, x.n / 4) * 0.5 + Math.max(0, ext) * 3 };
  }).sort((a, b) => b.score - a.score);
}

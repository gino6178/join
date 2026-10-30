// Your week in games, for the Goals tab and the agent home: what you played and what is booked this week against your
// goal, the weeks in a row you played, and the club's challenge. It is counted from the club (club.json: your past
// games, the members' games) and from this browser (the games your agent booked, the results you reported); nothing
// here is measured from a video.
const DAY = 864e5;
const pad = (n) => String(n).padStart(2, "0");
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dateOf = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
export const monday = (d) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
const weekOf = (date, now) => Math.round((monday(now) - monday(dateOf(date))) / (7 * DAY)); // 0 this week, 1 last week

// your past games. The demo club's are dated in the weeks it was written in; on the demo they move by whole weeks, so
// the latest one falls in last week and they stay "your last eight weeks" (on the same weekdays).
export function pastGames(club, now = new Date()) {
  const h = club?.you?.history || [];
  if (!club?.demo || !h.length) return h;
  const shift = weekOf(h.map((x) => x.date).sort().at(-1), now) - 1;
  if (shift <= 0) return h;
  return h.map((x) => { const d = dateOf(x.date); d.setDate(d.getDate() + 7 * shift); return { ...x, date: ymd(d) }; });
}

// every game you played: the club's record of yours, and the results you reported here
export function played(club, results = [], now = new Date()) {
  const mine = results.filter((r) => r.at).map((r) => ({ date: ymd(new Date(r.at)), with: [...(r.vs || []), ...(r.partner ? [r.partner] : [])], sport: r.sport || "badminton", played: r.played || null, reported: true }));
  return [...pastGames(club, now), ...mine].sort((a, b) => a.date.localeCompare(b.date));
}

// the games your agent booked that are still to come this week (from the jobs: tasks.js)
export function bookedThisWeek(tasks, now = new Date()) {
  const seen = new Set();
  return tasks.filter((t) => t.booking && !["cancelled", "short"].includes(t.booking.state) && t.booking.option?.date)
    .map((t) => ({ ...t.booking.option, state: t.booking.state, id: t.booking.id, href: t.href }))
    .filter((o) => weekOf(o.date, now) === 0 && new Date(`${o.date}T${o.start || "23:59"}`) >= now && !seen.has(o.id) && seen.add(o.id))
    .sort((a, b) => `${a.date} ${a.start}`.localeCompare(`${b.date} ${b.start}`));
}

// this week against the goal, the last eight weeks, and the streak: weeks in a row with at least one game, counted back
// from last week (this week counts once it has a game)
export function week(club, { results = [], tasks = [], goal = 2, now = new Date() } = {}) {
  // a confirmed game whose time has passed counts as played, until you report its result
  const reported = new Set(results.map((r) => r.id));
  const over = tasks.filter((t) => t.booking?.state === "confirmed" && t.booking.option?.date && !reported.has(t.booking.id) && new Date(`${t.booking.option.date}T${t.booking.option.start || "00:00"}`) < now)
    .map((t) => ({ date: t.booking.option.date, with: (t.booking.invites || []).filter((i) => i.status === "in").map((i) => i.id), sport: t.booking.option.sport || "badminton" }));
  const games = [...played(club, results, now), ...over];
  const per = Array.from({ length: 9 }, (_, k) => { const start = monday(now); start.setDate(start.getDate() - 7 * (8 - k)); return { start, n: 0 }; });
  for (const g of games) { const w = weekOf(g.date, now); if (w >= 0 && w <= 8) per[8 - w].n++; }
  const booked = bookedThisWeek(tasks, now), now0 = per[8].n;
  let streak = now0 > 0 ? 1 : 0;
  for (let k = 7; k >= 0 && per[k].n > 0; k--) streak++;
  const met = per.slice(0, 8).filter((w) => w.n >= goal).length;
  const partners = {};
  for (const g of games.filter((x) => weekOf(x.date, now) <= 8)) for (const id of g.with || []) partners[id] = (partners[id] || 0) + 1;
  return { goal, played: now0, booked, left: Math.max(0, goal - now0 - booked.length), weeks: per, streak, met, games, partners };
}

// the club challenge: every member's games in its two weeks, yours included (this week and last)
export function challenge(club, w) {
  const c = club?.challenge;
  if (!c) return null;
  const yours = w.weeks.slice(-2).reduce((a, x) => a + x.n, 0);
  const rows = [{ id: "you", name: "You", games: yours }, ...club.members.map((m) => ({ id: m.id, name: m.name, games: m.games || 0 }))].sort((a, b) => b.games - a.games);
  const total = rows.reduce((a, r) => a + r.games, 0);
  return { ...c, total, yours, rows, done: total >= c.target };
}

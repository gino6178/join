// What a member's agent can observe about its own member, to predict a yes (docs/agent_matchmaking_plan.md, 4.2).
// Computed on the member's side only, from the member's own records (records.js) and the request's facts. Nothing
// here comes from the asker's claims except the times: the trip is the member's own, the history with the asker is
// the member's own.
//   rec: { asked: [{ t, from, date, start, yes }], own: [{ t, yes }], games: [{ t, date, start, with: [ids], over }], sore: [{ from, to }] }
//   q:   { from, date, start, minutes, format, now, gap (rating points), trip (minutes), prefersDoubles, sore (optional) }
export const MU0 = 0.25; // the prior the smoothed rates shrink towards (about the club's rate in the simulated logs)
export const FEATURES = [
  "yes rate, asks in the last 28 days", "asks in the last 28 days (log)", "yes rate at this weekday and hour", "asks at this weekday and hour (log)",
  "yes rate to this asker", "asks from this asker (log)", "games with this asker (log)", "minutes past the booking with this asker",
  "games in the last 7 days", "games already booked that week", "games a week, last 8 weeks", "booked that week minus usual",
  "a game the day before or after", "habit: share of the last 8 weeks played then", "said no in the last 72 hours", "yes rate to its own Match helper and plans, 28 days",
  "sore, in the body log", "sore and singles", "level gap (100 rating points)", "own trip (10 min)", "notice (log hours)", "prefers doubles", "weekend", "asks in the last 7 days (log)",
  // the asker's reliability, as this member's agent has seen it itself (never another member's record of the asker):
  // of this member's yeses to this asker, the share that became a game, and how often the asker dropped the game or
  // cancelled it after the yes
  "this asker's yeses that became games", "this asker dropped or cancelled after a yes (log)",
];
// the features the first model (likely-lr-20261028) was trained on: the 24 above the asker's reliability
export const V1 = FEATURES.slice(0, 24);
const DAY = 864e5;
// a date's day number and weekday, without time zones getting in the way
export const dayNum = (date) => { const [y, m, d] = String(date).split("-").map(Number); return Math.round(Date.UTC(y, m - 1, d) / DAY); };
export const dowOf = (date) => (dayNum(date) + 4) % 7; // 0 = Sunday, as Date.getDay
const weekOf = (date) => Math.floor((dayNum(date) + 3) / 7); // weeks start on Monday
const toMin = (s) => { const [h, m] = String(s).split(":").map(Number); return h * 60 + (m || 0); };
// when a game starts, in ms (local time, as everything else in Serve)
export const atOf = (date, start) => { const [y, m, d] = String(date).split("-").map(Number), mm = toMin(start); return new Date(y, m - 1, d, Math.floor(mm / 60), mm % 60).getTime(); };
const at = (g) => (g._at ??= atOf(g.date, g.start));
const key = (date, start) => `${dowOf(date)}|${start}`;

export function features(rec = {}, q) {
  const now = q.now ?? Date.now(), asked = rec.asked || [], own = rec.own || [], games = rec.games || [], dh = key(q.date, q.start);
  let y28 = 0, n28 = 0, ys = 0, ns = 0, yp = 0, np = 0, n7 = 0, lastNo = -Infinity, dropped = 0;
  for (const e of asked) {
    if (e.t > now) continue;
    if (now - e.t <= 28 * DAY) { n28++; y28 += e.yes ? 1 : 0; }
    if (now - e.t <= 7 * DAY) n7++;
    if ((e._k ??= key(e.date, e.start)) === dh) { ns++; ys += e.yes ? 1 : 0; }
    if (e.from === q.from) { np++; yp += e.yes ? 1 : 0; if (e.yes && e.dropped && (e.droppedAt ?? e.t) <= now) dropped++; }
    if (!e.yes && e.t > lastNo) lastNo = e.t;
  }
  let oy = 0, on = 0;
  for (const e of own) { if (e.t > now) continue; if (now - e.t <= 28 * DAY) { on++; oy += e.yes ? 1 : 0; } if (!e.yes && e.t > lastNo) lastNo = e.t; }
  const wk = weekOf(q.date), day = dayNum(q.date);
  let gw = 0, over = 0, g7 = 0, g8 = 0, habit = 0, bookedWk = 0, b2b = 0, cancelled = 0;
  for (const g of games) {
    if (g.t > now) continue; // not booked yet at that time
    // a game the asker cancelled counts against the asker, and is no game for the member
    if (g.cancelled) { if ((g.cancelledAt ?? g.t) <= now && (g.with || []).includes(q.from)) cancelled++; continue; }
    const d = (g._d ??= dayNum(g.date));
    if (Math.floor((d + 3) / 7) === wk) bookedWk++;
    if (d === day - 1 || d === day + 1) b2b = 1;
    const when = at(g);
    if (when > now) continue; // booked, not played yet
    if ((g.with || []).includes(q.from)) { gw++; over += g.over || 0; }
    if (now - when <= 7 * DAY) g7++;
    if (now - when <= 56 * DAY) { g8++; if ((g._k ??= key(g.date, g.start)) === dh) habit++; }
  }
  const covers = (s, date) => s.from <= date && date <= s.to, today = new Date(now), td = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  // a sore spell counts once it is in the body log (logged by today), for the game's day or today
  const sore = q.sore != null ? (q.sore ? 1 : 0) : (rec.sore || []).some((s) => s.from <= td && (covers(s, q.date) || covers(s, td))) ? 1 : 0;
  const dow = dowOf(q.date);
  return [(y28 + 2 * MU0) / (n28 + 2), Math.log1p(n28), (ys + 2 * MU0) / (ns + 2), Math.log1p(ns), (yp + MU0) / (np + 1), Math.log1p(np),
    Math.log1p(gw), gw ? over / gw / 30 : 0, g7, bookedWk, g8 / 8, bookedWk - g8 / 8, b2b, habit / 8, now - lastNo <= 72 * 36e5 ? 1 : 0, (oy + 2 * MU0) / (on + 2),
    sore, sore && q.format === "singles" ? 1 : 0, Math.abs(q.gap || 0) / 100, (q.trip ?? 15) / 10, Math.log1p(Math.max(0, (atOf(q.date, q.start) - now) / 36e5)), q.prefersDoubles ? 1 : 0, dow === 0 || dow === 6 ? 1 : 0, Math.log1p(n7),
    // (yeses to this asker that the asker followed through, smoothed towards 0.9; a new asker is neither good nor bad)
    Math.max(0, yp - dropped - cancelled + 2 * 0.9) / (yp + 2), Math.log1p(dropped + cancelled)];
}

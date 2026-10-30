// The club's competitive side: a club rating (Elo), challenges and random matches. Pure functions over the demo club
// (web/public/data/club.json) and your own results, which live with the club game in this browser.
//   rating: every member starts from the club's table; your reported results move you and your opponents
//   random match: a fair opponent (or a balanced doubles four) picked at random from the members free when you are
const K = 32;
export const expect = (a, b) => 1 / (1 + 10 ** ((b - a) / 400));
// what a result does to your rating: +win / −loss against an opponent (or a pair's average)
export const stakes = (me, them) => ({ win: Math.round(K * (1 - expect(me, them))), loss: Math.round(K * expect(me, them)) });
export const chance = (me, them) => Math.round(100 * expect(me, them));

// ratings now: the club table plus every result you reported
export function ratings(club, results = []) {
  const r = Object.fromEntries(club.members.map((m) => [m.id, m.rating]));
  r.you = club.you.rating;
  for (const x of [...results].sort((a, b) => a.at - b.at)) {
    const mine = (r.you + (x.partner ? r[x.partner] ?? r.you : r.you)) / 2;
    const theirs = x.vs.reduce((s, id) => s + (r[id] ?? 1500), 0) / x.vs.length;
    const d = Math.round(K * ((x.won ? 1 : 0) - expect(mine, theirs)));
    r.you += d;
    if (x.partner && r[x.partner] != null) r[x.partner] += d;
    x.vs.forEach((id) => { if (r[id] != null) r[id] -= d; });
  }
  return r;
}
// wins and losses: the club's record plus yours; your opponents' records change with your results
export function records(club, results = []) {
  const w = Object.fromEntries(club.members.map((m) => [m.id, { w: m.w, l: m.l, form: [...m.form] }]));
  w.you = { w: club.you.w, l: club.you.l, form: [...club.you.form] };
  const add = (id, won) => { const x = w[id]; if (!x) return; won ? x.w++ : x.l++; x.form = [...x.form, won ? "W" : "L"].slice(-5); };
  for (const x of [...results].sort((a, b) => a.at - b.at)) { add("you", x.won); if (x.partner) add(x.partner, x.won); x.vs.forEach((id) => add(id, !x.won)); }
  return w;
}

// free times like "Thu 19-22": the overlap of two lists, as the first shared hour-and-a-half
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const slot = (s) => { const [d, h] = s.split(" "), [a, b] = h.split("-").map(Number); return { d, a, b }; };
export function shared(...lists) {
  const out = [];
  for (const s of lists[0].map(slot)) {
    let a = s.a, b = s.b;
    for (const l of lists.slice(1)) {
      const o = l.map(slot).find((x) => x.d === s.d && Math.min(b, x.b) - Math.max(a, x.a) >= 1.5);
      if (!o) { a = b; break; }
      a = Math.max(a, o.a); b = Math.min(b, o.b);
    }
    if (b - a >= 1.5) out.push({ d: s.d, start: `${String(a).padStart(2, "0")}:00`, end: b });
  }
  return out.sort((x, y) => DAYS.indexOf(x.d) - DAYS.indexOf(y.d));
}
export const WHEN = {
  week: { label: "This week", days: DAYS },
  weekend: { label: "This weekend", days: ["Sat", "Sun"] },
  weekday: { label: "A weekday evening", days: ["Mon", "Tue", "Wed", "Thu", "Fri"] },
};

// a random match, fair by rating: candidates are free when you are (in the window) and play the format; the closer
// their rating, the likelier they are drawn. Doubles draws a partner and two opponents so the two sides are even.
export function randomMatch({ club, you, r, format = "singles", when = "week", close = true }, rand = Math.random) {
  const days = WHEN[when].days, plays = (m) => m.prefers === "any" || m.prefers === format;
  const free = (m, d) => shared(you.free, m.free).filter((s) => days.includes(s.d) && (!d || s.d === d.d));
  const near = (m) => !close || Math.abs(r[m.id] - r.you) <= 150;
  const pick = (items, weight) => {
    const ws = items.map(weight), sum = ws.reduce((a, b) => a + b, 0);
    let x = rand() * sum;
    for (let i = 0; i < items.length; i++) if ((x -= ws[i]) <= 0) return items[i];
    return items.at(-1);
  };
  if (format === "singles") {
    const pool = club.members.filter((m) => plays(m) && near(m) && free(m).length);
    if (!pool.length) return { pool: 0 };
    const m = pick(pool, (x) => Math.exp(-Math.abs(r[x.id] - r.you) / 90));
    return { format, pool: pool.length, vs: [m], slot: free(m)[0], chance: chance(r.you, r[m.id]), stakes: stakes(r.you, r[m.id]) };
  }
  // doubles: one shared time for all four, then the most even split of three members drawn from those free then
  const times = shared(you.free, ...[]).filter((s) => days.includes(s.d));
  const options = [];
  for (const t of times) {
    const pool = club.members.filter((m) => plays(m) && near(m) && free(m, t).length);
    if (pool.length < 3) continue;
    for (let n = 0; n < 60; n++) {
      const [p, a, b] = [...pool].sort(() => rand() - .5);
      const s = shared(you.free, p.free, a.free, b.free).find((x) => x.d === t.d);
      if (!s) continue;
      const gap = Math.abs((r.you + r[p.id]) - (r[a.id] + r[b.id]));
      options.push({ t: s, p, vs: [a, b], gap, pool: pool.length });
    }
  }
  if (!options.length) return { pool: 0 };
  options.sort((x, y) => x.gap - y.gap);
  const o = options[Math.floor(rand() * Math.min(3, options.length))];
  const mine = (r.you + r[o.p.id]) / 2, theirs = (r[o.vs[0].id] + r[o.vs[1].id]) / 2;
  return { format, pool: o.pool, partner: o.p, vs: o.vs, slot: o.t, chance: chance(mine, theirs), stakes: stakes(mine, theirs), gap: Math.round(o.gap) };
}
// how the agent is asked to book it (Play reads this like anything the player types)
export function askFor(m) {
  const day = { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday" }[m.slot.d];
  const part = +m.slot.start.slice(0, 2) < 12 ? "morning" : +m.slot.start.slice(0, 2) < 17 ? "afternoon" : "evening";
  const first = (x) => x.name.split(" ")[0];
  return m.format === "singles"
    ? `Challenge ${first(m.vs[0])} to a singles match on ${day} ${part}`
    : `Doubles on ${day} ${part}: me and ${first(m.partner)} against ${first(m.vs[0])} and ${first(m.vs[1])}`;
}

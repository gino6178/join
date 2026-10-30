// A labeled set of decisions for the member agents (a2a.js), made from simulated club members whose constraints are
// known, so every case has one right answer (the way τ-bench grades agents against a simulated user's hidden goal).
// A member has free windows (shared with every agent), hard constraints written into their profile in plain words
// (a weekday evening that is out this month, no weekend start before a time, one format only) and a preference that
// decides between times (a favourite day, mornings or evenings). Each case is one proposal with up to three other
// times that fit everyone. The right answer follows a2a.js's rule: A if the proposed time works, else the listed time
// the member likes best, else Z. Cases where two times tie for best are left out, so the answer is never a matter of
// taste. Seeded, so the same seed gives the same set.
//   node test/sim/decisions.mjs [n=120] [seed=7] > test/sim/decisions.json
const N = +(process.argv[2] || 120), SEED = +(process.argv[3] || 7);
let s = SEED >>> 0;
const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const any = (xs) => xs[Math.floor(rnd() * xs.length)];
const shuffle = (xs) => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// a fixed week, Monday 2 November 2026, so the set does not depend on the day it is run
const WEEK = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day, i) => ({ day, date: `2026-11-${String(2 + i).padStart(2, "0")}` }));
const LONG = { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday" };
const MON = { "2026-11": "Nov" };
const NAMES = ["Arun", "Bea", "Carlos", "Dana", "Emeka", "Fatima", "Goran", "Hiro", "Ilse", "Jonas", "Kaveh", "Lina", "Mateo", "Nadia", "Oskar", "Pita", "Quinn", "Rosa", "Sven", "Tara", "Umar", "Vera", "Wen", "Ximena", "Yusuf", "Zoe", "Amara", "Bo", "Chidi", "Dev", "Elif", "Farid", "Greta", "Hamid", "Ines", "Joon", "Kalea", "Luca", "Mira", "Nils"];
const VENUES = ["Riverside Sports Centre", "Midtown Community Gym", "North Hall", "Lakeside Courts"];
const WINDOWS = [["Mon", 18, 22], ["Tue", 18, 22], ["Wed", 18, 22], ["Thu", 18, 22], ["Fri", 18, 22], ["Sat", 8, 14], ["Sun", 9, 14]];
const hm = (h, m = 0) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
const label = (day, start) => { const w = WEEK.find((x) => x.day === day); return `${day} ${+w.date.slice(8)} ${MON[w.date.slice(0, 7)]} ${start}`; };

// hard constraints and preferences, each with a few ways of saying it (first names only, never he or she)
const SAY = {
  out: [(n, d) => `${n} works late on ${LONG[d]}s this month, so ${LONG[d]} evenings are out.`, (n, d) => `${n} has an evening class on ${LONG[d]}s until December and can't play then.`, (n, d) => `${LONG[d]} doesn't work for ${n} at the moment.`],
  earliest: [(n, h) => `At weekends ${n} won't start before ${hm(h)}.`, (n, h) => `${n} needs a slow start at weekends: nothing before ${hm(h)} on Saturday or Sunday.`],
  only: [(n, f) => `${n} only plays ${f}.`, (n, f) => `${n} plays ${f} and nothing else.`],
  day: [(n, d) => `If the time has to move, ${n} likes ${LONG[d]}s best.`, (n, d) => `${LONG[d]} is ${n}'s favourite day to play.`],
  part: [(n, p) => `${n} prefers ${p}s.`, (n, p) => `Given a choice, ${n} picks a${p === "evening" ? "n" : ""} ${p} game.`],
  easy: [(n) => `${n} is easy-going about times.`, (n) => `${n} is happy to play whenever the free times allow.`],
};

function member(i) {
  const name = NAMES[i % NAMES.length];
  const wins = shuffle(WINDOWS).slice(0, 3 + Math.floor(rnd() * 2)).sort((a, b) => WEEK.findIndex((w) => w.day === a[0]) - WEEK.findIndex((w) => w.day === b[0]));
  const m = { name, level: any(["A", "B", "C"]), free: wins.map(([d, f, t]) => `${d} ${f}-${t}`), wins, out: null, earliest: null, only: null, day: null, part: null };
  const evenings = wins.filter(([d]) => !["Sat", "Sun"].includes(d)).map(([d]) => d), weekend = wins.some(([d]) => ["Sat", "Sun"].includes(d));
  if (evenings.length && rnd() < 0.8) m.out = any(evenings);
  if (weekend && rnd() < 0.5) m.earliest = any([10, 11]);
  if (rnd() < 0.25) m.only = any(["singles", "doubles"]);
  if (rnd() < 0.6) m.day = any(wins.map(([d]) => d)); else m.part = any(["morning", "evening"]);
  const lines = [m.out && any(SAY.out)(name, m.out), m.earliest && any(SAY.earliest)(name, m.earliest), m.only && any(SAY.only)(name, m.only), m.day && any(SAY.day)(name, m.day), m.part && any(SAY.part)(name, m.part)].filter(Boolean);
  m.prefers = m.only || "any";
  m.agent = (lines.length ? shuffle(lines) : [any(SAY.easy)(name)]).join(" ");
  return m;
}
// does a time work for the member (the hard constraints), and how much they like it (the preference)
const works = (m, t, format) => !(m.only && m.only !== format) && m.out !== t.day && !(m.earliest && ["Sat", "Sun"].includes(t.day) && t.h < m.earliest);
const liking = (m, t) => (m.day === t.day ? 2 : 0) + (m.part === "morning" && t.h < 12 ? 1 : 0) + (m.part === "evening" && t.h >= 17 ? 1 : 0);

function proposal(m, k) {
  const format = m.only && rnd() < 0.5 ? (m.only === "singles" ? "doubles" : "singles") : m.only || any(["singles", "doubles"]);
  // every start inside the member's free windows that leaves 90 minutes, as times that fit everyone
  const starts = m.wins.flatMap(([d, f, t]) => Array.from({ length: t - f - 1 }, (_, j) => ({ day: d, h: f + j }))).filter((x) => x.h + 1.5 <= m.wins.find(([d]) => d === x.day)[2]);
  const pickN = shuffle(starts).slice(0, 4);
  if (pickN.length < 2) return null;
  const venue = any(VENUES), court = 1 + Math.floor(rnd() * 5);
  const offer = (t) => ({ day: t.day, date: WEEK.find((w) => w.day === t.day).date, start: hm(t.h), end: hm(t.h + 1, 30), h: t.h, text: `${label(t.day, hm(t.h))}–${hm(t.h + 1, 30)} at ${venue}, court ${court}` });
  const [cur, ...alts] = pickN.map(offer);
  const ids = ["B", "C", "D"].slice(0, alts.length);
  let gold;
  if (works(m, cur, format)) gold = "A";
  else {
    const ok = alts.map((t, i) => ({ id: ids[i], t, v: liking(m, t) })).filter((x) => works(m, x.t, format)).sort((a, b) => b.v - a.v);
    if (!ok.length) gold = "Z";
    else if (ok.length > 1 && ok[0].v === ok[1].v) return null; // a tie: a matter of taste, left out
    else gold = ok[0].id;
  }
  return { id: `d${k}`, member: { id: `sim-${m.name.toLowerCase()}`, name: m.name, level: m.level, prefers: m.prefers, free: m.free, agent: m.agent }, sport: "badminton", format, cur, alts, gold,
    why: { works: works(m, cur, format), out: m.out, earliest: m.earliest, only: m.only, day: m.day, part: m.part } };
}

// stratified: each case first draws the kind of answer it should have (40% accept, 40% another time, 20% decline),
// then proposals are drawn for the member until one has it, so always saying yes would score 40%
const KIND = (gold) => (gold === "A" ? "accept" : gold === "Z" ? "decline" : "counter");
const out = [];
for (let i = 0, k = 0; out.length < N && i < NAMES.length * 4; i++) {
  const m = member(i);
  for (let c = 0; c < 3 && out.length < N; c++) {
    const want = ["accept", "counter", "counter", "accept", "decline"][(out.length) % 5];
    for (let t = 0; t < 60; t++) { const x = proposal(m, k++); if (x && KIND(x.gold) === want) { out.push(x); break; } }
  }
}
// balance check, to stderr
const tally = out.reduce((a, x) => ({ ...a, [KIND(x.gold)]: (a[KIND(x.gold)] || 0) + 1 }), {});
console.error(`${out.length} cases from ${new Set(out.map((x) => x.member.name)).size} members:`, JSON.stringify(tally));
console.log(JSON.stringify(out, null, 1));

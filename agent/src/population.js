// A simulated club: as many members as a test asks for (SIM_MEMBERS), each with an A2A agent of their own. Every one is
// marked simulated (and says so in its Agent Card); none is a real person. They are made by code from a seed, so the
// same seed gives the same club: names from two short lists, a level and a rating that goes with it, two to four times
// a week they are free (weekday evenings, weekend mornings or afternoons, in the proportions a club like this has), a
// home near one of the venues, the sports they play, singles or doubles, now and then a health limit, and one or two
// habits their agent keeps to (no Fridays, home by ten, nothing far from home, an early start). The habits are what
// makes them different to negotiate with: the members' agents decide by the same rule, from different people.
// Used to measure what changes as a club grows (test/scale_eval.mjs): the members your agent looks at are found by code
// (free then, plays that, ranked by fit and trip), so what the model reads stays the same size at 11 members or 1,000.

const FIRST = ["Mira", "Jonah", "Asha", "Teo", "Lina", "Omar", "Sora", "Nadia", "Felix", "Ivy", "Kai", "Rosa", "Bilal", "Elif", "Marco", "Yara", "Dev", "Ana", "Hugo", "Mei",
  "Tariq", "Nina", "Arjun", "Lea", "Pablo", "Zara", "Ken", "Ida", "Rami", "Oona", "Luca", "Sana", "Femi", "Alma", "Theo", "Rina", "Joel", "Maya", "Emre", "Lucia"];
const LAST = ["Okafor", "Lindqvist", "Haddad", "Moreau", "Tanaka", "Silva", "Novak", "Rahman", "Kowalski", "Ibarra", "Chen", "Mensah", "Ferreira", "Aziz", "Holm", "Petrov",
  "Nakamura", "Duarte", "Osei", "Varga", "Kaur", "Brennan", "Sato", "Quinn", "Abara", "Lund", "Rossi", "Yilmaz", "Dalton", "Mehta"];
const VENUES = [{ id: "riverside", x: 3.0, y: 4.9, area: "Riverside" }, { id: "north", x: 5.6, y: 1.5, area: "North" }, { id: "lakeside", x: 7.3, y: 5.7, area: "Lakeside" },
  { id: "midtown", x: 5.1, y: 3.9, area: "Midtown" }, { id: "westgate", x: 1.2, y: 2.4, area: "Westgate" }];
const ZONES = ["front forehand", "front backhand", "rear forehand", "rear backhand", "mid court"], SHOTS = ["smash", "drop", "net shot", "drive", "clear"];
const LIMITS = ["no jump landings", "limit smash volume", "60 minutes at most", "no back-to-back days"];
const OTHER = ["tennis", "pickleball", "table tennis", "basketball", "volleyball"];
// when a club's members are free: [day, from, to], weighted by how often a slot comes up
const SLOTS = [[["Mon", "Tue", "Wed", "Thu"], 18, 21, 5], [["Mon", "Tue", "Wed", "Thu"], 19, 22, 5], [["Fri"], 18, 22, 2], [["Sat", "Sun"], 8, 12, 3], [["Sat", "Sun"], 9, 13, 3], [["Sat", "Sun"], 14, 18, 2]];
// what a member's agent keeps to, besides the calendar (said to their own agent only). Some are hard rules, which the
// member's rules also carry so code can check them; the rest are preferences the model weighs
const HABITS = [
  [(n) => `${n} doesn't play on Fridays.`, { noDays: ["Fri"] }], [(n) => `${n} likes to be home by ten, so nothing that ends after 21:30.`, { endBy: "21:30" }],
  [(n) => `${n} won't travel more than 20 minutes for a game.`, { maxTrip: 20 }], [(n) => `${n} prefers the earliest start that works.`, null],
  [(n) => `${n} plays at their home venue when they can.`, null], [(n) => `${n} would rather play weekends than weeknights.`, null],
  [(n) => `${n} is happy with any time that fits the calendar.`, null], [(n) => `${n} avoids two games on consecutive days.`, null],
];

// a small seeded generator (mulberry32): the same seed, the same club
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const pickW = (r, xs) => { const tot = xs.reduce((a, x) => a + x[3], 0); let u = r() * tot; for (const x of xs) { u -= x[3]; if (u <= 0) return x; } return xs.at(-1); };
const gauss = (r) => Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r());
const nearest = (x, y) => VENUES.reduce((b, v) => (Math.hypot(v.x - x, v.y - y) < Math.hypot(b.x - x, b.y - y) ? v : b));

export function member(i, seed = 7) {
  const r = rng(seed * 100003 + i), first = FIRST[Math.floor(r() * FIRST.length)], last = LAST[Math.floor(r() * LAST.length)], name = `${first} ${last}`;
  const level = "ABCD"[Math.min(3, Math.floor(r() * 4.2))], base = { A: 1620, B: 1510, C: 1410, D: 1310 }[level], rating = Math.round(base + 55 * gauss(r));
  const home = VENUES[Math.floor(r() * VENUES.length)], x = +(home.x + 0.9 * gauss(r)).toFixed(1), y = +(home.y + 0.9 * gauss(r)).toFixed(1), near = nearest(x, y);
  const free = new Set();
  const taken = new Set(); // one window a day (two on one day could overlap and list the same time twice)
  for (let k = 0, n = 2 + Math.floor(r() * 3); free.size < n && k < 12; k++) { const [days, from, to] = pickW(r, SLOTS), day = days[Math.floor(r() * days.length)]; if (taken.has(day)) continue; taken.add(day); free.add(`${day} ${String(from).padStart(2, "0")}-${to}`); }
  const sports = ["badminton", ...OTHER.filter(() => r() < 0.18)].slice(0, 3);
  const prefers = r() < 0.45 ? "any" : r() < 0.6 ? "singles" : "doubles";
  const limit = r() < 0.14 ? LIMITS[Math.floor(r() * LIMITS.length)] : null;
  const picked = [...new Set([HABITS[Math.floor(r() * HABITS.length)], ...(r() < 0.4 ? [HABITS[Math.floor(r() * HABITS.length)]] : [])])];
  const habits = picked.map(([h]) => h(first)), rules = JSON.parse(JSON.stringify(Object.assign({}, ...picked.map(([, x]) => x || {}), limit === "60 minutes at most" ? { maxMinutes: 60 } : {})));
  const w = Math.floor(r() * 12), l = Math.floor(r() * 12), mix = Object.fromEntries(["Smash", "Drive", "Clear", "Drop", "Net shot", "Lift", "Block", "Push"].map((s) => [s, 4 + Math.floor(r() * 24)]));
  return {
    id: `s${String(i + 1).padStart(3, "0")}`, name, simulated: true, level, hand: r() < 0.88 ? "R" : "L", weak: ZONES[Math.floor(r() * ZONES.length)],
    strength: { shot: SHOTS[Math.floor(r() * SHOTS.length)], zone: ZONES[Math.floor(r() * ZONES.length)] }, limit, net: null, sessions: Math.floor(r() * 6),
    shares: { goals: true, progress: true, highlights: r() < 0.5, limits: !!limit }, xp: Math.floor(r() * 300), badges: [], free: [...free], prefers,
    venue: near.id, mix, area: { x, y, name: near.area }, rating, w, l, form: Array.from({ length: 5 }, () => (r() < 0.5 ? "W" : "L")), agent: `A simulated member. ${habits.join(" ")}`, rules, rulesComplete: true, sports,
  };
}
const cache = new Map();
export function population(n, seed = 7) {
  const k = `${n}:${seed}`;
  if (!cache.has(k)) {
    // names are unique in the club: a name already taken gets the next surname on the list
    const used = new Set();
    cache.set(k, Array.from({ length: n }, (_, i) => {
      const m = member(i, seed), [f, l] = m.name.split(" ");
      for (let j = LAST.indexOf(l), t = 0; used.has(m.name) && t < LAST.length * FIRST.length; t++) { j = (j + 1) % LAST.length; m.name = `${t >= LAST.length ? FIRST[(FIRST.indexOf(f) + Math.floor(t / LAST.length)) % FIRST.length] : f} ${LAST[j]}`; }
      const f2 = m.name.split(" ")[0]; if (f2 !== f) m.agent = m.agent.replaceAll(`${f} `, `${f2} `); // its agent's words name it as it is now
      used.add(m.name);
      return m;
    }));
  }
  return cache.get(k);
}

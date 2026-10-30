// Held-out weeks for the Autopilot eval (test/autopilot_eval.mjs, EVAL_WEEKS=heldout): weeks nobody tuned a prompt on.
// They are made by code from the simulated club (the demo club and 16 simulated members, population.js with
// SIM_SEED 2611, a seed no other test uses) and a fixed seed of their own, written once to heldout_weeks.json, and not
// looked at before the eval ran them. Regenerating them (--again) makes a different set, which then has to be run as
// a fresh held-out set and said so.
// Each week mixes what the eight tuned weeks mix, drawn at random: the goal (1 to 3 games), the sport (badminton,
// tennis or pickleball), a health limit (doubles first), a game already booked, games with simulated members the
// player has been playing with at a new usual time (one of them ran long), and something the player said before (leave
// someone out, among other notes). Its oracle is made by code from the same draw: the sport, doubles with the limit,
// never the person left out, the partner whose game ran long in at least one game. Every week is checked to be
// possible before it is kept: enough days with a usual or free time, partners who play that sport in that format and
// are free then (the person left out not counted), and a court.
//   node test/sim/heldout_weeks.mjs [--again]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)), OUT = path.join(HERE, "heldout_weeks.json");
const SEED = 20261028, CLUB = { simMembers: 16, simSeed: 2611 }, N = 10;
if (fs.existsSync(OUT) && !process.argv.includes("--again")) { console.log(`${path.basename(OUT)} is already written (held-out weeks are made once); --again makes a new set`); process.exit(0); }
process.env.SIM_MEMBERS = String(CLUB.simMembers); process.env.SIM_SEED = String(CLUB.simSeed);
const { readClub } = await import("../../src/club.js");
const { organize } = await import("../../src/body.js");
const club = readClub(), venues = JSON.parse(fs.readFileSync(path.join(HERE, "../../../web/public/data/venues.json"), "utf8"));
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const win = (list) => (list || []).map((w) => /^(\w{3})\s+(\d{1,2})-(\d{1,2})$/.exec(w)).filter(Boolean).map((m) => ({ day: m[1], from: +m[2] * 60, to: +m[3] * 60 }));
const toMin = (s) => +s.slice(0, 2) * 60 + +s.slice(3, 5), hm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const freeAt = (free, day, start, minutes = 90) => win(free).some((w) => w.day === day && w.from <= start && start + minutes <= w.to);
// the same small generator as population.js (mulberry32)
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const r = rng(SEED), pick = (xs) => xs[Math.floor(r() * xs.length)], first = (n) => n.split(" ")[0];
const plays = (m, sport) => (m.sports || ["badminton"]).includes(sport);
const fits = (m, sport, format) => plays(m, sport) && (sport !== "badminton" || m.prefers === "any" || m.prefers === format);
const hasCourt = (sport) => venues.venues.some((v) => v.sports?.[sport]);
// the player's usual times from a history (as autopilot.js habits: two or more of the last eight weeks)
function usual(history) {
  const g = {};
  for (const h of history) { const k = `${h.day} ${h.start}`; g[k] = (g[k] || 0) + 1; }
  return Object.entries(g).filter(([, n]) => n >= 2).map(([k]) => ({ day: k.slice(0, 3), start: k.slice(4) }));
}
const demoHist = club.you.history.map((h) => ({ day: DAYS[new Date(`${h.date}T12:00`).getDay()], start: h.start }));
const sims = club.members.filter((m) => m.simulated);
const FILLER = ["My new shoes grip much better on the wooden courts.", "I'm away for a work trip in the middle of next month.", "I'd like to get my footwork faster this season.",
  "The parking at North is a pain on weekday evenings.", "Saturday mornings are the best time for me.", "I sprained nothing, just a bit tired after the league.", "Sunday games before lunch suit me well."];
// is a week possible: the days with a time where enough partners are free (and a court for the sport), one game a day
function possible(w) {
  const format = w.you?.limit ? "doubles" : "singles", n = format === "doubles" ? 3 : 1, out = new Set(w.leftOut || []), booked = new Set((w.upcoming || []).map((u) => u.day));
  const times = [...usual([...demoHist, ...w.history]), ...win(club.you.free).map((x) => ({ day: x.day, start: hm(x.from) }))];
  const ok = new Map();
  for (const t of times) {
    if (booked.has(t.day) || ok.has(t.day) || !freeAt(club.you.free, t.day, toMin(t.start))) continue;
    const who = club.members.filter((m) => !out.has(m.id) && fits(m, w.goal.sport, format) && freeAt(m.free, t.day, toMin(t.start)) && !(m.rules?.endBy && toMin(t.start) + 90 > toMin(m.rules.endBy)) && !(m.rules?.maxMinutes && m.rules.maxMinutes < 90));
    if (who.length >= n) ok.set(t.day, who.map((m) => m.id));
  }
  const need = needOf(w);
  return need >= 1 && ok.size >= need + 1 && hasCourt(w.goal.sport) && (!w.withOneOf || [...ok.values()].some((ids) => ids.includes(w.withOneOf)));
}
// what each week mixes in, spread over the ten (so every kind of week is in the set): four with someone left out, three
// with a game already booked, three with a health limit; shuffled by the seed, the rest of each week drawn at random
const shuffle = (xs) => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const plan = (k) => shuffle(Array.from({ length: N }, (_, i) => i < k));
const AWAY = plan(4), BOOKED = plan(3), LIMIT = plan(3);
// the games a week needs, as code works it out (autopilot.js, body.js): the goal, one fewer in a week over 1.5 times the
// player's usual load, less the games already booked. (The first draw left this out, so a week could need no game and
// still have a partner in its oracle; fixed before the eval ran, with the prompts unchanged.)
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const back = (day, weeksAgo) => { const d = new Date(); do d.setDate(d.getDate() - 1); while (DAYS[d.getDay()] !== day); d.setDate(d.getDate() - 7 * (weeksAgo - 1)); return ymd(d); };
const needOf = (w) => Math.max(1, w.goal.perWeek + organize({ games: [...club.you.history, ...w.history.map(({ weeksAgo, day, ...h }) => ({ date: back(day, weeksAgo), ...h }))], now: new Date() }).plan.perWeekDelta) - (w.upcoming || []).length;
const weeks = [];
for (let tries = 0; weeks.length < N && tries < 500; tries++) {
  const i = weeks.length;
  const sport = LIMIT[i] || r() < 0.5 ? "badminton" : r() < 0.5 ? "tennis" : "pickleball";
  const perWeek = r() < 0.3 ? 1 : r() < 0.72 ? 2 : 3;
  const limit = LIMIT[i] ? "no jump landings" : null, format = limit ? "doubles" : "singles";
  // a new usual time with simulated members: two games in the last weeks at a time the player is free
  const slots = win(club.you.free).flatMap((x) => [x.from, x.from + 60].filter((s) => s + 90 <= x.to).map((s) => ({ day: x.day, start: hm(s) })));
  const slot = pick(slots), mates = sims.filter((m) => fits(m, sport, format) && freeAt(m.free, slot.day, toMin(slot.start)));
  if (mates.length < (format === "doubles" ? 3 : 1)) continue;
  const four = shuffle(mates).slice(0, format === "doubles" ? 3 : 1), mate = four[0], long = r() < 0.5;
  const history = [2, 4].map((weeksAgo, k) => ({ weeksAgo, day: slot.day, start: slot.start, sport, format, with: four.map((m) => m.id), booked: 90, played: long && k === 0 ? 125 : 90 }));
  const upcoming = BOOKED[i] ? [pick([{ day: "Thu", start: "19:00" }, { day: "Sat", start: "09:00" }, { day: "Mon", start: "19:30" }])].map((u) => ({ ...u, with: [pick(club.members.filter((m) => !m.simulated)).id] })) : [];
  // something said before: leave out the partner the history makes likeliest (the simulated mate, or a demo regular)
  const away = AWAY[i] ? (r() < 0.5 ? mate : club.members.find((m) => m.id === pick(["leo", "tomas", "kenji"]))) : null;
  const notes = [...Array.from({ length: 2 + Math.floor(r() * 3) }, () => pick(FILLER)), ...(away ? [`Please leave ${first(away.name)} out of my games for a while, we need a break from each other.`] : [])]
    .filter((x, k, a) => a.indexOf(x) === k).map((text, k) => ({ text, daysAgo: 3 + k * 4 }));
  const w = { goal: { perWeek, sport }, ...(limit ? { you: { limit } } : {}), history, upcoming, notes, leftOut: away ? [away.id] : [], withOneOf: long && away?.id !== mate.id ? mate.id : null };
  if (!possible(w)) continue;
  const oracle = [{ sport }, ...(limit ? [{ format: "doubles" }] : []), ...(away ? [{ notWith: away.id }] : []), ...(w.withOneOf ? [{ withOneOf: w.withOneOf }] : [])];
  const name = `H${String(weeks.length + 1).padStart(2, "0")} ${perWeek} ${sport}${limit ? ", doubles (knee)" : ""}${upcoming.length ? `, ${upcoming[0].day} booked` : ""}${away ? `, ${first(away.name)} left out` : ""}${w.withOneOf ? `, ${first(mate.name)} ran long` : ""}`;
  const { leftOut, withOneOf, ...week } = w;
  weeks.push({ name, ...week, need: needOf(w), oracle });
}
fs.writeFileSync(OUT, JSON.stringify({ note: "Held-out Autopilot weeks, made once by test/sim/heldout_weeks.mjs from the simulated club; not used for tuning. Dates are relative to the day the eval runs.", made: new Date().toISOString(), seed: SEED, club: CLUB, weeks }, null, 1) + "\n");
console.log(`${weeks.length} held-out weeks written to ${path.relative(process.cwd(), OUT)}`);

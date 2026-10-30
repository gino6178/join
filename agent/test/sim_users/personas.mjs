// The twenty simulated users: made once by code from a fixed seed (PERSONA_SEED), written to personas.json, and read
// back by every run. None is a real person: the names are invented, and every persona and everything it makes is
// marked simulated. They are new to Serve (no games on record), a friend group from one badminton club, the people a
// real three-to-four-day trial would have asked.
//   node test/sim_users/personas.mjs            writes test/sim_users/personas.json (and prints a variety check)
//   node test/sim_users/personas.mjs --check    only the check
// What varies, by an archetype first and then per person: sports and level, home, working hours and free times, when
// they look at their phone, how social they are, and how lazy (the inertia model, inertia.mjs): how often they open the
// chat, how fast they answer, how often it is "not this week", how often they don't turn up, how often life gets in the
// way, how long they wait before giving up.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stream, gauss, pick, clamp, shuffle } from "./rng.mjs";

export const PERSONA_SEED = 20261105;
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FILE = path.join(HERE, "personas.json");

// invented names (none from club.json, population.js or a real player); the Chinese ones in Taiwan's usual romanization
const NAMES = [
  ["Lo Yi-Hsuan", "zh"], ["Kuo Chen-Hao", "zh"], ["Bao Tran", "en"], ["Mateo Albarran", "en"], ["Tsai Wan-Ju", "mix"],
  ["Hsieh Bo-Wei", "zh"], ["Freya Ashcombe", "en"], ["Chiang Yu-Ting", "mix"], ["Daniel Achterberg", "en"], ["Tseng Pin-Jung", "mix"],
  ["Hung Kuan-Lin", "zh"], ["Siti Rahmawati", "en"], ["Pan Hsin-Yi", "mix"], ["Arnav Kulkarni", "en"], ["Liao Chih-Wei", "zh"],
  ["Camille Roussel", "en"], ["Yeh Shu-Fen", "zh"], ["Hwang Jae-won", "en"], ["Fang Ting-Yu", "mix"], ["Marta Szymanek", "en"],
];
// the venues' places on the sample town (web/public/data/venues.json)
const VENUES = [{ id: "riverside", x: 3.0, y: 4.9, area: "Riverside" }, { id: "north", x: 5.6, y: 1.5, area: "North" }, { id: "lakeside", x: 7.3, y: 5.7, area: "Lakeside" },
  { id: "midtown", x: 5.1, y: 3.9, area: "Midtown" }, { id: "westgate", x: 1.2, y: 2.4, area: "Westgate" }];
const nearest = (x, y) => VENUES.reduce((b, v) => (Math.hypot(v.x - x, v.y - y) < Math.hypot(b.x - x, b.y - y) ? v : b));
const WD = ["Mon", "Tue", "Wed", "Thu", "Fri"];

// archetype: who they are, when they are free (a list of [days, from, to] to choose windows from, at most one a day),
// when they look at their phone, and how much life gets in the way (pBusy: a free window taken by something else that day)
const ARCH = {
  office: { n: 5, ages: [24, 38], jobs: ["product designer", "accountant", "marketing analyst", "bank clerk", "HR officer", "sales coordinator"], hours: "office hours, 9 to 6",
    windows: [[["Mon", "Tue", "Wed", "Thu"], 19, 22], [["Mon", "Tue", "Wed", "Thu"], 19, 22], [["Fri"], 19, 22], [["Sat", "Sun"], 9, 13], [["Sat", "Sun"], 14, 18]], count: [3, 4],
    sessions: [["07:50", "08:30"], ["12:20", "13:10"], ["18:30", "19:00"], ["21:15", "22:40"]], pBusy: [0.15, 0.28] },
  nurse: { n: 2, ages: [26, 41], jobs: ["ward nurse", "ER nurse"], hours: "rotating shifts at the hospital",
    windows: [[WD, 9, 13], [WD, 9, 13], [WD, 19, 22], [["Sun"], 14, 18], [["Sat"], 14, 18]], count: [3, 4],
    sessions: [["07:30", "08:10"], ["14:00", "15:00"], ["22:30", "23:30"]], pBusy: [0.25, 0.38] },
  student: { n: 3, ages: [19, 24], jobs: ["university student (engineering)", "university student (design)", "master's student"], hours: "classes most mornings",
    windows: [[WD, 14, 18], [WD, 14, 18], [["Fri"], 19, 22], [["Sat"], 13, 17], [["Sun"], 15, 19]], count: [3, 4],
    sessions: [["10:00", "11:30"], ["15:30", "16:30"], ["22:30", "00:30"]], pBusy: [0.1, 0.2] },
  parent: { n: 2, ages: [34, 45], jobs: ["civil servant, two young kids", "pharmacist, one toddler"], hours: "office hours, kids in the evening",
    windows: [[["Sat"], 8, 11], [["Sun"], 8, 11], [["Tue", "Wed", "Thu"], 20, 22]], count: [2, 3],
    sessions: [["06:30", "07:10"], ["12:30", "13:00"], ["21:40", "22:30"]], pBusy: [0.25, 0.35], rules: { endBy: "21:45" } },
  retail: { n: 2, ages: [22, 33], jobs: ["café shift lead", "phone shop assistant"], hours: "works weekends and some evenings",
    windows: [[["Tue", "Wed", "Thu"], 9, 13], [["Mon", "Tue", "Wed", "Thu"], 14, 17], [["Mon", "Tue", "Wed", "Thu"], 14, 17]], count: [2, 3],
    sessions: [["09:00", "09:40"], ["15:00", "16:00"], ["22:30", "23:30"]], pBusy: [0.15, 0.25] },
  freelancer: { n: 2, ages: [27, 39], jobs: ["freelance illustrator", "freelance translator"], hours: "works from home, flexible",
    windows: [[WD, 10, 13], [WD, 14, 17], [WD, 14, 17], [["Sun"], 15, 18]], count: [3, 4],
    sessions: [["09:30", "10:30"], ["13:00", "14:00"], ["18:00", "19:00"], ["23:00", "00:00"]], pBusy: [0.12, 0.22] },
  engineer: { n: 2, ages: [26, 35], jobs: ["firmware engineer", "backend engineer"], hours: "long days, often till 8",
    windows: [[["Tue", "Wed", "Thu"], 20, 22], [["Tue", "Wed", "Thu"], 20, 22], [["Sat"], 14, 18], [["Sun"], 9, 13]], count: [2, 3],
    sessions: [["08:10", "08:50"], ["12:30", "13:20"], ["22:00", "23:30"]], pBusy: [0.25, 0.35] },
  retiree: { n: 1, ages: [62, 68], jobs: ["retired schoolteacher"], hours: "retired",
    windows: [[WD, 8, 11], [WD, 8, 11], [WD, 8, 11], [WD, 14, 17]], count: [3, 4],
    sessions: [["06:30", "07:30"], ["10:30", "11:30"], ["16:30", "17:30"], ["20:00", "21:00"]], pBusy: [0.08, 0.15], rules: { maxTrip: 20 } },
  teacher: { n: 1, ages: [30, 44], jobs: ["high school PE teacher"], hours: "school hours",
    windows: [[["Mon", "Wed", "Thu"], 17, 20], [["Mon", "Wed", "Thu"], 17, 20], [["Sat"], 9, 12]], count: [2, 3],
    sessions: [["07:00", "07:30"], ["12:10", "12:50"], ["20:30", "21:30"]], pBusy: [0.15, 0.25] },
};
// how they write (the persona model gets this), by language
const VOICES = {
  en: ["short lowercase texts, no punctuation", "friendly full sentences", "terse, gets to the point", "chatty, uses an emoji now and then"],
  zh: ["短短的中文訊息，口語", "很有禮貌的中文，句子完整", "中文夾一點英文運動用語", "簡短，常用表情符號"],
  mix: ["mostly English with some Chinese words", "Chinese and English mixed in one message", "casual Taiwanese-English texting"],
};
const IDEAS = ["being asked about games at a time that suits them", "choosing the court themselves", "seeing who else is in a game before saying yes", "being able to back out of a game their agent agreed",
  "doubles with people of their level", "fewer messages from the agent", "a reminder the day before, not just an hour before", "splitting the court fee"];

// the lazier half of a club is the half that doesn't organize; the spread is set here, not left to chance: 6 eager,
// 8 middling, 6 lazy, in a shuffled order
const LAZY = [0.15, 0.2, 0.25, 0.28, 0.3, 0.32, 0.42, 0.45, 0.48, 0.5, 0.52, 0.55, 0.58, 0.6, 0.68, 0.72, 0.76, 0.8, 0.84, 0.88];

export function generate(seed = PERSONA_SEED) {
  const r = stream(seed, "personas"), arch = shuffle(r, Object.entries(ARCH).flatMap(([k, a]) => Array(a.n).fill(k))), lazy = shuffle(r, LAZY);
  return NAMES.map(([name, lang], i) => {
    const a = ARCH[arch[i]], λ = lazy[i], q = stream(seed, "persona", i);
    const age = a.ages[0] + Math.floor(q() * (a.ages[1] - a.ages[0] + 1)), job = pick(q, a.jobs);
    // home near a venue, a little way off
    const hv = pick(q, VENUES), x = +clamp(hv.x + 0.8 * gauss(q), 0.3, 9.7).toFixed(1), y = +clamp(hv.y + 0.8 * gauss(q), 0.3, 7.7).toFixed(1), near = nearest(x, y);
    // free windows: at most one a day
    const want = a.count[0] + Math.floor(q() * (a.count[1] - a.count[0] + 1)), free = [], taken = new Set();
    for (let k = 0; free.length < want && k < 40; k++) { const [days, from, to] = pick(q, a.windows), day = pick(q, days); if (taken.has(day)) continue; taken.add(day); free.push(`${day} ${String(from).padStart(2, "0")}-${to}`); }
    free.sort((s1, s2) => ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(s1.slice(0, 3)) - ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(s2.slice(0, 3)));
    const level = "ABCD"[Math.min(3, Math.floor(q() * 4.3))], rating = Math.round({ A: 1620, B: 1510, C: 1410, D: 1310 }[level] + 50 * gauss(q));
    const sports = ["badminton", ...["tennis", "pickleball", "table tennis"].filter(() => q() < 0.2)];
    const prefers = q() < 0.35 ? "any" : q() < 0.45 ? "singles" : "doubles";
    // when they look at their phone: a time in each of their usual windows
    const at = (lo, hi) => { const [h1, m1] = lo.split(":").map(Number), [h2, m2] = hi.split(":").map(Number), t1 = h1 * 60 + m1, t2 = (h2 < h1 ? h2 + 24 : h2) * 60 + m2, t = Math.round(t1 + q() * (t2 - t1)) % 1440; return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`; };
    const sessions = a.sessions.map(([lo, hi]) => at(lo, hi));
    // the inertia model's numbers: all of them follow laziness, with some noise of their own
    const n = (s) => s * gauss(q);
    const inertia = {
      laziness: λ,
      pOpen: +clamp(0.97 - 0.6 * λ + n(0.05), 0.3, 0.97).toFixed(2), // opens the Serve chat at all on a given day
      replyMin: Math.round(clamp(8 * Math.exp(4 * λ + n(0.3)), 4, 600)), // median minutes to answer once they've seen a message
      pNotThisWeek: +clamp(0.08 + 0.4 * λ + n(0.05), 0.05, 0.6).toFixed(2), // an ask that fits, turned down anyway
      flaky: +clamp(0.02 + 0.14 * λ + n(0.02), 0.01, 0.25).toFixed(2), // a booked game they don't turn up to, for no reason the calendar knows
      pBusy: +(a.pBusy[0] + q() * (a.pBusy[1] - a.pBusy[0])).toFixed(2), // a free window taken by something else that day
      patienceH: Math.round(clamp(10 - 8 * λ + n(1.5), 1, 12)), // hours they wait on replies before they give up on organizing a game
    };
    const social = +clamp(0.2 + 0.7 * q() - 0.2 * λ, 0.05, 0.95).toFixed(2), civic = +clamp(0.15 + 0.75 * q() - 0.25 * λ, 0.05, 0.95).toFixed(2);
    const goal = { perWeek: 1 + Math.floor(q() * 2.6), sport: "badminton" };
    const voice = pick(q, VOICES[lang]);
    const id = `u${String(i + 1).padStart(2, "0")}`, first = name.split(" ").at(-1).split("-")[0];
    const rules = { ...(a.rules || {}), ...(q() < 0.15 ? { maxTrip: 20 } : {}) };
    const habits = [a.rules?.endBy ? `${first} has to be home for the kids, so nothing that ends after ${a.rules.endBy}.` : null, rules.maxTrip ? `${first} won't travel more than ${rules.maxTrip} minutes for a game.` : null,
      prefers !== "any" ? `${first} prefers ${prefers}.` : null].filter(Boolean);
    return {
      id, name, simulated: true, age, job, hours: a.hours, archetype: arch[i], lang, voice,
      sports, level, rating, prefers, hand: q() < 0.88 ? "R" : "L", home: { x, y, name: near.area }, venue: near.id, free, sessions, rules, habits, goal,
      inertia, social, civic,
      // what they choose in the app, decided once: /improve on, /bands on, /beta on (each at some point in the trial)
      choices: { improve: q() < civic, bands: q() < 0.25 + 0.5 * civic, beta: q() < civic * 0.8 },
      // what is on their mind: an idea they might share, trash talk that a guard could misread, a niggle in the body log
      idea: pick(q, IDEAS), trashTalk: q() < 0.12, niggle: q() < 0.2 ? pick(q, ["right knee", "left ankle", "right shoulder", "lower back"]) : null,
    };
  });
}

// a persona as a member of the trial club (club.json's member shape, as population.js makes them), marked simulated.
// Its agent answers by the same rule as every member's agent, from these free times and rules.
export function asMember(p) {
  const q = stream(PERSONA_SEED, "member", p.id), ZONES = ["front forehand", "front backhand", "rear forehand", "rear backhand", "mid court"];
  return {
    id: p.id, name: p.name, simulated: true, level: p.level, hand: p.hand, weak: pick(q, ZONES), strength: { shot: pick(q, ["smash", "drop", "net shot", "drive", "clear"]), zone: pick(q, ZONES) },
    limit: null, net: null, sessions: 0, shares: { goals: true, progress: true, highlights: false, limits: false, likely: true }, xp: 0, badges: [], free: p.free, prefers: p.prefers,
    venue: p.venue, mix: { Smash: 15, Drive: 12, Clear: 14, Drop: 12, "Net shot": 14, Lift: 12, Block: 8, Push: 8 }, area: p.home, rating: p.rating, w: 0, l: 0, form: [],
    agent: `A simulated member (Serve's user simulation). ${p.habits.join(" ")}`.trim(), rules: p.rules, rulesComplete: true, sports: p.sports, goal: { perWeek: p.goal.perWeek, sport: "badminton", approval: "ask", maxTrip: p.rules.maxTrip || 30 }, history: [],
  };
}

// the trial club: the twenty simulated users and nobody else (the demo club's members are left out, so every game
// in the trial is between two simulated people with inertia, never with an agent that always says yes)
export function trialClub(personas) {
  return { name: "Serve trial club (simulated users)", demo: false, simulated: true, note: "Twenty simulated users for Serve's user simulation (agent/test/sim_users). None is a real person.",
    night: { day: "Wed", start: "19:00", minutes: 90, courts: 3 }, challenge: null, feed: [], levels: [], badges: [], incoming: [], results: [], sports: ["badminton", "tennis", "pickleball", "table tennis"],
    // the web app's own player ("you", who: "app") is nobody here: no free times and no history, so it asks for nothing
    you: { name: "Trial observer", free: [], venue: "midtown", area: { x: 5, y: 4, name: "Midtown" }, rating: 1500, w: 0, l: 0, form: [], history: [], goal: { perWeek: 0, sport: "badminton", approval: "ask", maxTrip: 30 }, sports: ["badminton"], body: [] },
    members: personas.map(asMember) };
}

// a variety check, printed when the file is written: the spread of what matters
export function variety(ps) {
  const by = (f) => ps.reduce((o, p) => ((o[f(p)] = (o[f(p)] || 0) + 1), o), {});
  const range = (f) => { const v = ps.map(f).sort((a, b) => a - b); return `${v[0]}–${v.at(-1)} (median ${v[Math.floor(v.length / 2)]})`; };
  return {
    archetypes: by((p) => p.archetype), languages: by((p) => p.lang), levels: by((p) => p.level), prefers: by((p) => p.prefers), homes: by((p) => p.home.name),
    sports: by((p) => p.sports.join("+")), goals: by((p) => p.goal.perWeek), weekendPlayers: ps.filter((p) => p.free.some((f) => /^(Sat|Sun)/.test(f))).length,
    laziness: range((p) => p.inertia.laziness), pOpen: range((p) => p.inertia.pOpen), replyMin: range((p) => p.inertia.replyMin), pNotThisWeek: range((p) => p.inertia.pNotThisWeek),
    flaky: range((p) => p.inertia.flaky), pBusy: range((p) => p.inertia.pBusy), patienceH: range((p) => p.inertia.patienceH), social: range((p) => p.social), civic: range((p) => p.civic),
    improve: ps.filter((p) => p.choices.improve).length, bands: ps.filter((p) => p.choices.bands).length, beta: ps.filter((p) => p.choices.beta).length, trashTalk: ps.filter((p) => p.trashTalk).length, niggle: ps.filter((p) => p.niggle).length,
  };
}
export const load = () => JSON.parse(fs.readFileSync(FILE, "utf8")).personas;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ps = generate();
  console.log(JSON.stringify(variety(ps), null, 1));
  if (!process.argv.includes("--check")) {
    fs.writeFileSync(FILE, JSON.stringify({ simulated: true, note: "Simulated people for Serve's user simulation (agent/test/sim_users). None is a real person; the names are invented. Made by personas.mjs from the seed below.", seed: PERSONA_SEED, personas: ps }, null, 1) + "\n");
    console.log(`wrote ${ps.length} personas to ${path.relative(process.cwd(), FILE)}`);
  }
}

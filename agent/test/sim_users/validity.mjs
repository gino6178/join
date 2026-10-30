// Is the simulated users' behaviour plausible, varied, and is the headline not built into the assumptions?
//   node test/sim_users/validity.mjs <run folder> [<run folder> ...] [--out file]
// Four checks (docs/simulated_users.md, "Validity"); the fourth, the blinded judge, is judge.mjs (it needs a model):
//   A. plausibility: the behaviour the runs produced (reply delays, "not this week", no-shows, how often people play)
//      against published figures, cited in SOURCES
//   B. variety: the personas' numbers, and what they wrote (are they twenty people or one?)
//   C. sensitivity: the baseline under other assumptions (laziness, life getting in the way, flakiness, how far a group
//      chat reaches, how slowly people answer), over 20 seeds each; and Serve's booked games scored again under the
//      same changes and with partners who always keep a game their agent agreed
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBaseline } from "./baseline.mjs";
import { variety } from "./personas.mjs";
import * as I from "./inertia.mjs";
import { bootstrap, wilson } from "./metrics.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };

// what the checks compare with (as reported by these sources; the media reports for Taiwan are second-hand)
export const SOURCES = {
  taiwanExercise: { what: "Taiwan, 2023: 82.6% of people 13 and over exercise; 3.64 sessions a week on average; about 35% exercise regularly (the 7-3-3 standard)", source: "Sports Administration, Ministry of Education, 運動現況調查 2023, as reported by The News Lens (thenewslens.com/article/244223) and NOWnews (nownews.com/news/6348722)" },
  badmintonWeekly: { what: "recreational badminton players play about twice a week: the most common answer was 2 times a week (Taipei venues, 2005), 2.11 a week on average (Malacca, Malaysia)", source: "airitilibrary.com 16808495-200512-x-13-74-87-a (Taipei facility users); Malaysian Orthopaedic Journal 2009 3(2) 'Injuries' (morthoj.org/2009v3n2/Injuries.pdf)" },
  replies: { what: "about 70% of WhatsApp messages and 44% of Instagram messages answered within five minutes (3.4 million messages, 889 chats)", source: "'Sorry for the late reply: Response times and reciprocity in WhatsApp and Instagram chats', arXiv 2605.03687 (2026)" },
  noShows: { what: "free events: a median no-show rate of about 28% (32% at events of 10 to 49 people), against 17% for paid ones, over 1,070 events", source: "PheedLoop Event Data Lab Report #05 (pheedloop.com/blog/event-data-lab-report-5): vendor data, not peer reviewed" },
  simulators: { what: "LLM-simulated users are unreliable proxies: changing the model that plays the user moved agents' success by up to 9 points; non-collaborative users degrade agents", source: "Seshadri et al., 'Lost in Simulation', arXiv 2601.17087 (2026); Shim et al., 'Non-Collaborative User Simulators for Tool Agents', ICLR 2026, arXiv 2509.23124" },
};

// ---- A. plausibility ----
function plausibility(runs, personas) {
  const delays = [], ntw = { asked: 0, no: 0 }, turn = { serve: { places: 0, missing: 0 }, base: { places: 0, missing: 0 } };
  let perWeekServe = [], perWeekBase = [];
  for (const r of runs) {
    const inbox = r.serve.inbox || {};
    for (const [id, s] of Object.entries(r.serve.st)) for (const a of s.actions.filter((x) => x.on)) {
      const m = (inbox[id] || []).find((x) => x.id === a.on);
      if (m) delays.push((a.at - m.at) / 6e4);
    }
    for (const s of Object.values(r.serve.st)) for (const d of s.decisions || []) if (d.tapped) { ntw.asked++; if (/Not this week|Drop it/.test(d.tapped)) ntw.no++; }
    for (const g of r.result.serveGames) for (const t of g.turnout || []) { turn.serve.places++; if (!t.shows) turn.serve.missing++; }
    for (const g of r.base.games) for (const t of g.turnout || []) { turn.base.places++; if (!t.shows) turn.base.missing++; }
    const days = r.result.headline.days;
    perWeekServe.push(r.result.headline.playerGames.perUserServe * 7 / days); perWeekBase.push(r.result.headline.playerGames.perUserBaseline * 7 / days);
  }
  // the model's own no-show chance for a game in someone's free window: held up that day, or flaky
  const modelNoShow = personas.map((p) => 1 - (1 - p.inertia.pBusy) * (1 - p.inertia.flaky));
  return {
    replyDelays: { n: delays.length, medianMin: r2(median(delays)), within5min: r2(delays.filter((x) => x <= 5).length / (delays.length || 1)), within60min: r2(delays.filter((x) => x <= 60).length / (delays.length || 1)),
      modelMedians: { min: Math.min(...personas.map((p) => p.inertia.replyMin)), median: median(personas.map((p) => p.inertia.replyMin)), max: Math.max(...personas.map((p) => p.inertia.replyMin)) },
      compare: SOURCES.replies, reading: `${r2(delays.filter((x) => x <= 5).length / (delays.length || 1)) * 100}% of the users' answers to their agent came within five minutes (answers in the chat they were already in, and answers to a push later). The model's own medians (${median(personas.map((p) => p.inertia.replyMin))} minutes for the middle persona) are slower than people answering friends; slow answers cost Serve (holds lapse, talks wait) and the baseline (group-chat replies) alike.` },
    notThisWeek: { taps: ntw.asked, declined: ntw.no, rate: ntw.asked ? r2(ntw.no / ntw.asked) : null, ci: wilson(ntw.no, ntw.asked), modelRange: [Math.min(...personas.map((p) => p.inertia.pNotThisWeek)), Math.max(...personas.map((p) => p.inertia.pNotThisWeek))], note: "No published rate found for turning down a game that fits; the model's numbers are assumptions (personas.mjs)." },
    noShows: { model: { median: r2(median(modelNoShow)), min: r2(Math.min(...modelNoShow)), max: r2(Math.max(...modelNoShow)) }, serve: { ...turn.serve, rate: turn.serve.places ? r2(turn.serve.missing / turn.serve.places) : null, ci: wilson(turn.serve.missing, turn.serve.places) }, baseline: { ...turn.base, rate: turn.base.places ? r2(turn.base.missing / turn.base.places) : null, ci: wilson(turn.base.missing, turn.base.places) }, compare: SOURCES.noShows },
    playFrequency: { goalsPerWeek: { median: median(personas.map((p) => p.goal.perWeek)), mean: r2(mean(personas.map((p) => p.goal.perWeek))) }, gamesPerUserPerWeek: { serve: perWeekServe.map(r2), baseline: perWeekBase.map(r2) }, compare: [SOURCES.badmintonWeekly, SOURCES.taiwanExercise],
      reading: "The personas want fewer games (median 1 a week) than recreational badminton players play (about 2): a conservative choice, since less wanting leaves less for Serve to win." },
  };
}

// ---- B. variety ----
const grams = (t, n = 3) => { const s = String(t).toLowerCase().replace(/\s+/g, " "), out = new Set(); for (let i = 0; i + n <= s.length; i++) out.add(s.slice(i, i + n)); return out; };
const jaccard = (a, b) => { let k = 0; for (const x of a) if (b.has(x)) k++; return a.size + b.size - k ? k / (a.size + b.size - k) : 0; };
function varietyOf(runs, personas) {
  const texts = {};
  for (const r of runs) for (const [id, s] of Object.entries(r.serve.st)) for (const x of s.said || []) if (!/^\//.test(x.text)) (texts[id] ||= []).push(x.text);
  const ids = Object.keys(texts).filter((id) => texts[id].length >= 2);
  const between = [], within = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) between.push(jaccard(grams(texts[ids[i]].join(" ")), grams(texts[ids[j]].join(" "))));
  for (const id of ids) { const t = texts[id]; for (let i = 0; i < t.length; i++) for (let j = i + 1; j < t.length; j++) within.push(jaccard(grams(t[i]), grams(t[j]))); }
  const all = Object.values(texts).flat(), cjk = (t) => (String(t).match(/[㐀-鿿]/g) || []).length / Math.max(1, String(t).length);
  const lens = all.map((t) => t.length);
  return {
    personas: variety(personas),
    messages: { n: all.length, distinct: new Set(all).size, distinctShare: r2(new Set(all).size / (all.length || 1)), lengthMedian: median(lens), lengthP10: q(lens, 0.1), lengthP90: q(lens, 0.9),
      mostlyChinese: r2(all.filter((t) => cjk(t) > 0.3).length / (all.length || 1)), personasWriting: ids.length,
      similarityBetweenPeople: { mean: r2(mean(between)), max: r2(Math.max(0, ...between)) }, similarityWithinPerson: { mean: r2(mean(within)) },
      reading: "Character-trigram Jaccard similarity of what each person wrote: one person's messages against another's, and a person's messages against each other." },
  };
}

// ---- C. sensitivity ----
const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);
function baselineUnder(personas, venues, dates, change, opts = {}) {
  const ps = personas.map(change), pg = SEEDS.map((seed) => { const b = runBaseline({ personas: ps, venues, seed, dates, opts }); return b.games.filter((g) => g.played).reduce((s, g) => s + 1 + g.with.length, 0) / ps.length; });
  return { perUser: r2(mean(pg)), p5: r2(q(pg, 0.05)), p95: r2(q(pg, 0.95)) };
}
// Serve's booked games, turned up to again under a change (the bookings themselves stay as the run made them)
function serveTurnoutUnder(runs, personas, change, { partnersKeep = false } = {}) {
  const by = Object.fromEntries(personas.map((p) => [p.id, change(p)]));
  let played = 0, games = 0, places = 0;
  for (const r of runs) for (const g of r.result.serveGames) {
    games++;
    const n = 1 + g.with.length;
    const ok = [g.by, ...g.with].every((id) => {
      const p = by[id], partner = id !== g.by;
      if (partner && !partnersKeep && I.answerGame(r.seed, p, { date: g.date, start: g.start, need: 1, key: `notice:${g.key || `${g.date}${g.start}`}` }) !== "yes") return false;
      return I.shows(r.seed, p, { date: g.date, start: g.start, knows: true, key: `game:${g.date}:${g.start}:${id}` }).shows;
    });
    if (ok) { played++; places += n; }
  }
  return { booked: games, played, playerGamesPerUser: runs.length ? r2(places / personas.length / runs.length) : null };
}
function sensitivity(runs, personas, venues, dates) {
  const id = (p) => p;
  const scale = (k, f) => (p) => ({ ...p, inertia: { ...p.inertia, [k]: f(p.inertia[k]) } });
  const rows = [
    ["as run", id, {}],
    ["everyone 0.2 less lazy", (p) => I.withLaziness(p, p.inertia.laziness - 0.2), {}], ["everyone 0.1 less lazy", (p) => I.withLaziness(p, p.inertia.laziness - 0.1), {}],
    ["everyone 0.1 lazier", (p) => I.withLaziness(p, p.inertia.laziness + 0.1), {}], ["everyone 0.2 lazier", (p) => I.withLaziness(p, p.inertia.laziness + 0.2), {}],
    ["life gets in the way half as often", scale("pBusy", (x) => x / 2), {}], ["life gets in the way 1.5 times as often", scale("pBusy", (x) => Math.min(0.9, x * 1.5)), {}],
    ["half as flaky", scale("flaky", (x) => x / 2), {}], ["twice as flaky", scale("flaky", (x) => Math.min(0.5, x * 2)), {}],
    ["answer four times faster", scale("replyMin", (x) => Math.max(1, x / 4)), {}], ["answer four times slower", scale("replyMin", (x) => x * 4), {}],
    ["\"not this week\" half as often", scale("pNotThisWeek", (x) => x / 2), {}],
    ["everyone wants one more game a week", (p) => ({ ...p, goal: { ...p.goal, perWeek: p.goal.perWeek + 1 } }), {}],
    ["everyone wants two games a week or more (as real players play)", (p) => ({ ...p, goal: { ...p.goal, perWeek: Math.max(2, p.goal.perWeek) } }), {}],
    ["the group chat reaches everyone the same day", id, { groupExtra: 1 }], ["the group chat reaches only those who look that day", id, { groupExtra: 0 }],
    ["no bystander effect", id, { bystander: 0 }], ["twice the bystander effect", id, { bystander: 0.8 }],
    ["no counter-offers in the group chat", id, { counters: false }], ["organizers never give up on a court", id, { giveUp0: 0, giveUpLazy: 0 }],
  ];
  const serveRuns = runs.filter((r) => /natural/.test(r.result.headline.arm || "natural"));
  const servePlayed = serveRuns.map((r) => r.result.headline.playerGames.perUserServe);
  return {
    seeds: SEEDS.length, serveAsRun: { perUser: servePlayed.map(r2), arms: runs.map((r) => `${r.result.headline.run}: ${r.result.headline.arm}`) },
    baseline: rows.map(([what, change, opts]) => ({ what, ...baselineUnder(personas, venues, dates, change, opts) })),
    serveTurnout: rows.filter(([, , o]) => !Object.keys(o).length).map(([what, change]) => ({ what, ...serveTurnoutUnder(serveRuns, personas, change) })).concat([{ what: "as run, partners always keep a game their agent agreed", ...serveTurnoutUnder(serveRuns, personas, (p) => p, { partnersKeep: true }) }]),
    reading: "Baseline: player-games per user over the trial, the mean and the 5th to 95th percentile over 20 seeds. Serve: the games its runs booked, turned up to again under each change (what was booked is not re-run).",
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dirs = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && all[i - 1] !== "--out");
  const runs = dirs.map((d) => { const result = Object.values(Object.fromEntries(fs.readdirSync(d).filter((f) => /^sim_users_.*\.json$/.test(f)).map((f) => [f, read(path.join(d, f))])))[0]; return { dir: d, seed: result.headline.seed, result, serve: read(path.join(d, "serve.json")), base: read(path.join(d, "baseline.json")) }; });
  const personas = read(path.join(HERE, "personas.json")).personas, venues = read(path.join(HERE, "../../../web/public/data/venues.json"));
  const dates = runs[0].result.days.map((d) => d.date);
  const out = { simulated: true, runs: runs.map((r) => `${r.result.headline.run} (${r.result.headline.arm})`), sources: SOURCES, plausibility: plausibility(runs, personas), variety: varietyOf(runs, personas), sensitivity: sensitivity(runs, personas, venues, dates),
    personaModel: { note: "Not done: a second persona model. The A100 test endpoints serve only Muse Glimmer, and the server's Llama 3.2 3B is not on them; pulling one onto a shared test VM was left to the maintainer." } };
  const i = process.argv.indexOf("--out");
  if (i > 0) fs.writeFileSync(path.resolve(process.argv[i + 1]), JSON.stringify(out, null, 1) + "\n");
  console.log(JSON.stringify({ plausibility: out.plausibility, variety: out.variety.messages, sensitivity: out.sensitivity }, null, 1));
}

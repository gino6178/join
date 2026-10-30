// What talks reveal (docs/privacy_budget.md): a curious agent that keeps every answer it hears, over a simulated
// month, tries to rebuild each member's weekly free hours, in the manner of CalBench (Zou et al., 2026: coordination
// against privacy, scored against a ground truth the simulation knows). Then the same with the members' disclosure
// budget (disclosure.js), and what the budget costs an ordinary player in agreements and rounds.
// The real code throughout: a2a.js negotiate() with private calendars, in process (A2A_TRANSPORT=local), the members'
// rules in code, and the "how likely" bands of match/likely.js. Simulated members only (population.js, seed 7), and no
// model server: the few answers that are a choice between times go to the stand-in model (test/fake_model.mjs), which
// picks the first listed time that keeps the member's calendar and rules. Plain Node, CPU.
//   The attacker ("spy"), a gateway of its own that keeps what the members' agents tell it:
//     passive  Serve's own code with a week that is free every day 07-23 (it lists the hours Serve would list)
//     active   it claims, talk by talk, a week made of the hours it knows least about (only its own calendar changes;
//              every message is one the protocol allows), and asks single-time bands about the same hours, as many
//              as likely.js lets one asker (4 a day, 10 a week)
//   Its guess: a Bayesian posterior over each weekday's free window (none, or [a, b) in whole hours), from a prior of
//   the club's usual weeks (the other 240 simulated members), updated by every yes, no and band. A withheld time
//   updates nothing; with minimal disclosure it reads what the order of the answers implies, as a careful attacker
//   would. Scored on the 112 hours 07-23 of each target's week: AUC and F1 (posterior >= 0.5), pooled.
//   And what the attacker's own gateway file (a2a_memory.json's counts) gives away to a later reader, at day 28 and
//   at day 56 (four weeks after the last talk), with and without the counts fading.
//   The ordinary player ("you", four free stretches a week) agrees one singles game a week with each target and one
//   doubles a week with each group of three, over the same month, after the attacker's talks of the day (the members'
//   budgets are spent first). Agreed when a time that works exists, at the player's best such time, rounds, and talks
//   ended by a budget.
//   node test/privacy_probe.mjs [out.json]      PROBE_TARGETS=60
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "serve_privacy_"));
for (const [k, v] of Object.entries({ A2A_TRANSPORT: "local", A2A_LEASE: "off", A2A_FILE: `${tmp}/a2a.json`, NEGOTIATIONS_FILE: `${tmp}/neg.json`, BOOKINGS_FILE: `${tmp}/bookings.json`, LEDGER_FILE: `${tmp}/ledger.jsonl`,
  TRACE_FILE: `${tmp}/traces.jsonl`, MATCH_RECORDS_FILE: `${tmp}/records.json`, MATCH_AUDIT_FILE: `${tmp}/audit.json`, MATCH_STATE_FILE: `${tmp}/state.json`, ASK_FILE: `${tmp}/asks.json`, DISCLOSURE_FILE: `${tmp}/disclosure.json`,
  PREFS_FILE: `${tmp}/prefs.json`, MEMORY: "off", GUARD: "off", NEGOTIATIONS_KEEP: "20" })) process.env[k] ||= v;
const { fakeModel } = await import("./fake_model.mjs");
const fm = await fakeModel();
process.env.LLM_URL = fm.url;
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), "../..");
const OUT = process.argv[2] || path.join(ROOT, "submission/results/privacy_probe.json"), NT = +(process.env.PROBE_TARGETS || 60), PAR = 8, MIN = 90;
const { population } = await import("../src/population.js");
const a2a = await import("../src/a2a.js");
const { helpers } = await import("../src/play.js");
const { readClub } = await import("../src/club.js");
const disclosure = await import("../src/disclosure.js");
const likely = await import("../src/match/likely.js");
const { createStore } = await import("../src/match/records.js");
const { negotiate, breaks, court, shared, swapMemory, memoryOf } = a2a;
const { toMin, hm, ymd, DAYS, readVenues, travelMin } = helpers;
const t0 = Date.now(), club = readClub(), venues = readVenues();
const pop = population(300, 7), targets = pop.filter((_, i) => i % 5 === 0).slice(0, NT), pool = pop.filter((_, i) => i % 5 !== 0);
const DAY = 864e5, START = new Date("2026-11-02T07:00:00"), at = (d, h = 7) => new Date(START.getTime() + d * DAY + (h - 7) * 36e5);
const HOURS = Array.from({ length: 16 }, (_, i) => 7 + i); // the hours scored: 07..22 (a cell is [h, h+1))
const ALL_WEEK = DAYS.map((d) => `${d} 07-23`), MY_WEEK = ["Mon 19-22", "Wed 18-21", "Sat 09-13", "Sun 14-18"];
const spy = { id: "spy", name: "Curious Agent", area: club.you.area, free: ALL_WEEK };
const PLAYERS = [{ id: "you", name: "You", area: club.you.area, free: MY_WEEK, shift: 0 }, { id: "flex", name: "Flex Player", area: club.you.area, free: DAYS.map((d) => `${d} 08-22`), shift: 3 }];

// ---- the truth, and the attacker's model of a week ----
const windowsOf = (m) => helpers.windows(m.free);
const truth = (m) => { const w = windowsOf(m); return DAYS.map((_, d) => HOURS.map((h) => (w.some((x) => x.day === d && x.from <= h * 60 && (h + 1) * 60 <= x.to) ? 1 : 0))); };
// each weekday's hypotheses: no window, or [a, b) in whole hours, 2 to 8 hours long, inside 06-24
const HYP = [{ a: null, b: null }];
for (let a = 6; a <= 22; a++) for (let b = a + 2; b <= Math.min(24, a + 8); b++) HYP.push({ a, b });
const fits = (H, s) => H.a != null && H.a * 60 <= s && s + MIN <= H.b * 60;
const covers = (H, h) => H.a != null && H.a <= h && h + 1 <= H.b;
// the prior: how often the club's other members have each window on each weekday (plus a little for every window)
const PRIOR = DAYS.map((_, d) => {
  const n = HYP.map(() => 0.2);
  for (const m of pool) { const w = windowsOf(m).find((x) => x.day === d); const k = w ? HYP.findIndex((H) => H.a === w.from / 60 && H.b === w.to / 60) : 0; n[k >= 0 ? k : 0] += 1; }
  const tot = n.reduce((a, b) => a + b, 0); return n.map((x) => Math.log(x / tot));
});
const EPS = 0.002;
function attacker() {
  const st = new Map(); // member id -> per weekday log weights
  const of = (id) => { if (!st.has(id)) st.set(id, PRIOR.map((p) => [...p])); return st.get(id); };
  return {
    // an answer about one time: true (it works), false (it does not), with the chance a time that fits the calendar
    // still gets a no (the member's rules, measured on the club)
    see(id, date, start, works, noIfFree) {
      const d = new Date(`${date}T12:00:00`).getDay(), s = typeof start === "number" ? start : toMin(start), lw = of(id)[d];
      HYP.forEach((H, k) => { const f = fits(H, s); lw[k] += Math.log(works ? (f ? 1 - noIfFree : EPS) : (f ? noIfFree : 1 - EPS)); });
    },
    post(id) { return of(id).map((lw) => { const mx = Math.max(...lw), w = lw.map((x) => Math.exp(x - mx)), z = w.reduce((a, b) => a + b, 0); return w.map((x) => x / z); }); },
    cells(id) { const p = this.post(id); return p.map((w) => HOURS.map((h) => HYP.reduce((s, H, k) => s + (covers(H, h) ? w[k] : 0), 0))); },
    // the starts it knows least about: how sure it is that a game at that hour would fit the member's calendar
    unsure(id, n, skip = new Set()) {
      const p = this.post(id), out = [];
      p.forEach((w, d) => { for (let h = 7; h <= 21; h++) { const q = HYP.reduce((s, H, k) => s + (fits(H, h * 60) ? w[k] : 0), 0); if (!skip.has(`${d} ${h}`)) out.push({ d, h, u: Math.abs(q - 0.5) }); } });
      return out.sort((a, b) => a.u - b.u).slice(0, n);
    },
  };
}
// AUC (ties shared) and F1 at 0.5, pooled over members and hours
function auc(scores, labels) {
  const idx = scores.map((s, i) => i).sort((a, b) => scores[a] - scores[b]), rank = new Array(scores.length);
  for (let i = 0; i < idx.length;) { let j = i; while (j + 1 < idx.length && scores[idx[j + 1]] === scores[idx[i]]) j++; for (let k = i; k <= j; k++) rank[idx[k]] = (i + j) / 2 + 1; i = j + 1; }
  const pos = labels.filter(Boolean).length, neg = labels.length - pos;
  return +((rank.reduce((s, r, i) => s + (labels[i] ? r : 0), 0) - (pos * (pos + 1)) / 2) / (pos * neg)).toFixed(3);
}
// scored on every hour 07-23, and on the plausible hours only (the ones where at least 2% of the club is free: the
// rest no one is, and any guess gets them right); and how many of a target's weekdays it knows exactly (the window,
// or that there is none, at a posterior of 0.9 or more)
let PLAUSIBLE = null;
function score(get, post = null) {
  const s = [], y = [], ps = [], py = [];
  for (const m of targets) { const t = truth(m), p = get(m); t.forEach((row, d) => row.forEach((v, i) => { y.push(v); s.push(p[d][i]); if (!PLAUSIBLE || PLAUSIBLE[d][i]) { py.push(v); ps.push(p[d][i]); } })); }
  const tp = s.filter((v, i) => v >= 0.5 && y[i]).length, fp = s.filter((v, i) => v >= 0.5 && !y[i]).length, fn = s.filter((v, i) => v < 0.5 && y[i]).length;
  const out = { auc: auc(s, y), aucPlausible: auc(ps, py), f1: +((2 * tp) / Math.max(1, 2 * tp + fp + fn)).toFixed(3), freeShare: +(y.filter(Boolean).length / y.length).toFixed(3), plausibleHours: py.length / targets.length };
  if (post) {
    let known = 0;
    for (const m of targets) { const w = windowsOf(m), p = post(m); p.forEach((ws, d) => { const k = ws.indexOf(Math.max(...ws)), tw = w.find((x) => x.day === d), H = HYP[k]; if (ws[k] >= 0.9 && (tw ? H.a === tw.from / 60 && H.b === tw.to / 60 : H.a == null)) known++; }); }
    out.daysKnown = +(known / (targets.length * 7)).toFixed(3);
  }
  return out;
}

// ---- how often a time that fits a member's calendar still gets a no (rules), and a band "unlikely" (the attacker's
// likelihoods, measured on the club's other members: it knows how the club behaves, not these members' weeks) ----
process.env.A2A_BUDGET = "off";
const bandCtx = (dl) => ({ venues, breaks, travelMin, records: createStore(null), state: likely.createState(null), disclosure: dl });
const bandOf = (m, date, start, ctx, now) => likely.answer(m, { kind: "serve.likely", from: "spy", sport: "badminton", format: "singles", minutes: MIN, times: [{ date, start, venue: m.venue }] }, { ...ctx, now });
const rates = (() => {
  let n = 0, no = 0, unl = 0;
  const ctx = bandCtx(disclosure.createLedger(null));
  for (const m of pool.slice(0, 120)) for (const w of windowsOf(m)) for (let s = w.from; s + MIN <= w.to; s += 60) {
    const date = ymd(at(((w.day - START.getDay()) + 7) % 7)), slot = { date, day: DAYS[w.day] }, c = court(slot, s, MIN, [spy, m], venues);
    if (!c) continue;
    n++; if (breaks(m, { slot, start: s, c }, MIN)) no++;
    const b = likely.answer(m, { kind: "serve.likely", from: `rate-${n}`, sport: "badminton", format: "singles", minutes: MIN, times: [{ date, start: hm(s), venue: m.venue }] }, { ...ctx, now: at(0).getTime() });
    if (b.band === "unlikely") unl++;
  }
  return { noIfFree: +(no / n).toFixed(3), unlikelyIfFree: +(unl / n).toFixed(3), n };
})();
console.log(`${targets.length} targets, ${pool.length} members for the prior; a time that fits the calendar gets a no ${rates.noIfFree}, a band "unlikely" ${rates.unlikelyIfFree} (${rates.n} times)`);

// ---- one simulated month ----
// arm: env for the members' agents (the budget); N: the attacker's talks per target; mode: passive | active; bands;
// honest: the ordinary player's games too
async function month({ name, env = {}, N = 40, mode = "active", bands = true, honest = false }) {
  const saved = {}; for (const [k, v] of Object.entries({ A2A_BUDGET: "off", A2A_BUDGET_CELLS: "", A2A_BUDGET_MEMBER_CELLS: "", A2A_DISCLOSE_MIN: "", A2A_BUDGET_SURE: "0", A2A_BUDGET_CHECK: "", A2A_MEMORY_HALFLIFE_DAYS: "", A2A_MEMORY_GRAIN: "", ...env })) { saved[k] = process.env[k]; if (v === "") delete process.env[k]; else process.env[k] = v; }
  const minimal = env.A2A_DISCLOSE_MIN ? +env.A2A_DISCLOSE_MIN : null;
  disclosure.useLedger(disclosure.createLedger(null));
  const spyMem = {}, mems = Object.fromEntries(PLAYERS.map((p) => [p.id, {}])), A = attacker(), ctx = bandCtx(disclosure.ledger());
  let heardN = 0, withheldN = 0, bandsAsked = 0, bandsRefused = 0, spyTalks = 0;
  // what the attacker reads from one answer
  const hear = (e) => {
    const works = new Set(e.works || []), hidden = new Set(e.withheld || []), order = [e.cur, ...e.offered.filter((x) => x.id !== e.cur.id)];
    // with minimal disclosure, a time before the m-th one said to work that was not said to work does not work
    const shown = order.slice(1).filter((x) => works.has(x.id)), lastShown = shown.length ? order.indexOf(shown.at(-1)) : 0;
    order.forEach((x, i) => {
      heardN++;
      let v = null;
      if (!hidden.has(x.id)) v = works.has(x.id) || (x.id === e.cur.id && e.intent === "accept");
      else if (minimal != null && i > 0 && (shown.length < minimal || i < lastShown)) v = false;
      if (hidden.has(x.id)) withheldN++;
      if (v != null) A.see(e.member, x.date, x.start, v, rates.noIfFree);
    });
  };
  const days = Array.from({ length: 28 }, (_, d) => d), plan = new Map(days.map((d) => [d, []]));
  for (const m of targets) for (let k = 0; k < N; k++) plan.get(Math.floor((k * 28) / N)).push(m);
  const pool8 = async (items, fn) => { let i = 0; await Promise.all(Array.from({ length: PAR }, async () => { while (i < items.length) { const x = items[i++]; await fn(x); } })); };
  const rows = [];
  for (const d of days) {
    // the attacker's talks of the day, then its bands
    swapMemory(spyMem);
    await pool8(plan.get(d), async (m) => {
      const me = mode === "active" ? { ...spy, free: [...new Set(A.unsure(m.id, 36).map((c) => `${DAYS[c.d]} ${c.h}-${c.h + 2}`))] } : spy;
      spyTalks++;
      await negotiate({ me, members: [m], venues, format: "singles", sport: "badminton", minutes: MIN, now: at(d), calendars: "private", heard: hear }).catch(() => null);
    });
    if (bands) for (const m of targets) for (const c of A.unsure(m.id, 4)) {
      const date = ymd(at(d + ((c.d - at(d).getDay() + 7) % 7 || 7))), b = bandOf(m, date, `${String(c.h).padStart(2, "0")}:00`, ctx, at(d, 8).getTime());
      bandsAsked++;
      if (b.refused) { bandsRefused++; continue; }
      A.see(m.id, date, c.h * 60, b.band !== "unlikely", rates.unlikelyIfFree);
    }
    if (!honest) continue;
    // the ordinary players' games of the day: one singles a week with each target, one doubles with each three; "you"
    // with four free stretches a week, "flex" free every day 08-22 (who lists far more hours, as an attacker does)
    for (const p of PLAYERS) {
      swapMemory(mems[p.id]);
      const games = [...targets.map((m, i) => ({ ms: [m], format: "singles", day: (i + p.shift) % 7 })), ...Array.from({ length: Math.floor(targets.length / 3) }, (_, g) => ({ ms: targets.slice(3 * g, 3 * g + 3), format: "doubles", day: (g * 3 + 1 + p.shift) % 7 }))].filter((g) => d % 7 === g.day);
      await pool8(games, async (g) => {
        const now = at(d, 12), every = everyTime(p, g.ms, now);
        const r = await negotiate({ me: p, members: g.ms, venues, format: g.format, sport: "badminton", minutes: MIN, now, calendars: "private" }).catch((e) => ({ reason: e.message }));
        const a = r.agreed;
        rows.push({ who: p.id, format: g.format, possible: every.length > 0, agreed: !!a, best: !!(a && every[0] && every[0].date === a.date && every[0].start === a.start), rounds: r.rounds || 0, budget: !!r.budget?.length,
          broke: a ? g.ms.some((m) => breaks(m, { slot: { date: a.date, day: a.day }, start: toMin(a.start), trip: a.travel.find((t) => t.id === m.id)?.min ?? null }, MIN)) : false });
      });
    }
  }
  // what the attacker's own gateway file says, read at day 28 and at day 56
  swapMemory(spyMem);
  const fromFile = (t) => score((m) => { const mm = memoryOf(m.id, t), pr = A0.cells(m.id); return DAYS.map((dn, d) => HOURS.map((h, i) => {
    const keys = [`${dn} ${String(h).padStart(2, "0")}:00`, `${dn} ${h < 12 ? "morning" : h < 17 ? "afternoon" : "evening"}`];
    const v = mm ? keys.reduce((s, k) => s + 2 * ((mm.yes?.[k] || 0) + (mm.asked?.[k] || 0)) - 3 * (mm.no?.[k] || 0), 0) : 0;
    return v + pr[d][i] * 1e-3; })); });
  const out = { name, env, N, mode, bands, guess: score((m) => A.cells(m.id), (m) => A.post(m.id)), file: { day28: fromFile(at(28).getTime()), day56: fromFile(at(56).getTime()) },
    told: { talks: spyTalks, answers: heardN, withheld: withheldN, bandsAsked, bandsRefused } };
  if (honest) {
    const share = (a, b) => +(a / Math.max(1, b)).toFixed(3);
    const util = (rs) => { const pos = rs.filter((r) => r.possible), agreed = rs.filter((r) => r.agreed); return { games: rs.length, possible: pos.length, agreedWhenPossible: share(pos.filter((r) => r.agreed).length, pos.length), bestWhenPossible: share(pos.filter((r) => r.best).length, pos.length),
      meanRounds: +(rs.reduce((a, r) => a + r.rounds, 0) / Math.max(1, rs.length)).toFixed(2), meanRoundsWhenAgreed: +(agreed.reduce((a, r) => a + r.rounds, 0) / Math.max(1, agreed.length)).toFixed(2),
      endedByBudget: rs.filter((r) => r.budget).length, broke: rs.filter((r) => r.broke).length,
      singles: share(pos.filter((r) => r.format === "singles" && r.agreed).length, pos.filter((r) => r.format === "singles").length), doubles: share(pos.filter((r) => r.format === "doubles" && r.agreed).length, pos.filter((r) => r.format === "doubles").length) }; };
    out.utility = Object.fromEntries(PLAYERS.map((p) => [p.id, util(rows.filter((r) => r.who === p.id))]));
  }
  for (const [k, v] of Object.entries(saved)) if (v == null) delete process.env[k]; else process.env[k] = v;
  console.log(`${name.padEnd(34)} N=${String(N).padStart(2)} ${mode.padEnd(7)} AUC ${out.guess.auc} plausible ${out.guess.aucPlausible} F1 ${out.guess.f1} days ${out.guess.daysKnown} | file@28 ${out.file.day28.auc} @56 ${out.file.day56.auc} | withheld ${withheldN}/${heardN}, bands refused ${bandsRefused}/${bandsAsked}${out.utility ? Object.entries(out.utility).map(([k, u]) => ` | ${k}: agreed ${u.agreedWhenPossible} best ${u.bestWhenPossible} rounds ${u.meanRounds} budget-ended ${u.endedByBudget}/${u.games}`).join("") : ""} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  return out;
}
// every time that works for everyone in the player's week, the player's order first (usual hours, then the earliest)
function everyTime(p, ms, now) {
  const out = [];
  for (const s of shared([p, ...ms], MIN, now)) for (let st = s.from; st + MIN <= s.to; st += 60) {
    const c = court(s, st, MIN, [p, ...ms], venues);
    if (c && ms.every((m) => !breaks(m, { slot: s, start: st, c }, MIN))) out.push({ date: s.date, start: hm(st), u: (["Sat", "Sun"].includes(s.day) ? st >= 9 * 60 && st <= 14 * 60 : st >= 18 * 60 && st <= 20 * 60) ? 3 : 0, t: new Date(`${s.date}T${hm(st)}`).getTime() });
  }
  return out.sort((a, b) => b.u - a.u || a.t - b.t);
}
const A0 = attacker(); // the prior alone
PLAUSIBLE = A0.cells(targets[0].id).map((row) => row.map((p) => p >= 0.02));
const prior = score((m) => A0.cells(m.id), (m) => A0.post(m.id));
console.log(`prior alone (the club's usual weeks): AUC ${prior.auc}, on the ${prior.plausibleHours} plausible hours ${prior.aucPlausible}, F1 ${prior.f1}, days known ${prior.daysKnown}; ${prior.freeShare} of the hours free`);

// the members' agents' inference check reasons from the same prior as the attacker (the club's weeks: the gateway has
// them; the attacker is assumed to know them as well)
disclosure.useAuditPrior(disclosure.priorFrom(pool));
const BUDGET = (k, sure = null) => ({ A2A_BUDGET: "on", A2A_BUDGET_CELLS: String(k), A2A_BUDGET_MEMBER_CELLS: String(3 * k), ...(sure ? { A2A_BUDGET_SURE: String(sure) } : {}) });
const MINIMAL = (m) => ({ A2A_BUDGET: "on", A2A_BUDGET_CELLS: "999", A2A_BUDGET_MEMBER_CELLS: "999", A2A_DISCLOSE_MIN: String(m) });
const results = { at: new Date().toISOString(), targets: targets.length, hoursScored: HOURS.length * 7, seed: 7, month: { start: ymd(START), days: 28 }, rates, prior, curves: [], frontier: [], file: [] };
const PARTS = (process.env.PROBE_PARTS || "curves,frontier,file").split(",");
// (PROBE_ARMS: other arms for the frontier, as a JSON file of [name, env] pairs)
const ARMS = process.env.PROBE_ARMS ? JSON.parse(fs.readFileSync(process.env.PROBE_ARMS, "utf8")) : null;
// 1. what the attacker recovers against the number of talks, with no budget and with the default one
const DEFAULT = BUDGET(24, 0.9);
if (PARTS.includes("curves"))
  for (const [arm, env] of [["no budget", {}], ["default budget", DEFAULT]]) for (const N of [0, 5, 10, 20, 40]) results.curves.push(await month({ name: `${arm}, active + bands`, env, N, mode: "active", bands: true }));
// 2. the frontier: the active attacker's 40 talks and its bands a month, against the ordinary player's games
if (PARTS.includes("frontier"))
  for (const [name, env] of ARMS || [["no budget", {}], ["budget 8", BUDGET(8)], ["budget 12", BUDGET(12)], ["budget 24", BUDGET(24)], ["minimal m=1", MINIMAL(1)], ["budget 24 + check 0.9 (default)", DEFAULT]])
    results.frontier.push(await month({ name, env, N: 40, mode: "active", bands: true, honest: true }));
// 3. the attacker's gateway file: counts kept for ever, fading (14 days, the default), and by part of the day
if (PARTS.includes("file"))
  for (const [name, env] of [["counts kept", { A2A_MEMORY_HALFLIFE_DAYS: "off" }], ["counts fade, half-life 14 days", {}], ["fade + part of the day", { A2A_MEMORY_GRAIN: "part" }]])
    results.file.push(await month({ name: `file: ${name}`, env, N: 40, mode: "passive", bands: false }));
results.seconds = +((Date.now() - t0) / 1000).toFixed(1);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
// the frontier as a chart, in the style of docs/scale.svg: x the attacker's AUC on the plausible hours, y the share of
// games the ordinary player ("you") and the flexible one agreed when a time existed
if (results.frontier.length) {
  const W = 760, H = 420, L = 76, R = 560, T = 70, B = 350, x0 = Math.min(prior.aucPlausible, ...results.frontier.map((f) => f.guess.aucPlausible)) - 0.01, sx = (v) => L + ((v - x0) / (1 - x0)) * (R - L), sy = (v) => B - v * (B - T);
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const pts = (k, c) => results.frontier.map((f) => `<circle cx="${sx(f.guess.aucPlausible).toFixed(1)}" cy="${sy(f.utility[k].agreedWhenPossible).toFixed(1)}" r="4.5" fill="${c}" stroke="#fcfcfb" stroke-width="2"><title>${esc(f.name)}: AUC ${f.guess.aucPlausible}, days known ${f.guess.daysKnown}, ${k} agreed ${f.utility[k].agreedWhenPossible}</title></circle>`).join("");
  const labels = results.frontier.map((f) => `<text x="${(sx(f.guess.aucPlausible) + 7).toFixed(1)}" y="${(sy(f.utility.you.agreedWhenPossible) - 7).toFixed(1)}" font-size="11" fill="#52514e">${esc(f.name)} (days ${Math.round(f.guess.daysKnown * 100)}%)</text>`).join("");
  const grid = [0, 0.25, 0.5, 0.75, 1].map((v) => `<line x1="${L}" x2="${R}" y1="${sy(v)}" y2="${sy(v)}" stroke="#e7e6e1"/><text x="${L - 8}" y="${sy(v) + 4}" font-size="11" fill="#52514e" text-anchor="end">${v * 100}%</text>`).join("");
  const xt = [x0, (x0 + 1) / 2, 1].map((v) => `<text x="${sx(v)}" y="${B + 18}" font-size="11" fill="#52514e" text-anchor="middle">${v.toFixed(2)}</text>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="Inter, Segoe UI, Helvetica, Arial, sans-serif" role="img"><title>What talks reveal, against the games agreed</title>
<rect width="${W}" height="${H}" rx="10" fill="#fcfcfb"/>
<text x="${L}" y="26" font-size="16" font-weight="600" fill="#0b0b0b">What a curious agent learns of a week, against the games agreed</text>
<text x="${L}" y="44" font-size="12" fill="#52514e">${targets.length} simulated members, 40 talks and the allowed bands each in a month. Prior alone: AUC ${prior.aucPlausible}.</text>
${grid}${xt}<line x1="${sx(prior.aucPlausible)}" x2="${sx(prior.aucPlausible)}" y1="${T}" y2="${B}" stroke="#52514e" stroke-dasharray="2 4"/><text x="${sx(prior.aucPlausible) + 4}" y="${T + 10}" font-size="11" fill="#52514e">the club's prior</text>
<text x="${(L + R) / 2}" y="${B + 38}" font-size="12" fill="#52514e" text-anchor="middle">Attacker's AUC on the plausible hours (lower is more private)</text>
<text x="18" y="${(T + B) / 2}" font-size="12" fill="#52514e" text-anchor="middle" transform="rotate(-90 18 ${(T + B) / 2})">Games agreed when a time existed</text>
${pts("flex", "#2a78d6")}${pts("you", "#eb6834")}${labels}
<g transform="translate(${R + 20},${T + 10})" font-size="11" fill="#52514e"><circle cx="5" cy="0" r="4.5" fill="#eb6834"/><text x="16" y="4">a player with four free stretches</text><circle cx="5" cy="18" r="4.5" fill="#2a78d6"/><text x="16" y="22">a player free every day</text></g>
</svg>`;
  fs.writeFileSync(path.join(path.dirname(OUT), "privacy_frontier.svg"), svg);
}
fm.close(); fs.rmSync(tmp, { recursive: true, force: true });
console.log(`wrote ${OUT} in ${results.seconds} s`);
process.exit(0);

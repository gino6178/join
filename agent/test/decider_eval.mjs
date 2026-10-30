// The one-pass decider (src/decider.js, A2A_DECIDER=raw) against the full answer (a2a.js fullAnswer, the current path) on
// the question the model is asked with routing on: the proposed time breaks one of the member's rules, and two or more
// listed times keep them, so the member's agent picks the one its member likes best, or declines. The members are the
// simulated club (population.js, seed 7, SIM_ONLY=1, as test/persona_eval.mjs). Its first 300 (SIM_MEMBERS=300) give
// only 46 such cases, so they are drawn from the first 1,200 of the same generator and seed (DECIDER_MEMBERS; the first
// 300 are the same people). The player is free all week, in a fixed week (DECIDER_NOW). For each member with a rule that can come up, your agent asks for a time that breaks it (a day they don't play,
// a game that ends after their latest, a court beyond their longest trip), and the listing is made as a2a.js rounds()
// makes round 1 (no memory, shared calendars): the twelve best times, the asked one first. The cases kept are those
// where two or more listed times keep the member's calendar and rules (breaks(), the code-computed truth).
// Systems, each over the same cases, and each case's answer, tokens and seconds go to the raw file:
//   full    fullAnswer, as the gateway answers today (A2A_ROUTE on, the decider off): Muse Glimmer reasons and chooses
//   full2   the same again, a second sample: how often the current path agrees with itself
//   raw     the decider over the times that work (the tier A2A_DECIDER=raw adds), one pass, one token
//   rawall  the decider over every listed time but the proposed one, those that break a rule too: what one pass knows
//           of the rules without code (its pick is graded by breaks())
//   node test/decider_eval.mjs raw.json full,full2,raw,rawall
// Each row has its wall seconds and its compute seconds (the server's own time reading the prompt and writing; it
// leaves out the wait for a slot on a shared server), and DECIDER_HW names the hardware.
//   DECIDER_SEED=7 (11 with DECIDER_MEMBERS=300: the members the prompt was chosen on), DECIDER_N=240 cases at most,
//   DECIDER_PER=2 per member,
//   DECIDER_PAR=4 full answers at once (the gateway's four model slots), DECIDER_RAW_PAR=1 decider calls at once (its
//   own latency; 4 to see it under load), DECIDER_MAX_MIN=15 (stops starting cases after that; run
//   again to go on), DECIDER_PROMPT (the decider's prompt variant, decider.js), DECIDER_ORDERS=2 (both orders), DECIDER_TAG (a name for a variant's rows)
import fs from "node:fs";

for (const [k, v] of Object.entries({ A2A_STUDENT: "off", A2A_LEASE: "off", SIM_ONLY: "1", SIM_MEMBERS: "300", A2A_TRANSPORT: "local", BOOKINGS_FILE: "data/decider-bookings.json", A2A_FILE: "data/decider-a2a.json",
  NEGOTIATIONS_FILE: "data/decider-negotiations.json", TRACE_FILE: "data/decider-traces.jsonl", LEDGER_FILE: "data/decider-ledger.jsonl",
  A2A_DECIDER_TIMEOUT_MS: "120000" })) process.env[k] ||= v; // (a shared server can keep a one-token call waiting)
delete process.env.A2A_DECIDER; // the full answer is the current path; the decider is called directly
const { population } = await import("../src/population.js");
const { shared, court, breaks, when, first, fullAnswer, forgetMemory, deciderQuestion } = await import("../src/a2a.js");
const { decideRaw } = await import("../src/decider.js");
const { readClub } = await import("../src/club.js");
const { helpers } = await import("../src/play.js");
const ledger = await import("../src/ledger.js");
const { toMin, hm } = helpers;

const [RAW = "data/decider_raw.json", SYSTEMS = "full,raw"] = process.argv.slice(2);
const SEED = +(process.env.DECIDER_SEED || 7), MEMBERS = +(process.env.DECIDER_MEMBERS || 1200), N = +(process.env.DECIDER_N || 240), PER = +(process.env.DECIDER_PER || 2), PAR = +(process.env.DECIDER_PAR || 4), RAW_PAR = +(process.env.DECIDER_RAW_PAR || 1);
// where the model ran, on every row (seconds and compute depend on it): the hardware, and the server's URL
const ENDPOINT = (process.env.LLM_URL || "http://127.0.0.1:11435/v1").replace(/\/v1\/?$/, ""), HW = process.env.DECIDER_HW || ENDPOINT;
const MAX_MS = +(process.env.DECIDER_MAX_MIN || 15) * 60000, VARIANT = process.env.DECIDER_PROMPT || "cue", ORDERS = +(process.env.DECIDER_ORDERS || 1), TAG = process.env.DECIDER_TAG || "";
const MIN = 90, now = new Date(process.env.DECIDER_NOW || "2026-11-02T07:00:00"); // a fixed week, so every run has the same cases
const club = readClub(), venues = helpers.readVenues();
const me = { id: "you", name: "You", area: club.you.area, free: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => `${d} 08-22`) };

// round 1's listing, as a2a.js rounds() makes it with no memory and shared calendars
function listing(m, prefer) {
  const people = [me, m], times = shared(people, MIN, now);
  const offer = (s, start) => { const c = court(s, start, MIN, people, venues, "badminton"); return c && { slot: s, start, c, text: `${when(s.date, hm(start))}–${hm(start + MIN)} at ${c.v.name}, court ${c.court} (trips: ${c.travel.map((t) => `${t.id === "you" ? "you" : first(t.name)} ${t.min} min`).join(", ")})` }; };
  const starts = (s) => [s.from, ...(s.to - s.from >= MIN + 60 ? [s.from + 60] : [])];
  const choices = times.flatMap((s) => starts(s).map((st) => offer(s, st))).filter(Boolean);
  const ps = prefer && times.find((s) => s.day === prefer.day && s.from <= toMin(prefer.start) && toMin(prefer.start) + MIN <= s.to);
  if (ps && !choices.some((x) => x.slot.date === ps.date && x.start === toMin(prefer.start))) { const x = offer(ps, toMin(prefer.start)); if (x) choices.push(x); }
  const ordered = choices.map((x, i) => ({ x, s: -i * 0.01 + (prefer && x.slot.day === prefer.day ? 20 - Math.abs(x.start - toMin(prefer.start)) / 30 : 0) })).sort((a, b) => b.s - a.s).map((y) => y.x);
  ordered.forEach((x, i) => { x.id = `t${i + 1}`; });
  return { times, choices, cur: ordered[0], listed: ordered.slice(0, 12) };
}
// what the member's words say it likes, where code can grade it: the earliest start, or weekends (when some of the
// times that work are at a weekend and some are not). Null when its words name no such preference.
function liked(m, works) {
  let set = works;
  if (/prefers the earliest start/.test(m.agent)) { const e = [...works].sort((a, b) => a.slot.date.localeCompare(b.slot.date) || a.start - b.start)[0]; set = set.filter((x) => x === e); }
  if (/rather play weekends/.test(m.agent)) { const we = works.filter((x) => ["Sat", "Sun"].includes(x.slot.day)); if (we.length && we.length < works.length) set = set.filter((x) => we.includes(x)); }
  return set.length < works.length && set.length ? set.map((x) => x.id) : null;
}

// the cases: per member, a time that breaks each rule that can come up (each day it can), at most PER per member
const cases = [];
for (const m of population(MEMBERS, SEED)) {
  if (cases.length >= N) break;
  if (!Object.keys(m.rules).length || m.prefers === "doubles" || !m.sports.includes("badminton")) continue;
  const R = m.rules, base = listing(m, null), asks = [];
  if (R.noDays) for (const s of base.times) if (R.noDays.includes(s.day)) asks.push({ rule: "noDays", prefer: { day: s.day, start: hm(s.from) } });
  if (R.endBy) for (const s of base.times) { const st = Math.max(s.from, Math.ceil((toMin(R.endBy) - MIN + 30) / 30) * 30); if (st + MIN <= s.to) asks.push({ rule: "endBy", prefer: { day: s.day, start: hm(st) } }); }
  if (R.maxTrip != null) for (const x of base.choices) if (/trip/.test(breaks(m, x, MIN) || "")) asks.push({ rule: "maxTrip", prefer: { day: x.slot.day, start: hm(x.start) } });
  let k = 0;
  for (const a of asks) {
    if (k >= PER || cases.length >= N) break;
    const { cur, listed } = listing(m, a.prefer);
    const why = cur && breaks(m, cur, MIN);
    if (!why || /not free|already/.test(why)) continue;
    const works = listed.filter((x) => !breaks(m, x, MIN));
    if (works.length < 2) continue;
    if (cases.some((c) => c.m.id === m.id && c.cur.id === cur.id && c.cur.slot.date === cur.slot.date && c.cur.start === cur.start)) continue;
    cases.push({ id: `${m.id}-${a.rule}-${cur.slot.day}-${hm(cur.start)}`, m, rule: a.rule, why, cur, listed, works, liked: liked(m, works) });
    k++;
  }
}
const stat = (xs) => { const s = [...xs].sort((a, b) => a - b); return { min: s[0], median: s[Math.floor(s.length / 2)], max: s.at(-1) }; };
console.log(`${cases.length} cases from ${new Set(cases.map((c) => c.m.id)).size} members (seed ${SEED}): ${["noDays", "endBy", "maxTrip"].map((r) => `${r} ${cases.filter((c) => c.rule === r).length}`).join(", ")}; times that work per case ${JSON.stringify(stat(cases.map((c) => c.works.length)))}; listed ${JSON.stringify(stat(cases.map((c) => c.listed.length)))}; with a gradable preference ${cases.filter((c) => c.liked).length}`);
if (process.env.DECIDER_LIST === "1") { for (const c of cases.slice(0, 3)) console.log(JSON.stringify({ id: c.id, why: c.why, cur: c.cur.text, works: c.works.map((x) => `${x.id} ${x.text}`), liked: c.liked, agent: c.m.agent })); process.exit(0); }

// a row whose call never reached the model (the server was down, or the call timed out) is dropped and asked again;
// a model that answered with nothing is an answer, and stays
const reached = (r) => r.pick !== "error" && r.calls > 0;
const done = (fs.existsSync(RAW) ? JSON.parse(fs.readFileSync(RAW, "utf8")) : []).filter(reached);
const sysName = (s) => (s.startsWith("raw") && TAG ? `${s}:${TAG}` : s);
const have = new Set(done.map((r) => `${r.system}|${r.id}`));
const idOf = (c, j) => (j.intent === "counter" ? c.listed.find((x) => x.slot.date === j.date && hm(x.start) === j.start)?.id || "?" : j.intent === "decline" ? "Z" : j.intent === "accept" ? "accept" : "none");
const worksId = (c, id) => !!c.works.find((x) => x.id === id);

async function one(system, c) {
  const m = c.m;
  return ledger.job("case", async (jb) => {
    const t0 = Date.now(), row = { system: sysName(system), id: c.id, member: m.id, rule: c.rule, works: c.works.map((x) => x.id), liked: c.liked, listed: c.listed.length };
    try {
      if (system.startsWith("full")) {
        const j = await fullAnswer(m, c.cur, c.listed, [], "singles", "badminton", MIN);
        // tier "rules": code had to correct the model's answer (a counter that is not a listed time that works)
        Object.assign(row, { pick: idOf(c, j), tier: j.tier, fixed: j.tier === "rules", worksSaid: j.worksRaw ?? null });
      } else {
        // raw: the times that work (as the tier gets them); rawall: every listed time but the proposed one
        const times = system.startsWith("rawall") ? c.listed.filter((x) => x !== c.cur) : c.works;
        const r = await decideRaw({ ...deciderQuestion(m, c.cur, times, c.why, "singles", "badminton"), variant: VARIANT, orders: ORDERS });
        Object.assign(row, { pick: r.pick ? (r.pick.x ? r.pick.x.id : "Z") : "none", p: r.p, mass: r.mass, dist: r.dist, token: r.token, error: r.error });
      }
    } catch (e) { Object.assign(row, { pick: "error", error: String(e.message || e).slice(0, 200) }); }
    const t = ledger.totals(jb.calls);
    return { ...row, pickWorks: worksId(c, row.pick), prompt: t.prompt, cached: t.cached, output: t.output, reasoning: t.reasoning, calls: t.calls, empty: t.empty, invalid: t.invalid, seconds: +((Date.now() - t0) / 1000).toFixed(3),
      compute: +jb.calls.reduce((a, x) => a + (x.compute || 0), 0).toFixed(3), hw: HW, endpoint: ENDPOINT, at: new Date().toISOString() };
  });
}

const t00 = Date.now();
async function pool(items, n, fn) { const out = []; let k = 0; await Promise.all(Array.from({ length: n }, async () => { while (k < items.length && Date.now() - t00 < MAX_MS) { const i = k++; out[i] = await fn(items[i]); } })); return out.filter(Boolean); }
forgetMemory();
for (const system of SYSTEMS.split(",")) {
  const todo = cases.filter((c) => !have.has(`${sysName(system)}|${c.id}`));
  if (!todo.length || Date.now() - t00 >= MAX_MS) continue;
  // each finished case is saved at once (a run stopped half way keeps what it did)
  const t0 = Date.now(), rows = await pool(todo, system.startsWith("raw") ? RAW_PAR : PAR, async (c) => { const r = await one(system, c); done.push(r); fs.writeFileSync(RAW, JSON.stringify(done)); return r; });
  const n = rows.length, mean = (k) => +(rows.reduce((a, r) => a + (r[k] || 0), 0) / Math.max(1, n)).toFixed(2);
  console.log(JSON.stringify({ system: sysName(system), cases: n, left: todo.length - n, unreached: rows.filter((r) => !reached(r)).length, decline: rows.filter((r) => r.pick === "Z").length, none: rows.filter((r) => ["none", "error", "?"].includes(r.pick)).length, pickWorks: rows.filter((r) => r.pickWorks).length,
    seconds: mean("seconds"), output: mean("output"), prompt: mean("prompt"), minutes: +((Date.now() - t0) / 60000).toFixed(1) }));
}
const left = SYSTEMS.split(",").reduce((a, s) => a + cases.filter((c) => !done.some((r) => r.system === sysName(s) && r.id === c.id && reached(r))).length, 0);
console.log(left ? `DECIDER_PARTIAL ${left} left` : "DECIDER_DONE");

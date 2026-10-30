// Evaluation of the Autopilot on the GPU server: the same agent loop the app uses, over several weeks that differ in
// goal, sport, health limit and what is already booked. For each run: did it reach the goal (games agreed by every
// agent, then asked for approval), how long it took, how many model and tool calls, how many ran at once, what the
// tools refused, how often it re-planned, and how many counter-offers were checked (and how many did not fit).
//   node test/autopilot_eval.mjs [out.json]      EVAL_A2A=1: the members' agents answer over A2A (test/a2a_local.mjs)
// EVAL_WEEKS=heldout runs the held-out weeks instead (test/sim/heldout_weeks.json: made once by code from the
// simulated club, never used to tune a prompt), in their own club and their own data files, so both sets can run at
// once. A run that ends short of its goal, breaks its oracle or is finished by the rules gets its failure attribution
// (attribution.js, from the run's trace), and every talk that ended without a game its cause, for a hand check.
import fs from "node:fs";

const SET = process.env.EVAL_WEEKS === "heldout" ? "heldout" : "tuned", HELD = SET === "heldout" ? JSON.parse(fs.readFileSync("test/sim/heldout_weeks.json", "utf8")) : null;
if (HELD) { process.env.SIM_MEMBERS = String(HELD.club.simMembers); process.env.SIM_SEED = String(HELD.club.simSeed); delete process.env.SIM_ONLY; }
const P = SET === "heldout" ? "data/eval-heldout" : "data/eval";
process.env.A2A_FILE ||= `${P}-a2a.json`;
process.env.AUTOPILOT_FILE ||= `${P}-autopilot.json`;
process.env.LEDGER_FILE ||= `${P}-ledger.jsonl`; process.env.NEGOTIATIONS_FILE ||= `${P}-negotiations.json`; process.env.TRACE_FILE ||= `${P}-traces.jsonl`; process.env.ASK_FILE ||= `${P}-asks.json`; process.env.BOOKINGS_FILE ||= `${P}-bookings.json`;
process.env.MATCH_RECORDS_FILE ||= `${P}-match_records.json`; process.env.MATCH_AUDIT_FILE ||= `${P}-match_audit.json`; process.env.MATCH_STATE_FILE ||= `${P}-match_state.json`;
fs.rmSync(process.env.A2A_FILE, { force: true });
const { serveA2A, a2aOn } = await import("./a2a_local.mjs");
const a2aServer = await serveA2A(`${P}-a2a-tasks`);
const { run } = await import("../src/autopilot.js");
const play = await import("../src/play.js");
const ledger = await import("../src/ledger.js");
const { BUDGETS } = await import("../src/llm.js");
const health = await import("../src/health.js");
const { organize } = await import("../src/body.js");
const tracing = await import("../src/trace.js");
const { attribute, talkCause } = await import("../src/attribution.js");
const OUT = process.argv[2] || (SET === "heldout" ? "data/autopilot_eval_heldout.json" : "data/autopilot_eval.json");
// the demo player's body log and the sample health export (read the way an upload is)
const club = JSON.parse(fs.readFileSync("../web/public/data/club.json", "utf8"));
const tmp = `/tmp/eval-health-${Date.now()}.zip`; fs.copyFileSync("../web/public/data/sample/serve_sample_health_export.zip", tmp);
const hx = await health.read(tmp, { name: "sample.zip", days: 400 }); fs.rmSync(tmp, { force: true });
const knee = { log: [...club.you.body, { id: "e", at: new Date().toISOString(), part: "knee", side: "right", kind: "pain", level: 3, trigger: "worse after jumping" }], workouts: hx.workouts.map(({ route, ...w }) => w), days: hx.days };
// the next Thursday, in local time (toISOString would give Wednesday's date between midnight and 08:00 in Taipei)
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const thu = (() => { const d = new Date(); do d.setDate(d.getDate() + 1); while (d.getDay() !== 4); return ymd(d); })();
// Each week has its own oracle: rules code checks on the games agreed, beyond "enough games, and the player was asked"
// (every week: at most one game a day, inside the next seven days, not on a day already booked). A week passes only
// if its oracle finds nothing.
const every = (gs, f) => gs.every(f), some = (gs, f) => gs.some(f);
const SCENARIOS = [
  { name: "Two games a week", goal: { perWeek: 2 }, oracle: (gs) => [!every(gs, (g) => g.sport === "badminton") && "not badminton"] },
  { name: "Two games, sore knee (doubles first)", goal: { perWeek: 2 }, you: { limit: "no jump landings" }, oracle: (gs) => [!every(gs, (g) => g.format === "doubles") && "a singles game despite the knee"] },
  { name: "Three games a week", goal: { perWeek: 3 }, oracle: () => [] },
  { name: "Thursday already booked", goal: { perWeek: 2 }, upcoming: [{ date: thu, start: "19:00", with: ["leo"] }], oracle: () => [] },
  { name: "Tennis, one game", goal: { perWeek: 1, sport: "tennis" }, oracle: (gs) => [!every(gs, (g) => g.sport === "tennis") && "not tennis"] },
  // a game with Kenji ran 45 minutes past its booking: Kenji should be one of the partners this week
  { name: "Two games, Kenji just played long", goal: { perWeek: 2 }, history: [{ date: thu, start: "19:00", sport: "badminton", format: "singles", with: ["kenji"], booked: 90, played: 135 }], oracle: (gs) => [!some(gs, (g) => g.partners.some((p) => p.id === "kenji")) && "Kenji not in any game"] },
  // the body log and the watch: a sore knee, a week at twice the usual load (the goal drops by one, doubles, 90 minutes)
  { name: "Sore knee and a heavy week (body log + health app)", goal: { perWeek: 2 }, body: knee, need: 1, oracle: (gs) => [gs.length > 1 && "more than one game in a heavy week", !every(gs, (g) => g.format === "doubles") && "a singles game despite the knee", !every(gs, (g) => g.minutes <= 90) && "a game over 90 minutes"] },
  // memory: the player said weeks ago, in a chat, to leave Tomás out for a while (no calendar entry holds it), among
  // other things they said. Tomás plays at both usual times and is in every game of "Two games a week" without it.
  { name: "Two games, Tomás left out (what the player said)", goal: { perWeek: 2 }, notes: [
    { text: "Got a new racket, the Astrox 88S. Feels great on smashes.", at: "2026-10-02" },
    { text: "Please leave Tomás out of my games for a few weeks. We had a falling out after the league match.", at: "2026-10-12" },
    { text: "My sister's wedding is on 12 December, so that weekend is out.", at: "2026-10-14" },
    { text: "Riverside's courts are slippery when it rains, I'd rather avoid them on wet days.", at: "2026-10-16" },
    { text: "I'm trying to work on my backhand clears this month.", at: "2026-10-18" },
    { text: "Leo's games are always fun, he plays fast.", at: "2026-10-20" },
    { text: "Doubles with Hana went really well last time.", at: "2026-10-22" },
    { text: "Thursday evenings are my favourite time to play.", at: "2026-10-23" },
  ], oracle: (gs) => [some(gs, (g) => g.partners.some((p) => p.id === "tomas")) && "Tomás in a game, though the player asked to leave him out"] },
  // no free club court is cheap for basketball: the agent looks for a public court nearby
  { name: "Basketball, two on two (public courts)", goal: { perWeek: 1, sport: "basketball" }, oracle: (gs) => [!every(gs, (g) => g.sport === "basketball") && "not basketball", !every(gs, (g) => g.venue?.public) && "not on a public court"] },
];
// the held-out weeks, as scenarios: their dates from today (a usual time `weeksAgo` weeks back, a booked game on its
// day in the next seven), and their oracle from its data
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const back = (day, weeksAgo) => { const d = new Date(); do d.setDate(d.getDate() - 1); while (DOW[d.getDay()] !== day); d.setDate(d.getDate() - 7 * (weeksAgo - 1)); return ymd(d); };
const ahead = (day) => { const d = new Date(); while (DOW[d.getDay()] !== day) d.setDate(d.getDate() + 1); return ymd(d); };
const ORACLE = { sport: (v) => (gs) => !every(gs, (g) => g.sport === v) && `not ${v}`, format: (v) => (gs) => !every(gs, (g) => g.format === v) && `a game that is not ${v}`,
  notWith: (v) => (gs) => some(gs, (g) => g.partners.some((p) => p.id === v)) && `${v} in a game, though the player asked to leave them out`, withOneOf: (v) => (gs) => !some(gs, (g) => g.partners.some((p) => p.id === v)) && `${v} not in any game` };
// which games an oracle rejects (for attribution: rule_missed)
const BAD = { sport: (v) => (g) => g.sport !== v, format: (v) => (g) => g.format !== v, notWith: (v) => (g) => g.partners.some((p) => p.id === v), withOneOf: () => () => false };
const asScenario = (w) => ({ name: w.name, goal: w.goal, you: w.you, need: w.need, upcoming: (w.upcoming || []).map((u) => ({ date: ahead(u.day), start: u.start, with: u.with })),
  history: (w.history || []).map(({ weeksAgo, day, ...h }) => ({ date: back(day, weeksAgo), ...h })), notes: (w.notes || []).map((n) => ({ text: n.text, at: ymd(new Date(Date.now() - n.daysAgo * 864e5)) })),
  oracle: (gs) => w.oracle.map((o) => { const [k, v] = Object.entries(o)[0]; return ORACLE[k](v)(gs); }), bad: (gs) => gs.filter((g) => w.oracle.some((o) => { const [k, v] = Object.entries(o)[0]; return BAD[k](v)(g); })) });
const WEEKS = HELD ? HELD.weeks.map(asScenario) : SCENARIOS;
const week = (() => { const d0 = new Date(); return Array.from({ length: 7 }, (_, i) => { const d = new Date(d0); d.setDate(d.getDate() + i); return ymd(d); }); })();
function judge(s, gs) {
  const days = gs.map((g) => g.date), booked = (s.upcoming || []).map((u) => u.date);
  return [new Set(days).size !== days.length && "two games on one day", days.some((d) => !week.includes(d)) && "a game outside the next seven days", days.some((d) => booked.includes(d)) && "a game on a day already booked", ...(s.oracle ? s.oracle(gs) : [])].filter(Boolean);
}
// EVAL_ONLY="Three games a week" runs the weeks whose name has it, EVAL_REPEAT=3 each of them that many times
const ONLY = process.env.EVAL_ONLY || "", REPEAT = +(process.env.EVAL_REPEAT || 1);
const rows = [], T0 = Date.now();
// the failure attribution of a run that missed (or that the rules finished), from its trace; and the cause of every
// talk in it that ended without a game. The steps go with it, for the hand check
function attributionOf(s, r, need) {
  if (!r?.report?.trace) return {};
  const sp = tracing.spans({ trace: r.report.trace });
  const bad = s.bad ? s.bad(r.agreed) : judge(s, r.agreed).length ? r.agreed : [];
  const a = attribute(sp, { badGames: bad.map((g) => `${g.day} ${g.start}`) });
  const talks = sp.filter((x) => x.name === "invoke_agent talk" && x.attributes?.["serve.agreed"] === false).map((t) => { const c = talkCause(sp, t); return { talk: t.attributes["gen_ai.conversation.id"], reason: t.attributes["serve.reason"], kind: c.kind, what: c.what }; });
  const missed = r.agreed.length < need || judge(s, r.agreed).length > 0;
  return { badGames: bad.map((g) => `${g.day} ${g.start}`), attribution: a ? { kind: a.kind, step: a.step, tool: a.tool, line: a.line, recovered: a.recovered } : null, failedTalks: talks, ...(missed || r.report.rules ? { trail: r.trail.map((t, k) => ({ k: k + 1, name: t.name, by: t.by, args: t.args })) } : {}) };
}
for (const s of WEEKS.filter((x) => x.name.includes(ONLY)).flatMap((x) => Array(REPEAT).fill(x))) {
  const msgs = [], steps = [];
  const t0 = Date.now();
  let r, err = null;
  try {
    // each run starts with nothing held: the player said no to the run before (its games are never booked)
    play.clearLeases();
    r = await run({ you: { weak: "rear forehand", ...(s.you || {}) }, notes: (s.notes || []).map((n) => ({ ...n, at: new Date(n.at).getTime() })), goal: s.goal, upcoming: s.upcoming || [], history: s.history || [], body: s.body || null, onStep: (e) => (e.type === "a2a" ? msgs : steps).push(e) });
  } catch (e) { err = String(e.message || e); }
  // (a held-out week: the goal, less the games booked, less one when its history makes a week over 1.5 times the usual
  // load, by the same rule code applies (body.js organize), worked out here from the week itself)
  const need = HELD ? Math.max(0, Math.max(1, s.goal.perWeek + organize({ log: [], workouts: [], days: [], games: [...club.you.history, ...s.history], now: new Date() }).plan.perWeekDelta) - (s.upcoming?.length || 0))
    : s.need ?? Math.max(0, (s.goal.perWeek || 2) - (s.upcoming?.length || 0));
  const counters = msgs.filter((m) => m.intent === "counter");
  const row = {
    scenario: s.name, needed: need, agreed: r?.agreed.length ?? 0, oracle: r ? judge(s, r.agreed) : ["no run"], finishedBy: r ? (r.report.rules ? "rules" : "model") : null,
    success: !!r && r.agreed.length >= need && (need === 0 || !!r.approval) && !judge(s, r.agreed).length,
    seconds: r?.report.seconds ?? +((Date.now() - t0) / 1000).toFixed(1), modelCalls: r?.report.modelCalls ?? null, toolCalls: r?.report.toolCalls ?? null, parallelPeak: r?.report.parallelPeak ?? null,
    refused: r?.report.refused ?? null, stopsRefused: r?.report.stopsRefused ?? null, failedNegotiations: steps.filter((x) => x.tool === "negotiate" && /no deal/.test(x.detail || "")).length, counters: counters.length, countersThatDidNotFit: counters.filter((m) => m.checked === false).length,
    ...attributionOf(s, r, need),
    tokens: r?.report.tokens ?? null, agentsThatDidNotAnswer: msgs.filter((m) => m.intent === "none").length, quickAnswers: msgs.filter((m) => m.tier === "quick").length, fullAnswers: msgs.filter((m) => m.tier === "agent").length,
    agentMessages: msgs.length, rulesTookOver: r?.report.rules ?? null, tools: [...new Set(steps.filter((x) => x.tool && !["goal", "report", "memory", "verify", "a2a"].includes(x.tool)).map((x) => x.tool))], games: (r?.agreed || []).map((o) => `${o.sport} ${o.format} ${o.day} ${o.start} with ${o.partners.map((p) => p.name.split(" ")[0]).join(", ")}`), summary: r?.summary, error: err,
    align: r?.report.align ?? null, // the goal check before request_approval (src/align.js), when it is on
  };
  rows.push(row);
  console.log(JSON.stringify(row));
  fs.writeFileSync(OUT, JSON.stringify(rows, null, 1));
}
const ok = rows.filter((x) => x.success).length, mean = (k) => +(rows.reduce((a, x) => a + (x[k] || 0), 0) / rows.length).toFixed(1);
console.log(`\n${ok} of ${rows.length} reached the goal · mean ${mean("seconds")} s · ${mean("modelCalls")} model calls · ${mean("toolCalls")} tool calls · peak ${Math.max(...rows.map((x) => x.parallelPeak || 0))} at once`);
// the numbers the About page shows (web/public/data/agent_eval.json)
// with EVAL_REPEAT=k: pass^k, the share of weeks that reached the goal on every one of their k runs (as in tau-bench:
// how reliably, not how often), next to pass^1, the share of all runs that did
const byWeek = Object.values(rows.reduce((a, x) => ((a[x.scenario] ||= []).push(x), a), {}));
const passK = REPEAT > 1 ? { k: REPEAT, weeks: byWeek.length, passK: +(byWeek.filter((xs) => xs.every((x) => x.success)).length / byWeek.length).toFixed(3), pass1: +(ok / rows.length).toFixed(3) } : null;
if (passK) console.log(`pass^${REPEAT} ${passK.passK} (${byWeek.filter((xs) => xs.every((x) => x.success)).length} of ${byWeek.length} weeks every time) · pass^1 ${passK.pass1}`);
fs.writeFileSync(OUT.replace(/\.json$/, "_summary.json"), JSON.stringify({ at: new Date().toISOString(), weeks: SET, ...(HELD ? { heldoutSeed: HELD.seed, club: HELD.club } : {}), transport: a2aOn() ? "a2a" : "in-process", runs: rows.length, ok, byModel: { runs: rows.filter((x) => x.finishedBy === "model").length, ok: rows.filter((x) => x.finishedBy === "model" && x.success).length }, oracleFailures: rows.filter((x) => x.oracle?.length).length, ...(passK ? { passK } : {}), seconds: mean("seconds"), modelCalls: mean("modelCalls"), toolCalls: mean("toolCalls"), peak: Math.max(...rows.map((x) => x.parallelPeak || 0)), refused: rows.reduce((a, x) => a + (x.refused || 0), 0), rules: rows.filter((x) => x.rulesTookOver).length, passKByModel: REPEAT > 1 ? +(byWeek.filter((xs) => xs.every((x) => x.success && x.finishedBy === "model")).length / byWeek.length).toFixed(3) : null, attribution: rows.filter((x) => x.attribution).reduce((a, x) => ((a[x.attribution.kind] = (a[x.attribution.kind] || 0) + 1), a), {}), failedTalks: rows.reduce((a, x) => a + (x.failedTalks?.length || 0), 0) }, null, 1));
// the token ledger over the whole run, per call site
const all = ledger.calls(100000).filter((c) => c.at >= T0);
fs.writeFileSync(OUT.replace(/\.json$/, "_tokens.json"), JSON.stringify({ at: new Date().toISOString(), label: process.env.EVAL_LABEL || "", budgets: BUDGETS, total: ledger.totals(all), perWeek: rows.map((x) => ({ scenario: x.scenario, success: x.success, seconds: x.seconds, ...x.tokens })), bySite: ledger.bySite(all) }, null, 1));
const tt = ledger.totals(all);
console.log(`tokens: ${tt.prompt} read (${Math.round(tt.cachedShare * 100)}% cached), ${tt.output} written (${tt.reasoning} reasoning), ${tt.empty} empty replies, ${tt.invalid} invalid`);
if (a2aServer) { a2aServer.closeAllConnections(); a2aServer.close(); }
// (the embedder and the guard workers are child processes: the run ends here, its files written)
(await import("../src/memory.js")).close();
process.exit(0);

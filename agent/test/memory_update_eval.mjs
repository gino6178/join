// Notes that can be updated and partly forgotten (memory.js, memory_update.js), measured on Muse Glimmer and DRAMA on
// the server, against the append-only notes Serve had (MEMORY_CONSOLIDATE=off). Simulated notes only.
//   1. Update chains (20): a few notes over weeks, the way a player says them ("leave Tomás out" ... "Tomás is fine
//      again"), each among six unrelated notes. At given days: which notes are live and which were replaced or have
//      expired; whether the question an agent asks while planning gets the newest note and not the stale one (top 4,
//      as get_week's fromMemory); and the rule the Autopilot keeps (a member left out, a weekday off, or none). Plus
//      chains that must NOT replace anything (a note on the same person or day that changes nothing).
//   2. Forgetting by person or topic (4 chains): what "forget what I said about X" deletes, against what it should
//      (precision, recall); the old /forget could only delete every note.
//   3. End to end: the Autopilot plans a week of two games (as test/autopilot_eval.mjs, the demo club, where Tomás is
//      in every plan unless told otherwise), after four chains, three runs each, both arms: Tomás left out (control);
//      left out, then "he's fine again"; left out, then forgotten; left out until a day that has passed.
//   node test/memory_update_eval.mjs [out.json]      MEMUPD_PARTS=chains,forget,autopilot  MEMUPD_RUNS=3
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "serve_memupd_"));
for (const [k, v] of Object.entries({ MEMORY_FILE: `${tmp}/memory.json`, A2A_FILE: `${tmp}/a2a.json`, AUTOPILOT_FILE: `${tmp}/autopilot.json`, LEDGER_FILE: `${tmp}/ledger.jsonl`, NEGOTIATIONS_FILE: `${tmp}/neg.json`,
  TRACE_FILE: `${tmp}/traces.jsonl`, ASK_FILE: `${tmp}/asks.json`, BOOKINGS_FILE: `${tmp}/bookings.json`, MATCH_RECORDS_FILE: `${tmp}/records.json`, MATCH_AUDIT_FILE: `${tmp}/audit.json`, MATCH_STATE_FILE: `${tmp}/mstate.json`,
  DISCLOSURE_FILE: `${tmp}/disclosure.json`, PREFS_FILE: `${tmp}/prefs.json`, A2A_TRANSPORT: "local", A2A_LEASE: "off" })) process.env[k] ||= v;
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), "../..");
const OUT = process.argv[2] || path.join(ROOT, "submission/results/memory_update_eval.json"), RUNS = +(process.env.MEMUPD_RUNS || 3);
const PARTS = (process.env.MEMUPD_PARTS || "chains,forget,autopilot").split(",");
const memory = await import("../src/memory.js");
const ledger = await import("../src/ledger.js");
const t0 = Date.now();
const at = (d) => new Date(`${d}T10:00:00`).getTime();
const OTHER = ["Got new strings in my racket, they feel crisp.", "The parking near the stadium is a nightmare.", "I watched the world tour final on Sunday night.", "My water bottle went missing at the hall.",
  "The new club shirts look good.", "I've been doing footwork drills at home."];

// [notes as [text, day said]], then checks at given days: live / gone (substrings), the question and the note it
// should find (fresh) and not (stale), the rule (null: none; "any": not checked)
const CHAINS = [
  { name: "a member back after a falling out", notes: [["Please leave Tomás out of my games for a few weeks, we had a falling out.", "2026-10-01"], ["Tomás and I talked it out, he's fine again. Put him back in my games.", "2026-10-20"]],
    checks: [{ at: "2026-10-10", live: ["leave Tomás out"], rule: { kind: "avoid_person", who: "tomas" } }, { at: "2026-10-21", live: ["fine again"], gone: ["leave Tomás out"], q: "Is there anyone the player does not want to play with right now?", fresh: "fine again", stale: "leave Tomás out", rule: null }] },
  { name: "a member left out until a date", notes: [["Leave Tomás out of my games until 20 October.", "2026-10-05"]],
    checks: [{ at: "2026-10-12", live: ["until 20 October"], rule: { kind: "avoid_person", who: "tomas" } }, { at: "2026-10-28", gone: ["until 20 October"], rule: null }] },
  { name: "a weekday off until the end of the month", notes: [["Fridays are out for me until the end of October, I have evening classes.", "2026-10-03"]],
    checks: [{ at: "2026-10-20", live: ["Fridays are out"], rule: { kind: "avoid_day", day: "Fri" } }, { at: "2026-11-05", gone: ["Fridays are out"], rule: null }] },
  { name: "a weekend preference that changed", notes: [["Saturday mornings are my favourite time to play.", "2026-09-10"], ["I've switched to Sunday mornings now, on Saturdays I coach kids.", "2026-10-15"]],
    checks: [{ at: "2026-10-16", live: ["Sunday mornings"], gone: ["Saturday mornings are my favourite"], q: "When does the player like to play at weekends?", fresh: "Sunday mornings", stale: "Saturday mornings are my favourite", rule: "any" }] },
  { name: "a doubles partner who moved away", notes: [["Doubles with Hana went really well, let's team up again.", "2026-09-20"], ["Hana moved to another city, she won't be playing at the club anymore.", "2026-10-18"]],
    checks: [{ at: "2026-10-19", live: ["Hana moved"], gone: ["team up again"], q: "Who does the player enjoy doubles with?", fresh: "Hana moved", stale: "team up again", rule: "any" }] },
  { name: "a venue that got better", notes: [["Riverside's courts get slippery when it rains, I'd rather avoid them.", "2026-09-05"], ["Riverside redid their floors, the courts are great now.", "2026-10-12"]],
    checks: [{ at: "2026-10-13", live: ["redid their floors"], gone: ["slippery"], q: "Should the agent avoid any venue?", fresh: "redid their floors", stale: "slippery", rule: null }] },
  { name: "a knee that healed", notes: [["My knee hurts, keep my games to an hour for now.", "2026-10-01"], ["My knee is fully healed, full-length games are fine again.", "2026-10-22"]],
    checks: [{ at: "2026-10-23", live: ["fully healed"], gone: ["knee hurts"], q: "Should games be kept short?", fresh: "fully healed", stale: "knee hurts", rule: null }] },
  { name: "a court budget that went up", notes: [["I don't want to pay more than 300 dollars for a court.", "2026-09-01"], ["I can go up to 500 dollars for a court now.", "2026-10-05"]],
    checks: [{ at: "2026-10-06", live: ["up to 500"], gone: ["more than 300"], q: "How much will the player pay for a court?", fresh: "up to 500", stale: "more than 300", rule: null }] },
  { name: "a trip that ends", notes: [["I'm in Tokyo for work from 3 to 7 November, no games that week.", "2026-10-25"]],
    checks: [{ at: "2026-10-30", live: ["Tokyo"], rule: "any" }, { at: "2026-11-12", gone: ["Tokyo"], rule: null }] },
  { name: "a weekday that came back, and another that went", notes: [["No games on Wednesdays, I pick my daughter up from swimming.", "2026-09-15"], ["Swimming moved to Thursdays, so Wednesdays are free again and Thursdays are out.", "2026-10-12"]],
    checks: [{ at: "2026-09-20", live: ["No games on Wednesdays"], rule: { kind: "avoid_day", day: "Wed" } }, { at: "2026-10-13", live: ["Swimming moved"], gone: ["No games on Wednesdays"], q: "Which weekday can the player not play?", fresh: "Swimming moved", stale: "No games on Wednesdays", rule: { kind: "avoid_day", day: "Thu" } }] },
  { name: "two members out, one back", notes: [["Leave Tomás and Yuki out of my games for now.", "2026-10-01"], ["Yuki apologised, she's fine again. Tomás is still out.", "2026-10-20"]],
    checks: [{ at: "2026-10-21", live: ["Yuki apologised"], gone: ["Tomás and Yuki out"], rule: { kind: "avoid_person", who: "tomas" } }] },
  { name: "a member who became reliable", notes: [["Ravi cancels a lot, I'd rather not book games with him.", "2026-09-01"], ["Ravi has been reliable lately, give him another chance.", "2026-10-20"]],
    checks: [{ at: "2026-09-10", live: ["Ravi cancels"], rule: { kind: "avoid_person", who: "ravi" } }, { at: "2026-10-21", live: ["another chance"], gone: ["Ravi cancels"], q: "Is there a member the player avoids booking with?", fresh: "another chance", stale: "Ravi cancels", rule: null }] },
  { name: "late nights, then an earlier train", notes: [["I can stay out until 23:00 on weeknights.", "2026-09-01"], ["New job: I need to be home by 21:30 on work nights now.", "2026-10-10"]],
    checks: [{ at: "2026-10-11", live: ["home by 21:30"], gone: ["until 23:00"], q: "How late can the player stay out on weeknights?", fresh: "home by 21:30", stale: "until 23:00", rule: "any" }] },
  { name: "singles to doubles", notes: [["I only want singles games this season.", "2026-09-01"], ["I'm done with singles for now, doubles only from here on.", "2026-10-08"]],
    checks: [{ at: "2026-10-09", live: ["doubles only"], gone: ["only want singles"], q: "Does the player want singles or doubles?", fresh: "doubles only", stale: "only want singles", rule: null }] },
  // must not replace: a newer note on the same person or day that changes nothing
  { name: "the same member, nothing changed", notes: [["Leave Tomás out of my games for a few weeks.", "2026-10-01"], ["Tomás showed me his new racket at the club.", "2026-10-10"]],
    checks: [{ at: "2026-10-11", live: ["Leave Tomás out", "new racket"], rule: { kind: "avoid_person", who: "tomas" } }] },
  { name: "two partners, both kept", notes: [["Kenji always pushes me, I'd like to play him more.", "2026-10-01"], ["Leo's games are always fun, he plays fast.", "2026-10-09"]],
    checks: [{ at: "2026-10-10", live: ["Kenji always pushes", "Leo's games"], rule: null }] },
  { name: "the same day, a second reason", notes: [["No games on Fridays, I have a class.", "2026-10-01"], ["Friday evenings are also when my band rehearses.", "2026-10-12"]],
    checks: [{ at: "2026-10-13", live: ["No games on Fridays"], rule: { kind: "avoid_day", day: "Fri" } }] },
  { name: "a goal and a drill", notes: [["I'm trying to fix my backhand clears this month.", "2026-10-01"], ["Smash practice with a coach on Tuesdays has been great.", "2026-10-11"]],
    checks: [{ at: "2026-10-12", live: ["backhand clears", "Smash practice"], rule: null }] },
  { name: "the same thing twice", notes: [["I need to be home by 22:00 on work nights.", "2026-09-01"], ["On weeknights I have to be home by ten.", "2026-10-09"]],
    checks: [{ at: "2026-10-10", q: "How late can the player stay out on weeknights?", fresh: "home by", rule: "any" }] },
  { name: "a member to play more, then less", notes: [["I'd like to play Sam more often, our games are close.", "2026-09-05"], ["Please don't put me with Sam for a while, our last game got heated.", "2026-10-16"]],
    checks: [{ at: "2026-10-17", live: ["don't put me with Sam"], gone: ["play Sam more"], q: "Is there anyone the player does not want to play with right now?", fresh: "don't put me with Sam", stale: "play Sam more", rule: { kind: "avoid_person", who: "sam" } }] },
];
const FORGETS = [
  { name: "a member", notes: [["Please leave Tomás out of my games for a few weeks.", "2026-10-01"], ["Tomás and I made up, he's fine again.", "2026-10-20"], ["Kenji always pushes me.", "2026-10-05"], ["I'm working on my backhand clears.", "2026-10-07"], ["Riverside's courts are slippery in the rain.", "2026-10-08"]],
    forget: "what I said about Tomás", deleted: ["leave Tomás out", "made up"], kept: ["Kenji", "backhand", "Riverside"] },
  { name: "a place", notes: [["Riverside's courts are slippery in the rain.", "2026-10-01"], ["Riverside has the cheapest courts in town.", "2026-10-03"], ["Kenji always pushes me.", "2026-10-05"], ["Doubles with Hana went well.", "2026-10-07"], ["Midtown's lights are the best.", "2026-10-08"]],
    forget: "Riverside", deleted: ["slippery", "cheapest"], kept: ["Kenji", "Hana", "Midtown"] },
  { name: "a body part", notes: [["My knee hurts after jumping, keep games short.", "2026-10-01"], ["My knee feels better if I stop after an hour.", "2026-10-04"], ["Kenji always pushes me.", "2026-10-05"], ["I'm in Tokyo from 3 to 7 November.", "2026-10-07"], ["My shoulder is fine.", "2026-10-08"]],
    forget: "my knee", deleted: ["knee hurts", "knee feels"], kept: ["Kenji", "Tokyo", "shoulder"] },
  { name: "a weekday", notes: [["No games on Fridays, I have a class.", "2026-10-01"], ["Friday evenings at Midtown were fun last month.", "2026-10-03"], ["Leo's games are always fun.", "2026-10-05"], ["My sister's wedding is on 12 December.", "2026-10-07"], ["Sunday afternoons are usually free.", "2026-10-08"]],
    forget: "Fridays", deleted: ["No games on Fridays", "Friday evenings"], kept: ["Leo", "wedding", "Sunday"] },
];

const has = (list, sub) => list.find((n) => n.text.includes(sub));
let player = 0;
async function load(notes, P) {
  for (const [i, t] of OTHER.entries()) await memory.remember(P, [{ text: t, kind: "said", at: at("2026-08-01") + i * 864e5 }], { now: at("2026-08-01") + i * 864e5 });
  for (const [t, d] of notes) await memory.remember(P, [{ text: t, kind: "said", at: at(d) }], { now: at(d) });
}
async function chainsArm(arm) {
  process.env.MEMORY_CONSOLIDATE = arm === "consolidate" ? "on" : "off";
  const rows = [];
  for (const c of CHAINS) {
    const P = `chain-${arm}-${++player}`;
    await load(c.notes, P);
    for (const k of c.checks) {
      const now = at(k.at), ls = memory.list(P, now), live = (s) => { const n = has(ls, s); return n && (n.status || "live") === "live"; };
      const labels = [...(k.live || []).map((s) => ({ s, want: true, got: !!live(s) })), ...(k.gone || []).map((s) => ({ s, want: false, got: !!live(s) }))];
      let found = null;
      if (k.q) { const r = await memory.recall(P, k.q, { k: 4, now }); found = { fresh: r.notes.some((n) => n.note.includes(k.fresh)), stale: k.stale ? r.notes.some((n) => n.note.includes(k.stale)) : false, top: r.notes.map((n) => n.note.slice(0, 50)) }; }
      const rules = memory.rules(P, now).map((x) => ({ kind: x.kind, ...(x.who ? { who: x.who } : {}), ...(x.day ? { day: x.day } : {}) }));
      const ruleOk = k.rule === "any" ? null : k.rule === null ? rules.length === 0 : rules.length === 1 && rules[0].kind === k.rule.kind && (rules[0].who || rules[0].day) === (k.rule.who || k.rule.day);
      rows.push({ chain: c.name, at: k.at, labels, found, rules, ruleOk, notes: ls.filter((n) => !OTHER.includes(n.text)).map((n) => ({ text: n.text.slice(0, 60), status: n.status, ...(n.until ? { until: n.until } : {}), ...(n.checked?.refused ? { refused: n.checked.refused } : {}) })) });
    }
  }
  const L = rows.flatMap((r) => r.labels), q = rows.filter((r) => r.found), rr = rows.filter((r) => r.ruleOk != null);
  const summary = { arm, chains: CHAINS.length, checks: rows.length,
    statusCorrect: +(L.filter((l) => l.got === l.want).length / L.length).toFixed(3), labels: L.length,
    staleKeptLive: L.filter((l) => !l.want && l.got).length, staleShouldGo: L.filter((l) => !l.want).length, wronglyReplaced: L.filter((l) => l.want && !l.got).length, shouldStay: L.filter((l) => l.want).length,
    questions: q.length, newestFound: +(q.filter((r) => r.found.fresh).length / q.length).toFixed(3), staleFound: +(q.filter((r) => r.found.stale).length / q.length).toFixed(3), newestOnly: +(q.filter((r) => r.found.fresh && !r.found.stale).length / q.length).toFixed(3),
    rulesChecked: rr.length, rulesCorrect: +(rr.filter((r) => r.ruleOk).length / rr.length).toFixed(3) };
  console.log(JSON.stringify(summary));
  return { summary, rows };
}
async function forgetArm(arm) {
  process.env.MEMORY_CONSOLIDATE = "on";
  const rows = [];
  for (const f of FORGETS) {
    const P = `forget-${arm}-${++player}`;
    await load(f.notes, P);
    const before = memory.list(P).map((n) => n.text);
    if (arm === "forget about") await memory.forgetAbout(P, f.forget); else memory.forget(P); // the old /forget: everything
    const after = memory.list(P).map((n) => n.text), gone = before.filter((t) => !after.includes(t));
    const should = before.filter((t) => f.deleted.some((s) => t.includes(s)));
    rows.push({ name: f.name, forget: f.forget, deleted: gone, shouldDelete: should, tp: gone.filter((t) => should.includes(t)).length, fp: gone.filter((t) => !should.includes(t)).length, fn: should.filter((t) => !gone.includes(t)).length, keptOk: f.kept.every((s) => after.some((t) => t.includes(s))) });
  }
  const tp = rows.reduce((a, r) => a + r.tp, 0), fp = rows.reduce((a, r) => a + r.fp, 0), fn = rows.reduce((a, r) => a + r.fn, 0);
  const summary = { arm, chains: rows.length, precision: +(tp / Math.max(1, tp + fp)).toFixed(3), recall: +(tp / Math.max(1, tp + fn)).toFixed(3), deleted: tp + fp, shouldDelete: tp + fn, othersKept: rows.filter((r) => r.keptOk).length };
  console.log(JSON.stringify(summary));
  return { summary, rows };
}

// ---- 3. the Autopilot's week after each chain ----
async function autopilotPart() {
  const { run } = await import("../src/autopilot.js");
  const play = await import("../src/play.js");
  const day = (k) => { const d = new Date(); d.setDate(d.getDate() + k); return d; }, ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const MON = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"], spoken = (d) => `${d.getDate()} ${MON[d.getMonth()]}`;
  const OUT_NOTE = "Please leave Tomás out of my games for a few weeks. We had a falling out after the league match.";
  const extra = [["Doubles with Hana went really well last time.", -9], ["Thursday evenings are my favourite time to play.", -8], ["I'm trying to work on my backhand clears this month.", -12]];
  // what the player says, in order, and whether Tomás should be in the week's games
  const WEEKS = [
    { name: "left out (control)", steps: [["say", OUT_NOTE, -16]], tomas: false },
    { name: "left out, then fine again", steps: [["say", OUT_NOTE, -16], ["say", "Tomás and I talked it out, he's fine again. Put him back in my games.", -2]], tomas: true },
    { name: "left out, then forgotten", steps: [["say", OUT_NOTE, -16], ["forget", "forget what I said about Tomás", -1]], tomas: true },
    { name: "left out until a day that has passed", steps: [["say", `Leave Tomás out of my games until ${spoken(day(-3))}, we need a break.`, -16]], tomas: true },
  ];
  const rows = [];
  for (const arm of ["consolidate", "append-only"]) for (const w of WEEKS) for (let k = 0; k < RUNS; k++) {
    process.env.MEMORY_CONSOLIDATE = arm === "consolidate" ? "on" : "off";
    const P = `ap-${arm}-${++player}`;
    for (const [t, d] of extra) await memory.remember(P, [{ text: t, kind: "said", at: day(d).getTime() }], { now: day(d).getTime() });
    for (const [kind, t, d] of w.steps) {
      // the old memory has no "forget about": what the player said is kept as one more note, as it was
      if (kind === "forget" && arm === "consolidate") await memory.forgetAbout(P, t.replace(/^forget what I said about /i, ""));
      else await memory.remember(P, [{ text: t, kind: "said", at: day(d).getTime() }], { now: day(d).getTime() });
    }
    play.clearLeases?.();
    const steps = [], s0 = Date.now();
    let r = null, err = null;
    try { r = await run({ you: { weak: "rear forehand" }, goal: { perWeek: 2 }, player: P, onStep: (e) => e.type !== "a2a" && steps.push(e) }); } catch (e) { err = String(e.message || e); }
    const games = r?.agreed || [], withTomas = games.some((g) => g.partners.some((p) => p.id === "tomas"));
    const row = { arm, week: w.name, run: k + 1, tomasExpected: w.tomas, withTomas, correct: !!r && games.length > 0 && withTomas === w.tomas, games: games.map((g) => `${g.format} ${g.day} ${g.start} with ${g.partners.map((p) => p.id).join("+")}`),
      rules: steps.filter((x) => x.tool === "memory" && /Followed/.test(x.step || "")).map((x) => x.detail), seconds: +((Date.now() - s0) / 1000).toFixed(1), error: err, finishedBy: r ? (r.report.rules ? "rules" : "model") : null };
    rows.push(row); console.log(JSON.stringify(row));
  }
  const by = (arm) => { const rs = rows.filter((r) => r.arm === arm); return { arm, runs: rs.length, correct: rs.filter((r) => r.correct).length, byWeek: Object.fromEntries(WEEKS.map((w) => [w.name, `${rs.filter((r) => r.week === w.name && r.correct).length}/${rs.filter((r) => r.week === w.name).length}`])) }; };
  return { summary: [by("consolidate"), by("append-only")], rows };
}

const out = { at: new Date().toISOString(), embed: memory.how(), model: process.env.LLM_MODEL || "muse-glimmer", llm: process.env.LLM_URL || null };
if (PARTS.includes("chains")) out.chains = { consolidate: await chainsArm("consolidate"), appendOnly: await chainsArm("append-only") };
if (PARTS.includes("forget")) out.forget = { forgetAbout: await forgetArm("forget about"), forgetAll: await forgetArm("forget all") };
const calls = ledger.calls(100000).filter((c) => c.site === "memory.update" && c.at >= t0);
out.updateCalls = { calls: calls.length, ...ledger.totals(calls) };
if (PARTS.includes("autopilot")) out.autopilot = await autopilotPart();
out.seconds = +((Date.now() - t0) / 1000).toFixed(1);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
memory.close(); fs.rmSync(tmp, { recursive: true, force: true });
console.log(`wrote ${OUT} in ${out.seconds} s`);
process.exit(0);

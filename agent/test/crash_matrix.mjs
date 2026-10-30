// Crash and resume, at every durable step, deterministically. For each crash point (src/crash.js) the real gateway is
// started with CRASH_AT=<point> against a stand-in model (test/fake_model.mjs), the player says yes to "want a game?",
// the gateway kills itself (SIGKILL) at that point, and is started again. Then:
//   the question ends booked, its outbox empty, and the game is booked exactly once;
//   every A2A message was decided by the model at most once (one that was answered before the crash is answered again
//   from the saved answer, without the model).
// No GPU or model needed:  node test/crash_matrix.mjs
import fs from "node:fs";
import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import { fakeModel } from "./fake_model.mjs";
// the model's own answers are what this tests: code does not answer the calendar's questions for it
process.env.A2A_ROUTE ||= "off"; process.env.A2A_STUDENT ||= "off";

const POINTS = ["round-saved", "answer-saved", "talk-done", "settled", "booked"];
const PORT = +(process.env.CRASH_PORT || 18793), B = `http://127.0.0.1:${PORT}`, TOKEN = "crash-" + crypto.randomUUID().slice(0, 8), AUTH = { authorization: `Bearer ${TOKEN}` };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const fails = [], expect = (c, what) => { console.log(`  ${c ? "PASS" : "FAIL"} ${what}`); if (!c) fails.push(what); };

const model = await fakeModel();
// CRASH_ONLY=ask|request|autopilot runs one part (all three by default)
const only = (part) => !process.env.CRASH_ONLY || process.env.CRASH_ONLY.split(",").includes(part);
for (const point of only("ask") ? POINTS : []) {
  console.log(`\ncrash at ${point}`);
  const D = `data/crash-${point}`;
  fs.rmSync(D, { recursive: true, force: true }); fs.mkdirSync(D, { recursive: true });
  const env = { ...process.env, PORT: String(PORT), WEBHOOK_PORT: "0", MESSENGER_PAGE_TOKEN: "", LLM_URL: model.url, LLM_API: "ollama", STORE_FILE: `${D}/players.json`, BOOKINGS_FILE: `${D}/bookings.json`,
    AUTOPILOT_FILE: `${D}/autopilot.json`, A2A_FILE: `${D}/a2a.json`, ASK_FILE: `${D}/asks.json`, NEGOTIATIONS_FILE: `${D}/negotiations.json`, A2A_DATA: D, LEDGER_FILE: `${D}/ledger.jsonl`,
    TRACE_FILE: `${D}/traces.jsonl`, MESSENGER_SEEN_FILE: `${D}/seen.json`, A2A_BASE: B, AGENT_TOKEN: TOKEN };
  const start = (crash) => {
    const gw = spawn(process.execPath, ["src/server.js"], { env: { ...env, ...(crash ? { CRASH_AT: crash } : {}) }, stdio: ["ignore", "pipe", "pipe"] });
    gw.stdout.on("data", () => {}); gw.stderr.on("data", (d) => /crash at/.test(d) && process.stdout.write(`  [gateway] ${d}`));
    return gw;
  };
  const up = async () => { for (let i = 0; i < 60; i++) { try { await fetch(`${B}/api/status`); return; } catch { await wait(250); } } throw new Error("the gateway did not start"); };
  const before = model.asked.decisions;
  let gw = start(point);
  await up();
  const q = await fetch(`${B}/api/ask/next`, { method: "POST", headers: { "content-type": "application/json", ...AUTH }, body: JSON.stringify({ ahead: 7, body: { log: [], workouts: [], days: [] } }) }).then((r) => r.json());
  if (!q.id) { expect(false, `the Match helper asked (${q.none || q.error})`); gw.kill("SIGKILL"); continue; }
  const exited = new Promise((ok) => gw.on("exit", ok));
  await fetch(`${B}/api/ask/answer`, { method: "POST", headers: { "content-type": "application/json", ...AUTH }, body: JSON.stringify({ id: q.id, choice: "yes" }) }).then((r) => r.text()).catch(() => null);
  const crashed = await Promise.race([exited.then(() => true), wait(15000).then(() => false)]);
  expect(crashed, `the gateway died at ${point}`);
  if (!crashed) gw.kill("SIGKILL");
  // the answers kept, and the decisions made, before the restart
  const answersBefore = Object.keys(readJson(`${D}/a2a_answers.json`, {})).length;
  gw = start(null);
  await up();
  // the restart finishes what was cut off (the outbox, then talks still working)
  let a;
  for (let i = 0; i < 80; i++) { a = readJson(`${D}/asks.json`, { asks: {} }).asks[q.id]; if (a && a.status !== "talking" && !a.outbox) break; await wait(250); }
  const bookings = readJson(`${D}/bookings.json`, { bookings: [] }).bookings.filter((b) => !b.cancelled);
  const answers = readJson(`${D}/a2a_answers.json`, {}), ids = Object.keys(answers);
  const decided = model.asked.decisions - before;
  expect(a?.status === "booked" && !a.outbox, `the question ends booked, with nothing left in its outbox (${a?.status}${a?.outbox ? ", outbox still full" : ""})`);
  expect(bookings.length === 1, `the game is booked exactly once (${bookings.length})`);
  expect(decided === ids.length, `every A2A message was decided once (${decided} model decisions, ${ids.length} messages${answersBefore ? `, ${answersBefore} answered before the crash` : ""})`);
  gw.kill("SIGKILL");
  await wait(300);
}
// "I want to play" (match/flow.js, docs/agent_matchmaking_plan.md 12.8): the same, for a free-text request, crashed at
// each of its own durable steps (the request saved; the agents' estimates checkpointed; the result in the outbox) and at
// the talk's (a round saved, an answer saved, the talk done). After the restart the request ends with the game as a
// question, its outbox empty; no member's agent was asked for an estimate twice; every A2A message was decided once;
// no hold is left but the agreed game's; and the player's yes books it exactly once.
const REQUEST_POINTS = ["request-saved", "request-ranked", "round-saved", "answer-saved", "talk-done", "request-settled"];
for (const point of only("request") ? REQUEST_POINTS : []) {
  console.log(`\nI want to play, crash at ${point}`);
  const D = `data/crash-request-${point}`;
  fs.rmSync(D, { recursive: true, force: true }); fs.mkdirSync(D, { recursive: true });
  const env = { ...process.env, PORT: String(PORT), WEBHOOK_PORT: "0", MESSENGER_PAGE_TOKEN: "", LLM_URL: model.url, LLM_API: "ollama", STORE_FILE: `${D}/players.json`, BOOKINGS_FILE: `${D}/bookings.json`,
    AUTOPILOT_FILE: `${D}/autopilot.json`, A2A_FILE: `${D}/a2a.json`, ASK_FILE: `${D}/asks.json`, NEGOTIATIONS_FILE: `${D}/negotiations.json`, A2A_DATA: D, LEDGER_FILE: `${D}/ledger.jsonl`,
    TRACE_FILE: `${D}/traces.jsonl`, MESSENGER_SEEN_FILE: `${D}/seen.json`, A2A_BASE: B, AGENT_TOKEN: TOKEN, MATCH_RECORDS_FILE: `${D}/match_records.json`, MATCH_AUDIT_FILE: `${D}/match_audit.json`,
    MATCH_STATE_FILE: `${D}/match_state.json`, MATCH_SETTINGS_FILE: `${D}/match_settings.json`, MATCH_MODELS_DIR: `${D}/match_models` };
  const start = (crash) => { const gw = spawn(process.execPath, ["src/server.js"], { env: { ...env, ...(crash ? { CRASH_AT: crash } : {}) }, stdio: ["ignore", "pipe", "pipe"] }); gw.stdout.on("data", () => {}); gw.stderr.on("data", (d) => /crash at/.test(d) && process.stdout.write(`  [gateway] ${d}`)); return gw; };
  const up = async () => { for (let i = 0; i < 60; i++) { try { await fetch(`${B}/api/status`); return; } catch { await wait(250); } } throw new Error("the gateway did not start"); };
  const before = model.asked.decisions;
  let gw = start(point);
  await up();
  const exited = new Promise((ok) => gw.on("exit", ok));
  await fetch(`${B}/api/match/find`, { method: "POST", headers: { "content-type": "application/json", ...AUTH }, body: JSON.stringify({ text: "I want to play singles this week" }) }).then((r) => r.text()).catch(() => null);
  const crashed = await Promise.race([exited.then(() => true), wait(15000).then(() => false)]);
  expect(crashed, `the gateway died at ${point}`);
  if (!crashed) gw.kill("SIGKILL");
  gw = start(null);
  await up();
  let a;
  for (let i = 0; i < 80; i++) { a = Object.values(readJson(`${D}/asks.json`, { asks: {} }).asks).find((x) => x.from === "request"); if (a && a.status !== "searching" && !a.outbox) break; await wait(250); }
  expect(a?.status === "moved" && !a.outbox, `the request ends with the game as a question, its outbox empty (${a?.status}${a?.outbox ? ", outbox still full" : ""})`);
  // no member's agent counted an estimate twice (an estimate asked again comes from its cache)
  const counted = readJson(`${D}/match_audit.json`, { audit: [] }).audit.filter((x) => x.counted), per = {};
  counted.forEach((x) => { per[x.member] = (per[x.member] || 0) + 1; });
  expect(Object.values(per).every((n) => n === 1), `no member's agent was asked for an estimate twice (${counted.length} estimates, ${Object.keys(per).length} members)`);
  const answers = Object.keys(readJson(`${D}/a2a_answers.json`, {})), decided = model.asked.decisions - before;
  expect(decided === answers.length, `every A2A message was decided once (${decided} model decisions, ${answers.length} messages)`);
  const live = (readJson(`${D}/bookings.json`, { leases: [] }).leases || []).filter((l) => l.until > Date.now());
  expect(a?.agreed && live.every((l) => l.ref === a.agreed.hold), `no hold is left but the agreed game's (${live.length} held, ${[...new Set(live.map((l) => l.ref))].join(", ") || "none"})`);
  if (a?.status === "moved") {
    await fetch(`${B}/api/ask/answer`, { method: "POST", headers: { "content-type": "application/json", ...AUTH }, body: JSON.stringify({ id: a.id, choice: "book" }) }).then((r) => r.text()).catch(() => null);
    await wait(500);
  }
  const bookings = readJson(`${D}/bookings.json`, { bookings: [] }).bookings.filter((b) => !b.cancelled);
  expect(bookings.length === 1, `the player's yes books it exactly once (${bookings.length})`);
  gw.kill("SIGKILL");
  await wait(300);
}
// The Autopilot (autopilot.js, autopilot_journal.js): a whole week planned in Messenger (a fake Graph API here) and
// crashed inside the run: at its start, after a model turn, around each of its two talks (the talk's id in the
// journal, a round saved, a member's answer saved, the talk done, its result in the journal), once the plan waits for
// the player's yes, after the approval message, and on the way to the booking (the yes saved, the games booked).
// Each run is compared with the same week run without a crash. After the restart the run goes on by itself, and:
//   exactly one approval message reaches the player, with the same games as the run without a crash;
//   the model is asked for no turn it already took (the turns, counted by the stand-in, are the crash-free run's);
//   no member's agent gets a proposal twice (as many A2A messages as without a crash), and each is decided once;
//   no hold is left over: before the yes only the plan's own talks hold anything, and after it nothing does;
//   the player's yes books each game exactly once, the outbox is empty and the run's journal is gone.
// The same crashes with AUTOPILOT_DURABLE=0 (the run is not resumed; the player asks again) are the baseline: what a
// crash cost before (proposals sent again, holds left over).
const AP_POINTS = ["autopilot-started", "autopilot-step@1", "autopilot-step@2", "autopilot-negotiating@1", "round-saved@1", "answer-saved@1", "talk-done@1", "autopilot-negotiated@1",
  "autopilot-step@4", "autopilot-negotiating@2", "round-saved@2", "answer-saved@2", "talk-done@2", "autopilot-negotiated@2", "autopilot-asked", "autopilot-notified", "autopilot-answered", "autopilot-booked"];
const BASELINE = ["autopilot-negotiated@1", "round-saved@2", "autopilot-asked"];
const GRAPH = +(process.env.CRASH_GRAPH_PORT || PORT + 1), SECRET = "crash-secret", PSID = "7007";
const sent = [];
const graph = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { const j = b ? JSON.parse(b) : {}; if (j.message?.text) sent.push({ text: j.message.text, payloads: (j.message.quick_replies || []).map((q) => q.payload) }); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ message_id: `m${sent.length}` })); }); });
if (only("autopilot")) await new Promise((ok) => graph.listen(GRAPH, "127.0.0.1", ok));
const hook = (event) => {
  const body = JSON.stringify({ object: "page", entry: [{ id: "page", time: Date.now(), messaging: [{ sender: { id: PSID }, recipient: { id: "page" }, timestamp: Date.now(), ...event }] }] });
  return fetch(`${B}/webhook/messenger`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=" + crypto.createHmac("sha256", SECRET).update(body).digest("hex") }, body }).then((r) => r.text()).catch(() => null);
};
const approvals = () => sent.filter((m) => m.payloads.some((p) => /^ap:[\w-]+:all$/.test(p)));
const until = async (f, ms = 30000) => { for (const t = Date.now(); Date.now() - t < ms; await wait(200)) { const v = f(); if (v) return v; } return null; };
// a whole week, crashed at `point` (or not at all), resumed by the restart (durable) or asked for again (baseline)
async function apWeek(point, { durable = true } = {}) {
  const D = `data/crash-ap-${durable ? "" : "base-"}${point || "none"}`.replace("@", "-");
  fs.rmSync(D, { recursive: true, force: true }); fs.mkdirSync(D, { recursive: true });
  sent.length = 0;
  const env = { ...process.env, PORT: String(PORT), WEBHOOK_PORT: "0", LLM_URL: model.url, LLM_API: "ollama", GUARD: "off", MEMORY_EMBED: "bm25", MESSENGER_PAGE_TOKEN: "TEST", MESSENGER_APP_SECRET: SECRET, MESSENGER_VERIFY_TOKEN: "v",
    MESSENGER_API: `http://127.0.0.1:${GRAPH}/v21.0`, STORE_FILE: `${D}/players.json`, BOOKINGS_FILE: `${D}/bookings.json`, AUTOPILOT_FILE: `${D}/autopilot.json`, A2A_FILE: `${D}/a2a.json`, ASK_FILE: `${D}/asks.json`,
    NEGOTIATIONS_FILE: `${D}/negotiations.json`, A2A_DATA: D, LEDGER_FILE: `${D}/ledger.jsonl`, TRACE_FILE: `${D}/traces.jsonl`, MESSENGER_SEEN_FILE: `${D}/seen.json`, MEMORY_FILE: `${D}/memory.json`, PREFS_FILE: `${D}/prefs.json`,
    MATCH_RECORDS_FILE: `${D}/match_records.json`, MATCH_AUDIT_FILE: `${D}/match_audit.json`, MATCH_STATE_FILE: `${D}/match_state.json`, MATCH_SETTINGS_FILE: `${D}/match_settings.json`, MATCH_MODELS_DIR: `${D}/match_models`,
    LOOP_DIR: `${D}/loop`, LOOP_WATCH: "off", FEED_FILE: `${D}/feed.json`, FEED_DEMO: "off", FEED_MEDIA_DIR: `${D}/feed-media`, FEED_CACHE_FILE: `${D}/feed-cache.json`,
    A2A_BASE: B, AGENT_TOKEN: TOKEN, AUTOPILOT_NOW: AP_NOW, AUTOPILOT_KEEP_JOURNAL: "1", AUTOPILOT_DURABLE: durable ? "1" : "0" };
  const start = (crash) => { const gw = spawn(process.execPath, ["src/server.js"], { env: { ...env, ...(crash ? { CRASH_AT: crash } : {}) }, stdio: ["ignore", "pipe", "pipe"] }); gw.stdout.on("data", () => {}); gw.stderr.on("data", (d) => /crash at/.test(d) && process.stdout.write(`  [gateway] ${d}`)); return gw; };
  const up = async () => { for (let i = 0; i < 60; i++) { try { await fetch(`${B}/api/status`); return; } catch { await wait(250); } } throw new Error("the gateway did not start"); };
  const t0 = { turns: model.asked.turns, decisions: model.asked.decisions };
  let gw = start(point), crashed = false, mid = 0;
  let exited = new Promise((ok) => gw.on("exit", () => { crashed = true; ok(); }));
  await up();
  const say = (text, payload) => hook({ message: { mid: `${D}-${++mid}-${Date.now()}`, text, ...(payload ? { quick_reply: { payload } } : {}) } });
  await say("Hi"); await until(() => sent.length >= 1, 10000);
  await say("/autopilot");
  // the crash, or the plan
  await Promise.race([exited, until(() => approvals().length, 30000)]);
  await wait(1000); // (a crash just after the approval message: the restart comes before the yes)
  const restart = async () => { gw = start(null); exited = new Promise((ok) => gw.on("exit", ok)); await up(); };
  if (crashed) {
    await restart();
    // the baseline: nothing goes on by itself, so the player asks again
    if (!durable && !approvals().length) await say("/autopilot");
  }
  const ask = await until(() => approvals()[0], 40000);
  const runId = ask && /^ap:([\w-]+):all$/.exec(ask.payloads.find((p) => /:all$/.test(p)))[1];
  const db0 = readJson(`${D}/autopilot.json`, { pending: {} });
  const plan = (db0.pending[runId]?.options || []).map((o) => `${o.day} ${o.start} ${o.venue.id} court ${o.court} with ${o.partners.map((p) => p.id).join("+")}`);
  const talks = (db0.pending[runId]?.options || []).map((o) => o.hold || o.talk);
  const leasesBefore = (readJson(`${D}/bookings.json`, { leases: [] }).leases || []).filter((l) => l.until > Date.now());
  const answers = Object.keys(readJson(`${D}/a2a_answers.json`, {})).length;
  const turns = model.asked.turns - t0.turns, decisions = model.asked.decisions - t0.decisions;
  // the player's yes (a crash on the way to the booking, then the restart books it)
  if (runId && !crashed) {
    let dead = false; const e2 = exited.then(() => { dead = true; });
    await say("Book both", `ap:${runId}:all`);
    await Promise.race([e2, until(() => sent.some((m) => /^Booked:/.test(m.text)), 20000)]);
    if (dead) { crashed = true; await restart(); await until(() => sent.some((m) => /^Booked:/.test(m.text)), 20000); }
  } else if (runId) {
    await say("Book both", `ap:${runId}:all`);
    await until(() => sent.some((m) => /^Booked:/.test(m.text)), 20000);
  }
  await wait(500);
  const bookings = readJson(`${D}/bookings.json`, { bookings: [] }).bookings.filter((b) => !b.cancelled);
  const leasesAfter = (readJson(`${D}/bookings.json`, { leases: [] }).leases || []).filter((l) => l.until > Date.now());
  const db1 = readJson(`${D}/autopilot.json`, { pending: {}, runs: [] });
  const open = fs.existsSync(`${D}/autopilot_runs`) ? fs.readdirSync(`${D}/autopilot_runs`).filter((f) => !fs.readFileSync(`${D}/autopilot_runs/${f}`, "utf8").includes('"k":"end"')) : [];
  gw.kill("SIGKILL"); await wait(300);
  return { crashed, approvals: approvals().length, plan, talks, leasesBefore, leasesAfter, answers, turns, decisions, bookings, outbox: !!db1.pending[runId]?.outbox, open: open.length, runs: db1.runs.length, resumed: db1.runs.find((r) => r.id === runId)?.report?.resumed || null };
}
const AP_NOW = (() => { const d = new Date(); d.setMinutes(0, 0, 0); d.setHours(10); return d.toISOString(); })(); // (a fixed hour today: every run plans the same week)
if (only("autopilot")) {
  console.log("\nAutopilot, no crash (the week to compare with)");
  const ref = await apWeek(null);
  console.log(`  ${ref.plan.length} games: ${ref.plan.join("; ")} · ${ref.turns} model turns, ${ref.answers} A2A proposals`);
  expect(ref.plan.length === 2 && ref.approvals === 1 && ref.bookings.length === 2, `without a crash the week ends with 2 games, one approval message and 2 bookings (${ref.plan.length}, ${ref.approvals}, ${ref.bookings.length})`);
  let passed = 0;
  const apPoints = AP_POINTS.filter((p) => !process.env.CRASH_POINTS || process.env.CRASH_POINTS.split(",").includes(p));
  for (const point of apPoints) {
    console.log(`\nAutopilot, crash at ${point}`);
    const before = fails.length, r = await apWeek(point);
    expect(r.crashed, `the gateway died at ${point}`);
    expect(r.approvals === 1, `exactly one approval message (${r.approvals})`);
    expect(JSON.stringify(r.plan) === JSON.stringify(ref.plan), `the same games as without the crash (${r.plan.join("; ") || "none"})`);
    expect(r.turns === ref.turns, `the model was asked for no turn it had already taken (${r.turns} turns, ${ref.turns} without a crash${r.resumed ? `; ${r.resumed.turnsFromJournal} turns and ${r.resumed.toolCallsFromJournal} tool calls from the journal` : ""})`);
    expect(r.answers === ref.answers && r.decisions === r.answers, `no member's agent got a proposal twice (${r.answers} proposals, ${ref.answers} without a crash; ${r.decisions} decided)`);
    expect(r.leasesBefore.every((l) => r.talks.includes(l.ref)) && !r.leasesAfter.length, `no hold left over (${r.leasesBefore.length} held before the yes, all the plan's; ${r.leasesAfter.length} after)`);
    expect(r.bookings.length === 2 && new Set(r.bookings.map((b) => b.option?.talk)).size === 2, `the yes booked each game exactly once (${r.bookings.length} bookings)`);
    expect(!r.outbox && !r.open, `the outbox is empty and no run is left unfinished (${r.outbox ? "outbox full" : "outbox empty"}, ${r.open} open)`);
    if (fails.length === before) passed++;
  }
  console.log(`\nAutopilot crash points: ${passed} of ${apPoints.length} passed`);
  // the baseline: the same crashes, when a run is not resumed
  const base = [];
  for (const point of process.env.CRASH_BASELINE !== "0" ? BASELINE : []) {
    const r = await apWeek(point, { durable: false });
    base.push({ point, again: r.answers - ref.answers, leftOver: r.leasesBefore.filter((l) => !r.talks.includes(l.ref)).length, approvals: r.approvals, turns: r.turns - ref.turns });
    console.log(`  baseline (not resumed), crash at ${point}: ${r.answers - ref.answers} proposals sent again, ${base.at(-1).leftOver} holds left over from the cut-off run, ${r.turns - ref.turns} extra model turns, ${r.approvals} approval message${r.approvals === 1 ? "" : "s"}`);
  }
  fs.writeFileSync("data/crash_autopilot.json", JSON.stringify({ at: new Date().toISOString(), points: apPoints.length, passed, reference: { games: ref.plan, turns: ref.turns, proposals: ref.answers }, baseline: base }, null, 1));
  graph.close();
}
model.close();
console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASSED");
process.exit(fails.length ? 1 : 0);

// Unit tests for the durable Autopilot and the failure attribution, with a stand-in model and no GPU:
//   node --test test/durable_unit.mjs
//   - the journal: lines written and read back, a line cut off by a crash left out, runs without an end listed
//   - a run cut short (its journal cut after a talk), resumed: the same games, the model asked only for the turns it had
//     not taken, the talk not started again
//   - error.type for the Autopilot's tool refusals
//   - attribution on made-up traces: each kind, a failure got past, a run that met its goal
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeModel } from "./fake_model.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "serve-durable-"));
const model = await fakeModel();
Object.assign(process.env, { AUTOPILOT_FILE: `${tmp}/autopilot.json`, BOOKINGS_FILE: `${tmp}/bookings.json`, A2A_FILE: `${tmp}/a2a.json`, A2A_DATA: `${tmp}/a2a`, NEGOTIATIONS_FILE: `${tmp}/neg.json`, LEDGER_FILE: `${tmp}/ledger.jsonl`,
  TRACE_FILE: `${tmp}/traces.jsonl`, PREFS_FILE: `${tmp}/prefs.json`, STORE_FILE: `${tmp}/players.json`, MEMORY_FILE: `${tmp}/memory.json`, MATCH_RECORDS_FILE: `${tmp}/mr.json`, MATCH_AUDIT_FILE: `${tmp}/ma.json`, MATCH_STATE_FILE: `${tmp}/ms.json`,
  LLM_URL: model.url, LLM_API: "ollama", GUARD: "off", MEMORY: "off", A2A_TRANSPORT: "local", A2A_ROUTE: "off", AUTOPILOT_KEEP_JOURNAL: "1", LOOP_DIR: `${tmp}/loop`, LOOP_WATCH: "off" });
delete process.env.A2A_BASE; delete process.env.A2A_PRIVATE; delete process.env.CRASH_AT; delete process.env.AUTOPILOT_DURABLE;
const journal = await import("../src/autopilot_journal.js");
const autopilot = await import("../src/autopilot.js");
const play = await import("../src/play.js");
const { errorType } = await import("../src/trace.js");
const { attribute, outcomeOf } = await import("../src/attribution.js");
after(() => { model.close(); fs.rmSync(tmp, { recursive: true, force: true }); (async () => (await import("../src/memory.js")).close?.())().catch(() => {}); });

test("journal: written line by line, read back, a torn last line left out, unfinished runs listed", () => {
  const j = journal.open("ap-test-1");
  j.rec("start", { args: { goal: { perWeek: 1 } } }); j.rec("turn", { i: 0, calls: [] }); j.rec("done", { seq: 0, name: "get_week", res: {}, fx: {}, step: "Checked your week" });
  fs.appendFileSync(j.file, '{"k":"done","seq":1,"na');
  const back = journal.read("ap-test-1");
  assert.equal(back.length, 3);
  const k = journal.open("ap-test-1");
  assert.ok(k.resumed && k.start && k.turns[0] && k.calls[0].done);
  assert.deepEqual(journal.unfinished().map((r) => r.id), ["ap-test-1"]);
  assert.equal(journal.progress("ap-test-1").last, "Checked your week");
  journal.remove("ap-test-1");
  assert.equal(journal.read("ap-test-1"), null);
});

test("a run cut off after its first talk resumes from the journal: same games, no turn asked twice, no talk started again", async () => {
  const now = new Date(); now.setHours(10, 0, 0, 0);
  play.clearLeases();
  const t0 = model.asked.turns, d0 = model.asked.decisions;
  const full = await autopilot.run({ goal: { perWeek: 2 }, now, player: "unit" });
  const turns = model.asked.turns - t0, decisions = model.asked.decisions - d0;
  assert.equal(full.agreed.length, 2);
  // the same week again, its journal cut just after the first talk's result (as a crash there would leave it)
  play.clearLeases();
  const second = await autopilot.run({ goal: { perWeek: 2 }, now, player: "unit2" });
  const es = journal.read(second.id), cut = es.findIndex((e) => e.k === "done" && e.name === "negotiate") + 1;
  const kept = es.slice(0, cut);
  const talks = kept.filter((e) => e.k === "done" && e.name === "negotiate").length;
  journal.remove(second.id);
  fs.writeFileSync(path.join(journal.dir(), `${second.id}.jsonl`), kept.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const t1 = model.asked.turns, d1 = model.asked.decisions;
  const [resumed] = await autopilot.resumeRuns();
  assert.equal(resumed.id, second.id);
  assert.deepEqual(resumed.agreed.map((o) => `${o.day} ${o.start} ${o.partners.map((p) => p.id)}`), second.agreed.map((o) => `${o.day} ${o.start} ${o.partners.map((p) => p.id)}`));
  const turnsTaken = kept.filter((e) => e.k === "turn").length;
  assert.equal(model.asked.turns - t1, turns - turnsTaken, "the model is asked only for the turns not in the journal");
  // (the first talk comes back from the journal; the second, which finished before the journal was cut, from its own
  // saved result, by its id: no member's agent is asked again)
  assert.ok(talks === 1 && decisions === 2);
  assert.equal(model.asked.decisions - d1, 0, "no talk is held again");
  assert.ok(resumed.report.resumed.turnsFromJournal === turnsTaken && resumed.report.resumed.toolCallsFromJournal > 0);
  assert.equal(journal.unfinished().length, 0);
});

test("error.type: each of the Autopilot's refusals has its kind", () => {
  assert.equal(errorType("find_partners", { error: "the arguments do not fit find_partners: $.day: missing. Call find_partners again" }), "invalid_arguments");
  assert.equal(errorType("x", { error: "no tool called x" }), "unknown_tool");
  assert.equal(errorType("finish", { error: "not yet: 1 game is still needed" }), "stop_refused");
  assert.equal(errorType("find_partners", { error: "You are not usually free Wed 19:00; pick one of your habitual times" }), "rule_refused");
  assert.equal(errorType("negotiate", { error: "Leo is left out this week, as the player asked" }), "rule_refused");
  assert.equal(errorType("find_partners", { error: "Nobody who plays doubles is free Sat 09:00" }), "no_option");
  assert.equal(errorType("find_places", { error: "fetch failed", threw: true }), "tool_failed");
  assert.equal(errorType("find_places", { error: "The operation was aborted due to timeout", threw: true }), "timeout");
  assert.equal(outcomeOf({ reason: "Leo declined" }), "declined");
  assert.equal(outcomeOf({ reason: "Kenji's agent did not answer", silent: ["kenji"] }), "no_answer");
  assert.equal(outcomeOf({ reason: "no court is free when everyone is" }), "no_court");
});

// a made-up trace: the run's root, its steps in order, and what is under them
let n = 0;
const sp = (name, attributes = {}, parent = null, extra = {}) => ({ traceId: "t", spanId: `s${++n}`, parentId: parent?.spanId || null, name, kind: 0, start: n * 10, ms: 5, status: extra.error ? "error" : "ok", attributes, ...extra });
const run = (attrs) => sp("invoke_agent autopilot", { "serve.needed": 2, "serve.agreed": 1, "serve.rules_took_over": false, "serve.steps_left": 8, ...attrs });
const tool = (root, name, attrs = {}, extra = {}) => sp(`execute_tool ${name}`, { "gen_ai.tool.name": name, ...attrs }, root, extra);
const win = (root) => tool(root, "negotiate", { "serve.agreed": true, "serve.when": "Thu 19:00" });

test("attribution: a run that met its goal by the model has none", () => {
  const root = run({ "serve.agreed": 2 });
  assert.equal(attribute([root, win(root), win(root)]), null);
});
test("attribution: a member's agent that timed out inside the talk that failed", () => {
  const root = run(), w = win(root), ng = tool(root, "negotiate", { "serve.agreed": false, "serve.reason": "Sam's agent did not answer" });
  const talk = sp("invoke_agent talk", { "serve.agreed": false, "serve.outcome": "no_answer" }, ng);
  const inv = sp("invoke_agent member:sam", { "serve.member": "sam", "error.type": "timeout" }, talk, { kind: 2, error: "timeout" });
  const a = attribute([root, w, ng, talk, inv, tool(root, "request_approval")]);
  assert.equal(a.kind, "timeout"); assert.equal(a.step, 2); assert.equal(a.cause, inv.spanId); assert.match(a.line, /^Ended short at step 2 \(negotiate\): negotiate: sam's agent did not answer in time \(timeout\)\.$/);
});
test("attribution: a member's agent that could not be reached", () => {
  const root = run(), ng = tool(root, "negotiate", { "serve.agreed": false });
  const talk = sp("invoke_agent talk", { "serve.outcome": "no_answer" }, ng), msg = sp("SendMessage", { "serve.member": "leo", "error.type": "unreachable" }, talk, { error: "fetch failed" });
  assert.equal(attribute([root, ng, talk, msg]).kind, "agent_unreachable");
});
test("attribution: the model stopped calling tools (and the rules finished it)", () => {
  const root = run({ "serve.agreed": 2, "serve.rules_took_over": true }), w = win(root);
  const c1 = sp("chat muse-glimmer", { "serve.tool_calls": 0, "serve.text_reply": true }, root), c2 = sp("chat muse-glimmer", { "serve.tool_calls": 0 }, root);
  const rw = tool(root, "negotiate", { "serve.agreed": true, "serve.decided_by": "rules" });
  const a = attribute([root, w, c1, c2, rw]);
  assert.equal(a.kind, "model_format"); assert.ok(a.recovered); assert.match(a.line, /^Rules finished the plan/);
});
test("attribution: a stop refused that the run got past is not the step; a rule break it did not get past is", () => {
  const root = run(), w = win(root), stop = tool(root, "finish", { "error.type": "stop_refused" }, { error: "not yet" }), fp = tool(root, "find_partners", { "error.type": "rule_refused" }, { error: "not usually free" }), end = tool(root, "request_approval");
  const a = attribute([root, w, stop, fp, end]);
  assert.equal(a.kind, "rule_caught"); assert.equal(a.tool, "find_partners");
});
test("attribution: arguments that did not fit, then fixed, are got past; the talk declined after is a dead end", () => {
  const root = run(), w = win(root), bad = tool(root, "find_partners", { "error.type": "invalid_arguments" }, { error: "x" }), ok = tool(root, "find_partners"), ng = tool(root, "negotiate", { "serve.agreed": false });
  const talk = sp("invoke_agent talk", { "serve.outcome": "declined" }, ng);
  const a = attribute([root, w, bad, ok, ng, talk, tool(root, "request_approval")]);
  assert.equal(a.kind, "no_option"); assert.equal(a.step, 4);
});
test("attribution: a fault after a dead end wins (the model ran out of steps)", () => {
  const root = run({ "serve.rules_took_over": true, "serve.steps_left": 0 }), ng = tool(root, "negotiate", { "serve.agreed": false, "serve.reason": "Hana declined" }), c = sp("chat muse-glimmer", { "serve.tool_calls": 1 }, root);
  assert.equal(attribute([root, ng, c]).kind, "timeout");
});
test("attribution: a game the oracle rejects is a rule break missed", () => {
  const root = run({ "serve.agreed": 2 }), w1 = win(root), w2 = tool(root, "negotiate", { "serve.agreed": true, "serve.when": "Sat 09:00" });
  const a = attribute([root, w1, w2], { badGames: ["Sat 09:00"] });
  assert.equal(a.kind, "rule_missed"); assert.equal(a.step, 2);
});
test("attribution: a member's yes that broke its rule, put right by code, ends the talk: a rule break caught", () => {
  const root = run(), ng = tool(root, "negotiate", { "serve.agreed": false }), talk = sp("invoke_agent talk", { "serve.outcome": "declined" }, ng), m = sp("invoke_agent member:yuki", { "serve.overruled": true, "gen_ai.agent.name": "member:yuki" }, talk);
  assert.equal(attribute([root, ng, talk, m]).kind, "rule_caught");
});

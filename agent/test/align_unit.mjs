// The goal check (src/align.js, src/align_worker.py): its JSON-lines protocol and its fail-closed rule, with no model
// and no GPU. A stand-in worker (a Node script) answers as told; where LlamaFirewall's venv is there (ALIGN_PYTHON, or
// ../attack/lfenv/bin/python), the real Python worker is run against a stand-in OpenAI-compatible model server too.
//   node --test test/align_unit.mjs        (npm test)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fakeModel } from "./fake_model.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "serve-align-"));
const model = await fakeModel();
Object.assign(process.env, { LEDGER_FILE: `${tmp}/ledger.jsonl`, TRACE_FILE: `${tmp}/traces.jsonl`, AUTOPILOT_FILE: `${tmp}/autopilot.json`, BOOKINGS_FILE: `${tmp}/bookings.json`, A2A_FILE: `${tmp}/a2a.json`, A2A_DATA: `${tmp}/a2a`,
  NEGOTIATIONS_FILE: `${tmp}/neg.json`, ASK_FILE: `${tmp}/asks.json`, LLM_URL: model.url, LLM_API: "ollama", MEMORY: "off", GUARD: "off", A2A_ROUTE: "off" });
delete process.env.ALIGN_URL; delete process.env.ALIGN_CHECK;
const align = await import("../src/align.js");
const ledger = await import("../src/ledger.js");

// the stand-in worker: FAKE_ALIGN says how it answers (aligned, misaligned, error, garbage, silent, exit, swap)
const FAKE = path.join(tmp, "fake_align_worker.mjs");
fs.writeFileSync(FAKE, `import readline from "node:readline";
const mode = process.env.FAKE_ALIGN || "aligned", held = [];
const answer = (r) => {
  if (mode === "garbage") return "not json at all";
  if (mode === "error") return JSON.stringify({ id: r.id, aligned: false, checked: false, error: "APIConnectionError: Connection error." });
  if (mode === "lies") return JSON.stringify({ id: r.id, aligned: true, checked: false, error: "the model did not answer" });
  const off = mode === "misaligned" || /tennis/.test(JSON.stringify(r.actions));
  return JSON.stringify({ id: r.id, aligned: !off, checked: true, decision: off ? "human_in_the_loop_required" : "allow", seconds: 0.01, tokens: { prompt: 900, output: 80 }, reason: off ? "Observation: books tennis" : "default" });
};
readline.createInterface({ input: process.stdin }).on("line", (l) => {
  const r = JSON.parse(l);
  if (mode === "silent") return;
  if (mode === "exit") process.exit(3);
  if (mode === "swap") { held.push(r); if (held.length === 2) { console.log(answer(held[1])); console.log(answer(held[0])); held.length = 0; } return; }
  console.log(answer(r));
});
`);
const useFake = (mode) => { align.stopWorker(); Object.assign(process.env, { ALIGN_CHECK: "on", ALIGN_URL: "http://127.0.0.1:9/v1", ALIGN_PYTHON: process.execPath, ALIGN_WORKER: FAKE, FAKE_ALIGN: mode }); };
const goal = "Get me 1 badminton game this week, doubles on Thursday.";
const plan = (sport = "badminton") => [{ action: "find_partners", input: { day: "Thu", start: "19:00", format: "doubles" }, thought: "Thursday is the usual time", result: "Leo, Hana, Kenji free" },
  { action: "request_approval", input: { games: [`${sport} doubles Thursday 19:00 with Leo, Hana, Kenji`] }, thought: "ask the player" }];

test("the fail-closed rule: aligned only on a verdict that says so", () => {
  assert.equal(align.verdictOf(JSON.stringify({ id: 1, aligned: true, checked: true, decision: "allow" })).aligned, true);
  assert.equal(align.verdictOf(JSON.stringify({ id: 1, aligned: false, checked: true })).aligned, false);
  for (const line of ["", "not json", "null", "[]", JSON.stringify({ id: 1 }), JSON.stringify({ id: 1, aligned: true }), JSON.stringify({ id: 1, aligned: true, checked: false }),
    JSON.stringify({ id: 1, aligned: true, checked: true, error: "boom" }), JSON.stringify({ id: 1, aligned: "yes", checked: true }), JSON.stringify({ id: 1, error: "the goal check stopped" })]) {
    const v = align.verdictOf(line);
    assert.equal(v.aligned, false, `fails closed on ${line || "(empty)"}`);
  }
  assert.equal(align.verdictOf("garbage").checked, false);
});

test("the switch: off without an endpoint, on with one, ALIGN_CHECK=off wins", async () => {
  delete process.env.ALIGN_URL; delete process.env.ALIGN_CHECK;
  assert.equal(align.alignOn(), false);
  assert.deepEqual(await align.check({ goal, actions: plan() }), { aligned: true, checked: false, off: true });
  process.env.ALIGN_URL = "http://127.0.0.1:9/v1"; assert.equal(align.alignOn(), true);
  process.env.ALIGN_CHECK = "off"; assert.equal(align.alignOn(), false);
  delete process.env.ALIGN_URL; process.env.ALIGN_CHECK = "on"; assert.equal(align.alignOn(), true, "on uses LLM_URL"); assert.equal(align.endpoint(), model.url);
  delete process.env.ALIGN_CHECK;
});

test("the protocol: one line each way, answers matched by id, a ledger row with no text", async () => {
  useFake("aligned");
  const ok = await align.check({ goal, actions: plan(), site: "align.unit" });
  assert.equal(ok.aligned, true); assert.equal(ok.checked, true); assert.equal(ok.verdict, "aligned");
  const off = await align.check({ goal, actions: plan("tennis"), site: "align.unit" });
  assert.equal(off.aligned, false); assert.equal(off.checked, true); assert.equal(off.verdict, "misaligned");
  // two at once, answered in the other order: each gets its own
  useFake("swap");
  const [a, b] = await Promise.all([align.check({ goal, actions: plan("tennis"), site: "align.unit" }), align.check({ goal, actions: plan(), site: "align.unit" })]);
  assert.equal(a.aligned, false); assert.equal(b.aligned, true);
  const rows = ledger.calls(50).filter((c) => c.site === "align.unit");
  assert.equal(rows.length, 4);
  for (const r of rows) {
    assert.ok(["aligned", "misaligned"].includes(r.align)); assert.equal(typeof r.seconds, "number"); assert.equal(r.marker, true);
    assert.ok(!JSON.stringify(r).includes("Thursday") && !JSON.stringify(r).includes("tennis") && !("reason" in r), "no text in the ledger");
  }
});

test("fail-closed: an error, no verdict, a line that is not JSON, no answer, a worker that dies or never starts", async () => {
  for (const mode of ["error", "lies", "garbage", "silent", "exit"]) {
    useFake(mode);
    const v = await align.check({ goal, actions: plan(), site: "align.unit.fail", timeoutMs: 1500 });
    assert.equal(v.aligned, false, mode); assert.equal(v.checked, false, mode); assert.equal(v.verdict, "failed", mode);
  }
  align.stopWorker(); process.env.ALIGN_PYTHON = path.join(tmp, "no-python");
  const v = await align.check({ goal, actions: plan(), site: "align.unit.fail" });
  assert.equal(v.aligned, false); assert.match(v.error, /no Python/);
  assert.ok(ledger.calls(100).filter((c) => c.site === "align.unit.fail").every((c) => c.align === "failed"));
});

test("actionsOf: each tool call as action, input, thought and result", () => {
  const a = align.actionsOf([{ name: "negotiate", args: { members: ["leo"], day: "Thu", reason: "Leo plays fast" }, res: { agreed: true }, by: "rules" }, { name: "get_week", args: {}, res: null }], (t) => { if (!t.res) throw new Error("x"); return "agreed"; });
  assert.deepEqual(a[0], { action: "negotiate", input: { members: ["leo"], day: "Thu" }, thought: "Leo plays fast (run by rules)", result: "agreed" });
  assert.equal(a[1].result, "");
});

// the Autopilot (the model stalls on the stand-in server, so rules plan the week): a plan off the request, or a check
// that did not run, is not sent for approval; the player is told plainly and sees a draft
test("the Autopilot: not aligned or not checked, the plan is a draft and the player is told", async () => {
  const { run, pending, answer } = await import("../src/autopilot.js");
  useFake("misaligned");
  let told = null;
  const r = await run({ goal: { perWeek: 1 }, now: new Date("2026-11-02T08:00:00"), notify: async (id, games, summary, o) => { told = o; } });
  assert.ok(r.agreed.length >= 1, "rules lined up a game");
  assert.equal(r.approval?.draft, true); assert.equal(r.approval.status, "draft");
  assert.equal(pending(r.id).status, "draft");
  assert.match(r.summary, /draft/i); assert.match(r.summary, /doesn't quite match what you asked for/);
  assert.deepEqual(told, { draft: true });
  assert.deepEqual(r.report.align, { aligned: false, checked: true, seconds: r.report.align.seconds });
  assert.ok(answer(r.id, "none"), "the player can still answer a draft");

  useFake("silent"); process.env.ALIGN_TIMEOUT_MS = "1500";
  const f = await run({ goal: { perWeek: 1 }, now: new Date("2026-11-02T08:00:00") });
  assert.equal(f.approval?.draft, true); assert.match(f.summary, /couldn't check the plan/);
  delete process.env.ALIGN_TIMEOUT_MS;

  useFake("aligned");
  const ok = await run({ goal: { perWeek: 1 }, now: new Date("2026-11-02T08:00:00") });
  assert.equal(ok.approval?.status, "pending"); assert.ok(!ok.approval.draft); assert.equal(ok.report.align.aligned, true);
});

// the real worker, if LlamaFirewall's venv is here: AlignmentCheck's verdict from a stand-in model, and its failures
const PY = process.env.ALIGN_PYTHON_REAL || path.resolve("../attack/lfenv/bin/python");
test("align_worker.py with LlamaFirewall (skipped without its venv)", { skip: !fs.existsSync(PY) && `no venv at ${PY}` }, async () => {
  let mode = "false";
  const srv = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c));
    req.on("end", () => {
      if (mode === "500") { res.writeHead(500); return res.end("boom"); }
      const content = mode === "garbage" ? "I think it is fine" : JSON.stringify({ observation: "o", thought: "t", conclusion: mode === "true" });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "x", object: "chat.completion", created: 1, model: "muse-glimmer", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }], usage: { prompt_tokens: 700, completion_tokens: 60, total_tokens: 760 } }));
    });
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  try {
    align.stopWorker();
    Object.assign(process.env, { ALIGN_CHECK: "on", ALIGN_URL: `http://127.0.0.1:${srv.address().port}/v1`, ALIGN_PYTHON: PY }); delete process.env.ALIGN_WORKER;
    const ok = await align.check({ goal, actions: plan(), site: "align.unit.py" });
    assert.equal(ok.checked, true, ok.error); assert.equal(ok.aligned, true); assert.equal(ok.tokens.prompt, 700);
    mode = "true";
    const off = await align.check({ goal, actions: plan(), site: "align.unit.py" });
    assert.equal(off.checked, true); assert.equal(off.aligned, false); assert.equal(off.decision, "human_in_the_loop_required");
    for (mode of ["500", "garbage"]) {
      const v = await align.check({ goal, actions: plan(), site: "align.unit.py" });
      assert.equal(v.aligned, false, mode); assert.equal(v.checked, false, mode);
    }
    mode = "false";
    const none = await align.check({ goal: "", actions: plan(), site: "align.unit.py" });
    assert.equal(none.aligned, false); assert.equal(none.checked, false);
    const empty = await align.check({ goal, actions: [], site: "align.unit.py" });
    assert.equal(empty.aligned, false); assert.equal(empty.checked, false);
  } finally { align.stopWorker(); srv.close(); }
});

test.after(() => { align.stopWorker(); model.close(); delete process.env.ALIGN_CHECK; delete process.env.ALIGN_URL; });

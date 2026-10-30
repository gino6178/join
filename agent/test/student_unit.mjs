// Unit tests for the student tier (src/student.js, A2A_STUDENT), against a stand-in worker: no model, no GPU.
//   node --test test/student_unit.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "serve-student-"));
Object.assign(process.env, { BOOKINGS_FILE: `${tmp}/bookings.json`, A2A_FILE: `${tmp}/a2a.json`, NEGOTIATIONS_FILE: `${tmp}/neg.json`, LEDGER_FILE: `${tmp}/ledger.jsonl`, TRACE_FILE: `${tmp}/traces.jsonl`, LLM_URL: "http://127.0.0.1:9/v1" });
const { breaks, decide, fullAnswer } = await import("../src/a2a.js");
const { studentAnswer } = await import("../src/student.js");
const { validate, DECISION } = await import("../src/schema.js");
const ledger = await import("../src/ledger.js");

// a stand-in worker: answers with what the test sets, and keeps what it was sent
let reply = null, seen = [];
const srv = await new Promise((ok) => { const s = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { seen.push(JSON.parse(b)); res.setHeader("content-type", "application/json"); res.end(JSON.stringify(reply)); }); }).listen(0, "127.0.0.1", () => ok(s)); });
process.env.A2A_STUDENT_URL = `http://127.0.0.1:${srv.address().port}`;
test.after(() => srv.close());

// a member free Tuesday, Friday and Saturday who never plays Fridays; the proposed time (t1) is a Friday
const m = { id: "s900", name: "Ana Silva", level: "B", prefers: "singles", free: ["Tue 18-22", "Fri 18-22", "Sat 08-12"], rules: { noDays: ["Fri"] }, rulesComplete: true, area: { x: 3, y: 5 }, agent: "A simulated member. Ana doesn't play on Fridays." };
const t = (id, date, day, h) => ({ id, slot: { date, day }, start: h * 60, trip: 10, text: `${day} ${date.slice(8)} Nov ${h}:00–${h + 1}:30 at Riverside Sports Centre, court 2 (Ana's trip 10 min)` });
const cur = t("t1", "2026-11-06", "Fri", 19), tue = t("t2", "2026-11-03", "Tue", 19), sat = t("t3", "2026-11-07", "Sat", 9), sun = t("t4", "2026-11-08", "Sun", 9);
const all = [cur, tue, sat, sun], ok = all.filter((x) => !breaks(m, x, 90));
const opts = { minutes: 90, format: "singles", sport: "badminton", profile: "You are Ana Silva's agent." };
const pick = (id, p, works = { t1: 0.02, t2: 0.97, t3: 0.96, t4: 0.03 }) => ({ options: [{ letter: "B", kind: "counter", id: "t2", p: id === "t2" ? p : 1 - p }, { letter: "C", kind: "counter", id: "t3", p: id === "t3" ? p : 1 - p }, { letter: "Z", kind: "decline", id: null, p: 0 }],
  pick: { letter: id === "t2" ? "B" : "C", kind: "counter", id, p }, works_p: works, ms: 300, tokens: 210, reused: 0, model: "test.gguf" });

test("the student answers the real choice: a counter to a time that works, with code's set of times", async () => {
  reply = pick("t3", 0.97); seen = [];
  const j = await studentAnswer(m, cur, ok, all, opts);
  assert.equal(j.intent, "counter"); assert.equal(j.date, "2026-11-07"); assert.equal(j.start, "09:00");
  assert.deepEqual(j.works, ["t2", "t3"], "the times that keep the calendar and rules, by code");
  assert.equal(j.tier, "student"); assert.deepEqual(validate(DECISION, j), [], "fits the protocol's decision");
  assert.deepEqual(seen[0].works, ["t2", "t3"]); assert.equal(seen[0].offers[0].id, "t1", "the proposed time first");
  assert.equal(seen[0].offers[2].date, "2026-11-07"); assert.equal(seen[0].offers[2].start, "09:00");
});

test("unsure, or its own reading of the times differs from code's: Muse Glimmer answers", async () => {
  reply = pick("t3", 0.3);
  assert.equal(await studentAnswer(m, cur, ok, all, opts), null);
  reply = pick("t3", 0.99, { t1: 0.9, t2: 0.97, t3: 0.96, t4: 0.03 });
  assert.equal(await studentAnswer(m, cur, ok, all, opts), null, "it read the Friday as working");
  const rows = ledger.calls(50).filter((r) => r.site === "a2a.student");
  assert.ok(rows.length >= 3 && rows.every((r) => r.model === "test.gguf"), "every call is in the ledger");
});

test("only the real choice, and only for a member whose limits are all in code", async () => {
  reply = pick("t2", 0.99); seen = [];
  assert.equal(await studentAnswer(m, cur, [tue], all, opts), null, "one time works: code counters with it");
  assert.equal(await studentAnswer({ ...m, rulesComplete: false }, cur, ok, all, opts), null, "a limit only in words is Glimmer's");
  assert.equal(seen.length, 0, "the worker was not asked");
});

test("A2A_STUDENT on by default: a member's agent decides with it, through the full answer's path", async () => {
  reply = pick("t2", 0.95);
  const j = await decide(m, cur, all, [], "singles", "badminton", 90);
  assert.equal(j.intent, "counter"); assert.equal(j.start, "19:00"); assert.equal(j.tier, "student"); assert.match(j.text, /would rather play Tue 3 Nov 19:00/);
});

test("a worker that is down is no answer, and Muse Glimmer is asked (A2A_STUDENT=off asks it directly)", async () => {
  const url = process.env.A2A_STUDENT_URL; process.env.A2A_STUDENT_URL = "http://127.0.0.1:9";
  assert.equal(await studentAnswer(m, cur, ok, all, opts), null);
  process.env.A2A_STUDENT_URL = url;
  // (the model here is not reachable either: the full answer comes back as no answer, not as the student's)
  process.env.A2A_STUDENT = "off"; seen = [];
  const j = await fullAnswer(m, cur, all, [], "singles", "badminton", 90);
  delete process.env.A2A_STUDENT;
  assert.equal(seen.length, 0); assert.notEqual(j.tier, "student");
});

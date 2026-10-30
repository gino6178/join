// Unit tests for notes that can be updated and partly forgotten (memory.js, memory_update.js), with a stand-in for
// the model and BM25 for meaning (no GPU):
//   node --test test/memory_update_unit.mjs
//   - code finds the members, weekdays and times a note names
//   - the model's answer is checked: a replaced note must share a subject, a rule's member must be named in the note,
//     a weekday rule's day too, a last day must be a date after today from a note that speaks of a time; a note with
//     nothing to check is added without asking
//   - a newer note replaces an older one (kept, struck, never recalled), its rule goes with it; a note past its last day
//     expires; the Autopilot's rules come from live notes only; append-only when MEMORY_CONSOLIDATE=off
//   - forgetting what was said about one member, or one topic, and nothing else
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "serve-memupd-"));
Object.assign(process.env, { MEMORY_FILE: `${tmp}/memory.json`, MEMORY_EMBED: "bm25", LEDGER_FILE: `${tmp}/ledger.jsonl`, TRACE_FILE: `${tmp}/traces.jsonl`, LLM_URL: "http://127.0.0.1:9/v1" });
delete process.env.MEMORY; delete process.env.MEMORY_CONSOLIDATE;
const update = await import("../src/memory_update.js");
const memory = await import("../src/memory.js");
after(() => { update.useAsk(null); fs.rmSync(tmp, { recursive: true, force: true }); });

const at = (d) => new Date(`${d}T10:00:00`).getTime();
// the stand-in model: answers what the test says, and records what it was shown
let reply = null, shown = [];
update.useAsk(async (msgs) => { shown.push(msgs[0].content); return { value: typeof reply === "function" ? reply(msgs[0].content) : reply }; });

test("code finds the members, weekdays and times a note names", () => {
  assert.deepEqual(update.people("Please leave Tomás out for a while"), ["tomas"]);
  assert.deepEqual(update.people("tomas and hana are fine").sort(), ["hana", "tomas"]);
  assert.deepEqual(update.people("A new racket"), []);
  assert.deepEqual(update.daysIn("No games on Fridays, ever"), ["Fri"]);
  assert.deepEqual(update.daysIn("weekends are best").sort(), ["Sat", "Sun"]);
  assert.equal(update.timeish("until the end of October"), true);
  assert.equal(update.timeish("Kenji always pushes me"), false);
});

test("the model's answer is checked by code", async () => {
  const note = { text: "Tomás and I made up, he is fine again.", at: at("2026-10-20"), about: ["tomas"] };
  const cands = [{ id: "a1", text: "Leave Tomás out of my games for a few weeks.", at: at("2026-10-01"), about: ["tomas"], cos: 0.5 }, { id: "a2", text: "My shoes are worn out.", at: at("2026-10-02"), about: [], cos: 0.2 }];
  reply = { op: "update", replaces: ["n1", "n2"], rule: { kind: "none" }, until: "" };
  let d = await update.decide(note, cands);
  assert.equal(d.op, "update"); assert.deepEqual(d.replaces, ["a1"]); assert.match(d.refused[0], /shares no subject/);
  // a rule for someone the note does not name is refused; for someone it names, kept
  reply = { op: "add", replaces: [], rule: { kind: "avoid_person", who: "Kenji" }, until: "" };
  d = await update.decide({ text: "Leave Tomás out for now.", at: at("2026-10-05"), about: ["tomas"] }, []);
  assert.equal(d.rule, null); assert.match(d.refused[0], /not a club member the note names/);
  reply = { op: "add", replaces: [], rule: { kind: "avoid_person", who: "tomas" }, until: "2026-10-20" };
  d = await update.decide({ text: "Leave Tomás out until 20 October.", at: at("2026-10-05"), about: ["tomas"] }, []);
  assert.deepEqual(d.rule, { kind: "avoid_person", who: "tomas", name: "Tomás" }); assert.equal(d.until, "2026-10-20");
  // a last day before today, or from a note that names no time, is refused
  reply = { op: "add", replaces: [], rule: { kind: "avoid_day", day: "Fri" }, until: "2025-01-01" };
  d = await update.decide({ text: "No games on Fridays until January.", at: at("2026-10-05") }, []);
  assert.deepEqual(d.rule, { kind: "avoid_day", day: "Fri" }); assert.equal(d.until, null); assert.match(d.refused.at(-1), /between today and a year/);
  reply = { op: "add", replaces: [], rule: { kind: "avoid_day", day: "Sat" }, until: "2026-11-30" };
  d = await update.decide({ text: "No games on Fridays.", at: at("2026-10-05") }, []);
  assert.equal(d.rule, null, "a weekday the note does not name"); assert.equal(d.until, null, "a note that names no time");
  // "same" needs a note close in meaning; nothing to check is added without asking the model
  reply = { op: "same", replaces: [], rule: { kind: "none" }, until: "" };
  d = await update.decide(note, cands); assert.equal(d.op, "add");
  shown = [];
  d = await update.decide({ text: "Got a new racket, feels great.", at: at("2026-10-05") }, []);
  assert.equal(d.op, "add"); assert.equal(d.by, "code"); assert.equal(shown.length, 0);
  // no answer in the format: added as it is
  reply = null; d = await update.decide(note, cands); assert.equal(d.op, "add"); assert.match(d.refused[0], /no answer/);
});

test("a newer note replaces an older one, its rule goes with it, and a note past its last day expires", async () => {
  const P = "unit-p1";
  reply = { op: "add", replaces: [], rule: { kind: "avoid_person", who: "Tomás" }, until: "" };
  assert.equal(await memory.remember(P, [{ text: "Please leave Tomás out of my games for a few weeks.", kind: "said", at: at("2026-10-01") }]), 1);
  reply = null;
  await memory.remember(P, [{ text: "Kenji always pushes me, I'd like to play him more.", kind: "said", at: at("2026-10-03") }]);
  assert.deepEqual(memory.rules(P, at("2026-10-10")).map((r) => [r.kind, r.who]), [["avoid_person", "tomas"]]);
  // the stand-in replaces whichever offered note names Tomás
  reply = (sys) => { const l = sys.match(/(n\d) \(said [^)]*\): "[^"]*Tomás/)?.[1]; return { op: "update", replaces: l ? [l] : [], rule: { kind: "none" }, until: "" }; };
  await memory.remember(P, [{ text: "Tomás and I talked it out, he is fine again. Put him back in my games.", kind: "said", at: at("2026-10-20") }]);
  const ls = memory.list(P, at("2026-10-21")), old = ls.find((n) => n.text.startsWith("Please leave"));
  assert.equal(old.status, "replaced"); assert.match(old.replacedBy, /fine again/); assert.equal(old.rule.name, "Tomás");
  assert.deepEqual(memory.rules(P, at("2026-10-21")), [], "the rule went with the note");
  const r = await memory.recall(P, "Is there anyone the player does not want to play with? Tomás", { k: 4, min: -1, now: at("2026-10-21") });
  assert.ok(!r.notes.some((n) => n.note.startsWith("Please leave")), "a replaced note is never recalled");
  assert.ok(r.notes.some((n) => /fine again/.test(n.note)));
  // a weekday off with a last day: kept until then, expired after
  reply = { op: "add", replaces: [], rule: { kind: "avoid_day", day: "Fri" }, until: "2026-10-30" };
  await memory.remember(P, [{ text: "No games on Fridays until 30 October, I have evening classes.", kind: "said", at: at("2026-10-05") }]);
  assert.deepEqual(memory.rules(P, at("2026-10-25")).map((x) => [x.kind, x.day, x.until]), [["avoid_day", "Fri", "2026-10-30"]]);
  assert.deepEqual(memory.rules(P, at("2026-11-02")), []);
  assert.equal(memory.list(P, at("2026-11-02")).find((n) => /Fridays/.test(n.text)).status, "expired");
  // append-only (the baseline): every note recalled, no rules
  process.env.MEMORY_CONSOLIDATE = "off";
  const all = await memory.recall(P, "Is there anyone the player does not want to play with? Tomás", { k: 6, min: -1, now: at("2026-10-21") });
  assert.ok(all.notes.some((n) => n.note.startsWith("Please leave")));
  assert.deepEqual(memory.rules(P, at("2026-10-25")), []);
  delete process.env.MEMORY_CONSOLIDATE;
});

test("forgetting what was said about one member, or one topic, and nothing else", async () => {
  const P = "unit-p2";
  reply = null;
  for (const [t, d] of [["Leave Tomás out of my games for now.", "2026-10-01"], ["Tomás showed me his new racket.", "2026-10-02"], ["Riverside's courts are slippery when it rains.", "2026-10-03"],
    ["Riverside has the cheapest courts.", "2026-10-04"], ["Kenji always pushes me.", "2026-10-05"], ["My knee feels better after an hour.", "2026-10-06"]]) await memory.remember(P, [{ text: t, kind: "said", at: at(d) }]);
  let r = await memory.forgetAbout(P, "what I said about Tomas");
  assert.equal(r.by, "member"); assert.deepEqual(r.deleted.map((n) => n.text).sort(), ["Leave Tomás out of my games for now.", "Tomás showed me his new racket."]);
  r = await memory.forgetAbout(P, "Riverside");
  assert.deepEqual(r.deleted.map((n) => n.text).sort(), ["Riverside has the cheapest courts.", "Riverside's courts are slippery when it rains."]);
  assert.deepEqual(memory.list(P).map((n) => n.text).sort(), ["Kenji always pushes me.", "My knee feels better after an hour."]);
  r = await memory.forgetAbout(P, "tennis"); assert.equal(r.deleted.length, 0);
  r = await memory.forgetAbout(P, "my knee"); assert.deepEqual(r.deleted.map((n) => n.text), ["My knee feels better after an hour."]);
});

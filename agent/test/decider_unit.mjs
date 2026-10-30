// Unit tests for the one-pass decider (src/decider.js, A2A_DECIDER=raw in a2a.js), on a stand-in for Ollama that answers
// /api/generate with the next token's probabilities and /api/chat with a full answer: no model, no GPU.
//   node --test test/decider_unit.mjs        (npm test runs it with test/unit.mjs)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

// the stand-in: `next` is the next token's top alternatives it gives (token and probability); what it was asked is kept
const seen = { generate: [], chat: 0 };
let next = [];
const srv = http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    const j = JSON.parse(b || "{}"), send = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.url === "/api/generate") {
      seen.generate.push(j);
      const top = next.map(([token, p]) => ({ token, logprob: Math.log(p) }));
      return send({ model: j.model, response: top[0]?.token || "", done: true, done_reason: "length", prompt_eval_count: 300, eval_count: 1, logprobs: [{ token: top[0]?.token || "", logprob: top[0]?.logprob ?? 0, top_logprobs: top }] });
    }
    seen.chat++;
    send({ model: j.model, message: { role: "assistant", content: JSON.stringify({ intent: "counter", date: "2026-11-28", start: "10:00", works: ["t5"] }) }, done: true, done_reason: "stop", prompt_eval_count: 400, eval_count: 300, eval_duration: 1e9 });
  });
});
await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "serve-decider-"));
Object.assign(process.env, { A2A_STUDENT: "off", LLM_URL: `http://127.0.0.1:${srv.address().port}/v1`, LLM_MODEL: "muse-glimmer", BOOKINGS_FILE: `${tmp}/bookings.json`, A2A_FILE: `${tmp}/a2a.json`, NEGOTIATIONS_FILE: `${tmp}/neg.json`, LEDGER_FILE: `${tmp}/ledger.jsonl`, TRACE_FILE: `${tmp}/traces.jsonl`, A2A_LEASE: "off" });
const { readOptions, decisionPrompt } = await import("../src/decider.js");
const { fullAnswer } = await import("../src/a2a.js");
test.after(() => srv.close());

const opts = [{ id: "A" }, { id: "B" }, { id: "C" }, { id: "Z" }];
test("the options' probabilities are read from the next token: a letter's spellings add up, other words do not count", () => {
  const r = readOptions([{ token: " B", logprob: Math.log(0.5) }, { token: "B", logprob: Math.log(0.2) }, { token: " A", logprob: Math.log(0.1) }, { token: " Be", logprob: Math.log(0.15) }, { token: " D", logprob: Math.log(0.05) }], opts);
  assert.equal(r.pick.id, "B");
  assert.equal(r.p, 0.875, "0.7 of the 0.8 the options had");
  assert.equal(r.mass, 0.8, "\" Be\" is not B, and D is not an option");
  assert.deepEqual(readOptions([{ token: " The", logprob: Math.log(0.9) }], opts), { pick: null, p: null, mass: 0, dist: {} }, "no option in the top tokens: no pick");
});

test("the question: one letter per time that works, in the order listed, Z last, closing on the answer cue", () => {
  const times = [{ text: "Thu 26 Nov 19:00" }, { text: "Sat 28 Nov 09:00" }];
  const { text, opts: o } = decisionPrompt({ profile: "You are Mira Okafor's agent.", rule: "Decide by this rule.", them: "Mira", sport: "badminton", format: "singles", cur: "Thu 26 Nov 20:30", why: "it ends after 21:30", times, variant: "cue" });
  assert.deepEqual(o.map((x) => x.id), ["A", "B", "Z"]);
  assert.match(text, /A\. Thu 26 Nov 19:00\nB\. Sat 28 Nov 09:00\nZ\. Mira can't play this week/);
  assert.match(text, /That time does not work for Mira \(it ends after 21:30\)/);
  assert.ok(text.endsWith("Answer:"));
});

// Mira: free Thursday evening and Saturday morning, home by half past nine. The proposed time ends at 22:00.
// (her only limit is a rule in code, so what the facts decide is routed without a model: rulesComplete)
const mira = { id: "mira", name: "Mira Okafor", free: ["Thu 18-22", "Sat 09-12"], rules: { endBy: "21:30" }, rulesComplete: true };
const t = (id, day, date, start) => ({ id, slot: { day, date }, start, text: `${day} ${Math.floor(start / 60)}:${String(start % 60).padStart(2, "0")}` });
const a = t("t1", "Thu", "2026-11-26", 19 * 60), b = t("t2", "Thu", "2026-11-26", 20 * 60 + 30), c = t("t3", "Sat", "2026-11-28", 9 * 60), d = t("t4", "Fri", "2026-11-27", 19 * 60), e = t("t5", "Sat", "2026-11-28", 10 * 60);
const ask = () => fullAnswer(mira, b, [a, b, c, d, e], [], "singles", "badminton", 90);
const reset = (top) => { next = top; seen.generate = []; seen.chat = 0; };

test("A2A_DECIDER=raw: a sure pick between the times that work is the counter, in one pass of one token", async () => {
  process.env.A2A_DECIDER = "raw"; delete process.env.A2A_DECIDER_SURE;
  reset([[" B", 0.95], [" A", 0.04], [" Z", 0.01]]);
  const j = await ask();
  assert.equal(j.intent, "counter"); assert.equal(j.tier, "decider"); assert.equal(j.date, "2026-11-28"); assert.equal(j.start, "09:00");
  assert.deepEqual(j.works, ["t1", "t3", "t5"], "the times that work are the ones code kept");
  assert.equal(j.confidence, 0.95);
  assert.equal(seen.chat, 0, "the full answer was not asked");
  assert.equal(seen.generate.length, 1);
  const g = seen.generate[0];
  assert.equal(g.raw, true); assert.equal(g.options.num_predict, 1); assert.equal(g.options.temperature, 0); assert.equal(g.logprobs, true);
  assert.match(g.prompt, /A\. Thu 19:00\nB\. Sat 9:00\nC\. Sat 10:00\nZ\./, "only the times that keep the calendar and the rules are options");
});

test("not sure, or not this week: the full answer decides", async () => {
  process.env.A2A_DECIDER = "raw";
  reset([[" A", 0.5], [" B", 0.45]]);
  let j = await ask();
  assert.equal(j.tier, "agent"); assert.equal(seen.chat, 1); assert.equal(j.start, "10:00");
  reset([[" Z", 0.99]]);
  j = await ask();
  assert.equal(j.tier, "agent", "a decline while times work is left to the full answer"); assert.equal(seen.chat, 1);
  process.env.A2A_DECIDER_SURE = "0.4";
  reset([[" A", 0.5], [" B", 0.45]]);
  j = await ask();
  assert.equal(j.tier, "decider"); assert.equal(j.start, "19:00", "A2A_DECIDER_SURE sets the threshold");
  delete process.env.A2A_DECIDER_SURE;
});

test("the decider is asked only for a choice between times, and only when on", async () => {
  process.env.A2A_DECIDER = "raw";
  reset([[" B", 0.95]]);
  const yes = await fullAnswer(mira, a, [a, b, c, d, e], [], "singles", "badminton", 90);
  assert.equal(yes.intent, "accept"); assert.equal(yes.tier, "rules");
  const one = await fullAnswer(mira, b, [b, c, d], [], "singles", "badminton", 90);
  assert.equal(one.intent, "counter"); assert.equal(one.tier, "rules");
  assert.equal(seen.generate.length, 0, "what the facts decide is not asked");
  delete process.env.A2A_DECIDER;
  const j = await ask();
  assert.equal(j.tier, "agent"); assert.equal(seen.generate.length, 0, "off by default");
});

// Runs the member agents (a2a.js) on the labeled decision set (test/sim/decisions.json): System 1, the quick pick, at
// several reasoning budgets, and System 2, the full agent, at several budgets. Every answer is graded against the
// case's right answer, and its cost is taken from the token ledger. The raw results go to a file that
// test/cascade_analysis.mjs reads (accuracy with confidence intervals, the budget each system needs, calibration, the
// threshold for the cascade, and the cascade on held-out members). Done results are kept, so a run can be resumed.
//   node test/cascade_eval.mjs [raw.json] [s1 budgets, e.g. 150,300,600] [s2 budgets, e.g. 100,250,500,900]
import fs from "node:fs";
// the model's own answers are what this tests: code does not answer the calendar's questions for it
process.env.A2A_ROUTE ||= "off"; process.env.A2A_STUDENT ||= "off";

process.env.LEDGER_FILE ||= "data/cascade-ledger.jsonl";
process.env.A2A_FILE ||= "data/cascade-a2a.json"; process.env.NEGOTIATIONS_FILE ||= "data/cascade-negotiations.json"; process.env.TRACE_FILE ||= "data/cascade-traces.jsonl";
const RAW = process.argv[2] || "data/cascade_raw.json";
const S1 = (process.argv[3] || "150,300,600").split(",").map(Number), S2 = (process.argv[4] || "100,250,500,900").split(",").map(Number);
const { BUDGETS } = await import("../src/llm.js");
const ledger = await import("../src/ledger.js");
const { quickPick, fullAnswer } = await import("../src/a2a.js");
const cases = JSON.parse(fs.readFileSync(new URL("./sim/decisions.json", import.meta.url), "utf8"));
const done = fs.existsSync(RAW) ? JSON.parse(fs.readFileSync(RAW, "utf8")) : [];
const have = new Set(done.map((r) => `${r.system}|${r.budget}|${r.id}`));
const toMin = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const offer = (t) => ({ slot: { date: t.date, day: t.day }, start: toMin(t.start), text: t.text });

// what an answer means as an option id: A yes, B to D the time asked for, Z no; "?" a time that is not listed
function idOf(c, r) {
  if (r.intent === "accept") return "A";
  if (r.intent === "decline") return "Z";
  if (r.intent === "counter") { const i = c.alts.findIndex((t) => t.date === r.date && t.start === r.start); return i >= 0 ? "BCD"[i] : "?"; }
  return "none";
}
async function one(system, budget, c) {
  const m = c.member, cur = offer(c.cur), choices = [cur, ...c.alts.map(offer)];
  BUDGETS[system === "s1" ? "a2a.pick" : "a2a.answer"] = budget;
  return ledger.job("case", async (j) => {
    const t0 = Date.now();
    let pred = "none", conf = null;
    try {
      if (system === "s1") { const { q } = await quickPick(m, cur, choices, [], c.format, c.sport); pred = q.pick || "none"; conf = q.confidence; }
      else pred = idOf(c, await fullAnswer(m, cur, choices, [], c.format, c.sport));
    } catch (e) { pred = "error"; }
    const t = ledger.totals(j.calls);
    return { system, budget, id: c.id, member: m.name, gold: c.gold, pred, correct: pred === c.gold, conf, prompt: t.prompt, cached: t.cached, output: t.output, reasoning: t.reasoning, seconds: +((Date.now() - t0) / 1000).toFixed(2), calls: t.calls, empty: t.empty };
  });
}
// four at a time: the model server's parallel slots. Budgets are set per call site, and every case of a batch shares
// one system and budget, so a batch never mixes budgets.
async function pool(items, n, fn) { const out = []; let k = 0; await Promise.all(Array.from({ length: n }, async () => { while (k < items.length) { const i = k++; out[i] = await fn(items[i]); } })); return out; }
const plan = [...S1.map((b) => ["s1", b]), ...S2.map((b) => ["s2", b])];
for (const [system, budget] of plan) {
  const todo = cases.filter((c) => !have.has(`${system}|${budget}|${c.id}`));
  if (!todo.length) continue;
  const t0 = Date.now();
  const rows = await pool(todo, 4, (c) => one(system, budget, c));
  done.push(...rows); fs.writeFileSync(RAW, JSON.stringify(done));
  const right = rows.filter((r) => r.correct).length;
  console.log(JSON.stringify({ system, budget, cases: rows.length, right, accuracy: +(right / rows.length).toFixed(3), outputPerCase: Math.round(rows.reduce((a, r) => a + r.output, 0) / rows.length), secondsPerCase: +(rows.reduce((a, r) => a + r.seconds, 0) / rows.length).toFixed(1), empty: rows.filter((r) => r.empty).length, minutes: +((Date.now() - t0) / 60000).toFixed(1) }));
}
console.log("CASCADE_DONE");

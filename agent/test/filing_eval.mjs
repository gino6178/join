// Accuracy against reasoning budget for the two filing calls, on the labeled messages (test/sim/messages.json):
// life.read (calendar entry, finished session, or chat; the entry's start time; the session's minutes) and body.read
// (part, side and level, and whether the model or the word list read it). Raw rows in the same shape as
// test/cascade_eval.mjs's, so test/cascade_analysis.mjs's intervals and non-inferiority test apply.
//   node test/filing_eval.mjs [raw.json] [budgets, e.g. 100,250,500,900]
import fs from "node:fs";

process.env.LEDGER_FILE ||= "data/filing-ledger.jsonl";
process.env.TRACE_FILE ||= "data/filing-traces.jsonl";
const RAW = process.argv[2] || "data/filing_raw.json", LEVELS = (process.argv[3] || "100,250,500,900").split(",").map(Number);
const { BUDGETS } = await import("../src/llm.js");
const ledger = await import("../src/ledger.js");
const life = await import("../src/life.js");
const body = await import("../src/body.js");
const { filing, body: hurts } = JSON.parse(fs.readFileSync(new URL("./sim/messages.json", import.meta.url), "utf8"));
const done = fs.existsSync(RAW) ? JSON.parse(fs.readFileSync(RAW, "utf8")) : [];
const have = new Set(done.map((r) => `${r.system}|${r.budget}|${r.id}`));
const now = new Date("2026-11-02T09:00:00");

const SITES = {
  "life.read": { cases: filing, run: (c) => life.read(c.text, now), right: (c, r) => r.intent === c.intent && (c.intent !== "event" || r.events.some((e) => e.start === c.start)) && (c.intent !== "log" || +r.log.minutes === c.minutes) },
  "body.read": { cases: hurts, run: (c) => body.read(c.text, now), right: (c, r) => r.entries.some((e) => e.part === c.part && (c.side == null || e.side === c.side) && e.level === c.level), model: (r) => r.by === "model" },
};
async function pool(items, n, fn) { const out = []; let k = 0; await Promise.all(Array.from({ length: n }, async () => { while (k < items.length) { const i = k++; out[i] = await fn(items[i]); } })); return out; }
for (const budget of LEVELS) for (const [site, x] of Object.entries(SITES)) {
  const todo = x.cases.filter((c) => !have.has(`${site}|${budget}|${c.id}`));
  if (!todo.length) continue;
  BUDGETS[site] = budget;
  const rows = await pool(todo, 4, (c) => ledger.job("case", async (j) => {
    const t0 = Date.now(); let r = null;
    try { r = await x.run(c); } catch { /* graded wrong */ }
    const t = ledger.totals(j.calls.filter((k) => k.site === site));
    return { system: site, budget, id: c.id, member: c.id, correct: !!r && x.right(c, r), byModel: x.model ? !!r && x.model(r) : null, conf: null, pred: r ? (r.intent || r.by) : "error",
      prompt: t.prompt, output: t.output, reasoning: t.reasoning, seconds: +((Date.now() - t0) / 1000).toFixed(2), calls: t.calls, empty: t.empty };
  }));
  done.push(...rows); fs.writeFileSync(RAW, JSON.stringify(done));
  console.log(JSON.stringify({ site, budget, cases: rows.length, right: rows.filter((r) => r.correct).length, byModel: x.model ? rows.filter((r) => r.byModel).length : undefined, outputPerCase: Math.round(rows.reduce((a, r) => a + r.output, 0) / rows.length), empty: rows.reduce((a, r) => a + r.empty, 0) }));
}
console.log("FILING_DONE");

// Muse Glimmer in practice: what the token ledger says about how the model behaves at each call site, over the
// evaluations' ledgers (every model call they made): how many calls, how much it reads and writes, how much of what it
// writes is reasoning, how often a reply comes back empty (it reasoned past its budget), how often a reply does not fit
// its JSON Schema the first time (and is asked again), how often a tool call's arguments do not fit, and how long a
// call takes.  node test/glimmer_report.mjs data/eval-ledger.jsonl data/persona-ledger.jsonl ... > glimmer_in_practice.json
import fs from "node:fs";

const files = process.argv.slice(2).filter((f) => fs.existsSync(f));
const rows = files.flatMap((f) => fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean));
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1) : null; };
const by = {};
for (const r of rows) (by[r.site] ||= []).push(r);
const sites = Object.entries(by).map(([site, rs]) => {
  const calls = rs.filter((r) => !r.marker), marks = rs.filter((r) => r.marker);
  const sum = (k) => calls.reduce((a, r) => a + (r[k] || 0), 0);
  return { site, calls: calls.length, promptPerCall: Math.round(sum("prompt") / Math.max(1, calls.length)), cachedShare: sum("prompt") ? +(sum("cached") / sum("prompt")).toFixed(2) : 0,
    outputPerCall: Math.round(sum("output") / Math.max(1, calls.length)), reasoningShare: sum("output") ? +(sum("reasoning") / sum("output")).toFixed(2) : 0,
    empty: calls.filter((r) => r.empty).length, notFittingSchema: marks.length, schemaCalls: calls.filter((r) => r.format).length, toolCallsWithBadArgs: calls.reduce((a, r) => a + (r.invalidCalls || 0), 0),
    secondsP50: q(calls.map((r) => r.seconds), 0.5), secondsP95: q(calls.map((r) => r.seconds), 0.95) };
}).filter((s) => s.calls).sort((a, b) => b.calls - a.calls);
const all = rows.filter((r) => !r.marker);
console.log(JSON.stringify({ at: new Date().toISOString(), ledgers: files, calls: all.length, emptyShare: +(all.filter((r) => r.empty).length / Math.max(1, all.length)).toFixed(3),
  reasoningShare: +(all.reduce((a, r) => a + (r.reasoning || 0), 0) / Math.max(1, all.reduce((a, r) => a + (r.output || 0), 0))).toFixed(2), sites }, null, 1));

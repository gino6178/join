// The token ledger: every model call, with the call site it came from, the job it was part of and what it cost.
//   prompt     tokens the model read (Ollama's prompt_eval_count, cached ones included)
//   cached     of those, how many the server reused from an earlier call with the same prefix (prompt_eval_cached_count)
//   output     tokens the model wrote: the reply and its hidden reasoning together (eval_count)
//   reasoning  the reasoning's share of output, estimated from the length of the reasoning text against the reply
//   empty      the call came back with no reply and no tool call (reasoning used up the budget, or the model stalled)
// A job (one Autopilot run, one negotiation) is a scope: job(name, fn) runs fn, and every call made inside it, however
// deep and however parallel, is added to that job and to the jobs around it (Node's AsyncLocalStorage carries the
// scope across awaits). Calls are kept in memory for /api/ledger and appended to data/ledger.jsonl.
import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

const FILE = path.resolve(process.env.LEDGER_FILE || "data/ledger.jsonl");
const scope = new AsyncLocalStorage();
const recent = [];
let seq = 0;

export function job(name, fn) {
  const j = { name, id: `${name}-${Date.now().toString(36)}-${++seq}`, calls: [], parent: scope.getStore() || null };
  return scope.run(j, () => fn(j));
}
export const current = () => scope.getStore() || null;

export function record(call) {
  const j = scope.getStore(), row = { at: Date.now(), ...call, job: j?.id || null };
  recent.push(row); if (recent.length > 3000) recent.shift();
  for (let x = j; x; x = x.parent) x.calls.push(row);
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.appendFileSync(FILE, JSON.stringify(row) + "\n"); } catch { /* the ledger never stops a call */ }
  return row;
}

// totals over a list of calls: what a job, a call site or a whole eval run cost
export function totals(calls = []) {
  const sum = (k) => calls.reduce((a, c) => a + (c[k] || 0), 0);
  const prompt = sum("prompt"), cached = sum("cached");
  // (a marker row, for a reply that did not fit its format, counts as invalid but is not a call)
  return { calls: calls.filter((c) => !c.marker).length, prompt, cached, fresh: prompt - cached, cachedShare: prompt ? +(cached / prompt).toFixed(3) : 0, output: sum("output"), reasoning: sum("reasoning"),
    seconds: +sum("seconds").toFixed(1), empty: calls.filter((c) => c.empty).length, invalid: calls.filter((c) => c.invalid).length };
}
// per call site, most expensive first
export function bySite(calls = recent) {
  const g = {};
  for (const c of calls) (g[c.site] ||= []).push(c);
  return Object.entries(g).map(([site, cs]) => ({ site, ...totals(cs), perCall: ((t, n) => ({ prompt: Math.round(t.prompt / n), output: Math.round(t.output / n), seconds: +(t.seconds / n).toFixed(1) }))(totals(cs), Math.max(1, totals(cs).calls)) }))
    .sort((a, b) => b.seconds - a.seconds);
}
export const calls = (n = 200) => recent.slice(-n);

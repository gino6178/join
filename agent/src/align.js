// The goal check: before an agent acts for someone, does what it did still serve what it was asked to do?
//   Meta's LlamaFirewall (MIT) and its AlignmentCheck scanner, run by align_worker.py on Muse Glimmer: it reads the
//   goal (the player's request, or the reading agent's task) and the agent's actions as plain text (each tool call,
//   its reason and what it returned), and says whether the action about to be taken still serves the goal.
//   Used before the Autopilot asks the player to approve its plan (autopilot.js), and before the club's reading agent
//   publishes a paper post (feed/papers.js).
// Fail-closed: a check that did not run (no worker, no answer in time, no verdict) counts as "not aligned", so the
// Autopilot's plan becomes a draft for the player to look at and the paper post waits. ALIGN_CHECK=off turns it off;
// it is on by default where its model endpoint is set (ALIGN_URL), and ALIGN_CHECK=on uses LLM_URL when ALIGN_URL is
// not set. Every check is a ledger row (site, seconds, verdict; never the text). Measured in test/align_eval.mjs
// (docs/security.md, "Goal check").
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { record } from "./ledger.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const endpoint = () => process.env.ALIGN_URL || (process.env.ALIGN_CHECK === "on" ? process.env.LLM_URL || "" : "");
export const alignOn = () => process.env.ALIGN_CHECK !== "off" && (process.env.ALIGN_CHECK === "on" || !!process.env.ALIGN_URL) && !!endpoint();
const MODEL = () => process.env.ALIGN_MODEL || process.env.LLM_MODEL || "muse-glimmer";
// checked: the model gave a verdict; flagged: of those, not aligned; failed: the check did not run (also not aligned)
export const stats = { checked: 0, flagged: 0, failed: 0 };

// A worker's answer line, read by the fail-closed rule: aligned only when the line is JSON, says checked, and says
// aligned: true. Anything else (an error, no verdict, a line that is not JSON, no line at all) is not aligned.
export function verdictOf(line) {
  let j = null;
  try { j = typeof line === "string" ? JSON.parse(line) : line; } catch { /* not JSON */ }
  if (!j || typeof j !== "object") return { aligned: false, checked: false, error: "no answer from the goal check" };
  const checked = j.checked === true && typeof j.aligned === "boolean" && !j.error;
  return { aligned: checked && j.aligned === true, checked, ...(j.decision ? { decision: j.decision } : {}), ...(j.seconds != null ? { modelSeconds: +j.seconds } : {}),
    tokens: { prompt: j.tokens?.prompt || 0, output: j.tokens?.output || 0 }, ...(checked ? {} : { error: String(j.error || "no verdict").slice(0, 160) }), ...(j.reason ? { reason: String(j.reason).slice(0, 600) } : {}) };
}

// one worker, kept running; requests carry an id, so an answer that comes after its request timed out is dropped.
// Each worker has its own requests waiting (a worker stopped, or one that died, answers only its own with an error)
let worker = null, seq = 0;
function workerUp() {
  if (worker) return worker;
  const py = process.env.ALIGN_PYTHON || path.resolve("../attack/lfenv/bin/python"), script = process.env.ALIGN_WORKER || path.join(HERE, "align_worker.py");
  if (!fs.existsSync(py)) throw new Error(`no Python for the goal check at ${py}`);
  let w;
  // -I: the worker's own directory and the current one are not on Python's path (it imports only the venv's packages)
  const args = /\.py$/.test(script) ? ["-I", script] : [script];
  try {
    w = spawn(py, args, { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, ALIGN_URL: endpoint(), ALIGN_MODEL: MODEL(), CUDA_VISIBLE_DEVICES: "" } });
  } catch (e) { throw new Error(`the goal check did not start (${String(e.code || e.message).slice(0, 80)})`); }
  worker = w;
  const waiting = w.waiting = new Map();
  let buf = "";
  const stop = (why) => { if (worker === w) worker = null; for (const [k, f] of waiting) { waiting.delete(k); f(JSON.stringify({ id: k, error: why })); } };
  w.stdout.on("data", (d) => {
    buf += d;
    for (let i; (i = buf.indexOf("\n")) >= 0;) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let id = null; try { id = JSON.parse(line).id; } catch { /* not JSON: dropped */ }
      const f = waiting.get(id); if (f) { waiting.delete(id); f(line); }
    }
  });
  w.on("error", (e) => stop(`the goal check did not start (${e.code || e.message})`));
  w.stdin.on("error", () => {});
  w.on("exit", () => stop("the goal check stopped"));
  return w;
}
export function stopWorker() { const w = worker; worker = null; w?.kill(); }

// The check. goal: the request, in words; actions: [{ action, input, thought, result }], the last one the action about
// to be taken. Returns { aligned, checked, seconds, ... }, or { aligned: true, off: true } when the check is off.
export async function check({ goal, actions = [], site = "align", timeoutMs = +(process.env.ALIGN_TIMEOUT_MS || 120000) } = {}) {
  if (!alignOn()) return { aligned: true, checked: false, off: true };
  const t0 = Date.now(), id = ++seq;
  let timer, v, w = null;
  try {
    w = workerUp();
    const line = await Promise.race([new Promise((ok) => { w.waiting.set(id, ok); w.stdin.write(JSON.stringify({ id, goal: String(goal || ""), actions }) + "\n"); }),
      new Promise((_, no) => { timer = setTimeout(() => no(new Error("the goal check did not answer in time")), timeoutMs); })]);
    v = verdictOf(line);
  } catch (e) {
    w?.waiting?.delete(id);
    if (w && worker === w && /in time/.test(e.message)) stopWorker(); // a worker that stopped answering is started again next time
    v = { aligned: false, checked: false, error: String(e.message || e).slice(0, 160), tokens: { prompt: 0, output: 0 } };
  } finally { clearTimeout(timer); }
  const seconds = (Date.now() - t0) / 1000;
  if (v.checked) { stats.checked++; if (!v.aligned) stats.flagged++; } else stats.failed++;
  const verdict = !v.checked ? "failed" : v.aligned ? "aligned" : "misaligned";
  record({ site, model: MODEL(), prompt: v.tokens.prompt, cached: 0, output: v.tokens.output, reasoning: 0, seconds, align: verdict, marker: true });
  return { ...v, verdict, seconds: +seconds.toFixed(2) };
}

// An agent's tool calls as AlignmentCheck reads them: the tool, its arguments (the reason apart, as its thought), and
// what it returned, in one line of plain text each.
export function actionsOf(trail = [], resultOf = () => "") {
  return trail.map((t) => {
    const { reason, ...input } = t.args || {};
    let result = "";
    try { result = String(resultOf(t) || ""); } catch { result = t.res?.error ? `refused: ${t.res.error}` : ""; }
    return { action: t.name, input, thought: [reason, t.by && t.by !== "model" ? `(run by ${t.by})` : ""].filter(Boolean).join(" "), result: result.slice(0, 600) };
  });
}

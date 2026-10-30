// The builder's work, for the maintainer's page (#/maintain): an approved C1-C3 proposal is built on its own branch
// (builder.js), the gates run on that branch (gates.js), and everything the maintainer needs before their next
// decision is kept here: the branch, every attempt (how it ended, what it changed, the unit tests, refused writes), the
// diff, the gates that passed and failed, and why it stopped if it did. The gateway serves it behind the maintainer's
// token (GET /api/loop/builds, POST /api/loop/build). One build at a time; it runs in the background.
//   The proposal's status follows: approved -> building -> gated (the gates passed) or back to approved, with the
//   reasons (the build stopped, or a gate failed), so it can be built again; refused by the rules when the builder
//   refuses the spec itself (a file on the never-list, the review's no).
//   The gates run after a build are LOOP_BUILD_GATES (comma list, or "all"); by default the ones that need no GPU
//   (policy, scan, unit, oracle, privacy). The suites on the GPU (crash matrix, red team, end to end, the Autopilot
//   eval) are named as not run, for the maintainer to run (test/loop_gates.mjs).
// Nothing here merges, pushes or deploys: the maintainer does, outside the app.
import path from "node:path";
import { readJSON, writeJSON } from "../jsonfile.js";
import * as proposals from "./proposals.js";
import { DIR } from "./signals.js";

const FILE = () => path.resolve(process.env.LOOP_BUILDS_FILE || path.join(DIR, "builds.json"));
export const ALL_GATES = ["policy", "scan", "unit", "crash_matrix", "redteam", "e2e", "autopilot_eval", "oracle", "privacy"];
export const NO_GPU = ["policy", "scan", "unit", "oracle", "privacy"];
export const gatesWanted = () => { const v = String(process.env.LOOP_BUILD_GATES || "").trim(); return !v ? NO_GPU : v === "all" ? ALL_GATES : v.split(",").map((s) => s.trim()).filter((g) => ALL_GATES.includes(g)); };
const DIFF_MAX = 120000;
let db = null, running = null;
const read = () => (db ||= readJSON(FILE(), {}));
const save = () => writeJSON(FILE(), read());
const put = (id, patch) => { const d = read(); d[id] = { ...(d[id] || {}), ...patch, at: Date.now() }; save(); return d[id]; };

// an attempt as the page shows it: how it ended and what it did (its own diff stays out: the build's is the one)
const WHY = { done: "finished with done", steps: "ran out of steps", tokens: "used up its token budget", stalled: "the model stopped calling tools", "model-error": "the model server did not answer", verify: "the spec's own check failed", "build-tokens": "the build's token budget ran out" };
const attemptOf = (a) => ({ n: a.n, ok: !!a.ok, end: a.end, why: WHY[a.end] || a.end, steps: a.steps ?? null, toolCalls: a.toolCalls ?? 0, changed: a.changed || [], unit: a.unit || null,
  refused: (a.refused || []).map(({ tool, path: p, kind, reason }) => ({ tool, path: p, kind, reason })), verify: a.verify ? { ok: !!a.verify.ok, output: String(a.verify.output || "").slice(0, 1500) } : null,
  tokens: a.tokens ? { prompt: a.tokens.prompt || 0, output: a.tokens.output || 0 } : null, seconds: a.seconds ?? null, summary: a.summary || null });

// a build that was running when the gateway stopped did not finish: it says so, and its proposal can be built again
function settleStale() {
  for (const [id, b] of Object.entries(read())) {
    if (b.status !== "building" || running === id) continue;
    put(id, { status: "stopped", finishedAt: Date.now(), reasons: [...(b.reasons || []), "the gateway stopped during the build; nothing was merged"] });
    try { if (proposals.get(id)?.status === "building") proposals.annotate(id, { status: "approved", reasons: ["the build stopped when the gateway restarted; build it again"] }); } catch { /* the proposal is gone */ }
  }
}
export function list() { settleStale(); return read(); }
export const get = (id) => list()[id] || null;

// why a proposal can't be built now, or null
export function refusal(spec) {
  if (!spec) return { code: 404, error: "no such proposal" };
  if (!["C1", "C2", "C3"].includes(spec.change?.class)) return { code: 409, error: spec.change?.class === "C0" ? "a C0 change is a flag value: it ships by code, not through the builder" : `class ${spec.change?.class} is not C1, C2 or C3` };
  if (spec.status !== "approved") return { code: 409, error: `it is ${spec.status}: only an approved proposal is built` };
  if (running) return { code: 409, error: `the builder is busy with ${running}` };
  return null;
}

// start the build in the background and return its record at once. deps (tests): build, runGates, only
export function start(id, deps = {}) {
  settleStale();
  const spec = proposals.get(id), no = refusal(spec), prev = read()[id] || null;
  if (no) return no;
  running = id;
  const only = deps.only || gatesWanted();
  const rec = put(id, { proposal: id, status: "building", phase: "build", startedAt: Date.now(), finishedAt: null, attempt: 1, attempts: [], branch: null, commit: null, diff: "", stat: "", gates: null,
    gatesRun: only, gatesNotRun: ALL_GATES.filter((g) => !only.includes(g)), reasons: [], class: spec.change.class, files: spec.change.files || [] });
  proposals.setStatus(id, "building", [`the builder is working on loop/${id}`], "code");
  // building again (only an approved proposal is built: a gated one keeps its branch): the last build's branch and
  // worktree are replaced
  const done = run(id, { ...spec, status: "approved" }, only, { ...deps, replace: deps.replace ?? !!prev }).catch((e) => finish(id, { status: "failed", reasons: [`the build stopped: ${String(e.message || e).slice(0, 300)}`] }, "approved")).finally(() => { running = null; });
  if (deps.wait) return done.then(() => get(id));
  return rec;
}
// (back to approved is not a decision: the maintainer's approval stays the last one on record, as the review reads it
// (review.approvedByMaintainer), so the proposal can be built again; the build's record says what happened)
function finish(id, patch, status, extra = {}, by = "code") {
  const b = put(id, { ...patch, finishedAt: Date.now() });
  try {
    if (status === "approved") proposals.annotate(id, { ...extra, status, reasons: b.reasons || [] });
    else proposals.setStatus(id, status, b.reasons?.length ? b.reasons : [], by, { extra });
  } catch { /* the proposal is gone */ }
  return b;
}
async function run(id, spec, only, deps) {
  const build = deps.build || (await import("./builder.js")).build;
  const r = await build(spec, { replace: !!deps.replace, onStep: (e) => {
    if (e.type === "attempt") put(id, { attempt: e.n });
    if (e.type === "attempt-end") put(id, { attempts: [...(get(id)?.attempts || []), attemptOf(e)] });
  } });
  const common = { attempts: (r.attempts || []).map(attemptOf), branch: r.branch || null, base: r.base || null, commit: r.commit || null, stat: r.stat || "",
    diff: String(r.diff || "").slice(0, DIFF_MAX), diffCut: String(r.diff || "").length > DIFF_MAX, summary: r.summary || null, baseUnit: r.baseUnit || null,
    tokens: r.tokens ? { prompt: r.tokens.prompt || 0, output: r.tokens.output || 0, calls: r.tokens.calls || 0 } : null, buildSeconds: r.seconds ?? null, endpoint: r.endpoint || null, lockWaitS: r.lockWaitS ?? null,
    infra: !!r.infra, refusedSpec: !!r.refused };
  // the builder refused the spec itself (the never-list, the review, a spec it can't build as written): the proposal is
  // refused by the rules, as the review refuses one; any other stop leaves it approved, to be built again
  if (!r.ok && r.refused && !(r.reasons || []).some((x) => /already exists/.test(x))) return finish(id, { ...common, status: "refused", phase: "build", reasons: r.reasons?.length ? r.reasons : ["the builder refused the spec"] }, "refused", { branch: null }, "rules");
  if (!r.ok) return finish(id, { ...common, status: "failed", phase: "build", reasons: r.reasons?.length ? r.reasons : ["the build did not finish"] }, "approved", { branch: null });
  put(id, { ...common, phase: "gates" });
  const runGates = deps.runGates || (await import("./gates.js")).runGates;
  let g;
  try { g = await runGates(spec, { branch: r.branch, only }); } catch (e) { g = { pass: false, results: [{ gate: "gates", ok: false, details: { error: String(e.message || e).slice(0, 200) } }] }; }
  const results = (g.results || []).map((x) => ({ gate: x.gate, ok: !!x.ok, details: x.details ?? null }));
  const passed = results.length > 0 && results.every((x) => x.ok);
  const gates = { pass: passed && only.length === ALL_GATES.length, subset: only.length < ALL_GATES.length ? only : null, subsetOk: passed, results };
  const failed = results.filter((x) => !x.ok).map((x) => `${x.gate} failed`);
  return finish(id, { status: "built", phase: "done", gates, reasons: passed ? (gates.subset ? [`passed ${only.join(", ")}; ${ALL_GATES.filter((x) => !only.includes(x)).join(", ")} are the maintainer's to run on the GPU`] : []) : failed },
    passed ? "gated" : "approved", { branch: r.branch, gates: { pass: gates.pass, subset: gates.subset, subsetOk: gates.subsetOk, results } });
}

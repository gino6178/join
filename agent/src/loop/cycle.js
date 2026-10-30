// One turn of the community loop, run by code (the gateway runs it nightly with LOOP_NIGHTLY=1; test/loop_eval.mjs runs
// it on the simulated club): cluster what members shared, draft a spec for each idea that has the support it needs,
// review it, run the gates on a C0 change and ship it to the beta canary, watch the flags and roll back on a breach,
// and re-measure what shipped. Nothing here merges or deploys code: a C1, C2 or C3 change waits for the maintainer,
// and after their yes the builder works on a branch the maintainer merges.
import * as signals from "./signals.js";
import * as proposals from "./proposals.js";
import { load } from "./parts.js";

// what the review recounts a spec's support from: the declared flags, the screened items, the clusters and the votes
export const context = () => ({ schema: proposals.declared(), items: signals.items(), clusters: proposals.clusters(), votes: proposals.voteList() });
// the review's verdict on a spec: refused (the never-list), approved (a C0 change with its support recounted, or one a
// maintainer approved that passes every gate), or waiting for the maintainer
export async function reviewSpec(spec, { now = Date.now(), diff = null } = {}) {
  const { review } = await load();
  let r;
  try { r = await review.check(spec, diff, context()); } catch (e) { r = { allowed: false, needs: "maintainer", reasons: [`the review failed (${String(e.message || e).slice(0, 100)})`], gates: [] }; }
  const extra = { review: { allowed: !!r.allowed, needs: r.needs, reasons: r.reasons || [], gates: r.gates || [], class: r.class || spec.change?.class, at: now } };
  if (r.needs === "never") return proposals.setStatus(spec.id, "refused", r.reasons, "rules", { now, extra });
  if (r.allowed && r.needs === "none" && spec.change?.class === "C0") return proposals.setStatus(spec.id, "approved", r.reasons, "rules", { now, extra });
  // (a maintainer's approval stays the last decision on record: the review only adds its verdict)
  if (r.allowed && spec.status === "approved") return proposals.annotate(spec.id, extra);
  // (a change that needs a file on the never-list says which, first: the drafter's files were checked before this)
  const own = spec.change?.blocked?.length ? (spec.change.classReasons || []).filter((x) => /on the never-list/.test(x)) : [];
  return proposals.setStatus(spec.id, "review", [...own, ...(r.reasons?.length ? r.reasons : ["needs the maintainer"])], "rules", { now, extra });
}

// the gates a C0 change passes here before it ships (LOOP_SHIP_GATES; all nine by default). The evaluation runs the
// ones that need no GPU and lists the rest for the maintainer, who runs them on the GPU (test/loop_gates.mjs)
export const shipGates = () => (process.env.LOOP_SHIP_GATES ? process.env.LOOP_SHIP_GATES.split(",").map((s) => s.trim()).filter(Boolean) : null);
// an approved C0 change: the gates, then the flag to the beta canary (the flags post the club's note when it is
// promoted to everyone, or rolled back)
export async function shipSpec(spec, { now = Date.now() } = {}) {
  const { gates, flags } = await load();
  // only what the review found to be C0 ships by code (the spec's own claim is not enough: it may be forged)
  if (spec.review?.class !== "C0" || spec.change?.class !== "C0") return proposals.setStatus(spec.id, "approved", [`not shipped by code: the review found ${spec.review?.class || "no class"}, and only C0 ships behind a flag`], "code", { now });
  let g;
  const only = shipGates();
  try { g = await gates.runGates(spec, only ? { only } : {}); } catch (e) { g = { pass: false, results: [{ gate: "gates", ok: false, details: String(e.message || e).slice(0, 120) }] }; }
  const passed = g.pass || (only && g.subsetOk === true && g.results.length > 0 && g.results.every((x) => x.ok));
  const brief = (x) => `${x.gate}: ${typeof x.details === "string" ? x.details : JSON.stringify(x.details).slice(0, 160)}`;
  if (!passed) return proposals.setStatus(spec.id, "approved", g.results.filter((x) => !x.ok).map(brief), "code", { now, extra: { gates: g } });
  let s = proposals.setStatus(spec.id, "gated", only ? [`passed ${only.join(", ")}; the GPU suites are the maintainer's to run`] : [], "code", { now, extra: { gates: g } });
  let r;
  try { r = await flags.ship(s, { now, gates: { pass: true } }); } catch (e) { r = { ok: false, reasons: [String(e.message || e).slice(0, 120)] }; }
  if (!r?.ok) return proposals.setStatus(spec.id, "gated", [`not shipped: ${(r?.reasons || ["the flags said no"]).join("; ")}`], "code", { now });
  return proposals.setStatus(spec.id, "shipped", [], "code", { now, extra: { shipped: { key: r.key, value: r.value, canary: r.canary, beta: r.beta, until: r.until, at: now } } });
}

export async function cycle({ now = Date.now(), embed = null, ship = true } = {}) {
  const parts = await load(), report = { at: now, stubs: parts.stubs, clusters: 0, shown: 0, drafted: [], approved: [], waiting: [], refused: [], shipped: [], breaches: [], errors: [] };
  // items that waited for a guard that was down are screened again first
  report.held = await signals.retryHeld({ now });
  const cs = await proposals.cluster(signals.items(), embed ? { embed } : {});
  if (cs.error) { report.errors.push(cs.error); return report; }
  report.clusters = cs.length; report.shown = cs.filter((c) => c.shown).length;
  for (const c of proposals.rank().filter((x) => x.eligible && !x.proposal)) {
    const spec = await proposals.draft(c, { now });
    if (spec.error) { report.errors.push(`${c.id}: ${spec.error}`); continue; }
    report.drafted.push(spec.id);
    const s = await reviewSpec(spec, { now });
    (s.status === "refused" ? report.refused : s.status === "approved" ? report.approved : report.waiting).push(s.id);
  }
  if (ship) for (const s of proposals.specs().filter((x) => x.status === "approved" && x.review?.class === "C0")) { const r = await shipSpec(s, { now }); if (r.status === "shipped") report.shipped.push(r.id); }
  report.breaches = await watch({ now });
  return report;
}

// the flags' monitor; a breach it handled turns the flag off, and its proposal is rolled back (hard) or reopened (soft)
export async function watch({ now = Date.now() } = {}) {
  const { flags } = await load();
  let out = [];
  try { out = (await flags.monitor({ now })) || []; } catch (e) { return [{ error: `monitor: ${String(e.message || e).slice(0, 120)}` }]; }
  for (const b of out) {
    const s = b.proposal && proposals.get(b.proposal);
    if (!s || !["shipped", "gated"].includes(s.status)) continue;
    // a canary that ran its window with no breach is on for everyone
    // promoted: on for every member; the cluster is measured again (how many members asked for it by now)
    if (b.kind === "promoted") { const c = proposals.clusters().find((x) => x.proposal === s.id); proposals.setStatus(s.id, "shipped", [`on for every member after a clean canary${b.reason ? ` (${b.reason})` : ""}`], "code", { now, extra: { shipped: { ...(s.shipped || {}), on: now, members: c?.members ?? null } } }); continue; }
    if (b.kind !== "hard" && b.kind !== "soft") continue;
    const why = `rolled back: ${b.reason || b.kind}`;
    if (b.kind === "soft") { proposals.setStatus(s.id, "rolledBack", [why], "code", { now }); proposals.setStatus(s.id, "open", [`reopened after a soft breach (${b.reason || "signals"})`], "code", { now }); }
    else proposals.setStatus(s.id, "rolledBack", [why], "code", { now });
  }
  return out;
}

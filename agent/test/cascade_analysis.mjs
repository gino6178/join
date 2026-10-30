// The analysis of test/cascade_eval.mjs's raw results.
//   1. Accuracy, tokens and seconds for each system (S1 the quick pick, S2 the full agent) at each reasoning budget,
//      with 95% intervals from a cluster bootstrap over members (one member's cases are not independent).
//   2. The budget each system needs: the smallest whose accuracy is non-inferior to the largest budget's, by a paired
//      cluster bootstrap of the difference against a 5-point margin.
//   3. Is S1's confidence calibrated: expected calibration error over 10 bins, the reliability table, and the
//      risk-coverage curve of answering only above a threshold (selective prediction).
//   4. The threshold, chosen on the calibration members only, by conformal risk control: the loss of a case is 1 when
//      S1 answers it alone (confidence at least the threshold) and is wrong. That loss can only fall as the threshold
//      rises, so the lowest threshold whose calibration risk R passes (n R + 1) / (n + 1) <= EPS bounds the expected
//      share of all cases S1 gets wrong by EPS on new members.
//   5. The cascade on the held-out test members: S1 answers above the threshold, S2 the rest. Its coverage, the error
//      rate of S1's own answers (exact Clopper-Pearson interval), overall accuracy and cost, against S2 alone.
//   node test/cascade_analysis.mjs raw.json out.json [EPS=0.05]
import fs from "node:fs";

const [RAW, OUT = "data/cascade_summary.json", EPS = "0.05"] = process.argv.slice(2);
const eps = +EPS, raw = JSON.parse(fs.readFileSync(RAW, "utf8"));
let seed = 11;
const rnd = () => { seed = (seed + 0x6d2b79f5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * s.length)))]; };
const r3 = (x) => +x.toFixed(3);
// members split in two by a hash of the name: calibration (threshold chosen here) and test (reported here)
const hash = (t) => [...t].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);
const half = (member) => (hash(member) % 2 ? "test" : "calibration");
const members = [...new Set(raw.map((r) => r.member))];

// a statistic over cases, resampling whole members
function bootstrap(rows, stat, reps = 2000) {
  const by = {}; for (const r of rows) (by[r.member] ||= []).push(r);
  const ms = Object.keys(by), out = [];
  for (let i = 0; i < reps; i++) { const pick = Array.from({ length: ms.length }, () => by[ms[Math.floor(rnd() * ms.length)]]).flat(); out.push(stat(pick)); }
  return [r3(q(out, 0.025)), r3(q(out, 0.975))];
}
const acc = (rows) => mean(rows.map((r) => (r.correct ? 1 : 0)));
const systems = [...new Set(raw.map((r) => `${r.system}|${r.budget}`))].map((k) => { const [system, budget] = k.split("|"); return { system, budget: +budget, rows: raw.filter((r) => r.system === system && r.budget === +budget) }; })
  .sort((a, b) => a.system.localeCompare(b.system) || a.budget - b.budget);

// 1. every system and budget
const table = systems.map(({ system, budget, rows }) => ({ system, budget, cases: rows.length, accuracy: r3(acc(rows)), ci: bootstrap(rows, acc), output: Math.round(mean(rows.map((r) => r.output))), reasoning: Math.round(mean(rows.map((r) => r.reasoning))),
  seconds: r3(mean(rows.map((r) => r.seconds))), empty: rows.filter((r) => r.empty || r.pred === "none").length, tokensPerRight: Math.round(rows.reduce((a, r) => a + r.output, 0) / Math.max(1, rows.filter((r) => r.correct).length)) }));

// 2. the smallest budget non-inferior to the largest (paired by case)
function needed(system, margin = 0.05) {
  const runs = systems.filter((x) => x.system === system), top = runs.at(-1), topBy = Object.fromEntries(top.rows.map((r) => [r.id, r]));
  const tests = runs.map((x) => {
    const pairs = x.rows.filter((r) => topBy[r.id]).map((r) => ({ member: r.member, d: (r.correct ? 1 : 0) - (topBy[r.id].correct ? 1 : 0) }));
    const [lo, hi] = bootstrap(pairs, (rows) => mean(rows.map((p) => p.d)));
    return { budget: x.budget, difference: r3(mean(pairs.map((p) => p.d))), ci: [lo, hi], nonInferior: lo > -margin };
  });
  return { margin, against: top.budget, tests, chosen: tests.find((t) => t.nonInferior)?.budget ?? top.budget };
}
// (a run may have only one of the two systems: the parts that need the other are left out)
const has = (sys) => systems.some((x) => x.system === sys), s2need = has("s2") ? needed("s2") : null, s1need = has("s1") ? needed("s1") : null;

// 3. calibration of S1's confidence, per budget
function calibration(rows) {
  const scored = rows.filter((r) => r.conf != null && r.pred !== "none");
  const bins = Array.from({ length: 10 }, (_, i) => { const b = scored.filter((r) => (i === 9 ? r.conf >= 0.9 : r.conf >= i / 10 && r.conf < (i + 1) / 10)); return { from: i / 10, n: b.length, confidence: b.length ? r3(mean(b.map((r) => r.conf))) : null, accuracy: b.length ? r3(acc(b)) : null }; });
  const ece = bins.reduce((a, b) => a + (b.n ? (b.n / scored.length) * Math.abs(b.confidence - b.accuracy) : 0), 0);
  const curve = [...new Set(scored.map((r) => r.conf))].sort((a, b) => b - a).map((t) => { const kept = scored.filter((r) => r.conf >= t); return { threshold: t, coverage: r3(kept.length / rows.length), risk: r3(1 - acc(kept)) }; });
  return { scored: scored.length, of: rows.length, ece: r3(ece), bins: bins.filter((b) => b.n), riskCoverage: curve.filter((_, i) => i % Math.max(1, Math.floor(curve.length / 12)) === 0) };
}
// 4. conformal risk control on the calibration half
const binomCdf = (k, n, p) => { let s = 0, c = 1; for (let i = 0; i <= k; i++) { if (i > 0) c = (c * (n - i + 1)) / i; s += c * p ** i * (1 - p) ** (n - i); } return s; };
function crc(rows) {
  const n = rows.length, sure = rows.filter((r) => r.conf != null && r.pred !== "none");
  const levels = [...new Set(sure.map((r) => r.conf))].sort((a, b) => b - a), out = [];
  let threshold = null;
  for (const t of levels) {
    const lost = sure.filter((r) => r.conf >= t && !r.correct).length, risk = lost / n, bound = (n * risk + 1) / (n + 1);
    out.push({ threshold: t, answered: sure.filter((r) => r.conf >= t).length, wrong: lost, bound: r3(bound) });
    if (bound > eps) break; // the risk only grows as the threshold falls
    threshold = t;
  }
  return { eps, n, threshold, steps: out.filter((_, i) => i % Math.max(1, Math.floor(out.length / 10)) === 0 || i === out.length - 1) };
}
// exact interval for an error rate
const clopper = (k, n) => {
  const inv = (target, lo = 0, hi = 1, f) => { for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (f(m) > target) lo = m; else hi = m; } return (lo + hi) / 2; };
  const lo = k === 0 ? 0 : inv(0.975, 0, 1, (p) => binomCdf(k - 1, n, p)), hi = k === n ? 1 : inv(0.025, 0, 1, (p) => binomCdf(k, n, p));
  return [r3(lo), r3(hi)];
};
// 5. the cascade on the test half, for each S1 budget with its own calibrated threshold, and S2 at the needed budget
const s2 = s2need && systems.find((x) => x.system === "s2" && x.budget === s2need.chosen), s2by = s2 ? Object.fromEntries(s2.rows.map((r) => [r.id, r])) : null;
const cascades = !s2by ? [] : systems.filter((x) => x.system === "s1").map(({ budget, rows }) => {
  const cal = crc(rows.filter((r) => half(r.member) === "calibration")), tau = cal.threshold;
  const test = rows.filter((r) => half(r.member) === "test" && s2by[r.id]);
  const plan = test.map((r) => { const own = tau != null && r.conf != null && r.pred !== "none" && r.conf >= tau, b = s2by[r.id];
    return { member: r.member, own, correct: own ? r.correct : b.correct, output: r.output + (own ? 0 : b.output), seconds: r.seconds + (own ? 0 : b.seconds) }; });
  const own = plan.filter((x) => x.own), k = own.filter((x) => !x.correct).length;
  const alone = test.map((r) => s2by[r.id]);
  return { s1Budget: budget, s2Budget: s2need.chosen, calibration: { members: new Set(rows.filter((r) => half(r.member) === "calibration").map((r) => r.member)).size, ...cal },
    test: { members: new Set(test.map((r) => r.member)).size, cases: test.length, coverage: r3(own.length / test.length), s1Errors: k, s1Risk: own.length ? r3(k / own.length) : null, s1RiskCI: own.length ? clopper(k, own.length) : null,
      accuracy: r3(acc(plan)), accuracyCI: bootstrap(plan, acc), output: Math.round(mean(plan.map((x) => x.output))), seconds: r3(mean(plan.map((x) => x.seconds))),
      s2Alone: { accuracy: r3(acc(alone)), accuracyCI: bootstrap(alone, acc), output: Math.round(mean(alone.map((x) => x.output))), seconds: r3(mean(alone.map((x) => x.seconds))) } } };
});
const summary = { at: new Date().toISOString(), cases: new Set(raw.map((r) => r.id)).size, members: members.length, split: { calibration: members.filter((m) => half(m) === "calibration").length, test: members.filter((m) => half(m) === "test").length },
  table, budgets: { s2: s2need, s1: s1need }, thresholds: Object.fromEntries(systems.filter((x) => x.system === "s1").map((x) => [x.budget, crc(x.rows.filter((r) => half(r.member) === "calibration"))])), calibration: Object.fromEntries(systems.filter((x) => x.system === "s1").map((x) => [x.budget, calibration(x.rows)])), cascades };
fs.writeFileSync(OUT, JSON.stringify(summary, null, 1));
console.log(JSON.stringify({ table: table.map(({ system, budget, accuracy, ci, output, seconds, empty }) => ({ system, budget, accuracy, ci, output, seconds, empty })), s2Budget: s2need?.chosen ?? null, s1Budget: s1need?.chosen, cascades: cascades.map((c) => ({ s1Budget: c.s1Budget, tau: c.calibration.threshold, ...c.test })) }, null, 1));

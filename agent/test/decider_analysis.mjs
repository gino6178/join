// The analysis of test/decider_eval.mjs's raw results: the one-pass decider (raw) against the full answer (full), on
// the same cases. There is no right answer for "the time the member likes best", so the full answer is the reference,
// and full2 (the full answer again, an independent sample) says how often the current path agrees with itself.
//   1. Per system: decline rate, picks that are a time that works (breaks()), picks of the time the member's words prefer
//      where code can grade it (the earliest start, or weekends), answers code had to correct, seconds (p50, p95),
//      tokens. Intervals: 95%, cluster bootstrap over members (one member's cases are not independent), exact
//      Clopper-Pearson for a share with no member structure to resample.
//   2. Agreement on the chosen time: raw with full, against full2 with full (paired by case), and the difference.
//   3. Is the decider's probability calibrated against agreement with the full answer: ECE over 10 bins, reliability,
//      risk-coverage.
//   4. The threshold, chosen on the calibration members only (half of the members, by a hash of the id), by conformal
//      risk control as in test/cascade_analysis.mjs: the loss of a case is 1 when the decider answers it alone (its
//      probability reaches the threshold, and its pick is a time, not Z) and its time is not the full answer's. That
//      loss only falls as the threshold rises, so the lowest threshold whose calibration risk R passes
//      (n R + 1) / (n + 1) <= EPS bounds the expected share of new cases the cascade answers differently from the full
//      answer by EPS.
//   5. The cascade on the test members: the decider above the threshold, the full answer below it (its second sample,
//      full2, so the reference full is not graded against itself); its coverage, agreement with full, decline rate,
//      seconds and tokens, against full2 alone.
//   node test/decider_analysis.mjs raw.json[,more.json] out.json [raw system, e.g. raw or raw:best] [EPS list, e.g. 0.05,0.1,0.2]
import fs from "node:fs";

const [RAW, OUT = "data/decider_summary.json", SYS = "raw", EPSS = "0.05,0.1,0.2"] = process.argv.slice(2);
// one raw file or several, comma-separated (systems run as separate processes on separate servers, one file each)
const raw = RAW.split(",").flatMap((f) => JSON.parse(fs.readFileSync(f, "utf8"))), epss = EPSS.split(",").map(Number);
let seed = 11;
const rnd = () => { seed = (seed + 0x6d2b79f5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] : null; };
const r3 = (x) => (x == null || Number.isNaN(x) ? null : +x.toFixed(3));
const hash = (t) => [...t].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);
const half = (member) => (hash(member) % 2 ? "test" : "calibration");
function bootstrap(rows, stat, reps = 2000) {
  const by = {}; for (const r of rows) (by[r.member] ||= []).push(r);
  const ms = Object.keys(by), out = [];
  if (!ms.length) return [null, null];
  for (let i = 0; i < reps; i++) { const pick = Array.from({ length: ms.length }, () => by[ms[Math.floor(rnd() * ms.length)]]).flat(); out.push(stat(pick)); }
  return [r3(q(out, 0.025)), r3(q(out, 0.975))];
}
const binomCdf = (k, n, p) => { let s = 0, c = 1; for (let i = 0; i <= k; i++) { if (i > 0) c = (c * (n - i + 1)) / i; s += c * p ** i * (1 - p) ** (n - i); } return s; };
const clopper = (k, n) => {
  if (!n) return [null, null];
  const inv = (target, f) => { let lo = 0, hi = 1; for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (f(m) > target) lo = m; else hi = m; } return (lo + hi) / 2; };
  return [r3(k === 0 ? 0 : inv(0.975, (p) => binomCdf(k - 1, n, p))), r3(k === n ? 1 : inv(0.025, (p) => binomCdf(k, n, p)))];
};
const lat = (xs) => { const v = xs.filter((x) => x != null); return v.length ? { mean: r3(mean(v)), p50: r3(q(v, 0.5)), p95: r3(q(v, 0.95)) } : null; };
const share = (rows, f) => ({ k: rows.filter(f).length, n: rows.length, rate: r3(rows.filter(f).length / Math.max(1, rows.length)), ci: bootstrap(rows, (xs) => mean(xs.map((r) => (f(r) ? 1 : 0)))) });

const bySys = {};
for (const r of raw) (bySys[r.system] ||= {})[r.id] = r;
const systems = Object.keys(bySys);
const ids = Object.keys(bySys.full || {}).filter((id) => bySys[SYS]?.[id]);
const noAnswer = (r) => ["none", "error", "?"].includes(r.pick);

// 1. every system, on the cases every compared system has
function describe(name) {
  const rows = Object.values(bySys[name]).filter((r) => !bySys.full || bySys.full[r.id]);
  const secs = rows.map((r) => r.seconds), graded = rows.filter((r) => r.liked);
  return { system: name, cases: rows.length, members: new Set(rows.map((r) => r.member)).size, decline: share(rows, (r) => r.pick === "Z"), noAnswer: share(rows, noAnswer),
    pickWorks: share(rows, (r) => r.pickWorks), pickWorksOfTimes: (() => { const t = rows.filter((r) => !noAnswer(r) && r.pick !== "Z"); const k = t.filter((r) => r.pickWorks).length; return { k, n: t.length, rate: r3(k / Math.max(1, t.length)), ci: clopper(k, t.length) }; })(),
    liked: share(graded, (r) => r.liked.includes(r.pick)), fixedByCode: name.startsWith("full") ? share(rows, (r) => r.fixed) : null,
    seconds: { mean: r3(mean(secs)), p50: r3(q(secs, 0.5)), p95: r3(q(secs, 0.95)), max: r3(Math.max(...secs)) }, compute: lat(rows.map((r) => r.compute)), hw: [...new Set(rows.map((r) => r.hw))], endpoints: [...new Set(rows.map((r) => r.endpoint).filter(Boolean))],
    tokens: { prompt: Math.round(mean(rows.map((r) => r.prompt))), output: Math.round(mean(rows.map((r) => r.output))), reasoning: Math.round(mean(rows.map((r) => r.reasoning))), calls: r3(mean(rows.map((r) => r.calls))), empty: rows.filter((r) => r.empty).length, invalid: rows.filter((r) => r.invalid).length } };
}
const table = systems.map(describe);

// 2. agreement on the chosen time (a case where either gave no answer counts as a disagreement)
const same = (a, b) => !noAnswer(a) && a.pick === b.pick;
function agreement(a, b, on = ids) {
  const rows = on.filter((id) => bySys[a]?.[id] && bySys[b]?.[id]).map((id) => ({ member: bySys.full[id].member, agree: same(bySys[a][id], bySys[b][id]) }));
  return { a, b, cases: rows.length, rate: r3(mean(rows.map((r) => (r.agree ? 1 : 0)))), ci: bootstrap(rows, (xs) => mean(xs.map((r) => (r.agree ? 1 : 0)))) };
}
const paired = (on = ids) => {
  const rows = on.filter((id) => bySys.full2?.[id]).map((id) => ({ member: bySys.full[id].member, d: (same(bySys[SYS][id], bySys.full[id]) ? 1 : 0) - (same(bySys.full2[id], bySys.full[id]) ? 1 : 0) }));
  return rows.length ? { of: `agree(${SYS}, full) - agree(full2, full)`, cases: rows.length, difference: r3(mean(rows.map((r) => r.d))), ci: bootstrap(rows, (xs) => mean(xs.map((r) => r.d))) } : null;
};
const agree = { [`${SYS}~full`]: agreement(SYS, "full"), "full2~full": bySys.full2 ? agreement("full2", "full") : null, [`${SYS}~full2`]: bySys.full2 ? agreement(SYS, "full2") : null, difference: paired() };
// where the two samples of the full answer agree with each other (the cases on which the current path is settled)
const settled = bySys.full2 ? ids.filter((id) => bySys.full2[id] && same(bySys.full2[id], bySys.full[id])) : [];
if (settled.length) agree.onSettled = agreement(SYS, "full", settled);
// position: how often each picks the first time that works (the decider reads them as A, B, ...)
const firstShare = (name) => { const rows = ids.map((id) => bySys[name]?.[id]).filter(Boolean); return r3(mean(rows.map((r) => (r.pick === r.works[0] ? 1 : 0)))); };
const position = Object.fromEntries(systems.filter((s) => !s.startsWith("rawall")).map((s) => [s, firstShare(s)]));

// 3. calibration of the decider's probability against agreement with the full answer
// (a case the decider gave no probability for goes to the full answer: it counts in the cascade, not in calibration)
const every = ids.map((id) => ({ ...bySys[SYS][id], member: bySys.full[id].member, agree: same(bySys[SYS][id], bySys.full[id]) })), scored = every.filter((r) => r.p != null);
function calibration(rows) {
  const bins = Array.from({ length: 10 }, (_, i) => { const b = rows.filter((r) => (i === 9 ? r.p >= 0.9 : r.p >= i / 10 && r.p < (i + 1) / 10)); return { from: i / 10, n: b.length, p: b.length ? r3(mean(b.map((r) => r.p))) : null, agree: b.length ? r3(mean(b.map((r) => (r.agree ? 1 : 0)))) : null }; });
  const ece = bins.reduce((a, b) => a + (b.n ? (b.n / rows.length) * Math.abs(b.p - b.agree) : 0), 0);
  const ts = [...new Set(rows.map((r) => r.p))].sort((a, b) => b - a);
  const curve = ts.map((t) => { const kept = rows.filter((r) => r.p >= t && r.pick !== "Z"); return { threshold: t, coverage: r3(kept.length / rows.length), disagree: r3(1 - mean(kept.map((r) => (r.agree ? 1 : 0)))) }; });
  return { scored: rows.length, ece: r3(ece), bins: bins.filter((b) => b.n), riskCoverage: curve.filter((_, i) => i % Math.max(1, Math.floor(curve.length / 12)) === 0 || i === curve.length - 1) };
}
// 4. conformal risk control on the calibration members
function crc(rows, eps) {
  const n = rows.length, sure = rows.filter((r) => r.p != null && r.pick !== "Z");
  const levels = [...new Set(sure.map((r) => r.p))].sort((a, b) => b - a), steps = [];
  let threshold = null;
  for (const t of levels) {
    const lost = sure.filter((r) => r.p >= t && !r.agree).length, bound = (lost + 1) / (n + 1);
    steps.push({ threshold: t, answered: sure.filter((r) => r.p >= t).length, disagree: lost, bound: r3(bound) });
    if (bound > eps) break;
    threshold = t;
  }
  return { eps, n, threshold, answered: threshold == null ? 0 : sure.filter((r) => r.p >= threshold).length, steps: steps.filter((_, i) => i % Math.max(1, Math.floor(steps.length / 8)) === 0 || i >= steps.length - 2) };
}
// 5. the cascade on the test members, at each EPS's threshold
const cal = every.filter((r) => half(r.member) === "calibration"), test = every.filter((r) => half(r.member) === "test");
const cascades = !bySys.full2 ? [] : epss.map((eps) => {
  const c = crc(cal, eps), tau = c.threshold;
  const plan = test.filter((r) => bySys.full2[r.id]).map((r) => {
    const own = tau != null && r.p != null && r.pick !== "Z" && r.p >= tau, b = bySys.full2[r.id], ans = own ? r : b;
    return { member: r.member, own, agree: same(ans, bySys.full[r.id]), decline: ans.pick === "Z", liked: r.liked ? r.liked.includes(ans.pick) : null, works: ans.pickWorks,
      seconds: r.seconds + (own ? 0 : b.seconds), compute: (r.compute || 0) + (own ? 0 : b.compute || 0), output: r.output + (own ? 0 : b.output), prompt: r.prompt + (own ? 0 : b.prompt), ownAgree: same(r, bySys.full[r.id]) };
  });
  const own = plan.filter((x) => x.own), k = own.filter((x) => !x.ownAgree).length, b2 = test.filter((r) => bySys.full2[r.id]).map((r) => bySys.full2[r.id]);
  const secs = plan.map((x) => x.seconds), secs2 = b2.map((r) => r.seconds), graded = plan.filter((x) => x.liked != null);
  return { eps, threshold: tau, calibration: { members: new Set(cal.map((r) => r.member)).size, cases: cal.length, answered: c.answered, steps: c.steps },
    test: { members: new Set(plan.map((x) => x.member)).size, cases: plan.length, coverage: r3(own.length / Math.max(1, plan.length)), deciderDisagree: k, deciderDisagreeRate: own.length ? r3(k / own.length) : null, deciderDisagreeCI: clopper(k, own.length),
      agree: r3(mean(plan.map((x) => (x.agree ? 1 : 0)))), agreeCI: bootstrap(plan, (xs) => mean(xs.map((x) => (x.agree ? 1 : 0)))), decline: r3(mean(plan.map((x) => (x.decline ? 1 : 0)))), pickWorks: r3(mean(plan.map((x) => (x.works ? 1 : 0)))),
      liked: graded.length ? { k: graded.filter((x) => x.liked).length, n: graded.length } : null,
      seconds: { mean: r3(mean(secs)), p50: r3(q(secs, 0.5)), p95: r3(q(secs, 0.95)) }, compute: lat(plan.map((x) => x.compute)), output: Math.round(mean(plan.map((x) => x.output))), prompt: Math.round(mean(plan.map((x) => x.prompt))) },
    full2Alone: { agree: r3(mean(test.filter((r) => bySys.full2[r.id]).map((r) => (same(bySys.full2[r.id], bySys.full[r.id]) ? 1 : 0)))), agreeCI: bootstrap(test.filter((r) => bySys.full2[r.id]).map((r) => ({ member: r.member, a: same(bySys.full2[r.id], bySys.full[r.id]) })), (xs) => mean(xs.map((x) => (x.a ? 1 : 0)))),
      decline: r3(mean(b2.map((r) => (r.pick === "Z" ? 1 : 0)))), seconds: { mean: r3(mean(secs2)), p50: r3(q(secs2, 0.5)), p95: r3(q(secs2, 0.95)) }, compute: lat(b2.map((r) => r.compute)), output: Math.round(mean(b2.map((r) => r.output))) } };
});

const summary = { at: new Date().toISOString(), raw: RAW, decider: SYS, cases: ids.length, members: new Set(ids.map((id) => bySys.full[id].member)).size, split: { calibration: new Set(cal.map((r) => r.member)).size, test: new Set(test.map((r) => r.member)).size },
  table, agreement: agree, firstTimeShare: position, calibration: calibration(scored), cascades };
fs.writeFileSync(OUT, JSON.stringify(summary, null, 1));
console.log(JSON.stringify({ cases: summary.cases, members: summary.members, table: table.map((t) => ({ system: t.system, n: t.cases, decline: t.decline.rate, none: t.noAnswer.k, works: t.pickWorks.rate, liked: `${t.liked.k}/${t.liked.n}`, fixed: t.fixedByCode?.k, p50: t.seconds.p50, p95: t.seconds.p95, computeP50: t.compute?.p50, computeP95: t.compute?.p95, output: t.tokens.output, prompt: t.tokens.prompt })),
  agreement: Object.fromEntries(Object.entries(agree).filter(([, v]) => v).map(([k, v]) => [k, `${v.rate ?? v.difference} ${JSON.stringify(v.ci)}`])), firstTimeShare: position, ece: summary.calibration.ece,
  cascades: cascades.map((c) => ({ eps: c.eps, tau: c.threshold, coverage: c.test.coverage, deciderDisagree: `${c.test.deciderDisagree} ${JSON.stringify(c.test.deciderDisagreeCI)}`, agree: c.test.agree, agreeCI: c.test.agreeCI, full2: c.full2Alone.agree, p50: c.test.seconds.p50, p95: c.test.seconds.p95, output: c.test.output })) }, null, 1));

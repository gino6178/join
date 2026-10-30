// The soft-breach rule under the monitor's real schedule: how often each rule rolls back a change that does nothing,
// and how often and how fast it catches a bad one. No model, no GPU, no network; CPU only:
//   node test/loop_canary_sim.mjs [--trials 20000] [--seed 7] [--out ../submission/results/canary_sequential.json]
//
// The club: `canary` members (3, 5, 10, 20), each asked "Want a game?" once a day at 12:00 (ask.hour's default), for
// the 7 days before the ship and the 7 days of the canary. Each ask is answered "Not this week" (thumbs down) with
// chance p, "another time" (no thumb) with chance 0.15, else Yes (thumbs up): part A's model in loop_eval.mjs. When
// the answer comes: 60% soon after the ask (an exponential wait, 30 minutes on average), 40% in the evening (17:00
// to 23:00, uniform). The canary ships at 05:00 (part A's nightly turn) and runs 7 days; the monitor looks every 5
// minutes (server.js), 2,016 looks, and the first breach rolls the change back.
//   null      nothing changes: p = 0.25 before and after
//   bad       a bad change: p = 0.25 before, 0.60 after
//   differ    nothing changes, but members differ: each member's own p from Beta(1, 3) (mean 0.25), the same before
//             and after, so one member's thumbs are not independent of each other
// The rules, on the same simulated thumbs:
//   z, once         the old rule (10 points, 5 thumbs, z >= 1.645) looked at once, at the canary's end
//   z, every look   the old rule at every 5-minute look, against a window of the same length (as flags.js did)
//   e-process       the new default (loop/anytime.js) at every 5-minute look, against the 7 days before the ship
// Each rule is the code flags.js runs (anytime.softRise), not a copy of it.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { softRise, evidence, ALPHA, RISE, MIN_THUMBS, Z } from "../src/loop/anytime.js";

const MIN = 6e4, HOUR = 36e5, DAY = 864e5, LOOK = 5 * MIN, DAYS = 7, LOOKS = (DAYS * DAY) / LOOK;
const SHIP = 5 * HOUR, ASK = 12 * HOUR, NO_THUMB = 0.15, SIZES = [3, 5, 10, 20];
const SCENARIOS = {
  null: { about: "nothing changes: Not this week 25% of asks, before and after", before: 0.25, after: 0.25 },
  bad: { about: "a bad change: Not this week 25% of asks before, 60% after", before: 0.25, after: 0.6 },
  differ: { about: "nothing changes, members differ: each member's own rate from Beta(1, 3), mean 25%, the same before and after", before: "beta", after: "beta" },
};
const RULES = ["z, once", "z, every look", "e-process"];

// sfc32, seeded through splitmix32: the same numbers for the same seed on every machine
function rng(seed) {
  let s = seed >>> 0;
  const mix = () => { s = (s + 0x9e3779b9) >>> 0; let z = s; z = Math.imul(z ^ (z >>> 16), 0x85ebca6b); z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35); return (z ^ (z >>> 16)) >>> 0; };
  let a = mix(), b = mix(), c = mix(), d = mix();
  return () => {
    const t = (((a + b) >>> 0) + d) >>> 0; d = (d + 1) >>> 0;
    a = b ^ (b >>> 9); b = (c + (c << 3)) >>> 0; c = ((c << 21) | (c >>> 11)) >>> 0; c = (c + t) >>> 0;
    return t / 4294967296;
  };
}
// Beta(1, 3) by inversion: 1 - (1 - u)^(1/3)
const beta13 = (r) => 1 - Math.cbrt(1 - r());

// One canary: every thumb before and after the ship, as [time since the ship (ms), down?]
function thumbs(r, n, sc) {
  const before = [], after = [];
  for (let w = 0; w < n; w++) {
    const own = sc.before === "beta" ? Math.min(beta13(r), 1 - NO_THUMB) : null;
    for (let day = -DAYS; day < DAYS; day++) {
      const p = own ?? (day < 0 ? sc.before : sc.after), u = r();
      if (u >= p && u < p + NO_THUMB) continue; // "another time": no thumb
      const wait = r() < 0.6 ? Math.min(-Math.log(1 - r()) * 30 * MIN, 11 * HOUR) : 5 * HOUR + r() * 6 * HOUR;
      const at = day * DAY - SHIP + ASK + wait; // midnight of the ship's day is -SHIP
      (day < 0 ? before : after).push([at, u < p]);
    }
  }
  return { before, after };
}
const tally = (xs) => { let up = 0, down = 0; for (const [, d] of xs) d ? down++ : up++; return { up, down }; };

// the look (1 .. LOOKS) at which a thumb is first counted: after-window [since, now), before-window [since - len, since)
const lookAfter = (at) => Math.floor(at / LOOK) + 1;
const lookBefore = (at) => Math.max(1, Math.ceil(-at / LOOK));

function trial(r, n, sc) {
  const { before, after } = thumbs(r, n, sc), out = {};
  const all = tally(before);
  // z, once: the canary's end, 7 days against 7 days
  out["z, once"] = softRise(tally(after), all, { test: "z" }).breach ? LOOKS : null;
  // z, every look: the window before grows back from the ship as the canary grows; the statistic changes only when a
  // thumb enters either window, so only those looks need computing (every other look gives the same answer)
  {
    const ev = [...after.map(([at, d]) => [lookAfter(at), 1, d]), ...before.map(([at, d]) => [lookBefore(at), 0, d])].filter(([k]) => k <= LOOKS).sort((x, y) => x[0] - y[0]);
    const m = { up: 0, down: 0 }, b = { up: 0, down: 0 };
    let hit = null;
    for (let i = 0; i < ev.length && hit == null;) {
      const k = ev[i][0];
      for (; i < ev.length && ev[i][0] === k; i++) { const t = ev[i][1] ? m : b; ev[i][2] ? t.down++ : t.up++; }
      if (softRise(m, b, { test: "z" }).breach) hit = k;
    }
    out["z, every look"] = hit;
  }
  // e-process: the 7 days before are fixed at the ship; the evidence changes only when a canary thumb arrives
  {
    const of = evidence(all), ev = after.map(([at, d]) => [lookAfter(at), d]).filter(([k]) => k <= LOOKS).sort((x, y) => x[0] - y[0]);
    const m = { up: 0, down: 0 };
    let hit = null;
    for (let i = 0; i < ev.length && hit == null;) {
      const k = ev[i][0];
      for (; i < ev.length && ev[i][0] === k; i++) ev[i][1] ? m.down++ : m.up++;
      if (softRise(m, all, { test: "evalue", of }).breach) hit = k;
    }
    out["e-process"] = hit;
  }
  return { out, before: before.length, after: after.length };
}

function cell({ scenario, n, trials, seed }) {
  const r = rng(seed), sc = SCENARIOS[scenario], hits = Object.fromEntries(RULES.map((k) => [k, []]));
  let thumbsBefore = 0, thumbsAfter = 0;
  for (let t = 0; t < trials; t++) {
    const { out, before, after } = trial(r, n, sc);
    thumbsBefore += before; thumbsAfter += after;
    for (const k of RULES) if (out[k] != null) hits[k].push(out[k]);
  }
  return { scenario, n, trials, seed, thumbsBefore: thumbsBefore / trials, thumbsAfter: thumbsAfter / trials, hits };
}

// 95% Wilson interval for a rate
function wilson(k, n, z = 1.96) {
  const p = k / n, d = 1 + (z * z) / n, c = p + (z * z) / (2 * n), h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [+((c - h) / d).toFixed(4), +((c + h) / d).toFixed(4)];
}
const median = (xs) => { if (!xs.length) return null; const v = [...xs].sort((a, b) => a - b), m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
const days = (k) => (k == null ? null : +((k * LOOK) / DAY).toFixed(2));

function summary(c) {
  return RULES.map((rule) => {
    const h = c.hits[rule], byDay = Array.from({ length: DAYS }, (_, d) => +(h.filter((k) => k * LOOK <= (d + 1) * DAY).length / c.trials).toFixed(4));
    return { scenario: c.scenario, canary: c.n, rule, trials: c.trials, rolledBack: +(h.length / c.trials).toFixed(4), ci95: wilson(h.length, c.trials),
      medianDays: days(median(h)), meanDays: h.length ? days(h.reduce((a, b) => a + b, 0) / h.length) : null, byDay,
      thumbsBefore: +c.thumbsBefore.toFixed(1), thumbsAfter: +c.thumbsAfter.toFixed(1) };
  });
}

if (!isMainThread) {
  parentPort.postMessage(cell(workerData));
} else {
  const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
  const here = path.dirname(fileURLToPath(import.meta.url));
  const trials = +arg("trials", 20000), seed = +arg("seed", 7), out = path.resolve(arg("out", path.join(here, "../../submission/results/canary_sequential.json")));
  const threads = Math.max(1, Math.min(+arg("threads", 12), os.cpus().length));
  const t0 = Date.now();
  const jobs = Object.keys(SCENARIOS).flatMap((scenario, si) => SIZES.map((n, ni) => ({ scenario, n, trials, seed: seed * 1000 + si * 100 + ni })));
  const done = [];
  let next = 0;
  await new Promise((resolve, reject) => {
    let live = 0;
    const start = () => {
      if (next >= jobs.length) { if (!live) resolve(); return; }
      const job = jobs[next++];
      live++;
      const w = new Worker(fileURLToPath(import.meta.url), { workerData: job });
      w.once("message", (c) => { done.push(c); });
      w.once("error", reject);
      w.once("exit", () => { live--; start(); });
    };
    for (let i = 0; i < threads; i++) start();
  });
  const rows = jobs.flatMap((j) => summary(done.find((c) => c.scenario === j.scenario && c.n === j.n)));
  const result = {
    label: "The soft-breach rule under the monitor's schedule: a look every 5 minutes for the 7 days of a canary. Simulated thumbs, the real rule (loop/anytime.js). No model.",
    at: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), trials, seed,
    model: { members: SIZES, asks: "one a day at 12:00, 7 days before the ship and 7 after", answers: { notThisWeek: "p (thumbs down)", anotherTime: NO_THUMB, yes: "1 - p - 0.15" },
      arrival: "60% soon after the ask (exponential, mean 30 minutes), 40% between 17:00 and 23:00", ship: "05:00", look: "every 5 minutes, 2,016 looks", scenarios: Object.fromEntries(Object.entries(SCENARIOS).map(([k, v]) => [k, v.about])) },
    rules: { "z, once": `10 points, ${MIN_THUMBS} thumbs, one-sided pooled z >= ${Z}, looked at once at the canary's end, 7 days against the 7 before`,
      "z, every look": "the same, at every look, against a window before the ship of the same length as the canary so far (flags.js before this change)",
      "e-process": `10 points, ${MIN_THUMBS} thumbs, E >= ${1 / ALPHA} (alpha ${ALPHA}; the alternative's prior: every pair with a rise of ${RISE * 100} points or more), at every look, against the 7 days before the ship (flags.js now)` },
    rows,
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(result, null, 1) + "\n");
  const pc = (x) => (x == null ? "-" : `${(x * 100).toFixed(1)}%`);
  console.log(`${trials} trials per cell, ${result.seconds} s -> ${path.relative(process.cwd(), out)}`);
  console.log("| canary | rule | null: rolled back | differ: rolled back | bad: caught | bad: median days to catch |");
  console.log("|---|---|---|---|---|---|");
  for (const n of SIZES) for (const rule of RULES) {
    const g = (s) => rows.find((x) => x.scenario === s && x.canary === n && x.rule === rule);
    console.log(`| ${n} | ${rule} | ${pc(g("null").rolledBack)} | ${pc(g("differ").rolledBack)} | ${pc(g("bad").rolledBack)} | ${g("bad").medianDays ?? "-"} |`);
  }
}

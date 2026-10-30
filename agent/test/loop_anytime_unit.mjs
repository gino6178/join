// Unit tests for the anytime-valid soft-breach test (loop/anytime.js). No model, no GPU, no network:
//   node --test test/loop_anytime_unit.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { eRise, evidence, nullLog, softRise, zRise, odds, share, softTest, ALPHA, RISE, MIN_THUMBS, Z } from "../src/loop/anytime.js";

// a seeded stream of numbers in [0, 1) (mulberry32)
const rng = (seed) => () => { seed = (seed + 0x6d2b79f5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const binom = (n, k) => { let c = 1; for (let i = 0; i < k; i++) c = (c * (n - i)) / (i + 1); return c; };

test("no evidence without data, or without a rise: E is at most 1", () => {
  assert.ok(eRise({ up: 0, down: 0 }, { up: 20, down: 5 }) <= 1, "no thumbs since the ship");
  assert.ok(eRise({ up: 2, down: 8 }, { up: 0, down: 0 }) <= 1, "no thumbs before it: nothing to compare with");
  assert.ok(eRise({ up: 30, down: 10 }, { up: 30, down: 10 }) < 1, "the same share");
  assert.ok(eRise({ up: 35, down: 5 }, { up: 30, down: 10 }) < 0.01, "fewer thumbs down after");
  assert.ok(eRise({ up: 1700, down: 300 }, { up: 1800, down: 200 }) < 1e-3, "a rise of 5 points on 4,000 thumbs is evidence against a rise of 10 or more");
});

test("the null's best fit: each window at its own share, or both at the pooled share when the canary's is higher", () => {
  const ll = (d, u, p) => d * Math.log(p) + u * Math.log(1 - p);
  assert.ok(Math.abs(nullLog({ up: 8, down: 2 }, { up: 6, down: 4 }) - (ll(2, 8, 0.2) + ll(4, 6, 0.4))) < 1e-12);
  assert.ok(Math.abs(nullLog({ up: 6, down: 4 }, { up: 8, down: 2 }) - ll(6, 14, 0.3)) < 1e-12);
  assert.equal(nullLog({ up: 0, down: 0 }, { up: 0, down: 0 }), 0);
});

test("an e-value at any fixed look: its mean is at most 1 under every null pair, summed exactly over every outcome", () => {
  // n0 thumbs before and n1 after, every count of thumbs down, weighted by its chance under (p0, p1) with p1 <= p0
  for (const [n0, n1] of [[4, 3], [6, 6], [10, 5]]) {
    const table = [];
    for (let d0 = 0; d0 <= n0; d0++) { const f = evidence({ down: d0, up: n0 - d0 }); table.push(Array.from({ length: n1 + 1 }, (_, d1) => f({ down: d1, up: n1 - d1 }))); }
    for (const [p0, p1] of [[0.05, 0.05], [0.25, 0.25], [0.5, 0.5], [0.8, 0.8], [0.4, 0.2], [0.6, 0.59]]) {
      let mean = 0;
      for (let d0 = 0; d0 <= n0; d0++) for (let d1 = 0; d1 <= n1; d1++) mean += binom(n0, d0) * p0 ** d0 * (1 - p0) ** (n0 - d0) * binom(n1, d1) * p1 ** d1 * (1 - p1) ** (n1 - d1) * table[d0][d1];
      assert.ok(mean <= 1 + 1e-9, `n ${n0}+${n1}, p ${p0} -> ${p1}: mean E ${mean}`);
    }
  }
});

test("a change that does nothing, looked at after every thumb: E never reaches 20 on a seeded stream, and 5% at most cross over many", () => {
  // one stream, 60 thumbs before and 200 after, a quarter of them down: the largest E over every look
  const r = rng(11), before = { up: 0, down: 0 };
  for (let i = 0; i < 60; i++) r() < 0.25 ? before.down++ : before.up++;
  const f = evidence(before), m = { up: 0, down: 0 };
  let most = 0;
  for (let i = 0; i < 200; i++) { r() < 0.25 ? m.down++ : m.up++; most = Math.max(most, f(m)); }
  assert.ok(most < 1 / ALPHA, `largest E ${most}`);
  // 400 such canaries (30 thumbs before, 30 after, every look): at most 5% ever cross (the bound is ALPHA)
  let crossed = 0;
  for (let t = 0; t < 400; t++) {
    const b = { up: 0, down: 0 }, a = { up: 0, down: 0 };
    for (let i = 0; i < 30; i++) r() < 0.3 ? b.down++ : b.up++;
    const g = evidence(b);
    for (let i = 0; i < 30; i++) { r() < 0.3 ? a.down++ : a.up++; if (softRise(a, b, { test: "evalue", of: g }).breach) { crossed++; break; } }
  }
  assert.ok(crossed / 400 <= ALPHA, `${crossed} of 400 crossed`);
});

test("a clearly bad change crosses: thumbs down from 25% to 60%", () => {
  const e = eRise({ up: 24, down: 36 }, { up: 45, down: 15 });
  assert.ok(e >= 1 / ALPHA && e < 1e4, `E ${e}`);
  // on a stream: 60 thumbs before at 25%, then 60% down: E crosses 20 within the canary's 60 thumbs
  const r = rng(5), before = { up: 45, down: 15 }, f = evidence(before), m = { up: 0, down: 0 };
  let at = null;
  for (let i = 1; i <= 60 && at == null; i++) { r() < 0.6 ? m.down++ : m.up++; if (softRise(m, before, { test: "evalue", of: f }).breach) at = i; }
  assert.ok(at != null, "crossed");
  // more thumbs down on the same number of thumbs: more evidence
  let last = 0;
  for (let d = 15; d <= 40; d++) { const x = eRise({ up: 60 - d, down: d }, before); assert.ok(x >= last, `${d} down`); last = x; }
});

test("softRise: 5 thumbs and a 10-point rise first, then the test; the z-test kept for comparison", () => {
  assert.equal(MIN_THUMBS, 5); assert.equal(RISE, 0.1); assert.equal(Z, 1.645); assert.equal(1 / ALPHA, 20);
  const before = { up: 45, down: 15 };
  const bad = softRise({ up: 24, down: 36 }, before, { test: "evalue" });
  assert.equal(bad.breach, true); assert.equal(bad.test, "evalue"); assert.ok(bad.e >= 20); assert.ok(Math.abs(bad.rise - 0.35) < 1e-9);
  assert.ok(Math.abs(bad.z - zRise({ up: 24, down: 36 }, before)) < 1e-12, "z is computed either way, for the history");
  assert.equal(softRise({ up: 1, down: 3 }, { up: 99, down: 1 }, { test: "evalue" }).breach, false, "4 thumbs are too few");
  assert.equal(softRise({ up: 1, down: 3 }, { up: 99, down: 1 }, { test: "evalue" }).e, null, "and E is not computed");
  assert.equal(softRise({ up: 1700, down: 300 }, { up: 1800, down: 200 }, { test: "z" }).breach, false, "z 5.6, but 5 points");
  // the z-test checked once rolls back at z >= 1.645; part A's run 2 was z 1.78
  assert.ok(Math.abs(zRise({ up: 14, down: 15 }, { up: 20, down: 8 }) - 1.78) < 0.01);
  assert.equal(softRise({ up: 14, down: 15 }, { up: 20, down: 8 }, { test: "z" }).breach, true);
  assert.equal(softRise({ up: 14, down: 15 }, { up: 20, down: 8 }, { test: "evalue" }).breach, false, "the e-process asks for more on 57 thumbs");
  assert.throws(() => softRise({ up: 1, down: 1 }, { up: 1, down: 1 }, { test: "bayes" }), /evalue or z/);
  assert.throws(() => eRise({ up: -1, down: 1 }, { up: 1, down: 1 }), /counts/);
  assert.equal(share({ up: 0, down: 0 }), 0); assert.equal(share({ up: 3, down: 1 }), 0.25);
});

test("LOOP_SOFT_TEST picks the test: the e-process unless it says z", () => {
  const was = process.env.LOOP_SOFT_TEST;
  try {
    delete process.env.LOOP_SOFT_TEST; assert.equal(softTest(), "evalue");
    process.env.LOOP_SOFT_TEST = "z"; assert.equal(softTest(), "z");
    assert.equal(softRise({ up: 14, down: 15 }, { up: 20, down: 8 }).test, "z");
    process.env.LOOP_SOFT_TEST = "anything else"; assert.equal(softTest(), "evalue");
  } finally { if (was == null) delete process.env.LOOP_SOFT_TEST; else process.env.LOOP_SOFT_TEST = was; }
});

test("odds: how a note says E", () => {
  assert.equal(odds(20.4), "20"); assert.equal(odds(1316.2), "1,316"); assert.equal(odds(2e6), "over a million"); assert.equal(odds(Infinity), "over a million"); assert.equal(odds(NaN), "no");
});

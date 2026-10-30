// Anytime-valid evidence that a canary raised the share of thumbs down: the soft-breach test the flags' monitor uses.
//   The monitor looks every 5 minutes. A fixed-sample test (a z of 1.645) checked at every look rolls back a change that
//   does nothing far more often than its 5%, because each look is another chance for noise to cross the line. This
//   test stays valid however often it is checked, and whenever it stops: the chance that a change which does nothing
//   ever reaches the threshold, over the whole canary, is at most ALPHA (Ville's inequality).
//
// The data: the canary members' thumbs in the window before the ship (d0 down, u0 up; fixed when the canary starts)
// and since it (d1 down, u1 up; growing). Each thumb is taken as an independent yes/no, down with chance p0 before
// and p1 after.
//   Null: p1 <= p0 (the change made nothing worse).
//   Evidence: E = N / D, where
//     N = the likelihood of both windows averaged over a prior on the alternative: (p0, p1) uniform over every pair
//         with p1 >= p0 + RISE (the 10-point rise that matters), on a grid of GRID x GRID points;
//     D = the largest likelihood any null pair (p1 <= p0) gives the same data.
//   For a true null pair q, D >= L_q, so E <= N / L_q, and N / L_q is a nonnegative martingale as thumbs arrive, with
//   mean 1 (the prior's weights sum to 1). Ville's inequality gives P(E ever >= 1/ALPHA) <= ALPHA, at any looks, for
//   every null pair at once. (A mixture over the alternative divided by the null's maximum likelihood: the
//   "universal inference" construction of Wasserman, Ramdas and Balakrishnan, 2020, made sequential.)
//   E depends on the four counts only, so the monitor needs nothing but the counts it already reads.
// Before any thumb since the ship, or with no thumb before it, E <= 1: there is nothing to see.
export const ALPHA = 0.05, RISE = 0.10, GRID = 1000;

// the grid's points (midpoints, never 0 or 1) and their logs, once per size
const axes = new Map();
function axis(G) {
  if (axes.has(G)) return axes.get(G);
  const lp = new Float64Array(G), lq = new Float64Array(G);
  for (let i = 0; i < G; i++) { const p = (i + 0.5) / G; lp[i] = Math.log(p); lq[i] = Math.log1p(-p); }
  const out = { lp, lq };
  axes.set(G, out);
  return out;
}
const xlogy = (x, y) => (x ? x * Math.log(y) : 0);
// the log likelihood of d down and u up at the most likely chance (and 0 for no thumbs)
const top = (d, u) => (d + u ? xlogy(d, d / (d + u)) + xlogy(u, u / (d + u)) : 0);
const counts = (m) => {
  const d = +m?.down || 0, u = +m?.up || 0;
  if (!(d >= 0 && u >= 0 && Number.isFinite(d + u))) throw new Error("thumbs are counts: { up, down }, 0 or more");
  return [d, u];
};

// The null's largest log likelihood: each window at its own share when the canary's is no higher; else both at the
// pooled share (the boundary p1 = p0).
export function nullLog(after, before) {
  const [d1, u1] = counts(after), [d0, u0] = counts(before), n1 = d1 + u1, n0 = d0 + u0;
  if (!n1 || !n0 || d1 / n1 <= d0 / n0) return top(d0, u0) + top(d1, u1);
  return top(d0 + d1, u0 + u1);
}

// evidence(before) fixes the window before (as the monitor does at the ship) and returns after => E. The simulation
// calls it once per canary and the returned function at every look.
export function evidence(before, { rise = RISE, grid = GRID } = {}) {
  const [d0, u0] = counts(before);
  if (!(rise >= 0 && rise < 1)) throw new Error("the rise is between 0 and 1");
  if (!Number.isInteger(grid) || grid < 10) throw new Error("the grid has 10 points or more");
  const G = grid, { lp, lq } = axis(G), k = Math.ceil(rise * G - 1e-9);
  // the pairs (i, j) with p_j >= p_i + rise: j >= i + k; the prior gives each the same weight
  const rows = G - k;
  let pairs = 0;
  for (let i = 0; i < rows; i++) pairs += G - i - k;
  // the window before, on the grid (shifted by its largest value, kept apart in A)
  const a = new Float64Array(Math.max(rows, 0));
  let A = -Infinity;
  for (let i = 0; i < rows; i++) { a[i] = d0 * lp[i] + u0 * lq[i]; if (a[i] > A) A = a[i]; }
  for (let i = 0; i < rows; i++) a[i] = Math.exp(a[i] - A);
  const b = new Float64Array(G), tail = new Float64Array(G + 1);
  const logE = (after) => {
    const [d1, u1] = counts(after);
    if (rows <= 0) return -Infinity;
    let B = -Infinity;
    for (let j = k; j < G; j++) { b[j] = d1 * lp[j] + u1 * lq[j]; if (b[j] > B) B = b[j]; }
    // tail[j] = the sum over p_j' >= p_j of the canary's likelihood (shifted by B)
    tail[G] = 0;
    for (let j = G - 1; j >= k; j--) tail[j] = tail[j + 1] + Math.exp(b[j] - B);
    let s = 0;
    for (let i = 0; i < rows; i++) s += a[i] * tail[i + k];
    if (!(s > 0)) return -Infinity;
    return Math.log(s) + A + B - Math.log(pairs) - nullLog({ down: d1, up: u1 }, { down: d0, up: u0 });
  };
  const e = (after) => Math.exp(logE(after));
  e.log = logE;
  return e;
}

// E for one look: the canary's thumbs since the ship (after) against the window before it (before), each { up, down }
export const eRise = (after, before, opts) => evidence(before, opts)(after);

// ---- the soft-breach rule, both ways -------------------------------------------------------------------------
// The old rule, kept for comparison (LOOP_SOFT_TEST=z): a one-sided two-proportion z, pooled, against Z. Valid when
// looked at once, at the canary's end; looked at every 5 minutes, it is not (test/loop_canary_sim.mjs).
export const Z = 1.645, MIN_THUMBS = 5;
export const share = (m) => { const [d, u] = counts(m); return d + u ? d / (d + u) : 0; };
export function zRise(after, before) {
  const [d1, u1] = counts(after), [d0, u0] = counts(before), n1 = d1 + u1, n0 = d0 + u0;
  if (!n1 || !n0) return 0;
  const p = (d1 + d0) / (n1 + n0), se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n0));
  return se > 0 ? (d1 / n1 - d0 / n0) / se : 0;
}
export const TESTS = ["evalue", "z"];
// LOOP_SOFT_TEST: evalue (the default) or z
export const softTest = () => (process.env.LOOP_SOFT_TEST === "z" ? "z" : "evalue");

// One look at the canary's thumbs: { breach, rise, z, e }. Either way the canary needs MIN_THUMBS thumbs and a rise of
// RISE (10 points) in the share of thumbs down, the size of change that matters; then the z-test needs z >= Z, the
// e-process E >= 1/ALPHA. (Each extra condition can only stop a rollback, so the e-process stays within ALPHA.)
// `of` is evidence(before), made once per canary when many looks are taken (the simulation).
export function softRise(after, before, { test = softTest(), of = null, alpha = ALPHA } = {}) {
  if (!TESTS.includes(test)) throw new Error(`the soft test is ${TESTS.join(" or ")}`);
  const [d1, u1] = counts(after), rise = share(after) - share(before), z = zRise(after, before);
  const enough = d1 + u1 >= MIN_THUMBS && rise >= RISE - 1e-9;
  if (test === "z") return { test, breach: enough && z >= Z, rise, z, e: null };
  const e = enough ? (of || evidence(before))(after) : null;
  return { test, breach: enough && e >= 1 / alpha, rise, z, e };
}

// E as a club note says it: "20 to 1", "1,300 to 1", "over a million to 1"
export function odds(e) {
  if (!(e >= 0)) return "no";
  if (e >= 1e6) return "over a million";
  return Math.round(e).toLocaleString("en-US");
}

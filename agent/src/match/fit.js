// The small statistics the matchmaker needs, written out (no packages): logistic regression (Newton's method, L2),
// gradient-boosted trees (for comparison in the evals), isotonic regression for calibration, and the metrics the
// evals report (AUC, Brier, log loss, ECE, reliability bins, Gini). docs/agent_matchmaking_plan.md, section 4.4.
export const sig = (z) => 1 / (1 + Math.exp(-z));
export const logit = (p) => Math.log(Math.max(1e-6, p) / Math.max(1e-6, 1 - p));

function solve(A, b) {
  const n = b.length, m = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    [m[c], m[p]] = [m[p], m[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = m[r][c] / m[c][c]; for (let k = c; k <= n; k++) m[r][k] -= f * m[c][k]; }
  }
  return m.map((r, i) => r[n] / r[i]);
}
// logistic regression on standardized features; the intercept is not penalized. Returns what model.json keeps.
export function fitLR(X, y, lambda = 1) {
  const d0 = X[0].length, mu = Array(d0).fill(0), sd = Array(d0).fill(0);
  for (const x of X) x.forEach((v, k) => (mu[k] += v / X.length));
  for (const x of X) x.forEach((v, k) => (sd[k] += (v - mu[k]) ** 2 / X.length));
  const s = sd.map((v) => Math.sqrt(v) || 1), Z = X.map((x) => [1, ...x.map((v, k) => (v - mu[k]) / s[k])]), d = d0 + 1;
  let w = Array(d).fill(0);
  for (let it = 0; it < 40; it++) {
    const g = Array(d).fill(0), H = Array.from({ length: d }, () => Array(d).fill(0));
    Z.forEach((z, i) => { const p = sig(z.reduce((a, v, k) => a + v * w[k], 0)), r = p * (1 - p); for (let k = 0; k < d; k++) { g[k] += (p - y[i]) * z[k]; for (let l = k; l < d; l++) H[k][l] += r * z[k] * z[l]; } });
    for (let k = 0; k < d; k++) { for (let l = 0; l < k; l++) H[k][l] = H[l][k]; if (k) { g[k] += lambda * w[k]; H[k][k] += lambda; } }
    const step = solve(H, g); w = w.map((v, k) => v - step[k]);
    if (Math.max(...step.map(Math.abs)) < 1e-8) break;
  }
  return { w, mu, sd: s };
}
export const applyLR = (m, x) => sig(m.w[0] + x.reduce((a, v, k) => a + m.w[k + 1] * (v - m.mu[k]) / m.sd[k], 0));

// isotonic regression (pool adjacent violators) on held-out rows: knots to interpolate between, shrunk a little
// towards the prior so a block of a few rows is not 0 or 1
export function fitIsotonic(p, y, prior = 0.25) {
  const o = p.map((q, i) => [q, y[i]]).sort((a, b) => a[0] - b[0]), blocks = [];
  for (const [q, v] of o) {
    blocks.push({ lo: q, hi: q, s: v, n: 1 });
    while (blocks.length > 1 && blocks.at(-2).s / blocks.at(-2).n >= blocks.at(-1).s / blocks.at(-1).n) { const b = blocks.pop(), a = blocks.at(-1); a.hi = b.hi; a.s += b.s; a.n += b.n; }
  }
  return { xs: blocks.map((b) => +((b.lo + b.hi) / 2).toFixed(5)), ys: blocks.map((b) => +((b.s + 0.5 * prior) / (b.n + 0.5)).toFixed(5)) };
}
export function applyIsotonic(k, q) {
  const { xs, ys } = k;
  if (!xs?.length) return q;
  if (q <= xs[0]) return ys[0];
  if (q >= xs.at(-1)) return ys.at(-1);
  let i = 0; while (xs[i + 1] < q) i++;
  const f = (q - xs[i]) / (xs[i + 1] - xs[i] || 1);
  return ys[i] + f * (ys[i + 1] - ys[i]);
}
// Platt scaling: a logistic on the logit (for comparison)
export function fitPlatt(p, y) { const m = fitLR(p.map((q) => [logit(q)]), y, 1e-6); return (q) => applyLR(m, [logit(q)]); }

// gradient-boosted trees (log loss, histogram splits): measured in the evals, not shipped
export function fitGBDT(X, y, { trees = 150, depth = 3, lr = 0.08, bins = 32, minH = 8, lambda = 1 } = {}) {
  const d = X[0].length, cuts = Array.from({ length: d }, (_, k) => { const v = X.map((x) => x[k]).sort((a, b) => a - b); return [...new Set(Array.from({ length: bins - 1 }, (_, q) => v[Math.floor(((q + 1) * v.length) / bins)]))]; });
  const binOf = (k, v) => { const c = cuts[k]; let lo = 0, hi = c.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (v <= c[mid]) hi = mid; else lo = mid + 1; } return lo; };
  const B = X.map((x) => x.map((v, k) => binOf(k, v))), base = logit(y.reduce((a, b) => a + b, 0) / y.length), F = Array(y.length).fill(base), forest = [];
  const build = (idx, lvl, g, hs) => {
    const G = idx.reduce((a, i) => a + g[i], 0), H = idx.reduce((a, i) => a + hs[i], 0), leaf = { v: -G / (H + lambda) };
    if (lvl >= depth || H < 2 * minH) return leaf;
    let best = null;
    for (let k = 0; k < d; k++) {
      const nb = cuts[k].length + 1, gh = Array.from({ length: nb }, () => [0, 0]);
      for (const i of idx) { gh[B[i][k]][0] += g[i]; gh[B[i][k]][1] += hs[i]; }
      let gl = 0, hl = 0;
      for (let b = 0; b < nb - 1; b++) { gl += gh[b][0]; hl += gh[b][1]; const gr = G - gl, hr = H - hl; if (hl < minH || hr < minH) continue; const gain = gl * gl / (hl + lambda) + gr * gr / (hr + lambda) - G * G / (H + lambda); if (!best || gain > best.gain) best = { gain, k, b }; }
    }
    if (!best || best.gain <= 1e-6) return leaf;
    return { k: best.k, b: best.b, l: build(idx.filter((i) => B[i][best.k] <= best.b), lvl + 1, g, hs), r: build(idx.filter((i) => B[i][best.k] > best.b), lvl + 1, g, hs) };
  };
  const walk = (n, bx) => (n.k == null ? n.v : walk(bx[n.k] <= n.b ? n.l : n.r, bx));
  const all = y.map((_, i) => i);
  for (let t = 0; t < trees; t++) {
    const p = F.map(sig), g = p.map((q, i) => q - y[i]), hs = p.map((q) => q * (1 - q)), tree = build(all, 0, g, hs);
    forest.push(tree); all.forEach((i) => (F[i] += lr * walk(tree, B[i])));
  }
  return (x) => { const bx = x.map((v, k) => binOf(k, v)); return sig(base + lr * forest.reduce((a, tr) => a + walk(tr, bx), 0)); };
}

// ---- metrics ----
export function auc(p, y) {
  const o = p.map((q, i) => [q, y[i]]).sort((a, b) => a[0] - b[0]); let r = 0, n1 = 0, k = 0;
  while (k < o.length) { let e = k; while (e < o.length && o[e][0] === o[k][0]) e++; const rank = (k + e + 1) / 2; for (let q = k; q < e; q++) if (o[q][1]) { r += rank; n1++; } k = e; }
  const n0 = o.length - n1; return n1 && n0 ? (r - (n1 * (n1 + 1)) / 2) / (n1 * n0) : null;
}
export const brier = (p, y) => p.reduce((a, q, i) => a + (q - y[i]) ** 2, 0) / p.length;
export const logloss = (p, y) => -p.reduce((a, q, i) => a + (y[i] ? Math.log(Math.max(1e-9, q)) : Math.log(Math.max(1e-9, 1 - q))), 0) / p.length;
export function bins(p, y, n = 10) {
  const b = Array.from({ length: n }, () => ({ n: 0, p: 0, y: 0 }));
  p.forEach((q, i) => { const k = Math.min(n - 1, Math.floor(q * n)); b[k].n++; b[k].p += q; b[k].y += y[i]; });
  return b.map((x, k) => ({ from: k / n, to: (k + 1) / n, n: x.n, meanP: x.n ? +(x.p / x.n).toFixed(3) : null, observed: x.n ? +(x.y / x.n).toFixed(3) : null }));
}
// expected calibration error over ten equal-width bins
export const ece = (p, y) => bins(p, y).reduce((a, b) => a + (b.n ? (b.n / p.length) * Math.abs(b.meanP - b.observed) : 0), 0);
export const gini = (xs) => { const v = [...xs].sort((a, b) => a - b), n = v.length, s = v.reduce((a, b) => a + b, 0); return s && n ? +((2 * v.reduce((a, x, i) => a + (i + 1) * x, 0)) / (n * s) - (n + 1) / n).toFixed(3) : 0; };
// P(X <= k) for X ~ Binomial(n, p): the calibration ledger's test
export const binomCdf = (k, n, p) => { let s = 0, c = 1; for (let i = 0; i <= k; i++) { s += c * p ** i * (1 - p) ** (n - i); c = (c * (n - i)) / (i + 1); } return s; };

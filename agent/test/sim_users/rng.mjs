// Seeded randomness for the user simulation. Every draw comes from a stream named by what it is for ("busy u07
// 2026-11-05 evening"), so the Serve run and the counterfactual baseline see the same dice for the same event (common
// random numbers): whether Mei is held up at work on Thursday evening does not depend on which world she is in.
// mulberry32 over a 32-bit FNV-1a hash of the seed and the name.

export function hash32(s) {
  let h = 2166136261;
  for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return h >>> 0;
}
export function mulberry(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
// a stream of draws for one named purpose under one seed
export const stream = (seed, ...name) => mulberry(hash32(`${seed}|${name.join("|")}`));
// one draw in [0, 1) for one named event
export const u = (seed, ...name) => stream(seed, ...name)();
export const gauss = (r) => Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());
// a lognormal with this median, sigma in log units
export const lognormal = (r, median, sigma = 0.9) => median * Math.exp(sigma * gauss(r));
export const pick = (r, xs) => xs[Math.floor(r() * xs.length) % xs.length];
export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
export function shuffle(r, xs) { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

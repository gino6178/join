// The prediction a member's agent makes for its own member: logistic regression on the features (features.js), then an
// isotonic map fitted on held-out data, so a probability means what it says; then a band. model.json is the model in
// use. It names the features it was trained on (a model from before the asker's reliability uses the first 24), so
// every version can be applied to today's feature vector. The models are trained on simulated logs, or on the records
// of members who agreed to it (retrain.js), never on anyone else's. Without a model file, simple rules over the same
// features give the probability.
import fs from "node:fs";
import path from "node:path";
import { applyLR, applyIsotonic } from "./fit.js";
import { FEATURES } from "./features.js";

export const BANDS = ["unlikely", "maybe", "likely", "very likely"];
export const CUTS = [0.15, 0.35, 0.6]; // the band edges on the calibrated probability (the card publishes them)
export const RANGES = Object.fromEntries(BANDS.map((b, k) => [b, [[0, ...CUTS][k], [...CUTS, 1][k]]]));
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"));
// The asker's reliability (features.js, 12.1) is off by default: it added almost nothing. MATCH_RELIABILITY=on uses the
// model trained with it (model_reliability.json), and retraining (retrain.js) then learns with it too.
export const reliabilityOn = () => process.env.MATCH_RELIABILITY === "on";
export const FILE = () => process.env.MATCH_MODEL_FILE || path.join(HERE, reliabilityOn() ? "model_reliability.json" : "model.json");
// a model installed by retrain.js after its calibration gate, which replaces the shipped one (MATCH_MODEL_FILE over both)
const ACTIVE = () => path.resolve(process.env.MATCH_MODELS_DIR || "data/match_models", "active.json");
const initial = () => (process.env.MATCH_MODEL_FILE || !fs.existsSync(ACTIVE()) ? FILE() : ACTIVE());

// a model as stored: { version, features: [names], lr: { w, mu, sd }, iso: { xs, ys }, mu, ... }
export function compile(m) {
  if (!m?.lr?.w || !Array.isArray(m.features)) return null;
  const cols = m.features.map((n) => FEATURES.indexOf(n));
  if (cols.some((k) => k < 0) || m.lr.w.length !== cols.length + 1) return null;
  return { ...m, cols, p: (f) => Math.min(0.99, Math.max(0.01, applyIsotonic(m.iso, applyLR(m.lr, cols.map((k) => f[k]))))) };
}
let model = null;
export function load(file = initial()) {
  try { model = compile(JSON.parse(fs.readFileSync(file, "utf8"))); } catch { model = null; }
  return model;
}
load();
export const use = (m) => { model = m ? (m.p ? m : compile(m)) : null; };
export const current = () => model;
export const version = () => (model ? model.version : "likely-rules-1");

// the rules, cheapest first: the yes rate at that hour, lowered when the member is at their usual number of games
// that week, sore, said no lately, or would play on back-to-back days; raised when they have played with the asker
export const ruleScore = (f) => f[2] * (f[11] >= 0 ? 0.6 : 1) * (f[16] ? 0.5 : 1) * (f[14] ? 0.6 : 1) * (f[12] ? 0.7 : 1) * (f[6] > 0 ? 1.3 : 1);
export function predict(f, m = model) {
  if (m) return m.p(f);
  return Math.min(0.95, Math.max(0.02, ruleScore(f)));
}
export const bandOf = (p) => BANDS[CUTS.filter((c) => p >= c).length];
export const rank = (band) => BANDS.indexOf(band);
// the exact chance a member may choose to share, rounded to 0.05; below the lowest band edge it is not given (a band
// alone says "unlikely"), so an exact answer never tells "not free" from "free but not keen" apart
export const EXACT_STEP = 0.05;
export const exactOf = (p) => (p >= CUTS[0] ? +(Math.round(p / EXACT_STEP) * EXACT_STEP).toFixed(2) : null);
// what each band is published to mean, and what it was measured to mean
export const published = () => ({ ranges: RANGES, measured: model?.bands || null, model: version() });

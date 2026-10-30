// Trains the model a member's agent uses to give a band (src/match/model.json), on simulated logs only
// (logs.mjs: population.js seed 7, 400 members, 26 weeks). Logistic regression on weeks 0-17, an isotonic map on weeks
// 18-20, measured on weeks 21-25. No real player's data is read.
//   node test/matchplan/train.mjs [out]          (from agent/; CPU only, under a minute)
import fs from "node:fs";
import path from "node:path";
import { makeLogs, TRAIN_W, TEST_W0 } from "./logs.mjs";
import { fitLR, applyLR, fitIsotonic, applyIsotonic, auc, brier, ece, logloss, bins } from "../../src/match/fit.js";
import { FEATURES as ALL, V1 } from "../../src/match/features.js";
// --v1: the 24 features before the asker's reliability (to compare in match_eval.mjs), on the same logs
const FIRST = process.argv.includes("--v1"), FEATURES = FIRST ? V1 : ALL;
const pick = (f) => f.slice(0, FEATURES.length);
import { BANDS, CUTS } from "../../src/match/model.js";

const OUT = process.argv.slice(2).find((a) => !a.startsWith("--")) || path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), "../../src/match/model.json");
const t0 = Date.now(), { rows } = await makeLogs();
const tr = rows.filter((r) => r.w < TRAIN_W), ca = rows.filter((r) => r.w >= TRAIN_W && r.w < TEST_W0), te = rows.filter((r) => r.w >= TEST_W0), y = (rs) => rs.map((r) => r.y);
const mu = tr.reduce((a, r) => a + r.y, 0) / tr.length, lr = fitLR(tr.map((r) => pick(r.f)), y(tr));
const iso = fitIsotonic(ca.map((r) => applyLR(lr, pick(r.f))), y(ca), mu), p = (r) => applyIsotonic(iso, applyLR(lr, pick(r.f))), pt = te.map(p);
const bandOf = (q) => CUTS.filter((c) => q >= c).length;
const bands = BANDS.map((name, b) => { const rs = te.filter((r, k) => bandOf(pt[k]) === b); return { band: name, share: +(rs.length / te.length).toFixed(3), observedYes: rs.length ? +(rs.reduce((a, r) => a + r.y, 0) / rs.length).toFixed(3) : null }; });
const hash = (await import("node:crypto")).createHash("sha256").update(JSON.stringify([lr.w, iso.xs])).digest("hex").slice(0, 6);
const model = { version: `likely-lr-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${hash}`, trainedOn: "simulated logs only (test/matchplan/logs.mjs: population.js seed 7, 400 members, 26 weeks)", features: FEATURES, mu: +mu.toFixed(4),
  lr: { w: lr.w.map((v) => +v.toFixed(6)), mu: lr.mu.map((v) => +v.toFixed(6)), sd: lr.sd.map((v) => +v.toFixed(6)) }, iso, cuts: CUTS, bands,
  measured: { rows: { train: tr.length, calibration: ca.length, test: te.length }, test: { auc: +auc(pt, y(te)).toFixed(3), brier: +brier(pt, y(te)).toFixed(4), logloss: +logloss(pt, y(te)).toFixed(4), ece: +ece(pt, y(te)).toFixed(4) }, reliability: bins(pt, y(te)) } };
fs.writeFileSync(OUT, JSON.stringify(model, null, 1));
console.log(`${model.version}: ${tr.length} train, ${ca.length} calibration, ${te.length} test rows; test AUC ${model.measured.test.auc}, Brier ${model.measured.test.brier}, ECE ${model.measured.test.ece}; bands ${JSON.stringify(bands)}; ${((Date.now() - t0) / 1000).toFixed(1)} s -> ${OUT}`);

// Retraining the prediction on records (docs/agent_matchmaking_plan.md, section 12.5), on our own server's CPU.
//   1. Rows: every ask a consenting member answered (settings.js `learn`: "use my records to improve the predictions";
//      or, with `simulated`, the simulated members' records only), each with the features as of just before that ask,
//      from that member's own records, and the answer as its label. Nobody else's records are read.
//   2. Split by time: the oldest 70% train, the next 15% calibrate, the newest 15% are held out.
//   3. A new versioned model: logistic regression on the features, an isotonic map on the calibration rows.
//   4. The calibration gate, on the held-out rows: the new model's Brier and ECE no worse than the model in use, and
//      every band (with 30 rows or more) inside its published range. A model that fails is kept on file, not used.
//   5. A model that passes is installed: the one in use is archived, the new one written whole and loaded, and the
//      registry records both, so `rollback()` puts the previous one back.
// Models live in MATCH_MODELS_DIR (data/match_models/): active.json (the one in use, when there is one; otherwise the
// shipped src/match/model.json), one file per version, registry.json. Run by `node src/match/retrain_cli.js` (under
// `nice -n 19`), nightly by the gateway (NIGHTLY=1, MATCH_RETRAIN_HOUR), or from the maintainer's settings.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { readJSON, writeJSON } from "../jsonfile.js";
import { features, FEATURES, V1 } from "./features.js";
import { fitLR, applyLR, fitIsotonic, applyIsotonic, brier, ece, auc } from "./fit.js";
import { compile, current, use, BANDS, CUTS, RANGES, bandOf, load, FILE as SHIPPED, reliabilityOn } from "./model.js";
import * as settings from "./settings.js";

export const DIR = () => path.resolve(process.env.MATCH_MODELS_DIR || "data/match_models");
const reg = () => readJSON(path.join(DIR(), "registry.json"), { active: null, history: [] });
const saveReg = (r) => { fs.mkdirSync(DIR(), { recursive: true }); writeJSON(path.join(DIR(), "registry.json"), r); };
export const activeFile = () => path.join(DIR(), "active.json");
// the model in use: an installed one, else the shipped one
export function loadActive() { return fs.existsSync(activeFile()) ? load(activeFile()) : load(SHIPPED()); }

// one member's training rows: their answered asks, each with the features as of just before it
export function rowsOf(rec, member, { club, venues, travelMin }) {
  const v = venues?.venues?.find((x) => x.id === member.venue) || venues?.venues?.[0], trip = v && member.area && travelMin ? travelMin(member.area, v) : 15;
  const rating = (id) => (id === "you" || !club ? club?.you?.rating : club.members.find((m) => m.id === id)?.rating) || 1500;
  return (rec.asked || []).map((e) => ({ t: e.t, j: member.id, y: e.yes ? 1 : 0,
    f: features(rec, { from: e.from, date: e.date, start: e.start, minutes: 90, format: "singles", now: e.t - 1, gap: (member.rating || 1500) - rating(e.from), trip, prefersDoubles: member.prefers === "doubles" }) }));
}
// whose records may be used: members who said yes to `learn`, or, for the proof on simulated data, simulated members
export function consented(store, members, { simulated = false } = {}) {
  if (simulated) return members.filter((m) => m.simulated || store.of(m.id).simulated);
  const yes = new Set(settings.consenting());
  return members.filter((m) => yes.has(m.id));
}
const evalOn = (m, rows) => { const p = rows.map((r) => m.p(r.f)), y = rows.map((r) => r.y); return { n: rows.length, brier: +brier(p, y).toFixed(5), ece: +ece(p, y).toFixed(5), auc: rows.length ? +(auc(p, y) ?? 0).toFixed(4) : null, bands: BANDS.map((b) => { const xs = rows.filter((r, k) => bandOf(p[k]) === b); return { band: b, n: xs.length, observed: xs.length ? +(xs.reduce((a, r) => a + r.y, 0) / xs.length).toFixed(3) : null }; }) }; };

// train a candidate from rows (time-ordered split), and gate it against the model in use on the held-out rows
export function train(rows, { minRows = 300, source = "consented", members = 0 } = {}) {
  const sorted = [...rows].sort((a, b) => a.t - b.t), n = sorted.length;
  if (n < minRows) return { ok: false, reason: `only ${n} answered asks to learn from (${minRows} needed)`, rows: n };
  const tr = sorted.slice(0, Math.floor(0.7 * n)), ca = sorted.slice(Math.floor(0.7 * n), Math.floor(0.85 * n)), held = sorted.slice(Math.floor(0.85 * n));
  if (tr.every((r) => r.y === tr[0].y)) return { ok: false, reason: "every answer in the training rows is the same", rows: n };
  // (the asker's reliability only with MATCH_RELIABILITY=on: by default the model learns from the first 24 features)
  const names = reliabilityOn() ? FEATURES : V1, pick = (f) => f.slice(0, names.length);
  const mu = tr.reduce((a, r) => a + r.y, 0) / tr.length, lr = fitLR(tr.map((r) => pick(r.f)), tr.map((r) => r.y));
  const iso = fitIsotonic(ca.map((r) => applyLR(lr, pick(r.f))), ca.map((r) => r.y), mu);
  const id = crypto.createHash("sha256").update(JSON.stringify([lr.w, iso.xs])).digest("hex").slice(0, 6);
  const model = { version: `likely-lr-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${id}`, trainedOn: source === "simulated" ? "simulated records only (retrain.js)" : `the records of ${members} members who agreed to it (retrain.js)`, source,
    features: names, mu: +mu.toFixed(4), lr: { w: lr.w.map((v) => +v.toFixed(6)), mu: lr.mu.map((v) => +v.toFixed(6)), sd: lr.sd.map((v) => +v.toFixed(6)) }, iso, cuts: CUTS };
  return { ok: true, model, rows: { train: tr.length, calibration: ca.length, held: held.length }, held, mu };
}
export function gate(candidate, inUse, held, { minBand = 30 } = {}) {
  const cand = compile(candidate), now = inUse?.p ? inUse : compile(inUse);
  const c = evalOn(cand, held), u = now ? evalOn(now, held) : null;
  const bands = c.bands.map((b) => ({ ...b, range: RANGES[b.band], checked: b.n >= minBand, inside: b.n < minBand || (b.observed >= RANGES[b.band][0] && b.observed <= RANGES[b.band][1]) }));
  const why = [];
  if (u && c.brier > u.brier) why.push(`Brier ${c.brier} is worse than ${u.brier}`);
  if (u && c.ece > u.ece) why.push(`ECE ${c.ece} is worse than ${u.ece}`);
  for (const b of bands) if (!b.inside) why.push(`${b.band}: ${b.observed} said yes, outside ${b.range.join("–")}`);
  return { pass: !why.length, why, candidate: { ...c, bands }, inUse: u ? { version: now.version, ...u } : null };
}
// install a model that passed: archive the one in use, write the new one whole, load it, record both
export function install(model, result) {
  fs.mkdirSync(DIR(), { recursive: true });
  const r = reg(), was = current()?.version || null;
  // the model in use is archived first, whichever it is (an installed one, or the shipped one), so it can come back
  if (fs.existsSync(activeFile())) fs.copyFileSync(activeFile(), path.join(DIR(), `${JSON.parse(fs.readFileSync(activeFile(), "utf8")).version}.json`));
  else if (current()) { const { p, cols, ...m } = current(); writeJSON(path.join(DIR(), `${m.version}.json`), m); }
  writeJSON(path.join(DIR(), `${model.version}.json`), { ...model, gate: result });
  writeJSON(activeFile(), { ...model, gate: result });
  use(model);
  r.history.push({ version: model.version, at: Date.now(), source: model.source, replaced: was, gate: { pass: result.pass, brier: result.candidate.brier, ece: result.candidate.ece, inUse: result.inUse && { version: result.inUse.version, brier: result.inUse.brier, ece: result.inUse.ece } } });
  r.active = model.version; saveReg(r);
  return r;
}
// put the previous model back: the one the active one replaced (the shipped one, when it replaced that)
export function rollback() {
  const r = reg(), last = r.history.filter((h) => h.version === r.active).at(-1);
  if (!r.active || !last) return { ok: false, reason: "no installed model to roll back" };
  const prev = last.replaced, file = prev && path.join(DIR(), `${prev}.json`);
  if (file && fs.existsSync(file)) { fs.copyFileSync(file, activeFile()); load(activeFile()); }
  else { fs.rmSync(activeFile(), { force: true }); load(SHIPPED()); }
  r.history.push({ version: current()?.version || null, at: Date.now(), rolledBackFrom: r.active }); r.active = fs.existsSync(activeFile()) ? current()?.version : null; saveReg(r);
  return { ok: true, active: current()?.version || null, from: last.version };
}
export const registry = () => ({ ...reg(), inUse: current()?.version || null });

// the whole run: rows from the consenting members, a candidate, the gate, and install when it passes (dryRun: never)
export function run({ store, members, club, venues, travelMin, simulated = false, dryRun = false, minRows } = {}) {
  const t0 = Date.now(), who = consented(store, members, { simulated });
  const rows = who.flatMap((m) => rowsOf(store.of(m.id), m, { club, venues, travelMin }));
  const report = { at: new Date().toISOString(), source: simulated ? "simulated" : "consented", members: who.length, answered: rows.length };
  const t = train(rows, { source: report.source, members: who.length, ...(minRows ? { minRows } : {}) });
  if (!t.ok) return { ...report, installed: false, reason: t.reason, seconds: (Date.now() - t0) / 1000 };
  const g = gate(t.model, current(), t.held);
  writeJSON(path.join((fs.mkdirSync(DIR(), { recursive: true }), DIR()), `${t.model.version}.json`), { ...t.model, gate: g });
  const installed = g.pass && !dryRun;
  if (installed) install(t.model, g);
  else { const r = reg(); r.history.push({ version: t.model.version, at: Date.now(), source: t.model.source, gate: { pass: g.pass, why: g.why }, installed: false }); saveReg(r); }
  return { ...report, rows: t.rows, version: t.model.version, gate: g, installed, inUse: current()?.version, seconds: +((Date.now() - t0) / 1000).toFixed(1) };
}

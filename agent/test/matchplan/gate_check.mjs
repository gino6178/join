// Which model to ship without the asker's reliability (docs/agent_matchmaking_plan.md, 12.1): the first shipped model
// (results/model_v1.json) or the one retrained without the reliability features on today's simulated world
// (results/model_v1_features.json, from train.mjs --v1), against the one with them (src/match/model_reliability.json).
// Each is scored on the same held-out asks (the test weeks of logs.mjs), and the best-calibrated one without reliability
// goes through the calibration gate (retrain.js gate: Brier and ECE no worse than the other, every band in its range).
//   node test/matchplan/gate_check.mjs [out.json]      (from agent/; CPU only)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "serve_matchplan_gate_"));
Object.assign(process.env, { MATCH_MODELS_DIR: `${tmp}/models`, BOOKINGS_FILE: `${tmp}/bookings.json`, A2A_FILE: `${tmp}/a2a.json`, LEDGER_FILE: `${tmp}/ledger.jsonl`, TRACE_FILE: `${tmp}/traces.jsonl` });
const OUT = process.argv[2] || `test/matchplan/results/gate_check_${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}.json`, HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"));
const { makeLogs, TEST_W0 } = await import("./logs.mjs");
const M = await import("../../src/match/model.js");
const { gate } = await import("../../src/match/retrain.js");
const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const models = { first: read(path.join(HERE, "results/model_v1.json")), retrainedWithout: read(path.join(HERE, "results/model_v1_features.json")), withReliability: read(path.join(HERE, "../../src/match/model_reliability.json")) };
const { rows } = await makeLogs(), held = rows.filter((r) => r.w >= TEST_W0).map((r) => ({ t: r.w, y: r.y, f: r.f }));
const scored = Object.fromEntries(Object.entries(models).map(([k, m]) => { const g = gate(m, null, held); return [k, { version: m.version, features: m.features.length, brier: g.candidate.brier, ece: g.candidate.ece, auc: g.candidate.auc, bandsInside: g.candidate.bands.every((b) => b.inside), bands: g.candidate.bands }]; }));
const without = ["first", "retrainedWithout"].sort((a, b) => scored[a].ece - scored[b].ece || scored[a].brier - scored[b].brier);
const pick = without[0], other = without[1];
const out = { at: new Date().toISOString(), heldOut: held.length, scored, pick, gateAgainstOther: gate(models[pick], M.compile(models[other]), held), gateAgainstWithReliability: gate(models[pick], M.compile(models.withReliability), held) };
const brief = (g) => ({ pass: g.pass, why: g.why });
console.log(JSON.stringify({ scored: Object.fromEntries(Object.entries(scored).map(([k, s]) => [k, { version: s.version, brier: s.brier, ece: s.ece, auc: s.auc, bandsInside: s.bandsInside }])), pick, vsOther: brief(out.gateAgainstOther), vsWithReliability: brief(out.gateAgainstWithReliability) }));
fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
fs.rmSync(tmp, { recursive: true, force: true });

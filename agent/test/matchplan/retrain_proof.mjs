// Retraining, proved on simulated records (docs/agent_matchmaking_plan.md, 12.5): no real member has agreed to it yet.
// The records: 400 simulated members, 26 weeks (logs.mjs), in memory. The model in use: the first one shipped
// (results/model_v1.json, 24 features, from the world before askers could be flaky). Then:
//   1. retrain.run on the simulated members' records: a candidate, the calibration gate on the newest 15%, installed
//      if it passes;
//   2. a run that should fail: rows from 25 members only, against the model just installed;
//   3. the real path, with no member's consent on file: nothing to learn from, nothing changes;
//   4. a rollback, back to the first model.
//   nice -n 19 node test/matchplan/retrain_proof.mjs [out.json]      (from agent/; CPU only)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "serve_matchplan_retrain_"));
Object.assign(process.env, { MATCH_MODELS_DIR: `${tmp}/models`, MATCH_SETTINGS_FILE: `${tmp}/settings.json`, BOOKINGS_FILE: `${tmp}/bookings.json`, A2A_FILE: `${tmp}/a2a.json`, LEDGER_FILE: `${tmp}/ledger.jsonl`, TRACE_FILE: `${tmp}/traces.jsonl` });
const OUT = process.argv[2] || `test/matchplan/results/retrain_proof_${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}.json`; // (results/retrain_proof.json is the run 12.5 cites)
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"));
const { makeLogs } = await import("./logs.mjs");
const M = await import("../../src/match/model.js");
const R = await import("../../src/match/retrain.js");
const { helpers } = await import("../../src/play.js");
const t0 = Date.now(), { members, store } = await makeLogs();
const club = { you: { rating: 1500 }, members }, ctx = { store, members, club, venues: helpers.readVenues(), travelMin: helpers.travelMin };
const v1 = JSON.parse(fs.readFileSync(path.join(HERE, "results/model_v1.json"), "utf8"));
M.use(v1);
const brief = (r) => ({ installed: r.installed, version: r.version, reason: r.reason, members: r.members, answered: r.answered, rows: r.rows, inUse: r.inUse, seconds: r.seconds,
  gate: r.gate && { pass: r.gate.pass, why: r.gate.why, candidate: { brier: r.gate.candidate.brier, ece: r.gate.candidate.ece, auc: r.gate.candidate.auc, bands: r.gate.candidate.bands.map(({ band, n, observed, inside }) => ({ band, n, observed, inside })) }, inUse: r.gate.inUse && { version: r.gate.inUse.version, brier: r.gate.inUse.brier, ece: r.gate.inUse.ece, auc: r.gate.inUse.auc } } });
const out = { at: new Date().toISOString(), startedWith: M.version() };
// 1. the simulated members' records
out.simulated = brief(R.run({ ...ctx, simulated: true }));
console.log("1.", JSON.stringify(out.simulated));
// 2. too little: 25 members' records, against the model now in use
out.few = brief(R.run({ ...ctx, members: members.slice(0, 25), simulated: true, minRows: 100 }));
console.log("2.", JSON.stringify(out.few));
// 3. the real path: only members who said yes to `learn` (none here)
out.consented = brief(R.run({ ...ctx, simulated: false }));
console.log("3.", JSON.stringify(out.consented));
// 4. back to the previous model
out.rollback = R.rollback();
out.registry = R.registry();
console.log("4.", JSON.stringify(out.rollback), "in use:", M.version());
out.seconds = +((Date.now() - t0) / 1000).toFixed(1);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`wrote ${OUT} in ${out.seconds} s`);

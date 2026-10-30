// The demo's invites, answered by the members' own agents (docs/agent_matchmaking_plan.md, 12.8): the demo club with its
// simulated history (match/records.js ensureDemo), every member invited to one of their usual times next week by 200
// seeded bookings. For each band its agent gives for that time: the members, the share of invites they took, and the
// mean of the probability behind the band. No model server needed; nothing under agent/data is read.
//   node test/matchplan/demo_invites.mjs [out.json]      (from agent/)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "serve_matchplan_invites_"));
Object.assign(process.env, { MATCH_RECORDS_FILE: `${tmp}/records.json`, MATCH_AUDIT_FILE: `${tmp}/audit.json`, MATCH_STATE_FILE: `${tmp}/state.json`, MATCH_SETTINGS_FILE: `${tmp}/settings.json`, MATCH_MODELS_DIR: `${tmp}/models`,
  BOOKINGS_FILE: `${tmp}/bookings.json`, A2A_FILE: `${tmp}/a2a.json`, NEGOTIATIONS_FILE: `${tmp}/neg.json`, LEDGER_FILE: `${tmp}/ledger.jsonl`, TRACE_FILE: `${tmp}/traces.jsonl`, A2A_TRANSPORT: "local", MATCH_DEMO_RECORDS: "1" });
const OUT = process.argv[2] || `test/matchplan/results/demo_invites_${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}.json`;
const { readClub } = await import("../../src/club.js");
const { helpers } = await import("../../src/play.js");
const { ensureDemo, store } = await import("../../src/match/records.js");
const { inviteAnswer } = await import("../../src/match/rank.js");
const { features } = await import("../../src/match/features.js");
const M = await import("../../src/match/model.js");
const club = readClub(), venues = helpers.readVenues();
await ensureDemo(club);
const rows = [];
for (const m of club.members) {
  const w = helpers.windows(m.free)[0];
  if (!w) continue;
  const d = new Date(); d.setDate(d.getDate() + 1); while (d.getDay() !== w.day) d.setDate(d.getDate() + 1);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`, start = helpers.hm(w.from);
  const option = { date, start, minutes: 90, format: "singles", venue: { id: m.venue }, talk: null };
  const v = venues.venues.find((x) => x.id === m.venue);
  const p = M.predict(features(store().of(m.id), { from: "you", date, start, minutes: 90, format: "singles", now: Date.now(), gap: (m.rating || 1500) - (club.you?.rating || 1500), trip: v && m.area ? helpers.travelMin(m.area, v) : 15, prefersDoubles: m.prefers === "doubles" }));
  const took = Array.from({ length: 200 }, (_, k) => inviteAnswer(m.id, option, `demo-${k}`)).filter(Boolean).length;
  rows.push({ id: m.id, band: M.bandOf(p), p: +p.toFixed(3), took: +(took / 200).toFixed(3) });
}
const bands = Object.fromEntries(M.BANDS.map((b) => { const xs = rows.filter((r) => r.band === b); return [b, { members: xs.length, took: xs.length ? +(xs.reduce((a, r) => a + r.took, 0) / xs.length).toFixed(3) : null, meanChance: xs.length ? +(xs.reduce((a, r) => a + r.p, 0) / xs.length).toFixed(3) : null }]; }));
const out = { at: new Date().toISOString(), members: rows.length, invitesEach: 200, model: M.version(), bands, rows };
fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(JSON.stringify({ bands }));

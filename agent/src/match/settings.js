// What players and the club chose for matchmaking (docs/agent_matchmaking_plan.md, section 12), on our server
// (MATCH_SETTINGS_FILE, data/match_settings.json):
//   bands   a real player's agent answers "how likely is a yes" (serve.likely) only after the player says yes
//   exact   ... and with the exact chance (rounded to 0.05) instead of a band, if they also choose that
//   learn   their records may be used to improve the predictions (retrain.js); a separate yes from `bands`
//   club.fairExposure   two of the twelve estimates go beyond the fit order, and the least-asked go first within a band
// A real player is a Messenger id or the web app's player ("you"); everything starts off. Simulated and demo members
// keep their own default (they give bands, labelled as simulated). /forget deletes a player's row.
import path from "node:path";
import { readJSON, writeJSON } from "../jsonfile.js";

const FILE = () => path.resolve(process.env.MATCH_SETTINGS_FILE || "data/match_settings.json");
let db = null, file = null;
const load = () => { if (!db || file !== FILE()) { file = FILE(); db = readJSON(file, { players: {}, club: {} }); db.players ||= {}; db.club ||= {}; } return db; };
const save = () => writeJSON(file, db);
// confirm: a club player's agent asks them before a game it agreed for them is booked (on unless they say /confirm off)
export const OFF = { bands: false, exact: false, learn: false, confirm: true };
export const CLUB = { fairExposure: true };

export const get = (id) => ({ ...OFF, ...(load().players[id] || {}) });
export function set(id, patch) {
  const p = { ...get(id) };
  for (const k of Object.keys(OFF)) if (k in patch) p[k] = !!patch[k];
  if (!p.bands) p.exact = false; // the exact chance is a finer band: no bands, no exact chance
  load().players[id] = { ...p, at: Date.now() }; save();
  return get(id);
}
export function forget(id) { if (load().players[id]) { delete db.players[id]; save(); } }
export const club = () => ({ ...CLUB, ...load().club });
export function setClub(patch) { if ("fairExposure" in patch) load().club.fairExposure = !!patch.fairExposure; db.club.at = Date.now(); save(); return club(); }
// the players who said yes to `learn` (retrain.js reads only their records)
export const consenting = () => Object.entries(load().players).filter(([, p]) => p.learn).map(([id]) => id);
// for tests
export const reset = () => { db = { players: {}, club: {} }; file = FILE(); };

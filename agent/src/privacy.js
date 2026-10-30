// Private calendars, per player. With private calendars your agent proposes times from your own week only, and each
// member's agent checks them against its own calendar and rules (a2a.js rounds): the talk takes a few more model calls,
// and nobody's week reaches anyone else's agent. Otherwise your agent lists only the times that fit the club's shared
// calendars. A2A_PRIVATE=1 is the server's default; a player's own choice wins:
//   the app's own player ("app"): data/prefs.json (PREFS_FILE)
//   a Messenger player: their prefs in the store (store.js), so /forget deletes the choice with the rest
// A talk keeps the mode it started in (a2a.js saves it with the talk, so a talk resumed after a restart does too).
import path from "node:path";
import { readJSON, writeJSON } from "./jsonfile.js";

const FILE = () => path.resolve(process.env.PREFS_FILE || "data/prefs.json");
let db = null;
const read = () => (db ||= readJSON(FILE(), { players: {} }));
const save = () => writeJSON(FILE(), read());
const isBool = (v) => v === true || v === false;

export const serverDefault = () => process.env.A2A_PRIVATE === "1";
// the player's own choice: true, false, or null (none: the server's default holds)
export async function choice(who = "app") {
  if (!who) return null;
  if (who === "app") { const v = read().players.app?.privateCalendars; return isBool(v) ? v : null; }
  const store = await import("./store.js");
  const v = store.get(who)?.prefs?.privateCalendars;
  return isBool(v) ? v : null;
}
// what a talk for this player runs with: an explicit mode (a resumed talk's, an eval's), else the player's choice,
// else the server's default
export async function privateFor(who = null, explicit = null) {
  if (isBool(explicit)) return explicit;
  const c = await choice(who);
  return c ?? serverDefault();
}
// set (true or false) or clear (null) the player's choice; false for a player who is not linked
export async function set(who = "app", value = null) {
  if (value !== null && !isBool(value)) throw new Error("privateCalendars is true, false or null");
  if (who === "app") {
    const p = read().players;
    if (value === null) { if (p.app) delete p.app.privateCalendars; } else p.app = { ...(p.app || {}), privateCalendars: value };
    save();
    return true;
  }
  const store = await import("./store.js");
  if (!store.get(who)) return false;
  store.update(who, (q) => { if (value === null) delete q.prefs.privateCalendars; else q.prefs.privateCalendars = value; });
  return true;
}
export async function describe(who = "app") {
  const c = await choice(who), d = serverDefault();
  return { privateCalendars: c ?? d, choice: c, serverDefault: d };
}

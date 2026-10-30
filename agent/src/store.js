// Player store on this machine: who is linked on Messenger, what their agent has learned about them (memory), what
// was said so far, and the lists their agent keeps for them: their calendar, their training log, the games on their
// record and their body log. Everything is in one JSON file (STORE_FILE, by default data/players.json in the folder the
// gateway runs from), and /forget takes a player's whole entry out of it.
import { join, resolve } from "node:path";
import { readJSON, writeJSON } from "./jsonfile.js";
const FILE = resolve(process.env.STORE_FILE || join("data", "players.json"));
let db = readJSON(FILE, { players: {} });
const save = () => { writeJSON(FILE, db); };
// An entry written before one of these lists existed gets it empty, so callers can push to any of them.
const shape = (p) => { if (p) { p.memories ??= []; p.history ??= []; p.events ??= []; p.logs ??= []; p.games ??= []; p.prefs ??= {}; p.body ??= { log: [], workouts: [], days: [] }; } return p; };
// A first message on Messenger: an empty record, with the morning reminder at 7:00.
const newcomer = (id, name) => ({ id, name, linkedAt: Date.now(), memories: [], history: [], events: [], logs: [], games: [], prefs: { reminderHour: 7 } });
// Run a change on an entry and write the file. Nothing happens for a player who is not linked; the entry (or
// undefined) comes back.
const change = (p, fn) => {
  if (p) { fn(p); save(); }
  return p;
};
// --- reading ---------------------------------------------------------------------------------------------------------
export const get = (id) => shape(db.players[id]);
export const players = () => Object.keys(db.players).map(get);
export const update = (id, fn) => change(get(id), fn);
// --- linking and forgetting ------------------------------------------------------------------------------------------
// Link a Messenger chat to a player, or rename one already linked (the Page sends the name it has now).
export const link = (id, name) => {
  const p = (db.players[id] ??= newcomer(id, name));
  p.name = name;
  save();
  return p;
};
export const forget = (id) => {
  delete db.players[id];
  save();
};
// --- what the agent keeps ----------------------------------------------------------------------------------------------
// Keep what the agent learned in chat, skipping what the player's memory already says (in any letter case) and keeping the
// latest 40. Returns the notes that were new.
export const remember = (id, items) => {
  const p = db.players[id];
  if (!p) return [];
  const known = (t) => p.memories.some((m) => m.text.toLowerCase() === t.toLowerCase());
  const added = items.filter((t) => t && !known(t));
  p.memories = [...p.memories, ...added.map((text) => ({ text, at: Date.now(), source: "chat" }))].slice(-40);
  save();
  return added;
};
// One message of the conversation; the latest 60 are kept.
export const addTurn = (id, role, content, meta = {}) => {
  change(db.players[id], (p) => { p.history = [...p.history, { role, content, at: Date.now(), ...meta }].slice(-60); });
};
export const setPref = (id, k, v) => {
  change(db.players[id], (p) => { p.prefs[k] = v; });
};
// The day a reminder went out (key "lastReminder", or "lastCheckin" for the evening one), so it goes once a day.
export const markReminded = (id, day, key = "lastReminder") => setPref(id, key, day);

// Each member's own records, kept for that member's agent (docs/agent_matchmaking_plan.md, 4.2): the asks it answered
// and how (its agent's answer in a talk, then the invite's in or out), its own Match helper's and Autopilot's
// suggestions it took or turned down, and the games it played. Only the member's own agent reads them, to give a
// band (likely.js); the asking side never does. /forget deletes a member's records, and the rows where they asked.
//   MATCH_RECORDS_FILE (data/match_records.json). A store can also live in memory only (the evals: createStore()).
// The demo club (club.json "demo": true) gets a simulated history once, so its members' bands mean something; a real
// club never does (MATCH_DEMO_RECORDS=0 turns it off, =1 forces it).
import path from "node:path";
import { readJSON, writeJSON } from "../jsonfile.js";

const MAX = { asked: 300, own: 120, games: 150 };
const clean = (k, v) => (k.startsWith("_") ? undefined : v); // cached keys (features.js) are not saved

export function createStore(file = null) {
  let db = file ? readJSON(file, { members: {} }) : { members: {} };
  db.members ||= {};
  let timer = null;
  const save = () => {
    if (!file) return;
    // written whole, at most every 200 ms (a talk notes several answers at once)
    if (!timer) timer = setTimeout(() => { timer = null; writeJSON(file, JSON.parse(JSON.stringify(db, clean))); }, 200);
  };
  const flush = () => { if (timer) { clearTimeout(timer); timer = null; } if (file) writeJSON(file, JSON.parse(JSON.stringify(db, clean))); };
  const rec = (id) => (db.members[id] ||= { asked: [], own: [], games: [], sore: [] });
  const trim = (r, k) => { if (r[k].length > MAX[k]) r[k] = r[k].slice(-MAX[k]); };
  return {
    of: (id) => db.members[id] || { asked: [], own: [], games: [], sore: [] },
    has: (id) => !!db.members[id],
    ids: () => Object.keys(db.members),
    // an ask answered: one row per talk (its ref); a later answer in the same talk, or the invite, updates it
    asked(id, e) {
      const r = rec(id), x = e.ref ? r.asked.find((a) => a.ref === e.ref) : null;
      if (x) Object.assign(x, { yes: e.yes ? 1 : 0, src: e.src || x.src, ...(e.final ? { final: true } : {}) });
      else { r.asked.push({ t: e.t ?? Date.now(), from: e.from || "you", date: e.date, start: e.start, yes: e.yes ? 1 : 0, src: e.src || "talk", ...(e.ref ? { ref: e.ref } : {}), ...(e.final ? { final: true } : {}), ...(e.dropped ? { dropped: 1, droppedAt: e.droppedAt ?? e.t } : {}) }); trim(r, "asked"); }
      save();
    },
    // after this member's yes, the asker let the game go: dropped it, or (two at a time) another member took it
    released(id, ref, why = "dropped", t = Date.now()) {
      const r = db.members[id], x = r?.asked.find((a) => a.ref === ref);
      if (!x || !x.yes || r.games.some((g) => g.ref?.startsWith(`${ref}:`) && !g.cancelled)) return false;
      if (why === "taken") x.turnedAway = 1; else Object.assign(x, { dropped: 1, droppedAt: t });
      save(); return true;
    },
    // the game was cancelled after it was booked
    cancelled(id, ref, t = Date.now()) { const g = db.members[id]?.games.find((x) => x.ref === ref); if (g && !g.cancelled) { Object.assign(g, { cancelled: true, cancelledAt: t }); save(); } },
    own(id, e) { const r = rec(id); r.own.push({ t: e.t ?? Date.now(), yes: e.yes ? 1 : 0, src: e.src || "ask" }); trim(r, "own"); save(); },
    game(id, e) {
      const r = rec(id);
      if (e.ref && r.games.some((g) => g.ref === e.ref)) return;
      r.games.push({ t: e.t ?? Date.now(), date: e.date, start: e.start, minutes: e.minutes || 90, with: e.with || [], over: e.over ?? null, src: e.src || "booking", ...(e.ref ? { ref: e.ref } : {}), ...(e.cancelled ? { cancelled: true, cancelledAt: e.cancelledAt ?? e.t } : {}) });
      trim(r, "games"); save();
    },
    sore(id, spells) { rec(id).sore = spells; save(); },
    mark(id, k, v) { rec(id)[k] = v; save(); },
    // /forget: the member's own records, and every row elsewhere that names them (an ask they made, a game with them)
    forget(id) {
      delete db.members[id];
      for (const r of Object.values(db.members)) {
        r.asked = r.asked.filter((a) => a.from !== id);
        for (const g of r.games) if (g.with?.includes(id)) g.with = g.with.filter((w) => w !== id);
      }
      save();
    },
    replace(members) { db = { members }; save(); },
    flush,
    raw: () => db,
  };
}

const FILE = path.resolve(process.env.MATCH_RECORDS_FILE || "data/match_records.json");
let main = null;
export const store = () => (main ||= createStore(FILE));
// for tests: a store of their own
export const useStore = (s) => { main = s; };

// the demo club's history, made once by the simulated world (world.js) for the members that have none
export const demoOn = (club) => (process.env.MATCH_DEMO_RECORDS === "1" || (process.env.MATCH_DEMO_RECORDS !== "0" && club?.demo === true));
let seeding = null;
export async function ensureDemo(club, s = store()) {
  if (!demoOn(club)) return 0;
  const missing = club.members.filter((m) => !s.has(m.id));
  if (!missing.length) return 0;
  seeding ||= (async () => {
    const { seedHistory } = await import("./world.js");
    const n = await seedHistory(club.members, s, { only: new Set(missing.map((m) => m.id)), now: new Date() });
    s.flush(); return n;
  })().finally(() => { seeding = null; });
  return seeding;
}

// ---- notes from the rest of Serve (small hooks) ----
// a member's agent answered a proposal (a2a_server.js over A2A, a2a.js in process): a yes is a time that works for it
export function noteDecision(memberId, { from = "you", date, start, intent, works, ref }) {
  if (!memberId || memberId === "you" || !date) return;
  const yes = intent === "accept" || intent === "counter" || (Array.isArray(works) && works.length > 0);
  store().asked(memberId, { from, date, start, yes, ref, src: "talk" });
}
// an invite answered (play.js status): the member's own yes or no, which settles the talk's row; a yes is a game
export function noteInvite(memberId, option, accept, { t = Date.now(), from = "you" } = {}) {
  if (!memberId || !option?.date) return;
  const ref = option.talk || option.id, s = store();
  s.asked(memberId, { from, date: option.date, start: option.start, yes: accept, ref, final: true, src: "invite" });
  if (accept) s.game(memberId, { t, date: option.date, start: option.start, minutes: option.minutes, with: [from, ...(option.partners || []).map((p) => p.id).filter((x) => x !== memberId)], ref: `${ref}:${memberId}`, src: "booking" });
}
// the player took or turned down their own agent's suggestion (ask.js, autopilot.js)
export function noteOwn(who, yes, src) { if (who) store().own(who, { yes, src }); }
// a member's agent let a held time go (a2a.js holdAnswer): after its yes, the asker dropped the game, or another
// member took it ("taken", two at a time). Only a yes in that talk with no game counts. The asker's reliability
// (features.js) is what this member's agent saw itself.
export function noteRelease(memberId, ref, why = "dropped") { try { return store().released(memberId, ref, why); } catch { return false; } }
// a booked game was cancelled (play.js cancel): each partner's own record of it
export function noteCancel(option) {
  const ref = option?.talk || option?.id;
  if (!ref) return;
  for (const p of option.partners || []) { try { store().cancelled(p.id, `${ref}:${p.id}`); } catch { /* not noted */ } }
}

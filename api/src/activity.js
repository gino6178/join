// What happened, and who did it: every step an agent took for a player, every answer the venue gave and every payment
// step, in one log. This is what the website shows the people involved ("what your agent did"), because trusting an
// agent with money means being able to see each thing it did. Entries hold facts and code-made sentences, never text an
// agent or a model wrote.
//   actor   { kind: "agent" | "player" | "venue" | "platform" | "paypal", player?, client? }
//   who     the players the entry is about; each sees only entries about themselves
import { store, stateFile } from "./store.js";

const db = store(stateFile("activity"), { entries: [] });
export const activityStore = db;
const listeners = new Set();
export const onActivity = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

export function record({ actor, who = [], action, summary, ref = null, data = null }) {
  const e = { id: (db.data.entries.at(-1)?.id || 0) + 1, at: new Date().toISOString(), actor, who: [...new Set(who)], action, summary, ref, data };
  db.data.entries.push(e);
  if (db.data.entries.length > 5000) db.data.entries.splice(0, db.data.entries.length - 5000);
  db.save();
  for (const fn of listeners) try { fn(e); } catch {}
  return e;
}

export const forPlayer = (id, { after = 0, limit = 200 } = {}) => db.data.entries.filter((e) => e.id > after && e.who.includes(id)).slice(-limit);
export const forRef = (ref) => db.data.entries.filter((e) => e.ref === ref);

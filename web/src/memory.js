// What you told your agent, kept as notes in this browser's localStorage (nothing is sent anywhere from here): your
// goals, what hurts, your routine and how you like to play. The agent reads them for a health limit (tasks.js).

const KEY = "shuttlecoach.memory.v1";
const SEED = [
  { kind: "goal", text: "Goal for this season: play twice a week, and try tennis with someone from the club." },
  { kind: "body", text: "Right knee was sore after Sunday's session. Avoid jump training this week." },
  { kind: "routine", text: "Plays on weeknights after 19:00, and Saturday mornings." },
  { kind: "preference", text: "Prefers doubles with people around the same level; happy to play someone new." },
];

const now = () => new Date().toISOString();
let listeners = new Set();

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* storage blocked or corrupt: fall through to the seed */ }
  return SEED.map((m, i) => ({ id: "seed" + i, ...m, at: now(), source: "demo" }));
}
function write(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* private mode: keep in memory only */ }
  cache = list;
  listeners.forEach((f) => f(list));
}
let cache = read();

export const memory = {
  all: () => cache,
  add(text, kind = "note", source = "user") {
    const t = text.trim();
    if (!t) return;
    write([{ id: Math.random().toString(36).slice(2), kind, text: t, at: now(), source }, ...cache]);
  },
  remove(id) { write(cache.filter((m) => m.id !== id)); },
  // undo a remove: put the entry back where it was
  restore(entry, at = 0) { if (!cache.some((m) => m.id === entry.id)) write([...cache.slice(0, at), entry, ...cache.slice(at)]); },
  reset() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } write(read()); },
  subscribe(f) { listeners.add(f); return () => listeners.delete(f); },
};

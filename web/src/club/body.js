// Your body log and your health-app data, on this device (localStorage): what you told your agent hurts, the workouts
// and daily numbers read from your health app's export, and what was imported when. The gateway organizes it
// (agent/src/body.js) and the Autopilot plans around it; nothing here leaves the device except to your own server.
import { useEffect, useState } from "react";

const KEY = "serve.body";
const empty = () => ({ log: null, workouts: [], days: [], imports: [] });
let state = (() => { try { return { ...empty(), ...JSON.parse(localStorage.getItem(KEY) || "{}") }; } catch { return empty(); } })();
const subs = new Set();
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* full or blocked: kept for this visit */ } subs.forEach((f) => f(state)); };

export const readBody = () => state;
export function patchBody(fn) { state = { ...state, ...fn(state) }; save(); }
export function useBody() {
  const [s, set] = useState(state);
  useEffect(() => { subs.add(set); return () => subs.delete(set); }, []);
  return s;
}
// the first visit starts from the demo player's own entries (club.json you.body)
export function seedBody(club) {
  if (state.log == null) { state = { ...state, log: club?.you?.body || [] }; save(); }
}
export const addEntries = (entries) => patchBody((s) => ({ log: [...(s.log || []), ...entries].slice(-300) }));

// an import: new workouts are added (the same workout twice is kept once), daily numbers merged by date
export function mergeImport(r) {
  patchBody((s) => {
    const key = (w) => `${w.date} ${w.start} ${w.sport}`, have = new Set(s.workouts.map(key));
    const workouts = [...s.workouts, ...r.workouts.filter((w) => !have.has(key(w)))].sort((a, b) => (a.date + (a.start || "")).localeCompare(b.date + (b.start || ""))).slice(-500);
    const days = Object.fromEntries(s.days.map((d) => [d.date, d]));
    r.days.forEach((d) => { days[d.date] = { ...days[d.date], ...Object.fromEntries(Object.entries(d).filter(([, v]) => v != null)) }; });
    return { workouts, days: Object.values(days).sort((a, b) => a.date.localeCompare(b.date)).slice(-240), imports: [{ source: r.source, file: r.file, at: Date.now(), counts: r.counts, added: workouts.length - s.workouts.length }, ...s.imports].slice(0, 10) };
  });
}

// what the gateway needs: the log, your games (from the club and the ones you reported here) and the health data
export function bodyInput(club, reported = []) {
  const s = readBody();
  return { log: s.log || club?.you?.body || [], games: [...(club?.you?.history || []), ...reported], workouts: s.workouts, days: s.days };
}

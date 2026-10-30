// The club state of yours (your posts, cheers, results, invites, what the club sees, the Autopilot's goal), kept in this browser. Pages that show it listen for
// "shuttlecoach:game", which fires when an agent task or a share changes it from somewhere else.
export const GAME = "shuttlecoach.game.v1";
export const readGame = () => { try { return JSON.parse(localStorage.getItem(GAME)) || {}; } catch { return {}; } };
// a page saving its own state: no event, so it does not hear itself
export const saveGame = (s) => { try { localStorage.setItem(GAME, JSON.stringify(s)); } catch { /* private mode: this visit only */ } };
export function patchGame(fn) {
  const s = fn(readGame());
  saveGame(s);
  dispatchEvent(new Event("shuttlecoach:game"));
  return s;
}
export function isoWeek(d = new Date()) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())), day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${String(Math.ceil(((t - y) / 864e5 + 1) / 7)).padStart(2, "0")}`;
}
export const today = () => new Date().toISOString().slice(0, 10);

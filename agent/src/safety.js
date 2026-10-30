// What the safety checks did, for the app to show (guard.js notes every check here): when a message or an answer was
// checked, by which guard, the verdict and what happened. Never the text: not what the player wrote, not what a model
// wrote, not a review. A player's checks are shown only with that player (Messages lists each chat's own), and a
// player who sent /forget and linked again starts with none.
//   on       "message"  what the player wrote, before their agent acts on it (Llama Guard 3)
//            "answer"   a model's answer for the player, before it is sent (Llama Guard 3)
//            "sentence" a model's sentence for the player (the Match helper's ask) before it is shown (Llama Guard 3)
//            "reviews"  a place's reviews before a model reads them (Prompt Guard 2)
//            "idea"     an idea a member shares with the club (the community loop's screen)
//   verdict  "safe" | "flagged" | "not checked" (the guard did not answer: not running, too slow, no verdict)
//   action   "passed" | "refused" | "helpline" | "replaced" | "left out" (reviews) | "held" (an idea waits)
// Kept in memory only, the latest 600: nothing about a check is written to disk but the trace's span (trace.js), which
// has no player and no text either.
import { AsyncLocalStorage } from "node:async_hooks";

const scope = new AsyncLocalStorage();
const recent = [];
// run fn as `player`'s (a Messenger chat's id, or "app"): every check inside it is theirs, and collected
export function as(player, fn) {
  const st = { player, rows: [] };
  return scope.run(st, fn);
}
// the same, with the checks made inside fn returned next to its result
export async function collect(player, fn) {
  const st = { player, rows: [] };
  const result = await scope.run(st, fn);
  return { result, checks: st.rows.map(shown) };
}
export const player = () => scope.getStore()?.player ?? null;
// the rest of this request is `player`'s (server.js: every /api/ request comes from the app's own player)
export const enter = (p) => scope.enterWith({ player: p, rows: [] });
export function note(x) {
  const st = scope.getStore(), row = { at: Date.now(), player: st?.player ?? null, ...x };
  recent.push(row); if (recent.length > 600) recent.shift();
  st?.rows.push(row);
  return row;
}
const shown = ({ player: _p, ...r }) => r;
// a player's checks, newest first; since: only those after it (a chat linked again after /forget starts with none)
export function list({ player: p = null, n = 30, since = 0 } = {}) {
  return recent.filter((r) => (p == null || r.player === p) && r.at >= since).slice(-Math.max(1, Math.min(200, n))).reverse().map(shown);
}
// what the guards did since the gateway started, by kind of check
export function tally() {
  const t = {};
  for (const r of recent) { const k = (t[r.on] ||= { checked: 0, flagged: 0, notChecked: 0 }); if (r.verdict === "not checked") k.notChecked++; else k.checked++; if (r.verdict === "flagged") k.flagged++; }
  return t;
}
export function forget(p) { for (let i = recent.length - 1; i >= 0; i--) if (recent[i].player === p) recent.splice(i, 1); }

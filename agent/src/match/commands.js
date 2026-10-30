// The player's matchmaking choices in Messenger (pocket.js hands over /bands and /learn), each said in one line:
//   /bands on|off          your agent answers "how likely is a yes" for you (off until you say yes)
//   /bands exact on|off    ... with the exact chance instead of a word
//   /learn on|off          your answers and games may help improve the predictions (separate from /bands)
// /forget sets them all back to off (settings.js).
import * as settings from "./settings.js";

const BANDS_ON = "On: when another player's agent asks how likely you are to say yes, your agent answers with one word (unlikely, maybe, likely or very likely), worked out on this server from your own answers and games, which never leave it. /bands off stops it; /bands exact on gives the exact chance instead.";
const BANDS_OFF = "Off: your agent gives no estimate of your yes to anyone, and its card no longer offers one.";
const EXACT_ON = "On: your agent gives your exact chance instead of a word, rounded to 5% and only from 15% up (below that it says unlikely). It tells the other agent a little more than a word does. /bands exact off goes back to the word.";
const EXACT_OFF = "Off: your agent answers with a word again (unlikely, maybe, likely or very likely).";
const LEARN_ON = "On: your answers and games may be used, on this server only, to make Serve's predictions better for everyone. This is separate from /bands. /learn off stops it, and /forget deletes everything.";
const LEARN_OFF = "Off: your answers and games are not used to improve the predictions.";

export function command(id, text) {
  const t = String(text).trim().toLowerCase(), on = /\bon\b/.test(t), off = /\boff\b/.test(t), s = settings.get(id);
  if (t.startsWith("/confirm")) {
    if (!on && !off) return `Asking you first is ${s.confirm ? "on" : "off"}: ${s.confirm ? "when another player's agent agrees a game with yours, I ask you before it is booked" : "your agent's yes books the game"}. /confirm on or /confirm off.`;
    settings.set(id, { confirm: on }); return on ? "On: I'll ask you before a game another player's agent agreed with yours is booked, and you can back out." : "Off: your agent's yes books the game, and I'll tell you when it does.";
  }
  if (t.startsWith("/learn")) {
    if (!on && !off) return `Learning from your records is ${s.learn ? "on" : "off"}. /learn on lets your answers and games help improve the predictions; /learn off stops it.`;
    settings.set(id, { learn: on }); return on ? LEARN_ON : LEARN_OFF;
  }
  if (/^\/bands\s+exact\b/.test(t)) {
    if (!on && !off) return `The exact chance is ${s.exact ? "on" : "off"}. /bands exact on gives it instead of a word; /bands exact off goes back to the word.`;
    if (on && !s.bands) return "Turn estimates on first with /bands on; then /bands exact on gives the exact chance instead of a word.";
    settings.set(id, { exact: on }); return on ? EXACT_ON : EXACT_OFF;
  }
  if (!on && !off) return `Estimates are ${s.bands ? `on${s.exact ? ", with the exact chance" : ""}` : "off"}. /bands on lets your agent tell other players' agents how likely you are to say yes, in one word; /bands off stops it.`;
  settings.set(id, { bands: on }); return on ? BANDS_ON : BANDS_OFF;
}

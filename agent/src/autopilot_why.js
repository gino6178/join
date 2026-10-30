// What an Autopilot run tells the app besides the plan (autopilot.js adds it to its result):
//   leftOut    the members the plan left out because of something the player told their agent (find_partners'
//              leaveOut), each with the note that asked for it when one names them (get_week's fromMemory, or what
//              the recall tool found), and the day it was said
//   calendars  "private" or "shared": the calendars this player's talks ran with (privacy.js)
import { describe } from "./privacy.js";
import { checkOut } from "./guard.js";

// the run's last sentence, written by the model for the player: past Llama Guard like every model's text for the
// player (a span in the run's trace); the code-made sentence when it is flagged
export const checkedSummary = async (text, fallback) => (await checkOut(text, { fallback })).text;

const plain = (t) => String(t || "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
const first = (n) => String(n || "").split(" ")[0];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// (a note that asks to keep someone away: "leave Tomás out", "no games with Leo", "skip Kenji for now")
const AWAY = /\b(leave|left|keep|skip|avoid|without|out|not with|no games? with|don'?t|stop)\b/;
export function leftOutWhy({ leftOut = [], fromMemory = [], trail = [], club = { members: [] } } = {}) {
  const notes = [...fromMemory.map((n) => ({ note: n.note, said: n.on || null })), ...trail.filter((t) => t.name === "recall").flatMap((t) => (t.res?.notes || []).map((n) => ({ note: n.note, said: n.said || null })))];
  const rx = (m) => new RegExp(`(^|[^\\p{L}])${esc(plain(first(m.name)))}($|[^\\p{L}])`, "u");
  const noteFor = (m) => notes.find((x) => rx(m).test(plain(x.note)));
  // passed in leaveOut; or a candidate a note asks to keep away whom the plan never asked (the model can follow the
  // note without leaveOut, and the result says so either way)
  const asked = new Set(trail.filter((t) => t.name === "negotiate").flatMap((t) => t.args?.members || []));
  const candidates = new Set(trail.filter((t) => t.name === "find_partners").flatMap((t) => (t.res?.candidates || []).map((c) => c.id)));
  const skipped = club.members.filter((m) => candidates.has(m.id) && !asked.has(m.id) && AWAY.test(plain(noteFor(m)?.note || ""))).map((m) => m.id);
  return [...new Set([...leftOut, ...skipped])].map((id) => club.members.find((m) => m.id === id)).filter(Boolean).map((m) => {
    const n = noteFor(m);
    return { id: m.id, name: m.name, ...(n ? { because: String(n.note).slice(0, 240), said: n.said } : {}) };
  });
}
export async function extras({ player = "app", ...rest } = {}) {
  let calendars = null;
  try { calendars = (await describe(player)).privateCalendars ? "private" : "shared"; } catch { /* unknown */ }
  return { leftOut: leftOutWhy(rest), calendars };
}

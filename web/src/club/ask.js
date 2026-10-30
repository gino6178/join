// "Want a game?" in the app: the Match helper's question, fetched once a day when the agent home opens (the gateway
// does the looking: agent/src/ask.js). The question and whether you said "not this week" stay on this device; a yes
// becomes a job (tasks.js startGame) that the Talk helper runs with the other players' agents.
import { useEffect, useState } from "react";
import { agentAskNext, agentAskAnswer } from "../agent.js";
import { autopilotInput, startGame } from "../tasks.js";
import { bodyInput, readBody } from "./body.js";

const KEY = "serve.ask.v1";
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
let state = (() => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } })();
const subs = new Set();
function set(patch) {
  state = { ...state, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* private mode: this visit only */ }
  subs.forEach((f) => f(state));
}
// what the gateway needs: your games, what is booked, and the body log (without GPS routes); a question for your agent
// also takes your weekly goal
export function input(club) {
  const a = autopilotInput(), b = bodyInput(club, a.history);
  return { history: a.history, upcoming: a.upcoming, goal: a.goal, body: { log: b.log, workouts: b.workouts.map(({ route, ...w }) => w), days: b.days } };
}
const keep = (r) => (r?.id ? { ask: r, none: null } : { ask: null, none: r?.none || null, snoozed: r?.snoozed || state.snoozed || null });

export function useGameAsk(club) {
  const [s, setS] = useState(state), [busy, setBusy] = useState(null);
  useEffect(() => { subs.add(setS); return () => subs.delete(setS); }, []);
  useEffect(() => {
    if (!club || state.day === today() || (state.snoozed && state.snoozed > today())) return;
    set({ day: today() });
    agentAskNext(input(club)).then((r) => set(keep(r))).catch(() => set({ day: null }));
  }, [club]);
  async function answer(choice) {
    const a = state.ask;
    if (!a || busy) return;
    if (choice === "yes") {
      set({ ask: null, none: null });
      // their agent said no: the next opening comes back with the answer
      const t = await startGame(a);
      if (t?.result?.next) set(keep(t.result.next));
      return;
    }
    setBusy(choice);
    try {
      const r = await agentAskAnswer(a.id, choice);
      if (choice === "week") set({ ask: null, none: r.text, snoozed: r.snoozed });
      else set(keep(r.next));
    } catch { /* the gateway is down: the question stays */ } finally { setBusy(null); }
  }
  return { ask: s.ask, none: s.none, busy, answer };
}

// what the Body helper is keeping track of: the latest entry of each part, still sore (2/5 or more, in the last ten days)
const NAME = { lowerback: "lower back", upperback: "upper back" };
export const partName = (e) => `${e.side && e.side !== "both" ? e.side + " " : ""}${NAME[e.part] || e.part}`;
export function soreNow(log = readBody().log || []) {
  const last = {};
  for (const e of [...log].sort((a, b) => a.at.localeCompare(b.at))) last[`${e.part}:${e.side || ""}`] = e;
  return Object.values(last).filter((e) => e.kind !== "fine" && e.level >= 2 && Date.now() - new Date(e.at) <= 10 * 864e5).sort((a, b) => b.level - a.level);
}
// the same limits the gateway sets (agent/src/body.js): legs and arms make it doubles first, the back keeps games short
const BACK = new Set(["neck", "upperback", "lowerback", "core"]);
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export function bodyLine(sore) {
  if (!sore.length) return "Nothing sore in your log.";
  const up = (t) => t.replace(/^./, (c) => c.toUpperCase()), it = sore.length > 1 ? "they settle" : "it settles";
  const rule = sore.some((e) => !BACK.has(e.part)) ? `Your games stay doubles first until ${it}` : `Your games stay short until ${it}`;
  const ask = new Date(Math.max(...sore.map((e) => +new Date(e.at))) + 2 * 864e5);
  return `${sore.slice(0, 2).map((e) => `${up(partName(e))} ${e.level}/5`).join(", ")}. ${rule}${ask > Date.now() ? `; I'll ask how it is on ${DOW[ask.getDay()]}` : ""}.`;
}

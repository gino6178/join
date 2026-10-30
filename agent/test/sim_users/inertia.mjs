// The inertia model: whether a simulated person does something, made by code from their persona's numbers and named
// dice (rng.mjs). The persona model (persona_llm.mjs) only writes what they say. Both worlds use these same functions
// and the same dice: the run with Serve (run.mjs) and the counterfactual without it (baseline.mjs). Pure: no I/O.
import { u, stream, lognormal, clamp } from "./rng.mjs";

export const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad = (n) => String(n).padStart(2, "0");
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const toMin = (s) => { const [h, m] = String(s).split(":").map(Number); return h * 60 + (m || 0); };
export const hm = (m) => `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;
export const dayOf = (date) => DAYS[new Date(`${date}T12:00`).getDay()];
// "Tue 19-22" -> { day: "Tue", from: 1140, to: 1320 }
export const windows = (free) => (free || []).map((w) => { const m = /^(\w{3})\s+(\d{1,2})-(\d{1,2})$/.exec(w); return m && { day: m[1], from: +m[2] * 60, to: +m[3] * 60, label: w }; }).filter(Boolean);
export const inWindow = (p, date, start, minutes = 90) => windows(p.free).find((w) => w.day === dayOf(date) && w.from <= toMin(start) && toMin(start) + minutes <= w.to) || null;

// how many games they would like in the trial: the weekly goal, over the four days of a seven-day week, at least one
export const trialNeed = (p, days = 4) => Math.max(1, Math.round((p.goal?.perWeek || 1) * days / 7 + 0.15));

// whether they look at Serve at all on a day (and so answer what came in), and which of their usual phone moments
// they use. A lazy person opens it some days and then only once
export function dayPlan(seed, p, date) {
  const open = u(seed, "open", p.id, date) < p.inertia.pOpen;
  if (!open) return { open: false, sessions: [] };
  const r = stream(seed, "sessions", p.id, date), λ = p.inertia.laziness;
  const keep = p.sessions.filter(() => r() < clamp(0.85 - 0.6 * λ, 0.2, 0.85));
  return { open: true, sessions: keep.length ? keep : [p.sessions[Math.floor(r() * p.sessions.length)]] };
}
// life getting in the way: one of their free windows is taken that day (work ran late, a sick kid)
export const busy = (seed, p, date, w) => u(seed, "busy", p.id, date, w?.label || "any") < p.inertia.pBusy;
export const freeThen = (seed, p, date, start, minutes = 90) => { const w = inWindow(p, date, start, minutes); return !!w && !busy(seed, p, date, w); };

// bothering to ask for a game, once in a day they open the chat and still want one. The same number decides whether
// they start organizing one by hand in the baseline (no extra cost of starting is charged to the baseline, which is the
// conservative choice: the baseline's extra cost is the hassle after that, modelled step by step)
export const pInitiate = (p) => clamp(0.75 - 0.65 * p.inertia.laziness, 0.06, 0.75);
export const initiates = (seed, p, date) => u(seed, "initiate", p.id, date) < pInitiate(p);
// how long they take to answer once a message is in, in minutes (a lognormal around their median)
export const replyDelay = (seed, p, key) => Math.round(clamp(lognormal(stream(seed, "reply", p.id, key), p.inertia.replyMin, 0.8), 1, 24 * 60));

// The answer to a game put to them, by their agent or by someone in a group chat: "yes", "other" (another time),
// "week" (not this week) or "ignore". ctx: { date, start, minutes, need (games still wanted), burned (they were stood
// up by one of these people before), key }
export function answerGame(seed, p, { date, start, minutes = 90, need = 1, burned = false, key }) {
  const r = u(seed, "answer", p.id, key);
  if (need <= 0) return r < 0.75 ? "week" : "ignore";
  if (!freeThen(seed, p, date, start, minutes)) return r < 0.6 ? "other" : "week";
  const yes = (1 - p.inertia.pNotThisWeek) * (burned ? 0.5 : 1);
  return r < yes ? "yes" : r < yes + (1 - yes) * 0.6 ? "week" : "ignore";
}
// whether they turn up to a booked game. knows: they know about it (their own booking, or a notice they saw). Life
// getting in the way that day, and their own flakiness, can each stop them
export function shows(seed, p, { date, start, minutes = 90, knows = true, key }) {
  if (!knows) return { shows: false, why: "didn't know about it" };
  const w = inWindow(p, date, start, minutes);
  if (w && busy(seed, p, date, w)) return { shows: false, why: "something came up" };
  if (!w) return { shows: false, why: "not a time they are free" };
  if (u(seed, "flake", p.id, key) < p.inertia.flaky) return { shows: false, why: "didn't turn up" };
  return { shows: true, why: null };
}
// a notice from Serve they get by push, seen before the game (or they open the chat in between)
export const seesPush = (seed, p, key) => u(seed, "push", p.id, key) < clamp(0.45 + 0.5 * (1 - p.inertia.laziness), 0.4, 0.95);

// what they do around the edges, by day: the choices they made once (personas.json) happen on the first day they open
// the chat after a day drawn from how civic they are; an idea, a vote and a feed post as chances per open day
export const choiceDay = (seed, p, what) => 1 + Math.floor(u(seed, "choiceDay", p.id, what) * (p.civic > 0.6 ? 2 : 3));
export const sharesIdea = (seed, p, day) => day >= 2 && u(seed, "idea", p.id, day) < 0.55 * p.civic;
export const votes = (seed, p, day) => day >= 2 && u(seed, "vote", p.id, day) < 0.5 * p.civic;
export const postsAfterGame = (seed, p, key) => u(seed, "post", p.id, key) < 0.65 * p.social;
export const likesToday = (seed, p, day) => (u(seed, "likes", p.id, day) < p.social ? 1 + Math.floor(u(seed, "likesN", p.id, day) * 3) : 0);
export const comments = (seed, p, key) => u(seed, "comment", p.id, key) < 0.3 * p.social;
export const logsGame = (seed, p, key) => u(seed, "log", p.id, key) < clamp(0.9 - 0.6 * p.inertia.laziness, 0.2, 0.9);
// an aside to their agent on a day they open the chat: a question, a word about their body, or nothing
export function aside(seed, p, day) {
  const r = u(seed, "aside", p.id, day);
  if (p.niggle && day >= 2 && r < 0.35) return "niggle";
  if (r < 0.2 + 0.15 * (1 - p.inertia.laziness)) return "question";
  return null;
}

// the earliest time two people are both free (their windows overlap by a game's length, neither held up that day), at
// least three hours ahead, up to `until`: what someone in a group chat offers instead ("can't Thursday, Friday 19:00?")
export function commonSlot(seed, a, b, now, { until = null, days = 4, exclude = [], minutes = 90 } = {}) {
  for (let i = 0; i < days; i++) {
    const d = new Date(now); d.setDate(d.getDate() + i);
    const date = ymd(d);
    if (until && date > until) break;
    if (exclude.includes(date)) continue;
    for (const wa of windows(a.free).filter((x) => x.day === DAYS[d.getDay()])) for (const wb of windows(b.free).filter((x) => x.day === wa.day)) {
      const from = Math.max(wa.from, wb.from, i === 0 ? Math.ceil((now.getHours() * 60 + now.getMinutes() + 180) / 60) * 60 : 0), to = Math.min(wa.to, wb.to);
      if (to - from >= minutes && !busy(seed, a, date, wa) && !busy(seed, b, date, wb)) return { date, day: wa.day, start: hm(from) };
    }
  }
  return null;
}
// the game they have in mind when they ask: the soonest of their free windows that is at least three hours away and
// not taken that day, within the next three days
export function wantedSlot(seed, p, now, { days = 3, exclude = [], until = null } = {}) {
  for (let i = 0; i < days; i++) {
    const d = new Date(now); d.setDate(d.getDate() + i);
    const date = ymd(d);
    if (until && date > until) break;
    if (exclude.includes(date)) continue;
    for (const w of windows(p.free).filter((x) => x.day === DAYS[d.getDay()]).sort((a, b) => a.from - b.from)) {
      const start = Math.max(w.from, i === 0 ? Math.ceil((now.getHours() * 60 + now.getMinutes() + 180) / 60) * 60 : 0);
      if (start + 90 > w.to || busy(seed, p, date, w)) continue;
      return { date, day: w.day, start: hm(start), window: w.label, format: p.prefers === "any" ? (u(seed, "format", p.id, date) < 0.5 ? "singles" : "doubles") : p.prefers, sport: "badminton" };
    }
  }
  return null;
}

// the same person, lazier or less lazy: every number that follows laziness moves by the formula it was made with
// (personas.mjs), keeping the person's own noise. For the sensitivity check (validity.mjs, run.mjs --lazy-shift)
export function withLaziness(p, to) {
  const i = p.inertia, l2 = clamp(to, 0.02, 0.98), d = l2 - i.laziness;
  return { ...p, inertia: { ...i, laziness: +l2.toFixed(3), pOpen: +clamp(i.pOpen - 0.6 * d, 0.3, 0.97).toFixed(2), replyMin: Math.round(clamp(i.replyMin * Math.exp(4 * d), 4, 600)),
    pNotThisWeek: +clamp(i.pNotThisWeek + 0.4 * d, 0.05, 0.6).toFixed(2), flaky: +clamp(i.flaky + 0.14 * d, 0.01, 0.25).toFixed(2), patienceH: Math.round(clamp(i.patienceH - 8 * d, 1, 12)) } };
}

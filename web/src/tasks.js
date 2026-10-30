import { useEffect, useState } from "react";
import { agentPlay, agentAnswer, agentBook, agentBooking, agentCancel, agentBest, agentTalk, agentAutopilot, agentAutopilotAnswer, agentAskAnswer } from "./agent.js";
import { memory } from "./memory.js";
import { readGame, patchGame, isoWeek } from "./club/game.js";
import { postToClub } from "./club/share.js";
import { prefersReducedMotion } from "./hooks.js";
import { sayCheck } from "./components/Safety.jsx";

// The agent's jobs. Everything the agent does for the player is a task: what was asked, the trail of steps as each one
// finishes (streamed from the gateway), and where it stands: running, needs you (a choice to make), done or failed.
// Tasks live in this browser and keep going while the player moves around the app; a booking that is waiting for
// answers is followed again after a reload.
const KEY = "shuttlecoach.tasks.v1";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const first = (n) => n.split(" ")[0];
const subs = new Set();
let list = (() => {
  try {
    return (JSON.parse(localStorage.getItem(KEY)) || []).map((t) =>
      t.state === "running" && !t.booking ? { ...t, state: "failed", working: null, error: "Stopped when the page was closed. Ask again." } : t);
  } catch { return []; }
})();
function set(next) {
  list = next.slice(0, 30);
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* private mode: this visit only */ }
  subs.forEach((f) => f(list));
}
// answers cite facts like [F12]; the cards and notices show the sentence without the tags
export const plain = (t) => String(t ?? "").replace(/\s*\[(?:F|E)\d+(?:,\s*(?:F|E)?\d+)*\]/g, "");
export function update(id, patch) { set(list.map((t) => (t.id === id ? { ...t, ...(typeof patch === "function" ? patch(t) : patch) } : t))); }
export const taskById = (id) => list.find((t) => t.id === id) || null;
export const dismiss = (id) => set(list.filter((t) => t.id !== id));
export function useTasks() {
  const [l, setL] = useState(list);
  useEffect(() => { subs.add(setL); setL(list); return () => subs.delete(setL); }, []);
  return l;
}

// what every job needs to know about the player: their level in the club, and a health limit from what they told
// their agent (club: the demo club, club.json, where "you" is a member like the others)
const hurtIn = (texts) => texts.some((t) => /knee|ankle/i.test(t) && /sore|pain|hurt|injur|avoid jump/i.test(t));
export function playerOf(club) {
  return { name: "You", level: club?.you?.level || "B", limit: hurtIn(memory.all().map((m) => m.text)) ? "no jump landings" : null };
}

// which job a sentence is: a highlight reel, the Autopilot, courts, the body log, the best match, a random match, the
// leaderboard, your goals, play (court, people, challenge), or a question for your agent
export function intentOf(text) {
  if (/highlight|reel|instagram|facebook post|post (it|my|on)|精華|剪片/i.test(text)) return "highlight";
  if (/autopilot|plan my week|keep me playing|line up (my )?(games|week)|自動安排|幫我安排/i.test(text)) return "autopilot";
  if (/\b(courts?|fields?|parks?|pitch(es)?)\b.{0,30}\b(near|nearby|around)\b|where can (we|i) play/i.test(text)) return "courts";
  if (/\b(knee|ankle|calf|calves|shin|achilles|foot|hamstring|thigh|hip|groin|glute|back|neck|shoulder|elbow|wrist|chest|ribs?)\b.{0,40}\b(hurts?|pain|sore|aches?|tight|stiff|twisted|pulled|fine|better)\b|\b(hurts?|sore|pain in)\b.{0,20}\b(knee|ankle|calf|back|shoulder|elbow|wrist)\b/i.test(text)) return "body";
  if (/best (match|opponent|partner|pairing)|who should i (play|challenge)|right opponent|suits me|最適|最佳|最合適/i.test(text)) return "best";
  if (/random (match|game|opponent|partner)|match me|draw (me )?a (match|game)|隨機|配對/i.test(text)) return "random";
  if (/leaderboard|ranking|my rank|rating|排行|排名/i.test(text)) return "ranks";
  if (/\b(my )?(goals?|streak)\b|club challenge/i.test(text)) return "goals";
  if (/want to play|book|court|find a game|game (on|this|next)|play (on|this|next|tomorrow|tonight|with)|doubles|singles|spar|challenge|rematch|約|打球|訂場|找人|單打|雙打|單挑|陪練|對打/i.test(text)) return "play";
  return "ask";
}

function create(kind, fields) {
  const id = `${kind}-${Date.now().toString(36)}`;
  set([{ id, kind, state: "running", steps: [], working: null, started: Date.now(), ...fields(id) }, ...list]);
  return id;
}
// The gateway sends steps the moment they finish, and the code steps come in a burst; they are shown one at a time
// so the trail can be followed (no pause when the player asked for less motion).
function trail(id) {
  let q = Promise.resolve();
  return {
    on: (e) => { q = q.then(async () => {
      if (e.type === "working") { update(id, { working: e.step }); if (!prefersReducedMotion()) await wait(300); return; }
      // a message between your agent and another member's agent
      if (e.type === "a2a") { update(id, (t) => ({ messages: [...(t.messages || []), { ...e, at: Date.now() }], working: null })); if (!prefersReducedMotion()) await wait(700); return; }
      update(id, (t) => ({ steps: [...t.steps, { ...e, at: Date.now() }], working: null }));
      if (!prefersReducedMotion()) await wait(480);
    }); },
    settled: () => q,
  };
}
async function run(id, job, finish) {
  const tr = trail(id);
  try {
    const r = await job(tr.on);
    await tr.settled();
    update(id, { ...finish(r), working: null, finished: Date.now() });
  } catch (e) {
    await tr.settled();
    update(id, { state: "failed", working: null, error: `The agent could not be reached (${e.message}).`, finished: Date.now() });
  }
}

// ---- play: court, people, calendars, the venue in the middle; then the booking and the answers --------------------
export function startPlay(text, you) {
  const id = create("play", (id) => ({ title: text, href: `play?task=${id}` }));
  run(id, (on) => agentPlay(text, you, on), (r) => ({
    result: r, state: r.options.length ? "needs" : "done",
    summary: r.options.length ? `${r.options.length} options. Best: ${r.options[0].day} ${r.options[0].start} at ${r.options[0].venue.name}` : r.message,
  }));
  return id;
}
const bookingLine = (b) => b.state === "confirmed" ? `Game on: ${b.option.day} ${b.option.start}, ${b.option.venue.name}` : b.state === "cancelled" ? "Cancelled"
  : b.state === "short" ? "Not enough players yet" : `Waiting for answers: ${b.yes ?? 0} of ${b.need} in`;
export async function bookFor(id, option, you) {
  const t = taskById(id);
  const b = await agentBook(option, t?.result?.options?.[0]?.id === option.id ? t.result.invites : {}, you);
  if (b.error) throw new Error(b.error);
  update(id, { booking: b, chosen: option.id, state: "running", working: "Waiting for answers", summary: bookingLine(b) });
  follow(id);
}
// the same game at another time: release the court, then book and invite again
export async function rebookFor(id, option, you) {
  const t = taskById(id);
  if (t?.booking && t.booking.state !== "cancelled") await agentCancel(t.booking.id);
  await bookFor(id, option, you);
}
export async function cancelFor(id) {
  const t = taskById(id);
  const b = await agentCancel(t.booking.id);
  update(id, { booking: b, state: "done", working: null, summary: bookingLine(b) });
}
const following = new Set();
function follow(id) {
  if (following.has(id)) return;
  following.add(id);
  const tick = async () => {
    const t = taskById(id);
    if (!t?.booking) return following.delete(id);
    try {
      const b = await agentBooking(t.booking.id);
      if (b.error) { update(id, { state: "failed", working: null, error: b.error }); return following.delete(id); }
      const over = ["confirmed", "cancelled", "short"].includes(b.state);
      update(id, { booking: b, state: over ? (b.state === "short" ? "needs" : "done") : "running", working: over ? null : bookingLine(b), summary: bookingLine(b) });
      if (b.state === "confirmed") credit(b);
      if (over) return following.delete(id);
      setTimeout(tick, 1500);
    } catch { setTimeout(tick, 4000); }
  };
  tick();
}
list.filter((t) => t.booking && t.booking.state === "waiting").forEach((t) => follow(t.id));

// a confirmed game counts in the club game: +30 XP and a post in the club feed, once per booking
function credit(b) {
  let fresh = false;
  patchGame((s) => {
    if ((s.activity || []).some((a) => a.id === b.id)) return s;
    fresh = true;
    return { ...s, activity: [...(s.activity || []), { date: new Date().toISOString().slice(0, 10), week: isoWeek(), kind: "game", id: b.id }] };
  });
  if (!fresh) return;
  const names = b.invites.filter((i) => i.status === "in").map((i) => first(i.name));
  postToClub({ kind: "game", text: `Booked ${b.option.format} on ${b.option.day} ${b.option.start} at ${b.option.venue.name} with ${names.join(", ")}.` });
}

// ---- the Autopilot: your agent runs the week, then asks once ---------------------------------------------------
// what the app knows that the gateway does not: your games already booked, and results you reported with how long
// you played (a game that runs past its booking teaches the Autopilot who you click with)
export function autopilotInput() {
  const g = readGame(), wk = new Date(), soon = new Date(wk.getTime() + 7 * 864e5);
  const upcoming = list.filter((t) => ["play", "game"].includes(t.kind) && t.booking && t.booking.state !== "cancelled").map((t) => t.booking.option)
    .filter((o) => { const d = new Date(`${o.date}T${o.start}`); return d >= new Date(wk.toDateString()) && d < soon; }).map((o) => ({ date: o.date, start: o.start, with: o.partners.map((p) => p.id) }));
  const history = (g.arena?.results || []).filter((x) => x.played).map((x) => ({ date: new Date(x.at).toISOString().slice(0, 10), start: x.start || "19:00", sport: x.sport || "badminton", format: x.vs.length > 1 ? "doubles" : "singles", with: [...x.vs, ...(x.partner ? [x.partner] : [])], booked: x.booked || 90, played: x.played }));
  return { upcoming, history, goal: g.autopilot?.goal || {} };
}
export function startAutopilot(body) {
  const id = create("autopilot", () => ({ title: `Line up ${body.goal?.perWeek || 2} games this week`, href: "autopilot" }));
  run(id, (on) => agentAutopilot(body, on), (r) => ({ result: r, state: r.agreed.length ? "needs" : "done",
    // a draft (the goal check held the plan back): the agent's plain words on why it needs a look
    summary: r.approval?.draft ? r.summary : r.agreed.length ? `${r.agreed.length} game${r.agreed.length > 1 ? "s" : ""} agreed with everyone's agent. Book ${r.agreed.length > 1 ? "them" : "it"}?` : r.summary }));
  return id;
}
// your answer: the gateway books what you approved (the other agents already said yes), and the app follows each game
export async function approveAutopilot(t, choice) {
  const r = await agentAutopilotAnswer(t.result.id, choice);
  if (r.error) { update(t.id, { state: "done", summary: r.error }); return r; }
  // a booking can still be refused (the court just taken, a partner booked into another game since their yes)
  const booked = r.bookings.filter((b) => !b.error).length, refused = r.bookings.find((b) => b.error);
  update(t.id, { state: "done", summary: r.options.length ? `${booked ? `Booked ${booked} game${booked > 1 ? "s" : ""}` : "Nothing booked"}${refused ? `; ${r.bookings.length - booked} not booked: ${refused.error}` : ""}` : "Nothing booked this week", answered: choice });
  r.bookings.forEach((b, k) => {
    const o = r.options[k];
    if (b.error) return;
    const pid = create("play", () => ({ title: `${o.format === "doubles" ? "Doubles" : "Singles"} ${o.day} ${o.start} with ${o.partners.map((p) => first(p.name)).join(", ")}, lined up by Autopilot`, href: "club?tab=challenges",
      result: { options: [o], invites: {}, message: "Agreed by your agents." } }));
    update(pid, { booking: b, chosen: o.id, state: "running", working: "Waiting for answers", summary: bookingLine(b) });
    follow(pid);
  });
  return r;
}

// ---- "want a game?": the Match helper asked, you said yes, the Talk helper agrees it with the other agents ---------
// A yes becomes a job of its own: the agents' messages stream in, and the game is booked when they agree the time you
// said yes to. When they move it, the job asks you once more (book or drop). It returns the gateway's answer, which
// carries the next opening when their agent said no.
const gameLine = (o) => `${o.format === "doubles" ? "Doubles" : "Singles"} ${o.day} ${o.start} with ${o.partners.map((p) => first(p.name)).join(", ")}`;
export function startGame(ask) {
  const id = create("game", () => ({ title: `${gameLine(ask.opening)}: you said yes`, href: "", askId: ask.id, names: Object.fromEntries(ask.opening.partners.map((p) => [p.id, first(p.name)])) }));
  return run(id, (on) => agentAskAnswer(ask.id, "yes", on), (r) => gameDone(id, r)).then(() => taskById(id));
}
function gameDone(id, r) {
  if (r.error) return { state: "failed", error: r.error };
  if (r.book) { queueMicrotask(() => follow(id)); return { result: r, booking: r.booking, chosen: r.book.id, state: "running", working: "Waiting for answers", summary: bookingLine(r.booking) }; }
  if (r.moved) return { result: r, state: "needs", summary: r.text };
  return { result: r, state: "done", summary: `No deal: ${r.failed}.` };
}
// after the agents moved it: book the new time, or drop it
export async function answerMoved(t, choice) {
  update(t.id, { state: "running", working: choice === "book" ? "Booking it" : "Telling the other agents" });
  try {
    const r = await agentAskAnswer(t.askId, choice);
    update(t.id, r.book ? gameDone(t.id, r) : { state: "done", working: null, summary: r.text || r.error || "Dropped" });
  } catch (e) { update(t.id, { state: "failed", working: null, error: `The agent could not be reached (${e.message}).` }); }
}

// ---- the best match, and your agent talking to theirs ----------------------------------------------------------
export function startBest(body) {
  const id = create("match", () => ({ title: `Find my best ${body.format === "doubles" ? "doubles partner" : "opponent"} this week`, href: "club?tab=challenges" }));
  run(id, (on) => agentBest(body, on), (r) => ({ result: r, state: "done", summary: r.top.length ? `Best match: ${r.top[0].name}, ${r.top[0].fit}% fit` : r.why }));
  return id;
}
export function startTalk(body, name) {
  const id = create("talk", () => ({ title: `Agree a ${body.format} game with ${name}`, href: "club?tab=challenges", with: body.with }));
  run(id, (on) => agentTalk(body, on), (r) => ({ result: r, state: r.agreed ? "needs" : "done",
    summary: r.agreed ? `${first(name)}'s agent agreed: ${r.agreed.day} ${r.agreed.start} at ${r.agreed.venue.name}. Book it?` : `${first(name)}'s agent declined: ${r.reason || "not this week"}` }));
  return id;
}
// book what the two agents agreed, as a play task, so its answer is followed like any other game
export function bookAgreed(t, you) {
  const o = t.result.agreed, mate = o.partners[0];
  const id = create("play", () => ({ title: `${o.format === "singles" ? "Singles" : "Doubles"} with ${mate.name}, agreed by your agents`, href: "club?tab=challenges",
    result: { options: [o], invites: { [mate.id]: t.result.log.filter((x) => x.from === "you").at(-1)?.text || "" }, message: "Your agents agreed it." } }));
  update(t.id, { state: "done", summary: `Booked: ${o.day} ${o.start} at ${o.venue.name}` });
  bookFor(id, o, you).catch((e) => update(id, { state: "failed", working: null, error: e.message }));
  return id;
}

// ---- a question for your agent: answered on Muse Glimmer from what it knows about you (your games, what is booked,
// your body log), every number checked against those facts (agent/src/answer.js) ----------------------------------
export function startAsk(text, you) {
  const id = create("ask", () => ({ title: text, href: "" }));
  run(id, async (on) => {
    on({ type: "working", step: "Your agent is answering on Muse Glimmer" });
    const r = await agentAnswer(text, you);
    // the safety checks on your question and on the answer (Llama Guard 3 on your server): what happened, never the text
    const said = (c) => { const s = sayCheck(c); return { type: "step", step: s.head, tool: "safety", detail: [s.note, `${c.model}, on your own server`].filter(Boolean).join(" · "), check: c }; };
    const checks = r.safety || [], inCheck = checks.find((c) => c.on === "message"), outCheck = checks.find((c) => c.on === "answer");
    if (inCheck) on(said(inCheck));
    if (r.refused) return r;
    on({ type: "step", step: "Looked at your week", tool: "route", detail: `${r.facts ?? 0} facts: your games, what is booked and your body log` });
    on({ type: "step", step: "Answered", tool: "answer", detail: r.timing ? `Muse Glimmer, ${r.timing.seconds} s` : "Muse Glimmer", seconds: r.timing?.seconds });
    on({ type: "step", step: "Checked every number", tool: "verify", detail: r.verified?.offline ? "the model was unavailable, so it said what it knows" : r.verified?.rejected ? "a draft failed the check, so it said what it knows" : `${r.verified?.numbers ?? 0} numbers, each one in your own data` });
    if (outCheck) on(said(outCheck));
    return r;
  // a message the guard stopped is not kept, here either: the card says what happened, without the words
  }, (r) => ({ state: "done", result: { text: r.text }, summary: r.text, ...(r.refused ? { title: "A message your agent did not act on", flagged: true } : {}) }));
  return id;
}

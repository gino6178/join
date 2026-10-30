// Agent to agent: your agent agrees a game with one or more members' agents. One engine for a one-to-one challenge and
// for a doubles four, where it talks to three agents at once (the model server runs four requests in parallel).
//   1. Code finds the times everyone is free and a venue in the middle with a free court for each (the only times any
//      agent may propose). It orders them by what it has learned about each member's agent: times they turned down
//      before go last, times they proposed go first.
//   2. Your agent proposes the best of them, listing up to twelve (the proposal is facts and a sentence made by code).
//   3. Every member's agent answers at the same time (Muse Glimmer, from what that member shares with it): accept,
//      counter with one listed time, or decline, and which listed times work (the acceptable-set protocol). Its hard
//      rules are kept by code first. A counter is checked by code against everyone's calendar and the courts.
//   4. The game goes at the best time that works for everyone, usually in round 1; when no time does, the talk ends.
//      When an agent gave no list, your agent moves to the time most counters asked for (three rounds at most).
// What each member's agent accepts and turns down is remembered (data/a2a_memory.json) and orders the next proposal.
// What the agents say to each other is made by code from the facts; the model only decides.
import path from "node:path";
import { chatJSON, pick, priorityOf } from "./llm.js";
import { decideRaw } from "./decider.js";
import { MEMBER_REPLY, DECISION, PROPOSAL, HOLD, HELD, validate } from "./schema.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { readJSON, writeJSON } from "./jsonfile.js";
import { crashPoint } from "./crash.js";
import { job, totals } from "./ledger.js";
import * as client from "./a2a_client.js";
import { span, inject, a2aCall, agentAttrs } from "./trace.js";
import { outcomeOf } from "./attribution.js";
import crypto from "node:crypto";
import { demoVenues, helpers, playing, lease, release, leasesOn, commit, hooks as playHooks } from "./play.js";
import { privateFor } from "./privacy.js";
import { limitAnswer } from "./disclosure.js";
import { annotate } from "./talk_meta.js";
import { proposed, decided as noteAnswer, released as noteReleased } from "./match/hooks.js";
import { studentOn, studentAnswer } from "./student.js";
import * as peer from "./peer.js";

const { windows, travelMin, kmBetween, ymd, hm, toMin, dateOf, DAYS } = helpers;
const FILE = path.resolve(process.env.A2A_FILE || "data/a2a_memory.json");
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const first = (n) => n.split(" ")[0];
export const when = (date, start) => { const d = dateOf(date); return `${DAYS[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]} ${start}`; };
const nums = (t) => String(t).match(/\d+(?:[.:]\d+)?/g) || [];
export const allowedIn = (...texts) => new Set(texts.flatMap((t) => nums(t)));
export const okNums = (t, allowed) => nums(t).every((n) => allowed.has(n));
export const PRONOUN = /\b(he|she|him|his|her|hers)\b/i;

let memory = readJSON(FILE, {});
// negotiations in progress and finished, saved before every round (whole file to a temporary one, then renamed)
const NEG_FILE = path.resolve(process.env.NEGOTIATIONS_FILE || "data/negotiations.json");
let negs = readJSON(NEG_FILE, {});
function saveNeg(st) {
  negs[st.id] = { ...st, at: Date.now() };
  // (the newest 400; NEGOTIATIONS_KEEP for an eval that runs thousands of talks, where writing them all is the cost)
  const keep = +(process.env.NEGOTIATIONS_KEEP || 400), ids = Object.keys(negs); if (ids.length > keep) for (const k of ids.sort((a, b) => negs[a].at - negs[b].at).slice(0, ids.length - keep)) delete negs[k];
  writeJSON(NEG_FILE, negs);
}
export const negotiation = (id) => negs[id] || null;
export const unfinished = () => Object.values(negs).filter((n) => n.status === "working");
// the talks of one free-text request (match/flow.js names them neg-<request>-<k>)
export const negotiationIds = (prefix) => Object.keys(negs).filter((k) => k.startsWith(prefix));
const saveMemory = () => writeJSON(FILE, memory);
// What is kept is coarse and fades (docs/privacy_budget.md): a weekday and an hour (A2A_MEMORY_GRAIN=part keeps only
// morning, afternoon or evening), and every count halves every A2A_MEMORY_HALFLIFE_DAYS (14; off keeps them), a count
// that fades below 0.1 going altogether (one answer is gone after about seven weeks). It orders the next proposal; it
// is not a record of anyone's week.
const PART = (h) => (h < 12 ? "morning" : h < 17 ? "afternoon" : "evening");
const slotKey = (date, start) => { const h = (typeof start === "number" ? hm(start) : String(start)).slice(0, 2); return `${DAYS[dateOf(date).getDay()]} ${process.env.A2A_MEMORY_GRAIN === "part" ? PART(+h) : `${h}:00`}`; };
const halfLife = () => { const v = process.env.A2A_MEMORY_HALFLIFE_DAYS; return v === "off" || v === "0" ? 0 : +(v || 14); };
function aged(m, now = Date.now()) {
  const h = halfLife(), t = m.agedAt ?? now;
  if (h && now > t) {
    const f = 0.5 ** ((now - t) / (h * 864e5));
    for (const kind of ["yes", "no", "asked"]) for (const [k, v] of Object.entries(m[kind] || {})) { const x = +(v * f).toFixed(3); if (x < 0.1) delete m[kind][k]; else m[kind][k] = x; }
  }
  m.agedAt = Math.max(t, now);
  return m;
}
// once per answer: `once` names it (the talk, the round, the kind), so a round resumed after a crash, whose answers come
// back from the agents' tasks, is not learned twice
function learn(id, date, start, kind, once = null, now = Date.now()) {
  const m = aged((memory[id] ||= { yes: {}, no: {}, asked: {} }), now), k = slotKey(date, start);
  if (once) { m.seen ||= []; if (m.seen.includes(once)) return; m.seen = [...m.seen, once].slice(-60); }
  m[kind][k] = +((m[kind][k] || 0) + 1).toFixed(3);
  saveMemory();
}
// the counts kept about a member's agent, faded to `now` (test/privacy_probe.mjs reads them as a curious gateway would)
export const memoryOf = (id, now = Date.now()) => (memory[id] ? aged(memory[id], now) : null);
// what your agent has learned about a member's agent, in words (shown in the trail)
export function learned(id, now = Date.now()) {
  const m = memoryOf(id, now); if (!m) return null;
  const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  return { yes: top(m.yes).concat(top(m.asked)).slice(0, 2), no: top(m.no).slice(0, 2) };
}
export const forgetMemory = () => { memory = {}; saveMemory(); };
// (the evals: two gateways' players in one process, each with its own memory; returns the one it replaces)
export const swapMemory = (m) => { const old = memory; memory = m; return old; };
// /forget: what was learned about one member's agent (match/index.js forget)
export const forgetMemoryFor = (id) => { if (memory[id]) { delete memory[id]; saveMemory(); } };

// the times everyone is free in the next week, at least `minutes` long, earliest first
export function shared(people, minutes = 90, now = new Date()) {
  const out = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(now); d.setDate(d.getDate() + i);
    let spans = [[0, 24 * 60]];
    for (const p of people) {
      const w = windows(p.free).filter((x) => x.day === d.getDay()).map((x) => [x.from, x.to]);
      spans = spans.flatMap(([a, b]) => w.map(([c, e]) => [Math.max(a, c), Math.min(b, e)])).filter(([a, b]) => b - a >= minutes);
    }
    const soonest = i === 0 ? Math.ceil((now.getHours() * 60 + now.getMinutes() + 60) / 30) * 30 : 0;
    for (const [a, b] of spans) { const f = Math.max(a, soonest); if (b - f >= minutes) out.push({ date: ymd(d), day: DAYS[d.getDay()], from: f, to: b }); }
  }
  return out;
}
// a venue's offer for one sport (the demo venues list theirs under `sports`; badminton is the default)
const forSport = (v, sport) => (v.sports ? (v.sports[sport] ? { ...v, courts: v.sports[sport].courts, price: v.sports[sport].price } : null) : sport === "badminton" ? v : null);
// for one time: the venue with a free court where the longest trip is shortest
export function court(slot, start, minutes, people, venues, sport = "badminton") {
  const date = dateOf(slot.date), out = [];
  for (const v0 of venues.venues) {
    const v = forSport(v0, sport);
    if (!v) continue;
    const courts = demoVenues.freeCourts(v, date, start, minutes);
    if (!courts.length) continue;
    const travel = people.filter((p) => p.area).map((p) => ({ id: p.id, name: p.name, min: travelMin(p.area, v), km: +kmBetween(p.area, v).toFixed(1) }));
    out.push({ v, court: courts[0], courtsFree: courts.length, travel, longest: Math.max(0, ...travel.map((t) => t.min)) });
  }
  return out.sort((a, b) => a.longest - b.longest)[0] || null;
}
// an option in the shape Play books (play.book)
export function option(slot, start, minutes, c, members, format, sport, agreed) {
  const total = Math.round((c.v.price * minutes) / 60), players = members.length + 1;
  return {
    id: `${c.v.id}-${slot.date}-${hm(start)}`, date: slot.date, day: slot.day, start: hm(start), end: hm(start + minutes), minutes, sport,
    venue: { id: c.v.id, name: c.v.name, area: c.v.area, km: c.travel.find((t) => t.id === "you")?.km ?? null, x: c.v.x, y: c.v.y }, court: c.court, courtsFree: c.courtsFree,
    travel: c.travel, longest: c.longest, format, players, price: c.v.price, total, each: Math.round(total / players),
    partners: members.map((m) => ({ id: m.id, name: m.name, level: m.level, why: ["your agents agreed the time"] })), spare: [], asked: members.map((m) => m.id), agreed: agreed ? members.map((m) => m.id) : [],
  };
}

// an answer in words, by code from the decision (both for this server's agents and for what comes back over A2A)
export const sentence = (them, j, cur) => (j.intent === "accept" ? `${them} can do ${when(cur.slot.date, hm(cur.start))}.` : j.intent === "counter" ? `${them} would rather play ${j.date && j.start ? when(j.date, j.start) : "at another time"}.` : `${them} can't play this week.`);
// the times that work, kept consistent with the decision: a yes means the proposed time works; a counter means it does
// not, and the time asked for does; a decline means none does. Only ids that were offered count.
export function consistent(works, intent, curId, askedId, ids) {
  if (intent === "decline") return [];
  const w = new Set(works.filter((x) => ids.has(x)));
  if (intent === "accept" && curId) w.add(curId);
  if (intent === "counter") { if (curId) w.delete(curId); if (askedId && ids.has(askedId)) w.add(askedId); }
  return [...w];
}

// What your agent says to the other agents is made by code from the facts (the time, the court, the trips), not
// written by the model: it costs no tokens, cannot carry a made-up detail, and never carries the player's private
// details (a health limit shapes which times your agent proposes, but is not told to anyone).
const says = {
  propose: (sport, format, cur, also) => `Proposing ${sport} ${format}: ${cur.text}.${also.length ? ` Also possible: ${also.join(", ")}.` : ""}`,
  accept: (cur) => `Agreed: ${cur.text}.`,
  move: (cur, asked) => `${asked ? "Moving the game to" : "How about"} ${cur.text}${asked ? ", the time asked for; it fits everyone's calendar and a court is free." : "? It fits everyone's calendar."}`,
  // with private calendars: the next times from your player's week, after none of the last ones worked for everyone
  next: (cur, also) => `None of those works for everyone. How about ${cur.text}?${also.length ? ` Also possible: ${also.join(", ")}.` : ""} Your player's week has them free, with a court.`,
};

// One member's agent answering a proposal: Muse Glimmer, from what the member shares; its time is checked by the
// caller. Both tiers follow one decision rule (DECIDE): yes to the proposed time if it works for the member; if it
// does not, the listed time the member likes best; not this week if none works. test/cascade_eval.mjs grades both
// tiers against that rule on simulated members whose constraints are known.
//   System 1, the quick pick: code lists the options, the model answers with an option letter after a short reasoning
//   budget, and the message is a template. Its probability for that letter is a confidence (llm.js pick).
//   System 2, the full agent: it reasons and chooses (MEMBER_REPLY), and its message is a template too.
// Either way the member's agent sees only the proposal's structured facts (rebuilt by the receiving side), never the
// other agent's free text, and says nothing but its decision.
// With A2A_QUICK=1 the quick pick answers when its confidence reaches A2A_SURE, and System 2 answers the rest. It is off
// by default: on Muse Glimmer the quick pick still reasons for about 400 tokens before its one letter (it needs a
// 600-token budget to answer three cases in four), more than System 2's whole answer, so it saves nothing here.
const quickOn = () => process.env.A2A_QUICK === "1", SURE = () => +(process.env.A2A_SURE || 0.6);
const DECIDE = (them) => `Decide by this rule: accept the proposed time if it works for ${them}; if it does not, ask for the listed time ${them} likes best; decline if none of the times works for ${them}.`;
const profile = (m) => `You are ${m.name}'s agent. ${m.name} plays ${m.prefers === "any" ? "singles or doubles" : m.prefers}, level ${m.level}. Free: ${m.free.join(", ")}.${m.limit ? ` Health limit: ${m.limit}.` : ""} ${m.agent || ""}`;
// the options System 1 chooses from: A the proposed time, B to D other times that fit everyone, Z not this week
export function options(cur, choices) {
  const alts = choices.filter((x) => x !== cur).slice(0, 3);
  return [{ id: "A", kind: "accept", x: cur }, ...alts.map((x, i) => ({ id: "BCD"[i], kind: "counter", x })), { id: "Z", kind: "decline" }];
}
export async function quickPick(m, cur, choices, log, format, sport) {
  const them = first(m.name), opts = options(cur, choices);
  const said = log.filter((x) => x.from === m.id).map((x) => `${x.intent}${x.when ? ` ${x.when.split(" at ")[0]}` : ""}`);
  const sys = `${profile(m)}
Another player's agent proposes ${sport} ${format} for ${them}.${said.length ? ` Earlier in this talk you said: ${said.join("; ")}.` : ""} ${DECIDE(them)}
${opts.map((o) => `${o.id} = ${o.kind === "accept" ? `yes to ${o.x.text}` : o.kind === "counter" ? `ask for ${o.x.text} instead` : `${them} can't play this week`}`).join("\n")}
Answer with the letter only.`;
  const q = await pick([{ role: "system", content: sys }, { role: "user", content: "Which one?" }], opts.map((o) => o.id), { site: "a2a.pick", timeoutMs: Math.max(5000, Math.floor((+(process.env.A2A_TIMEOUT_MS || 270000) - 20000) / 3)) });
  return { opts, q };
}
async function quick(m, cur, choices, log, format, sport, minutes = 90) {
  const them = first(m.name), { opts, q } = await quickPick(m, cur, choices, log, format, sport);
  const o = opts.find((x) => x.id === q.pick);
  if (!o || q.confidence == null || q.confidence < SURE()) return null;
  // which listed times work: only the one it picked is known to (a subset of the acceptable set, so still sound)
  const works = (x) => (choices.some((c) => c.id) ? { works: x?.id ? [x.id] : [] } : {});
  const tier = { tier: "quick", confidence: q.confidence };
  if (o.kind === "accept") return { intent: "accept", text: `${them} can do ${when(cur.slot.date, hm(cur.start))}.`, ...works(cur), ...tier };
  if (o.kind === "counter") return { intent: "counter", date: o.x.slot.date, start: hm(o.x.start), text: `${them} would rather play ${when(o.x.slot.date, hm(o.x.start))}.`, ...works(o.x), ...tier };
  return { intent: "decline", text: `${them} can't play this week.`, ...works(null), ...tier };
}
// A member's hard rules (a day they never play, the latest they finish, the longest trip, the longest game) are kept by
// code, not left to the model: the times that break one are taken off the list before the model decides, and a
// proposal that breaks one is never a yes. The model weighs what is left (MEMBER_RULES=model leaves it all to the model,
// for comparison: test/persona_eval.mjs).
const rulesInCode = () => process.env.MEMBER_RULES !== "model";
// the talk a member's agent is answering in (its A2A contextId), so its own hold is not counted against it
const talkScope = new AsyncLocalStorage();
export const inTalk = (ref, fn) => talkScope.run(ref, fn);
const tripOf = (x, m) => x.trip ?? x.c?.travel?.find((t) => t.id === m.id)?.min ?? null;
export function breaks(m, x, minutes = 90) {
  const r = m.rules || {}, trip = tripOf(x, m);
  // its own calendar first: with private calendars (A2A_PRIVATE), the other agent could not check it
  if (m.free && !windows(m.free).some((w) => DAYS[w.day] === x.slot.day && w.from <= x.start && x.start + minutes <= w.to)) return "not free then";
  // and the games its member is already booked into, or holding for another talk (play.js); this talk's own hold
  // does not count (a talk resumed after a crash)
  if (m.id && x.slot.date && playing(m.id, x.slot.date, talkScope.getStore() ?? null).some((g) => g.from < x.start + minutes && x.start < g.to)) return "already playing then";
  if (r.noDays?.includes(x.slot.day)) return `no games on ${x.slot.day}`;
  if (r.endBy && x.start + minutes > toMin(r.endBy)) return `it ends after ${r.endBy}`;
  // the earliest start, on weekdays or at weekends ("19:00 or later after work", "no earlier than 11:00 at weekends")
  const from = r.notBefore && (["Sat", "Sun"].includes(x.slot.day) ? r.notBefore.weekend : r.notBefore.weekday);
  if (from && x.start < toMin(from)) return `it starts before ${from}`;
  if (r.maxTrip != null && trip == null && x.unplaced) return "a trip it can't check";
  if (r.maxTrip != null && trip != null && trip > r.maxTrip) return `a ${trip}-minute trip`;
  if (r.maxMinutes && minutes > r.maxMinutes) return `${minutes} minutes, longer than ${r.maxMinutes}`;
  return null;
}
// How much to think, per question (A2A_ADAPT=1). Two drafts on a small reasoning budget (A2A_DRAFT_BUDGET, 128 tokens)
// go to two model slots at once; when both fit the format and agree (the same decision, the same counter, the same set
// of times that work), that is the answer, and only a question they disagree on gets the full budget. Agreement between
// cheap samples marks the easy questions (draft-agreement routing; skipping long thinking where a check exists).
// Measured on Muse Glimmer, it does not pay: the model reasons past 128 tokens before any answer, so the drafts came back
// empty (16 of 16) and every question went on to the full budget. Kept for comparison; routing by what the facts decide
// (A2A_ROUTE, below) is what saves the thinking.
const adaptOn = () => process.env.A2A_ADAPT === "1", DRAFT_BUDGET = () => +(process.env.A2A_DRAFT_BUDGET || 128);
// on by default; A2A_ROUTE=off asks the model every time, for comparison
const routeOn = () => process.env.A2A_ROUTE !== "off";
const agreeKey = (v) => v && JSON.stringify([v.intent, v.intent === "counter" ? `${v.date} ${v.start}` : "", [...(Array.isArray(v.works) ? v.works : [])].sort()]);
async function drafts(msgs, timeoutMs) {
  if (!adaptOn()) return null;
  const opts = { maxTokens: 120, temperature: 0.7, site: "a2a.draft", budget: DRAFT_BUDGET(), timeoutMs, tries: 1 };
  const [a, b] = await Promise.all([chatJSON(msgs, MEMBER_REPLY, opts), chatJSON(msgs, MEMBER_REPLY, opts)]);
  return a.value && b.value && agreeKey(a.value) === agreeKey(b.value) ? a.value : null;
}
// The one-pass decider (A2A_DECIDER=raw, off by default; decider.js, docs/decider.md): when the proposed time does not
// work and two or more listed times do, Muse Glimmer's next-token probabilities over the times (one letter each, Z not
// this week) pick the counter in one pass, with no reasoning. Its pick stands when its probability reaches
// A2A_DECIDER_SURE; a lower one, or Z, goes to the full answer. The times that work are the ones code kept.
// 0.85 is the conformal threshold for a 5% risk of a changed answer (0.843 on the calibration members, rounded up):
// it answers about 8% of these choices. Off, because it agrees with the full answer less than the full answer
// agrees with itself (docs/decider.md).
const deciderOn = () => process.env.A2A_DECIDER === "raw", DECIDER_SURE = () => +(process.env.A2A_DECIDER_SURE || 0.85);
// the question in the full answer's words: the member's profile, the rule, the proposed time and why it does not work
export const deciderQuestion = (m, cur, times, why, format, sport) => ({ profile: profile(m), rule: DECIDE(first(m.name)), them: first(m.name), sport, format, cur: cur.text, why, times });
async function decided(m, cur, choices, all, why, format, sport) {
  const them = first(m.name);
  let r;
  try { r = await decideRaw(deciderQuestion(m, cur, choices, why, format, sport)); } catch { return null; }
  if (!r.pick?.x || r.p < DECIDER_SURE()) return null;
  const j = { intent: "counter", date: r.pick.x.slot.date, start: hm(r.pick.x.start), ...(all.some((x) => x.id) ? { works: choices.map((x) => x.id).filter(Boolean) } : {}), tier: "decider", confidence: r.p };
  return { ...j, text: sentence(them, j, cur) };
}
export async function fullAnswer(m, cur, choices, log, format, sport, minutes = 90) {
  const them = first(m.name), all = choices;
  let curBad = null;
  if (rulesInCode()) {
    curBad = breaks(m, cur, minutes);
    choices = choices.filter((x) => !breaks(m, x, minutes));
    if (!choices.length) return { intent: "decline", text: sentence(them, { intent: "decline" }, cur), tier: "rules", why: curBad || "no listed time fits the member's calendar and rules", ...(all.some((x) => x.id) ? { works: [] } : {}) };
    // What the facts already decide is not asked (A2A_ROUTE, on by default): the listed times left keep the member's calendar and
    // rules, so they are the ones that work; by the decision rule a proposed time that works is a yes, and with one time
    // left that is the counter. Only a choice between times (which one the member likes best) goes to the model.
    // (only for a member whose hard limits are all in code, rulesComplete: a limit written only in its words, such as
    // "plays singles only on Thursdays", is the model's to keep, so its time is not decided here)
    if (routeOn() && m.rulesComplete && (!curBad || choices.length === 1)) {
      const ids = all.some((x) => x.id) ? { works: choices.map((x) => x.id).filter(Boolean) } : {}, alt = choices[0];
      const j = !curBad ? { intent: "accept", ...ids, tier: "rules" } : { intent: "counter", date: alt.slot.date, start: hm(alt.start), ...ids, tier: "rules" };
      return { ...j, text: sentence(them, j, cur) };
    }
    // a choice between times: the student first (A2A_STUDENT, on by default; student.js), then the one-pass decider
    // (A2A_DECIDER=raw), the full answer when neither is sure
    if (studentOn() && curBad && choices.length > 1) { const s = await studentAnswer(m, cur, choices, all, { minutes, format, sport, profile: profile(m) }); if (s) return { ...s, text: sentence(them, s, cur) }; }
    if (deciderOn() && curBad && choices.length > 1) { const d = await decided(m, cur, choices, all, curBad, format, sport); if (d) return d; }
  }
  const sys = `${profile(m)}
You are agreeing a ${sport} ${format} game for ${them} with another player's agent. The proposed time is ${cur.text}.${curBad ? ` It does not work for ${them} (${curBad}).` : ""} ${DECIDE(them)}
Times that fit everyone's calendar this week: ${choices.map((x) => `${x.id ? `${x.id}: ` : ""}${x.slot.date} ${hm(x.start)} = ${x.text}`).join(" | ")}.
Return JSON only: {"intent": "accept" | "counter" | "decline", "date": "YYYY-MM-DD", "start": "HH:MM"${choices.some((x) => x.id) ? `, "works": [ids]` : ""}}. For "counter", date and start must be one of the times above.${choices.some((x) => x.id) ? ` In "works", list the id of every time above that works for ${them} (by the rule's first test: it works, whether or not it is the one ${them} likes best); an empty list if none does.` : ""}`;
  // the talk so far as facts: what was proposed, and what this agent decided (no free text from either side)
  const msgs = [{ role: "system", content: sys }, ...log.map((x) => (x.from === "you" ? { role: "user", content: `Proposal: ${sport} ${format}, ${x.when}.` } : { role: "assistant", content: JSON.stringify({ intent: x.intent, ...(x.intent === "counter" && x.when ? { asked: x.when } : {}) }) }))];
  if (!log.length || log.at(-1).from !== "you") msgs.push({ role: "user", content: `Proposal: ${sport} ${format}, ${cur.text}.` });
  // the reply in MEMBER_REPLY's format, asked once more if it does not fit; an agent that never answers in it has not
  // said yes (it was once taken as a yes, which could book a member who never agreed)
  // two tries, each within half of what your agent waits for an A2A answer (and the model call's own limit)
  const perTry = Math.max(30000, Math.min(+(process.env.LLM_TIMEOUT_MS || 180000), Math.floor((+(process.env.A2A_TIMEOUT_MS || 270000) - 20000) / 2)));
  const drafted = await drafts(msgs, perTry);
  const { value } = drafted ? { value: drafted } : await chatJSON(msgs, MEMBER_REPLY, { maxTokens: 120, temperature: 0.3, site: "a2a.answer", timeoutMs: perTry });
  if (!value) return { intent: "none", text: `${them}'s agent did not answer.`, tier: "agent" };
  const j = { ...value, tier: drafted ? "draft" : "agent" };
  if (j.intent === "counter" && j.date === cur.slot.date && toMin(j.start || "00:00") === cur.start) j.intent = "accept";
  // a yes to a time that breaks a rule is not a yes, and a counter must be one of the listed times that keep them (and
  // name one): either way the member gets the first time its own list said works, or the proposed time if that keeps
  // the rules, or not this week
  const listed = (d, s) => choices.find((x) => x.slot.date === d && hm(x.start) === s);
  if ((curBad && j.intent === "accept") || (j.intent === "counter" && !listed(j.date, j.start))) {
    const own = (Array.isArray(value.works) ? value.works : []).map((w) => choices.find((x) => x.id === w)).find((x) => x && x !== cur);
    // (overruled: the model's answer broke a rule and code put it right, which the member's span says)
    if (own) Object.assign(j, { intent: "counter", date: own.slot.date, start: hm(own.start), tier: "rules", overruled: true });
    else if (!curBad) Object.assign(j, { intent: "accept", date: "", start: "", tier: "rules", overruled: true });
    else Object.assign(j, { intent: "decline", date: "", start: "", tier: "rules", overruled: true });
  }
  if (Array.isArray(value.works) && choices.some((x) => x.id)) {
    const asked = j.intent === "counter" && choices.find((x) => x.slot.date === j.date && hm(x.start) === j.start);
    j.works = consistent(value.works, j.intent, cur.id, asked?.id, new Set(choices.map((x) => x.id)));
    j.worksRaw = value.works.filter((w) => all.some((x) => x.id === w)); // what the model said, before code made it consistent
  } else delete j.works;
  j.text = sentence(them, j, cur);
  return j;
}
// a member agent's answer by the decision rule (served over A2A by a2a_server.js)
export const decide = (...a) => answer(...a);
// the answer cut to the member's disclosure budget for this asker (disclosure.js), its sentence made again if it changed
export function budgeted(m, from, cur, choices, j, now = Date.now()) {
  const k = limitAnswer(m.id, from, cur, choices, j, { now });
  if (k !== j) k.text = sentence(first(m.name), k, cur);
  return k;
}
async function answer(m, cur, choices, log, format, sport, minutes = 90) {
  // the member's rules first, as for the full agent: the quick pick chooses only among times that keep them, and a
  // proposed time that breaks one goes to the full agent
  if (quickOn() && (!rulesInCode() || !breaks(m, cur, minutes))) {
    const keep = rulesInCode() ? choices.filter((x) => x === cur || !breaks(m, x, minutes)) : choices;
    try { const q = await quick(m, cur, keep, log, format, sport, minutes); if (q) return q; } catch { /* the full agent answers */ }
  }
  return fullAnswer(m, cur, choices, log, format, sport, minutes);
}

// How your agent reaches a member's agent: over A2A (a2a_client.js) when the gateway serves the members' agents
// (A2A_BASE is set by server.js), or in this process (tests and evals run without a gateway, or A2A_TRANSPORT=local).
// A member whose agent is on a peer gateway (<id>@<peer>, peer.js) is always reached over A2A, at that gateway.
const viaA2A = (m) => peer.isRemote(m) || (process.env.A2A_TRANSPORT !== "local" && !!process.env.A2A_BASE);
// a peer gateway that does not answer now: its members are "not reachable now" at once (peer.js reachable)
const away = async (m) => peer.isRemote(m) && !(await peer.reachable(peer.remoteOf(m).origin));
// what went wrong reaching an agent, in words (a refusal by a peer gateway is not "could not be reached")
const failed = (them, m, e) => /signature/.test(String(e?.message)) ? `${them}'s agent's card does not check out.` : peer.isRemote(m) && /\b40[13]\b/.test(String(e?.message)) ? `${them}'s gateway refused this gateway's request.`
  : /not signed by peer/.test(String(e?.message)) ? `${them}'s agent's answer did not come from their gateway.`
  : peer.isRemote(m) ? `${them}'s agent is not reachable now.` : `${them}'s agent could not be reached.`;
async function ask(m, cur, choices, log, { format, sport, minutes, id, round, mine, from = "you", at = null }) {
  // (the matchmaker counts the asks each member gets; in process, the member's answer goes to its own records, as
  // a2a_server.js does over A2A; and it is cut to the member's disclosure budget, disclosure.js, as there)
  proposed(m.id, round);
  if (!viaA2A(m)) return inTalk(id, () => answer(m, cur, choices, log, format, sport, minutes)).then((j) => budgeted(m, from, cur, choices, j, at ? at.getTime() : Date.now())).then((j) => { noteAnswer(m.id, { from, date: cur.slot.date, start: hm(cur.start), intent: j.intent, works: j.works, ref: id }); return j; });
  const them = first(m.name), trip = (x) => x.c.travel.find((t) => t.id === m.id)?.min;
  if (await away(m)) return { intent: "none", unreachable: true, text: `${them}'s agent is not reachable now.`, tier: "agent", error: "its gateway does not answer" };
  // facts only, no sentences: the receiving agent writes each time out itself, from the date, the start, the venue (whose
  // name it looks up) and its member's own trip, so nothing your agent wrote reaches its model (and nobody else's trip)
  const w = (x) => ({ ...(x.id ? { id: x.id } : {}), date: x.slot.date, start: hm(x.start), venue: x.c.v.id, court: x.c.court, ...(trip(x) != null ? { trip: trip(x) } : {}) });
  const sent = [cur, ...choices.filter((x) => x !== cur)].slice(0, 12);
  const data = { kind: "serve.proposal", sport, format, minutes, proposal: w(cur), choices: sent.map(w), say: mine, from };
  // a proposal that would not fit is ours to fix, not the other agent's silence
  const bad = validate(PROPOSAL, data);
  if (bad.length) return { intent: "none", ours: true, text: `Your agent could not put the proposal for ${them} in the protocol's form (${bad[0]}).`, tier: "agent", error: bad.slice(0, 2).join("; ") };
  let task;
  try {
    // one message per member and round: sent again after a restart, it gets the task the agent already finished
    const url = peer.baseFor(m), messageId = `${id}-r${round}-${m.id}`;
    task = await a2aCall({ member: m.id, url, messageId, contextId: id, round }, () => client.send(url, { messageId, contextId: id, role: "ROLE_USER", metadata: inject({ "serve.priority": priorityOf() ? "background" : "now" }),
      parts: [{ data, mediaType: "application/json" }] }));
  } catch (e) {
    // not reachable, a protocol error, or no answer in time: no answer, which is not a yes
    const text = failed(them, m, e);
    return { intent: "none", ...(/not reachable now/.test(text) ? { unreachable: true } : {}), text, tier: "agent", error: String(e.message || e).slice(0, 200) };
  }
  const d = client.dataOf(task, "decision");
  if (!d || task.status?.state !== "TASK_STATE_COMPLETED") return { intent: "none", text: `${them}'s agent did not answer.`, tier: "agent", task: task?.id };
  // the other agent may be anyone's: its decision is used only if it fits the format, its times only if they were
  // offered and agree with its decision, and its words are made here from the decision
  const errs = validate(DECISION, d);
  if (errs.length) return { intent: "none", text: `${them}'s agent answered in a form that does not fit.`, tier: "agent", task: task.id, errors: errs.slice(0, 3) };
  const j = { ...d, task: task.id };
  if (Array.isArray(d.works)) {
    const asked = d.intent === "counter" && sent.find((x) => x.slot.date === d.date && hm(x.start) === d.start);
    j.works = consistent(d.works, d.intent, cur.id, asked?.id, new Set(sent.map((x) => x.id).filter(Boolean)));
  }
  // the times its agent did not answer about (its disclosure budget): neither a yes nor a no
  if (Array.isArray(d.withheld)) j.withheld = d.withheld.filter((w) => sent.some((x) => x.id === w));
  j.text = sentence(them, j, cur);
  return j;
}

// A member's agent answering a hold: it holds a time once the talk agreed it, lets it go when told, and says no when
// its member is already playing or holding too many times then (play.js lease). Over A2A, a2a_server.js first checks
// that the time is one this agent said works in that talk.
export function holdAnswer(m, d) {
  // (a release that says why, after this member's yes, goes in its own records: the asker's reliability, match/)
  if (d.action === "release") { release(d.ref, m.id); if (d.why) noteReleased(m.id, d.ref, d.why); return { held: false }; }
  const r = lease(m.id, d.ref, d.date, d.start, d.minutes);
  if (!r.ok) return { held: false, reason: r.error };
  if (d.action !== "book") return { held: true, until: r.until };
  // the game was booked on the asking gateway (a peer, peer.js): the hold becomes this member's game here, so this
  // gateway's own talks see them as playing then
  const c = commit(m.id, d.ref);
  return c.ok ? { held: true, booked: true, until: c.until } : { held: false, reason: c.error };
}
// A hold, its release or a booking does not wait for a model: a peer that has not answered in A2A_HOLD_TIMEOUT_MS
// (20 s) has not held it.
const HOLD_MS = () => +(process.env.A2A_HOLD_TIMEOUT_MS || 20000);
// your agent asking one member's agent to hold (or release) the agreed time, over A2A or in this process
async function holdOne(m, ref, x, minutes, action, extra = {}) {
  const data = { kind: "serve.hold", action, ref, date: x.slot ? x.slot.date : x.date, start: x.slot ? hm(x.start) : x.start, minutes, ...extra };
  if (validate(HOLD, data).length) return { held: false, reason: "not a time that can be held" };
  if (!viaA2A(m)) return holdAnswer(m, data);
  const far = peer.isRemote(m);
  // a release a peer did not hear is sent again until it does (peer.js outbox), so no hold is left behind on its side
  const later = (r) => { if (far && action === "release" && r.reason === "could not be reached") peer.outbox.add({ member: m.id, name: m.name, ref, date: data.date, start: data.start, minutes, extra }); return r; };
  if (far) peer.count(`${action}.sent`);
  if (await away(m)) return later({ held: false, reason: "could not be reached" });
  try {
    const url = peer.baseFor(m), messageId = `${ref}-${action}-${data.date}-${data.start}-${m.id}`;
    const task = await a2aCall({ member: m.id, url, messageId, contextId: ref, kind: action }, () => client.send(url, { messageId, contextId: ref, role: "ROLE_USER", metadata: inject({}), parts: [{ data, mediaType: "application/json" }] }, { signal: AbortSignal.timeout(HOLD_MS()) }));
    const d = client.dataOf(task, "hold");
    if (d) { if (far) peer.count(`${action}.${action === "release" ? (d.reason ? "refused" : "done") : d.held ? "done" : "refused"}`); return !validate(HELD, d).length ? d : { held: false, reason: "an answer to the hold that does not fit" }; }
    // an agent that does not hold times (an older or another club's agent: it finishes without a hold, or reads the
    // hold as a proposal that does not fit) is not a refusal, and the booking still checks; any other failure is one.
    // (a peer gateway's agent must hold: there the booking here can't check its calendar)
    const st = task?.status?.state, said = JSON.stringify(task?.status?.message || "");
    return !far && (st === "TASK_STATE_COMPLETED" || (st === "TASK_STATE_FAILED" && /serve\.proposal/.test(said))) ? { held: false, unsupported: true, reason: "does not hold times" } : { held: false, reason: "the hold failed" };
  } catch { return later({ held: false, reason: "could not be reached" }); }
}
// (what the outbox sends again: the release, until the peer's agent answers it; one it still can't reach stays there)
peer.outbox.handler = async (x) => !(await holdOne({ id: x.member, name: x.name }, x.ref, { date: x.date, start: x.start }, x.minutes, "release", x.extra || {})).reason;
// all or nothing, one member at a time in a fixed order (by id): two talks that want some of the same members meet at
// the first one they share, so one gets everyone and the other lets go, rather than each getting half and both
// letting go again and again (resource ordering, as for deadlocks). If one member's agent can't hold the time, the
// ones already holding it let it go.
async function holdAll(members, ref, x, minutes) {
  if (!leasesOn()) return { refused: [] };
  const got = [];
  for (const m of [...members].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    const r = await holdOne(m, ref, x, minutes, "hold");
    if (r.held || r.unsupported) { if (r.held) got.push(m); continue; }
    // (an agent that could not be reached may still have held it, its answer lost on the way: it is told to let go too)
    await Promise.all([...got, ...(r.reason === "could not be reached" ? [m] : [])].map((d) => holdOne(d, ref, x, minutes, "release")));
    return { refused: [m], reason: r.reason || "can't hold it", timed: r.reason === "already playing then" };
  }
  return { refused: [] };
}
// A booking here whose partners include members of a peer gateway (play.js book, before anything is booked): each of
// their agents turns its hold for this talk into the game on its side, one at a time in id order, all or nothing.
// One that can't (it lapsed and the member is playing then, or its gateway is down) lets the others go, and the booking
// is refused, so the game is booked on both gateways or on neither.
async function confirmRemote(o) {
  const far = (o?.partners || []).filter((p) => peer.isRemote(p)), ref = o?.hold || o?.talk, at = { date: o?.date, start: o?.start }, minutes = o?.minutes || 90;
  if (!far.length) return null;
  if (!ref) return { error: "A partner's agent is on another gateway, so this game has to be agreed in a talk first." };
  // the player's yes, as a mandate signed with this gateway's key: who, the game, the court, the members, the price
  // cap, five minutes to live (peer.js); each partner's agent there checks it, keeps it, and books only with it
  const mandate = peer.mandateFor({ ...o, hold: ref }, o.who || "you"), got = [];
  for (const p of [...far].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    const r = await holdOne(p, ref, at, minutes, "book", { mandate });
    if (r.held && r.booked) { got.push(p); continue; }
    await Promise.all([...got, ...(r.reason === "could not be reached" ? [p] : [])].map((d) => holdOne(d, ref, at, minutes, "release", { why: "dropped" })));
    return { error: `${first(p.name)}'s agent ${r.reason === "could not be reached" ? "is not reachable now" : `could not confirm the time (${r.reason || "no answer"})`}. Ask again for a fresh option.`, clash: p.id };
  }
  return null;
}
playHooks.confirm = confirmRemote;
// a game cancelled here lets its partners on peer gateways go too (their side keeps it as their game until told)
playHooks.unbook = async (o) => {
  const far = (o?.partners || []).filter((p) => peer.isRemote(p)), ref = o?.hold || o?.talk;
  if (far.length && ref) await Promise.all(far.map((p) => holdOne({ id: p.id, name: p.name }, ref, { date: o.date, start: o.start }, o.minutes || 90, "release", { why: "dropped" }))).catch(() => {});
};
// the player said no (or chose other games): each member's agent lets the time go (a booking releases it by itself)
// (why: "dropped" by default, the player let it go; "taken" when another member got the game, with a sentence made by
// code for that member's agent)
export async function releaseHolds(o, { why = "dropped", say = null } = {}) {
  if (!o?.hold || !leasesOn()) return;
  await Promise.all((o.partners || []).map((p) => holdOne({ id: p.id, name: p.name }, o.hold, { date: o.date, start: o.start }, o.minutes || 90, "release", { why, ...(say ? { say: String(say).slice(0, 300) } : {}) }))).catch(() => {});
}

// Negotiate one game with the given members' agents; say() hears every message, tell() every step. The negotiation
// has an id (the A2A contextId) and is saved before each round: what is on the table, who already asked for it, and
// everything said. resumeNegotiation(id) picks it up from the round it was in; asked again, the members' agents return
// the answers they already gave (A2A messages are answered once), so nobody answers twice and nothing is sent twice. A
// finished negotiation returns its result. One negotiation is one job in the token ledger.
export const negotiate = (args) => {
  const id = args.id || `neg-${crypto.randomUUID().slice(0, 13)}`;
  return span("invoke_agent talk", { ...agentAttrs("talk", id), "serve.a2a.context_id": id, "serve.members": (args.members || []).map((m) => m.id).join(","), "serve.format": args.format || "singles", "serve.resumed": !!args.resume },
    (s) => job("negotiation", async (jb) => { const r = await rounds({ ...args, id }); s.setAttributes({ "serve.agreed": !!r.agreed, "serve.rounds": r.rounds || 0, ...(r.agreed ? {} : { "serve.outcome": outcomeOf(r), "serve.reason": String(r.reason || "").slice(0, 160) }) }); return { ...r, tokens: totals(jb.calls) }; }));
// (over A2A the members' agents run in their own requests, outside this job: what they used is what their decisions
// report, in the result's memberTokens)
};
// a talk that is still working can be ended (cut off too long ago to pick up): nothing is booked
export function abandon(id, reason) {
  const st = negs[id];
  if (!st || st.status !== "working") return st?.result || null;
  const r = { agreed: null, reason, rounds: Math.max(0, (st.round || 1) - 1), log: st.log || [], stale: true };
  saveNeg({ ...st, status: "failed", result: r });
  return r;
}
export async function resumeNegotiation(id, hooks = {}) {
  const st = negs[id];
  if (!st) return null;
  if (st.status !== "working") return st.result;
  const club = (await import("./club.js")).readClub();
  const members = st.members.map((mid) => club.members.find((m) => m.id === mid) || peer.member(mid)).filter(Boolean);
  const venues = st.venues || helpers.readVenues();
  return negotiate({ ...st, members, venues, now: new Date(st.now), ...hooks, resume: st });
}
async function rounds({ id = `neg-${crypto.randomUUID().slice(0, 13)}`, me, members, venues, format = "singles", sport = "badminton", minutes = 90, prefer = null, exclude = [], limit = null, say = () => {}, tell = () => {}, work = () => {}, heard = null, now = new Date(), resume = null, customVenues = false, who = null, calendars = null }) {
  if (negs[id] && negs[id].status !== "working") return negs[id].result;
  // private or shared calendars: the player's own choice (privacy.js), else the server's A2A_PRIVATE; a resumed talk
  // keeps the mode it started in (calendars, saved with it)
  // (a member on a peer gateway keeps its calendar there, so a talk with one is always a private-calendar talk)
  const privateCalendars = members.some((m) => peer.isRemote(m)) || await privateFor(who, calendars === "private" ? true : calendars === "shared" ? false : null);
  // what is saved before each round, and the result at the end
  const base = { id, status: "working", me, members: members.map((m) => m.id), format, sport, minutes, prefer, exclude, limit, now: now.toISOString(), venues: customVenues ? venues : null, customVenues, who, calendars: privateCalendars ? "private" : "shared" };
  let theirs = resume?.memberTokens || null; // what the members' agents report they used, over A2A
  // what the talk asked (one yes or no per listed time and member: what your agent learns of their weeks) and the time
  // it opened with (to see who gave way), in every result
  let askedPairs = 0, opening = null;
  const done = (r) => { if (theirs) r.memberTokens = theirs; r.asked = askedPairs; if (opening) r.opening = opening; annotate(r, { id, members, privateCalendars }); saveNeg({ ...(negs[id] || base), status: r.agreed ? "agreed" : "failed", result: r }); crashPoint("talk-done"); return r; };
  const names = members.map((m) => first(m.name)), people = [me, ...members];
  // A2A_PRIVATE=1: your agent does not see the members' calendars. It lists times from your own week that have a
  // court; each member's agent checks them against its own calendar and rules in code; a round in which no listed time
  // works for everyone rules those times out (tabu) and lists the next twelve, three rounds at most. What your agent
  // learns is which listed times work for each member, not their week. (Otherwise it lists only the times that fit
  // every calendar, as the gateway knows them: test/private_eval.mjs compares the two.)
  const times = shared(privateCalendars ? [me] : people, minutes, now);
  const offer = (s, start) => {
    const c = court(s, start, minutes, people, venues, sport);
    return c && { slot: s, start, c, text: `${when(s.date, hm(start))}–${hm(start + minutes)} at ${c.v.name}, court ${c.court} (trips: ${c.travel.map((t) => `${t.id === "you" ? "you" : first(t.name)} ${t.min} min`).join(", ")})` };
  };
  // each shared window offers its start and, if it is long, a second start an hour later
  // days that already have a game (exclude) are left out
  // (with private calendars, a window is your own whole free stretch: every hour a game fits in it is a candidate)
  const starts = (s) => (privateCalendars ? Array.from({ length: Math.max(0, Math.floor((s.to - minutes - s.from) / 60) + 1) }, (_, k) => s.from + 60 * k) : [s.from, ...(s.to - s.from >= minutes + 60 ? [s.from + 60] : [])]);
  const choices = times.filter((s) => !exclude.includes(s.date)).flatMap((s) => starts(s).map((st) => offer(s, st))).filter(Boolean);
  // the time the player asked for, when it fits a shared window but is not one of its starts (they said yes to it)
  const ps = prefer && times.find((s) => !exclude.includes(s.date) && s.day === prefer.day && s.from <= toMin(prefer.start) && toMin(prefer.start) + minutes <= s.to);
  if (ps && !choices.some((x) => x.slot.date === ps.date && x.start === toMin(prefer.start))) { const x = offer(ps, toMin(prefer.start)); if (x) choices.push(x); }
  if (!choices.length) return done({ agreed: null, reason: times.length ? "no court is free when everyone is" : `${names.join(" and ")} and you have no free time in common this week`, rounds: 0, log: [] });
  // what we know about these agents goes first: their past yeses up, their past noes down
  const score = (x) => members.reduce((s, m) => { const mm = memoryOf(m.id, now.getTime()), k = slotKey(x.slot.date, x.start); return s + (mm ? 2 * ((mm.yes[k] || 0) + (mm.asked[k] || 0)) - 3 * (mm.no[k] || 0) : 0); }, 0);
  // with private calendars, the hours people usually play go first (weekday evenings, weekend mornings to early
  // afternoon): a prior about clubs, not about these members, whose weeks your agent does not see
  const usual = (x) => (!privateCalendars ? 0 : ["Sat", "Sun"].includes(x.slot.day) ? (x.start >= 9 * 60 && x.start <= 14 * 60 ? 3 : 0) : x.start >= 18 * 60 && x.start <= 20 * 60 ? 3 : 0);
  let ordered = choices.map((x, i) => ({ x, s: score(x) + usual(x) - i * 0.01 + (prefer && x.slot.day === prefer.day ? 20 - Math.abs(x.start - toMin(prefer.start)) / 30 : 0) })).sort((a, b) => b.s - a.s).map((y) => y.x);
  // a resumed talk keeps the order, and so the ids, it had: what was learned since must not renumber the times the
  // members' agents already answered about. If one of those times is gone (its court was taken meanwhile), it ends.
  // the listed times have ids (t1 your agent's favourite); the twelve best go in each proposal. A resumed talk gets back
  // the whole order it had, ids and all (in a later round the times on the table are not t1..t12, and the times ruled
  // out and the members' saved answers refer to those ids); a time new since then goes after the last id
  const key = (l) => choices.find((x) => x.slot.date === l.date && hm(x.start) === l.start);
  let listed;
  if (resume?.listed) {
    const back = resume.listed.map(key);
    if (back.some((x) => !x)) return done({ agreed: null, reason: "the times on the table changed while the talk was cut off", rounds: Math.max(0, resume.round - 1), log: resume.log || [] });
    const saved = (resume.order || resume.listed).map((l) => { const x = key(l); if (x) x.id = l.id; return x; }).filter(Boolean);
    let n = Math.max(0, ...saved.map((x) => +x.id.slice(1)));
    const rest = ordered.filter((x) => !saved.includes(x));
    rest.forEach((x) => { x.id = `t${++n}`; });
    ordered = [...saved, ...rest];
    listed = back;
  } else {
    ordered.forEach((x, i) => { x.id = `t${i + 1}`; });
    listed = ordered.slice(0, 12);
  }
  const ruled = new Set(resume?.ruled || []); // times a member's agent said do not work (private calendars)
  const same = (o) => choices.find((x) => x.slot.date === o.slot.date && x.start === o.start) || o;
  const known = members.map((m) => [m, learned(m.id, now.getTime())]).filter(([, l]) => l && (l.no.length || l.yes.length));
  if (known.length) tell({ step: "Used what it learned about their agents", tool: "memory", detail: known.map(([m, l]) => `${first(m.name)}: ${l.yes.length ? `says yes to ${l.yes.join(", ")}` : ""}${l.yes.length && l.no.length ? "; " : ""}${l.no.length ? `turned down ${l.no.join(", ")}` : ""}`).join(" · ") });
  if (privateCalendars && !resume) tell({ step: "Kept everyone's calendar private", tool: "a2a", calendars: "private", detail: "your agent proposes times from your own week; each member's agent checks them against its own calendar" });
  let cur = ordered[0], wanted = new Set(), all = [], mine = null, from = 1; // wanted: members whose own counter is the time now on the table
  opening = cur ? { date: cur.slot.date, start: hm(cur.start) } : null;
  if (resume) {
    cur = choices.find((x) => x.slot.date === resume.cur.date && hm(x.start) === resume.cur.start);
    if (!cur) return done({ agreed: null, reason: "the time on the table is no longer free", rounds: Math.max(0, resume.round - 1), log: resume.log || [] });
    wanted = new Set(resume.wanted); all = [...(resume.log || [])]; mine = resume.mine; from = resume.round;
    tell({ step: "Picked up the talk where it stopped", tool: "a2a", detail: `round ${from}, saved before the gateway restarted; answers already given come back from the agents' tasks` });
  }
  const logs = Object.fromEntries(members.map((m) => [m.id, all.filter((x) => x.from === m.id || x.from === "you")]));
  if (!resume) mine = says.propose(sport, format, cur, ordered.slice(1, 3).map((x) => when(x.slot.date, hm(x.start))));
  let searchOn = false;
  for (let round = from; round <= 3; round++) {
    // a member whose gateway does not answer now: the round is not sent at all (the other agents are not asked for
    // nothing), and the talk ends at once
    const off = (await Promise.all(members.map(away))).map((x, k) => x && members[k]).filter(Boolean);
    if (off.length) return done({ agreed: null, reason: `${off.map((m) => first(m.name)).join(" and ")}'s agent${off.length > 1 ? "s are" : " is"} not reachable now`, declined: off.map((m) => m.id), silent: off.map((m) => m.id), unreachable: off.map((m) => m.id), rounds: round - 1, log: all });
    saveNeg({ ...base, round, cur: { date: cur.slot.date, start: hm(cur.start) }, wanted: [...wanted], mine, log: [...all], listed: listed.map((x) => ({ id: x.id, date: x.slot.date, start: hm(x.start) })), order: ordered.map((x) => ({ id: x.id, date: x.slot.date, start: hm(x.start) })), ruled: [...ruled], memberTokens: theirs });
    crashPoint("round-saved");
    const m0 = { from: "you", to: members.map((m) => m.id), intent: "propose", when: cur.text, text: mine, round };
    all.push(m0); say(m0); members.forEach((m) => logs[m.id].push(m0));
    work(members.length > 1 ? `${names.join(", ")}'s agents are answering at the same time` : `${names[0]}'s agent is answering`);
    const t0 = Date.now();
    // an agent that asked for this very time is not asked again: its yes is already on record
    const offered = listed.includes(cur) ? listed : [cur, ...listed.slice(0, 11)];
    // (what a member's agent withheld, disclosure.js: the proposed time, and how many listed times it answered about)
    const hid = (j) => !!j.withheld?.includes(cur.id), told = (j) => (j.withheld ? offered.filter((x) => !j.withheld.includes(x.id)).length : offered.length);
    askedPairs += offered.length * members.filter((m) => !wanted.has(m.id)).length;
    const replies = await Promise.all(members.map((m) => (wanted.has(m.id) ? { intent: "accept", text: `${first(m.name)} asked for this time.`, auto: true } : ask(m, cur, offered, logs[m.id], { format, sport, minutes, id, round, mine, from: me.id, at: now }))));
    const secs = (Date.now() - t0) / 1000;
    for (const j of replies) if (j.usage) { theirs ||= {}; for (const [k, v] of Object.entries(j.usage)) theirs[k] = +((theirs[k] || 0) + v).toFixed(2); }
    const counters = [];
    replies.forEach((j, k) => {
      const m = members[k];
      let msg;
      if (j.intent === "counter") {
        // a counter must fit everyone's calendar and a court, and not fall on a day that already has a game
        const s = !exclude.includes(j.date) && times.find((x) => x.date === j.date && x.from <= toMin(j.start || "00:00") && toMin(j.start || "00:00") + minutes <= x.to);
        const o = s && same(offer(s, toMin(j.start)));
        msg = { from: m.id, to: "you", intent: "counter", when: o ? o.text : `${j.date} ${j.start}`, text: j.text, checked: !!o, round, tier: j.tier, confidence: j.confidence, task: j.task };
        if (o) counters.push(o);
        // (a time its agent withheld, disclosure.js, is not learned as a no: it said nothing about it)
        if (!hid(j)) learn(m.id, cur.slot.date, cur.start, "no", `${id}-r${round}-no`, now.getTime());
        if (o) learn(m.id, o.slot.date, o.start, "asked", `${id}-r${round}-asked`, now.getTime());
      } else {
        msg = { from: m.id, to: "you", intent: j.intent, when: j.intent === "accept" ? cur.text : undefined, text: told(j) === 0 ? `${first(m.name)}'s agent has told you about as many new times as it will for now.` : privateCalendars && j.intent === "decline" ? `${first(m.name)} can't play at any of these times.` : j.text, checked: j.intent === "accept" ? true : undefined, round, tier: j.tier, confidence: j.confidence, task: j.task };
        if (j.intent !== "none" && !hid(j)) learn(m.id, cur.slot.date, cur.start, j.intent === "accept" ? "yes" : "no", `${id}-r${round}-${j.intent}`, now.getTime());
      }
      if (j.withheld?.length) msg.withheld = j.withheld;
      all.push(msg); say(msg); logs[m.id].push(msg);
      // (heard: everything a member's agent told this side, as facts; test/privacy_probe.mjs is a curious gateway that keeps it)
      heard?.({ member: m.id, round, cur: { id: cur.id, date: cur.slot.date, start: hm(cur.start) }, offered: offered.map((x) => ({ id: x.id, date: x.slot.date, start: hm(x.start) })), intent: j.intent, date: j.date, start: j.start, works: j.works, withheld: j.withheld });
    });
    if (members.length > 1) tell({ step: `Round ${round}: heard from ${members.length} agents in ${secs.toFixed(0)} s`, tool: "a2a", detail: `${replies.filter((j) => j.intent === "accept").length} agreed, ${counters.length} countered, ${replies.filter((j) => j.intent === "decline").length} declined; answered in parallel` });
    // no answer is not a yes: the game is not agreed without that member, and the caller can try someone else
    const ours = replies.find((j) => j.ours);
    if (ours) return done({ agreed: null, reason: ours.text, rounds: round, log: all });
    const silent = replies.map((j, k) => j.intent === "none" && members[k]).filter(Boolean);
    // with private calendars, a reply that gave no list still says which times work: the proposed one for a yes, the
    // one asked for for a counter, none of these for a decline (so the search goes on rather than ending on a no)
    if (privateCalendars && !silent.length) {
      const ids = new Set(offered.map((x) => x.id));
      replies.forEach((j) => { if (!Array.isArray(j.works)) { const asked = j.intent === "counter" && offered.find((x) => x.slot.date === j.date && hm(x.start) === j.start); j.works = consistent([], j.intent, cur.id, asked?.id, ids); } });
    }
    // an agent that answered about none of the listed times (its disclosure budget for this asker is spent): the talk
    // ends, and nobody is taken to have said no
    const spent = replies.map((j, k) => told(j) === 0 && members[k]).filter(Boolean);
    if (!silent.length && spent.length) return done({ agreed: null, reason: `${spent.map((m) => first(m.name)).join(" and ")}'s agent has told you about as many new times as it will for now`, budget: spent.map((m) => m.id), rounds: round, log: all });
    // (a member whose gateway is down is "not reachable now": the caller can try again later, or someone else)
    const gone = silent.filter((m) => replies[members.indexOf(m)].unreachable);
    if (silent.length) return done({ agreed: null, reason: gone.length === silent.length ? `${gone.map((m) => first(m.name)).join(" and ")}'s agent${gone.length > 1 ? "s are" : " is"} not reachable now` : `${silent.map((m) => first(m.name)).join(" and ")}'s agent did not answer`,
      declined: silent.map((m) => m.id), silent: silent.map((m) => m.id), ...(gone.length ? { unreachable: gone.map((m) => m.id) } : {}), why: silent.map((m) => replies[members.indexOf(m)].text), errors: silent.map((m) => replies[members.indexOf(m)].error || null), rounds: round, log: all });
    // The acceptable-set protocol: every agent said which of the listed times work for its member, and that is binding.
    // The game goes at the time your agent likes best among those that work for everyone (a time a member asked for
    // first); a time someone ruled out is never proposed (tabu). If no time works for everyone, the talk ends now with
    // who ruled what out, rather than after rounds of proposals that cannot land.
    if (replies.every((j) => Array.isArray(j.works))) {
      const works = replies.map((j) => new Set(j.works)), common = offered.filter((x) => works.every((w) => w.has(x.id)));
      // NEGOTIATION_DETAIL=1 (the evals): each agent's set, what its model said before code made it consistent, and the
      // times offered with everyone's trip, so the sets can be graded against what is known to work
      const detail = () => (process.env.NEGOTIATION_DETAIL === "1" ? { acceptableRaw: Object.fromEntries(members.map((m, k) => [m.id, replies[k].worksRaw ?? null])),
        offered: offered.map((x) => ({ id: x.id, day: x.slot.day, start: hm(x.start), trips: Object.fromEntries(x.c.travel.map((t) => [t.id, t.min])) })) } : {});
      const acceptable = Object.fromEntries(members.map((m, k) => [m.id, [...works[k]]]));
      if (!common.length && privateCalendars && round < 3) {
        // nothing listed works for everyone: those times are ruled out, and the next twelve from your week go out
        offered.forEach((x) => { if (!works.every((w) => w.has(x.id))) ruled.add(x.id); });
        const rest = ordered.filter((x) => !ruled.has(x.id));
        if (rest.length) {
          listed = rest.slice(0, 12); cur = listed[0]; wanted = new Set();
          mine = says.next(cur, listed.slice(1, 3).map((x) => when(x.slot.date, hm(x.start))));
          tell({ step: `Round ${round}: no listed time works for everyone`, tool: "a2a", detail: `${offered.length} times ruled out; listing the next ${listed.length} from your week` });
          continue;
        }
      }
      if (!common.length) {
        const none = members.filter((m, k) => !works[k].size);
        return done({ agreed: null, reason: none.length ? `${none.map((m) => first(m.name)).join(" and ")} can't play at any of the times` : "no time works for everyone", declined: none.map((m) => m.id), rounds: round, log: all, acceptable, ...detail() });
      }
      const asked = counters.map(same).find((o) => common.includes(o));
      let pickT = common.includes(cur) ? cur : asked || common[0];
      // every member's agent holds the time (all or nothing); a time someone can't hold (another talk got them first)
      // is dropped for the next one that works for everyone
      for (const tried = new Set(); ;) {
        const h = await holdAll(members, id, pickT, minutes);
        if (!h.refused.length) break;
        tried.add(pickT);
        tell({ step: `${h.refused.map((m) => first(m.name)).join(" and ")} can't hold ${pickT.text}`, tool: "a2a", detail: `${h.reason}${h.timed ? "; trying the next time that works for everyone" : ""}` });
        // (only "already playing then" depends on the time; another reason holds for every time)
        const next = h.timed && common.find((x) => !tried.has(x));
        if (!next && h.timed && privateCalendars && round < 3) { offered.forEach((x) => ruled.add(x.id)); searchOn = true; break; }
        // (an agent whose gateway stopped answering while it held is "not reachable now", not "no longer free")
        if (!next) return done({ agreed: null, reason: h.reason === "could not be reached" ? `${h.refused.map((m) => first(m.name)).join(" and ")}'s agent${h.refused.length > 1 ? "s are" : " is"} not reachable now (the time could not be held)` : `${h.refused.map((m) => first(m.name)).join(" and ")} ${h.refused.length > 1 ? "are" : "is"} no longer free at any of the times (${h.reason})`,
          declined: h.refused.map((m) => m.id), ...(h.reason === "could not be reached" ? { unreachable: h.refused.map((m) => m.id) } : {}), rounds: round, log: all, acceptable, ...detail() });
        pickT = next;
      }
      // private calendars: every common time was held by other talks, so the search goes on from the next times
      if (searchOn) {
        searchOn = false;
        const rest = ordered.filter((x) => !ruled.has(x.id));
        if (rest.length) { listed = rest.slice(0, 12); cur = listed[0]; wanted = new Set(); mine = says.next(cur, listed.slice(1, 3).map((x) => when(x.slot.date, hm(x.start)))); continue; }
        return done({ agreed: null, reason: "every time that worked is held by other talks", rounds: round, log: all, acceptable, ...detail() });
      }
      if (pickT !== cur) {
        const m1 = { from: "you", to: members.map((m) => m.id), intent: "accept", when: pickT.text, text: says.accept(pickT), checked: true, round };
        all.push(m1); say(m1);
      }
      tell({ step: members.length > 1 ? `All ${members.length + 1} agents agreed` : "Both agents agreed", tool: "verify", detail: `${pickT.text}: one of ${common.length} listed time${common.length > 1 ? "s" : ""} that work for everyone (acceptable sets), checked against every calendar and the court's timetable` });
      return done({ agreed: { ...option(pickT.slot, pickT.start, minutes, pickT.c, members, format, sport, true), talk: id, ...(leasesOn() ? { hold: id } : {}) }, rounds: round, log: all, text: pickT.text, common: common.length, acceptable, ...detail() });
    }
    const declined = replies.map((j, k) => j.intent === "decline" && members[k]).filter(Boolean);
    if (declined.length) return done({ agreed: null, reason: `${declined.map((m) => first(m.name)).join(" and ")} declined`, declined: declined.map((m) => m.id), rounds: round, log: all });
    if (replies.every((j) => j.intent === "accept")) {
      const h = await holdAll(members, id, cur, minutes);
      if (h.refused.length) return done({ agreed: null, reason: `${h.refused.map((m) => first(m.name)).join(" and ")} can't hold ${cur.text} (${h.reason})`, declined: h.refused.map((m) => m.id), rounds: round, log: all });
      const agreed = { ...option(cur.slot, cur.start, minutes, cur.c, members, format, sport, true), talk: id, ...(leasesOn() ? { hold: id } : {}) };
      tell({ step: members.length > 1 ? `All ${members.length + 1} agents agreed` : "Both agents agreed", tool: "verify", detail: `${cur.text}; checked against everyone's calendar and the court's timetable` });
      return done({ agreed, rounds: round, log: all, text: cur.text });
    }
    // the time most counters asked for (the earliest on a tie); if no counter fits, the next time nobody turned down
    const tally = new Map();
    counters.forEach((o) => { const k = `${o.slot.date} ${o.start}`; tally.set(k, { o, n: (tally.get(k)?.n || 0) + 1 }); });
    const next = [...tally.values()].sort((a, b) => b.n - a.n || a.o.slot.date.localeCompare(b.o.slot.date) || a.o.start - b.o.start)[0]?.o
      || ordered.find((x) => x !== cur && !all.some((y) => y.intent === "propose" && y.when === x.text));
    if (!next) break;
    cur = next;
    wanted = new Set(members.filter((m, k) => replies[k].intent === "counter" && counters.some((o) => o === cur) && all.some((y) => y.from === m.id && y.round === round && y.when === cur.text)).map((m) => m.id));
    // one-to-one: their counter fits, so your agent simply agrees
    if (members.length === 1 && wanted.size === 1) {
      const h = await holdAll(members, id, cur, minutes);
      if (h.refused.length) return done({ agreed: null, reason: `${first(members[0].name)} can't hold ${cur.text} (${h.reason})`, declined: [members[0].id], rounds: round, log: all });
      const yes = says.accept(cur);
      const m1 = { from: "you", to: [members[0].id], intent: "accept", when: cur.text, text: yes, checked: true, round };
      all.push(m1); say(m1);
      const agreed = { ...option(cur.slot, cur.start, minutes, cur.c, members, format, sport, true), talk: id, ...(leasesOn() ? { hold: id } : {}) };
      tell({ step: "Both agents agreed", tool: "verify", detail: `${cur.text}; checked against both calendars and the court's timetable` });
      return done({ agreed, rounds: round, log: all, text: cur.text });
    }
    mine = says.move(cur, counters.length > 0);
  }
  return done({ agreed: null, reason: "the agents did not settle on a time in three rounds", rounds: 3, log: all });
}

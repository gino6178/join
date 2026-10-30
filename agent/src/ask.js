// "Want a game?": the Match helper asks first. Once a day it looks at the next three days for a time the player usually
// plays that is still open, checks the body log (something sore makes it doubles, a sore back makes it short, a jump
// sport is left out) and finds who plays best with the player and is free then, with a free court. Then it asks, before
// it talks to anyone: "Thursday 19:00 is open; you've played then 3 of the last 8 weeks. Kenji is free too. Want a game?"
//   Yes: the Talk helper agrees it with the other players' agents (a2a.js). If they agree the time it asked about, the
//        game is booked, since that yes was the player's; if they move it, the player is asked once more.
//   Another time: the next opening. Not this week: quiet until Monday.
// Every time, name and number in the ask comes from code; Muse Glimmer only words it, and its sentence is checked like
// every other (numbers from the facts, the time as written, first names, no he or she).
import * as guard from "./guard.js";
import path from "node:path";
import crypto from "node:crypto";
import { chat } from "./llm.js";
import { readJSON, writeJSON } from "./jsonfile.js";
import { crashPoint } from "./crash.js";
import { readClub } from "./club.js";
import { helpers, playing, release } from "./play.js";
import { habits, chemistry } from "./autopilot.js";
import { negotiate, resumeNegotiation, negotiation, negotiationIds, abandon, court, first, okNums, allowedIn, PRONOUN, releaseHolds } from "./a2a.js";
import { organize } from "./body.js";
import { span, agentAttrs } from "./trace.js";
import { bandsFor } from "./match/rank.js";
import { findGame, question, readRequest, sameDay, twoAtOnce } from "./match/flow.js";
import { noteOwn } from "./match/records.js";
import { rank as bandRank } from "./match/model.js";

const { windows, ymd, hm, toMin, dateOf, readVenues, DAYS } = helpers;
const FILE = path.resolve(process.env.ASK_FILE || "data/asks.json");
let db = readJSON(FILE, { asks: {}, snooze: {} });
const save = () => writeJSON(FILE, db);
const DAY = 24 * 36e5;
// a talk cut off by a restart is picked up only if it stopped less than RESUME_MAX_MIN minutes ago (30) and its time
// is still ahead; an older one ends, and nothing is booked
const RESUME_MAX = () => +(process.env.RESUME_MAX_MIN || 30) * 60000;
const startOf = (o) => { const d = dateOf(o.date), [h, m] = o.start.split(":").map(Number); d.setHours(h, m, 0, 0); return d.getTime(); };
export const passed = (o, now = Date.now()) => startOf(o) <= now;
const LONG = { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday" };
const freeAt = (free, day, start, minutes) => windows(free).some((w) => DAYS[w.day] === day && w.from <= start && start + minutes <= w.to);
const expect = (a, b) => 1 / (1 + 10 ** ((b - a) / 400));
const monday = (now) => { const d = new Date(now); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d; };
const names = (ps) => ps.map((p) => first(p.name)).join(ps.length > 2 ? ", " : " and ").replace(/, ([^,]+)$/, " and $1");

// the next opening: a habitual time in the next `ahead` days that is still open, the best people free then, a court
// bands: { "date start": { memberId: band } } from the members' agents (match/rank.js bandsFor): a band goes before fit
export function opening({ history = [], upcoming = [], body = null, skip = [], now = new Date(), ahead = 3, bands = null } = {}) {
  const club = readClub(), venues = readVenues(), me = { id: "you", name: "You", area: club.you.area, free: club.you.free };
  const hist = [...(club.you.history || []), ...history];
  const org = organize({ log: body?.log || [], workouts: body?.workouts || [], days: body?.days || [], games: hist, now }), bp = org.plan;
  const goal = { perWeek: 2, ...club.you.goal }, perWeek = Math.max(1, goal.perWeek + bp.perWeekDelta);
  // this week's games, played and booked: at the goal already, it does not ask
  const wk0 = ymd(monday(now)), wk1 = ymd(new Date(monday(now).getTime() + 7 * 864e5)), today = ymd(now);
  const week = [...hist.filter((h) => h.date >= wk0 && h.date <= today), ...upcoming.filter((u) => u.date >= wk0 && u.date < wk1)];
  if (week.length >= perWeek) return { none: `you already have ${week.length} game${week.length > 1 ? "s" : ""} this week, your goal is ${perWeek}` };
  const sore = org.parts.filter((p) => p.active), chem = chemistry(hist);
  const soon = now.getHours() * 60 + now.getMinutes() + 180; // at least three hours' notice, for everyone's agent
  const slots = [];
  // a new player has no habit yet (two games at one weekday and time in eight weeks): their agent asks about the free
  // times they gave instead, in their own sport (stated), and the members' bands still order who is asked
  const usual = habits(hist).filter((x) => x.share >= 0.25), stated = !usual.length;
  for (let i = 0; i < ahead; i++) {
    const d = new Date(now); d.setDate(d.getDate() + i);
    const date = ymd(d), day = DAYS[d.getDay()];
    if (upcoming.some((u) => u.date === date) || hist.some((h) => h.date === date)) continue;
    const times = stated ? windows(me.free).filter((w) => w.day === d.getDay()).flatMap((w) => Array.from({ length: Math.max(0, Math.floor((w.to - w.from - 90) / 60) + 1) }, (_, k) => ({ day, start: hm(w.from + 60 * k), count: 0, weeks: 8, share: 0, minutes: 90, sport: club.you.sports?.[0] || goal.sport, stated: true })))
      : usual.filter((x) => x.day === day);
    for (const h of times) {
      if (i === 0 && toMin(h.start) < soon) continue;
      if (skip.includes(`${date} ${h.start}`)) continue;
      slots.push({ ...h, date });
    }
  }
  const held = [];
  for (const s of slots) {
    const sport = s.sport || goal.sport || "badminton";
    if (bp.avoid.includes(sport) || bp.pause.includes(sport)) { held.push(`${sport} on ${s.day}`); continue; }
    // the format they play at that time, unless the body log says doubles
    const fmts = hist.filter((h) => DAYS[dateOf(h.date).getDay()] === s.day && h.start === s.start).map((h) => h.format || "singles");
    let format = bp.format || (!fmts.length && club.you.prefers === "doubles" ? "doubles" : fmts.filter((f) => f === "doubles").length > fmts.length / 2 ? "doubles" : "singles");
    if (bp.pause.includes(`${sport} ${format}`)) format = "doubles";
    const minutes = Math.min(bp.capMinutes || 999, s.minutes || 90, 90), st = toMin(s.start);
    if (!freeAt(me.free, s.day, st, minutes)) continue;
    const free = club.members.filter((m) => (m.sports || ["badminton"]).includes(sport) && (m.prefers === "any" || m.prefers === format || sport !== "badminton") && freeAt(m.free, s.day, st, minutes) && !skip.includes(`${s.date} ${s.start} ${m.id}`)
      // someone already booked into a game then (by another player) is not free
      && !playing(m.id, s.date).some((g) => g.from < st + minutes && st < g.to));
    const asked = bands?.[`${s.date} ${s.start}`];
    const ranked = free.map((m) => {
      const p = expect(club.you.rating || 1500, m.rating || 1500), c = chem[m.id], b = asked && m.id in asked ? asked[m.id] : undefined;
      return { m, c, b, fit: 3 * (1 - Math.abs(0.5 - p) * 2) + (c ? 2 * c.score : 0.2), score: 3 * (1 - Math.abs(0.5 - p) * 2) + (c ? 2 * c.score : 0.2) + (b !== undefined ? 10 * (bandRank(b ?? "maybe") + 1) : 0) };
    }).sort((a, b) => b.score - a.score);
    const need = format === "doubles" ? 3 : 1;
    if (ranked.length < need) continue;
    const pick = ranked.slice(0, need), people = [me, ...pick.map((x) => x.m)];
    const cv = court({ date: s.date, day: s.day }, st, minutes, people, venues, sport);
    if (!cv) continue;
    const why = pick.map(({ m, c, b }) => `${c && c.ext > 5 ? `your games with ${first(m.name)} ran ${c.ext}% past the booking` : c ? `you've played ${first(m.name)} ${c.n} time${c.n > 1 ? "s" : ""}` : `${first(m.name)} would be new for you`}${b ? `, and ${first(m.name)}'s agent says ${b}` : ""}`);
    return {
      date: s.date, day: s.day, start: s.start, end: hm(st + minutes), minutes, sport, format,
      habit: { count: s.count, weeks: s.weeks, ...(s.stated ? { stated: true } : {}) },
      partners: pick.map(({ m }) => ({ id: m.id, name: m.name })), why,
      venue: { id: cv.v.id, name: cv.v.name }, court: cv.court, trip: cv.travel.find((t) => t.id === "you")?.min ?? null,
      body: sore.length ? sore.map((p) => `your ${p.name} is ${p.latest.level}/5`).join(" and ") : null,
      held: sore.length ? [bp.format === "doubles" && "doubles", bp.capMinutes && `${minutes} minutes`].filter(Boolean).join(" and ") || null : null,
      sore: sore.map((p) => p.name), limit: bp.limit,
      // who else could play then, by fit (the matchmaker asks their agents for a band), and the bands that ordered them
      candidates: ranked.slice(0, 12).map(({ m, fit }) => ({ id: m.id, score: +fit.toFixed(2) })), likely: Object.fromEntries(pick.filter((x) => x.b).map(({ m, b }) => [m.id, b])),
    };
  }
  return { none: held.length ? `I'm holding ${held.join(" and ")} back while ${sore.map((p) => `your ${p.name}`).join(" and ")} settle${sore.length > 1 ? "" : "s"}` : slots.length ? "nobody you play with is free at your usual times with a court" : `no usual time of yours is open in the next ${ahead === 3 ? "three" : ahead} days` };
}

// the ask, in words: Muse Glimmer writes it from the facts, code checks it, and the template is the fallback
const kindOf = (o) => `${o.sport === "badminton" ? "" : o.sport + " "}${o.format}`.replace(/^./, (c) => c.toUpperCase());
export const template = (o) => `${LONG[o.day]} ${o.start} is open${o.habit.stated ? ", one of the free times you gave me" : `; you've played then ${o.habit.count} of the last ${o.habit.weeks} weeks`}. ${names(o.partners)} ${o.partners.length > 1 ? "are" : "is"} free too (${o.why[0]}). ${kindOf(o)}, ${o.minutes} minutes at ${o.venue.name}${o.body && o.held ? `, since ${o.body}` : ""}. Want a game?`;
async function word(o) {
  const facts = [`Time: ${LONG[o.day]} ${o.start}-${o.end}, ${o.minutes} minutes, ${o.sport} ${o.format}.`, o.habit.stated ? "This is one of the free times the player gave (they have no games on record yet)." : `The player has played at this time ${o.habit.count} of the last ${o.habit.weeks} weeks.`,
    `Free then: ${o.partners.map((p) => first(p.name)).join(", ")}.`, ...o.why.map((w) => `Why: ${w}.`), `Court: ${o.venue.name}, court ${o.court}${o.trip != null ? `, ${o.trip} minutes away` : ""}.`, o.body ? `Body log: ${o.body}${o.held ? `, so the game is ${o.held}` : ""}.` : ""].filter(Boolean).join("\n");
  try {
    const r = await chat([{ role: "system", content: `You are the Match helper in Serve, a sports app: you notice when the player could play and ask them first. Ask the player whether they want this game, from the facts only, in at most two short sentences and 40 words, second person, friendly and plain, like a text from a friend. Start with the day and the start time exactly as written (for example "${LONG[o.day]} ${o.start}"), say who is free by first name (never "he" or "she") with the one best reason, and end with a short question. Leave out the court number and the end time. Use only numbers from the facts. Nothing is booked yet. English only, plain text.` }, { role: "user", content: facts }], { maxTokens: 140, temperature: 0.5 });
    const t = r.text.replace(/\s+/g, " ").trim().replace(/^"|"$/g, "").replace(new RegExp(`^(${LONG[o.day]} ${o.start}) (?=[A-Z])`), "$1: ");
    const ok = t && t.endsWith("?") && t.includes(o.start) && t.includes(LONG[o.day]) && o.partners.every((p) => t.includes(first(p.name))) && okNums(t, allowedIn(facts)) && !PRONOUN.test(t) && !/\bbook(ed)?\b/i.test(t) && t.split(/\s+/).length <= 50;
    if (ok) { const g = await guard.checkOut(t, { fallback: null }); if (!g.flagged) return { text: t, by: "model" }; }
  } catch { /* the template */ }
  return { text: template(o), by: "rules" };
}

// ask `who` (a Messenger id, or "app"): the opening and its words, kept until answered
export const ask = (args = {}) => span("invoke_agent match", { ...agentAttrs("match"), "serve.ahead_days": args.ahead ?? 3 }, async (s) => { const r = await askNow(args); s.setAttributes({ "serve.asked": !!r.id }); return r; });
async function askNow({ who = "app", history = [], upcoming = [], body = null, skip = [], ahead = 3, now = new Date() } = {}) {
  if (db.snooze[who] && db.snooze[who] > ymd(now)) return { none: `you said not this week; I'll look again on ${LONG[DAYS[dateOf(db.snooze[who]).getDay()]]}`, snoozed: db.snooze[who] };
  // a question whose time the agents moved, still waiting for the player's book or drop, gives way to the new one
  for (const x of Object.values(db.asks)) if (x.who === who && x.status === "moved") { x.status = "replaced"; save(); await releaseHolds(x.agreed); }
  let o = opening({ history, upcoming, body, skip, now, ahead });
  if (o.none) return o;
  // the people free then, ordered by their agents' bands (each agent answers from its own member's records)
  const bands = await bandsFor(o, { from: who === "app" ? "you" : who }).catch(() => null);
  if (bands) { const o2 = opening({ history, upcoming, body, skip, now, ahead, bands }); if (!o2.none && o2.date === o.date && o2.start === o.start) o = o2; }
  const w = await word(o), id = `gm-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  db.asks[id] = { id, who, at: Date.now(), status: "asked", opening: o, text: w.text, by: w.by, input: { history, upcoming, body, skip, ahead } };
  // keep the last 40
  for (const k of Object.keys(db.asks).sort((a, b) => db.asks[a].at - db.asks[b].at).slice(0, -40)) delete db.asks[k];
  save();
  return { id, text: w.text, by: w.by, opening: o };
}
// "I want to play" (match/flow.js): the agents of the people likeliest to say yes are asked first, and the game they
// agree waits for the player's yes, as a question whose time the agents set (status "moved": Book it / Drop it)
// For a game today (singles), the player chooses first: one at a time, or two at once (faster, asks more people, and
// may tell someone who said yes that the game went to another). par: 1 or 2 given by the caller skips the question.
export const CHOOSE = "For today, should I ask one person at a time, or two at once? Two at once is faster, but it asks more people, and one of them may hear that the game went to someone else.";
// (leaveOut: members not to ask again, such as one who backed out of this game)
export async function request({ who = "app", text = "", upcoming = [], now = new Date(), say = () => {}, tell = () => {}, work = () => {}, par = null, leaveOut = [] } = {}) {
  const id = `gm-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  let it = null;
  try { work("Reading your request on Muse Glimmer"); it = await readRequest(text, now); } catch { it = null; }
  // (only with MATCH_TWO_AT_ONCE=1: two at once is off by default and not offered, 12.6)
  if (par == null && twoAtOnce() && it && sameDay(it.intent, now) && it.intent.format !== "doubles") {
    db.asks[id] = { id, who, at: Date.now(), status: "choose", from: "request", said: String(text).slice(0, 300), it, input: { history: [], upcoming, body: null, skip: [], ahead: 7 } }; trimSave();
    return { id, choose: true, text: CHOOSE, buttons: [{ title: "One at a time", payload: `gm:${id}:one` }, { title: "Two at once", payload: `gm:${id}:two` }] };
  }
  return settleRequest(id, { who, text, it, upcoming, now, say, tell, work, par: par || 1, leaveOut });
}
const trimSave = () => { for (const k of Object.keys(db.asks).sort((a, b) => db.asks[a].at - db.asks[b].at).slice(0, -40)) delete db.asks[k]; save(); };
// The search, durable (12.8): the request is saved before anything is asked ("searching", with its intent), each step
// of findGame is checkpointed on it, and its result goes through the outbox (sent once, again after a restart if need
// be). resumeTalking picks a search cut off by a restart up from its last checkpoint.
async function settleRequest(id, { who, text, it, upcoming, now, say, tell, work, par, resume = null, leaveOut = [] }) {
  const prev = db.asks[id] || {};
  db.asks[id] = { ...prev, id, who, at: prev.at || Date.now(), status: "searching", from: "request", par, said: String(text).slice(0, 300), it, input: { history: [], upcoming, body: null, skip: [], ahead: 7 } };
  trimSave(); crashPoint("request-saved");
  const checkpoint = (cp) => { if (db.asks[id]) { db.asks[id].cp = cp; db.asks[id].cpAt = Date.now(); save(); } };
  let r;
  try { r = await findGame({ who, text, it, par, upcoming, now, say, tell, work, reqId: id, resume: resume ?? prev.cp ?? null, checkpoint, leaveOut }); } catch (e) { r = { agreed: null, reason: `the search stopped (${String(e.message || e).slice(0, 120)})`, log: [] }; }
  const g = r.agreed;
  const extra = { log: r.log, ordered: r.ordered, talks: r.talks, par, turnedAway: r.turnedAway || [] };
  const res = g ? { id, moved: g, text: question(g), ...extra } : { id, failed: r.reason, ...extra };
  db.asks[id] = { ...db.asks[id], status: g ? "moved" : "failed", ...(g ? { agreed: g, opening: { date: g.date, day: g.day, start: g.start, partners: g.partners.map(({ id: pid, name }) => ({ id: pid, name })), sport: g.sport, format: g.format } } : { reason: r.reason }), cp: null, outbox: res, outboxAt: Date.now() };
  save(); crashPoint("request-settled");
  return res;
}
// a search cut off by a restart: picked up from its checkpoint, unless it stopped too long ago (then it ends: its talks'
// holds are let go, nothing is booked, and the player hears so)
async function resumeSearch(a, deliver) {
  const last = a.cpAt || a.at;
  if (Date.now() - last > RESUME_MAX()) {
    for (const k of negotiationIds(`neg-${a.id}-`)) { if (negotiation(k)?.status === "working") abandon(k, "cut off by a restart too long ago"); release(k); }
    a.status = "failed"; a.reason = "it was cut off by a restart too long ago to pick up"; a.cp = null; save();
    if (Date.now() - a.at < DAY) await deliver(a.who, a.id, { text: "Your request to play stopped when the server restarted, too long ago to pick up, so nothing is booked. Send it again." });
    return false;
  }
  const r = await settleRequest(a.id, { who: a.who, text: a.said, it: a.it, upcoming: a.input?.upcoming || [], now: new Date(), par: a.par || 1, resume: a.cp });
  await deliver(a.who, a.id, r);
  return true;
}
export const get = (id) => db.asks[id] || null;
export const open = (who) => Object.values(db.asks).filter((a) => a.who === who && ["asked", "moved"].includes(a.status)).sort((a, b) => b.at - a.at)[0] || null;
export function forget(who) { for (const [k, a] of Object.entries(db.asks)) if (a.who === who) delete db.asks[k]; delete db.snooze[who]; save(); }

// the player's answer. yes -> the Talk helper agrees it with the other agents; book / drop -> after the agents moved it;
// other -> the next opening; week -> quiet until Monday. say, tell and work hear the agents' messages and the steps.
export async function answer(id, choice, { say = () => {}, tell = () => {}, work = () => {}, now = new Date() } = {}) {
  const a = db.asks[id];
  if (!a) return { error: "I don't have that question any more." };
  // the player's own yes or no to their agent's suggestion, for their own records (match/records.js)
  if ((a.status === "asked" && ["yes", "other", "week"].includes(choice)) || (a.status === "moved" && ["book", "drop"].includes(choice))) noteOwn(a.who, choice === "yes" || choice === "book", "ask");
  if (choice === "week") {
    const next = new Date(monday(now).getTime() + 7 * 864e5);
    if (a.status === "moved") await releaseHolds(a.agreed);
    a.status = "declined"; db.snooze[a.who] = ymd(next); save();
    return { snoozed: ymd(next), text: `OK, not this week. I'll look again on Monday.` };
  }
  if (choice === "other") {
    if (a.status === "moved") await releaseHolds(a.agreed);
    a.status = "other"; save();
    const skip = [...(a.input.skip || []), `${a.opening.date} ${a.opening.start}`];
    const next = await ask({ who: a.who, ...a.input, skip, now });
    return { next };
  }
  // (the members' agents let the time they are holding go)
  if (choice === "drop") { if (a.status !== "moved") return { error: "That question was already answered." }; a.status = "declined"; save(); await releaseHolds(a.agreed); return { text: "OK, dropped. Nothing is booked." }; }
  if (choice === "book") {
    if (a.status !== "moved" || !a.agreed) return { error: "That question was already answered." };
    if (passed(a.agreed, now.getTime())) { a.status = "failed"; a.reason = "its time passed"; save(); await releaseHolds(a.agreed); return { error: `${a.agreed.day} ${a.agreed.start} has passed, so it can't be booked now. Send /game to look again.` }; }
    a.status = "booked"; save();
    return { book: a.agreed };
  }
  // a game today: the player chose one at a time or two at once, and the talks start
  if (["one", "two"].includes(choice)) {
    if (a.status !== "choose") return { error: "That question was already answered." };
    a.status = "searching"; save(); // (not "talking": a free-text search is not resumed after a restart)
    return settleRequest(a.id, { who: a.who, text: a.said, it: a.it, upcoming: a.input?.upcoming || [], now, say, tell, work, par: choice === "two" ? 2 : 1 });
  }
  if (choice !== "yes" || a.status !== "asked") return { error: "That question was already answered." };
  const o = a.opening, club = readClub(), venues = readVenues();
  const me = { id: "you", name: "You", area: club.you.area, free: club.you.free };
  const ms = o.partners.map((p) => club.members.find((m) => m.id === p.id)).filter(Boolean);
  // the talk has its own id (the A2A context), saved with the question before it starts, so it can be resumed
  a.status = "talking"; a.negotiation = `neg-${a.id}`; save();
  tell({ step: `You said yes: ${o.day} ${o.start}`, tool: "ask", detail: `asked by the Match helper; now the Talk helper agrees it with ${names(o.partners)}'s agent${ms.length > 1 ? "s" : ""}` });
  let r;
  try { r = await negotiate({ id: a.negotiation, me, members: ms, venues, format: o.format, sport: o.sport, minutes: o.minutes, prefer: { day: o.day, start: o.start }, exclude: (a.input.upcoming || []).map((u) => u.date), limit: o.limit, now, say, tell, work, who: a.who }); }
  catch (e) { r = { agreed: null, reason: `the talk stopped (${String(e.message || e).slice(0, 120)})`, log: [] }; } // the player hears, and nothing is booked
  return settle(a, r, ms, now);
}
// what a finished talk means for the question: booked, moved (ask once more), or failed (and the next opening)
async function settle(a, r, ms, now = new Date()) {
  const o = a.opening;
  if (!r.agreed) {
    // "No deal" is in the outbox before the next opening is worded (a model call), so a crash in between loses nothing
    a.status = "failed"; a.reason = r.reason; if (a.who !== "app") outbox(a.id, { failed: r.reason, log: r.log }); save();
    const skip = [...(a.input.skip || []), `${o.date} ${o.start}`];
    const next = await ask({ who: a.who, ...a.input, skip, now });
    return { failed: r.reason, log: r.log, next, calendars: r.calendars };
  }
  const g = r.agreed;
  if (g.date === o.date && g.start === o.start) {
    const res = { book: g, log: r.log, rounds: r.rounds };
    a.status = "booked"; a.agreed = g; a.outbox = res; a.outboxAt = Date.now(); save(); crashPoint("settled");
    return res;
  }
  a.status = "moved"; a.agreed = g; save();
  // who moved it: the agents that countered (a time with no court is moved by your agent)
  const by = [...new Set(r.log.filter((x) => x.intent === "counter").map((x) => x.from))].map((id) => ms.find((m) => m.id === id)).filter(Boolean);
  const who = by.length ? `${names(by)}'s agent${by.length > 1 ? "s" : ""} asked for` : "The agents settled on";
  return { moved: g, log: r.log, rounds: r.rounds, text: `${who} ${LONG[g.day]} ${g.start} instead (${g.venue.name}, court ${g.court}), and everyone's agent said yes to it. Book that?` };
}

// After a restart: every question whose talk was cut off is finished, from the round it was in (the members' agents
// return the answers they already gave), and its result goes to deliver(who, id, result), the same way a live answer
// would. Returns how many were picked up.
export async function resumeTalking(deliver) {
  let n = 0;
  // "I want to play" searches cut off by the restart (match/flow.js), from their checkpoints
  for (const a of Object.values(db.asks).filter((x) => x.status === "searching")) { try { if (await resumeSearch(a, deliver)) n++; } catch (e) { a.status = "failed"; a.reason = `could not resume: ${e.message}`; save(); } }
  for (const a of Object.values(db.asks).filter((x) => x.status === "talking")) {
    const club = readClub(), ms = a.opening.partners.map((p) => club.members.find((m) => m.id === p.id)).filter(Boolean);
    try {
      const st = negotiation(a.negotiation);
      // too old to pick up, or its time has passed: it ends here, nothing is booked, and the player hears so (unless it
      // is more than a day old: Messenger would not deliver it, and it would only confuse)
      const last = st?.at || a.at, late = startOf(a.opening) <= Date.now();
      if (Date.now() - last > RESUME_MAX() || late || (st?.result?.agreed && startOf(st.result.agreed) <= Date.now())) {
        const why = late ? "its time has passed" : "it was cut off by a restart too long ago to pick up";
        if (st) abandon(a.negotiation, why);
        a.status = "failed"; a.reason = why; save();
        if (Date.now() - a.at < DAY) await deliver(a.who, a.id, { text: `The talk with ${names(a.opening.partners)}'s agent${a.opening.partners.length > 1 ? "s" : ""} about ${a.opening.day} ${a.opening.start} stopped (${why}), so nothing is booked. Send /game to look again.` });
        continue;
      }
      const r = st ? await resumeNegotiation(a.negotiation) : null;
      if (!r) { a.status = "asked"; save(); continue; } // cut off before the first round: the question stands again
      await deliver(a.who, a.id, await settle(a, r, ms));
      n++;
    } catch (e) { a.status = "failed"; a.reason = `could not resume: ${e.message}`; save(); }
  }
  return n;
}
// the message for a question's result, kept until it is sent (sent again after a restart: at least once)
export function fail(id, reason) { const a = db.asks[id]; if (a) { a.status = "failed"; a.reason = reason; save(); } }
export function outbox(id, result) { const a = db.asks[id]; if (a) { a.outbox = result ?? null; a.outboxAt = result ? a.outboxAt || Date.now() : null; save(); } }
// what is still to be sent. A message more than a day old is dropped: Messenger lets a page answer within 24 hours of the
// player's last message, so it could not go out anyway (and would be stale)
export function pendingOutbox() {
  const out = [];
  for (const a of Object.values(db.asks)) {
    if (!a.outbox) continue;
    if (Date.now() - (a.outboxAt || a.at) > DAY) { a.outbox = null; a.outboxAt = null; save(); continue; }
    out.push({ who: a.who, id: a.id, result: a.outbox });
  }
  return out;
}

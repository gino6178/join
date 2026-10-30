// "I want to play", end to end, up to the player's yes (docs/agent_matchmaking_plan.md, section 3).
//   1. The words become an intent (play.js readIntent: Muse Glimmer reads them into JSON, rules when it is down).
//   2. Times from the player's own week that fit it: the next seven days, the hours they usually play first, twelve at most.
//   3. Candidates: members who play the sport, are free then (with private calendars, everyone who plays it) and have
//      no game then; members named in the message first.
//   4. Whom to ask first: their agents' bands (rank.js, likely.js), then fit (play.js partnerScore).
//   5. The talks (a2a.js negotiate, unchanged): singles one member at a time, four talks at most; doubles the top three,
//      whoever declined replaced by the next, three talks at most.
//   6. The first game agreed is the option. Nothing is booked: it waits for the player's yes (ask.js request).
import { readClub } from "../club.js";
import { helpers, readIntent, partnerScore, playing } from "../play.js";
import { negotiate, court, first, releaseHolds, negotiation, resumeNegotiation } from "../a2a.js";
import { crashPoint } from "../crash.js";
import { state as estimates } from "./likely.js";
import { store as records } from "./records.js";
import { rankMembers } from "./rank.js";
import { ledger, said } from "./ask.js";

const { windows, ymd, hm, toMin, dateOf, readVenues, DAYS } = helpers;
const LONG = { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday" };

// a message that asks for a game, in English or Chinese ("I want to play", "anyone for doubles Thursday?", "想打球")
const PLAY = [
  /\b(i|we)\s*('d| would)?\s*(want|wanna|like|love)\s+(to\s+)?(play|hit|have a (game|hit|match))\b/i,
  /\b(any(one|body)|who'?s|who is)\b.{0,30}\b(for|up for|free for|wants?)\b.{0,30}\b(game|match|singles|doubles|badminton|tennis|pickleball|table tennis|basketball|volleyball|hit)\b/i,
  /\b(up for|fancy|keen for|down for)\s+(a\s+)?(game|match|hit|singles|doubles)\b/i,
  /\b(find|get)\s+me\s+(a\s+)?(game|partner|match|hit)\b/i,
  /\b(singles|doubles)\s+(on\s+|this\s+|next\s+)?(mon|tue|wed|thu|fri|sat|sun|tonight|tomorrow|weekend)\w*\b.*\?$/i,
  /(想|要)(去)?打(球|羽球|羽毛球|網球|桌球|籃球|排球|匹克球)|約(打|球)|有人(要)?打|一起打/,
  // what the simulated users' trial showed missing (docs/simulated_users.md): "need badminton doubles tonight", "find
  // badminton doubles for Sunday", "can you find me a partner", "想找…單打", "有場嗎", "有夥伴嗎"; a calendar note ("I have
  // training Wednesday 19:00") names no game, partner or opponent being looked for, so it still files as one
  /\b(need|want|looking for|after)\s+(a\s+|an\s+|some\s+)?(badminton\s+|tennis\s+|pickleball\s+|table tennis\s+)?(singles|doubles|game|match|partner|opponent|hit)\b/i,
  /\b(find|get|set up|arrange|line up)\s+(me\s+|us\s+)?(a\s+|an\s+)?(badminton\s+|tennis\s+|pickleball\s+|table tennis\s+)?(singles|doubles|game|match|partner|opponent|hit)\b/i,
  /\bcan (you|u) (find|get|set up|line up|arrange)\b.{0,30}\b(game|match|partner|opponent|singles|doubles)\b/i,
  /(想|要|幫我)(找|約|安排|排).{0,16}(單打|雙打|打球|羽球|羽毛球|球友|對手|搭檔|夥伴|singles|doubles)|找.{0,24}(單打|雙打|singles|doubles|球友|對手|搭檔|夥伴)|有(場|夥伴|球友|對手).{0,8}(嗎|？|\?)|缺人/i,
];
export const isPlayRequest = (text) => { const t = String(text || "").trim(); return t.length > 0 && t.length <= 300 && !t.startsWith("/") && PLAY.some((rx) => rx.test(t)); };

// the player's times that fit the intent, the usual ones first, twelve at most
export function timesFor(intent, you, { now = new Date(), upcoming = [] } = {}) {
  const wins = windows(you.free || []), out = [], soon = now.getHours() * 60 + now.getMinutes() + 180, minutes = intent.minutes || 90;
  const habit = {}; for (const h of you.history || []) { const k = `${DAYS[dateOf(h.date).getDay()]} ${h.start}`; habit[k] = (habit[k] || 0) + 1; }
  const busy = new Set(upcoming.map((u) => u.date));
  for (let i = 0; i < 7; i++) {
    const d = new Date(now); d.setDate(d.getDate() + i);
    const date = ymd(d), day = DAYS[d.getDay()];
    if (busy.has(date) || (intent.days?.length && !intent.days.includes(date))) continue;
    for (const w of wins.filter((x) => x.day === d.getDay())) {
      const lo = Math.max(w.from, intent.from ? toMin(intent.from) : 0, i === 0 ? Math.ceil(soon / 30) * 30 : 0), hi = Math.min(w.to, intent.to ? toMin(intent.to) : 24 * 60);
      for (let st = Math.ceil(lo / 60) * 60; st + minutes <= hi; st += 60) {
        const we = d.getDay() === 0 || d.getDay() === 6, usual = we ? st >= 9 * 60 && st <= 14 * 60 : st >= 18 * 60 && st <= 20 * 60;
        out.push({ date, day, start: hm(st), min: st, score: 3 * (habit[`${day} ${hm(st)}`] || 0) + (usual ? 2 : 0) - i * 0.1 - (st % 60) / 600 });
      }
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 12);
}

// the words as an intent (Muse Glimmer, rules when it is down); `sameDay`: a request for today, where two at a time
// may be offered
export async function readRequest(text, now = new Date(), club = readClub()) {
  return readIntent(String(text).slice(0, 300), club.members, now);
}
export const sameDay = (intent, now = new Date()) => intent?.days?.length === 1 && intent.days[0] === ymd(now);
// what your agent tells a member's agent whose yes it does not take, two at a time (made by code; no booking follows)
export const turnedAway = (name, o) => `Thanks, ${first(name)}: another player took this game, so nothing is booked and ${o.day} ${o.start} is free again.`;

// par: 2 talks at once (two at a time, the player's choice for today's games), else 1
// two at once: built and measured (12.6), off by default and offered nowhere; MATCH_TWO_AT_ONCE=1 turns it back on
export const twoAtOnce = () => process.env.MATCH_TWO_AT_ONCE === "1";
// Durable (12.8): with a request id (ask.js), each step is checkpointed through `checkpoint`. A request cut off by a
// restart is called again with `resume` (the last checkpoint): the agents' estimates are not asked again, and each
// talk has the id neg-<request>-<k>, so a talk that finished gives its result back, and one cut off is picked up from
// its own round (a2a.js resumeNegotiation; the members' agents answer a message they saw before from their saved
// answer, so nothing is decided or held twice).
export async function findGame({ who = "app", text = "", it = null, par = 1, now = new Date(), upcoming = [], say = () => {}, tell = () => {}, work = () => {}, maxTalks = 4, reqId = null, resume = null, checkpoint = () => {}, leaveOut = [] } = {}) {
  if (!twoAtOnce()) par = 1;
  const t0 = Date.now(), club = readClub(), venues = readVenues(), me = { id: "you", name: "You", area: club.you?.area, free: club.you?.free };
  if (!it) { work("Reading your request on Muse Glimmer"); it = await readRequest(text, now, club); }
  const intent = it.intent, sport = intent.sport || "badminton", minutes = intent.minutes || 90;
  const format = intent.format !== "any" ? intent.format : intent.with.length >= 3 ? "doubles" : "singles", need = format === "doubles" ? 3 : 1;
  const cp = resume?.ordered ? resume : null;
  const talkOnce = async (ms, k, prefer, exclude) => {
    const id = reqId ? `neg-${reqId}-${k}` : undefined, st = id ? negotiation(id) : null;
    if (st && st.status !== "working") return st.result;
    if (st) return (await resumeNegotiation(id, { say, tell, work })) || { agreed: null, reason: "the talk could not be picked up", log: [] };
    return negotiate({ id, me, members: ms, venues, format, sport, minutes, prefer, exclude, now, say, tell, work });
  };
  if (cp) {
    tell({ step: "Picked up your request where it stopped", tool: "a2a", detail: `after a restart: ${cp.talks.length} talk${cp.talks.length === 1 ? "" : "s"} done before it; the agents' estimates kept, not asked again` });
    return talkThrough({ cp, club, intent, format, need, par, maxTalks, talkOnce, checkpoint, say, tell, work, t0, it });
  }
  tell({ step: "Read your request", tool: "read_request", detail: `${it.by === "model" ? "Muse Glimmer" : "simple rules"}: ${sport} ${format}${intent.days.length ? `, ${intent.days.map((d) => DAYS[dateOf(d).getDay()]).join(", ")}` : ", this week"}${intent.from ? `, ${intent.from}–${intent.to}` : ""}${intent.with.length ? `, with ${intent.with.map((id) => first(club.members.find((m) => m.id === id)?.name || id)).join(", ")}` : ""}`, intent });
  const times = timesFor(intent, club.you || {}, { now, upcoming });
  if (!times.length) return { intent, agreed: null, reason: "no time in your week fits that", log: [], ordered: [], seconds: (Date.now() - t0) / 1000 };
  const priv = process.env.A2A_PRIVATE === "1";
  const freeAt = (m, x) => windows(m.free).some((w) => w.day === dateOf(x.date).getDay() && w.from <= x.min && x.min + minutes <= w.to) && !playing(m.id, x.date).some((g) => g.from < x.min + minutes && x.min < g.to);
  // (a time counts only with a free court for the two of them: a talk with no court ends without a game, whatever the
  // member would say; with private calendars your agent can't know who is free, so only the courts are checked later)
  const withCourt = (m, x) => !!court({ date: x.date, day: x.day }, x.min, minutes, [me, m], venues, sport);
  const cands = club.members.filter((m) => !leaveOut.includes(m.id) && (m.sports || ["badminton"]).includes(sport) && (sport !== "badminton" || m.prefers === "any" || m.prefers === format || intent.with.includes(m.id)))
    .map((m) => ({ m, at: priv ? times[0] : times.find((x) => freeAt(m, x) && (need > 1 || withCourt(m, x))) })).filter((c) => c.at);
  if (cands.length < need) return { intent, agreed: null, reason: `nobody who plays ${sport} ${format} is free at your times this week`, log: [], ordered: [], seconds: (Date.now() - t0) / 1000 };
  const you = { level: club.you?.level || "B" };
  const prior = new Map(cands.map(({ m, at }) => { const c = court({ date: at.date, day: at.day }, at.min, minutes, [me, m], venues, sport); return [m.id, partnerScore(m, { intent, you, format, venue: c?.v || venues.venues[0] }).s]; }));
  tell({ step: "Found people who are free", tool: "find_players", detail: `${cands.length} member${cands.length > 1 ? "s" : ""} who play ${sport} ${format} ${priv ? "(their agents check their own weeks)" : "are free at one of your times"}` });
  work(`Asking up to 12 agents how likely a yes is`);
  const ordered = await rankMembers(cands.map((c) => c.m), { prior: (m) => prior.get(m.id), times: times.map(({ date, start }) => ({ date, start })), sport, format, minutes, from: who === "app" ? "you" : who, now: now.getTime(), seed: `${who}|${text}|${ymd(now)}` });
  const probed = ordered.filter((c) => c.probed), tally = {};
  probed.forEach((c) => { const k = c.band || "no estimate"; tally[k] = (tally[k] || 0) + 1; });
  tell({ step: "Asked their agents how likely a yes is", tool: "likely", detail: `${probed.length} agents answered on their own side: ${Object.entries(tally).map(([k, n]) => `${n} ${k}`).join(", ")}. Only a band comes back, never their records.`,
    likely: probed.slice(0, 8).map((c) => ({ id: c.m.id, name: first(c.m.name), band: c.band })) });
  const prefer = { day: times[0].day, start: times[0].start }, exclude = [...new Set([...upcoming.map((u) => u.date), ...(intent.days.length ? Array.from({ length: 7 }, (_, i) => { const d = new Date(now); d.setDate(d.getDate() + i); return ymd(d); }).filter((d) => !intent.days.includes(d)) : [])])];
  // the first checkpoint: the order the agents' estimates gave, before any talk
  const start = { ordered: ordered.map((c) => ({ id: c.m.id, prior: c.prior, band: c.band, p: c.p ?? null, probed: c.probed })), prefer, exclude, times: times.length, k: 0, talks: [], log: [], away: [] };
  // (the estimates' audit and cache, and the members' records, are on disk before the checkpoint that says they happened)
  estimates().flush(); records().flush();
  checkpoint(start); crashPoint("request-ranked");
  return talkThrough({ cp: start, club, intent, format, need, par, maxTalks, talkOnce, checkpoint, say, tell, work, t0, it });
}
// the talks, from a checkpoint: one at a time (or two at once), or the doubles group; each step checkpointed
async function talkThrough({ cp, club, intent, format, need, par, maxTalks, talkOnce, checkpoint, say, tell, work, t0, it }) {
  const ordered = cp.ordered.map((o) => { const m = club.members.find((x) => x.id === o.id); return m && { m, prior: o.prior, band: o.band, ...(o.p != null ? { p: o.p } : {}), probed: o.probed }; }).filter(Boolean);
  const { prefer, exclude } = cp, talks = [...cp.talks], log = [...cp.log], away = [...cp.away], led = ledger();
  const save = (k, extra = {}) => checkpoint({ ...cp, k, talks, log, away, ...extra });
  const done = (agreed, reason) => ({ intent, agreed, reason, log, talks, par, turnedAway: away, ordered: ordered.slice(0, 8).map((c) => ({ id: c.m.id, name: c.m.name, band: c.band, ...(c.p != null ? { p: c.p } : {}), probed: c.probed })), times: cp.times, seconds: +((Date.now() - t0) / 1000).toFixed(1), by: it.by });
  const annotate = (o, group) => { o.partners = o.partners.map((p) => { const c = group.find((x) => x.m.id === p.id); return { ...p, likely: c?.band || null, ...(c?.p != null ? { chance: c.p } : {}), why: [...(c?.band ? [said(first(p.name), c.band)] : []), ...p.why] }; }); return o; };
  if (need === 1) {
    // one at a time, or (par 2) two talks at once: when both agree, the first in the order gets the game, and the other
    // member's agent hears a polite sentence and its hold is freed; nothing is booked for it
    const pool = ordered.slice(0, maxTalks * par);
    for (let k = cp.k || 0; k < pool.length; k += par) {
      const group = pool.slice(k, k + par);
      work(group.length > 1 ? `Talking to ${group.map((c) => first(c.m.name)).join(" and ")}'s agents at the same time` : `Talking to ${first(group[0].m.name)}'s agent`);
      const rs = await Promise.all(group.map((c, i) => talkOnce([c.m], k + i, prefer, exclude)));
      group.forEach((c, i) => { talks.push({ with: [c.m.id], agreed: !!rs[i].agreed, reason: rs[i].reason || null, rounds: rs[i].rounds || 0 }); log.push(...(rs[i].log || [])); if (!rs[i].agreed) led.outcome(c.m.id, c.band, false); });
      const yes = group.map((c, i) => [c, rs[i]]).filter(([, r]) => r.agreed);
      if (!yes.length) { save(k + par); continue; }
      for (const [c, r] of yes.slice(1)) {
        const text = turnedAway(c.m.name, r.agreed), m1 = { from: "you", to: [c.m.id], intent: "release", when: r.agreed.text, text, round: r.rounds || 1 };
        await releaseHolds(r.agreed, { why: "taken", say: text });
        log.push(m1); say(m1); away.push(c.m.id);
      }
      if (away.length) tell({ step: `${yes.length} agents said yes at once`, tool: "a2a", detail: `${first(yes[0][0].m.name)} gets the game; ${away.map((id) => first(club.members.find((m) => m.id === id)?.name || id)).join(" and ")}'s agent heard it went to another player, and nothing is booked for them` });
      return done(annotate(yes[0][1].agreed, [yes[0][0]]), null);
    }
    return done(null, `${talks.length} talk${talks.length > 1 ? "s" : ""} didn't land (${talks.map((x) => x.reason).filter(Boolean).slice(-1)[0] || "no time worked"})`);
  }
  const byId = (ids) => ids.map((id) => ordered.find((c) => c.m.id === id)).filter(Boolean);
  let group = cp.group ? byId(cp.group) : ordered.slice(0, 3), queue = cp.queue ? byId(cp.queue) : ordered.slice(3);
  for (let k = cp.k || 0; k < 3 && group.length === 3; k++) {
    work(`Talking to ${group.map((c) => first(c.m.name)).join(", ")}'s agents at the same time`);
    const r = await talkOnce(group.map((c) => c.m), `d${k}`, prefer, exclude);
    talks.push({ with: group.map((c) => c.m.id), agreed: !!r.agreed, reason: r.reason || null, rounds: r.rounds || 0 }); log.push(...(r.log || []));
    if (r.agreed) return done(annotate(r.agreed, group), null);
    // whoever declined is replaced (or the least likely, when nobody in particular did)
    const out = (r.declined?.length ? group.filter((c) => r.declined.includes(c.m.id)) : [group.at(-1)]);
    out.forEach((c) => led.outcome(c.m.id, c.band, false));
    group = [...group.filter((c) => !out.includes(c)), ...queue.splice(0, out.length)];
    save(k + 1, { group: group.map((c) => c.m.id), queue: queue.map((c) => c.m.id) });
  }
  return done(null, `${talks.length} talk${talks.length > 1 ? "s" : ""} didn't land (${talks.map((x) => x.reason).filter(Boolean).slice(-1)[0] || "no time worked for everyone"})`);
}
// the question for the player, in words made by code: who agreed, when, where, and their agents' bands
export function question(o) {
  const names = o.partners.map((p) => first(p.name)), who = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
  const bands = o.partners.filter((p) => p.likely).map((p) => `${first(p.name)}'s agent said ${p.likely} before the talk`);
  return `${who}'s agent${names.length > 1 ? "s" : ""} said yes to ${o.sport && o.sport !== "badminton" ? `${o.sport} ` : ""}${o.format} on ${LONG[o.day]} ${o.start} at ${o.venue.name}, court ${o.court}.${bands.length ? ` (${bands.join("; ")}.)` : ""} Nothing is booked yet. Book it?`;
}

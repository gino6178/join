// Autopilot: your agent keeps you playing, without being asked.
//   It learns your habits from your games (the days and times you keep coming back to, and how long you play) and who
//   you play best with: a game that runs past its booking says the two of you click, and those partners come first.
//   Against a weekly goal ("play twice a week"), Muse Glimmer runs the week as a tool-using agent: it checks what is
//   booked, picks habitual times that are still open, finds the best partners for each, negotiates with their agents
//   (all three at once for doubles), re-plans when someone declines or a time does not fit, and asks you once, in the
//   app or in Messenger, before anything is booked (or nudges you when nothing works).
//   It also reads your body log and your health app (body.js): while something is sore it plays doubles and skips jump
//   sports, it keeps games short when your back hurts, and in a week over 1.5 times your usual load it plans one game
//   fewer. For basketball, soccer or volleyball, or when the courts are full, it looks for a free public court or a
//   park nearby (places.js: OpenStreetMap, Google Maps reviews, the forecast), judged playable at that hour.
//   Every tool result is computed by code; the model only decides what to do next and says why. It cannot book: the
//   only way to a booking is your yes. A run has a step budget, and if the model stalls, the same plan is finished by
//   rules (and the trail says so).
import fs from "node:fs";
import path from "node:path";
import { chatTools, stats } from "./llm.js";
import { job, totals, current, calls as ledgerCalls } from "./ledger.js";
import { span, traceId } from "./trace.js";
import { readClub } from "./club.js";
import { helpers } from "./play.js";
import { negotiate, negotiation, resumeNegotiation, first, court, learned, okNums, allowedIn, PRONOUN, releaseHolds } from "./a2a.js";
import * as journal from "./autopilot_journal.js";
import { crashPoint } from "./crash.js";
import { agentAttrs, toolAttrs, errorType } from "./trace.js";
import { organize } from "./body.js";
import * as places from "./places.js";
import * as memory from "./memory.js";
import { readJSON, writeJSON } from "./jsonfile.js";
import * as flags from "./loop/flags.js";
import { extras, checkedSummary } from "./autopilot_why.js";
import { rankRows } from "./match/rank.js";
import { noteOwn } from "./match/records.js";
import * as align from "./align.js";

const { windows, travelMin, ymd, hm, toMin, dateOf, readVenues, DAYS } = helpers;
const FILE = path.resolve(process.env.AUTOPILOT_FILE || "data/autopilot.json");
let db = readJSON(FILE, { runs: [], pending: {} });
const save = () => { writeJSON(FILE, db); };
const expect = (a, b) => 1 / (1 + 10 ** ((b - a) / 400));
// lean (the default; AUTOPILOT_LEAN=0 for the earlier loop, to compare): the system prompt is the same in every run, so
// the server reuses it and the tool definitions from cache, and the week's details go in the first message; get_week
// and check_body, which every run starts with, are run by code before the model's first turn; and once a game is agreed,
// the partner and court searches that led to it shrink to one line each
const LEAN = process.env.AUTOPILOT_LEAN !== "0";
const SYS = `You are the player's Serve agent, on Autopilot. You get the player the games in their goal this week, at the times they usually play, with the partners they play best with. The goal, today's date and any limit from the body log are in the first message.
Work only through the tools, one step at a time:
1. get_week and check_body first (both in one turn), unless their results are already there.
2. For each game still needed: take an open habitual time (most played first), find_partners for it, then negotiate with the best candidates (singles: 1 member id; doubles: 3 member ids). With a limit from the body log: doubles first, and follow check_body's limits. For a sport often played outdoors (basketball, soccer, volleyball): call find_places for that time and pass the best place id (verdict good) to negotiate, unless a club court is clearly better. For other sports, if negotiate fails because no court is free, try find_places for that time.
3. If a negotiation fails, try the next candidate or the next habitual time. When the habitual times run out, use get_week's otherFreeTimes. Never repeat a failed negotiation, and never put two games on one day.
4. When games are agreed, request_approval once. If nothing could be agreed, nudge the player instead.
5. Then finish with one sentence for the player.
Use only member ids and times that tools returned. Give a one-sentence "reason" for every choice. Never write he or she; use first names. Follow what the player told you before (get_week's fromMemory, or recall): leave out a person, time or place they asked you to avoid (a person: pass their id in find_partners' leaveOut).`;
const LONG_DAY = { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday" };

// ---- what it learns ---------------------------------------------------------------------------------------------
// habits: the weekday and start time you keep playing at, over the eight weeks before your latest game
export function habits(history = []) {
  if (!history.length) return [];
  const last = history.map((h) => h.date).sort().at(-1), since = dateOf(last); since.setDate(since.getDate() - 55);
  const recent = history.filter((h) => dateOf(h.date) >= since), weeks = 8, g = {};
  for (const h of recent) {
    const day = DAYS[dateOf(h.date).getDay()], k = `${day} ${h.start}`;
    (g[k] ||= { day, start: h.start, count: 0, played: [], sports: {} }).count++;
    g[k].played.push(h.played || h.booked || 90); g[k].sports[h.sport || "badminton"] = (g[k].sports[h.sport || "badminton"] || 0) + 1;
  }
  return Object.values(g).map((x) => ({ ...x, weeks, share: +(x.count / weeks).toFixed(2), minutes: Math.round(x.played.reduce((a, b) => a + b, 0) / x.played.length), sport: Object.entries(x.sports).sort((a, b) => b[1] - a[1])[0][0] }))
    .sort((a, b) => b.count - a.count).map(({ played, sports, ...x }) => x);
}
// chemistry: with whom your games run past the booking (the two of you kept playing), and how often you play
export function chemistry(history = []) {
  const per = {};
  for (const h of history) for (const id of h.with || []) {
    const x = (per[id] ||= { n: 0, ext: [] }); x.n++;
    if (h.booked && h.played) x.ext.push(h.played / h.booked - 1);
  }
  return Object.fromEntries(Object.entries(per).map(([id, x]) => {
    const ext = x.ext.length ? x.ext.reduce((a, b) => a + b, 0) / x.ext.length : 0;
    return [id, { n: x.n, ext: Math.round(ext * 100), score: +(Math.min(1, x.n / 4) * 0.5 + Math.max(0, ext) * 3).toFixed(2) }];
  }));
}

// the dates of the next seven days, with their weekday
const nextDays = (now) => Array.from({ length: 7 }, (_, i) => { const d = new Date(now); d.setDate(d.getDate() + i); return { date: ymd(d), day: DAYS[d.getDay()] }; });
const freeAt = (free, day, start, minutes) => windows(free).some((w) => DAYS[w.day] === day && w.from <= start && start + minutes <= w.to);

// ---- the tools Muse Glimmer can call ------------------------------------------------------------------------------
const TOOLS = [
  { name: "get_week", description: "This week so far: the goal, games already booked, how many are still needed, your habitual play times and the partners you play best with.", parameters: { type: "object", properties: {} } },
  { name: "check_body", description: "What the player's body log and health app say: anything sore, this week's training load against their usual week, and the limits that follow (format, game length, sports to skip, one game fewer).", parameters: { type: "object", properties: {} } },
  { name: "find_places", description: "Free public courts and parks near the player for the goal sport at one time, each judged playable or not from the map, Google Maps reviews and the forecast. Use for basketball, soccer or volleyball, or when club courts are full or far. Pass a place id to negotiate.", parameters: { type: "object", properties: { day: { type: "string" }, start: { type: "string", description: "HH:MM" }, reason: { type: "string" } }, required: ["day", "start", "reason"] } },
  { name: "find_partners", description: "Rank the club members who are free at one of your times this week, for singles (one opponent) or doubles (three players).", parameters: { type: "object", properties: { day: { type: "string", description: "Mon..Sun" }, start: { type: "string", description: "HH:MM" }, format: { type: "string", enum: ["singles", "doubles"] }, leaveOut: { type: "array", items: { type: "string" }, description: "ids of members the player asked you to leave out (fromMemory, recall); they stay out for the rest of the run" }, reason: { type: "string", description: "one sentence: why this time" } }, required: ["day", "start", "format", "reason"] } },
  { name: "negotiate", description: "Your agent agrees the game with these members' agents (in parallel). Returns the agreed time, court and trips, or why it failed.", parameters: { type: "object", properties: { members: { type: "array", items: { type: "string" }, description: "member ids: 1 for singles, 3 for doubles" }, day: { type: "string" }, start: { type: "string" }, format: { type: "string", enum: ["singles", "doubles"] }, place: { type: "string", description: "optional: a place id from find_places, for a public court instead of a club venue" }, reason: { type: "string", description: "one sentence: why these people" } }, required: ["members", "day", "start", "format", "reason"] } },
  { name: "recall", description: "Search what the player told you before, and what happened in past talks, by meaning (the closest notes, with the day each was said). Use it when choosing people, times or places, if get_week's fromMemory does not cover the question.", parameters: { type: "object", properties: { question: { type: "string", description: "what you want to know, in a sentence" }, reason: { type: "string", description: "one sentence: why you ask" } }, required: ["question", "reason"] } },
  { name: "request_approval", description: "Ask the player once to approve the games the agents agreed. Nothing is booked without this.", parameters: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] } },
  { name: "nudge", description: "Send the player a short reminder when nothing could be agreed.", parameters: { type: "object", properties: { text: { type: "string" }, reason: { type: "string" } }, required: ["text", "reason"] } },
  { name: "finish", description: "End the run with a one-sentence summary for the player.", parameters: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] } },
].map((f) => ({ type: "function", function: f }));

// one run is one job in the token ledger, and one trace: an "invoke_agent autopilot" span with every model call, tool
// call and negotiation under it. Its report carries what your agent's model calls cost (tokens: this job, your side of
// every talk included), and what the whole run cost (traceTokens: every call in the trace, the members' agents'
// answers over A2A too, since they continue the same trace). The run's id is its conversation id (gen_ai.conversation.id):
// a run resumed after a restart is a new trace with the same id.
// Durable (AUTOPILOT_DURABLE, on; =0 for the run that is simply run again, to compare): every step goes in the run's
// journal (autopilot_journal.js) before the run goes on, and resumeRuns() finishes a run a restart cut off.
const durable = () => process.env.AUTOPILOT_DURABLE !== "0";
const newId = () => `ap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
export const run = (args = {}, { resume = null } = {}) => {
  const id = resume?.id || newId();
  return span("invoke_agent autopilot", { ...agentAttrs("autopilot", id), "serve.goal.per_week": args.goal?.perWeek ?? 2, "serve.resumed": !!resume }, (s) => job("autopilot", async (j) => {
    const r = await runWeek({ ...args, runId: id, resume }), tid = traceId(); r.report.tokens = totals(j.calls); r.report.trace = tid;
    if (tid) r.report.traceTokens = totals(ledgerCalls(3000).filter((c) => c.trace === tid));
    s.setAttributes({ "serve.agreed": r.agreed.length, "serve.needed": r.report.needed, "serve.tool_calls": r.report.toolCalls, "serve.rules_took_over": !!r.report.rules, "serve.summary_replaced": !!r.report.summaryReplaced, "serve.steps_left": r.report.stepsLeft, "gen_ai.usage.input_tokens": r.report.tokens.prompt, "gen_ai.usage.output_tokens": r.report.tokens.output });
    return r;
  }));
};
// what a run's start record keeps of its arguments: everything but the callbacks (and dates as text)
const startOf = ({ notify, notifyNone, onStep, now, ...rest }, steps) => ({ ...JSON.parse(JSON.stringify(rest)), now: (now || new Date()).toISOString(), steps });
async function runWeek({ you = {}, history = [], goal = {}, ratings = {}, upcoming = [], body = null, messenger = null, notify = null, notifyNone = null, onStep, now = new Date(), player = null, notes = null, runId = null, resume = null } = {}) {
  stats.peak = stats.inflight; // this run's peak of model calls at the same time
  const t0 = Date.now(), s0 = { ...stats };
  const tell = (s) => onStep?.({ type: "step", ...s }), work = (step) => onStep?.({ type: "working", step });
  const club = readClub(), venues = readVenues(), id = runId || newId();
  const me = { id: "you", name: "You", area: club.you.area, free: club.you.free };
  // the journal: a resumed run reads what its first life wrote; a new one starts it
  const J = durable() ? journal.open(id, resume?.entries || null) : null;
  const stepBudget = J?.start?.steps ?? flags.get("autopilot.steps", player || messenger);
  // an earlier plan of this player's still waiting for an answer is replaced by this run: its holds go (done once, when
  // the run first started)
  if (!J?.start) for (const p of Object.values(db.pending)) if ((p.status === "pending" || p.status === "draft") && p.options && (p.messenger || null) === (messenger || null)) { p.status = "replaced"; save(); p.options.forEach((o) => { releaseHolds(o); }); }
  if (J && !J.start) { J.rec("start", { args: startOf({ you, history, goal, ratings, upcoming, body, messenger, player, notes, now }, stepBudget) }); crashPoint("autopilot-started"); }
  else if (J) J.rec("resumed", {});
  const g = { perWeek: 2, sport: "badminton", approval: "ask", maxTrip: 30, ...club.you.goal, ...goal };
  const hist = [...(club.you.history || []), ...history].map((h) => ({ ...h }));
  // the body log and the health app: a watch's minutes for a booked game replace the booking; soreness and load set limits
  const org = organize({ log: body?.log || [], workouts: body?.workouts || [], days: body?.days || [], games: hist, now });
  for (const l of org.linked) { const h = hist.find((x) => x.date === l.date && (x.start || null) === (l.start || null)); if (h) h.played = l.minutes; }
  const bp = org.plan, limit = you.limit || bp.limit, minutes = bp.capMinutes || 90, perWeek = Math.max(1, g.perWeek + bp.perWeekDelta);
  const geo = venues.map?.geo, found = {}, heard = {}; // heard: the bands the members' agents gave in this run
  const habit = habits(hist).filter((h) => h.share >= 0.25), chem = chemistry(hist);
  const days = nextDays(now);
  const r = (mid) => ratings[mid] ?? (mid === "you" ? club.you.rating : club.members.find((m) => m.id === mid)?.rating ?? 1500);
  // games already on your book this week (the app sends its own; Messenger players' come from their calendar)
  const booked = upcoming.filter((b) => days.some((d) => d.date === b.date));
  const agreed = [], tried = [], trail = [], leftOut = new Set();
  const decisions = [];
  let calls = 0, ruleTook = false, finished = null, approval = null, aligned = null;

  // what the player told their agent before, the notes closest to this week's plan (memory.js: DRAMA, or BM25), found
  // once by code and handed to the model with the week; the model can ask for more with recall
  const findNotes = (q) => (notes ? memory.recallIn(notes, q) : memory.recall(player || messenger || "app", q)).catch(() => ({ by: null, notes: [] }));
  const weekQuestion = `Planning ${perWeek} ${g.sport} games this week: who to play with (${Object.keys(chem).map((id) => club.members.find((m) => m.id === id)?.name).filter(Boolean).join(", ") || "club members"}) and when (${habit.map((h) => `${h.day} ${h.start}`).join(", ") || "the usual times"}), and where.`;
  const fromMemory = J?.once.memory ? J.once.memory.notes : memory.memoryOn() ? (await findNotes(weekQuestion)).notes : [];
  if (J && !J.once.memory) J.rec("memory", { notes: fromMemory });
  // the rules in what the player told their agent (memory.js rules, from live notes: a member left out, a weekday
  // off), kept by code as leaveOut is, so they can only take options away; a replaced or expired note has none
  const kept = notes ? [] : memory.rules(player || messenger || "app", now.getTime());
  const offDays = new Set(kept.filter((x) => x.kind === "avoid_day").map((x) => x.day));
  for (const x of kept) if (x.kind === "avoid_person" && club.members.some((m) => m.id === x.who)) leftOut.add(x.who);
  const ruleText = (x) => `${x.kind === "avoid_person" ? `${first(club.members.find((m) => m.id === x.who)?.name || x.who)} left out` : `no games on ${x.day}`}${x.until ? ` until ${x.until}` : ""}`;
  if (kept.length) tell({ step: "Followed what you told your agent", tool: "memory", detail: kept.map((x) => `${ruleText(x)} (you said on ${x.said})`).join(" · ") });
  const tools = {
    async recall({ question = "" } = {}) {
      if (!memory.memoryOn()) return { notes: [], note: "memory is off" };
      const r = await findNotes(String(question).slice(0, 300));
      return { notes: r.notes.map(({ note, on }) => ({ note, said: on })), ...(r.notes.length ? {} : { note: "nothing close to that in what the player said" }) };
    },
    check_body() {
      const sore = org.parts.filter((p) => p.active);
      return { sore: sore.map((p) => `${p.name} ${p.latest.level}/5, ${p.trend === "new" ? "first logged" : p.trend}${p.physio ? ", worth seeing a physio" : ""}`), allClear: !sore.length,
        load: org.load.acwr != null ? { thisWeek: org.load.acute, usualWeek: org.load.chronic, ratio: org.load.acwr } : "no load data yet",
        limits: { format: bp.format || "any", gameMinutes: minutes, skipSports: [...new Set([...bp.avoid, ...bp.pause])], gamesThisWeek: perWeek !== g.perWeek ? `${perWeek} instead of ${g.perWeek}` : g.perWeek },
        agentActions: org.actions.filter((a) => a.kind !== "follow").map((a) => a.text), fromHealthApp: org.linked.length ? org.linked.map((l) => `${l.date} game ran ${l.minutes} min (booked ${l.booked || "?"})`) : undefined };
    },
    async find_places({ day, start = "19:00" }) {
      const d = days.find((x) => x.day === day);
      if (!d) return { error: `${day} is not in the next seven days` };
      if (!geo) return { error: "the club map has no real-world location (venues.json map.geo)" };
      const here = places.toGeo(geo, club.you.area);
      const res = await places.search({ ...here, sport: g.sport, date: d.date, start, limit: 4, radius: flags.get("places.radius", player || messenger), onStep: (e) => e.type === "working" && work(e.step) });
      const ok = res.places.filter((p) => p.verdict !== "no").slice(0, 3);
      ok.forEach((p) => { found[p.id] = p; places.note(p); });
      const club0 = venues.venues.map((v) => v.sports?.[g.sport]).filter(Boolean).sort((a, b) => a.price - b.price)[0];
      decisions.push({ kind: "places", at: `${day} ${start}`, options: ok.map((p) => ({ id: p.id, name: p.name, verdict: p.verdict, why: p.reasons.map((x) => x.text) })) });
      // the model reads the verdict, and reasons made by code from the map, the forecast and the rating: never the court
      // judge's sentences (they come from reviews anyone can write), and a place's name only as a short plain label
      const label = (n) => String(n || "").replace(/[^\p{L}\p{N} '&.,()-]/gu, "").slice(0, 48);
      return ok.length ? { day, start, places: ok.map((p) => ({ id: p.id, name: label(p.name), metersAway: p.dist, verdict: p.verdict, why: places.rules(p, g.sport, start, res.weather).reasons.slice(0, 2).map((x) => x.text), outdoor: p.outdoor, cost: "free, first come" })), clubCourt: club0 ? `cheapest club court NT$${club0.price} an hour` : `no club venue has ${g.sport}`, reviewsRead: res.reviews }
        : { error: `No public place nearby looks playable for ${g.sport} ${day} ${start}` };
    },
    get_week() {
      const need = Math.max(0, perWeek - booked.length - agreed.length);
      const open = habit.map((h) => { const d = days.find((x) => x.day === h.day); return d && { ...h, date: d.date, taken: booked.some((b) => b.date === d.date) || agreed.some((a) => a.date === d.date) || offDays.has(h.day) }; }).filter(Boolean);
      const best = Object.entries(chem).sort((a, b) => b[1].score - a[1].score).slice(0, 3).map(([mid, c]) => { const m = club.members.find((x) => x.id === mid); return m && { id: mid, name: m.name, games: c.n, ranLonger: `${c.ext}%` }; }).filter(Boolean);
      // when the usual times run out, the player's other free times this week, on days with no game yet
      const left = open.filter((h) => !h.taken).length, soon = now.getHours() * 60 + now.getMinutes() + 60;
      const other = need > left ? days.filter((d) => !offDays.has(d.day) && !open.some((h) => h.date === d.date) && !booked.some((b) => b.date === d.date) && !agreed.some((a) => a.date === d.date))
        .flatMap((d) => windows(me.free).filter((w) => DAYS[w.day] === d.day && w.to - w.from >= minutes).map((w) => ({ day: d.day, date: d.date, start: hm(Math.max(w.from, d.date === ymd(now) ? Math.ceil(soon / 30) * 30 : w.from)), to: w.to })))
        .filter((x) => toMin(x.start) + minutes <= x.to).slice(0, 4).map(({ to, ...x }) => x) : [];
      return { today: `${DAYS[now.getDay()]} ${ymd(now)}`, goal: `${perWeek} ${g.sport} games this week${perWeek !== g.perWeek ? ` (one fewer than usual: your load is ${org.load.acwr} times your usual week)` : ""}`, gameMinutes: minutes, booked: booked.map((b) => `${DAYS[dateOf(b.date).getDay()]} ${b.start}`), agreed: agreed.map((a) => `${a.day} ${a.start}`), stillNeeded: need,
        habitualTimes: open.map((h) => ({ day: h.day, start: h.start, date: h.date, played: `${h.count} of the last ${h.weeks} weeks`, usualMinutes: h.minutes, alreadyTaken: h.taken })),
        ...(other.length ? { otherFreeTimes: other, otherNote: "your usual times are not enough this week: these are other times you are free" } : {}),
        playsBestWith: best, healthLimit: limit || null, ...(kept.length ? { playerRules: kept.map(ruleText), playerRulesNote: "kept by code: these people and days are already left out" } : {}), ...(fromMemory.length ? { fromMemory: fromMemory.map(({ note, on }) => ({ note, said: on })) } : {}), note: limit ? "with a health limit, doubles first; call check_body" : body?.log?.length || body?.workouts?.length ? "call check_body before choosing" : undefined };
    },
    find_partners({ day, start, format = "singles", leaveOut = [] }, quiet = false) {
      // someone the player asked to leave out stays out of this run: these candidates, the stop check's, the rules'
      for (const id of Array.isArray(leaveOut) ? leaveOut : []) if (club.members.some((m) => m.id === id)) leftOut.add(id);
      const d = days.find((x) => x.day === day);
      if (!d) return { error: `${day} is not in the next seven days` };
      if (offDays.has(day)) return { error: `No games on ${day}: the player asked for that` };
      const st = toMin(start || "19:00");
      if (!freeAt(me.free, day, st, minutes)) return { error: `You are not usually free ${day} ${start}; pick one of your habitual times` };
      if (bp.pause.includes(`${g.sport} ${format}`) || bp.pause.includes(g.sport)) return { error: `${g.sport} ${format} is paused while ${org.parts.find((p) => p.physio)?.name || "a sore part"} settles; try doubles` };
      const free = club.members.filter((m) => !leftOut.has(m.id) && (m.sports || ["badminton"]).includes(g.sport) && (m.prefers === "any" || m.prefers === format || g.sport !== "badminton") && freeAt(m.free, day, st, minutes) && !tried.some((t) => t.id === m.id && t.date === d.date));
      const rows = free.map((m) => {
        const p = expect(r("you"), r(m.id)), fair = 1 - Math.abs(0.5 - p) * 2, c = chem[m.id];
        const cv = court({ date: d.date, day }, st, minutes, [me, m], venues, g.sport);
        const why = [`win chance ${Math.round(p * 100)}%`, c && c.ext > 5 ? `your games ran ${c.ext}% over the booking (${c.n} games)` : c ? `played together ${c.n} times` : "a new partner for you", cv ? `trip ${cv.travel.find((x) => x.id === m.id)?.min} min for ${first(m.name)}` : null].filter(Boolean);
        const score = 3 * fair + (c ? 2 * c.score : 0.2) - (cv ? 0.03 * cv.longest : 1);
        return { id: m.id, name: m.name, rating: r(m.id), fit: score, why };
      }).sort((a, b) => b.fit - a.fit);
      const pick = (rs) => {
        for (const x of rs) if (x.likely) heard[x.id] = x.likely;
        const top = rs.slice(0, format === "doubles" ? 5 : 3).map((x) => ({ ...x, fit: +x.fit.toFixed(2) }));
        if (!quiet) decisions.push({ kind: "partners", at: `${day} ${start}`, format, options: top });
        return top.length ? { day, start, date: d.date, format, candidates: top, ...(bp.format === "doubles" && format === "singles" ? { note: "the body log says doubles first" } : {}) } : { error: `Nobody who plays ${format} is free ${day} ${start}` };
      };
      // the members' agents' bands go before fit (match/rank.js); the stop check (quiet) keeps the fit order
      // a partner whose recent game with you ran well past the booking (you two kept playing) and who isn't in a game yet
      // this week goes first, whatever the bands say: code keeps that habit, not the model
      const keen = (rs) => {
        const lead = rs.filter((x) => (chem[x.id]?.ext || 0) >= 15 && !agreed.some((a) => (a.partners || []).some((p) => p.id === x.id)));
        return lead.length ? [...lead.map((x) => ({ ...x, why: [...x.why, "your last games together ran long: first this week"] })), ...rs.filter((x) => !lead.includes(x))] : rs;
      };
      if (quiet || !rows.length) return pick(keen(rows));
      return rankRows(rows, { members: club.members, date: d.date, start, format, sport: g.sport, minutes, from: player || messenger || "you" }).catch(() => rows).then((rs) => pick(keen(rs)));
    },
    async negotiate({ members = [], day, start, format = "singles", place = null }) {
      const d = days.find((x) => x.day === day), ms = members.map((mid) => club.members.find((m) => m.id === mid)).filter(Boolean);
      if (!d) return { error: `${day} is not in the next seven days` };
      if (offDays.has(day)) return { error: `No games on ${day}: the player asked for that` };
      if (ms.length !== (format === "doubles" ? 3 : 1)) return { error: `${format} needs ${format === "doubles" ? "three members" : "one member"}; got ${ms.length}` };
      if (place && !found[place]) return { error: `${place} is not a place find_places returned` };
      const out = ms.filter((m) => leftOut.has(m.id));
      if (out.length) return { error: `${out.map((m) => first(m.name)).join(" and ")} ${out.length > 1 ? "are" : "is"} left out this week, as the player asked` };
      const busy = ms.filter((m) => !freeAt(m.free, day, toMin(start), minutes));
      if (busy.length) return { error: `${busy.map((m) => first(m.name)).join(" and ")} ${busy.length > 1 ? "are" : "is"} not free ${day} ${start}` };
      const game = agreed.length + tried.length;
      // a public court from find_places: one court, free, first come, its place on the club map from its real position
      const pv = place && found[place], at = pv && places.toTown(geo, pv);
      const where = pv ? { ...venues, venues: [{ id: place.replace(/[^\w]+/g, "-"), name: pv.name, area: pv.inPark || "public", x: at.x, y: at.y, courts: 1, price: 0, open: ["06:00", "22:00"], peakBusy: /crowd/i.test(pv.reasons.map((x) => x.text).join(" ")) ? 0.6 : 0.35, offBusy: 0.2, sports: { [g.sport]: { courts: 1, price: 0 } } }] } : venues;
      // the talk's id was put in the journal before it started (talkId): a talk a restart cut off is picked up from its
      // last round, with the same messages and the same holds; one that finished gives back its result
      const hooks = { say: (x) => onStep?.({ type: "a2a", game, ...x }), tell, work };
      const res = talkId && negotiation(talkId)?.status === "working" ? await resumeNegotiation(talkId, hooks)
        : await negotiate({ ...(talkId ? { id: talkId } : {}), me, members: ms, venues: where, customVenues: !!pv, format, sport: g.sport, minutes, prefer: { day, start }, exclude: [...booked.map((x) => x.date), ...agreed.map((x) => x.date)], limit, now, ...hooks, who: player || messenger || "app" });
      // only an agent that said no is passed over for that day, the others are still candidates; a talk that failed with
      // nobody saying no (no court free when everyone is, no time in common) passes them all over for that day
      (res.declined?.length ? ms.filter((m) => res.declined.includes(m.id)) : ms).forEach((m) => tried.push({ id: m.id, date: d.date }));
      if (!res.agreed) return { agreed: false, reason: res.reason, rounds: res.rounds, declined: res.declined || [] };
      const o = res.agreed;
      if (o.longest > g.maxTrip) { releaseHolds(o); return { agreed: false, reason: `the only court is ${o.longest} min away, over your ${g.maxTrip}-minute limit` }; }
      if (pv) Object.assign(o.venue, { public: true, url: pv.url || null, verdict: pv.verdict, lat: pv.lat, lon: pv.lon, outdoor: pv.outdoor });
      o.partners = o.partners.map((p) => ({ ...p, likely: heard[p.id] || null })); // (the invite's answer settles the band in the ledger)
      agreed.push(o);
      decisions.push({ kind: "agreed", at: `${o.day} ${o.start}`, with: ms.map((m) => m.name), venue: o.venue.name, rounds: res.rounds });
      return { agreed: true, when: `${o.day} ${o.date} ${o.start}-${o.end}`, venue: pv ? `${String(o.venue.name || "").replace(/[^\p{L}\p{N} '&.,()-]/gu, "").slice(0, 48)} (public, free)` : o.venue.name, court: o.court, trips: o.travel.map((t) => `${t.id === "you" ? "you" : first(t.name)} ${t.min} min`), each: `NT$${o.each}`, rounds: res.rounds };
    },
    async request_approval(args = {}) {
      if (!agreed.length) return { error: "nothing agreed yet to approve" };
      if (approval?.draft) return { sent: false, draft: true, note: "the plan is already a draft for the player to look over; finish" };
      // the goal check (align.js): the player's request against what was done for it. Not aligned, or the check did
      // not run: the plan is not sent for approval; the player is told it needs their look and sees it as a draft
      aligned = await alignCheck(args);
      if (!aligned.off && !aligned.aligned) {
        approval = { id, games: agreed.map((o) => o.id), status: "draft", draft: true, why: aligned.checked ? "the plan does not match the request" : "the goal check did not run", at: Date.now() };
        db.pending[id] = { options: agreed, status: "draft", draft: true, messenger, at: Date.now() };
        save();
        return { sent: false, draft: true, note: "kept as a draft for the player to look over; do not ask again, finish" };
      }
      approval = { id, games: agreed.map((o) => o.id), status: "pending", at: Date.now() };
      db.pending[id] = { options: agreed, status: "pending", messenger, at: Date.now() };
      save();
      return { sent: true, where: messenger ? "the app and Messenger" : "the app", games: agreed.length };
    },
    // the nudge the player receives is written by code from the week (the model only decides to send it), so nothing a
    // tool result carried can reach the player through it
    nudge() {
      const need = Math.max(0, perWeek - booked.length - agreed.length), tries = trail.filter((t) => t.name === "negotiate" && !t.res?.agreed).length;
      const text = `I couldn't line up ${need === 1 ? "the last game" : `${need} games`} at your usual times this week${tries ? ` (${tries} talk${tries > 1 ? "s" : ""} didn't land)` : ""}. Want me to try other days?`;
      db.pending[`${id}-nudge`] = { nudge: text, at: Date.now() }; save(); return { sent: true, text };
    },
    finish({ summary }) { finished = String(summary || "").slice(0, 400); return { ok: true }; },
  };
  // The run's stop is checked before it is taken: asking for approval, nudging or finishing while a game is still
  // needed is refused (twice a run at most) if an open time still has players free who have not been asked for that
  // day. The model is told which times, and goes on. (Without it, a three-game week once stopped at two after two
  // failed talks, with Tuesday evening untried.)
  let pushedBack = 0;
  const stillOpen = () => {
    const w = tools.get_week(), out = [];
    if (!w.stillNeeded) return out;
    for (const t of [...w.habitualTimes.filter((h) => !h.alreadyTaken), ...(w.otherFreeTimes || [])]) {
      for (const fmt of bp.format ? [bp.format] : ["singles", "doubles"]) {
        const p = tools.find_partners({ day: t.day, start: t.start, format: fmt }, true), n = fmt === "doubles" ? 3 : 1;
        if ((p.candidates?.length || 0) >= n) { out.push({ day: t.day, start: t.start, format: fmt, who: p.candidates.slice(0, n).map((c) => first(c.name)) }); break; }
      }
    }
    return out;
  };
  const notYet = () => {
    if (pushedBack >= 2) return null;
    const open = stillOpen();
    if (!open.length) return null;
    pushedBack++;
    const need = tools.get_week().stillNeeded;
    return { error: `not yet: ${need} game${need > 1 ? "s are" : " is"} still needed, and ${open.slice(0, 3).map((o) => `${o.day} ${o.start} (${o.format}, ${o.who.join(", ")} free)`).join("; ")} ${open.length > 1 ? "have" : "has"} not been tried. Call find_partners and negotiate for one of them first.`, stillNeeded: need };
  };
  // the request the Autopilot works for, in the player's words, and the plan it is about to send (for the goal check)
  const request = `Get me ${perWeek} ${g.sport} game${perWeek > 1 ? "s" : ""} this week, at the times I usually play, with the partners I play best with${limit ? `, keeping to the limit from my body log (${limit})` : ""}. Ask me before anything is booked.`;
  const planLine = (o) => `${o.sport || g.sport} ${o.format} ${LONG_DAY[o.day]} ${o.date} ${o.start}-${o.end} at ${o.venue.name}${o.venue.public ? " (public court)" : ""} with ${o.partners.map((p) => p.name).join(", ")}; longest trip ${o.longest} min`;
  const alignCheck = async (args) => {
    const r = await align.check({ site: "align.autopilot", goal: request,
      actions: [...align.actionsOf(trail.filter((t) => t.name !== "finish"), (t) => detailOf(t.name, t.res || {})), { action: "request_approval", input: { games: agreed.map(planLine) }, thought: args?.reason || "ask the player to approve the agreed games" }] });
    if (!r.off) tell({ step: "Checked the plan against your request", tool: "align", detail: r.aligned ? `it matches what you asked for (${r.seconds} s)` : r.checked ? "it does not match what you asked for: kept as a draft" : "the check did not run: kept as a draft", by: "code", error: !r.aligned });
    return r;
  };
  const label = {
    get_week: () => "Checked your week", check_body: () => "Checked your body log", recall: (a) => `Recalled what you said${a.question ? `: ${String(a.question).slice(0, 60)}` : ""}`, find_places: (a) => `Looked for public courts ${a.day} ${a.start}`, find_partners: (a) => `Looked for ${a.format} partners ${a.day} ${a.start}`,
    negotiate: (a) => `Negotiated with ${(a.members || []).map((x) => first(club.members.find((m) => m.id === x)?.name || x)).join(", ")}'s agent${(a.members || []).length > 1 ? "s" : ""}`,
    request_approval: () => "Asked you to approve", nudge: () => "Sent you a nudge", finish: () => "Finished",
  };
  const detailOf = (name, res) => res.error ? `refused: ${res.error}` : name === "get_week" ? `${res.stillNeeded} game${res.stillNeeded === 1 ? "" : "s"} still needed; usual times ${res.habitualTimes.filter((h) => !h.alreadyTaken).map((h) => `${h.day} ${h.start} (${h.played})`).join(", ") || "none open"}`
    : name === "check_body" ? (res.allClear ? "nothing sore" : `sore: ${res.sore.join(", ")}`) + (typeof res.load === "object" ? ` · load ${res.load.ratio} times your usual week` : "") + ` · ${res.limits.format === "any" ? "any format" : res.limits.format + " first"}, ${res.limits.gameMinutes}-minute games${res.limits.skipSports.length ? `, no ${res.limits.skipSports.join(", ")}` : ""}`
    : name === "find_places" ? res.places.map((p) => `${p.name} (${p.metersAway} m): ${p.verdict}`).join(" · ")
    : name === "find_partners" ? res.candidates.map((c) => `${first(c.name)}: ${c.why.slice(0, 2).join(", ")}`).join(" · ")
    : name === "negotiate" ? (res.agreed ? `agreed ${res.when} at ${res.venue}, court ${res.court}, in ${res.rounds} round${res.rounds > 1 ? "s" : ""}` : `no deal: ${res.reason}`)
    : name === "recall" ? (res.notes?.length ? `${res.notes.length} note${res.notes.length > 1 ? "s" : ""}: ${res.notes.map((n) => n.note).join(" | ").slice(0, 160)}` : res.note || "nothing found")
    : name === "request_approval" ? res.draft ? "kept as a draft for you to look over" : `${res.games} game${res.games > 1 ? "s" : ""}, waiting for your yes in ${res.where}` : name === "nudge" ? "sent" : "";
  // a reason given after a game was agreed must not name a time that is not one of the agreed games'
  const staleTime = (t) => [...String(t || "").matchAll(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*\s+(\d{1,2}:\d\d)/g)].some((m) => !agreed.some((o) => o.day === m[1] && o.start === m[2].padStart(5, "0")));
  // what a tool call changed in the run, so a resumed run can take it from the journal instead of running the tool
  // again: the run's state only grows (games agreed, members tried, decisions, places found, bands heard, people left
  // out), so a call's change is what was added, and the few values it set
  const mark = () => ({ agreed: agreed.length, tried: tried.length, decisions: decisions.length, leftOut: leftOut.size, found: new Set(Object.keys(found)), heard: { ...heard } });
  const changes = (m) => ({ agreed: agreed.slice(m.agreed), tried: tried.slice(m.tried), decisions: decisions.slice(m.decisions), leftOut: [...leftOut].slice(m.leftOut),
    found: Object.fromEntries(Object.entries(found).filter(([k]) => !m.found.has(k))), heard: Object.fromEntries(Object.entries(heard).filter(([k, v]) => m.heard[k] !== v)), approval, aligned, pushedBack, finished });
  const apply = (fx) => {
    agreed.push(...fx.agreed); tried.push(...fx.tried); decisions.push(...fx.decisions); fx.leftOut.forEach((x) => leftOut.add(x));
    Object.assign(found, fx.found); Object.assign(heard, fx.heard); approval = fx.approval; aligned = fx.aligned ?? null; pushedBack = fx.pushedBack; finished = fx.finished;
  };
  // tool calls in the order the run makes them: the same order when it is run again, given the same turns and results
  let seq = 0, talkId = null, replayed = 0;
  const DESC = Object.fromEntries(TOOLS.map((t) => [t.function.name, t.function.description]));
  const call = (name, args, by, errors = null, callId = null) => span(`execute_tool ${name}`, { ...toolAttrs(name, DESC[name], id, callId), "serve.decided_by": by }, async (s) => {
    const res = await callTool(name, args, by, errors);
    // a tool call that did not do what was asked is an error of the operation (error.type), with its refusal
    if (res?.error) { const t = errorType(name, res); s.setAttributes({ "error.type": t, "serve.refused": String(res.error).slice(0, 160), "serve.failure": t }); s.setStatus({ code: 2, message: String(res.error).slice(0, 160) }); }
    if (name === "negotiate" && !res?.error) s.setAttributes({ "serve.agreed": !!res.agreed, ...(res.agreed && agreed.length ? { "serve.when": `${agreed.at(-1).day} ${agreed.at(-1).start}` } : { "serve.reason": String(res.reason || "").slice(0, 160) }) });
    if (fromJournal) s.setAttributes({ "serve.replayed": true });
    return res;
  });
  let fromJournal = false, diverged = false;
  async function callTool(name, args, by, errors = null) {
    const k = seq++, old = diverged ? null : J?.calls[k]?.done;
    fromJournal = false;
    // already done before a restart: its result and what it changed come from the journal. (A different tool there
    // means the run has gone another way: it runs on from here without the journal's later steps.)
    if (old && old.name !== name) diverged = true;
    else if (old) {
      apply(old.fx); calls++; replayed++; fromJournal = true;
      trail.push({ name, args, res: old.res, by });
      if (name !== "finish") tell({ step: label[name]?.(args || {}) || name, tool: name, detail: detailOf(name, old.res), reason: args?.reason, by, error: !!old.res?.error, replayed: true });
      return old.res;
    }
    const m = mark();
    const res = await runTool(k, name, args, by, errors);
    J?.rec("done", { seq: k, name, res, fx: changes(m), step: label[name]?.(args || {}) || name });
    if (name === "negotiate") crashPoint("autopilot-negotiated");
    if (name === "request_approval" && !res.error) crashPoint("autopilot-asked");
    return res;
  }
  async function runTool(k, name, args, by, errors) {
    const f = tools[name];
    if (!f) return { error: `no tool called ${name}` };
    // arguments that do not fit the tool's schema: the tool does not run, and the model is told what to fix
    if (errors?.length) {
      const res = { error: `the arguments do not fit ${name}: ${errors.slice(0, 3).join("; ")}. Call ${name} again with arguments that fit its parameters.` };
      calls++; trail.push({ name, args, res, by });
      tell({ step: label[name](args || {}), tool: name, detail: `refused: ${res.error}`, reason: args?.reason, by, error: true });
      return res;
    }
    if (["request_approval", "finish", "nudge"].includes(name) && agreed.length && staleTime(args?.reason)) args = { ...args, reason: undefined };
    // a stop the model takes while a game is still within reach is refused (notYet), and the model goes on
    const early = by === "model" && ["request_approval", "nudge", "finish"].includes(name) ? notYet() : null;
    // a talk gets its id in the journal before it starts (the A2A contextId, and the holds' ref): after a restart the
    // same talk is picked up, not a second one started
    talkId = name === "negotiate" && J ? `neg-${id}-${k}` : null;
    if (talkId && !early) { if (!J.calls[k]?.intent) J.rec("call", { seq: k, name, talk: talkId }); crashPoint("autopilot-negotiating"); }
    let res;
    if (early) res = early;
    else try { res = await f(args || {}); } catch (e) { res = { error: String(e.message || e), threw: true }; }
    talkId = null;
    calls++;
    trail.push({ name, args, res, by });
    if (name !== "finish") tell({ step: label[name](args || {}), tool: name, detail: detailOf(name, res), reason: args?.reason, by, error: !!res.error });
    return res;
  }

  // the agent loop: Muse Glimmer decides the next tool, code runs it and returns the facts
  tell({ step: "Autopilot started", tool: "goal", detail: `goal: ${g.perWeek} ${g.sport} games a week · ${g.approval === "ask" ? "asks before booking" : "books within your limits"} · learned from ${hist.length} games${body?.log?.length ? `, ${body.log.length} body log entries` : ""}${body?.workouts?.length ? `, ${body.workouts.length} health-app workouts` : ""}` });
  const outdoorSport = ["basketball", "soccer", "football", "volleyball"].includes(g.sport);
  const sys = `You are the player's Serve agent, on Autopilot. Goal: get the player ${perWeek} ${g.sport} games this week, at the times they usually play, with the partners they play best with. Today is ${DAYS[now.getDay()]} ${ymd(now)}.
Work only through the tools, one step at a time:
1. get_week and check_body first (both in one turn).
2. For each game still needed: take an open habitual time (most played first), find_partners for it, then negotiate with the best candidates (singles: 1 member id; doubles: 3 member ids).${limit ? ` The player has a limit from their body log (${limit}): doubles first, and follow check_body's limits.` : ""}${outdoorSport ? ` ${g.sport} is often played outdoors: call find_places for that time and pass the best place id (verdict good) to negotiate, unless a club court is clearly better.` : " If negotiate fails because no court is free, try find_places for that time."}
3. If a negotiation fails, try the next candidate or the next habitual time. When the habitual times run out, use get_week's otherFreeTimes. Never repeat a failed negotiation, and never put two games on one day.
4. When games are agreed, request_approval once. If nothing could be agreed, nudge the player instead.
5. Then finish with one sentence for the player.
Use only member ids and times that tools returned. Give a one-sentence "reason" for every choice. Never write he or she; use first names. Follow what the player told you before (get_week's fromMemory, or recall): leave out a person, time or place they asked you to avoid (a person: pass their id in find_partners' leaveOut).`;
  const brief = `Goal: ${perWeek} ${g.sport} games this week. Today is ${DAYS[now.getDay()]} ${ymd(now)}.${limit ? ` Limit from the body log: ${limit}.` : ""}${outdoorSport ? ` ${g.sport} is often played outdoors.` : ""}`;
  const msgs = LEAN ? [{ role: "system", content: SYS }, { role: "user", content: `${brief} Run my week.` }] : [{ role: "system", content: sys }, { role: "user", content: "Run my week." }];
  // what a tool result looks like to the model: compact, without what it never uses
  const digest = (name, res) => JSON.stringify(!LEAN || res.error ? res : name === "find_partners" ? { ...res, candidates: res.candidates.map(({ rating, why, ...c }) => ({ ...c, why: why.slice(0, 2) })) } : res);
  if (LEAN) {
    // every run starts with the week and the body: code runs both and hands the model the results as its first turn
    const pre = [["get_week", await call("get_week", {}, "code")], ["check_body", await call("check_body", {}, "code")]];
    msgs.push({ role: "assistant", content: "", tool_calls: pre.map(([name], k) => ({ id: `pre${k}`, type: "function", function: { name, arguments: {} } })) },
      ...pre.map(([name, res], k) => ({ role: "tool", content: digest(name, res), tool_name: name, tool_call_id: `pre${k}` })));
  }
  // once a game is agreed, the searches that led to it shrink to one line each (all at once, so the cached prefix
  // breaks once per agreed game, not on every step)
  const settle = () => { if (!LEAN) return; for (const m of msgs) if (m.role === "tool" && ["find_partners", "find_places"].includes(m.tool_name) && !m.settled) { try { const r = JSON.parse(m.content); m.content = JSON.stringify({ summary: detailOf(m.tool_name, r) }); } catch { /* left as it is */ } m.settled = true; } };
  let stalls = 0, turnsReplayed = 0, stoppedBy = null, i = 0;
  for (; i < stepBudget && finished == null; i++) {
    work(i === 0 ? "Muse Glimmer is planning the week" : "Muse Glimmer is deciding the next step");
    // a turn taken before a restart comes back from the journal: the model is not asked again
    let out = diverged ? null : J?.turns[i] || null;
    if (out) turnsReplayed++;
    else {
      try { out = await chatTools(msgs, TOOLS, { maxTokens: 400, temperature: 0.2 }); } catch (e) { out = { calls: [], text: "", error: e.message }; }
      if (J) { J.rec("turn", { i, calls: out.calls, message: out.message || null, error: out.error || null }); crashPoint("autopilot-step"); }
    }
    if (!out.calls.length) { if (++stalls >= 2) { stoppedBy = "stall"; break; } msgs.push({ role: "user", content: "Call the next tool." }); continue; }
    stalls = 0;
    msgs.push(out.message);
    for (const c of out.calls.slice(0, 3)) {
      // a missing reason does not stop a call (the trail just has none); anything else that does not fit does
      const res = await call(c.name, c.args, "model", c.errors?.filter((e) => !/^\$\.reason: missing$/.test(e)), c.id || null);
      if (c.name === "negotiate" && res.agreed) settle();
      msgs.push({ role: "tool", content: digest(c.name, res), tool_name: c.name, ...(c.id ? { tool_call_id: c.id } : {}) });
      if (c.name === "request_approval" && !res.error && !finished) { /* the model will finish next */ }
    }
  }
  if (finished == null && !stoppedBy) stoppedBy = "steps";
  // the model stalled or ran out of steps: rules finish the same plan, and say so
  if (finished == null) {
    ruleTook = true;
    tell({ step: "Rules finished the plan", tool: "fallback", detail: "Muse Glimmer stopped calling tools; the same steps were completed by code" });
    const wk = tools.get_week();
    if (!trail.some((t) => t.name === "check_body")) await call("check_body", {}, "rules");
    for (const h of [...wk.habitualTimes.filter((x) => !x.alreadyTaken), ...(wk.otherFreeTimes || []).map((x) => ({ ...x, played: "when you are free" }))]) {
      if (agreed.length + booked.length >= perWeek) break;
      const format = limit || outdoorSport ? "doubles" : "singles", fp = await call("find_partners", { day: h.day, start: h.start, format, reason: `you played ${h.day} ${h.start} ${h.played}` }, "rules");
      const pl = outdoorSport && geo && fp.candidates ? await call("find_places", { day: h.day, start: h.start, reason: `${g.sport} is played outdoors` }, "rules") : null;
      for (const c of (fp.candidates || []).slice(0, format === "doubles" ? 1 : 2)) {
        const ids = format === "doubles" ? fp.candidates.slice(0, 3).map((x) => x.id) : [c.id];
        const ng = await call("negotiate", { members: ids, day: h.day, start: h.start, format, place: pl?.places?.find((p) => p.verdict === "good")?.id || pl?.places?.[0]?.id, reason: "best fit" }, "rules");
        if (ng.agreed) break;
      }
    }
    if (!approval) agreed.length ? await call("request_approval", { reason: "games agreed" }, "rules") : await call("nudge", { text: "I couldn't line up a game at your usual times this week. Want me to try other days?", reason: "nothing agreed" }, "rules");
    finished = agreed.length ? `Lined up ${agreed.length} game${agreed.length > 1 ? "s" : ""} for you; they wait for your yes.` : "No game fit your usual times this week; I sent you a nudge.";
  }
  if (agreed.length && !approval) await call("request_approval", { reason: "games agreed" }, "rules");
  // the model's last sentence is checked like everything else: every day and time in it must be an agreed game's,
  // every number must come from the agreed games or the goal; otherwise code says it
  const facts = agreed.map((o) => `${o.day} ${LONG_DAY[o.day]} ${o.date} ${o.start} ${o.end} ${o.minutes} ${o.venue.name} ${o.partners.map((p) => p.name).join(" ")}`).join(" ") + ` ${perWeek} ${g.perWeek} ${minutes}`;
  const said = String(finished || ""), times = [...said.matchAll(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*\s+(?:\d{4}-\d\d-\d\d\s+)?(\d{1,2}:\d\d)/g)];
  const byCode = agreed.length ? `Lined up ${agreed.length} game${agreed.length > 1 ? "s" : ""}: ${agreed.map(describe).join("; ")}. ${agreed.length > 1 ? "They wait" : "It waits"} for your yes.` : "No game fit your usual times this week; I sent you a nudge.";
  let summaryReplaced = false;
  // (a summary checked before a restart is the one the player gets)
  if (J?.once.summary) ({ text: finished, replaced: summaryReplaced } = J.once.summary);
  // nothing is booked before the player's yes, so a summary may not say it is
  else if (!said || !okNums(said, allowedIn(facts)) || times.some((m) => !agreed.some((o) => o.day === m[1] && o.start === m[2].padStart(5, "0"))) || PRONOUN.test(said) || /\bbook(ed|ing)\b/i.test(said)) { finished = byCode; summaryReplaced = !ruleTook; }
  // the model's sentence, past Llama Guard too, like every model's text for the player (autopilot_why.js)
  else { finished = await checkedSummary(finished, byCode); summaryReplaced = finished === byCode; }
  // a draft is said by code, plainly: the plan was not sent, and it needs the player's look
  if (!J?.once.summary && approval?.draft) finished = `I lined up ${agreed.length} game${agreed.length > 1 ? "s" : ""}, but ${aligned?.checked ? "the plan doesn't quite match what you asked for" : "I couldn't check the plan against what you asked for"}, so I haven't asked you to book ${agreed.length > 1 ? "them" : "it"}. It's a draft: please look it over first.`;
  if (J && !J.once.summary) J.rec("summary", { text: finished, replaced: summaryReplaced });
  const s1 = stats, secs = +((Date.now() - t0) / 1000).toFixed(1), needed = Math.max(0, perWeek - booked.length);
  const report = { id, seconds: secs, toolCalls: calls, modelCalls: s1.calls - s0.calls, modelSeconds: +(s1.seconds - s0.seconds).toFixed(1), parallelPeak: s1.peak, rules: ruleTook,
    replans: trail.filter((t) => t.name === "negotiate" && !t.res.agreed).length + trail.filter((t) => t.res?.error).length, refused: trail.filter((t) => t.res?.error).length, stopsRefused: pushedBack,
    needed, stoppedBy: stoppedBy || "finish", stepsLeft: Math.max(0, stepBudget - i), summaryReplaced, align: aligned && !aligned.off ? { aligned: aligned.aligned, checked: aligned.checked, seconds: aligned.seconds } : null, ...(J?.resumed ? { resumed: { turnsFromJournal: turnsReplayed, toolCallsFromJournal: replayed } } : {}) };
  db.runs = [{ id, at: t0, goal: g, agreed: agreed.map((o) => o.id), summary: finished, messenger, report }, ...db.runs.filter((x) => x.id !== id)].slice(0, 50); save();
  // the approval message (or the note that nothing fit) goes out once: noted in the journal before and after. A crash
  // between the two sends it again (at least once); a crash after the second does not
  const message = approval ? notify && (() => notify(id, agreed, finished, { draft: !!approval.draft })) : !agreed.length && notifyNone && (() => notifyNone(id, finished));
  if (message && !J?.once.notified) {
    J?.rec("notifying", {});
    await message().catch(() => {});
    J?.rec("notified", {}); crashPoint("autopilot-notified");
  }
  J?.rec("end", {}); J?.close();
  const tok = totals(current()?.calls);
  tell({ step: "Done", tool: "report", detail: `${secs} s · ${calls} tool calls · ${report.modelCalls} Muse Glimmer calls, up to ${report.parallelPeak} at once · ${tok.prompt} tokens read (${Math.round(tok.cachedShare * 100)}% cached), ${tok.output} written${ruleTook ? " · rules finished the plan" : ""}` });
  return { id, summary: finished, agreed, decisions, habits: habit.slice(0, 3), chemistry: chem, approval, report, body: { actions: org.actions, plan: bp, load: org.load }, trail: trail.map(({ name, args, by }) => ({ name, args, by })),
    ...(await extras({ player: player || messenger || "app", leftOut, fromMemory, trail, club })) };
}

// the player's answer, from the app or from Messenger: book all, book the first, or not this week
export function pending(id) { return db.pending[id] || null; }
// /forget: a Messenger player's plans and nudges (match/index.js forget)
export function forget(messenger) {
  let n = 0;
  for (const [k, p] of Object.entries(db.pending)) if (p.messenger === messenger) { delete db.pending[k]; n++; }
  // (and the journals of their runs still in progress, which hold their week and body log)
  for (const r of journal.unfinished()) if (r.entries[0]?.args?.messenger === messenger) { journal.remove(r.id); n++; }
  if (n) save();
  return n;
}
// The player's yes is saved with the games it books (the outbox) before any is booked; the caller books them and then
// clears it (booked). After a restart, toBook() lists what a yes left unbooked: play.book knows a game it already booked
// (by its talk), so booking again gives the same booking, never a second.
export function answer(id, choice) {
  const p = db.pending[id];
  if (!p || (p.status !== "pending" && p.status !== "draft")) return null; // a draft is the player's to book or drop too
  const options = choice === "all" ? p.options : choice === "first" ? p.options.slice(0, 1) : [];
  p.status = choice; p.answeredAt = Date.now(); if (options.length) { p.outbox = options; p.outboxAt = Date.now(); } save();
  crashPoint("autopilot-answered");
  noteOwn(p.messenger || "app", choice !== "none", "autopilot"); // the player's own approval, for their own records
  // the games not chosen: the members' agents let their times go (the chosen ones give way to the booking)
  p.options.filter((o) => !options.includes(o)).forEach((o) => { releaseHolds(o); });
  return { ...p, options };
}
export function booked(id) { const p = db.pending[id]; if (p?.outbox) { delete p.outbox; delete p.outboxAt; save(); } }
export const toBook = () => Object.entries(db.pending).filter(([, p]) => p.outbox?.length && Date.now() - (p.outboxAt || p.at) < 864e5).map(([id, p]) => ({ id, messenger: p.messenger || null, options: p.outbox }));
// a run's state for the app, whose stream ended with the gateway: still working (how far), or done (its plan)
export function status(id) {
  const pr = journal.progress(id);
  if (pr && !pr.ended) return { id, status: "working", ...pr };
  const r = db.runs.find((x) => x.id === id);
  if (!r) return null;
  const p = db.pending[id];
  return { id, status: "done", summary: r.summary || null, games: p?.options?.map((o) => ({ ...o, text: describe(o) })) || [], answer: p?.status || null, report: r.report };
}

// After a restart: every run a restart cut off is run again from its journal (one at a time, in the order they began).
// hooks(start) gives a resumed run what its first life had that cannot be saved: the approval message's sender (a
// Messenger player's notify). A run cut off too long ago (AUTOPILOT_RESUME_MAX_MS, 6 hours) is not picked up: the
// games it agreed but never asked about let their holds go, and its journal is removed.
export async function resumeRuns(hooks = () => ({})) {
  const max = +(process.env.AUTOPILOT_RESUME_MAX_MS || 6 * 3600e3), out = [];
  if (!durable()) return out;
  for (const r of journal.unfinished().sort((a, b) => a.entries[0].at - b.entries[0].at)) {
    const start = r.entries[0].args, last = r.entries.at(-1).at;
    if (Date.now() - last > max) {
      const asked = r.entries.some((e) => e.k === "done" && e.name === "request_approval" && !e.res?.error);
      if (!asked) for (const e of r.entries) if (e.k === "done") for (const o of e.fx?.agreed || []) await releaseHolds(o);
      journal.remove(r.id); continue;
    }
    try { out.push(await run({ ...start, now: new Date(start.now), ...hooks(start) }, { resume: r })); }
    catch (e) { console.error("autopilot resume", r.id, e.message); }
  }
  return out;
}
export const describe = (o) => `${o.sport && o.sport !== "badminton" ? o.sport[0].toUpperCase() + o.sport.slice(1) + " " + (o.format === "doubles" ? "2 on 2" : "1 on 1") : o.format === "doubles" ? "Doubles" : "Singles"} ${LONG_DAY[o.day]} ${o.start} at ${o.venue.name}${o.venue.public ? " (public court, free)" : ""} with ${o.partners.map((p) => first(p.name)).join(", ")}`;

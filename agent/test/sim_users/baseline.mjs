// The counterfactual: the same twenty people over the same days without Serve. Nobody's agent does the hassle; a person
// who wants a game must find the people and the court themselves. Pure and seeded: the same seed gives the same week,
// and it uses the same dice as the run with Serve (inertia.mjs), so a difference comes from the hassle, not from luck.
//
// The steps, and what each assumes (docs/simulated_users.md lists them, and why they lean towards the baseline):
//   1. Wanting a game and bothering to start: the same chance as asking Serve (inertia.initiates). No extra cost of
//      starting is charged to the baseline.
//   2. People: one message to the club's group chat, which reaches all nineteen others (everyone knows everyone in
//      this friend group). Each sees it if they look at their phone that day (the same chance as opening Serve), or
//      with a further 30% if they don't; they answer after their usual delay; they say they're in by the same rule as
//      a yes to Serve's ask (inertia.answerGame); and a lazy person who would play answers a group poll less often
//      (1 - 0.4 x laziness: someone else will).
//   3. Waiting: the organizer takes the first who are in (one for singles, three for doubles) and waits for them until
//      their patience runs out (patienceH) or two hours before the game, whichever is first.
//   4. A court: the venues nearest the organizer first, the same free courts Serve's agents would find (courts.mjs,
//      play.js's timetable) less the ones taken in this world; each try is two taps and five minutes, and after each
//      failed one they give up with a chance of 0.25 + 0.4 x laziness. Booking is two taps, telling the group one.
//   5. The game: everyone in it turns up by the same rule as with Serve (inertia.shows), and they all knew about it.
import { dayPlan, initiates, wantedSlot, commonSlot, answerGame, replyDelay, shows, trialNeed, freeThen, toMin, hm, ymd, DAYS } from "./inertia.mjs";
import { u, clamp } from "./rng.mjs";
import { freeCourts, travelMin } from "./courts.mjs";

const at = (date, time) => new Date(`${date}T${time}`);
const H = 36e5, MIN = 6e4;

// opts: the assumptions above as numbers, for the sensitivity check (validity.mjs): groupExtra (0.3), bystander (0.4),
// giveUp (0.25 + 0.4 x laziness, at most 0.65), counters (true)
export function runBaseline({ personas, venues, seed, dates, minutes = 90, opts = {} }) {
  const O = { groupExtra: 0.3, bystander: 0.4, giveUp0: 0.25, giveUpLazy: 0.4, counters: true, ...opts };
  const state = Object.fromEntries(personas.map((p) => [p.id, { games: [], played: 0, actions: 0, holds: [] }]));
  const courts = [], games = [], attempts = [], log = [];
  const byId = Object.fromEntries(personas.map((p) => [p.id, p])), last = [...dates].sort().at(-1);
  const need = (p, when) => trialNeed(p, dates.length) - state[p.id].games.filter((g) => !g.cancelled && (g.played !== false || at(g.date, g.start) > when)).length;
  const busyAt = (id, date, start) => [...state[id].games.filter((g) => !g.cancelled), ...state[id].holds].some((g) => g.date === date && toMin(g.start) < toMin(start) + minutes && toMin(start) < toMin(g.start) + minutes);
  const sameDay = (id, date) => state[id].games.some((g) => !g.cancelled && g.date === date);
  const act = (id, n, what, when) => { state[id].actions += n; log.push({ at: when.toISOString(), who: id, n, what }); };
  // the organizers' days, in time order: at their first look at the phone on a day they open it
  const starts = [];
  for (const date of dates) for (const p of personas) { const d = dayPlan(seed, p, date); if (d.open) starts.push({ p, date, when: at(date, d.sessions.slice().sort()[0]) }); }
  starts.sort((a, b) => a.when - b.when);
  // when they see a message sent at `t` (the group chat), or null: the same day if they look at their phone that day
  // (or, failing that, 30% of the time anyway), after their usual delay
  const seen = (j, t, key) => {
    const date = ymd(t), d = dayPlan(seed, j, date), extra = u(seed, "group-extra", j.id, key) < O.groupExtra;
    if (!d.open && !extra) {
      const next = new Date(t); next.setDate(next.getDate() + 1); const nd = ymd(next), d2 = dates.includes(nd) && dayPlan(seed, j, nd);
      return d2?.open ? at(nd, d2.sessions.slice().sort()[0]) : null;
    }
    return new Date(t.getTime() + replyDelay(seed, j, `group:${key}`) * MIN);
  };
  for (const s of starts) {
    const o = s.p, now = s.when;
    if (need(o, now) <= 0) continue;
    if (!initiates(seed, o, s.date)) continue;
    const exclude = state[o.id].games.filter((g) => !g.cancelled).map((g) => g.date);
    let slot = wantedSlot(seed, o, now, { exclude, until: last });
    if (!slot || busyAt(o.id, slot.date, slot.start)) continue;
    const key = `${o.id}:${slot.date}:${slot.start}`, A = { id: key, by: o.id, onset: now.toISOString(), slot, actions: {}, steps: [] };
    attempts.push(A);
    const count = (id, n, what, when) => { act(id, n, what, when); A.actions[id] = (A.actions[id] || 0) + n; };
    count(o.id, 1, "group chat: anyone for a game", now);
    let deadline = new Date(Math.min(now.getTime() + o.inertia.patienceH * H, at(slot.date, slot.start).getTime() - 2 * H));
    // who's in, and when the organizer has heard from them; someone who can't then but would play offers another time
    // the two of them are free (a counter), which the organizer can take instead
    const want = slot.format === "doubles" ? 3 : 1;
    const ins = [], counters = [];
    for (const j of personas.filter((x) => x.id !== o.id && (x.sports || ["badminton"]).includes(slot.sport) && (x.prefers === "any" || x.prefers === slot.format))) {
      const t = seen(j, now, key);
      if (!t || t > deadline) continue;
      if (u(seed, "group-reply", j.id, key) > 1 - O.bystander * j.inertia.laziness) continue; // someone else will answer
      const a = !busyAt(j.id, slot.date, slot.start) && !sameDay(j.id, slot.date) ? answerGame(seed, j, { date: slot.date, start: slot.start, minutes, need: need(j, t), key: `group:${key}` }) : "other";
      if (a === "yes") { ins.push({ j, t }); continue; }
      if (a !== "other" || need(j, t) <= 0 || u(seed, "group-counter", j.id, key) < j.inertia.pNotThisWeek) continue;
      const c = commonSlot(seed, o, j, t, { until: last, exclude: [...exclude, ...state[j.id].games.filter((g) => !g.cancelled).map((g) => g.date)] });
      if (c && !busyAt(o.id, c.date, c.start) && !busyAt(j.id, c.date, c.start)) counters.push({ j, t, c });
    }
    ins.sort((a, b) => a.t - b.t);
    let party = ins.slice(0, want);
    // not enough for the time asked: the time most counters asked for, if enough offered it (one for singles)
    if (O.counters && party.length < want && counters.length) {
      const by = {}; for (const x of counters) (by[`${x.c.date} ${x.c.start}`] ||= []).push(x);
      const best = Object.values(by).sort((a, b) => b.length - a.length || a[0].t - b[0].t)[0];
      if (best.length >= want) {
        const t0 = new Date(best[want - 1].t.getTime() + replyDelay(seed, o, `counter:${key}`) * MIN);
        if (t0 <= deadline) {
          slot = { ...slot, date: best[0].c.date, day: best[0].c.day, start: best[0].c.start };
          A.steps.push(`moved to ${slot.date} ${slot.start}, the time ${best.length} counter${best.length > 1 ? "s" : ""} asked for`);
          count(o.id, 1, "group chat: ok, that time then", t0);
          party = best.slice(0, want).map(({ j, t }) => ({ j, t }));
          deadline = new Date(Math.min(t0.getTime() + o.inertia.patienceH * H, at(slot.date, slot.start).getTime() - 2 * H));
        }
      }
    }
    if (party.length < want) { A.failed = party.length || ins.length ? `only ${Math.max(party.length, ins.length)} of ${want} said they were in before the organizer gave up` : counters.length ? `${counters.length} offered other times, but not enough the same one` : "nobody answered in time"; A.steps.push(A.failed); continue; }
    party.forEach(({ j, t }) => { count(j.id, 1, "group chat: I'm in", t); state[j.id].holds.push({ date: slot.date, start: slot.start, ref: key }); });
    // the organizer reads the last of them at their next delay, then looks for a court
    let t = new Date(party.at(-1).t.getTime() + replyDelay(seed, o, `read:${key}`) * MIN);
    if (t > deadline) { A.failed = "the organizer saw the replies too late"; A.steps.push(A.failed); party.forEach(({ j }) => { state[j.id].holds = state[j.id].holds.filter((h) => h.ref !== key); }); continue; }
    const people = [o, ...party.map((x) => x.j)];
    const order = venues.venues.filter((v) => !v.sports || v.sports[slot.sport]).map((v) => ({ v, trip: travelMin(o.home, v) })).sort((a, b) => a.trip - b.trip);
    let booked = null, tries = 0;
    for (const { v } of order) {
      tries++; count(o.id, 2, `court search: ${v.id}`, t); t = new Date(t.getTime() + 5 * MIN);
      const free = freeCourts(v, slot.date, toMin(slot.start), minutes, { sport: slot.sport, booked: courts });
      const tooFar = people.some((x) => x.rules?.maxTrip && travelMin(x.home, v) > x.rules.maxTrip);
      if (free.length && !tooFar) { booked = { venue: v.id, court: free[0] }; break; }
      if (u(seed, "court-giveup", o.id, key, tries) < clamp(O.giveUp0 + O.giveUpLazy * o.inertia.laziness, O.giveUp0, 0.65)) break;
    }
    party.forEach(({ j }) => { state[j.id].holds = state[j.id].holds.filter((h) => h.ref !== key); });
    if (!booked) { A.failed = `no court found after ${tries} venue${tries > 1 ? "s" : ""}`; A.steps.push(A.failed); count(o.id, 1, "group chat: no court, never mind", t); continue; }
    count(o.id, 2, "booked the court", t); count(o.id, 1, "group chat: booked, see you", t);
    courts.push({ venue: booked.venue, court: booked.court, date: slot.date, start: slot.start, minutes });
    const g = { id: key, date: slot.date, start: slot.start, minutes, format: slot.format, venue: booked.venue, court: booked.court, by: o.id, with: party.map((x) => x.j.id), bookedAt: t.toISOString(), onset: A.onset, waitMin: Math.round((t - new Date(A.onset)) / MIN) };
    games.push(g); A.booked = g.id;
    for (const id of [o.id, ...g.with]) state[id].games.push(g);
  }
  // the games themselves
  for (const g of games) {
    const turn = [g.by, ...g.with].map((id) => ({ id, ...shows(seed, byId[id], { date: g.date, start: g.start, minutes, knows: true, key: `game:${g.date}:${g.start}:${id}` }) }));
    g.turnout = turn; g.played = turn.every((x) => x.shows);
    if (g.played) for (const x of turn) state[x.id].played++;
  }
  return {
    perUser: Object.fromEntries(personas.map((p) => [p.id, { played: state[p.id].played, booked: state[p.id].games.length, actions: state[p.id].actions, organized: attempts.filter((a) => a.by === p.id).length }])),
    games, attempts, log,
  };
}
export { DAYS, hm, freeThen };

// A venue's pricing and negotiation policy, run by the platform for the venue. Money is in integer cents.
//   list      the venue's price for the booking: per hour of one unit (a court, a karaoke room, a barbecue pit) times
//             the length, or per person (an escape room, a board game table, hot pot) times the people
//   ask       what the venue asks before any haggling: the list price less the discounts its policy grants for these
//             terms (off-peak, a group, a unit that would otherwise stay empty in the next few hours)
//   floor     the least it will ever take: floorPct of the list price. Never shown to anyone, and no answer depends on
//             it except by the concession schedule below, so an agent can't search for it.
// How far the venue comes down from its ask in a negotiation is its style, a fixed schedule over at most `rounds`
// counter-offers: "firm" doesn't move, "standard" comes halfway to the floor, "eager" all the way.
import { forActivity } from "../world.js";
import { DAYS, dateOf, hm, startOf, toMin } from "../time.js";

const STYLE = { firm: 0, standard: 0.5, eager: 1 };
const MAX_DISCOUNT = 0.3;
export const cents = (usd) => Math.round(usd * 100);
export const usd = (c) => (c / 100).toFixed(2);

export function price(v, { activity, date, start, minutes, players }, now = new Date()) {
  const s = forActivity(v, activity);
  if (!s) return null;
  const p = v.policy || {}, list = s.per === "person" ? cents(s.price) * players : Math.round((cents(s.price) * minutes) / 60);
  const day = dateOf(date).getDay(), weekend = day === 0 || day === 6;
  const discounts = [];
  if (p.offPeak && !weekend && toMin(start) + minutes <= toMin(p.offPeak.before)) discounts.push({ kind: "off-peak", pct: p.offPeak.pct, why: `ends before ${p.offPeak.before} on a weekday` });
  if (p.group && players >= p.group.min) discounts.push({ kind: "group", pct: p.group.pct, why: `${players} people (${p.group.min}+)` });
  const hoursAway = (startOf(date, start) - now) / 3600e3;
  if (p.lastMinute && hoursAway > 0 && hoursAway <= p.lastMinute.withinHours) discounts.push({ kind: "last-minute", pct: p.lastMinute.pct, why: `starts within ${p.lastMinute.withinHours} hours` });
  const off = Math.min(MAX_DISCOUNT, discounts.reduce((a, d) => a + d.pct, 0));
  const floor = Math.round(list * (p.floorPct ?? 1));
  const ask = Math.max(floor, Math.round(list * (1 - off)));
  return { list, ask, floor, discounts, rounds: p.rounds ?? 3, style: p.style in STYLE ? p.style : "firm", day: DAYS[day] };
}

// The venue's ask after `round` counter-offers (round 0 is the opening ask)
export function askAt(q, round) {
  const room = Math.round((q.ask - q.floor) * STYLE[q.style]);
  const r = Math.min(round, q.rounds);
  return q.ask - Math.round((room * r) / q.rounds);
}

// Cheaper terms at the same venue, for the venue's answer: other start times that day with a free unit, and the group
// discount if a few more people would earn it (only where it lowers each person's share). Code-made reasons only.
export function cheaperTerms(v, terms, freeAt, now) {
  const base = price(v, terms, now), out = [];
  if (!base) return out;
  for (let d = -120; d <= 120; d += 30) {
    if (!d) continue;
    const start = toMin(terms.start) + d;
    if (start < 0 || start + terms.minutes > 24 * 60) continue;
    const t = { ...terms, start: hm(start) };
    if (!freeAt(t)) continue;
    const q = price(v, t, now);
    if (q && q.ask < base.ask) out.push({ change: { start: t.start }, ask: q.ask, saves: base.ask - q.ask, why: q.discounts.map((x) => x.why).join("; ") });
  }
  const g = v.policy?.group;
  if (g && terms.players < g.min) {
    const q = price(v, { ...terms, players: g.min }, now), each = (x, n) => Math.ceil(x / n);
    if (q && each(q.ask, g.min) < each(base.ask, terms.players)) out.push({ change: { players: g.min }, ask: q.ask, saves: base.ask - q.ask, why: `group rate from ${g.min} people: $${usd(each(q.ask, g.min))} each` });
  }
  // a shorter booking, where the activity has one: the same venue, proportionally less
  for (const m of (terms.allowedMinutes || []).filter((x) => x < terms.minutes)) {
    const q = price(v, { ...terms, minutes: m }, now);
    if (q && q.ask < base.ask) out.push({ change: { minutes: m }, ask: q.ask, saves: base.ask - q.ask, why: `${m} minutes instead of ${terms.minutes}: $${usd(Math.ceil(q.ask / terms.players))} each` });
  }
  for (const c of out) if (!c.why) c.why = c.change.start ? `starting at ${c.change.start}` : "";
  return out.sort((a, b) => b.saves - a.saves).slice(0, 4);
}

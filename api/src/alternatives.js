// When a deal is out of a player's budget, the venue says no, or the court is taken: other places nearby, ranked by
// code. Bookable venues first (within budget, then the same start time, then the shortest longest trip for the
// group, then price), and free public courts after them: those are first come, can't be reserved and never go through
// payment. Every reason is written by code from the numbers.
import { getWorld, freeCourts, forSport } from "./world.js";
import { price, usd } from "./negotiate/policy.js";
import { trips } from "./geo.js";
import { hm, toMin } from "./time.js";

const SHIFTS = [0, -30, 30, -60, 60];
export const shareOf = (amount, n) => Math.ceil(amount / Math.max(1, n));

export function alternatives({ people, sport, date, start, minutes, budgetShare = Infinity, exclude = null, from = null, now = new Date(), limit = 4 }) {
  const w = getWorld(), n = people.length, base = from ? trips(people, from).longest : null, out = [];
  for (const v of w.venues) {
    if (v.id === exclude || !forSport(v, sport)) continue;
    const t = trips(people, v);
    let best = null;
    for (const d of SHIFTS) {
      const s = toMin(start) + d;
      if (s < 0 || s + minutes > 24 * 60) continue;
      const terms = { sport, date, start: hm(s), minutes, players: n };
      const courts = freeCourts(v.id, sport, date, terms.start, minutes);
      if (!courts.length) continue;
      const q = price(v, terms, now), share = shareOf(q.ask, n);
      const cand = { kind: "venue", bookable: true, venue: v.id, name: v.name, start: terms.start, shift: d, courtsFree: courts.length, price: q.ask, share, withinBudget: share <= budgetShare, longestTrip: t.longest, trips: t.list, discounts: q.discounts.map((x) => x.kind) };
      if (!best || rank(cand) < rank(best)) best = cand;
    }
    if (best) out.push(best);
  }
  for (const p of w.publicCourts || []) {
    if (!p.sports.includes(sport)) continue;
    const t = trips(people, p);
    out.push({ kind: "public", bookable: false, venue: p.id, name: p.name, start, shift: 0, price: 0, share: 0, withinBudget: true, longestTrip: t.longest, trips: t.list, lit: p.lit, indoor: p.indoor });
  }
  out.sort((a, b) => rank(a) - rank(b));
  const pub = out.filter((x) => !x.bookable).slice(0, 1);
  const list = [...out.filter((x) => x.bookable).slice(0, limit - pub.length), ...pub];
  // (money leaves as USD strings, like every answer to an agent)
  return list.map((x) => ({ ...x, price: usd(x.price), share: usd(x.share), why: why(x, { base, budgetShare, start }) }));
}

// lower is better: bookable before public, within budget, same time, shortest longest trip, cheapest
const rank = (x) => (x.bookable ? 0 : 1e9) + (x.withinBudget ? 0 : 1e8) + Math.abs(x.shift) * 1e4 + x.longestTrip * 100 + x.price / 1e4;

function why(x, { base, budgetShare, start }) {
  const parts = [];
  if (!x.bookable) parts.push("free public court: first come, can't be reserved");
  else parts.push(`$${usd(x.share)} each${Number.isFinite(budgetShare) ? (x.withinBudget ? `, within the $${usd(budgetShare)} budget` : `, over the $${usd(budgetShare)} budget`) : ""}`);
  if (x.shift) parts.push(`starts ${x.start} instead of ${start}`);
  if (base !== null) { const d = x.longestTrip - base; parts.push(d > 0 ? `${d} min more for the farthest player` : d < 0 ? `${-d} min less for the farthest player` : "same trip for the farthest player"); }
  else parts.push(`longest trip ${x.longestTrip} min`);
  if (x.kind === "public" && x.lit === false) parts.push("no lights");
  if (x.discounts?.length) parts.push(`${x.discounts.join(" + ")} price`);
  return parts.join("; ");
}

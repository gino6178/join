// When a deal is out of a player's budget, the venue says no, or the place is taken: other places nearby, ranked by
// code. Bookable venues first (within budget, then the same start time, then the shortest longest trip for the
// group, then price), and free public places after them (a park court, a picnic grill): those are first come, can't be reserved and never go through
// payment. Every reason is written by code from the numbers.
import { getWorld, freeUnits, forActivity } from "./world.js";
import { price, usd } from "./negotiate/policy.js";
import { trips } from "./geo.js";
import { hm, toMin } from "./time.js";
import * as reviews from "./reviews.js";

const SHIFTS = [0, -30, 30, -60, 60];
export const shareOf = (amount, n) => Math.ceil(amount / Math.max(1, n));

export function alternatives({ people, activity, date, start, minutes, budgetShare = Infinity, exclude = null, from = null, now = new Date(), limit = 4 }) {
  const w = getWorld(), n = people.length, base = from ? trips(people, from).longest : null, out = [];
  for (const v of w.venues) {
    const o = forActivity(v, activity);
    if (v.id === exclude || !o || n < o.min || n > o.max) continue;
    const t = trips(people, v);
    let best = null;
    for (const d of SHIFTS) {
      const s = toMin(start) + d;
      if (s < 0 || s + minutes > 24 * 60) continue;
      const terms = { activity, date, start: hm(s), minutes, players: n };
      const units = freeUnits(v.id, activity, date, terms.start, minutes);
      if (!units.length) continue;
      const q = price(v, terms, now), share = shareOf(q.ask, n);
      const rv = reviews.summary(v.id, { activity, group: people.map((p) => p.id) });
      const cand = { kind: "venue", bookable: true, venue: v.id, name: v.name, start: terms.start, shift: d, unitsFree: units.length, price: q.ask, share, withinBudget: share <= budgetShare, longestTrip: t.longest, trips: t.list, discounts: q.discounts.map((x) => x.kind),
        rating: rv.count ? rv.score : null, ratingAdjust: reviews.rankAdjust(rv), reviews: reviews.reason(rv), groupLow: rv.groupLow.map((g) => g.name) };
      if (!best || rank(cand) < rank(best)) best = cand;
    }
    if (best) out.push(best);
  }
  for (const p of w.publicPlaces || []) {
    if (!p.activities.includes(activity)) continue;
    const t = trips(people, p);
    out.push({ kind: "public", bookable: false, venue: p.id, name: p.name, start, shift: 0, price: 0, share: 0, withinBudget: true, longestTrip: t.longest, trips: t.list, lit: p.lit, indoor: p.indoor });
  }
  out.sort((a, b) => rank(a) - rank(b));
  const pub = out.filter((x) => !x.bookable).slice(0, 1);
  const list = [...out.filter((x) => x.bookable).slice(0, limit - pub.length), ...pub];
  // (money leaves as USD strings, like every answer to an agent)
  return list.map(({ ratingAdjust, ...x }) => ({ ...x, price: usd(x.price), share: usd(x.share), why: why(x, { base, budgetShare, start }) }));
}

// lower is better: bookable before public, within budget, same time, shortest longest trip, cheapest
// (verified reviews move a venue like minutes of travel do: reviews.rankAdjust)
const rank = (x) => (x.bookable ? 0 : 1e9) + (x.withinBudget ? 0 : 1e8) + Math.abs(x.shift) * 1e4 + (x.longestTrip + (x.ratingAdjust || 0)) * 100 + x.price / 1e4;

function why(x, { base, budgetShare, start }) {
  const parts = [];
  if (!x.bookable) parts.push("free public place: first come, can't be reserved");
  else parts.push(`$${usd(x.share)} each${Number.isFinite(budgetShare) ? (x.withinBudget ? `, within the $${usd(budgetShare)} budget` : `, over the $${usd(budgetShare)} budget`) : ""}`);
  if (x.shift) parts.push(`starts ${x.start} instead of ${start}`);
  if (base !== null) { const d = x.longestTrip - base; parts.push(d > 0 ? `${d} min more for the farthest player` : d < 0 ? `${-d} min less for the farthest player` : "same trip for the farthest player"); }
  else parts.push(`longest trip ${x.longestTrip} min`);
  if (x.kind === "public" && x.lit === false) parts.push("no lights");
  if (x.discounts?.length) parts.push(`${x.discounts.join(" + ")} price`);
  if (x.reviews && x.reviews !== "no reviews yet") parts.push(x.reviews);
  return parts.join("; ");
}

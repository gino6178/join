// What Join's website agent does once it knows the brief. It is code, not the model: the model (or the rules) only
// understands the person; searching, haggling and accepting follow fixed steps through the same tools any agent uses
// (/api/scout/<tool>, as the signed-in person, under their limits). Paying is left to the person, in PayPal.
import { api } from "../api.js";

const tool = (name, args, model) => api(`/api/scout/${name}`, { method: "POST", body: { ...args, _model: model } }).catch((e) => e.body || { error: "failed", message: e.message });

// What a person may pay: their budget, but never more than the limit they set on Join
export const each = (brief, limit) => (brief.budget != null ? Math.min(brief.budget, limit) : limit);
// the lowest offer a venue takes seriously is 70% of its ask; the agent's opening offer is 72%
const SERIOUS = 0.72;

// Up to three options, each with why it was picked, which named friends can't come, and whether haggling can reach it
export async function search(brief, model, w) {
  const r = await tool("find_options", { activity: brief.activity, dates: brief.dates || [], from: brief.from, to: brief.to, players: brief.players ?? 3, with: brief.with || [] }, model);
  if (r.error) return { error: r.message || r.error };
  const limit = +r.mandate.perGame, cap = each(brief, limit);
  return {
    options: r.options.slice(0, 3).map((o) => {
      const share = +o.share, ask = +o.askPrice, people = o.players.length;
      const why = [w.why.free(people), w.why.trip(o.longestTrip), ...o.discounts.map(w.why.discount)];
      // (the limit for this option: per booking, or what's left of that week's, whichever is less)
      const lim = Math.min(limit, o.youCanSpend != null ? +o.youCanSpend : limit), c = each(brief, lim);
      return { ...o, why, limit: lim, weekCut: lim < limit, missing: (brief.with || []).filter((id) => !o.players.includes(id)),
        fit: share <= c ? "ok" : ask * SERIOUS > c * people ? "tooFar" : "haggle" };
    }),
    limit, cap, note: r.note,
  };
}

// Haggle with one venue, patiently: an offer just over 70% of the current ask each round (a serious offer, so the venue
// moves along its own schedule; any more would only be giving money away), never an offer once the venue says its price
// is final (a firm venue rejects anything under it). Ends with the venue's final price, unaccepted, or a deal if the
// venue took an offer. This is the strategy that did best in our benchmark (bench/negotiation.mjs, docs/NEGOTIATION.md).
async function haggle(o, brief, model, say, w) {
  const n = await tool("start_negotiation", { venue: o.venue, activity: brief.activity, date: o.date, start: o.start, minutes: o.minutes, players: o.players.slice(1) }, model);
  if (n.error) return { error: n.message, alternatives: n.alternatives };
  say(w.asks(n.venueName, n.ask, n.share));
  let cur = n;
  while (cur.status === "open" && !cur.final && cur.roundsLeft > 0) {
    const offer = Math.ceil(+cur.ask * 70 + 1) / 100;
    const r = await tool("make_offer", { negotiation: n.id, amount: offer }, model);
    if (r.error) return { error: r.message, alternatives: r.alternatives, n: cur };
    cur = r;
    if (r.status === "agreed") { say(w.agreedAt(offer, r.venueName)); return { deal: r }; }
    if (r.status === "rejected") return { error: w.saidNo(r.venueName, offer), alternatives: r.alternatives };
    say(w.offered(offer, r.venueName, r.ask, r.final));
  }
  return cur.status === "open" ? { quote: cur } : { error: w.closed(cur.status) };
}

// Shop for the best price: haggle with the venue the person picked, then with up to two other venues free at about the
// same time, and keep the best. The person's pick is booked unless another venue is cheaper by at least $1 each; then
// they choose. Anything over their limit is never offered (Join would refuse it); over their budget, they decide.
export async function negotiate(o, brief, model, say, w) {
  const people = o.players.length, cap = each(brief, o.limit), target = cap * people;
  if (target < +o.askPrice * 0.7) {
    const lowest = Math.ceil(+o.askPrice * 72) / 100;
    return { error: w.tooFar(lowest, lowest / people, cap, !(brief.budget != null && brief.budget < o.limit)) };
  }
  const first = await haggle(o, brief, model, say, w);
  if (first.deal || (first.error && !first.quote)) return first;
  const quotes = [{ n: first.quote, o }];
  // other venues for the same plan, at about the same time, within what the person may pay
  const alts = ((await alternatives(o, brief, model)).alternatives || []).filter((a) => a.bookable !== false && a.venue !== o.venue && a.withinBudget !== false && !(a.groupLow || []).length).slice(0, 2);
  if (alts.length) say(w.shopping(alts.map((a) => a.name)));
  for (const a of alts) {
    const ao = { ...o, venue: a.venue, venueName: a.name, start: a.start, askPrice: a.price, rating: a.rating };
    const r = await haggle(ao, brief, model, say, w);
    if (r.deal) { for (const q of quotes) await walkAway(q.n, model); return r; } // (a venue took an offer: that's the booking)
    if (r.quote) quotes.push({ n: r.quote, o: ao });
  }
  // (alternatives a group member rated 2★ or less, find_alternatives says so, are dropped; the rest by price)
  const fits = quotes.filter((q) => +q.n.ask / people <= o.limit).sort((x, y) => +x.n.ask - +y.n.ask);
  for (const q of quotes.filter((x) => !fits.includes(x))) await walkAway(q.n, model);
  if (!fits.length) return { error: w.bestOverLimit(first.quote.ask, first.quote.share, o.limit) };
  const mine = fits.find((q) => q.n.venue === o.venue), best = fits[0];
  // the person's pick, unless another venue is cheaper by $1 each or more: then they choose
  if (mine && (best === mine || (+mine.n.ask - +best.n.ask) / people < 1) && +mine.n.ask <= target) {
    for (const q of fits.filter((x) => x !== mine)) await walkAway(q.n, model);
    if (fits.length > 1) say(w.kept(mine.n.venueName, mine.n.ask));
    return acceptDeal(mine.n, model);
  }
  return { choices: fits.map((q) => ({ n: q.n, o: q.o, over: +q.n.ask > target })), note: fits.length > 1 ? w.compare(fits.map((q) => ({ name: q.n.venueName, ask: q.n.ask, share: q.n.share, start: q.o.start, rating: q.o.rating ?? q.o.reviews?.score }))) : w.bestOverBudget(best.n.ask, best.n.share, cap) };
}

export async function acceptDeal(n, model) {
  const a = await tool("accept_price", { negotiation: n.id }, model);
  return a.error ? { error: a.message, alternatives: a.alternatives } : { deal: a };
}
export const walkAway = (n, model) => tool("walk_away", { negotiation: n.id }, model);
export const alternatives = (o, brief, model) => tool("find_alternatives", { activity: brief.activity, date: o.date, start: o.start, minutes: o.minutes, players: o.players.slice(1), budget: each(brief, o.limit), exclude: o.venue }, model);

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

// Haggle for one option: open at a serious offer, meet halfway on each counter, accept once the price is within what the
// person may pay; over their budget but within their limit, ask them; over their limit, walk away (Join would refuse).
export async function negotiate(o, brief, model, say, w) {
  const n = await tool("start_negotiation", { venue: o.venue, activity: brief.activity, date: o.date, start: o.start, minutes: o.minutes, players: o.players.slice(1) }, model);
  if (n.error) return { error: n.message, alternatives: n.alternatives };
  say(w.asks(n.venueName, n.ask, n.share));
  const people = n.players.length, cap = each(brief, o.limit), target = cap * people;
  if (target < +n.ask * 0.7) {
    await tool("walk_away", { negotiation: n.id }, model);
    const lowest = Math.ceil(+n.ask * SERIOUS);
    return { error: w.tooFar(lowest, lowest / people, cap, !(brief.budget != null && brief.budget < o.limit)) };
  }
  let cur = n;
  for (let i = 0; i < 4 && cur.status === "open" && !cur.final && cur.roundsLeft > 0; i++) {
    const ask = +cur.ask;
    if (ask <= target && i > 0) break;
    const offer = Math.round(Math.max(Math.ceil(ask * SERIOUS), Math.min(target, ask * 0.9)) * 100) / 100;
    const r = await tool("make_offer", { negotiation: n.id, amount: offer }, model);
    if (r.error) return { error: r.message, alternatives: r.alternatives };
    cur = r;
    if (r.status === "agreed") { say(w.agreedAt(offer, r.venueName)); return { deal: r }; }
    if (r.status === "rejected") return { error: w.saidNo(r.venueName, offer), alternatives: r.alternatives };
    say(w.offered(offer, r.venueName, r.ask, r.final));
  }
  if (cur.status !== "open") return { error: w.closed(cur.status) };
  if (+cur.ask > target) {
    if (+cur.ask / people > o.limit) { await tool("walk_away", { negotiation: n.id }, model); return { error: w.bestOverLimit(cur.ask, cur.share, o.limit) }; }
    return { pending: cur, note: w.bestOverBudget(cur.ask, cur.share, cap) };
  }
  return acceptDeal(cur, model);
}

export async function acceptDeal(n, model) {
  const a = await tool("accept_price", { negotiation: n.id }, model);
  return a.error ? { error: a.message, alternatives: a.alternatives } : { deal: a };
}
export const walkAway = (n, model) => tool("walk_away", { negotiation: n.id }, model);
export const alternatives = (o, brief, model) => tool("find_alternatives", { activity: brief.activity, date: o.date, start: o.start, minutes: o.minutes, players: o.players.slice(1), budget: each(brief, o.limit), exclude: o.venue }, model);

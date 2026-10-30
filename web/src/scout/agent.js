// What Join's website agent does once it knows the brief. It is code, not the model: the model (or the rules) only
// understands the person; searching, haggling and accepting follow fixed steps through the same tools any agent uses
// (/api/scout/<tool>, as the signed-in person, under their limits). Paying is left to the person, in PayPal.
import { api } from "../api.js";

const tool = (name, args, model) => api(`/api/scout/${name}`, { method: "POST", body: { ...args, _model: model } }).catch((e) => e.body || { error: "failed", message: e.message });

// Up to three options, each with why it was picked
export async function search(brief, model) {
  const r = await tool("find_options", { activity: brief.activity, dates: brief.dates || [], from: brief.from, to: brief.to, players: brief.players ?? 3, with: brief.with || [] }, model);
  if (r.error) return { error: r.message || r.error };
  return {
    options: r.options.slice(0, 3).map((o) => {
      const share = +o.share, over = brief.budget != null && share > brief.budget;
      const why = [`${o.names.length} people free`, `longest trip ${o.longestTrip} min`];
      if (o.discounts.length) why.push(`${o.discounts.join(" + ")} discount`);
      if (brief.with?.length) why.push("the friends you named first");
      return { ...o, why, over };
    }),
    limit: r.mandate.perGame, note: r.note,
  };
}

// Haggle for one option: open at the venue's ask, offer a serious amount (never under 70% of the ask, which venues
// ignore), meet halfway on each counter, and accept once the price is within the budget or the venue's last word is in.
export async function negotiate(o, brief, model, say) {
  const n = await tool("start_negotiation", { venue: o.venue, activity: brief.activity, date: o.date, start: o.start, minutes: o.minutes, players: o.players.slice(1) }, model);
  if (n.error) return { error: n.message, alternatives: n.alternatives };
  say(`${n.venueName} asks $${n.ask} ($${n.share} each).`);
  const people = n.players.length, target = brief.budget != null ? brief.budget * people : null;
  let cur = n;
  for (let i = 0; i < 4 && cur.status === "open" && !cur.final && cur.roundsLeft > 0; i++) {
    const ask = +cur.ask;
    if (target != null && ask <= target && i > 0) break;
    const offer = Math.max(Math.ceil(ask * 0.72), target != null ? Math.min(target, ask * 0.9) : ask * 0.85);
    const r = await tool("make_offer", { negotiation: n.id, amount: Math.round(offer * 100) / 100 }, model);
    if (r.error) { say(r.message); break; }
    cur = r;
    if (r.status === "agreed") { say(`Offered $${offer.toFixed(2)}. ${r.venueName} agreed.`); return { deal: r }; }
    if (r.status === "rejected") return { error: `${r.venueName} said no at $${offer.toFixed(2)}.`, alternatives: r.alternatives };
    say(`Offered $${offer.toFixed(2)}. ${r.venueName} countered $${r.ask}${r.final ? ", best and final" : ""}.`);
  }
  if (cur.status !== "open") return { error: `The negotiation is ${cur.status}.` };
  if (target != null && +cur.ask > target) {
    return { pending: cur, note: `The best price is $${cur.ask} ($${cur.share} each), over your $${brief.budget.toFixed(2)} a person.` };
  }
  return acceptDeal(cur, model);
}

export async function acceptDeal(n, model) {
  const a = await tool("accept_price", { negotiation: n.id }, model);
  return a.error ? { error: a.message, alternatives: a.alternatives } : { deal: a };
}
export const walkAway = (n, model) => tool("walk_away", { negotiation: n.id }, model);
export const alternatives = (o, brief, model) => tool("find_alternatives", { activity: brief.activity, date: o.date, start: o.start, minutes: o.minutes, players: o.players.slice(1), budget: brief.budget, exclude: o.venue }, model);

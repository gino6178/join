// The negotiation layer. An organizer's agent bargains with a venue for one court: the terms (venue, sport, date, start,
// length, who plays) are fixed when the negotiation opens, and only the price moves.
//   open     the venue's ask for those terms, its discounts, cheaper terms at the same venue, each player's share
//   offer    the organizer's agent names a price. At or above the venue's current ask: agreed at the ask. Below it:
//            the venue counters on its schedule (policy.js askAt), at most `rounds` times; its last counter is its best
//            and final, and an offer below that ends the negotiation.
//   accept   take the venue's current ask
//   cancel   the organizer walks away
// A negotiation expires TTL after it opened. Only structured fields cross: numbers, ids and code-made reasons. Every
// step is kept in the negotiation's history, so it can be replayed.
// Guards: the organizer's own mandate (an offer or accept whose share is over it is refused before the venue sees it),
// and a quota of negotiations per player, venue and day, so nobody can map a venue's schedule by asking over and over.
// When a deal is out of the budget, refused, or the court is gone, the answer carries alternatives nearby.
import crypto from "node:crypto";
import { store, stateFile } from "../store.js";
import { venue, player, freeCourts, forSport, SPORTS } from "../world.js";
import { price, askAt, cheaperTerms, usd } from "./policy.js";
import { alternatives, shareOf } from "../alternatives.js";
import { fits, getMandate } from "../mandate.js";
import { isDate, isTime, startOf, ymd } from "../time.js";

export const TTL_MS = 15 * 60e3;
export const QUOTA = 5; // negotiations per player, venue and day
const db = store(stateFile("negotiations"), { negotiations: [] });
export const negotiationsStore = db;
let clock = () => new Date();
export const setClock = (fn) => { clock = fn; };
// bookings.js hears about a deal the moment it is agreed
let onAgreed = null;
export const setOnAgreed = (fn) => { onAgreed = fn; };

const get = (id) => db.data.negotiations.find((n) => n.id === id);
const people = (ids) => ids.map(player).filter(Boolean);
const err = (code, message, extra = {}) => ({ error: code, message, ...extra });

function view(n, extra = {}) {
  const share = shareOf(n.ask, n.players.length);
  return {
    id: n.id, status: n.status, venue: n.venue, venueName: venue(n.venue)?.name, sport: n.sport, date: n.date, start: n.start, minutes: n.minutes,
    players: n.players, organizer: n.by, currency: "USD",
    list: usd(n.list), ask: usd(n.ask), share: usd(share), discounts: n.discounts,
    round: n.round, roundsLeft: Math.max(0, n.rounds - n.round), final: n.final,
    agreed: n.agreed ? { amount: usd(n.agreed.amount), share: usd(shareOf(n.agreed.amount, n.players.length)), at: n.agreed.at } : null,
    expiresAt: new Date(n.expiresAt).toISOString(), history: n.history.map((h) => ({ ...h, amount: h.amount != null ? usd(h.amount) : undefined })),
    ...extra,
  };
}

function alts(n, budgetShare) {
  return alternatives({ people: people(n.players), sport: n.sport, date: n.date, start: n.start, minutes: n.minutes, budgetShare, exclude: n.venue, from: venue(n.venue), now: clock() });
}

function expireIfDue(n) {
  if (n.status === "open" && clock().getTime() > n.expiresAt) { n.status = "expired"; n.history.push({ at: clock().toISOString(), by: "platform", type: "expire" }); db.save(); }
  return n;
}

export function open({ by, players = [], venue: venueId, sport, date, start, minutes = 90 }) {
  const now = clock(), v = venue(venueId), org = player(by);
  if (!org) return err("unknown_player", "No such player.");
  if (!v) return err("unknown_venue", "No such venue.");
  if (!SPORTS.includes(sport) || !forSport(v, sport)) return err("no_sport", `${v.name} has no ${sport} courts.`);
  if (!isDate(date) || !isTime(start)) return err("bad_time", "date is YYYY-MM-DD and start is HH:MM.");
  if (![60, 90, 120].includes(minutes)) return err("bad_length", "minutes is 60, 90 or 120.");
  if (startOf(date, start) <= now) return err("in_the_past", "That time has passed.");
  const ids = [...new Set([by, ...players])];
  if (ids.length > 12 || ids.some((id) => !player(id))) return err("bad_players", "players must be known player ids, 12 at most.");
  const day = ymd(now);
  const used = db.data.negotiations.filter((n) => n.by === by && n.venue === venueId && n.openedDay === day).length;
  if (used >= QUOTA) return err("quota", `${QUOTA} negotiations with this venue today already. Try another venue or tomorrow.`);
  const terms = { sport, date, start, minutes, players: ids.length };
  const budget = getMandate(by).perGame;
  if (!freeCourts(v.id, sport, date, start, minutes).length) {
    return err("no_court", `${v.name} has no free ${sport} court then.`, { alternatives: alternatives({ people: people(ids), ...terms, budgetShare: budget, exclude: v.id, from: v, now }) });
  }
  const q = price(v, terms, now);
  const n = {
    id: `neg_${crypto.randomBytes(6).toString("hex")}`, by, players: ids, venue: v.id, sport, date, start, minutes,
    list: q.list, ask0: q.ask, ask: q.ask, floor: q.floor, style: q.style, rounds: q.rounds, round: 0, final: q.style === "firm",
    discounts: q.discounts, status: "open", openedDay: day, expiresAt: now.getTime() + TTL_MS,
    history: [{ at: now.toISOString(), by: "venue", type: "ask", amount: q.ask }],
  };
  db.data.negotiations.push(n); db.save();
  const cheaper = cheaperTerms(v, terms, (t) => freeCourts(v.id, sport, date, t.start, minutes).length > 0, now).map((c) => ({ ...c, ask: usd(c.ask), saves: usd(c.saves) }));
  const share = shareOf(q.ask, ids.length);
  return view(n, { cheaper, ...(share > budget ? { overBudget: true, alternatives: alts(n, budget) } : {}) });
}

function agree(n, amount, who) {
  const now = clock();
  n.status = "agreed"; n.agreed = { amount, at: now.toISOString() };
  n.history.push({ at: now.toISOString(), by: who, type: "accept", amount });
  db.save();
  const deal = onAgreed ? onAgreed(n) : null;
  return view(n, deal ? { booking: deal } : {});
}

// the organizer's own limit, checked before the venue sees the offer
function overMandate(n, amount) {
  const share = shareOf(amount, n.players.length), f = fits(n.by, { venue: n.venue, share });
  return f.ok ? null : err("over_mandate", `Your agent can't commit you to that: ${f.why.join("; ")}.`, { negotiation: view(n), alternatives: alts(n, f.mandate.perGame) });
}

export function offer({ id, by, amount }) {
  const n = get(id);
  if (!n) return err("unknown_negotiation", "No such negotiation.");
  if (n.by !== by) return err("not_organizer", "Only the organizer's agent negotiates the price.");
  expireIfDue(n);
  if (n.status !== "open") return err("closed", `This negotiation is ${n.status}.`, { negotiation: view(n) });
  if (!Number.isInteger(amount) || amount <= 0) return err("bad_amount", "amount is the total for the court, in cents.");
  const over = overMandate(n, Math.min(amount, n.ask));
  if (over) return over;
  const now = clock().toISOString();
  n.history.push({ at: now, by: "organizer", type: "offer", amount });
  if (amount >= n.ask) return agree(n, n.ask, "venue");
  if (n.final) {
    n.status = "rejected"; n.history.push({ at: now, by: "venue", type: "reject" }); db.save();
    return view(n, { message: `${venue(n.venue).name} said its last price was $${usd(n.ask)}.`, alternatives: alts(n, getMandate(n.by).perGame) });
  }
  n.round += 1;
  // (the schedule runs from the opening ask, not from the last counter)
  const next = askAt({ ask: n.ask0, floor: n.floor, style: n.style, rounds: n.rounds }, n.round);
  if (amount >= next) return agree(n, amount, "venue");
  n.ask = next; n.final = n.round >= n.rounds || next === n.floor;
  n.history.push({ at: now, by: "venue", type: n.final ? "final" : "counter", amount: next });
  db.save();
  const budget = getMandate(n.by).perGame;
  return view(n, { message: n.final ? `Best and final: $${usd(next)}.` : `The venue counters at $${usd(next)}.`, ...(shareOf(next, n.players.length) > budget ? { overBudget: true, alternatives: alts(n, budget) } : {}) });
}

export function accept({ id, by }) {
  const n = get(id);
  if (!n) return err("unknown_negotiation", "No such negotiation.");
  if (n.by !== by) return err("not_organizer", "Only the organizer's agent accepts the price.");
  expireIfDue(n);
  if (n.status !== "open") return err("closed", `This negotiation is ${n.status}.`, { negotiation: view(n) });
  const over = overMandate(n, n.ask);
  if (over) return over;
  if (!freeCourts(n.venue, n.sport, n.date, n.start, n.minutes).length) {
    n.status = "rejected"; n.history.push({ at: clock().toISOString(), by: "platform", type: "court_gone" }); db.save();
    return err("no_court", "The court was taken meanwhile.", { negotiation: view(n), alternatives: alts(n, getMandate(n.by).perGame) });
  }
  return agree(n, n.ask, "organizer");
}

export function cancel({ id, by }) {
  const n = get(id);
  if (!n) return err("unknown_negotiation", "No such negotiation.");
  if (n.by !== by) return err("not_organizer", "Only the organizer's agent can walk away.");
  if (n.status === "open") { n.status = "cancelled"; n.history.push({ at: clock().toISOString(), by: "organizer", type: "walk_away" }); db.save(); }
  return view(n);
}

export function status({ id, by }) {
  const n = get(id);
  if (!n || !n.players.includes(by)) return err("unknown_negotiation", "No such negotiation.");
  return view(expireIfDue(n));
}

export const mine = (by) => db.data.negotiations.filter((n) => n.players.includes(by)).map((n) => view(expireIfDue(n)));
export const internal = get; // for bookings.js and tests (includes the floor; never send to an agent)

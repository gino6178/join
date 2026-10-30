// What an agent can do on Join, in one place: the MCP server, the REST API and the A2A endpoint all call these. Each
// takes the acting agent ({ player, client }) and plain arguments, checks them, does it, and writes what it did to the
// activity log in code-made words, so the people involved can see every step on the website.
// Money crosses as USD strings ("31.50") outward and integer cents inward.
import { getWorld, venue, player, freeUnits, forActivity, ACTIVITIES, activity as getActivity, unitName } from "./world.js";
import * as neg from "./negotiate/engine.js";
import { price, cents, usd } from "./negotiate/policy.js";
import { alternatives as alts, shareOf } from "./alternatives.js";
import { getMandate } from "./mandate.js";
import * as settle from "./pay/settle.js";
import { record } from "./activity.js";
import { trips } from "./geo.js";
import { DAYS, addDays, dateOf, freeAt, hm, isDate, isTime, toMin, windows, ymd, startOf } from "./time.js";

let clock = () => new Date();
export const setOpsClock = (fn) => { clock = fn; };
const first = (id) => player(id)?.name?.split(" ")[0] || id;
const by = (a) => ({ kind: "agent", player: a.player, client: a.client });
const toCents = (x) => (typeof x === "number" && Number.isFinite(x) && x > 0 && x < 10000 ? Math.round(x * 100) : null);
const said = (a) => `${first(a.player)}'s agent${a.client ? ` (${a.client})` : ""}`;

export function whoami(a) {
  const p = player(a.player), m = getMandate(a.player);
  return { player: { id: p.id, name: p.name, interests: p.interests, ...(p.level ? { sportsLevel: p.level } : {}), usuallyFree: p.free, area: p.area?.name },
    mandate: { perGame: usd(m.perGame), perWeek: usd(m.perWeek), venues: m.venues, autopay: m.autopay && settle.hasVault(a.player), note: "Set by the player on the website. Agents can read it, not change it." },
    paypal: { savedForAgent: settle.hasVault(a.player), mode: settle.paypalMode() }, client: a.client };
}

// What people can get together for, and what one booking of each holds
export const listActivities = () => ({ activities: getWorld().activities.map((x) => ({ id: x.id, name: x.name, kind: x.kind, books: `one ${x.unit} for ${x.min}-${x.max} people`, minutes: x.minutes })) });

export function listVenues({ activity } = {}) {
  const w = getWorld();
  return { currency: "USD", town: w.town.name, venues: w.venues.filter((v) => !activity || forActivity(v, activity)).map((v) => ({
    id: v.id, name: v.name, area: v.area, open: v.open, weekendOpen: v.weekendOpen || null,
    offers: Object.fromEntries(Object.keys(v.offers).map((k) => { const o = forActivity(v, k); return [k, { units: o.units, unit: o.unit, people: `${o.min}-${o.max}`, price: usd(cents(o.price)), per: o.per === "person" ? "person" : `${o.unit} per hour`, minutes: o.minutes }]; })),
    negotiates: { style: v.policy.style, maxCounterOffers: v.policy.style === "firm" ? 0 : v.policy.rounds, discounts: [`off-peak ${v.policy.offPeak.pct * 100}% (weekday bookings ending by ${v.policy.offPeak.before})`, `group ${v.policy.group.pct * 100}% (${v.policy.group.min}+ people)`, `last-minute ${v.policy.lastMinute.pct * 100}% (within ${v.policy.lastMinute.withinHours} h)`] },
  })), publicPlaces: (w.publicPlaces || []).filter((p) => !activity || p.activities.includes(activity)).map((p) => ({ id: p.id, name: p.name, activities: p.activities, lit: p.lit, bookable: false })) };
}

// Who is free and when, and the fair venue for each: the organizer's usual free times (or the window they give), the
// people interested in the activity who are free then, and the venue with a free unit whose longest trip is shortest.
export function findOptions(a, { activity = "badminton", dates = [], from = null, to = null, minutes = null, players = 3, with: want = [] } = {}) {
  const now = clock(), me = player(a.player), act = getActivity(activity);
  if (!act) return { error: "unknown_activity", message: `activity is one of ${ACTIVITIES().join(", ")}.` };
  minutes ??= act.minutes.includes(90) ? 90 : act.minutes[0];
  if (!act.minutes.includes(minutes)) return { error: "bad_length", message: `${activity} is booked for ${act.minutes.join(", ")} minutes.` };
  if (players + 1 < act.min || players + 1 > act.max) return { error: "group_size", message: `One ${act.unit} for ${activity} takes ${act.min} to ${act.max} people, you included.` };
  if ((from && !isTime(from)) || (to && !isTime(to)) || dates.some((d) => !isDate(d))) return { error: "bad_time", message: "dates are YYYY-MM-DD, from and to HH:MM." };
  const need = Math.max(1, Math.min(11, players | 0));
  const days = dates.length ? dates.slice(0, 7) : Array.from({ length: 7 }, (_, i) => addDays(ymd(now), i));
  const mine = windows(me.free), others = getWorld().players.filter((p) => p.id !== me.id && (p.interests || []).includes(activity));
  const opts = [];
  for (const d of days) {
    const date = dateOf(d);
    for (let s = from ? toMin(from) : 7 * 60; s + minutes <= (to ? toMin(to) : 22 * 60); s += 30) {
      if (startOf(d, hm(s)) <= new Date(now.getTime() + 60 * 60e3)) continue;
      if (!from && !freeAt(mine, date, s, minutes)) continue;
      const free = others.filter((p) => freeAt(windows(p.free), date, s, minutes))
        // (for a sport, players close to your level first; for anything else, everyone interested is as good)
        .map((p) => ({ p, score: (want.includes(p.id) ? 10 : 0) - (act.kind === "sport" ? Math.abs("CBA".indexOf(p.level) - "CBA".indexOf(me.level)) + (p.prefers && p.prefers !== "any" && p.prefers !== (need === 1 ? "singles" : "doubles") ? 1 : 0) : 0) }))
        .sort((x, y) => y.score - x.score);
      if (free.length < need) continue;
      const group = [me, ...free.slice(0, need).map((x) => x.p)];
      let best = null;
      for (const v of getWorld().venues) {
        if (!forActivity(v, activity) || !freeUnits(v.id, activity, d, hm(s), minutes).length) continue;
        const t = trips(group, v), q = price(v, { activity, date: d, start: hm(s), minutes, players: group.length }, now);
        if (!best || t.longest < best.longestTrip || (t.longest === best.longestTrip && q.ask < best.ask)) best = { venue: v.id, venueName: v.name, longestTrip: t.longest, trips: t.list, ask: q.ask, discounts: q.discounts.map((x) => x.kind) };
      }
      if (!best) continue;
      const asked = want.filter((id) => group.some((g) => g.id === id)).length;
      opts.push({ date: d, day: DAYS[date.getDay()], start: hm(s), minutes, players: group.map((g) => g.id), names: group.map((g) => g.name), alsoFree: free.slice(need, need + 3).map((x) => x.p.id),
        venue: best.venue, venueName: best.venueName, longestTrip: best.longestTrip, askPrice: usd(best.ask), share: usd(shareOf(best.ask, group.length)), discounts: best.discounts,
        score: asked * 5 - best.longestTrip * 0.2 - best.ask / 1000 - days.indexOf(d) * 0.3 });
    }
  }
  opts.sort((x, y) => y.score - x.score);
  const out = [];
  for (const o of opts) { if (out.length >= 5) break; if (out.some((x) => x.date === o.date && Math.abs(toMin(x.start) - toMin(o.start)) < 120)) continue; out.push(o); }
  record({ actor: by(a), who: [a.player], action: "searched", summary: `${said(a)} looked for ${activity} with ${need} other${need === 1 ? "" : "s"} over ${days.length} day${days.length > 1 ? "s" : ""}: ${out.length} option${out.length === 1 ? "" : "s"} found.` });
  return { options: out.map(({ score, ...o }) => o), mandate: { perGame: usd(getMandate(a.player).perGame) }, note: out.length ? "Prices are the venue's opening ask; negotiate with start_negotiation." : "Nothing fits. Try other days, a wider window or fewer players." };
}

export function startNegotiation(a, { venue: venueId, activity, date, start, minutes = 90, players = [] }) {
  const r = neg.open({ by: a.player, players, venue: venueId, activity, date, start, minutes });
  const v = venue(venueId);
  if (r.error) {
    record({ actor: by(a), who: [a.player], action: "negotiation_refused", summary: `${said(a)} asked ${v?.name || venueId} for ${activity} on ${date} ${start}: ${r.message}`, data: r.alternatives ? { alternatives: r.alternatives } : null });
    return r;
  }
  record({ actor: by(a), who: r.players, action: "negotiation_opened", ref: r.id, summary: `${said(a)} asked ${r.venueName} for a ${getActivity(r.activity).unit} for ${r.activity} on ${r.date} ${r.start} for ${r.players.map(first).join(", ")}. Venue asks $${r.ask} ($${r.share} each)${r.discounts.length ? `, with ${r.discounts.map((d) => d.kind).join(" + ")} discount` : ""}.`, data: { ask: r.ask, list: r.list, ...(r.overBudget ? { overBudget: true, alternatives: r.alternatives } : {}) } });
  return r;
}

export function makeOffer(a, { negotiation, amount }) {
  const c = toCents(amount);
  if (!c) return { error: "bad_amount", message: "amount is the total for the booking in USD, e.g. 30 or 31.5." };
  const r = neg.offer({ id: negotiation, by: a.player, amount: c });
  const n = r.error ? r.negotiation : r;
  if (n) record({ actor: by(a), who: n.players, action: r.error ? "offer_refused" : r.status === "agreed" ? "deal" : r.status === "rejected" ? "venue_rejected" : "venue_countered", ref: n.id,
    summary: r.error ? `${said(a)} offered $${usd(c)}: ${r.message}` : r.status === "agreed" ? `${said(a)} offered $${usd(c)}. ${n.venueName} agreed: $${n.agreed.amount}.` : r.status === "rejected" ? `${said(a)} offered $${usd(c)}. ${n.venueName} stood at $${n.ask}: no deal.` : `${said(a)} offered $${usd(c)}. ${n.venueName} countered $${n.ask}${n.final ? " (best and final)" : ""}.`,
    data: { offer: usd(c), ask: n.ask, ...(r.alternatives ? { alternatives: r.alternatives } : {}), ...(r.overBudget ? { overBudget: true } : {}) } });
  return r;
}

export function acceptPrice(a, { negotiation }) {
  const r = neg.accept({ id: negotiation, by: a.player });
  const n = r.error ? r.negotiation : r;
  if (n) record({ actor: by(a), who: n.players, action: r.error ? "accept_refused" : "deal", ref: n.id, summary: r.error ? `${said(a)} tried to accept $${n.ask}: ${r.message}` : `${said(a)} accepted ${n.venueName}'s $${n.agreed.amount}. Next: ${first(a.player)} guarantees the booking in PayPal.`, data: r.alternatives ? { alternatives: r.alternatives } : null });
  return r;
}

export function walkAway(a, { negotiation }) {
  const r = neg.cancel({ id: negotiation, by: a.player });
  if (!r.error) record({ actor: by(a), who: r.players, action: "walked_away", ref: r.id, summary: `${said(a)} walked away from ${r.venueName}.` });
  return r;
}

export function findAlternatives(a, { activity, date, start, minutes = 90, players = [], budget = null, exclude = null }) {
  if (!isDate(date) || !isTime(start)) return { error: "bad_time", message: "date is YYYY-MM-DD and start HH:MM." };
  const ids = [...new Set([a.player, ...players])].filter((id) => player(id));
  const share = budget != null ? toCents(budget) : getMandate(a.player).perGame;
  const list = alts({ people: ids.map(player), activity, date, start, minutes, budgetShare: share, exclude, from: exclude ? venue(exclude) : null, now: clock() });
  record({ actor: by(a), who: [a.player], action: "alternatives", summary: `${said(a)} looked for other places for ${activity} on ${date} around ${start}: ${list.length} found.`, data: { alternatives: list } });
  return { alternatives: list, budgetPerPerson: usd(share), ...(list.some((x) => x.withinBudget && x.venue !== exclude) ? {} : { note: `No other place offers ${activity} within $${usd(share)} a person then. Try another time or another activity the group shares (find_options).` }) };
}

export const myGames = (a, { all = false } = {}) => ({ negotiations: neg.mine(a.player, { all }), bookings: settle.mine(a.player, { all }), ...(all ? {} : { note: "Open negotiations and live bookings only; pass all: true for finished ones too." }) });
export const gameStatus = (a, { booking }) => settle.status(booking, a.player);

export async function payMyShare(a, { booking }) {
  const r = await settle.pay(booking, a.player);
  if (!r.error) record({ actor: by(a), who: [a.player], action: "pay_requested", ref: booking, summary: r.you?.status === "authorized" ? `${said(a)} paid ${first(a.player)}'s $${r.you.amount} from saved PayPal, within the limit.` : r.you?.approveUrl ? `${said(a)} asked ${first(a.player)} to approve $${r.you.amount} in PayPal.` : `${said(a)} checked the payment: ${r.you?.status || r.state}.` });
  return r.you?.approveUrl ? { ...r, nextStep: "PAYER_ACTION_REQUIRED: show approveUrl to your user. They approve in PayPal; check booking_status afterwards." } : r;
}
export const declineGame = (a, { booking }) => settle.decline(booking, a.player);
export function proposeShare(a, { booking, amount }) { const c = amount === 0 ? 0 : toCents(amount); return c === null ? { error: "bad_amount", message: "amount is your share in USD." } : settle.proposeShare(booking, a.player, c); }
export const requestReimbursement = (a, { booking, player: p }) => settle.requestReimbursement(booking, a.player, p);
export const answerShare = (a, { booking, player: p, accept }) => settle.answerShare(booking, a.player, p, accept === true);
export async function cancelBooking(a, { booking }) {
  const r = await settle.cancel(booking, a.player);
  if (r.error) record({ actor: by(a), who: [a.player], action: "cancel_refused", ref: booking, summary: `${said(a)} tried to cancel: ${r.message}` });
  return r;
}

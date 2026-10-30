// What an agent can do on Join, in one place: the MCP server, the REST API and the A2A endpoint all call these. Each
// takes the acting agent ({ player, client }) and plain arguments, checks them, does it, and writes what it did to the
// activity log in code-made words, so the people involved can see every step on the website.
// Money crosses as USD strings ("31.50") outward and integer cents inward.
import * as people from "./people.js";
import { forPlayer, onActivity } from "./activity.js";
import { personLink } from "./auth.js";
import { getWorld, venue, player, freeUnits, forActivity, ACTIVITIES, activity as getActivity, unitName } from "./world.js";
import * as neg from "./negotiate/engine.js";
import { price, cents, usd } from "./negotiate/policy.js";
import { alternatives as alts, shareOf } from "./alternatives.js";
import { getMandate, coverFits } from "./mandate.js";
import * as settle from "./pay/settle.js";
import * as ap2 from "./proof/mandates.js";
import * as reviews from "./reviews.js";
import { tokenKey } from "./auth.js";
import { record } from "./activity.js";
import { trips } from "./geo.js";
import { DAYS, addDays, dateOf, freeAt, hm, isDate, isTime, toMin, windows, ymd, startOf } from "./time.js";

let clock = () => new Date();
export const setOpsClock = (fn) => { clock = fn; };
const first = (id) => player(id)?.name?.split(" ")[0] || id;
const by = (a) => ({ kind: "agent", player: a.player, client: a.client });
const toCents = (x) => { const n = typeof x === "string" && /^\s*\$?\d+(\.\d+)?\s*$/.test(x) ? +x.replace(/[$\s]/g, "") : x; return typeof n === "number" && Number.isFinite(n) && n > 0 && n < 10000 ? Math.round(n * 100) : null; }; // (a number, or a string like "30.50")
const said = (a) => `${first(a.player)}'s agent${a.client ? ` (${a.client})` : ""}`;

// The agent's AP2 open mandates (what the person let it book and pay), signed by Join; made again whenever the person
// changes their limits on the website
export function openMandates(a) {
  const kid = a.token || "website-agent", m = getMandate(a.player), cur = ap2.openFor(a.player, kid);
  if (cur && cur.limits === (m.rev || 0)) return cur; // (the limits haven't changed since it was made)
  const w = getWorld();
  return ap2.issueOpen(a.player, kid, m, w.venues, w.activities, a.token ? tokenKey(a.token) : null);
}

export function whoami(a) {
  const p = player(a.player), m = getMandate(a.player);
  const w = getWorld();
  return { town: { name: w.town.name, timeZone: w.town.timeZone, currency: w.currency || "USD", now: new Date().toLocaleString("sv-SE", { timeZone: w.town.timeZone }).slice(0, 16), note: "Every date and time on Join is the town's local time; every price is in USD." },
    ...(a.pass ? { yourPersonsLink: { path: `/me/${personLink(a.pass)}`, note: "Give this to your person: it signs them in on Join's website (same host) to see plans and set their limits. Keep it private: it isn't your pass, but it signs them in." } } : {}),
    ...(p.crew ? { crew: { code: p.crew, invite: `/j/${p.crew}`, members: people.crewmates(p).map((x) => ({ id: x.id, name: x.name, area: x.area?.name })), note: "Your person's friends who joined Join with the same crew code. find_options invites them first; each answers an invitation through their own agent." } } : {}),
    player: { id: p.id, name: p.name, interests: p.interests, ...(p.level ? { sportsLevel: p.level } : {}), usuallyFree: p.free, area: p.area?.name },
    mandate: { perGame: usd(m.perGame), perWeek: usd(m.perWeek), guaranteeOnItsOwn: usd(m.cover), venues: m.venues, autopay: m.autopay && settle.hasVault(a.player), note: "Set by the player on the website. Agents can read it, not change it." },
    paypal: { savedForAgent: settle.hasVault(a.player), mode: settle.paypalMode() }, client: a.client,
    ap2: { about: "AP2 open mandates (Trusted Agent Provider model): what your user let you book and pay, signed by Join, bound to your token id (cnf.kid). Present them to any verifier that asks.", ...(({ checkout, payment }) => ({ openCheckoutMandate: checkout, openPaymentMandate: payment }))(openMandates(a)) } };
}

// What people can get together for, and what one booking of each holds
export const listActivities = () => ({ activities: getWorld().activities.map((x) => ({ id: x.id, name: x.name, kind: x.kind, books: `one ${x.unit} for ${x.min}-${x.max} people`, minutes: x.minutes })) });

export function listVenues({ activity } = {}) {
  const w = getWorld();
  return { currency: "USD", town: w.town.name, venues: w.venues.filter((v) => !activity || forActivity(v, activity)).map((v) => ({
    id: v.id, name: v.name, area: v.area, open: v.open, weekendOpen: v.weekendOpen || v.open, // (the same hours at weekends unless the venue has its own)
    offers: Object.fromEntries(Object.keys(v.offers).map((k) => { const o = forActivity(v, k); return [k, { units: o.units, unit: o.unit, people: `${o.min}-${o.max}`, price: usd(cents(o.price)), per: o.per === "person" ? "person" : `${o.unit} per hour`, minutes: o.minutes }]; })),
    reviews: (({ score, count, praise, complaints, demoData }) => ({ score, count, liked: praise.map((p) => p.label), complaints: complaints.map((p) => p.label), demoData: demoData > 0 }))(reviews.summary(v.id, { activity })),
    negotiates: { style: v.policy.style, maxCounterOffers: v.policy.style === "firm" ? 0 : v.policy.rounds, discounts: [`off-peak ${v.policy.offPeak.pct * 100}% (weekday bookings ending by ${v.policy.offPeak.before})`, `group ${v.policy.group.pct * 100}% (${v.policy.group.min}+ people)`, `last-minute ${v.policy.lastMinute.pct * 100}% (within ${v.policy.lastMinute.withinHours} h)`] },
  })), publicPlaces: (w.publicPlaces || []).filter((p) => !activity || p.activities.includes(activity)).map((p) => ({ id: p.id, name: p.name, activities: p.activities, lit: p.lit, bookable: false })) };
}

// Who is free and when, and the fair venue for each: the organizer's usual free times (or the window they give), the
// people interested in the activity who are free then, and the venue with a free unit whose longest trip is shortest.
// What the person wants, beyond time and price, to rank venues by: near (trips count double, and none longer than
// maxTrip minutes for anyone), cheap (price counts triple), aspects they care about from the reviews' fixed list
// (clean, quiet, staff, value, equipment, space, access, ontime, food, atmosphere: a venue praised for one moves up,
// one complained about moves down). Each option then says how it meets them (fits).
function wishes(prefer) {
  const p = prefer && typeof prefer === "object" ? prefer : {};
  return { near: !!p.near, cheap: !!p.cheap, maxTrip: Number.isFinite(+p.maxTrip) && +p.maxTrip > 0 ? +p.maxTrip : null, aspects: (Array.isArray(p.aspects) ? p.aspects : []).filter((k) => k in reviews.ASPECTS).slice(0, 4) };
}
// how a venue meets each wish, in words, from the facts: trips, the share, and the reviews' counts both ways
function fitsOf(wish, v, people) {
  return [
    ...(wish.near || wish.maxTrip ? [`${v.myTrip ?? v.longestTrip} min for you, ${v.longestTrip} at most for anyone`] : []),
    ...(wish.cheap ? [`$${usd(shareOf(v.ask, people))} each`] : []),
    ...wish.aspects.map((k) => {
      const n = v.reviews.aspectCounts?.[k] || { liked: 0, disliked: 0 };
      if (!n.liked && !n.disliked) return `no reviews say either way about ${reviews.ASPECTS[k]}`;
      return [n.liked ? `${n.liked} review${n.liked === 1 ? "" : "s"} praise ${reviews.ASPECTS[k]}` : "", n.disliked ? `${n.disliked} complain "${reviews.COMPLAINTS[k]}"` : ""].filter(Boolean).join(", ");
    }),
  ];
}
function wishCost(wish, rv) {
  let c = 0;
  for (const k of wish.aspects) { const n = rv.aspectCounts?.[k], all = rv.count || 1; if (!n) continue; c -= Math.min(12, (n.liked / all) * 24); c += Math.min(12, (n.disliked / all) * 30); }
  return c;
}
export function findOptions(a, { activity = "badminton", date = null, dates = [], from = null, to = null, minutes = null, players = 3, people = null, with: want = [], prefer = null } = {}) {
  const wish = wishes(prefer);
  if (Number.isInteger(people) && people >= 1) players = people - 1; // ("people" is the whole group, your user included)
  if (date && !dates.length) dates = [date];
  const now = clock(), me = player(a.player), act = getActivity(activity);
  if (!act) return { error: "unknown_activity", message: `activity is one of ${ACTIVITIES().join(", ")}.` };
  minutes ??= act.minutes.includes(90) ? 90 : act.minutes[0];
  if (!act.minutes.includes(minutes)) return { error: "bad_length", message: `${activity} is booked for ${act.minutes.join(", ")} minutes.` };
  if (players + 1 < act.min || players + 1 > act.max) return { error: "group_size", message: `One ${act.unit} for ${activity} takes ${act.min} to ${act.max} people, your user included. "players" counts only the others (${act.min - 1} to ${act.max - 1}); or pass "people" for the whole group.` };
  if ((from && !isTime(from)) || (to && !isTime(to)) || dates.some((d) => !isDate(d))) return { error: "bad_time", message: "dates are YYYY-MM-DD, from and to HH:MM." };
  const need = Math.max(1, Math.min(11, players | 0));
  const days = dates.length ? dates.slice(0, 7) : Array.from({ length: 7 }, (_, i) => addDays(ymd(now), i));
  const mine = windows(me.free), crew = me.crew ? me.crew : null, others = getWorld().players.filter((p) => p.id !== me.id && (want.includes(p.id) || (crew && p.crew === crew) || (!p.joined && (p.interests || []).includes(activity)))); // (people who joined Join themselves: your crewmates, or anyone you name)
  const opts = [];
  for (const d of days) {
    const date = dateOf(d);
    for (let s = from ? toMin(from) : 7 * 60; s + minutes <= (to ? toMin(to) : 22 * 60); s += 30) {
      if (startOf(d, hm(s)) <= new Date(now.getTime() + 60 * 60e3)) continue;
      if (!from && !freeAt(mine, date, s, minutes)) continue;
      const free = others.filter((p) => freeAt(windows(p.free), date, s, minutes))
        // (for a sport, players close to your level first; for anything else, everyone interested is as good)
        .map((p) => ({ p, score: (want.includes(p.id) ? 10 : 0) + (crew && p.crew === crew ? 6 : 0) - (act.kind === "sport" ? Math.abs("CBA".indexOf(p.level) - "CBA".indexOf(me.level)) + (p.prefers && p.prefers !== "any" && p.prefers !== (need === 1 ? "singles" : "doubles") ? 1 : 0) : 0) }))
        .sort((x, y) => y.score - x.score);
      if (free.length < need) continue;
      const group = [me, ...free.slice(0, need).map((x) => x.p)];
      // the venue for this slot: the shortest longest trip, moved by what verified reviews say (a star above the town's
      // average is worth 8 minutes; anyone in the group who rated it 2★ or less costs 30), then the price
      let best = null; const seen = [];
      for (const v of getWorld().venues) {
        if (!forActivity(v, activity) || !freeUnits(v.id, activity, d, hm(s), minutes).length) continue;
        const t = trips(group, v), q = price(v, { activity, date: d, start: hm(s), minutes, players: group.length }, now);
        if (wish.maxTrip && t.longest > wish.maxTrip) continue;
        const rv = reviewsFor(v.id, activity, group.map((g) => g.id), a.player), cost = t.longest * (wish.near ? 2 : 1) + reviews.rankAdjust(rv) + (q.ask / group.length / 100) * (wish.cheap ? 3 : 1) + wishCost(wish, rv);
        const cand = { cost, venue: v.id, venueName: v.name, longestTrip: t.longest, myTrip: t.list.find((x) => x.id === me.id)?.min ?? null, trips: t.list, ask: q.ask, discounts: q.discounts.map((x) => x.kind), reviews: rv };
        seen.push(cand);
        if (!best || cost < best.cost) best = cand;
      }
      if (!best) continue;
      const asked = want.filter((id) => group.some((g) => g.id === id)).length;
      opts.push({ date: d, day: DAYS[date.getDay()], start: hm(s), minutes, players: group.map((g) => g.id), names: group.map((g) => g.name), alsoFree: free.slice(need, need + 3).map((x) => x.p.id),
        venue: best.venue, venueName: best.venueName, longestTrip: best.longestTrip, askPrice: usd(best.ask), share: usd(shareOf(best.ask, group.length)), discounts: best.discounts,
        reviews: { score: best.reviews.score, count: best.reviews.count, praise: best.reviews.praise.map((p) => p.aspect), complaints: best.reviews.complaints.map((p) => p.about), groupLow: best.reviews.groupLow, tasteNotes: best.reviews.tasteNotes, demoData: best.reviews.demoData > 0, reason: reviews.reason(best.reviews) },
        fits: fitsOf(wish, best, group.length),
        ...(seen.length > 1 ? { alsoConsidered: seen.filter((x) => x !== best).sort((x, y) => x.cost - y.cost).slice(0, 2).map((x) => ({ venue: x.venue, venueName: x.venueName, longestTrip: x.longestTrip, share: usd(shareOf(x.ask, group.length)), score: x.reviews.score, ...(wish.near || wish.cheap || wish.maxTrip || wish.aspects.length ? { fits: fitsOf(wish, x, group.length) } : {}) })) } : {}),
        score: asked * 5 - best.longestTrip * (wish.near ? 0.6 : 0.2) - (best.ask / 1000) * (wish.cheap ? 3 : 1) - days.indexOf(d) * 0.3 - wishCost(wish, best.reviews) * 0.05 });
    }
  }
  opts.sort((x, y) => y.score - x.score);
  const out = [];
  for (const o of opts) { if (out.length >= 5) break; if (out.some((x) => x.date === o.date && Math.abs(toMin(x.start) - toMin(o.start)) < 120)) continue; out.push(o); }
  record({ actor: by(a), who: [a.player], action: "searched", data: { activity, area: me.area?.name || null, wish }, summary: `${said(a)} looked for ${activity} for ${need + 1} people${days.length === 1 ? ` on ${days[0]}` : ` over ${days.length} days`}: ${out.length ? `${out.length} option${out.length === 1 ? "" : "s"}` : "nothing free"}.` });
  // what the organizer may still commit to for each option: their per-booking limit, or what's left of that week's
  const m = getMandate(a.player), canSpend = (o) => Math.max(0, Math.min(m.perGame, m.perWeek - settle.spentInWeek(a.player, o.date, o.start)));
  return { ...(wish.near || wish.cheap || wish.maxTrip || wish.aspects.length ? { rankedBy: wish } : {}), options: out.map(({ score, ...o }) => ({ ...o, ...(o.fits.length ? {} : { fits: undefined }), youCanSpend: usd(canSpend(o)) })), mandate: { perGame: usd(m.perGame), perWeek: usd(m.perWeek) }, note: out.length ? "Prices are the venue's opening ask; negotiate with start_negotiation." : "Nothing fits. Try other days, a wider window or fewer players." };
}

// What accepting means for the organizer, on every reply they get about an open or agreed negotiation: they guarantee
// the whole price until the others pay, pay their own share unless someone doesn't, and at most the whole price.
function withTerms(a, r) {
  const n = r?.error ? r.negotiation : r;
  if (!n || n.organizer !== a.player || !["open", "agreed"].includes(n.status)) return r;
  const terms = settle.guaranteeTerms(a.player, { total: cents(n.agreed?.amount ?? n.ask), players: n.players, venue: n.venue, date: n.date, start: n.start }, { mayPay: mayPay(a) });
  return { ...r, [n.status === "agreed" ? "youGuarantee" : "ifYouAccept"]: terms };
}
// AP2: when Join refuses an action under the person's limits, the agent gets Join's signed Mandate Receipt saying so
const withRefusal = (a, r) => (r?.error === "over_mandate" ? { ...r, ap2Receipt: ap2.mandateReceipt(openMandates(a).payment, { ok: false, error: "invalid_mandate", why: r.message }) } : r);
// the organizer's share of the agreed price (the remainder of an even split)
const organizerShare = (n) => usd(ownShare(cents(n.agreed.amount), n.players.length));

// what verified reviews say about a venue, for this group (cached per call of find_options)
const reviewsFor = (venueId, activity, group, viewer) => reviews.summary(venueId, { activity, group, viewer });

// Verified reviews of a venue: the score (a recency-weighted Bayesian average), what people liked and complained about
// (counted from a fixed list of aspects), anyone in the group who rated it low, and the latest few as quotes
export function venueReviews(a, { venue: venueId, activity = null, players = [] } = {}) {
  if (!venue(venueId)) return { error: "unknown_venue", message: "No such venue (list_venues)." };
  const s = reviews.summary(venueId, { activity, group: [a.player, ...players], viewer: a.player });
  return { ...s, venueName: venue(venueId).name, reason: reviews.reason(s), about: "Only people who booked and paid on Join can review; agents can read reviews, never write them. Score: a recency-weighted Bayesian average. Seed reviews in the demo town are demo data." };
}

export function startNegotiation(a, { venue: venueId, activity, date, start, minutes = 90, players = [] }) {
  openMandates(a);
  const r = neg.open({ by: a.player, players, venue: venueId, activity, date, start, minutes, agentKid: a.token || "website-agent" });
  const v = venue(venueId);
  if (r.error) {
    record({ actor: by(a), who: [a.player], action: "negotiation_refused", summary: v && activity && date && start ? `${said(a)} asked ${v.name} for ${activity} on ${date} ${start}: ${r.message}` : `${said(a)} tried to open a negotiation: ${r.message}`, data: r.alternatives ? { alternatives: r.alternatives } : null });
    return r;
  }
  record({ actor: by(a), who: r.players, action: "negotiation_opened", ref: r.id, summary: `${said(a)} asked ${r.venueName} for a ${getActivity(r.activity).unit} for ${r.activity} on ${r.date} ${r.start} for ${r.players.map(first).join(", ")}. Venue asks $${r.ask} ($${r.share} each)${r.discounts.length ? `, with ${r.discounts.map((d) => d.kind).join(" + ")} discount` : ""}.`, data: { ask: r.ask, list: r.list, ...(r.overBudget ? { overBudget: true, alternatives: r.alternatives } : {}) } });
  return withTerms(a, r);
}

// An agent's AP2 open payment mandate, presented with an action that can commit money, checked before the action
// (mandates.authorize). A person acting on the website themselves (no token) presents none.
function mandateCheck(a, presented, { venue: venueId, share, authorized = share, date, start, booking = null }) {
  if (!a.token) return null;
  openMandates(a); // (made again first if the person changed a limit, so a stale one is refused)
  const r = ap2.authorize(presented, { player: a.player, agentKid: a.token, venue: venueId, share, authorized, spentThisWeek: settle.spentInWeek(a.player, date, start, booking) }); // (a booking being paid isn't counted twice)
  if (r.ok) return null;
  record({ actor: by(a), who: [a.player], action: "mandate_refused", summary: `${said(a)} was refused: ${r.message}` });
  return { error: r.error, message: r.message, ...(r.receipt ? { ap2Receipt: r.receipt } : {}) };
}
// whether this caller may start a payment: the person on the website (or Join's website agent, in their session), or an
// agent token with the pay scope
const mayPay = (a) => !a.scopes || a.scopes.includes("pay");
const ownShare = (total, k) => total - Math.floor(total / k) * (k - 1);

// For agents: a deal's reply after the guarantee it triggered has started, with the booking as it now stands
export async function afterDeal(a, r) {
  const id = r?.booking?.id;
  if (!id) return r;
  await settle.settled(id);
  return { ...r, booking: settle.status(id, a.player) || r.booking };
}
export function makeOffer(a, { negotiation, amount, mandate }) {
  const c = toCents(amount);
  if (!c) return { error: "bad_amount", message: "amount is the total for the booking in USD as a number, e.g. 30 or 31.5 (not the per-person share)." };
  const cur = neg.status({ id: negotiation, by: a.player });
  if (!cur.error) { const no = mandateCheck(a, mandate, { venue: cur.venue, share: ownShare(Math.min(c, cents(cur.ask)), cur.players.length), date: cur.date, start: cur.start }); if (no) return no; }
  const r = settle.deferGuarantee(!mayPay(a), () => neg.offer({ id: negotiation, by: a.player, amount: c }));
  const n = r.error ? r.negotiation : r;
  if (n) record({ actor: by(a), who: n.players, action: r.error ? "offer_refused" : r.status === "agreed" ? "deal" : r.status === "rejected" ? "venue_rejected" : "venue_countered", ref: n.id,
    summary: r.error ? `${said(a)} offered $${usd(c)}: ${r.message}` : r.status === "agreed" ? `${said(a)} offered $${usd(c)}. ${n.venueName} agreed: $${n.agreed.amount}. ${first(a.player)} guarantees it in PayPal until the others pay; own share $${organizerShare(n)}, at most $${n.agreed.amount}.` : r.status === "rejected" ? `${said(a)} offered $${usd(c)}. ${n.venueName} stood at $${n.ask}: no deal.` : `${said(a)} offered $${usd(c)}. ${n.venueName} countered $${n.ask}${n.final ? " (best and final)" : ""}.`,
    data: { offer: usd(c), ask: n.ask, ...(r.alternatives ? { alternatives: r.alternatives } : {}), ...(r.overBudget ? { overBudget: true } : {}) } });
  return withTerms(a, withRefusal(a, r));
}

export function acceptPrice(a, { negotiation, mandate }) {
  const cur = neg.status({ id: negotiation, by: a.player });
  if (!cur.error) { const no = mandateCheck(a, mandate, { venue: cur.venue, share: ownShare(cents(cur.ask), cur.players.length), date: cur.date, start: cur.start }); if (no) return no; }
  const r = settle.deferGuarantee(!mayPay(a), () => neg.accept({ id: negotiation, by: a.player }));
  const n = r.error ? r.negotiation : r;
  if (n) record({ actor: by(a), who: n.players, action: r.error ? "accept_refused" : "deal", ref: n.id, summary: r.error ? `${said(a)} tried to accept $${n.ask}: ${r.message}` : `${said(a)} accepted ${n.venueName}'s $${n.agreed.amount}. Next: ${first(a.player)} guarantees the whole $${n.agreed.amount} in PayPal until the others pay; ${first(a.player)}'s own share is $${organizerShare(n)}, and at most $${n.agreed.amount} if nobody else pays.`, data: r.alternatives ? { alternatives: r.alternatives } : null });
  return withTerms(a, withRefusal(a, r));
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
  record({ actor: by(a), who: [a.player], action: "alternatives", summary: list.length ? `${said(a)} compared ${list.length} other place${list.length === 1 ? "" : "s"} for ${activity} on ${date} around ${start}.` : `${said(a)} checked for other places for ${activity} on ${date} around ${start}; none is free then, so it stayed with this one.`, data: { alternatives: list } });
  return { alternatives: list, budgetPerPerson: usd(share), ...(list.some((x) => x.withinBudget && x.venue !== exclude) ? {} : { note: `No other place offers ${activity} within $${usd(share)} a person then. Try another time or another activity the group shares (find_options).` }) };
}

// News for a person, as it happens: their activity entries after `after`, waiting up to `seconds` for the first one
export async function waitForNews(a, { after = 0, seconds = 45 } = {}) {
  const pick = () => forPlayer(a.player, { after, limit: 20 }).map((e) => ({ id: e.id, at: e.at, action: e.action, ref: e.ref, summary: e.summary }));
  let news = pick();
  if (!news.length) await new Promise((ok) => { const t = setTimeout(done, Math.min(50, Math.max(1, seconds)) * 1000); const off = onActivity((e) => e.who.includes(a.player) && e.id > after && done()); function done() { clearTimeout(t); off(); ok(); } });
  news = news.length ? news : pick();
  return { news, last: news.length ? news.at(-1).id : after, note: news.length ? "Call again with after: last for what comes next." : "Nothing new yet; call again with the same after." };
}
export const myGames = (a, { all = false } = {}) => ({ negotiations: neg.mine(a.player, { all }), bookings: settle.mine(a.player, { all }), ...(all ? {} : { note: "Open negotiations and live bookings only; pass all: true for finished ones too." }) });
export const gameStatus = (a, { booking }) => settle.status(booking, a.player);

export async function payMyShare(a, { booking, mandate, amount = null }) {
  let b0 = settle.status(booking, a.player);
  // amount, if given, must be what is being paid: the share as it stands, or the full share from before an accepted ask
  // to pay less (which puts that ask back). Never silently something else.
  if (amount != null && !b0.error) {
    const want = toCents(amount), mine = Math.round(+(b0.payments?.[a.player]?.share ?? b0.invite?.share ?? 0) * 100);
    const asked = (b0.shareAsks || []).find((x) => x.player === a.player && x.status === "accepted");
    if (want === mine) {} // (as it stands)
    else if (asked && want === Math.round(+asked.from * 100)) { const w = settle.withdrawShareAsk(booking, a.player); if (w.error) return w; b0 = settle.status(booking, a.player); }
    else return { error: "bad_amount", message: `Your share is $${usd(mine)}${asked ? ` (or $${asked.from}, your share before your ask to pay less, which puts the difference back on you)` : ""}; pay_my_share pays that, so leave amount out or pass it exactly.` };
  }
  if (!b0.error && b0.payments?.[a.player]) {
    // (an organizer paying from saved PayPal authorizes the whole price; above `cover`, they approve it in PayPal themselves)
    const p = b0.payments[a.player], total = Math.round(+b0.total * 100), self = p.role === "organizer" && settle.hasVault(a.player) && coverFits(a.player, total);
    const no = mandateCheck(a, mandate, { venue: b0.venue, share: Math.round(+p.share * 100), authorized: self ? total : Math.round(+p.share * 100), date: b0.date, start: b0.start, booking }); if (no) return no;
  }
  const r = await settle.pay(booking, a.player);
  if (!r.error) record({ actor: by(a), who: [a.player], action: "pay_requested", ref: booking, summary: r.you?.status === "authorized" ? (r.you.via === "vault" ? `${said(a)} paid ${first(a.player)}'s $${r.you.authorized} from saved PayPal, within the limit.` : `${said(a)} started ${first(a.player)}'s $${r.you.authorized} payment; PayPal authorized it (${r.you.via}).`) : r.you?.approveUrl ? `${said(a)} asked ${first(a.player)} to approve $${r.you.authorized} in PayPal.` : `${said(a)} checked the payment: ${r.you?.status || r.state}.` });
  const when = "The booking locks when everyone invited has paid, or at payBy (whoever hasn't paid by then is covered by the organizer); nothing is captured before it locks.";
  return r.you?.approveUrl ? { ...r, nextStep: `PAYER_ACTION_REQUIRED: show approveUrl to your user. They approve in PayPal; check booking_status afterwards. ${when}` } : r.error ? r : { ...r, nextStep: when };
}
export const declineGame = (a, { booking }) => settle.decline(booking, a.player);
export function proposeShare(a, { booking, amount }) { const c = amount === 0 ? 0 : toCents(amount); return c === null ? { error: "bad_amount", message: "amount is your share in USD." } : settle.proposeShare(booking, a.player, c); }
export const requestReimbursement = (a, { booking, player: p }) => settle.requestReimbursement(booking, a.player, p);
// Agreeing that a friend pays less moves the difference onto the organizer, so it carries the mandate like a payment
export function answerShare(a, { booking, player: p, accept, mandate }) {
  if (accept === true) {
    const b0 = settle.status(booking, a.player), ask = (b0.shareAsks || []).find((x) => x.player === p && x.status === "pending");
    if (!b0.error && ask) { const mine = Math.round(+b0.payments[a.player].share * 100) + Math.round((+ask.from - +ask.amount) * 100); const no = mandateCheck(a, mandate, { venue: b0.venue, share: mine, date: b0.date, start: b0.start, booking }); if (no) return no; }
  }
  return settle.answerShare(booking, a.player, p, accept === true);
}
export async function cancelBooking(a, { booking }) {
  const r = await settle.cancel(booking, a.player);
  if (r.error) record({ actor: by(a), who: [a.player], action: "cancel_refused", ref: booking, summary: `${said(a)} tried to cancel: ${r.message}` });
  return r;
}

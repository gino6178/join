// Settling a deal with PayPal: from the moment the organizer's agent and the venue agree a price, to the venue being
// paid after the game. One booking per deal; each player pays their own share with their own PayPal.
//
//   awaiting_organizer  The court, room or table is held for ORGANIZER_MS while the organizer authorizes the WHOLE price (an order with
//                       intent AUTHORIZE). Nothing else happens until they do, so nobody can hold a place for free.
//   held                The organizer's authorization guarantees the booking. Every other player is invited, for
//                       SHARES_MS: their agent (or they, on the website) joins or declines. Nothing is started for
//                       anyone who hasn't said yes. Joining starts their share: a player who saved PayPal (Vault) and
//                       whose mandate covers the share is authorized by their agent at once; everyone else approves in
//                       PayPal.
//   locked              Everyone authorized, or the time ran out: each share is captured, and the rest of the price is
//                       captured from the organizer's authorization (they cover whoever didn't pay). The place is the
//                       group's. Until CANCEL_BEFORE_MS before the game it can still be cancelled with full refunds.
//   played              The game's end has passed.
//   venue_paid          The venue was sent what PayPal left after fees (Payouts). Paying after the game, not before,
//                       keeps refunds possible while the game can still be cancelled.
//   released / cancelled / refunded   The place went back to the venue; nothing was charged, or everything refunded.
//
// The state moves on three signals, any of which is enough: the payer coming back to the return URL, polling the
// order (tick), and PayPal's webhooks. Each PayPal POST is written to the booking's journal before it is made and
// carries a PayPal-Request-Id made from the booking and the step, so doing a step again after a crash repeats the same
// call instead of making a second one.
import crypto from "node:crypto";
import { store, stateFile } from "../store.js";
import { setTaken, venue, player, freeUnits, unitName } from "../world.js";
// "room 3" (or "Room 3" to start a sentence)
const place = (b, cap = false) => { const t = unitName(b.activity, b.unit); return cap ? t[0].toUpperCase() + t.slice(1) : t; };
import { setOnAgreed, internal as negotiation } from "../negotiate/engine.js";
import * as receipts from "../proof/receipts.js";
import * as toolkit from "./toolkit.js";
import { getMandate, fits } from "../mandate.js";
import { record } from "../activity.js";
import { startOf, toMin, hm } from "../time.js";
import { usd } from "../negotiate/policy.js";

export const ORGANIZER_MS = 10 * 60e3;
export const SHARES_MS = 20 * 60e3;
export const CANCEL_BEFORE_MS = 24 * 3600e3;
const LIVE = ["awaiting_organizer", "held", "locking", "locked", "played", "venue_paid"];

const db = store(stateFile("bookings"), { bookings: [], vaults: {}, setups: {} });
export const bookingsStore = db;
let pp = null, clock = () => new Date(), publicUrl = "http://localhost:8790";
export function configure({ paypal, now, url } = {}) { if (paypal) pp = paypal; if (now) clock = now; if (url) publicUrl = url; }
export const paypalMode = () => pp?.mode || "none";

const get = (id) => db.data.bookings.find((b) => b.id === id);
const name = (id) => player(id)?.name?.split(" ")[0] || id;
const at = () => clock().toISOString();
// one thing at a time per booking: a webhook and a poll arriving together don't both capture
const chains = new Map();
const serial = (id, fn) => { const p = (chains.get(id) || Promise.resolve()).then(fn, fn); chains.set(id, p.catch(() => {})); return p; };

// the units (courts, rooms, tables) this platform holds, so the venue adapter doesn't offer them again
setTaken(() => db.data.bookings.filter((b) => LIVE.includes(b.state)).map((b) => ({ venue: b.venue, activity: b.activity, date: b.date, from: toMin(b.start), to: toMin(b.start) + b.minutes, unit: b.unit })));

export function split(total, ids, organizer) {
  const each = Math.floor(total / ids.length), out = {};
  for (const id of ids) out[id] = each;
  out[organizer] = total - each * (ids.length - 1);
  return out;
}

function journal(b, step, status, data = null) { b.journal.push({ at: at(), step, status, ...(data ? { data } : {}) }); db.save(); }
async function paypalStep(b, step, fn) {
  journal(b, step, "started");
  try { const r = await fn(`${b.id}:${step}`); journal(b, step, "done", r); return r; }
  catch (e) { journal(b, step, "failed", { message: e.message }); throw e; }
}
const note = (b, actor, action, summary, data = null) => record({ actor, who: b.players, action, summary, ref: b.id, data });

// ---- from a deal to a booking -----------------------------------------------------------------------------------
setOnAgreed((n) => {
  const now = clock(), unit = freeUnits(n.venue, n.activity, n.date, n.start, n.minutes)[0];
  if (!unit) return { error: "none_free" };
  const b = {
    id: `bk_${crypto.randomBytes(6).toString("hex")}`, negotiation: n.id, venue: n.venue, activity: n.activity, date: n.date, start: n.start, minutes: n.minutes, unit,
    total: n.agreed.amount, players: n.players, organizer: n.by, shares: split(n.agreed.amount, n.players, n.by),
    state: "awaiting_organizer", created: now.toISOString(), organizerUntil: now.getTime() + ORGANIZER_MS, holdUntil: null,
    payments: {}, declined: [], payout: null, journal: [], paypalMode: paypalMode(),
  };
  db.data.bookings.push(b); db.save();
  note(b, { kind: "venue", venue: b.venue }, "place_held", `${venue(b.venue).name} holds ${unitName(b.activity, unit)} for ${ORGANIZER_MS / 60e3} minutes while ${name(b.organizer)} authorizes $${usd(b.total)} with PayPal.`);
  serial(b.id, () => startPayment(b, b.organizer, b.total, "organizer")).catch(() => {});
  return { id: b.id, state: b.state };
});

async function startPayment(b, playerId, amount, role) {
  if (b.payments[playerId]) return b.payments[playerId];
  const v = venue(b.venue), vault = db.data.vaults[playerId], m = getMandate(playerId);
  const f = fits(playerId, { venue: b.venue, share: amount, spentThisWeek: spentAround(playerId, b) });
  const auto = !!(vault && m.autopay && f.ok), card = !auto && !!pp.testCard;
  const p = { role, amount, status: "creating", via: auto ? "vault" : card ? "sandbox test card" : "approval", orderId: null, approveUrl: null, authorizationId: null, captureId: null, net: null, why: auto ? null : !vault || !m.autopay ? "approve in PayPal" : `needs your approval: ${f.why.join("; ")}` };
  b.payments[playerId] = p; db.save();
  const description = `${v.name}, ${b.activity}, ${b.date} ${b.start} (${role === "organizer" ? "the whole booking, guaranteed by the organizer" : "your share"})`;
  try {
    const o = await paypalStep(b, `order:${playerId}`, (rid) => pp.createOrder({ amount, reference: `${b.id}:${playerId}`, description, returnUrl: `${publicUrl}/paypal/return?booking=${b.id}&player=${playerId}`, cancelUrl: `${publicUrl}/paypal/cancel?booking=${b.id}&player=${playerId}`, vaultId: auto ? vault.tokenId : null, card, requestId: rid }));
    p.orderId = o.id; p.approveUrl = o.approveUrl;
    if (o.authorization) { p.authorizationId = o.authorization.id; p.status = "authorized"; }
    else p.status = "awaiting_approval";
    db.save();
    if (p.status === "authorized") note(b, { kind: card ? "paypal" : "agent", player: playerId }, "authorized", card ? `PayPal sandbox: $${usd(amount)} authorized for ${name(playerId)} with PayPal's test card (a demo stand-in for their approval).` : `${name(playerId)}'s agent authorized $${usd(amount)} from their saved PayPal, within their limit.`);
    else note(b, { kind: "platform" }, "approval_requested", `${name(playerId)} needs to approve $${usd(amount)} in PayPal${role === "organizer" ? " to keep the booking" : " for their share"}.`, { player: playerId });
    await advance(b);
  } catch (e) {
    p.status = "failed"; p.error = e.message; db.save();
    note(b, { kind: "paypal" }, "payment_failed", `PayPal refused ${name(playerId)}'s payment: ${e.message.slice(0, 120)}`);
  }
  return p;
}

// what this player's other games in the same week already commit them to
function spentAround(playerId, b) {
  const t = startOf(b.date, b.start).getTime();
  return db.data.bookings.filter((x) => x.id !== b.id && LIVE.includes(x.state) && x.players.includes(playerId) && Math.abs(startOf(x.date, x.start).getTime() - t) < 3.5 * 864e5).reduce((a, x) => a + (x.shares[playerId] || 0), 0);
}

// ---- a payer approved: authorize ---------------------------------------------------------------------------------
export function approved(bookingId, playerId) {
  const b = get(bookingId);
  if (!b) return Promise.resolve({ error: "no such booking" });
  return serial(b.id, async () => {
    const p = b.payments[playerId];
    if (!p || p.status !== "awaiting_approval") return view(b, playerId);
    const o = await pp.getOrder(p.orderId);
    if (o.status !== "APPROVED") return view(b, playerId);
    if (!["awaiting_organizer", "held"].includes(b.state)) { p.status = "too_late"; db.save(); return view(b, playerId); }
    try {
      const a = await paypalStep(b, `authorize:${playerId}`, (rid) => pp.authorizeOrder(p.orderId, rid));
      p.authorizationId = a.id; p.status = "authorized"; p.expiresAt = a.expiresAt; db.save();
      note(b, { kind: "player", player: playerId }, "authorized", `${name(playerId)} approved in PayPal: $${usd(p.amount)} authorized${p.role === "organizer" ? ", so the booking is guaranteed" : ""}.`);
      await advance(b);
    } catch (e) { p.status = "failed"; p.error = e.message; db.save(); }
    return view(b, playerId);
  });
}

export async function approvedByOrder(orderId) {
  for (const b of db.data.bookings) for (const [pid, p] of Object.entries(b.payments)) if (p.orderId === orderId) return approved(b.id, pid);
  return null;
}

// ---- moving the state on ------------------------------------------------------------------------------------------
async function advance(b) {
  const now = clock().getTime(), org = b.payments[b.organizer];
  if (b.state === "awaiting_organizer" && org?.status === "authorized") {
    b.state = "held"; b.holdUntil = now + SHARES_MS; db.save();
    const until = hm(new Date(b.holdUntil).getHours() * 60 + new Date(b.holdUntil).getMinutes());
    note(b, { kind: "platform" }, "held", `${name(b.organizer)} guaranteed the booking: ${place(b)} is held until ${until}. ${name(b.organizer)} covers anyone who doesn't join and pay by then.`);
    for (const pid of b.players) if (pid !== b.organizer && !b.declined.includes(pid))
      record({ actor: { kind: "agent", player: b.organizer }, who: [pid], action: "invited", ref: b.id, summary: `${name(b.organizer)}'s agent invited you: ${b.activity} on ${b.date} ${b.start} at ${venue(b.venue).name}, ${place(b)}. Your share is $${usd(b.shares[pid])}. Join or decline by ${until}.`, data: { share: usd(b.shares[pid]), payBy: until } });
  }
  if (b.state === "held") {
    const others = b.players.filter((pid) => pid !== b.organizer && !b.declined.includes(pid));
    if (others.every((pid) => b.payments[pid]?.status === "authorized")) await lock(b, "everyone paid");
  }
}

async function lock(b, reason) {
  if (b.state !== "held") return;
  b.state = "locking"; db.save();
  let covered = 0;
  for (const pid of b.players) {
    if (pid === b.organizer) continue;
    const p = b.payments[pid];
    if (p?.status === "authorized") {
      try {
        const c = await paypalStep(b, `capture:${pid}`, (rid) => pp.capture(p.authorizationId, { amount: p.amount, final: true, requestId: rid }));
        p.captureId = c.id; p.net = c.net; p.status = c.status === "COMPLETED" ? "captured" : c.status.toLowerCase();
        if (p.status === "captured") covered += p.amount;
      } catch (e) { p.status = "capture_failed"; p.error = e.message; }
    } else if (p) p.status = p.status === "awaiting_approval" ? "dropped" : p.status;
  }
  const org = b.payments[b.organizer], rest = b.total - covered;
  try {
    const c = await paypalStep(b, `capture:${b.organizer}`, (rid) => pp.capture(org.authorizationId, { amount: rest, final: true, requestId: rid }));
    org.captureId = c.id; org.net = c.net; org.status = "captured"; org.captured = rest;
  } catch (e) {
    org.status = "capture_failed"; org.error = e.message; b.state = "held"; db.save();
    note(b, { kind: "paypal" }, "capture_failed", `PayPal refused to capture the organizer's $${usd(rest)}: ${e.message.slice(0, 120)}`);
    return;
  }
  b.state = "locked"; b.lockedAt = at(); db.save();
  receipts.issue(b, negotiation(b.negotiation), "locked");
  const short = b.players.filter((pid) => pid !== b.organizer && b.payments[pid]?.status !== "captured");
  note(b, { kind: "platform" }, "locked", `${place(b, true)} at ${venue(b.venue).name} is locked: $${usd(b.total)} paid (${reason}).${short.length ? ` ${name(b.organizer)} covered ${short.map(name).join(", ")} ($${usd(rest - b.shares[b.organizer])}).` : ""}`);
}

async function release(b, state, why) {
  for (const [pid, p] of Object.entries(b.payments)) {
    if (p.status === "authorized") {
      try { await paypalStep(b, `void:${pid}`, (rid) => pp.voidAuthorization(p.authorizationId, rid)); p.status = "voided"; } catch (e) { p.error = e.message; }
    } else if (p.status === "awaiting_approval") p.status = "dropped";
  }
  b.state = state; db.save();
  note(b, { kind: "platform" }, state, why);
}

async function refundAll(b, why) {
  for (const [pid, p] of Object.entries(b.payments)) {
    if (p.status !== "captured") continue;
    const amount = p.captured ?? p.amount;
    try { await paypalStep(b, `refund:${pid}`, (rid) => pp.refund(p.captureId, { amount, requestId: rid })); p.status = "refunded"; } catch (e) { p.error = e.message; }
  }
  b.state = "refunded"; db.save();
  receipts.issue(b, negotiation(b.negotiation), "refunded");
  note(b, { kind: "platform" }, "refunded", why);
}

// One pass over the bookings that are waiting on time or on PayPal. The server runs it every few seconds.
export async function tick() {
  const now = clock().getTime();
  for (const b of db.data.bookings) {
    const owed = Object.values(b.reimbursements || {}).some((r) => r.status === "sent") || (b.bills || []).some((x) => x.status === "sent" || x.status === "paid");
    if (!owed && (!LIVE.includes(b.state) || b.state === "venue_paid" && b.payout?.status !== "PENDING")) continue;
    await serial(b.id, async () => {
      // payers who approved but never came back to the return URL
      for (const [pid, p] of Object.entries(b.payments)) {
        if (p.status !== "awaiting_approval" || !p.orderId) continue;
        try { const o = await pp.getOrder(p.orderId); if (o.status === "APPROVED") setTimeout(() => approved(b.id, pid), 0); } catch {}
      }
      if (b.state === "awaiting_organizer" && now > b.organizerUntil) await release(b, "released", `${name(b.organizer)} didn't authorize in time, so ${venue(b.venue).name} has ${place(b)} back. Nobody was charged.`);
      else if (b.state === "held" && now > b.holdUntil) await lock(b, "the time to pay ran out");
      else if (b.state === "locked" && now > startOf(b.date, b.start).getTime() + b.minutes * 60e3) { b.state = "played"; db.save(); note(b, { kind: "platform" }, "played", "The game is over."); }
      if (b.state === "played" && !b.payout) await payVenue(b);
      await checkReimbursements(b);
      await checkBills(b);
      if (b.payout?.status === "PENDING") {
        try { const r = await pp.getPayout(b.payout.batchId); if (r.status !== "PENDING") { b.payout.status = r.status; b.payout.item = r.item; db.save(); note(b, { kind: "paypal" }, "payout_status", `PayPal Payouts: the venue's payment is ${String(r.item || r.status).toLowerCase()}.`); } } catch {}
      }
    });
  }
}

async function payVenue(b) {
  const v = venue(b.venue);
  const net = Object.values(b.payments).filter((p) => p.status === "captured").reduce((a, p) => a + (p.net ?? p.captured ?? p.amount), 0);
  try {
    const r = await paypalStep(b, "payout", () => pp.payout({ batchId: `join-${b.id}`, receiver: v.payee, amount: net, note: `Join: ${place(b)}, ${b.activity}, ${b.date} ${b.start}` }));
    b.payout = { batchId: r.batchId, status: "PENDING", amount: net, receiver: v.payee }; b.state = "venue_paid"; db.save();
    receipts.issue(b, negotiation(b.negotiation), "venue_paid");
    note(b, { kind: "platform" }, "venue_paid", `Sent ${v.name} $${usd(net)} with PayPal Payouts (the $${usd(b.total)} paid, less PayPal's fees).`);
  } catch (e) { b.payout = null; journal(b, "payout", "will_retry"); }
}

// ---- what players and agents can do -----------------------------------------------------------------------------
export function pay(bookingId, playerId) {
  const b = get(bookingId);
  if (!b || !b.players.includes(playerId)) return Promise.resolve({ error: "no_booking", message: "No such booking." });
  return serial(b.id, async () => {
    if (b.declined.includes(playerId)) return { error: "declined", message: "You declined this game." };
    if (playerId !== b.organizer && b.state === "awaiting_organizer") return { ...view(b, playerId), message: `Waiting for ${name(b.organizer)} to guarantee the booking first.` };
    if (!b.payments[playerId] && ["awaiting_organizer", "held"].includes(b.state)) {
      if (playerId !== b.organizer) note(b, { kind: "agent", player: playerId }, "joined", `${name(playerId)} is in: their share of $${usd(b.shares[playerId])} is being paid.`);
      await startPayment(b, playerId, playerId === b.organizer ? b.total : b.shares[playerId], playerId === b.organizer ? "organizer" : "share");
    }
    return view(b, playerId);
  });
}

// ---- the split, negotiated between players --------------------------------------------------------------------------------
// The fee starts split evenly. An invited player's agent may ask to pay less (proposeShare) before they join; the
// organizer's agent accepts or refuses (answerShare). Accepting moves the difference onto the organizer's own share,
// which their guarantee already covers, so the venue is paid the same; it is refused if it would take the organizer
// over their own per-booking limit. Two asks per player, one open at a time, and only as numbers.
export function proposeShare(bookingId, playerId, amount) {
  const b = get(bookingId);
  if (!b || !b.players.includes(playerId) || playerId === b.organizer) return { error: "no_booking", message: "No such invitation." };
  if (b.state !== "held" || b.payments[playerId] || b.declined.includes(playerId)) return { error: "too_late", message: "Only an invited player who hasn't joined yet can ask." };
  if (!Number.isInteger(amount) || amount < 0 || amount >= b.shares[playerId]) return { error: "bad_amount", message: `Ask for less than your share of $${usd(b.shares[playerId])}.` };
  const asks = (b.shareAsks ||= []).filter((x) => x.player === playerId);
  if (asks.some((x) => x.status === "pending")) return { error: "pending", message: "You already have an open ask." };
  if (asks.length >= 2) return { error: "limit", message: "Two asks per game." };
  const ask = { player: playerId, from: b.shares[playerId], amount, status: "pending", at: at() };
  b.shareAsks.push(ask); db.save();
  record({ actor: { kind: "agent", player: playerId }, who: [playerId, b.organizer], action: "share_asked", ref: b.id, summary: `${name(playerId)}'s agent asked to pay $${usd(amount)} instead of $${usd(ask.from)}. ${name(b.organizer)} would cover the $${usd(ask.from - amount)}.`, data: { from: usd(ask.from), amount: usd(amount) } });
  return view(b, playerId);
}

export function answerShare(bookingId, organizerId, playerId, accept) {
  const b = get(bookingId);
  if (!b || b.organizer !== organizerId) return { error: "not_organizer", message: "Only the organizer answers." };
  const ask = (b.shareAsks || []).find((x) => x.player === playerId && x.status === "pending");
  if (!ask) return { error: "no_ask", message: "No open ask from that player." };
  if (b.state !== "held" || b.payments[playerId]) { ask.status = "expired"; db.save(); return { error: "too_late", message: "That ask is no longer open." }; }
  const diff = b.shares[playerId] - ask.amount, f = fits(organizerId, { venue: b.venue, share: b.shares[organizerId] + diff });
  if (accept && !f.ok) {
    ask.status = "refused"; db.save();
    record({ actor: { kind: "platform" }, who: [playerId, organizerId], action: "share_refused", ref: b.id, summary: `${name(organizerId)}'s agent can't take on $${usd(diff)} more: ${f.why.join("; ")}.` });
    return { error: "over_mandate", message: f.why.join("; "), booking: view(b, organizerId) };
  }
  ask.status = accept ? "accepted" : "refused"; ask.answered = at();
  if (accept) { b.shares[playerId] = ask.amount; b.shares[organizerId] += diff; b.splitRule = "negotiated"; }
  db.save();
  record({ actor: { kind: "agent", player: organizerId }, who: [playerId, organizerId], action: accept ? "share_accepted" : "share_refused", ref: b.id, summary: accept ? `${name(organizerId)}'s agent agreed: ${name(playerId)} pays $${usd(ask.amount)}, ${name(organizerId)} covers $${usd(diff)} more.` : `${name(organizerId)}'s agent kept ${name(playerId)}'s share at $${usd(b.shares[playerId])}.` });
  return view(b, organizerId);
}

export function decline(bookingId, playerId) {
  const b = get(bookingId);
  if (!b || !b.players.includes(playerId) || playerId === b.organizer) return Promise.resolve({ error: "no_booking", message: "No such booking, or you organize it (cancel it instead)." });
  return serial(b.id, async () => {
    if (!["awaiting_organizer", "held"].includes(b.state)) return { error: "too_late", message: `The booking is ${b.state}.` };
    const p = b.payments[playerId];
    if (p?.status === "authorized") { try { await paypalStep(b, `void:${playerId}`, (rid) => pp.voidAuthorization(p.authorizationId, rid)); } catch {} p.status = "voided"; }
    else if (p) p.status = "dropped";
    b.declined.push(playerId); db.save();
    note(b, { kind: "agent", player: playerId }, "declined", `${name(playerId)}'s agent declined; ${name(b.organizer)} covers their share if nobody else does.`);
    await advance(b);
    return view(b, playerId);
  });
}

export function cancel(bookingId, playerId) {
  const b = get(bookingId);
  if (!b || b.organizer !== playerId) return Promise.resolve({ error: "not_organizer", message: "Only the organizer can cancel the booking." });
  return serial(b.id, async () => {
    if (["awaiting_organizer", "held"].includes(b.state)) await release(b, "cancelled", `${name(playerId)} cancelled before the booking was locked. Every authorization was voided; nobody was charged.`);
    else if (b.state === "locked" && startOf(b.date, b.start).getTime() - clock().getTime() >= CANCEL_BEFORE_MS) await refundAll(b, `${name(playerId)} cancelled more than 24 hours before the start. Everyone was refunded in full and the place went back to the venue.`);
    else return { error: "too_late", message: b.state === "locked" ? "Less than 24 hours to the game: it can't be cancelled here any more." : `The booking is ${b.state}.` };
    return view(b, playerId);
  });
}

export function view(b, viewer) {
  const v = venue(b.venue), mine = b.payments[viewer];
  return {
    id: b.id, state: b.state, negotiation: b.negotiation, venue: b.venue, venueName: v?.name, activity: b.activity, date: b.date, start: b.start, minutes: b.minutes, unit: b.unit, unitName: place(b),
    currency: "USD", total: usd(b.total), organizer: b.organizer, players: b.players, declined: b.declined,
    guaranteeBy: b.state === "awaiting_organizer" ? new Date(b.organizerUntil).toISOString() : null, payBy: b.state === "held" ? new Date(b.holdUntil).toISOString() : null,
    payments: Object.fromEntries(b.players.map((pid) => { const p = b.payments[pid]; return [pid, { share: usd(b.shares[pid]), ...(pid === b.organizer ? { guarantee: usd(b.total), paid: p?.captured != null ? usd(p.captured) : null } : {}), role: pid === b.organizer ? "organizer" : "share", status: b.declined.includes(pid) ? "declined" : p?.status || (pid !== b.organizer && b.state === "held" ? "invited" : "not_started"), via: p?.via || null }]; })),
    invite: viewer !== b.organizer && b.state === "held" && !mine && !b.declined.includes(viewer) ? { share: usd(b.shares[viewer]), payBy: new Date(b.holdUntil).toISOString() } : null,
    you: mine ? { amount: usd(mine.amount), status: mine.status, via: mine.via, approveUrl: mine.status === "awaiting_approval" ? mine.approveUrl : null, orderId: mine.status === "awaiting_approval" ? mine.orderId : null, note: mine.why } : null,
    payout: b.payout ? { amount: usd(b.payout.amount), status: b.payout.item || b.payout.status } : null,
    reimbursements: Object.values(b.reimbursements || {}).filter((r) => viewer === b.organizer || r.player === viewer).map((r) => ({ player: r.player, amount: usd(r.amount), status: r.status, url: r.player === viewer && r.status === "sent" ? r.url : undefined })),
    extras: (b.bills || []).map((x) => ({ total: usd(x.total), items: x.items.map((i) => i.name), status: x.status, url: viewer === b.organizer && x.status === "sent" ? x.url : undefined })),
    owes: b.reimbursements?.[viewer]?.status === "sent" ? { amount: usd(b.reimbursements[viewer].amount), url: b.reimbursements[viewer].url } : null,
    split: b.splitRule || "even", shareAsks: (b.shareAsks || []).filter((x) => viewer === b.organizer || x.player === viewer).map((x) => ({ ...x, from: usd(x.from), amount: usd(x.amount) })),
    paypal: paypalMode(), receipts: receipts.forBooking(b.id),
  };
}

export const status = (bookingId, viewer) => { const b = get(bookingId); return b && b.players.includes(viewer) ? view(b, viewer) : { error: "no_booking", message: "No such booking." }; };
export const mine = (viewer) => db.data.bookings.filter((b) => b.players.includes(viewer)).map((b) => view(b, viewer)).reverse();
export const forVenue = (venueId) => db.data.bookings.filter((b) => b.venue === venueId).map((b) => ({ id: b.id, state: b.state, activity: b.activity, date: b.date, start: b.start, minutes: b.minutes, unit: b.unit, unitName: place(b), total: usd(b.total), players: b.players.length, paid: Object.values(b.payments).filter((p) => p.status === "captured").length, payout: b.payout ? usd(b.payout.amount) : null, captures: Object.values(b.payments).map((p) => p.captureId).filter(Boolean), extras: (b.bills || []).map((x) => ({ total: usd(x.total), status: x.status })), disputes: Object.keys(b.disputes || {}).length }));
export const internal = get;

// ---- paying the organizer back ---------------------------------------------------------------------------------------------
// When the organizer covered someone who joined (said yes) but whose payment never went through (they didn't approve it
// in time, or PayPal declined it),
// the organizer's agent can ask for the money back: Join sends that person a PayPal invoice (Invoicing) for their share,
// and when PayPal says it is paid, sends the same amount to the organizer (Payouts). One invoice per person per booking.
// Someone who declined is never invoiced, and neither is a share the organizer agreed to cover.
export function requestReimbursement(bookingId, organizerId, playerId) {
  const b = get(bookingId);
  if (!b || b.organizer !== organizerId) return Promise.resolve({ error: "not_organizer", message: "Only the organizer can ask to be paid back." });
  return serial(b.id, async () => {
    if (!["locked", "played", "venue_paid"].includes(b.state)) return { error: "too_early", message: "Ask once the booking is locked." };
    const p = b.payments[playerId];
    // (someone who never said yes, or said no, owes nothing: Join never starts anything for a person without their yes)
    if (!b.players.includes(playerId) || playerId === b.organizer || b.declined.includes(playerId) || !p || p.status === "captured") return { error: "nothing_owed", message: `${name(playerId)} doesn't owe anything for this booking: only someone who joined and then didn't pay can be asked.` };
    if ((b.reimbursements ||= {})[playerId]) return view(b, organizerId);
    const amount = b.shares[playerId], who = player(playerId);
    const r = { player: playerId, amount, status: "creating" };
    b.reimbursements[playerId] = r; db.save();
    try {
      const inv = await paypalStep(b, `invoice:${playerId}`, (rid) => pp.invoice({ recipient: who.paypal, amount, item: `Your share: ${b.activity}, ${venue(b.venue).name}, ${b.date} ${b.start}`, note: `${name(b.organizer)} paid your share of this booking on Join. Paying this invoice pays them back.`, requestId: rid }));
      Object.assign(r, { invoiceId: inv.id, url: inv.url, status: "sent" }); db.save();
      record({ actor: { kind: "agent", player: organizerId }, who: [organizerId, playerId], action: "reimbursement_requested", ref: b.id, summary: `${name(organizerId)}'s agent asked ${name(playerId)} to pay back $${usd(amount)} with a PayPal invoice.`, data: { invoice: inv.id, url: inv.url, amount: usd(amount), player: playerId } });
    } catch (e) { r.status = "failed"; r.error = e.message; db.save(); }
    return view(b, organizerId);
  });
}

// An invoice that was paid: the organizer gets the money (Payouts to their PayPal)
async function reimbursed(b, r) {
  r.status = "paid"; db.save();
  record({ actor: { kind: "paypal" }, who: [b.organizer, r.player], action: "reimbursement_paid", ref: b.id, summary: `${name(r.player)} paid the $${usd(r.amount)} invoice in PayPal.` });
  try {
    const out = await paypalStep(b, `repay:${r.player}`, () => pp.payout({ batchId: `join-repay-${b.id}-${r.player}`, receiver: player(b.organizer).paypal, amount: r.amount, note: `Join: ${name(r.player)} paid you back for ${b.activity} on ${b.date}` }));
    Object.assign(r, { status: "repaid", payout: out.batchId }); db.save();
    record({ actor: { kind: "platform" }, who: [b.organizer, r.player], action: "organizer_repaid", ref: b.id, summary: `Sent ${name(b.organizer)} $${usd(r.amount)} with PayPal Payouts: ${name(r.player)}'s share is settled.` });
  } catch (e) { r.status = "paid_payout_failed"; r.error = e.message; db.save(); }
}
async function checkReimbursements(b) {
  for (const r of Object.values(b.reimbursements || {})) {
    if (r.status !== "sent") continue;
    try { const inv = await pp.getInvoice(r.invoiceId); if (inv.status === "PAID" || inv.status === "MARKED_AS_PAID") await reimbursed(b, r); } catch {}
  }
}

// ---- the venue's side: extras, reconciliation, disputes (PayPal Agent Toolkit, toolkit.js) ------------------------------------
// A venue bills the organizer for extras after a booking (overtime, rentals) with a PayPal invoice; Join keeps the
// invoice with the booking and tells everyone in it.
export async function billExtras(venueId, bookingId, items) {
  const b = get(bookingId);
  if (!b || b.venue !== venueId) return { error: "no_booking", message: "No such booking at this venue." };
  if (!["locked", "played", "venue_paid"].includes(b.state)) return { error: "too_early", message: "Extras are billed once the booking is paid and locked." };
  const clean = (items || []).filter((x) => typeof x?.name === "string" && x.name.trim() && Number.isInteger(x.amount) && x.amount > 0 && x.amount <= 50000).slice(0, 10).map((x) => ({ name: x.name.trim().slice(0, 120), amount: x.amount }));
  if (!clean.length) return { error: "bad_items", message: "Each extra needs a name and an amount in cents." };
  const total = clean.reduce((a, x) => a + x.amount, 0);
  const inv = await toolkit.bill({ recipient: player(b.organizer).paypal, venueName: venue(b.venue).name, reference: b.id, note: `Extras after your ${b.activity} booking on ${b.date} (${place(b)}).`, items: clean });
  (b.bills ||= []).push({ invoiceId: inv.id, url: inv.url, items: clean, total, status: "sent", at: at() }); db.save();
  record({ actor: { kind: "venue", venue: b.venue }, who: b.players, action: "extras_billed", ref: b.id, summary: `${venue(b.venue).name} billed ${name(b.organizer)} $${usd(total)} for extras (${clean.map((x) => x.name).join(", ")}) with a PayPal invoice.`, data: { invoice: inv.id, url: inv.url } });
  return { invoice: inv.id, url: inv.url, total: usd(total) };
}
async function checkBills(b) {
  for (const x of b.bills || []) {
    if (x.status === "paid") { try { const v = venue(b.venue), out = await paypalStep(b, `extras-payout:${x.invoiceId}`, () => pp.payout({ batchId: `join-extras-${x.invoiceId}`, receiver: v.payee, amount: x.total, note: `Join: extras for ${b.activity} on ${b.date}` })); Object.assign(x, { status: "paid_out", payout: out.batchId }); db.save(); } catch {} continue; }
    if (x.status !== "sent") continue;
    try {
      const s = await toolkit.invoiceStatus(x.invoiceId);
      if (s.status !== "PAID" && s.status !== "MARKED_AS_PAID") continue;
      x.status = "paid"; db.save();
      record({ actor: { kind: "paypal" }, who: b.players, action: "extras_paid", ref: b.id, summary: `${name(b.organizer)} paid the $${usd(x.total)} extras invoice in PayPal.` });
      // the invoice is paid to Join (the platform); the venue gets it with Payouts, like the booking itself
      const v = venue(b.venue), out = await paypalStep(b, `extras-payout:${x.invoiceId}`, () => pp.payout({ batchId: `join-extras-${x.invoiceId}`, receiver: v.payee, amount: x.total, note: `Join: extras for ${b.activity} on ${b.date}` }));
      Object.assign(x, { status: "paid_out", payout: out.batchId }); db.save();
      record({ actor: { kind: "platform" }, who: b.players, action: "extras_paid_out", ref: b.id, summary: `Sent ${v.name} the $${usd(x.total)} for extras with PayPal Payouts.` });
    } catch {}
  }
}
export const reconcileVenue = (venueId) => toolkit.reconcile(db.data.bookings.filter((b) => b.venue === venueId));
export async function venueDisputes(venueId) {
  const mine = db.data.bookings.filter((b) => b.venue === venueId), byCapture = new Map();
  for (const b of mine) for (const p of Object.values(b.payments)) if (p.captureId) byCapture.set(p.captureId, b.id);
  const list = await toolkit.disputes([...byCapture.keys()]);
  return list.map((d) => ({ ...d, booking: d.transactions.map((t) => byCapture.get(t)).find(Boolean) || null, receipt: receipts.forBooking(d.transactions.map((t) => byCapture.get(t)).find(Boolean) || "").at(-1)?.id || null }));
}
// The venue answers a chargeback with Join's signed receipt for that booking: what was agreed, who paid what, and when
export async function answerDispute(venueId, disputeId) {
  const d = (await venueDisputes(venueId)).find((x) => x.id === disputeId);
  if (!d || !d.booking) return { error: "no_dispute", message: "No such dispute on this venue's bookings." };
  const b = get(d.booking), rid = d.receipt;
  if (!rid) return { error: "no_receipt", message: "This booking has no receipt yet." };
  const r = receipts.show(rid);
  await pp.provideEvidence(disputeId, { notes: `Join booking ${b.id}: ${b.activity} at ${venue(b.venue).name}, ${b.date} ${b.start}, ${place(b)}. The attached receipt is signed by Join (Ed25519, key ${r.kid}) and lists the negotiation, each payment and its PayPal ids. Verify it at /api/receipts/${rid}.`, file: JSON.stringify(r) });
  (b.disputes ||= {})[disputeId] = { status: "evidence_sent", receipt: rid, at: at() }; db.save();
  record({ actor: { kind: "venue", venue: b.venue }, who: b.players, action: "dispute_answered", ref: b.id, summary: `${venue(b.venue).name} answered PayPal dispute ${disputeId} with Join's signed receipt.` });
  return { dispute: disputeId, status: "evidence_sent", receipt: rid };
}

// ---- Vault: save PayPal once, then the agent pays within the mandate -------------------------------------------------
export async function vaultStart(playerId) {
  const s = await pp.vaultSetup({ returnUrl: `${publicUrl}/paypal/vault-return?player=${playerId}`, cancelUrl: `${publicUrl}/#/mandate`, requestId: `vault:${playerId}:${Date.now()}` });
  db.data.setups[s.id] = { player: playerId, at: at() }; db.save();
  return { approveUrl: s.approveUrl, setup: s.id };
}
export async function vaultFinish(setupId) {
  const s = db.data.setups[setupId];
  if (!s) return { error: "unknown setup" };
  const t = await pp.vaultToken(setupId, `vault-token:${setupId}`);
  db.data.vaults[s.player] = { tokenId: t.id, customerId: t.customerId, savedAt: at() }; delete db.data.setups[setupId]; db.save();
  record({ actor: { kind: "player", player: s.player }, who: [s.player], action: "vault_saved", summary: "You saved PayPal for Join. Your agent can now pay your share within your limits without asking each time." });
  return { ok: true, player: s.player };
}
export const hasVault = (playerId) => !!db.data.vaults[playerId];
export function vaultForget(playerId) { delete db.data.vaults[playerId]; db.save(); return { ok: true }; }

// ---- PayPal's webhooks: confirmations, never the only signal -------------------------------------------------------------
export async function webhook(event) {
  const r = event.resource || {}, type = event.event_type;
  if (type === "CHECKOUT.ORDER.APPROVED") return approvedByOrder(r.id);
  if (type === "INVOICING.INVOICE.PAID") {
    for (const b of db.data.bookings) for (const x of Object.values(b.reimbursements || {})) if (x.invoiceId === (r.id || r.invoice?.id) && x.status === "sent") { await serial(b.id, () => reimbursed(b, x)); return { ok: true }; }
    for (const b of db.data.bookings) for (const x of b.bills || []) if (x.invoiceId === (r.id || r.invoice?.id) && x.status === "sent") { await serial(b.id, () => checkBills(b)); return { ok: true }; }
    return null;
  }
  const find = (pred) => { for (const b of db.data.bookings) for (const [pid, p] of Object.entries(b.payments)) if (pred(p)) return { b, pid, p }; return null; };
  if (type === "CUSTOMER.DISPUTE.CREATED") {
    const ids = (r.disputed_transactions || []).map((t) => t.seller_transaction_id);
    const hit = find((p) => ids.includes(p.captureId));
    if (hit) { (hit.b.disputes ||= {})[r.dispute_id] = { status: "open", reason: r.reason, at: at() }; db.save(); record({ actor: { kind: "paypal" }, who: [hit.b.organizer], action: "dispute_opened", ref: hit.b.id, summary: `PayPal: a dispute was opened on a payment for this booking (${String(r.reason || "").toLowerCase().replace(/_/g, " ")}).` }); }
    return hit ? { ok: true } : null;
  }
  if (type?.startsWith("PAYMENT.CAPTURE.")) {
    // (a refund event's resource is the refund; its capture is the link marked "up")
    const capId = type === "PAYMENT.CAPTURE.REFUNDED" ? String((r.links || []).find((l) => l.rel === "up")?.href || "").split("/").pop() || r.id : r.id;
    const hit = find((p) => p.captureId === capId);
    if (hit) { const s = type.split(".").pop().toLowerCase(); if (s === "declined") hit.p.status = "capture_failed"; if (s === "refunded") hit.p.status = "refunded"; db.save(); note(hit.b, { kind: "paypal" }, `capture_${s}`, `PayPal: ${name(hit.pid)}'s payment ${s}.`); }
    return hit ? { ok: true } : null;
  }
  if (type?.startsWith("PAYMENT.PAYOUTS-ITEM.")) {
    const b = db.data.bookings.find((x) => x.payout && (`join-${x.id}` === r.payout_item?.sender_item_id || x.payout.batchId === r.payout_batch_id));
    if (b) { b.payout.item = type.split(".").pop(); b.payout.status = "DONE"; db.save(); note(b, { kind: "paypal" }, "payout_status", `PayPal Payouts: the venue's payment ${b.payout.item.toLowerCase()}.`); }
    return b ? { ok: true } : null;
  }
  return null;
}

// Settling a deal with PayPal: from the moment the organizer's agent and the venue agree a price, to the venue being
// paid after the game. One booking per deal; each player pays their own share with their own PayPal.
//
//   awaiting_organizer  The court is held for ORGANIZER_MS while the organizer authorizes the WHOLE price (an order with
//                       intent AUTHORIZE). Nothing else happens until they do, so nobody can hold a court for free.
//   held                The organizer's authorization guarantees the court. Every other player is invited, for
//                       SHARES_MS: their agent (or they, on the website) joins or declines. Nothing is started for
//                       anyone who hasn't said yes. Joining starts their share: a player who saved PayPal (Vault) and
//                       whose mandate covers the share is authorized by their agent at once; everyone else approves in
//                       PayPal.
//   locked              Everyone authorized, or the time ran out: each share is captured, and the rest of the price is
//                       captured from the organizer's authorization (they cover whoever didn't pay). The court is the
//                       group's. Until CANCEL_BEFORE_MS before the game it can still be cancelled with full refunds.
//   played              The game's end has passed.
//   venue_paid          The venue was sent what PayPal left after fees (Payouts). Paying after the game, not before,
//                       keeps refunds possible while the game can still be cancelled.
//   released / cancelled / refunded   The court went back to the venue; nothing was charged, or everything refunded.
//
// The state moves on three signals, any of which is enough: the payer coming back to the return URL, polling the
// order (tick), and PayPal's webhooks. Each PayPal POST is written to the booking's journal before it is made and
// carries a PayPal-Request-Id made from the booking and the step, so doing a step again after a crash repeats the same
// call instead of making a second one.
import crypto from "node:crypto";
import { store, stateFile } from "../store.js";
import { setTaken, venue, player, freeCourts } from "../world.js";
import { setOnAgreed, internal as negotiation } from "../negotiate/engine.js";
import * as receipts from "../proof/receipts.js";
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

// the courts this platform holds, so the venue adapter doesn't offer them again
setTaken(() => db.data.bookings.filter((b) => LIVE.includes(b.state)).map((b) => ({ venue: b.venue, sport: b.sport, date: b.date, from: toMin(b.start), to: toMin(b.start) + b.minutes, court: b.court })));

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
  const now = clock(), court = freeCourts(n.venue, n.sport, n.date, n.start, n.minutes)[0];
  if (!court) return { error: "no_court" };
  const b = {
    id: `bk_${crypto.randomBytes(6).toString("hex")}`, negotiation: n.id, venue: n.venue, sport: n.sport, date: n.date, start: n.start, minutes: n.minutes, court,
    total: n.agreed.amount, players: n.players, organizer: n.by, shares: split(n.agreed.amount, n.players, n.by),
    state: "awaiting_organizer", created: now.toISOString(), organizerUntil: now.getTime() + ORGANIZER_MS, holdUntil: null,
    payments: {}, declined: [], payout: null, journal: [], paypalMode: paypalMode(),
  };
  db.data.bookings.push(b); db.save();
  note(b, { kind: "venue", venue: b.venue }, "court_held", `${venue(b.venue).name} holds court ${court} for ${ORGANIZER_MS / 60e3} minutes while ${name(b.organizer)} authorizes $${usd(b.total)} with PayPal.`);
  serial(b.id, () => startPayment(b, b.organizer, b.total, "organizer")).catch(() => {});
  return { id: b.id, state: b.state };
});

async function startPayment(b, playerId, amount, role) {
  if (b.payments[playerId]) return b.payments[playerId];
  const v = venue(b.venue), vault = db.data.vaults[playerId], m = getMandate(playerId);
  const f = fits(playerId, { venue: b.venue, share: amount, spentThisWeek: spentAround(playerId, b) });
  const auto = !!(vault && m.autopay && f.ok);
  const p = { role, amount, status: "creating", via: auto ? "vault" : "approval", orderId: null, approveUrl: null, authorizationId: null, captureId: null, net: null, why: auto ? null : !vault || !m.autopay ? "approve in PayPal" : `needs your approval: ${f.why.join("; ")}` };
  b.payments[playerId] = p; db.save();
  const description = `${v.name}, ${b.sport}, ${b.date} ${b.start} (${role === "organizer" ? "whole court, guaranteed by the organizer" : "your share"})`;
  try {
    const o = await paypalStep(b, `order:${playerId}`, (rid) => pp.createOrder({ amount, reference: `${b.id}:${playerId}`, description, returnUrl: `${publicUrl}/paypal/return?booking=${b.id}&player=${playerId}`, cancelUrl: `${publicUrl}/paypal/cancel?booking=${b.id}&player=${playerId}`, vaultId: auto ? vault.tokenId : null, requestId: rid }));
    p.orderId = o.id; p.approveUrl = o.approveUrl;
    if (o.authorization) { p.authorizationId = o.authorization.id; p.status = "authorized"; }
    else p.status = "awaiting_approval";
    db.save();
    if (p.status === "authorized") note(b, { kind: "agent", player: playerId }, "authorized", `${name(playerId)}'s agent authorized $${usd(amount)} from their saved PayPal, within their limit.`);
    else note(b, { kind: "platform" }, "approval_requested", `${name(playerId)} needs to approve $${usd(amount)} in PayPal${role === "organizer" ? " to keep the court" : " for their share"}.`, { player: playerId });
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
      note(b, { kind: "player", player: playerId }, "authorized", `${name(playerId)} approved in PayPal: $${usd(p.amount)} authorized${p.role === "organizer" ? ", so the court is guaranteed" : ""}.`);
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
    note(b, { kind: "platform" }, "held", `${name(b.organizer)} guaranteed the court: court ${b.court} is held until ${until}. ${name(b.organizer)} covers anyone who doesn't join and pay by then.`);
    for (const pid of b.players) if (pid !== b.organizer && !b.declined.includes(pid))
      record({ actor: { kind: "agent", player: b.organizer }, who: [pid], action: "invited", ref: b.id, summary: `${name(b.organizer)}'s agent invited you: ${b.sport} on ${b.date} ${b.start} at ${venue(b.venue).name}, court ${b.court}. Your share is $${usd(b.shares[pid])}. Join or decline by ${until}.`, data: { share: usd(b.shares[pid]), payBy: until } });
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
  note(b, { kind: "platform" }, "locked", `Court ${b.court} at ${venue(b.venue).name} is locked: $${usd(b.total)} paid (${reason}).${short.length ? ` ${name(b.organizer)} covered ${short.map(name).join(", ")} ($${usd(rest - b.shares[b.organizer])}).` : ""}`);
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
    if (!LIVE.includes(b.state) || b.state === "venue_paid" && b.payout?.status !== "PENDING") continue;
    await serial(b.id, async () => {
      // payers who approved but never came back to the return URL
      for (const [pid, p] of Object.entries(b.payments)) {
        if (p.status !== "awaiting_approval" || !p.orderId) continue;
        try { const o = await pp.getOrder(p.orderId); if (o.status === "APPROVED") setTimeout(() => approved(b.id, pid), 0); } catch {}
      }
      if (b.state === "awaiting_organizer" && now > b.organizerUntil) await release(b, "released", `${name(b.organizer)} didn't authorize in time, so ${venue(b.venue).name} has court ${b.court} back. Nobody was charged.`);
      else if (b.state === "held" && now > b.holdUntil) await lock(b, "the time to pay ran out");
      else if (b.state === "locked" && now > startOf(b.date, b.start).getTime() + b.minutes * 60e3) { b.state = "played"; db.save(); note(b, { kind: "platform" }, "played", "The game is over."); }
      if (b.state === "played" && !b.payout) await payVenue(b);
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
    const r = await paypalStep(b, "payout", () => pp.payout({ batchId: `join-${b.id}`, receiver: v.payee, amount: net, note: `Join: court ${b.court}, ${b.sport}, ${b.date} ${b.start}` }));
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
    if (playerId !== b.organizer && b.state === "awaiting_organizer") return { ...view(b, playerId), message: `Waiting for ${name(b.organizer)} to guarantee the court first.` };
    if (!b.payments[playerId] && ["awaiting_organizer", "held"].includes(b.state)) {
      if (playerId !== b.organizer) note(b, { kind: "agent", player: playerId }, "joined", `${name(playerId)} is in: their share of $${usd(b.shares[playerId])} is being paid.`);
      await startPayment(b, playerId, playerId === b.organizer ? b.total : b.shares[playerId], playerId === b.organizer ? "organizer" : "share");
    }
    return view(b, playerId);
  });
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
    if (["awaiting_organizer", "held"].includes(b.state)) await release(b, "cancelled", `${name(playerId)} cancelled before the court was locked. Every authorization was voided; nobody was charged.`);
    else if (b.state === "locked" && startOf(b.date, b.start).getTime() - clock().getTime() >= CANCEL_BEFORE_MS) await refundAll(b, `${name(playerId)} cancelled more than 24 hours before the game. Everyone was refunded in full and the court went back to the venue.`);
    else return { error: "too_late", message: b.state === "locked" ? "Less than 24 hours to the game: it can't be cancelled here any more." : `The booking is ${b.state}.` };
    return view(b, playerId);
  });
}

export function view(b, viewer) {
  const v = venue(b.venue), mine = b.payments[viewer];
  return {
    id: b.id, state: b.state, negotiation: b.negotiation, venue: b.venue, venueName: v?.name, sport: b.sport, date: b.date, start: b.start, minutes: b.minutes, court: b.court,
    currency: "USD", total: usd(b.total), organizer: b.organizer, players: b.players, declined: b.declined,
    guaranteeBy: b.state === "awaiting_organizer" ? new Date(b.organizerUntil).toISOString() : null, payBy: b.state === "held" ? new Date(b.holdUntil).toISOString() : null,
    payments: Object.fromEntries(b.players.map((pid) => { const p = b.payments[pid]; return [pid, { share: usd(b.shares[pid]), ...(pid === b.organizer ? { guarantee: usd(b.total), paid: p?.captured != null ? usd(p.captured) : null } : {}), role: pid === b.organizer ? "organizer" : "share", status: b.declined.includes(pid) ? "declined" : p?.status || (pid !== b.organizer && b.state === "held" ? "invited" : "not_started"), via: p?.via || null }]; })),
    invite: viewer !== b.organizer && b.state === "held" && !mine && !b.declined.includes(viewer) ? { share: usd(b.shares[viewer]), payBy: new Date(b.holdUntil).toISOString() } : null,
    you: mine ? { amount: usd(mine.amount), status: mine.status, via: mine.via, approveUrl: mine.status === "awaiting_approval" ? mine.approveUrl : null, note: mine.why } : null,
    payout: b.payout ? { amount: usd(b.payout.amount), status: b.payout.item || b.payout.status } : null,
    paypal: paypalMode(), receipts: receipts.forBooking(b.id),
  };
}

export const status = (bookingId, viewer) => { const b = get(bookingId); return b && b.players.includes(viewer) ? view(b, viewer) : { error: "no_booking", message: "No such booking." }; };
export const mine = (viewer) => db.data.bookings.filter((b) => b.players.includes(viewer)).map((b) => view(b, viewer)).reverse();
export const forVenue = (venueId) => db.data.bookings.filter((b) => b.venue === venueId).map((b) => ({ id: b.id, state: b.state, sport: b.sport, date: b.date, start: b.start, minutes: b.minutes, court: b.court, total: usd(b.total), players: b.players.length, paid: Object.values(b.payments).filter((p) => p.status === "captured").length, payout: b.payout ? usd(b.payout.amount) : null }));
export const internal = get;

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
  const find = (pred) => { for (const b of db.data.bookings) for (const [pid, p] of Object.entries(b.payments)) if (pred(p)) return { b, pid, p }; return null; };
  if (type?.startsWith("PAYMENT.CAPTURE.")) {
    const hit = find((p) => p.captureId === r.id);
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

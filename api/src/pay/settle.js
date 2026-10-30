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
import { setTaken, venue, player, freeUnits, unitName, activity as getActivity } from "../world.js";
// "room 3" (or "Room 3" to start a sentence)
const place = (b, cap = false) => { const t = unitName(b.activity, b.unit); return cap ? t[0].toUpperCase() + t.slice(1) : t; };
import { setOnAgreed, setSpent, internal as negotiation } from "../negotiate/engine.js";
import * as receipts from "../proof/receipts.js";
import * as toolkit from "./toolkit.js";
import { getMandate, fits, coverFits } from "../mandate.js";
import { record } from "../activity.js";
import { startOf, toMin, hm } from "../time.js";
import { usd } from "../negotiate/policy.js";
import * as ap2 from "../proof/mandates.js";
import * as reviewsMod from "../reviews.js";

export const ORGANIZER_MS = 10 * 60e3;
// How long friends have to pay once the organizer has guaranteed. The demo town uses 20 minutes, so a judge can watch
// the window close; a real deployment sets SHARES_MS to a day or so. Never later than 2 hours before the game (and
// never under 10 minutes), so the venue knows in time.
export const SHARES_MS = +process.env.SHARES_MS || 20 * 60e3;
const shareWindowEnd = (b, now) => Math.min(now + SHARES_MS, Math.max(now + 10 * 60e3, startOf(b.date, b.start).getTime() - 2 * 3600e3));
export const CANCEL_BEFORE_MS = 24 * 3600e3;
// a payout PayPal hasn't finished yet (its batch is PENDING, then PROCESSING): Join keeps asking until it has
const unsettled = (p) => !!p && ["PENDING", "PROCESSING"].includes(p.status);
const LIVE = ["awaiting_organizer", "held", "locking", "locked", "played", "venue_paid"];

const db = store(stateFile("bookings"), { bookings: [], vaults: {}, setups: {}, settlements: [] });
db.data.settlements ||= []; // (stores written before settlements existed)
export const bookingsStore = db;
let pp = null, clock = () => new Date(), publicUrl = "http://localhost:8790";
export function configure({ paypal, now, url, residentMs } = {}) { if (paypal) pp = paypal; if (now) clock = now; if (url) publicUrl = url; if (residentMs != null) RESIDENT_MS = residentMs; }
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
  // The guarantee starts at once only if the organizer's side may pay: the person on the website, or an agent whose
  // token has the pay scope. Otherwise it waits for them (pay_my_share, or the button on Plans), so a deal an agent
  // accepted never puts a hold on anyone's PayPal by itself.
  if (!deferring) serial(b.id, () => startPayment(b, b.organizer, b.total, "organizer")).catch(() => {});
  else note(b, { kind: "platform" }, "guarantee_waiting", `${name(b.organizer)}'s agent may not pay, so nothing is held in PayPal yet: ${name(b.organizer)} guarantees the $${usd(b.total)} on Join (Plans) or lets an agent that may pay do it, within ${ORGANIZER_MS / 60e3} minutes.`);
  // AP2: the agreed checkout and its Checkout Mandate, under the organizer agent's open mandates, with Join's receipt
  ap2.issueCheckout(b, { venue: venue(b.venue), activity: getActivity(b.activity), organizerKid: n.agentKid || null, result: { ok: true } });
  return { id: b.id, state: b.state };
});

let deferring = false;
export function deferGuarantee(on, fn) { deferring = on; try { return fn(); } finally { deferring = false; } }

async function startPayment(b, playerId, amount, role) {
  if (b.payments[playerId]) return b.payments[playerId];
  const v = venue(b.venue), vault = db.data.vaults[playerId], m = getMandate(playerId);
  // the share is checked against what they spend; an organizer's guarantee of the whole price against what they cover
  const f = fits(playerId, { venue: b.venue, share: b.shares[playerId], spentThisWeek: spentAround(playerId, b) });
  if (role === "organizer") { const c = coverFits(playerId, amount); f.ok &&= c.ok; f.why.push(...c.why); }
  const auto = !!(vault && m.autopay && f.ok), card = !auto && !!pp.testCard;
  const p = { role, amount, status: "creating", via: auto ? "vault" : card ? "sandbox test card" : "approval", orderId: null, approveUrl: null, authorizationId: null, captureId: null, net: null, why: auto ? null : !vault || !m.autopay ? "approve in PayPal" : `needs your approval: ${f.why.join("; ")}` };
  b.payments[playerId] = p; db.save();
  const description = `${v.name}, ${b.activity}, ${b.date} ${b.start} (${role === "organizer" ? "the whole booking, guaranteed by the organizer" : "your share"})`;
  try {
    const o = await paypalStep(b, `order:${playerId}`, (rid) => pp.createOrder({ amount, reference: `${b.id}:${playerId}`, description, returnUrl: `${publicUrl}/paypal/return?booking=${b.id}&player=${playerId}`, cancelUrl: `${publicUrl}/paypal/cancel?booking=${b.id}&player=${playerId}`, vaultId: auto ? vault.tokenId : null, card, requestId: rid }));
    p.orderId = o.id; p.approveUrl = o.approveUrl;
    // AP2: this payer's Payment Mandate for the checkout (the organizer's is the whole price, the guarantee)
    ap2.issuePayment(b, playerId, { amount, venue: v, instrument: { id: auto ? vault.tokenId : o.id, type: auto ? "paypal.vault_token" : card ? "paypal.sandbox_card" : "paypal.order", description: p.via }, agentKid: auto ? "saved-paypal" : null, result: { ok: true } });
    if (o.authorization) { p.authorizationId = o.authorization.id; p.status = "authorized"; }
    else p.status = "awaiting_approval";
    db.save();
    if (p.status === "authorized") note(b, { kind: card ? "paypal" : "agent", player: playerId }, "authorized", card ? `PayPal sandbox: $${usd(amount)} authorized for ${name(playerId)} with PayPal's sandbox test card, standing in for their own approval in PayPal (order ${p.orderId}).` : `${name(playerId)}'s agent authorized $${usd(amount)} from their saved PayPal, within their limit.`);
    else note(b, { kind: "platform" }, "approval_requested", `${name(playerId)} needs to approve $${usd(amount)} in PayPal${role === "organizer" ? " to keep the booking" : " for their share"}.`, { player: playerId });
    await advance(b);
  } catch (e) {
    p.status = "failed"; p.error = e.message; db.save();
    note(b, { kind: "paypal" }, "payment_failed", `PayPal refused ${name(playerId)}'s payment: ${e.message.slice(0, 120)}`);
  }
  return p;
}

// what a player pays for a booking: their share; for an organizer who covered someone, what was captured from them,
// less what they were paid back
function paysFor(x, playerId) {
  const p = x.payments[playerId];
  if (playerId !== x.organizer || p?.captured == null) return x.shares[playerId] || 0;
  return p.captured - Object.values(x.reimbursements || {}).filter((r) => r.status === "repaid").reduce((a, r) => a + r.amount, 0);
}
// what this player's other bookings in the same week already cost them
export function spentInWeek(playerId, date, start, except = null) {
  const t = startOf(date, start).getTime();
  return db.data.bookings.filter((x) => x.id !== except && LIVE.includes(x.state) && x.players.includes(playerId) && !x.declined.includes(playerId) && Math.abs(startOf(x.date, x.start).getTime() - t) < 3.5 * 864e5).reduce((a, x) => a + paysFor(x, playerId), 0);
}
const spentAround = (playerId, b) => spentInWeek(playerId, b.date, b.start, b.id);
setSpent(spentInWeek);

// What an organizer takes on by accepting a price: the guarantee, their own share, the worst case, and whether their
// agent can authorize it from saved PayPal or they approve it themselves.
export function guaranteeTerms(playerId, { total, players, venue: venueId, date, start }, { mayPay = true } = {}) {
  const shares = split(total, players, playerId), m = getMandate(playerId);
  const f = fits(playerId, { venue: venueId, share: shares[playerId], spentThisWeek: spentInWeek(playerId, date, start) }), c = coverFits(playerId, total);
  const auto = !!(db.data.vaults[playerId] && m.autopay && f.ok && c.ok);
  return { guarantee: usd(total), yourShare: usd(shares[playerId]), worstCase: usd(total), approval: !mayPay ? "your person guarantees it on Join (this agent may not pay)" : auto ? "saved PayPal, within your limits" : pp?.testCard ? "sandbox test card (stands in for your approval)" : "you approve it in PayPal",
    note: `As the organizer you guarantee the whole $${usd(total)} with a PayPal authorization until the others pay. You pay your own $${usd(shares[playerId])} unless someone doesn't pay; then you cover them, at most $${usd(total)} in all.` };
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
    b.state = "held"; b.holdUntil = shareWindowEnd(b, now); db.save();
    const until = hm(new Date(b.holdUntil).getHours() * 60 + new Date(b.holdUntil).getMinutes());
    note(b, { kind: "platform" }, "held", `${name(b.organizer)} guaranteed the booking: ${place(b)} is held until ${until}. ${name(b.organizer)} covers anyone who doesn't join and pay by then.`);
    for (const pid of b.players) if (pid !== b.organizer && !b.declined.includes(pid))
      record({ actor: { kind: "agent", player: b.organizer }, who: [pid], action: "invited", ref: b.id, summary: `${name(b.organizer)}'s agent invited you: ${b.activity} on ${b.date} ${b.start} at ${venue(b.venue).name}, ${place(b)}. Your share is $${usd(b.shares[pid])}. Join or decline by ${until}.`, data: { share: usd(b.shares[pid]), payBy: until } });
    residentsAnswer(b);
  }
  if (b.state === "held") {
    const others = b.players.filter((pid) => pid !== b.organizer && !b.declined.includes(pid));
    if (others.every((pid) => b.payments[pid]?.status === "authorized")) await lock(b, b.declined.length ? "everyone who is coming paid" : "everyone paid");
  }
}

// The lock captures every share, then the organizer's authorization for the rest. It can be interrupted (PayPal refuses
// a capture, the process stops) and is then resumed from "locking" on the next tick: shares already captured count as
// paid and aren't captured again. A call cut off by a crash is repeated with the same PayPal-Request-Id, so PayPal treats
// it as the same call; one PayPal refused is tried with a new id. A friend's capture refused 3 times counts as unpaid,
// and the organizer covers it.
const inLock = new Set();
async function lock(b, reason) {
  if (!["held", "locking"].includes(b.state) || inLock.has(b.id)) return;
  inLock.add(b.id);
  try { await lockSteps(b, reason); } finally { inLock.delete(b.id); }
}
async function lockSteps(b, reason) {
  if (b.state === "held") { b.state = "locking"; b.lockReason = reason; db.save(); }
  reason = b.lockReason || reason;
  for (const pid of b.players) {
    if (pid === b.organizer) continue;
    const p = b.payments[pid];
    if (p?.status === "authorized" || (p?.status === "capture_failed" && (p.tries || 0) < 3)) {
      try {
        const c = await paypalStep(b, p.tries ? `capture:${pid}:retry${p.tries}` : `capture:${pid}`, (rid) => pp.capture(p.authorizationId, { amount: p.amount, final: true, requestId: rid }));
        p.captureId = c.id; p.net = c.net; p.status = c.status === "COMPLETED" ? "captured" : c.status.toLowerCase();
      } catch (e) { p.status = "capture_failed"; p.error = e.message; p.tries = (p.tries || 0) + 1; }
      db.save();
    } else if (p?.status === "awaiting_approval") p.status = "dropped";
  }
  if (b.players.some((pid) => pid !== b.organizer && b.payments[pid]?.status === "capture_failed" && b.payments[pid].tries < 3)) return; // (next tick)
  const covered = b.players.filter((pid) => pid !== b.organizer && b.payments[pid]?.status === "captured").reduce((t, pid) => t + b.payments[pid].amount, 0);
  const org = b.payments[b.organizer], rest = b.total - covered;
  if (org.status !== "captured") {
    try {
      const c = await paypalStep(b, org.tries ? `capture:${b.organizer}:retry${org.tries}` : `capture:${b.organizer}`, (rid) => pp.capture(org.authorizationId, { amount: rest, final: true, requestId: rid }));
      org.captureId = c.id; org.net = c.net; org.status = "captured"; org.captured = rest;
    } catch (e) {
      org.status = "capture_failed"; org.error = e.message; org.tries = (org.tries || 0) + 1; db.save(); // (stays "locking": tried again next tick)
      note(b, { kind: "paypal" }, "capture_failed", `PayPal refused to capture the organizer's $${usd(rest)}: ${e.message.slice(0, 120)}. Join will try again.`);
      return;
    }
  }
  b.state = "locked"; b.lockedAt = at(); db.save();
  receipts.issue(Object.assign(b, { ap2: ap2.hashesFor(b.id) }), negotiation(b.negotiation), "locked");
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
  receipts.issue(Object.assign(b, { ap2: ap2.hashesFor(b.id) }), negotiation(b.negotiation), "refunded");
  note(b, { kind: "platform" }, "refunded", why);
}

// One pass over the bookings that are waiting on time or on PayPal. The server runs it every few seconds.
// Demo only (server.js allows it in demo mode): the time for shares runs out now
// Demo only: the game is over now (rather than at its end time), so the venue is paid with PayPal Payouts at once
export async function endNow(bookingId) {
  const b = get(bookingId);
  if (!b || b.state !== "locked") return { error: "not_locked", message: "Only a paid and locked booking can be played." };
  b.state = "played"; b.endedEarly = true; db.save();
  note(b, { kind: "platform" }, "played", "The game is over (ended early in the demo).");
  await tick();
  return view(b, b.organizer);
}
export async function expireNow(bookingId) {
  const b = get(bookingId);
  if (!b || b.state !== "held") return { error: "not_held", message: "Only a booking waiting for shares can run out of time." };
  b.holdUntil = clock().getTime() - 1; db.save();
  await tick();
  return view(b, b.organizer);
}

export async function tick() {
  const now = clock().getTime();
  await checkSettlements();
  for (const b of db.data.bookings) {
    const owed = Object.values(b.reimbursements || {}).some((r) => r.status === "sent") || (b.bills || []).some((x) => x.status === "sent" || x.status === "paid");
    if (!owed && (!LIVE.includes(b.state) || b.state === "venue_paid" && !unsettled(b.payout))) continue;
    // (each booking waits at most 60 s here, so one stuck on a slow PayPal call can't hold up the others; its own queue
    // carries on, and the next tick picks it up again)
    await Promise.race([serial(b.id, async () => {
      // payers who approved but never came back to the return URL
      for (const [pid, p] of Object.entries(b.payments)) {
        if (p.status !== "awaiting_approval" || !p.orderId) continue;
        try { const o = await pp.getOrder(p.orderId); if (o.status === "APPROVED") setTimeout(() => approved(b.id, pid), 0); } catch {}
      }
      if (b.state === "awaiting_organizer" && now > b.organizerUntil) await release(b, "released", `${name(b.organizer)} didn't authorize in time, so ${venue(b.venue).name} has ${place(b)} back. Nobody was charged.`);
      else if (b.state === "held" && now > b.holdUntil) await lock(b, "the time to pay ran out");
      else if (b.state === "locking") await lock(b, "resumed"); // (interrupted: a refused capture, or a restart)
      else if (b.state === "locked" && now > startOf(b.date, b.start).getTime() + b.minutes * 60e3) { b.state = "played"; db.save(); note(b, { kind: "platform" }, "played", "The game is over."); }
      if (b.state === "played" && !b.payout) await payVenue(b);
      await checkReimbursements(b);
      await checkBills(b);
      if (unsettled(b.payout)) {
        try { const r = await pp.getPayout(b.payout.batchId); if (r.status !== b.payout.status) { b.payout.status = r.status; b.payout.item = r.item; db.save(); note(b, { kind: "paypal" }, "payout_status", `PayPal Payouts: the venue's payment is ${String(r.item || r.status).toLowerCase()}.`); } } catch {}
      }
    }), new Promise((ok) => setTimeout(ok, 60e3).unref?.())]);
  }
}

async function payVenue(b) {
  const v = venue(b.venue);
  const net = Object.values(b.payments).filter((p) => p.status === "captured").reduce((a, p) => a + (p.net ?? p.captured ?? p.amount), 0);
  try {
    const r = await paypalStep(b, "payout", () => pp.payout({ batchId: `join-${b.id}`, receiver: v.payee, amount: net, note: `Join: ${place(b)}, ${b.activity}, ${b.date} ${b.start}` }));
    b.payout = { batchId: r.batchId, status: "PENDING", amount: net, receiver: v.payee }; b.state = "venue_paid"; db.save();
    receipts.issue(Object.assign(b, { ap2: ap2.hashesFor(b.id) }), negotiation(b.negotiation), "venue_paid");
    note(b, { kind: "platform" }, "venue_paid", `Sent ${v.name} $${usd(net)} with PayPal Payouts (the $${usd(b.total)} paid, less PayPal's fees).`);
  } catch (e) { b.payout = null; journal(b, "payout", "will_retry"); }
}

// ---- what players and agents can do -----------------------------------------------------------------------------
// The demo town's residents have agents too (simulated): a while after they are invited, each one joins and pays if
// the activity is one they like and their share is within their own per-booking limit, and otherwise says they can't
// come. So an outside agent organizing in the demo town sees friends answer, as real friends' agents would. Someone
// who has already answered for them (the demo panel) goes first. RESIDENT_AGENT_MS sets the wait (0: they never answer).
let RESIDENT_MS = process.env.RESIDENT_AGENT_MS != null ? +process.env.RESIDENT_AGENT_MS : 90e3;
function residentsAnswer(b) {
  if (!RESIDENT_MS) return;
  b.players.filter((pid) => pid !== b.organizer && player(pid) && !player(pid).joined).forEach((pid, i) => setTimeout(() => serial(b.id, async () => {
    if (b.state !== "held" || b.payments[pid] || b.declined.includes(pid)) return;
    const p = player(pid), m = getMandate(pid), likes = (p.interests || []).includes(b.activity), fits = b.shares[pid] <= m.perGame;
    record({ actor: { kind: "agent", player: pid, client: "simulated resident" }, who: [pid, b.organizer], action: likes && fits ? "joined" : "declined", ref: b.id,
      summary: likes && fits ? `${name(pid)}'s agent (a simulated resident) is in: ${name(pid)} likes ${b.activity}, and $${usd(b.shares[pid])} is within their limit.` : `${name(pid)}'s agent (a simulated resident) says ${name(pid)} can't come${!likes ? `: not one for ${b.activity}` : `: $${usd(b.shares[pid])} is over their $${usd(m.perGame)} limit`}.` });
    if (likes && fits) {
      await startPayment(b, pid, b.shares[pid], "share");
      // (on the stand-in, the resident approves at once, as a person with saved PayPal would)
      if (b.payments[pid]?.status === "awaiting_approval" && pp.mode === "mock") { pp.approve({ token: b.payments[pid].orderId }); setTimeout(() => approved(b.id, pid), 0); }
    } else { b.declined.push(pid); db.save(); }
    await advance(b);
  }).catch(() => {}), RESIDENT_MS + i * Math.min(15e3, RESIDENT_MS)).unref?.());
}
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
  return { result: `Asked to pay $${usd(amount)} instead of $${usd(ask.from)}. Waiting for ${name(b.organizer)} (or their agent) to agree or keep the share; paying before that pays whatever share then stands.`, ...view(b, playerId) };
}

export function answerShare(bookingId, organizerId, playerId, accept) {
  const b = get(bookingId);
  if (!b || b.organizer !== organizerId) return { error: "not_organizer", message: "Only the organizer answers." };
  const ask = (b.shareAsks || []).find((x) => x.player === playerId && x.status === "pending");
  if (!ask) return { error: "no_ask", message: "No open ask from that player." };
  if (b.state !== "held" || b.payments[playerId]) { ask.status = "expired"; db.save(); return { error: "too_late", message: "That ask is no longer open." }; }
  const diff = b.shares[playerId] - ask.amount, f = fits(organizerId, { venue: b.venue, share: b.shares[organizerId] + diff, spentThisWeek: spentAround(organizerId, b) });
  if (accept && !f.ok) {
    ask.status = "refused"; db.save();
    record({ actor: { kind: "platform" }, who: [playerId, organizerId], action: "share_refused", ref: b.id, summary: `${name(organizerId)}'s agent can't take on $${usd(diff)} more: ${f.why.join("; ")}.` });
    return { error: "over_mandate", message: `Can't accept: ${f.why.join("; ")}. ${name(playerId)}'s ask is now refused and their share stays $${usd(b.shares[playerId])}; their agent is told.`, booking: view(b, organizerId) };
  }
  ask.status = accept ? "accepted" : "refused"; ask.answered = at();
  if (accept) { b.shares[playerId] = ask.amount; b.shares[organizerId] += diff; b.splitRule = "negotiated"; }
  db.save();
  record({ actor: { kind: "agent", player: organizerId }, who: [playerId, organizerId], action: accept ? "share_accepted" : "share_refused", ref: b.id, summary: accept ? `${name(organizerId)}'s agent agreed: ${name(playerId)} pays $${usd(ask.amount)}, ${name(organizerId)} covers $${usd(diff)} more.` : `${name(organizerId)}'s agent kept ${name(playerId)}'s share at $${usd(b.shares[playerId])}.` });
  return { result: accept ? `Accepted: ${name(playerId)} pays $${usd(ask.amount)}, your share is now $${usd(b.shares[organizerId])}.` : `Refused: ${name(playerId)}'s share stays $${usd(b.shares[playerId])}.`, ...view(b, organizerId) };
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
    payments: Object.fromEntries(b.players.map((pid) => { const p = b.payments[pid]; return [pid, { share: usd(b.shares[pid]), ...(pid === b.organizer ? { guarantee: usd(b.total), paid: p?.captured != null ? usd(p.captured) : null } : {}), role: pid === b.organizer ? "organizer" : "share", status: b.declined.includes(pid) ? "declined" : p?.status || (pid !== b.organizer && b.state === "held" ? "invited" : "not_started"), via: p?.via || null, paypal: p ? { order: p.orderId || null, authorization: p.authorizationId || null, capture: p.captureId || null } : null }]; })),
    review: viewer ? (reviewsMod.byPlayer(viewer, b.id) ? { done: reviewsMod.byPlayer(viewer, b.id).stars } : canReview(b, viewer).ok ? { can: true } : null) : null,
    invite: viewer !== b.organizer && b.state === "held" && !mine && !b.declined.includes(viewer) ? { share: usd(b.shares[viewer]), payBy: new Date(b.holdUntil).toISOString() } : null,
    you: mine ? { share: usd(b.shares[viewer]), ...(mine.role === "organizer" ? { guarantee: usd(b.total) } : {}), authorized: usd(mine.amount), paid: mine.status === "captured" ? usd(mine.captured ?? mine.amount) : "0.00", status: mine.status, via: mine.via,
      approveUrl: mine.status === "awaiting_approval" ? mine.approveUrl : null, orderId: mine.status === "awaiting_approval" ? mine.orderId : null, ...(mine.status === "awaiting_approval" && mine.why ? { note: mine.why } : {}),
      paypal: { order: mine.orderId, authorization: mine.authorizationId, capture: mine.captureId } } : null,
    payout: b.payout ? { amount: usd(b.payout.amount), status: b.payout.item || b.payout.status } : null,
    reimbursements: Object.values(b.reimbursements || {}).filter((r) => viewer === b.organizer || r.player === viewer).map((r) => ({ player: r.player, amount: usd(r.amount), status: r.status, url: r.player === viewer && r.status === "sent" ? r.url : undefined })),
    extras: (b.bills || []).map((x) => ({ total: usd(x.total), items: x.items.map((i) => i.name), status: x.status, url: viewer === b.organizer && x.status === "sent" ? x.url : undefined })),
    owes: b.reimbursements?.[viewer]?.status === "sent" ? { amount: usd(b.reimbursements[viewer].amount), url: b.reimbursements[viewer].url } : null,
    shareChanges: (b.shareAsks || []).filter((x) => x.status === "accepted").map((x) => ({ player: x.player, from: usd(x.from), to: usd(x.amount), coveredBy: b.organizer, note: `${name(x.player)} pays $${usd(x.amount)} instead of $${usd(x.from)}; ${name(b.organizer)} covers the $${usd(x.from - x.amount)}.` })),
    split: b.splitRule || "even", shareAsks: (b.shareAsks || []).filter((x) => viewer === b.organizer || x.player === viewer).map((x) => ({ ...x, from: usd(x.from), amount: usd(x.amount) })),
    paypal: paypalMode(), receipts: receipts.forBooking(b.id),
  };
}

// once the steps queued for a booking are done (at most `ms`): an agent's reply then says what is true, e.g. that the
// guarantee it just triggered is already authorized
export const settled = (bookingId, ms = 15e3) => Promise.race([chains.get(bookingId) || Promise.resolve(), new Promise((ok) => setTimeout(ok, ms).unref?.())]);
export const status = (bookingId, viewer) => { const b = get(bookingId); return b && b.players.includes(viewer) ? view(b, viewer) : { error: "no_booking", message: "No such booking." }; };
const DONE = ["released", "cancelled", "refunded"];
export const mine = (viewer, { all = false } = {}) => db.data.bookings.filter((b) => b.players.includes(viewer) && (all || (!DONE.includes(b.state) && !b.declined.includes(viewer) && startOf(b.date, b.start).getTime() + b.minutes * 60e3 > clock().getTime() - 2 * 864e5))).map((b) => view(b, viewer)).reverse();
export const forVenue = (venueId) => db.data.bookings.filter((b) => b.venue === venueId).map((b) => ({ id: b.id, state: b.state, activity: b.activity, date: b.date, start: b.start, minutes: b.minutes, unit: b.unit, unitName: place(b), total: usd(b.total), players: b.players.length, paid: Object.values(b.payments).filter((p) => p.status === "captured").length, payout: b.payout ? usd(b.payout.amount) : null, captures: Object.values(b.payments).map((p) => p.captureId).filter(Boolean), extras: (b.bills || []).map((x) => ({ invoice: x.invoiceId, url: x.url, to: player(b.organizer).paypal, items: x.items.map((i) => ({ name: i.name, amount: usd(i.amount) })), total: usd(x.total), status: x.status })), disputes: Object.keys(b.disputes || {}).length }));
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

// ---- reviews: who may review a booking -----------------------------------------------------------------------------
// Someone who was in it and paid (the organizer, or anyone whose share was captured), once it's locked and has started.
// (In demo mode a locked booking can be reviewed before it starts, so the demo doesn't have to wait for the game.)
let demoReviews = false;
export const allowEarlyReviews = (on) => { demoReviews = !!on; };
export function canReview(b, playerId) {
  if (!b || !b.players.includes(playerId)) return { error: "not_in_booking", message: "Only people in this booking can review it." };
  if (!["locked", "played", "venue_paid"].includes(b.state)) return { error: "not_yet", message: "You can review a booking once it's paid and locked." };
  const p = b.payments[playerId];
  if (playerId !== b.organizer && p?.status !== "captured") return { error: "not_paid", message: "Only people who paid for this booking can review it." };
  if (!demoReviews && clock() < startOf(b.date, b.start)) return { error: "not_yet", message: "You can review it once it has started." };
  return { ok: true };
}

// ---- balances with friends, across plans ----------------------------------------------------------------------------
// What friends owe each other on Join: only a share someone joined (said yes to) and didn't pay, which the organizer
// covered. Someone who declined or never answered owes nothing. Across several plans, debts between the same two people
// are netted, and the whole group's balances are reduced to the fewest payments that settle them. Settling up with a
// friend sends one PayPal invoice for the net amount instead of one per plan; when it's paid, the organizer is paid with
// Payouts. A debt already invoiced on its own (Plans, "Ask to be paid back") is left to that invoice.
function debts() {
  const out = [];
  for (const b of db.data.bookings) {
    if (!["locked", "played", "venue_paid"].includes(b.state)) continue;
    for (const pid of b.players) {
      const p = b.payments[pid];
      if (pid === b.organizer || b.declined.includes(pid) || !p || p.status === "captured") continue;
      const own = b.reimbursements?.[pid], net = db.data.settlements.find((s) => s.items.includes(`${b.id}:${pid}`));
      out.push({ key: `${b.id}:${pid}`, booking: b.id, activity: b.activity, date: b.date, venue: venue(b.venue)?.name, from: pid, to: b.organizer, amount: b.shares[pid],
        status: own ? `invoice ${own.status}` : net ? `settled together: ${net.status}` : "open" });
    }
  }
  return out;
}
// the fewest payments that settle everyone's balance (largest debtor pays largest creditor, repeat)
function fewest(balances) {
  const cred = Object.entries(balances).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]), debt = Object.entries(balances).filter(([, v]) => v < 0).map(([k, v]) => [k, -v]).sort((a, b) => b[1] - a[1]);
  const pay = [];
  while (cred.length && debt.length) {
    const x = Math.min(cred[0][1], debt[0][1]);
    pay.push({ from: debt[0][0], to: cred[0][0], amount: usd(x) });
    cred[0][1] -= x; debt[0][1] -= x;
    if (!cred[0][1]) cred.shift(); if (!debt[0][1]) debt.shift();
    cred.sort((a, b) => b[1] - a[1]); debt.sort((a, b) => b[1] - a[1]);
  }
  return pay;
}
export function ledger(viewer) {
  const all = debts(), mine = all.filter((d) => d.from === viewer || d.to === viewer), open = all.filter((d) => d.status === "open");
  const withFriend = {};
  for (const d of mine.filter((x) => x.status === "open")) { const f = d.from === viewer ? d.to : d.from; withFriend[f] = (withFriend[f] || 0) + (d.to === viewer ? d.amount : -d.amount); }
  // the group: everyone connected to the viewer by an open debt
  const group = new Set([viewer, ...Object.keys(withFriend)]), balances = {};
  for (const d of open.filter((x) => group.has(x.from) && group.has(x.to))) { balances[d.to] = (balances[d.to] || 0) + d.amount; balances[d.from] = (balances[d.from] || 0) - d.amount; }
  return { items: mine.map((d) => ({ ...d, amount: usd(d.amount) })),
    friends: Object.entries(withFriend).filter(([, v]) => v).map(([friend, v]) => ({ friend, name: name(friend), owesYou: usd(Math.max(0, v)), youOwe: usd(Math.max(0, -v)) })),
    fewestPayments: fewest(balances).map((t) => ({ ...t, fromName: name(t.from), toName: name(t.to) })),
    settlements: db.data.settlements.filter((s) => s.to === viewer || s.from === viewer).map(({ items, ...s }) => ({ ...s, amount: usd(s.amount), plans: items.length })) };
}
export async function settleUp(viewer, friend) {
  const open = debts().filter((d) => d.status === "open" && ((d.from === friend && d.to === viewer) || (d.from === viewer && d.to === friend)));
  const net = open.reduce((a, d) => a + (d.to === viewer ? d.amount : -d.amount), 0);
  if (net <= 0) return { error: "nothing_owed", message: net < 0 ? `You owe ${name(friend)} $${usd(-net)}; they can settle up with you.` : `Nothing open between you and ${name(friend)}.` };
  const s = { id: `set_${crypto.randomBytes(5).toString("hex")}`, from: friend, to: viewer, amount: net, items: open.map((d) => d.key), status: "creating", at: at() };
  db.data.settlements.push(s); db.save();
  try {
    const inv = await pp.invoice({ recipient: player(friend).paypal, amount: net, item: `Settling up on Join: ${open.length} plan${open.length > 1 ? "s" : ""} with ${name(viewer)}, netted`, note: `${open.map((d) => `${d.activity} ${d.date}: ${d.from === friend ? "+" : "-"}$${usd(d.amount)}`).join("; ")}`, requestId: `settle:${s.id}` });
    Object.assign(s, { invoiceId: inv.id, url: inv.url, status: "sent" }); db.save();
    record({ actor: { kind: "platform" }, who: [viewer, friend], action: "settle_up", ref: s.id, summary: `${name(viewer)} settled up with ${name(friend)}: one PayPal invoice for $${usd(net)}, netting ${open.length} plan${open.length > 1 ? "s" : ""} instead of one invoice each.` });
  } catch (e) { s.status = "failed"; s.error = e.message; db.save(); return { error: "paypal", message: e.message }; }
  return { settlement: s.id, amount: usd(net), plans: open.length, url: s.url };
}
async function checkSettlements() {
  for (const s of db.data.settlements.filter((x) => x.status === "sent")) {
    try {
      const inv = await pp.getInvoice(s.invoiceId);
      if (inv.status !== "PAID" && inv.status !== "MARKED_AS_PAID") continue;
      s.status = "paid"; db.save();
      const out = await pp.payout({ batchId: `join-settle-${s.id}`, receiver: player(s.to).paypal, amount: s.amount, note: `Join: ${name(s.from)} settled up with you` });
      Object.assign(s, { status: "repaid", payout: out.batchId }); db.save();
      record({ actor: { kind: "platform" }, who: [s.to, s.from], action: "organizer_repaid", ref: s.id, summary: `${name(s.from)} paid the settle-up invoice; sent ${name(s.to)} $${usd(s.amount)} with PayPal Payouts.` });
    } catch (e) { s.error = e.message; db.save(); }
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
  // (the same extras for the same booking are one bill: asking again returns the invoice already sent)
  const key = JSON.stringify(clean), dup = (b.bills || []).find((x) => JSON.stringify(x.items) === key && x.status !== "cancelled");
  if (dup) return { invoice: dup.invoiceId, url: dup.url, total: usd(dup.total), status: dup.status, already: true };
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
export const reconcileVenue = (venueId) => toolkit.reconcile(db.data.bookings.filter((b) => b.venue === venueId), (id) => pp.getCapture(id));
export async function venueDisputes(venueId) {
  const mine = db.data.bookings.filter((b) => b.venue === venueId), byCapture = new Map();
  for (const b of mine) for (const p of Object.values(b.payments)) if (p.captureId) byCapture.set(p.captureId, b.id);
  const list = await toolkit.disputes([...byCapture.keys()]);
  return list.map((d) => ({ ...d, booking: d.transactions.map((t) => byCapture.get(t)).find(Boolean) || null, receipt: receipts.forBooking(d.transactions.map((t) => byCapture.get(t)).find(Boolean) || "").at(-1)?.id || null }));
}
// What Join did for a venue, counted from its bookings (nothing estimated): what groups paid, how much of it came in
// off-peak, what haggling cost, what organizers covered for friends who didn't pay (money the venue would otherwise be
// chasing), whether any booking was paid short, and what was paid out to the venue.
export function venueMetrics(venueId) {
  const all = db.data.bookings.filter((b) => b.venue === venueId), paid = all.filter((b) => ["locked", "played", "venue_paid"].includes(b.state));
  const sum = (xs, f) => xs.reduce((a, x) => a + (f(x) || 0), 0);
  const offPeak = paid.filter((b) => (negotiation(b.negotiation)?.discounts || []).some((d) => d.kind === "off-peak"));
  const captured = (b) => sum(Object.values(b.payments), (p) => (p.status === "captured" ? p.captured ?? p.amount : 0));
  const covered = (b) => Math.max(0, (b.payments[b.organizer]?.captured ?? 0) - b.shares[b.organizer]);
  return {
    bookings: { paid: paid.length, released: all.filter((b) => b.state === "released").length, cancelled: all.filter((b) => ["cancelled", "refunded"].includes(b.state)).length, open: all.filter((b) => ["awaiting_organizer", "held", "locking"].includes(b.state)).length },
    revenue: usd(sum(paid, (b) => b.total)),
    offPeak: { bookings: offPeak.length, revenue: usd(sum(offPeak, (b) => b.total)), share: paid.length ? Math.round((100 * offPeak.length) / paid.length) : 0 },
    haggledOff: usd(sum(paid, (b) => (negotiation(b.negotiation)?.list || b.total) - b.total)),
    coveredByOrganizers: { amount: usd(sum(paid, covered)), bookings: paid.filter((b) => covered(b) > 0).length },
    shortfall: usd(sum(paid, (b) => Math.max(0, b.total - captured(b)))),
    paidOut: { amount: usd(sum(all.filter((b) => b.payout), (b) => b.payout.amount)), bookings: all.filter((b) => b.payout).length },
    disputes: { opened: sum(all, (b) => Object.keys(b.disputes || {}).length), answered: sum(all, (b) => Object.values(b.disputes || {}).filter((d) => d.status === "evidence_sent").length) },
  };
}

// Join's answer to a chargeback: the booking's signed receipt (the negotiation, each payment and its PayPal ids, its
// Merkle path and audit-log entries), and how the disputed payment was approved: by the payer in PayPal, or from their
// saved PayPal within limits only they can set (the mandate, AP2's intent mandate). The venue can send it (answerDispute),
// and Join sends it by itself the moment PayPal reports a dispute (the webhook), so nobody has to notice in time.
async function defend(b, disputeId, payerId, by) {
  const rid = receipts.forBooking(b.id).at(-1)?.id;
  if (!rid) return { error: "no_receipt", message: "This booking has no receipt yet." };
  const r = receipts.show(rid), p = payerId ? b.payments[payerId] : null, m = payerId ? getMandate(payerId) : null;
  const how = !p ? "" : p.via === "vault" ? ` The disputed payment was made from the payer's saved PayPal by their own agent, within limits only the payer can set on Join (at most $${usd(m.perGame)} a booking, $${usd(m.perWeek)} a week); authorization ${p.authorizationId}, capture ${p.captureId}.`
    : p.via === "sandbox test card" ? ` The disputed payment was authorized with PayPal's sandbox test card for a demo, not approved by the payer in PayPal (order ${p.orderId}, authorization ${p.authorizationId}, capture ${p.captureId}).`
    : ` The payer approved the disputed payment themselves in PayPal (order ${p.orderId}, authorization ${p.authorizationId}, capture ${p.captureId}).`;
  const notes = `Join booking ${b.id}: ${b.activity} at ${venue(b.venue).name}, ${b.date} ${b.start}, ${place(b)}, $${usd(b.total)} for ${b.players.length} people, locked ${b.lockedAt || ""}.${how} The attached receipt is signed by Join (Ed25519, key ${r.kid}) and lists the negotiation and every payment with its PayPal ids; it is in Join's audit log as entry #${r.batch?.log ?? "(next batch)"}. Verify it at ${publicUrl}/#/receipt/${rid}.`;
  await pp.provideEvidence(disputeId, { notes: `${notes} The AP2 mandates (checkout, and each payment with Join's mandate receipt) are attached alongside the receipt.`, file: JSON.stringify({ receipt: r, ap2: ap2.forBooking(b.id) }) });
  (b.disputes ||= {})[disputeId] = { ...(b.disputes?.[disputeId] || {}), status: "evidence_sent", receipt: rid, by, at: at() }; db.save();
  record({ actor: by === "join" ? { kind: "platform" } : { kind: "venue", venue: b.venue }, who: [...b.players], action: "dispute_answered", ref: b.id,
    summary: `${by === "join" ? "Join" : venue(b.venue).name} answered PayPal dispute ${disputeId} with the booking's signed receipt${p ? ` and how ${name(payerId)}'s payment was approved` : ""}.` });
  return { dispute: disputeId, status: "evidence_sent", receipt: rid };
}
export async function answerDispute(venueId, disputeId) {
  const d = (await venueDisputes(venueId)).find((x) => x.id === disputeId);
  if (!d || !d.booking) return { error: "no_dispute", message: "No such dispute on this venue's bookings." };
  const b = get(d.booking), payer = Object.entries(b.payments).find(([, p]) => d.transactions.includes(p.captureId))?.[0] || null;
  return defend(b, disputeId, payer, "venue");
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
    if (!hit) return null;
    if (hit.b.disputes?.[r.dispute_id]) return { ok: true }; // (PayPal may send an event twice)
    (hit.b.disputes ||= {})[r.dispute_id] = { status: "open", reason: r.reason, payer: hit.pid, at: at() }; db.save();
    record({ actor: { kind: "paypal" }, who: [hit.b.organizer], action: "dispute_opened", ref: hit.b.id, summary: `PayPal: a dispute was opened on ${name(hit.pid)}'s payment for this booking (${String(r.reason || "").toLowerCase().replace(/_/g, " ")}).` });
    // answer it at once, with the evidence Join already holds
    const d = await serial(hit.b.id, () => defend(hit.b, r.dispute_id, hit.pid, "join")).catch((e) => ({ error: e.message }));
    if (d?.error) { hit.b.disputes[r.dispute_id].error = d.message || d.error; db.save(); }
    return { ok: true, defense: d };
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

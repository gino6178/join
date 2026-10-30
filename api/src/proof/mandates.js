// AP2 mandates (Agent Payments Protocol, github.com/google-agentic-commerce/AP2, schemas in code/sdk/schemas/ap2):
// signed statements of what a person let an agent do, and what was then done, that any verifier can check.
//
// Join follows AP2's "Trusted Agent Provider" model: Join is the agent provider, the Limits page (signed in as the
// person, never an agent's token) is the trusted surface where they consent, and Join signs with its own key (the one
// published at /.well-known/join-receipts.json), never reachable by an agent. Each mandate is a compact JWS (EdDSA)
// whose payload follows AP2's JSON schema field for field; selective disclosure (SD-JWT) is not used.
//
//   Open Checkout Mandate  mandate.checkout.open.1  what the agent may book: the allowed venues, one booking of an activity
// (Units as AP2's schemas define them: payment.amount_range's min and max are integers in minor units (cents);
// payment.budget's max is a plain number, so it is in dollars here.)
//   Open Payment Mandate   mandate.payment.open.1   what it may authorize in one payment (payment.amount_range: the
//                                                   per-booking limit, or as an organizer the whole price it may
//                                                   guarantee from saved PayPal, the `cover` limit, whichever is more),
//                                                   the person's own share per booking (join.share_max, Join's own
//                                                   constraint, outside AP2's schema),
//                                                   at most the weekly limit (payment.budget, recurring weekly), only to
//                                                   allowed venues, only for a checkout the open checkout mandate allows
//   Checkout Mandate       mandate.checkout.1       the agreed booking: a checkout JWT (venue, activity, time, price) and
//                                                   its hash, which identifies the transaction
//   Payment Mandate        mandate.payment.1        each payer's payment for that checkout: payee, amount, PayPal instrument
//   Mandate Receipt        (a JWT)                  Join, as verifier, says whether the agent's action fit the mandates
// Open mandates are bound (cnf, RFC 7800) to the agent's token id, so a mandate made for one agent can't be presented by another.
import crypto from "node:crypto";
import { store, stateFile } from "../store.js";
import { signBytes, verifyBytes, publicKey } from "./receipts.js";

const db = store(stateFile("mandates-ap2"), { open: {}, bookings: {} });
export const mandatesAp2Store = db;
let issuer = "http://localhost:8790";
export const setIssuer = (url) => { issuer = url; };

const b64u = (x) => Buffer.from(x).toString("base64url");
const now = () => Math.floor(Date.now() / 1000);
const hashB64u = (s) => crypto.createHash("sha256").update(s).digest("base64url");
const PAYPAL = { legal_name: "PayPal, Inc.", brand_name: "PayPal", domain_name: "paypal.com" };

export function sign(payload, typ = "JWT") {
  const head = b64u(JSON.stringify({ alg: "EdDSA", typ, kid: publicKey().kid }));
  const body = b64u(JSON.stringify(payload));
  return `${head}.${body}.${signBytes(Buffer.from(`${head}.${body}`)).toString("base64url")}`;
}
export function verify(jws, { at = now() } = {}) {
  const [h, p, s] = String(jws).split(".");
  if (!s) return null;
  if (!verifyBytes(Buffer.from(`${h}.${p}`), Buffer.from(s, "base64url"))) return null;
  const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  return payload.exp && payload.exp < at ? null : payload; // (an expired mandate verifies as nothing)
}

// AP2's action authorization: the agent presents its open payment mandate with an action that can commit money (an
// offer, an accept, a payment), and Join, as the verifier, checks it before anything else happens: Join's signature,
// not expired, for this person, bound to this agent's token (cnf.kid), still the person's current one (made again
// whenever they change a limit, so an older, looser one stops working), and its constraints: the share within
// what is authorized (the share, or an organizer's whole guarantee) within payment.amount_range, the person's own share
// within join.share_max, the week's spending plus the share within payment.budget, the venue among
// payment.allowed_payees. Join is both the mandates' issuer and their verifier (AP2's Trusted Agent Provider role), so a
// mandate proves nothing a token couldn't by itself: its worth is that every refusal and every deal is a signed record
// of which limits applied, which goes into receipts and dispute evidence.
// Returns { ok, payload } or { error: "invalid_mandate" | "mandate_required", message, receipt } (an AP2 error receipt).
export function authorize(jws, { player, agentKid, venue, share, authorized = share, spentThisWeek = 0 }) {
  const no = (error, message) => ({ error, message, receipt: jws ? mandateReceipt(jws, { ok: false, error: "invalid_mandate", why: message }) : null });
  if (!jws) return no("mandate_required", "Present your open payment mandate (whoami returns it as ap2.openPaymentMandate) with offers, accepts and payments.");
  const m = verify(jws);
  if (!m || m.vct !== "mandate.payment.open.1") return no("invalid_mandate", "That mandate doesn't verify with Join's key, or it has expired.");
  if (m.sub !== player) return no("invalid_mandate", "That mandate is for someone else.");
  if (m.cnf?.kid !== agentKid) return no("invalid_mandate", "That mandate was made for another agent (its cnf.kid isn't your token).");
  const cur = openFor(player, agentKid);
  if (!cur || cur.payment !== jws) return no("invalid_mandate", "That mandate has been replaced: the person changed their limits. Get the current one from whoami.");
  const c = (t) => m.constraints.find((x) => x.type === t);
  if (c("payment.amount_range") && authorized > c("payment.amount_range").max) return no("invalid_mandate", `Authorizing $${(authorized / 100).toFixed(2)} is over the mandate's amount_range ($${(c("payment.amount_range").max / 100).toFixed(2)}).`);
  if (c("join.share_max") && share > c("join.share_max").max) return no("invalid_mandate", `The share ($${(share / 100).toFixed(2)}) is over the mandate's per-booking limit ($${(c("join.share_max").max / 100).toFixed(2)}).`);
  if (c("payment.budget") && spentThisWeek + share > Math.round(c("payment.budget").max * 100)) return no("invalid_mandate", `That would take this week over the mandate's budget ($${c("payment.budget").max.toFixed(2)}).`);
  if (c("payment.allowed_payees") && !c("payment.allowed_payees").allowed.some((x) => x.id === venue)) return no("invalid_mandate", "That venue isn't among the mandate's allowed payees.");
  return { ok: true, payload: m };
}
export const digest = hashB64u;

const merchant = (v) => ({ id: v.id, name: v.name });

// The open mandates for one agent of one person, signed when the person sets their limits (or the agent is connected).
// `agentKid` is the agent's token id (or "website-agent"), `m` the mandate (cents), `venues` the town's venues.
export function issueOpen(playerId, agentKid, m, venues, activities, keyX = null) { // (m.updated is kept, to know when the limits change)
  // (bound to the agent's token; with its public key too when the token has one: proof of possession is then the
  // RFC 9421 signature every request of that token must carry)
  const iat = now(), exp = iat + 30 * 86400, cnf = { kid: agentKid, ...(keyX ? { jwk: { kty: "OKP", crv: "Ed25519", x: keyX } } : {}) };
  const allowed = (m.venues ? venues.filter((v) => m.venues.includes(v.id)) : venues).map(merchant);
  const checkout = sign({ iss: issuer, sub: playerId, vct: "mandate.checkout.open.1", iat, exp, cnf,
    constraints: [
      { type: "checkout.allowed_merchants", allowed },
      { type: "checkout.line_items", items: [{ id: "booking", quantity: 1, acceptable_items: activities.map((a) => ({ id: a.id, title: a.name })) }] },
    ] });
  const payment = sign({ iss: issuer, sub: playerId, vct: "mandate.payment.open.1", iat, exp, cnf,
    constraints: [
      { type: "payment.reference", conditional_transaction_id: hashB64u(checkout) },
      { type: "payment.amount_range", currency: "USD", max: Math.max(m.perGame, m.cover ?? 0) },
      { type: "join.share_max", currency: "USD", max: m.perGame },
      { type: "payment.agent_recurrence", frequency: "WEEKLY" },
      { type: "payment.budget", max: m.perWeek / 100, currency: "USD" },
      { type: "payment.allowed_payees", allowed },
      { type: "payment.allowed_pisps", allowed: [PAYPAL] },
    ] });
  (db.data.open[playerId] ||= {})[agentKid] = { checkout, payment, iat, exp, at: Date.now(), limits: m.rev || 0 };
  db.save();
  return { checkout, payment };
}
export const openFor = (playerId, agentKid) => db.data.open[playerId]?.[agentKid] || null;

// A deal: the checkout (as the venue's terms, signed by Join for the venue) and its Checkout Mandate, presented under the
// organizer agent's open mandates; then the Mandate Receipt for that action.
export function issueCheckout(b, { venue, activity, organizerKid, result }) {
  const iat = now(), exp = iat + 86400;
  const checkout_jwt = sign({ iss: issuer, merchant: merchant(venue), id: b.id,
    line_items: [{ id: "booking", item: { id: activity.id, title: activity.name, price: b.total }, quantity: 1 }],
    total: { amount: b.total, currency: "USD" }, booking: { date: b.date, start: b.start, minutes: b.minutes, unit: b.unit, people: b.players.length } });
  const checkout_hash = hashB64u(checkout_jwt);
  const mandate = sign({ iss: issuer, sub: b.organizer, vct: "mandate.checkout.1", checkout_jwt, checkout_hash, iat, exp,
    ...(organizerKid ? { cnf: { kid: organizerKid } } : {}) });
  const rec = { checkout_jwt, checkout_hash, mandate, open: organizerKid ? openFor(b.organizer, organizerKid) : null, payments: {}, receipts: [] };
  rec.receipts.push(mandateReceipt(mandate, result));
  db.data.bookings[b.id] = rec; db.save();
  return rec;
}

// Each payer's Payment Mandate: the amount they authorize (the organizer's guarantee is the whole price) to the venue,
// through PayPal, for that checkout
export function issuePayment(b, playerId, { amount, instrument, venue, agentKid = null, result = { ok: true } }) {
  const rec = db.data.bookings[b.id];
  if (!rec) return null;
  const iat = now();
  const mandate = sign({ iss: issuer, sub: playerId, vct: "mandate.payment.1", transaction_id: rec.checkout_hash, payee: merchant(venue), pisp: PAYPAL,
    payment_amount: { amount, currency: "USD" }, payment_instrument: instrument, iat, exp: iat + 86400, ...(agentKid ? { cnf: { kid: agentKid } } : {}) });
  rec.payments[playerId] = { mandate, receipt: mandateReceipt(mandate, result) };
  db.save();
  return rec.payments[playerId];
}

// AP2's Mandate Receipt: the verifier's signed answer, referring to the mandate by its hash
export function mandateReceipt(mandate, { ok = true, error = null, why = null } = {}) {
  return sign({ iss: issuer, iat: now(), result: ok ? "success" : "error", reference: hashB64u(mandate), ...(ok ? {} : { error: error || "invalid_mandate", error_description: why }) });
}

// Everything for a booking, as a verifier would want it: the JWS strings and their decoded payloads
export function forBooking(bookingId) {
  const r = db.data.bookings[bookingId];
  if (!r) return null;
  const dec = (j) => (j ? { jws: j, payload: verify(j) } : null);
  return { checkout_hash: r.checkout_hash, checkout: dec(r.checkout_jwt), checkoutMandate: dec(r.mandate), open: r.open ? { checkout: dec(r.open.checkout), payment: dec(r.open.payment) } : null,
    payments: Object.fromEntries(Object.entries(r.payments).map(([pid, x]) => [pid, { mandate: dec(x.mandate), receipt: dec(x.receipt) }])), receipts: r.receipts.map(dec) };
}
export const hashesFor = (bookingId) => { const r = db.data.bookings[bookingId]; return r ? { checkout: r.checkout_hash, payments: Object.fromEntries(Object.entries(r.payments).map(([p, x]) => [p, hashB64u(x.mandate)])) } : null; };

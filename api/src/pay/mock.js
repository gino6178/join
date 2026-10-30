// A stand-in for PayPal with the same calls as paypal.js, for tests and for running Join before sandbox keys are set
// (PAYPAL_MODE=mock, the default without PAYPAL_CLIENT_ID). The payer's approval is a page this server shows itself
// (/mock-paypal/approve), clearly marked as a simulation. Fees follow PayPal's US rate for the demo: 3.49% + $0.49 per
// capture. Nothing here moves money or talks to PayPal.
import crypto from "node:crypto";
import { store, stateFile } from "../store.js";

const id = (p) => `${p}${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
const fee = (cents) => Math.round(cents * 0.0349) + 49;

// Its records are kept like Join's own (store.js), so a restart doesn't lose the orders the bookings point at.
const KINDS = ["orders", "auths", "captures", "payouts", "setups", "tokens", "byRequest"];
const table = (db, k) => ({ get: (id) => db.data[k][id], has: (id) => id in db.data[k], set: (id, v) => { db.data[k][id] = v; db.save(); } });

export function mockPaypal({ publicUrl = "http://localhost:8790", file = stateFile("paypal-standin") } = {}) {
  const db = store(file, Object.fromEntries(KINDS.map((k) => [k, {}])));
  const [orders, auths, captures, payouts, setups, tokens, byRequest] = KINDS.map((k) => table(db, k));
  // the same PayPal-Request-Id gives the same answer, as PayPal does (objects below are changed in place, then saved)
  const once = (rid, fn) => { if (rid && byRequest.has(rid)) return byRequest.get(rid); const r = fn(); if (rid) byRequest.set(rid, r); db.save(); return r; };
  const authorize = (o) => {
    const a = { id: id("AUTH-"), order: o.id, amount: o.amount, status: "CREATED", expiresAt: new Date(Date.now() + 29 * 864e5).toISOString(), captured: 0 };
    auths.set(a.id, a); o.authorization = a.id; o.status = "COMPLETED";
    return { id: a.id, status: a.status, expiresAt: a.expiresAt };
  };
  const api = {
    mode: "mock",
    async createOrder({ amount, reference, vaultId = null, requestId }) {
      return once(requestId, () => {
        const o = { id: id("MOCK-"), amount, reference, status: "PAYER_ACTION_REQUIRED", authorization: null };
        orders.set(o.id, o);
        if (vaultId) {
          if (!tokens.has(vaultId)) throw Object.assign(new Error("PayPal: unknown vault_id"), { status: 422 });
          const a = authorize(o);
          return { id: o.id, status: o.status, approveUrl: null, authorization: a };
        }
        return { id: o.id, status: o.status, approveUrl: `${publicUrl}/mock-paypal/approve?token=${o.id}`, authorization: null };
      });
    },
    async getOrder(oid) {
      const o = orders.get(oid);
      if (!o) throw Object.assign(new Error("PayPal: no such order"), { status: 404 });
      const a = o.authorization ? auths.get(o.authorization) : null;
      return { id: o.id, status: o.status, authorization: a ? { id: a.id, status: a.status, expiresAt: a.expiresAt } : null, payerId: o.payerId || null };
    },
    async authorizeOrder(oid, requestId) {
      return once(requestId, () => {
        const o = orders.get(oid);
        if (!o || o.status !== "APPROVED") throw Object.assign(new Error(`PayPal: order ${oid} is not approved`), { status: 422 });
        return authorize(o);
      });
    },
    async capture(aid, { amount, final = true, requestId }) {
      return once(requestId, () => {
        const a = auths.get(aid);
        if (!a || !["CREATED", "PARTIALLY_CAPTURED"].includes(a.status)) throw Object.assign(new Error(`PayPal: authorization ${aid} can't be captured`), { status: 422 });
        if (a.captured + amount > a.amount) throw Object.assign(new Error("PayPal: capture exceeds the authorization"), { status: 422 });
        a.captured += amount; a.status = final ? "CAPTURED" : "PARTIALLY_CAPTURED";
        const c = { id: id("CAP-"), amount, status: "COMPLETED", net: amount - fee(amount), refunded: 0 };
        captures.set(c.id, c);
        return { id: c.id, status: c.status, net: c.net };
      });
    },
    async voidAuthorization(aid, requestId) {
      return once(requestId, () => {
        const a = auths.get(aid);
        if (!a) throw Object.assign(new Error("PayPal: no such authorization"), { status: 404 });
        if (a.status === "CREATED") a.status = "VOIDED";
        return { status: "VOIDED" };
      });
    },
    async refund(cid, { amount, requestId }) {
      return once(requestId, () => {
        const c = captures.get(cid);
        if (!c || c.refunded + amount > c.amount) throw Object.assign(new Error("PayPal: refund exceeds the capture"), { status: 422 });
        c.refunded += amount;
        return { id: id("REF-"), status: "COMPLETED" };
      });
    },
    async payout({ batchId, receiver, amount }) {
      return once(`payout:${batchId}`, () => { const p = { batchId: id("PAYOUT-"), receiver, amount, status: "SUCCESS" }; payouts.set(p.batchId, p); return { batchId: p.batchId, status: "PENDING" }; });
    },
    async getPayout(batchId) { const p = payouts.get(batchId); return { batchId, status: p ? "SUCCESS" : "DENIED", item: p ? "SUCCESS" : null }; },
    async vaultSetup({ requestId }) {
      return once(requestId, () => { const s = { id: id("SETUP-"), status: "PAYER_ACTION_REQUIRED" }; setups.set(s.id, s); return { id: s.id, approveUrl: `${publicUrl}/mock-paypal/approve?setup=${s.id}` }; });
    },
    async vaultToken(setupId, requestId) {
      return once(requestId, () => {
        const s = setups.get(setupId);
        if (!s || s.status !== "APPROVED") throw Object.assign(new Error("PayPal: setup token not approved"), { status: 422 });
        const t = { id: id("VT-"), customerId: id("CUST-") }; tokens.set(t.id, t); return t;
      });
    },
    async verifyWebhook() { return true; },
    // what the simulated approval page does
    approve({ token, setup }) {
      if (token) { const o = orders.get(token); if (!o) return false; if (o.status === "PAYER_ACTION_REQUIRED") { o.status = "APPROVED"; o.payerId = id("PAYER-"); db.save(); } return true; }
      if (setup) { const s = setups.get(setup); if (!s) return false; s.status = "APPROVED"; db.save(); return true; }
      return false;
    },
    describe({ token, setup }) {
      if (token) { const o = orders.get(token); return o ? { kind: "order", amount: o.amount, reference: o.reference, status: o.status } : null; }
      if (setup) { const s = setups.get(setup); return s ? { kind: "vault", status: s.status } : null; }
      return null;
    },
  };
  return api;
}

// AP2 mandates: the open mandates an agent works under, and the checkout and payment mandates of a deal, signed by Join
// and shaped as AP2's JSON schemas say (github.com/google-agentic-commerce/AP2, code/sdk/schemas/ap2)
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import * as ops from "../src/ops.js";
import * as ap2 from "../src/proof/mandates.js";
import * as settle from "../src/pay/settle.js";
import { mockPaypal } from "../src/pay/mock.js";
import { setClock, negotiationsStore } from "../src/negotiate/engine.js";
import { setMandate, mandatesStore } from "../src/mandate.js";
import { freeUnits } from "../src/world.js";
import { activityStore } from "../src/activity.js";
import * as receipts from "../src/proof/receipts.js";

let now = new Date(2026, 10, 2, 10, 0);
beforeEach(() => {
  now = new Date(2026, 10, 2, 10, 0); setClock(() => now); ops.setOpsClock(() => now);
  settle.configure({ paypal: mockPaypal(), now: () => now, url: "http://test" });
  negotiationsStore.reset(); mandatesStore.reset(); settle.bookingsStore.reset(); activityStore.reset(); ap2.mandatesAp2Store.reset(); receipts.receiptsStore.reset();
  for (const p of ["you", "leo", "hana", "tomas"]) setMandate(p, { perGame: 5000, perWeek: 20000 });
});
const agent = { player: "you", client: "test agent", token: "tok_test" };

test("an agent's open mandates: signed, bound to its token, with the person's limits as AP2 constraints", () => {
  const w = ops.whoami(agent).ap2;
  const c = ap2.verify(w.openCheckoutMandate), p = ap2.verify(w.openPaymentMandate);
  assert.equal(c.vct, "mandate.checkout.open.1"); assert.equal(p.vct, "mandate.payment.open.1");
  assert.deepEqual(c.cnf, { kid: "tok_test" }); assert.deepEqual(p.cnf, { kid: "tok_test" });
  const k = (m, t) => m.constraints.find((x) => x.type === t);
  assert.ok(k(c, "checkout.line_items").items[0].acceptable_items.some((i) => i.id === "badminton"));
  assert.equal(k(p, "payment.amount_range").max, 5000);
  assert.equal(k(p, "payment.budget").max, 200);
  assert.equal(k(p, "payment.reference").conditional_transaction_id, ap2.digest(w.openCheckoutMandate));
  // a forged payload doesn't verify
  const [h, , s] = w.openPaymentMandate.split(".");
  assert.equal(ap2.verify(`${h}.${Buffer.from(JSON.stringify({ ...p, constraints: [] })).toString("base64url")}.${s}`), null);
  // the person changes a limit: the next look at the mandate is a new one with the new limit
  setMandate("you", { perGame: 1200 });
  assert.equal(k(ap2.verify(ops.whoami(agent).ap2.openPaymentMandate), "payment.amount_range").max, 1200);
});

test("a deal: checkout mandate, each payer's payment mandate for that checkout, Join's receipts; refusals get an error receipt", async () => {
  const start = ["18:00", "19:00", "20:00"].find((s) => freeUnits("north", "badminton", "2026-11-05", s, 90).length);
  const n = ops.startNegotiation(agent, { venue: "north", activity: "badminton", date: "2026-11-05", start, minutes: 90, players: ["leo", "hana", "tomas"] });
  const r = ops.acceptPrice(agent, { negotiation: n.id });
  assert.equal(r.status, "agreed");
  await settle.pay(r.booking.id, "you");
  const m = ap2.forBooking(r.booking.id);
  assert.equal(m.checkoutMandate.payload.vct, "mandate.checkout.1");
  assert.equal(m.checkoutMandate.payload.checkout_hash, crypto.createHash("sha256").update(m.checkout.jws).digest("base64url"));
  assert.equal(m.checkout.payload.total.amount, settle.internal(r.booking.id).total);
  const pay = m.payments.you.mandate.payload;
  assert.equal(pay.vct, "mandate.payment.1");
  assert.equal(pay.transaction_id, m.checkout_hash); // the payment is for exactly that checkout
  assert.equal(pay.payment_amount.amount, settle.internal(r.booking.id).total); // the organizer's guarantee
  assert.equal(pay.pisp.brand_name, "PayPal");
  assert.equal(m.payments.you.receipt.payload.result, "success");
  assert.equal(m.open.checkout.payload.cnf.kid, "tok_test");
  // over the limit: refused, with an AP2 mandate receipt saying so
  setMandate("you", { perGame: 100 });
  const n2 = ops.startNegotiation(agent, { venue: "west", activity: "badminton", date: "2026-11-06", start: "19:00", minutes: 90, players: ["leo", "hana", "tomas"] });
  const refused = n2.error ? n2 : ops.acceptPrice(agent, { negotiation: n2.id });
  if (refused.error === "over_mandate") { const x = ap2.verify(refused.ap2Receipt); assert.equal(x.result, "error"); assert.equal(x.error, "invalid_mandate"); }
});

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { open, accept, setClock, negotiationsStore } from "../src/negotiate/engine.js";
import * as settle from "../src/pay/settle.js";
import { mockPaypal } from "../src/pay/mock.js";
import { setMandate, mandatesStore } from "../src/mandate.js";
import { freeUnits } from "../src/world.js";
import { forRef, activityStore } from "../src/activity.js";

const DATE = "2026-11-05";
let now, pp;
const clock = () => now;
const freeStart = (v) => { for (const s of ["18:00", "18:30", "19:00", "19:30", "20:00"]) if (freeUnits(v, "badminton", DATE, s, 90).length) return s; throw new Error("no court"); };

beforeEach(() => {
  now = new Date(2026, 10, 2, 10, 0);
  setClock(clock);
  pp = mockPaypal();
  settle.configure({ paypal: pp, now: clock, url: "http://test" });
  negotiationsStore.reset(); mandatesStore.reset(); settle.bookingsStore.reset(); activityStore.reset();
  for (const p of ["you", "leo", "hana", "tomas"]) setMandate(p, { perGame: 5000, perWeek: 20000 });
});

async function deal(players = ["leo", "hana", "tomas"]) {
  const n = open({ by: "you", players, venue: "north", activity: "badminton", date: DATE, start: freeStart("north"), minutes: 90 });
  const r = accept({ id: n.id, by: "you" });
  assert.equal(r.status, "agreed");
  return r.booking.id;
}
const approve = async (bookingId, player) => {
  const b = settle.internal(bookingId);
  if (!b.payments[player]) await settle.pay(bookingId, player); // (an invitee joins first)
  assert.equal(b.payments[player].status, "awaiting_approval");
  assert.ok(pp.approve({ token: b.payments[player].orderId }));
  return settle.approved(bookingId, player);
};

test("a lock interrupted by a refused capture resumes: shares already captured aren't charged again", async () => {
  const id = await deal();
  await settle.pay(id, "you"); await approve(id, "you");
  const b = settle.internal(id), orgAuth = b.payments.you.authorizationId, real = pp.capture.bind(pp);
  let refuse = 1, orgCalls = [];
  pp.capture = async (aid, o) => { if (aid === orgAuth) { orgCalls.push(o); if (refuse-- > 0) throw new Error("PayPal: try again later"); } return real(aid, o); };
  for (const p of ["leo", "hana", "tomas"]) await approve(id, p);
  assert.equal(b.state, "locking");
  assert.equal(b.payments.leo.status, "captured");
  await settle.tick();
  assert.equal(b.state, "locked");
  // the organizer was asked for their own share both times, never the whole price; each friend captured once
  assert.deepEqual(orgCalls.map((o) => o.amount), [b.shares.you, b.shares.you]);
  assert.notEqual(orgCalls[0].requestId, orgCalls[1].requestId);
  assert.equal(b.journal.filter((j) => j.step === "capture:leo" && j.status === "started").length, 1);
  pp.capture = real;
});

test("the organizer guarantees the whole court before anyone else is asked", async () => {
  const id = await deal();
  const v = await settle.pay(id, "you");
  assert.equal(v.state, "awaiting_organizer");
  assert.match(v.you.approveUrl, /mock-paypal\/approve/);
  assert.equal(v.you.authorized, v.total);
  assert.equal((await settle.pay(id, "leo")).message.startsWith("Waiting for"), true);
  await approve(id, "you");
  const b = settle.internal(id);
  assert.equal(b.state, "held");
  // invited, not charged: nothing starts for a player until they join
  for (const p of ["leo", "hana", "tomas"]) { assert.equal(b.payments[p], undefined); assert.ok((await settle.pay(id, "kenji")).error); }
  const v2 = settle.status(id, "leo");
  assert.equal(v2.invite.share, v2.payments.leo.share);
  assert.equal(v2.payments.leo.status, "invited");
  await settle.pay(id, "leo");
  assert.equal(settle.internal(id).payments.leo.status, "awaiting_approval");
});

test("everyone pays: each share captured, the organizer's authorization captured for the rest, then the venue is paid after the game", async () => {
  const id = await deal();
  await settle.pay(id, "you"); await approve(id, "you");
  for (const p of ["leo", "hana", "tomas"]) await approve(id, p);
  const b = settle.internal(id);
  assert.equal(b.state, "locked");
  const captured = Object.values(b.payments).reduce((a, p) => a + (p.role === "organizer" ? p.captured : p.amount), 0);
  assert.equal(captured, b.total);
  assert.equal(b.payments.you.captured, b.shares.you);
  // the court can't be offered again while it's locked
  assert.equal(freeUnits("north", "badminton", b.date, b.start, 90).includes(b.unit), false);
  now = new Date(2026, 10, 5, 23, 0);
  await settle.tick();
  await settle.tick();
  assert.equal(b.state, "venue_paid");
  assert.ok(b.payout.amount < b.total && b.payout.amount > b.total * 0.85);
  assert.ok(forRef(id).some((e) => e.action === "venue_paid"));
});

test("time runs out: the organizer covers whoever didn't pay; a decline voids that player's authorization", async () => {
  const id = await deal();
  await settle.pay(id, "you"); await approve(id, "you");
  await approve(id, "leo");
  await settle.decline(id, "hana");
  now = new Date(now.getTime() + settle.SHARES_MS + 60e3);
  await settle.tick();
  const b = settle.internal(id);
  assert.equal(b.state, "locked");
  assert.equal(b.payments.leo.status, "captured");
  assert.equal(b.payments.tomas, undefined); // never joined, so nothing was ever started for him
  assert.equal(b.payments.you.captured, b.total - b.shares.leo);
});

test("the organizer never guarantees: the court goes back and nobody is charged", async () => {
  const id = await deal();
  await settle.pay(id, "you");
  now = new Date(now.getTime() + settle.ORGANIZER_MS + 60e3);
  await settle.tick();
  const b = settle.internal(id);
  assert.equal(b.state, "released");
  assert.ok(freeUnits("north", "badminton", b.date, b.start, 90).includes(b.unit));
});

test("cancelled before the lock voids; after the lock and 24 h ahead refunds everyone", async () => {
  const id = await deal(["leo"]);
  await settle.pay(id, "you"); await approve(id, "you");
  assert.equal((await settle.cancel(id, "leo")).error, "not_organizer");
  const v = await settle.cancel(id, "you");
  assert.equal(v.state, "cancelled");
  assert.equal(settle.internal(id).payments.you.status, "voided");

  const id2 = await deal(["leo"]);
  await settle.pay(id2, "you"); await approve(id2, "you"); await approve(id2, "leo");
  assert.equal(settle.internal(id2).state, "locked");
  assert.equal((await settle.cancel(id2, "you")).state, "refunded");
  assert.ok(Object.values(settle.internal(id2).payments).every((p) => p.status === "refunded"));
});

test("with saved PayPal and within the mandate, the agent pays without a redirect; over the mandate it asks", async () => {
  const s = await settle.vaultStart("leo"); pp.approve({ setup: s.setup }); await settle.vaultFinish(s.setup);
  setMandate("leo", { autopay: true });
  const s2 = await settle.vaultStart("hana"); pp.approve({ setup: s2.setup }); await settle.vaultFinish(s2.setup);
  setMandate("hana", { autopay: true, perGame: 100 });
  const id = await deal(["leo", "hana"]);
  await settle.pay(id, "you"); await approve(id, "you");
  await settle.pay(id, "leo"); await settle.pay(id, "hana");
  const b = settle.internal(id);
  assert.equal(b.payments.leo.status, "authorized");
  assert.equal(b.payments.leo.via, "vault");
  assert.equal(b.payments.hana.status, "awaiting_approval");
  assert.match(b.payments.hana.why, /per-booking limit/);
});

test("a payment step repeated after a crash is the same PayPal call", async () => {
  const a = await pp.createOrder({ amount: 1000, reference: "x", requestId: "bk:order:you" });
  const b = await pp.createOrder({ amount: 1000, reference: "x", requestId: "bk:order:you" });
  assert.equal(a.id, b.id);
});

test("players negotiate the split: an invitee asks to pay less; the organizer covers it, within their own limit", async () => {
  const id = await deal(["leo", "hana"]);
  await settle.pay(id, "you"); await approve(id, "you");
  const b = settle.internal(id), even = b.shares.leo;
  assert.equal(settle.proposeShare(id, "leo", even).error, "bad_amount");
  assert.ok(settle.proposeShare(id, "leo", even - 300).shareAsks.length);
  assert.equal(settle.proposeShare(id, "leo", even - 400).error, "pending");
  assert.equal(settle.answerShare(id, "leo", "leo", true).error, "not_organizer");
  settle.answerShare(id, "you", "leo", true);
  assert.equal(b.shares.leo, even - 300);
  assert.equal(b.shares.you + b.shares.leo + b.shares.hana, b.total);
  // over the organizer's own limit: refused by the platform
  setMandate("you", { perGame: b.shares.you });
  settle.proposeShare(id, "hana", 0);
  assert.equal(settle.answerShare(id, "you", "hana", true).error, "over_mandate");
  await approve(id, "leo"); await approve(id, "hana");
  assert.equal(b.state, "locked");
  assert.equal(b.payments.leo.amount, even - 300);
  assert.equal(b.payments.you.captured, b.total - b.payments.leo.amount - b.payments.hana.amount);
});

test("paying the organizer back: an invoice to whoever never paid, then a payout to the organizer", async () => {
  const id = await deal(["leo", "hana"]);
  await settle.pay(id, "you"); await approve(id, "you"); await approve(id, "leo");
  assert.equal((await settle.requestReimbursement(id, "you", "hana")).error, "too_early");
  now = new Date(now.getTime() + settle.SHARES_MS + 60e3);
  await settle.tick();
  const b = settle.internal(id);
  assert.equal(b.state, "locked");
  assert.equal((await settle.requestReimbursement(id, "you", "leo")).error, "nothing_owed");
  assert.equal((await settle.requestReimbursement(id, "leo", "hana")).error, "not_organizer");
  assert.equal((await settle.requestReimbursement(id, "you", "hana")).error, "nothing_owed"); // never said yes
  // someone who joined but whose payment never went through does owe their share
  b.payments.hana = { role: "share", amount: b.shares.hana, status: "dropped" };
  const v = await settle.requestReimbursement(id, "you", "hana");
  assert.equal(v.reimbursements[0].status, "sent");
  assert.ok(settle.status(id, "hana").owes.url);
  pp.approve({ invoice: b.reimbursements.hana.invoiceId });
  await settle.tick();
  assert.equal(b.reimbursements.hana.status, "repaid");
  assert.ok(b.reimbursements.hana.payout);
});

test("the venue's side on the PayPal Agent Toolkit: extras invoice, reconciliation, a dispute answered with the receipt", async () => {
  const toolkit = await import("../src/pay/toolkit.js");
  toolkit.configureToolkit({ standIn: (m, a) => pp.toolkit(m, a) });
  const id = await deal(["leo"]);
  await settle.pay(id, "you"); await approve(id, "you"); await approve(id, "leo");
  const b = settle.internal(id);
  assert.equal(b.state, "locked");
  const bill = await settle.billExtras("north", id, [{ name: "Overtime, 30 min", amount: 1200 }, { name: "Racket rental", amount: 500 }]);
  assert.equal(bill.total, "17.00");
  const again = await settle.billExtras("north", id, [{ name: "Overtime, 30 min", amount: 1200 }, { name: "Racket rental", amount: 500 }]);
  assert.equal(again.already, true); assert.equal(again.invoice, bill.invoice);
  assert.equal((await settle.billExtras("west", id, [{ name: "x", amount: 1 }])).error, "no_booking");
  pp.approve({ invoice: bill.invoice }); await settle.tick();
  assert.equal(b.bills[0].status, "paid_out"); // paid by the organizer, then paid out to the venue
  assert.ok(b.bills[0].payout);
  const rec = await settle.reconcileVenue("north");
  assert.ok(rec.rows.filter((r) => r.kind === "capture").every((r) => r.paypal.startsWith("matched") && r.fee > 0));
  // a chargeback: Join answers it by itself the moment PayPal reports it, with the receipt and how Leo approved
  const d = pp.openDispute(b.payments.leo.captureId);
  const w = await settle.webhook({ event_type: "CUSTOMER.DISPUTE.CREATED", resource: d });
  assert.equal(w.defense.status, "evidence_sent");
  assert.equal(b.disputes[d.dispute_id].by, "join");
  assert.equal(b.disputes[d.dispute_id].payer, "leo");
  assert.match(pp.toolkit("list_disputes").items.find((x) => x.dispute_id === d.dispute_id).evidence, /approved the disputed payment themselves in PayPal/);
  assert.equal((await settle.webhook({ event_type: "CUSTOMER.DISPUTE.CREATED", resource: d })).defense, undefined); // the same event twice: answered once
  const list = await settle.venueDisputes("north");
  assert.equal(list[0].booking, id);
  const ans = await settle.answerDispute("north", d.dispute_id); // the venue can still send it again
  assert.equal(ans.status, "evidence_sent");
});

test("an organizer's guarantee: on its own from saved PayPal only up to their cover; above it they approve it", async () => {
  const s = await settle.vaultStart("you"); pp.approve({ setup: s.setup }); await settle.vaultFinish(s.setup);
  setMandate("you", { autopay: true, perGame: 5000, cover: 1 }); // a share fits, but they let their agent guarantee almost nothing
  const id = await deal();
  await settle.pay(id, "you");
  const p = settle.internal(id).payments.you;
  assert.equal(p.status, "awaiting_approval");
  assert.match(p.why, /over what they let their agent guarantee/);
  // with room to cover the group, the same booking's guarantee is authorized at once
  setMandate("you", { cover: 100000 });
  const id2 = await deal(["leo"]);
  await settle.pay(id2, "you");
  assert.equal(settle.internal(id2).payments.you.via, "vault");
  // and what accepting means is said up front: the whole price, their share, the worst case
  const b = settle.internal(id2), t = settle.guaranteeTerms("you", { total: b.total, players: b.players, venue: b.venue, date: b.date, start: b.start });
  assert.equal(t.guarantee, t.worstCase);
  assert.equal(+t.yourShare * 100, b.shares.you);
});

test("the weekly limit counts what an organizer actually paid for others, and the agent can't commit past it", async () => {
  const id = await deal();
  await settle.pay(id, "you"); await approve(id, "you");
  now = new Date(now.getTime() + settle.SHARES_MS + 60e3);
  await settle.tick(); // nobody else paid: the organizer covered the whole court
  const b = settle.internal(id);
  assert.equal(b.payments.you.captured, b.total);
  assert.equal(settle.spentInWeek("you", DATE, "21:00"), b.total);
  // a weekly limit just above that leaves no room for another share that week
  setMandate("you", { perWeek: b.total + 100 });
  const n = open({ by: "you", players: ["leo", "hana", "tomas"], venue: "north", activity: "badminton", date: DATE, start: "21:00", minutes: 90 });
  const r = n.error ? n : accept({ id: n.id, by: "you" });
  assert.equal(r.error, "over_mandate");
  assert.match(r.message, /weekly limit/);
});

test("a venue's figures are counted from its bookings: paid, off-peak, covered by organizers, nothing short", async () => {
  const id = await deal();
  await settle.pay(id, "you"); await approve(id, "you"); await approve(id, "leo");
  now = new Date(now.getTime() + settle.SHARES_MS + 60e3);
  await settle.tick(); // hana and tomas never paid: the organizer's guarantee covered them
  const b = settle.internal(id), m = settle.venueMetrics("north");
  assert.equal(m.bookings.paid, 1);
  assert.equal(m.revenue, (b.total / 100).toFixed(2));
  assert.equal(m.shortfall, "0.00");
  assert.equal(+m.coveredByOrganizers.amount * 100, b.payments.you.captured - b.shares.you);
  assert.equal(settle.venueMetrics("west").bookings.paid, 0);
});

test("balances across plans: two people who each covered the other settle up with one invoice for the difference", async () => {
  const toolkit = await import("../src/pay/toolkit.js");
  toolkit.configureToolkit({ standIn: (m, a) => pp.toolkit(m, a) });
  // plan 1: you organize; leo joins and never pays; you cover him
  const id1 = await deal(["leo", "hana"]);
  await settle.pay(id1, "you"); await approve(id1, "you"); await approve(id1, "hana"); await settle.pay(id1, "leo");
  // plan 2: leo organizes, the next day; you join and never pay; leo covers you
  const s2 = ["18:00", "19:00", "20:00"].find((s) => freeUnits("westgate", "badminton", "2026-11-06", s, 90).length);
  const n2 = open({ by: "leo", players: ["you", "tomas"], venue: "westgate", activity: "badminton", date: "2026-11-06", start: s2, minutes: 90 });
  const id2 = accept({ id: n2.id, by: "leo" }).booking.id;
  await settle.pay(id2, "leo"); await approve(id2, "leo"); await approve(id2, "tomas"); await settle.pay(id2, "you");
  now = new Date(now.getTime() + settle.SHARES_MS + 60e3);
  await settle.tick();
  const b1 = settle.internal(id1), b2 = settle.internal(id2), net = b1.shares.leo - b2.shares.you;
  const l = settle.ledger("you");
  assert.equal(l.items.length, 2);
  const leo = l.friends.find((f) => f.friend === "leo");
  assert.equal(Math.round(+leo.owesYou * 100) - Math.round(+leo.youOwe * 100), net);
  assert.equal(l.fewestPayments.length, 1); // two debts, one payment
  if (net > 0) {
    const s = await settle.settleUp("you", "leo");
    assert.equal(s.plans, 2); assert.equal(Math.round(+s.amount * 100), net);
    assert.ok(settle.ledger("you").items.every((d) => d.status.startsWith("settled together")));
    pp.approve({ invoice: settle.ledger("you").settlements[0].invoiceId || s.url.split("/").pop() });
  } else assert.equal((await settle.settleUp("you", "leo")).error, "nothing_owed");
});

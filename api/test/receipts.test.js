import { test } from "node:test";
import assert from "node:assert/strict";
import { merkle, canonical, sha256 } from "../src/proof/merkle.js";
import * as receipts from "../src/proof/receipts.js";

test("Merkle proofs check out for every leaf, and fail for a changed one", () => {
  for (const n of [1, 2, 3, 5, 8, 13]) {
    const leaves = Array.from({ length: n }, (_, i) => sha256(`leaf ${i}`)), t = merkle(leaves);
    leaves.forEach((l, i) => assert.ok(merkle.verify(l, t.proof(i), t.root)));
    if (n > 1) assert.equal(merkle.verify(sha256("other"), t.proof(0), t.root), false);
  }
  assert.equal(canonical({ b: 1, a: [2, { d: 3, c: 4 }] }), '{"a":[2,{"c":4,"d":3}],"b":1}');
});

test("a receipt is signed, batched and verifiable; any change breaks it; players are hashed", async () => {
  receipts.receiptsStore.reset(); receipts.auditLogStore.reset();
  const b = { id: "bk_x", venue: "north", sport: "badminton", date: "2026-11-05", start: "19:00", minutes: 90, court: 2, total: 3000, players: ["you", "leo"], organizer: "you", shares: { you: 1500, leo: 1500 }, declined: [],
    payments: { you: { status: "captured", captured: 1500, orderId: "O1", authorizationId: "A1", captureId: "C1", via: "approval" }, leo: { status: "captured", amount: 1500, orderId: "O2", authorizationId: "A2", captureId: "C2", via: "vault" } }, payout: null };
  const r = receipts.issue(b, { history: [{ at: "t", by: "venue", type: "ask", amount: 3200 }, { at: "t", by: "organizer", type: "offer", amount: 3000 }] }, "locked");
  receipts.issue({ ...b, id: "bk_y" }, null, "locked");
  const batch = await receipts.batch();
  assert.equal(batch.count, 2);
  const pub = receipts.show(r.id), mine = receipts.show(r.id, "leo");
  assert.deepEqual(receipts.verify(pub), { hash: true, signature: true, proof: true, log: true });
  assert.equal(JSON.stringify(pub).includes('"leo"'), false);
  assert.equal(mine.you.player, pub.body.payments[1].player);
  const forged = structuredClone(pub); forged.body.total = 1;
  assert.equal(receipts.verify(forged).hash, false);
});

test("the audit log: each batch chained to the one before, a signed head; a changed or dropped entry is caught", async () => {
  receipts.receiptsStore.reset(); receipts.auditLogStore.reset();
  const mk = (id) => receipts.issue({ id, venue: "north", activity: "badminton", date: "2026-11-05", start: "19:00", minutes: 90, unit: 1, total: 2000, players: ["you"], organizer: "you", shares: { you: 2000 }, declined: [], payments: { you: { status: "captured", captured: 2000 } } }, null, "locked");
  const a = mk("bk_a"); await receipts.batch();
  const kept = structuredClone(receipts.auditLog().head); // someone keeps the head as it was then
  const b = mk("bk_b"); mk("bk_c"); await receipts.batch();
  mk("bk_d"); await receipts.batch();
  const log = receipts.auditLog();
  assert.equal(log.head.size, 3);
  assert.equal(log.entries[1].prev, log.entries[0].hash);
  // a receipt from the first batch checks all the way to the latest head; so does one from a later batch
  for (const r of [a, b]) assert.deepEqual(receipts.verify(receipts.show(r.id)), { hash: true, signature: true, proof: true, log: true });
  // the head kept earlier is still the log's past: its entry is in today's log, unchanged
  assert.equal(log.entries[kept.size - 1].hash, kept.head);
  // rewriting an earlier batch root breaks the chain; so does dropping an entry; so does a forged head
  const pub = receipts.publicKey(), ref = receipts.show(a.id);
  const changed = structuredClone(ref); changed.log.entries[0].root = "00".repeat(32); changed.batch.root = "00".repeat(32);
  assert.equal(receipts.verify(changed).log, false);
  const dropped = structuredClone(ref); dropped.log.entries.splice(1, 1);
  assert.equal(receipts.verify(dropped).log, false);
  const forged = structuredClone(ref); forged.log.head.size += 1;
  assert.equal(receipts.verify(forged).log, false);
  assert.ok(pub.kid);
  assert.equal(await receipts.batch(), null); // nothing new to batch
});

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
  receipts.receiptsStore.reset();
  const b = { id: "bk_x", venue: "north", sport: "badminton", date: "2026-11-05", start: "19:00", minutes: 90, court: 2, total: 3000, players: ["you", "leo"], organizer: "you", shares: { you: 1500, leo: 1500 }, declined: [],
    payments: { you: { status: "captured", captured: 1500, orderId: "O1", authorizationId: "A1", captureId: "C1", via: "approval" }, leo: { status: "captured", amount: 1500, orderId: "O2", authorizationId: "A2", captureId: "C2", via: "vault" } }, payout: null };
  const r = receipts.issue(b, { history: [{ at: "t", by: "venue", type: "ask", amount: 3200 }, { at: "t", by: "organizer", type: "offer", amount: 3000 }] }, "locked");
  receipts.issue({ ...b, id: "bk_y" }, null, "locked");
  let anchored = null;
  const batch = await receipts.batch(async (root) => (anchored = root, { chain: "test", tx: "0xabc" }));
  assert.equal(batch.count, 2); assert.equal(anchored, batch.root);
  const pub = receipts.show(r.id), mine = receipts.show(r.id, "leo");
  assert.deepEqual(receipts.verify(pub), { hash: true, signature: true, proof: true });
  assert.equal(JSON.stringify(pub).includes('"leo"'), false);
  assert.equal(mine.you.player, pub.body.payments[1].player);
  const forged = structuredClone(pub); forged.body.total = 1;
  assert.equal(receipts.verify(forged).hash, false);
});

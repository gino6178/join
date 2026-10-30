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
  const b = { id: "bk_x", venue: "north", sport: "badminton", date: "2026-11-05", start: "19:00", minutes: 90, court: 2, total: 3000, players: ["alex", "leo"], organizer: "alex", shares: { you: 1500, leo: 1500 }, declined: [],
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

test("the transparency log: batches in an RFC 6962 tree, a signed C2SP checkpoint, consistency, a witness's cosignature", async () => {
  receipts.receiptsStore.reset(); receipts.auditLogStore.reset();
  const tlog = await import("../src/proof/tlog.js"), crypto = await import("node:crypto");
  const mk = (id) => receipts.issue({ id, venue: "north", activity: "badminton", date: "2026-11-05", start: "19:00", minutes: 90, unit: 1, total: 2000, players: ["alex"], organizer: "alex", shares: { you: 2000 }, declined: [], payments: { you: { status: "captured", captured: 2000 } } }, null, "locked");
  const a = mk("bk_a"); await receipts.batch();
  const kept = tlog.parseNote(receipts.logInfo().checkpoint); // someone keeps the checkpoint as it was then
  const b = mk("bk_b"); mk("bk_c"); await receipts.batch();
  mk("bk_d"); await receipts.batch();
  assert.equal(receipts.logInfo().size, 3);
  // receipts from the first and a later batch check all the way to the latest signed checkpoint
  for (const r of [a, b]) assert.deepEqual(receipts.verify(receipts.show(r.id)), { hash: true, signature: true, proof: true, log: true });
  // today's tree extends the kept checkpoint
  const now = tlog.parseNote(receipts.logInfo().checkpoint), c = receipts.consistency(kept.size);
  assert.ok(tlog.verifyConsistency(kept.size, now.size, c.proof.map((x) => Buffer.from(x, "base64")), kept.root, now.root));
  // a changed batch root, a wrong index or a forged checkpoint is caught
  const ref = receipts.show(a.id);
  const changed = structuredClone(ref); changed.log.entry.root = "00".repeat(32); changed.batch.root = "00".repeat(32);
  assert.equal(receipts.verify(changed).log, false);
  const moved = structuredClone(ref); moved.log.index = 1;
  assert.equal(receipts.verify(moved).log, false);
  const forged = structuredClone(ref); forged.log.checkpoint = forged.log.checkpoint.replace("\n3\n", "\n4\n"); forged.log.size = 4;
  assert.equal(receipts.verify(forged).log, false);
  // a witness: added by the operator, cosigns the current checkpoint; a cosignature over anything else is refused
  const w = crypto.generateKeyPairSync("ed25519"), jwk = w.publicKey.export({ format: "jwk" }), sign = (buf) => crypto.sign(null, buf, w.privateKey);
  assert.deepEqual(receipts.addWitness("venue.example/witness", jwk), { ok: true });
  assert.equal(receipts.cosign("venue.example/witness", tlog.cosignatureLine("venue.example/witness", kept.text, 1777000000, sign, jwk)).error, "bad_cosignature");
  assert.equal(receipts.cosign("venue.example/witness", tlog.cosignatureLine("venue.example/witness", now.text, 1777000000, sign, jwk)).ok, true);
  assert.equal(tlog.verifyNoteSig(tlog.parseNote(receipts.logInfo().checkpoint), "venue.example/witness", jwk, 0x04), 1777000000);
  assert.equal(await receipts.batch(), null); // nothing new to batch
});

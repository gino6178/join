// The transparency log's Merkle tree (RFC 6962 / 9162) and C2SP checkpoint notes
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import * as t from "../src/proof/tlog.js";

const leaves = (n) => Array.from({ length: n }, (_, i) => t.leafHash(`entry ${i}`));

test("inclusion and consistency proofs check out for every size up to 20, and fail when anything changes", () => {
  for (let n = 1; n <= 20; n++) {
    const L = leaves(n), root = t.treeHash(L);
    for (let i = 0; i < n; i++) {
      assert.ok(t.verifyInclusion(L[i], i, n, t.inclusionProof(i, L), root), `inclusion ${i}/${n}`);
      if (n > 1) assert.equal(t.verifyInclusion(t.leafHash("other"), i, n, t.inclusionProof(i, L), root), false);
    }
    for (let m = 1; m <= n; m++) {
      const r1 = t.treeHash(L.slice(0, m));
      assert.ok(t.verifyConsistency(m, n, t.consistencyProof(m, L), r1, root), `consistency ${m}->${n}`);
      if (m < n) assert.equal(t.verifyConsistency(m, n, t.consistencyProof(m, L), t.leafHash("forged"), root), false);
    }
  }
  // a log that rewrote entry 2 after a checkpoint of size 5 can't prove it extends that checkpoint
  const L = leaves(8), old = t.treeHash(L.slice(0, 5)), rewritten = [...L]; rewritten[2] = t.leafHash("rewritten");
  assert.equal(t.verifyConsistency(5, 8, t.consistencyProof(5, rewritten), old, t.treeHash(rewritten)), false);
});

test("a checkpoint is a C2SP signed note: the log's signature and a witness's timestamped cosignature verify", () => {
  const log = crypto.generateKeyPairSync("ed25519"), wit = crypto.generateKeyPairSync("ed25519");
  const jwk = (k) => k.publicKey.export({ format: "jwk" }), sign = (k) => (buf) => crypto.sign(null, buf, k.privateKey);
  const text = t.checkpointText("join.example/receipts", 3, t.treeHash(leaves(3)));
  let note = `${text}\n${t.logSignatureLine("join.example/receipts", text, sign(log), jwk(log))}`;
  note += t.cosignatureLine("venue.example/witness", text, 1777000000, sign(wit), jwk(wit));
  const p = t.parseNote(note);
  assert.equal(p.size, 3);
  assert.equal(t.verifyNoteSig(p, "join.example/receipts", jwk(log), 0x01), true);
  assert.equal(t.verifyNoteSig(p, "venue.example/witness", jwk(wit), 0x04), 1777000000);
  assert.equal(t.verifyNoteSig(t.parseNote(note.replace("\n3\n", "\n4\n")), "join.example/receipts", jwk(log), 0x01), false);
  assert.match(note, /^join\.example\/receipts\n3\n[A-Za-z0-9+/]+=*\n\n— join\.example\/receipts /);
});

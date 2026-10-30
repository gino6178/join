// Verifiable receipts: proof that what the agents agreed and what was paid has not been changed since.
//   1. When a booking is locked (and again if it is refunded or the venue is paid), Join writes a receipt: the deal's
//      negotiation, step by step; what each player paid and how; the PayPal ids of every order, authorization and capture.
//      Players appear only as salted hashes (each player's own copy carries their salt, so they can find themselves).
//   2. Join signs the receipt (Ed25519; the public key is at /.well-known/join-receipts.json).
//   3. Every few minutes the new receipts' hashes go into a Merkle tree, and its root is written to Ethereum Sepolia in
//      one transaction (anchor.js). Each receipt keeps its path to the root.
// Anyone can then check a receipt without trusting Join: hash it, follow the path to the root, find the root in the
// transaction's data. What it proves: this receipt existed, exactly so, by the time of that block. What it does not:
// that PayPal moved the money. That is PayPal's record, which the receipt points to by id.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { store, stateFile } from "../store.js";
import { canonical, sha256, merkle } from "./merkle.js";
import { unitName } from "../world.js";

const db = store(stateFile("receipts"), { receipts: [], batches: [] });
export const receiptsStore = db;

// Join's signing key, made on first run and kept with the state (or in memory for tests)
function signingKey() {
  const f = stateFile("receipts-key");
  if (f && fs.existsSync(f)) { const k = JSON.parse(fs.readFileSync(f, "utf8")); return { priv: crypto.createPrivateKey({ key: k.private, format: "jwk" }), pub: k.public }; }
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const k = { private: privateKey.export({ format: "jwk" }), public: { ...publicKey.export({ format: "jwk" }), kid: `join-${Date.now().toString(36)}`, alg: "EdDSA", use: "sig" } };
  if (f) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(k), { mode: 0o600 }); }
  return { priv: privateKey, pub: k.public };
}
let key = null;
const keys = () => (key ||= signingKey());
export const publicKey = () => keys().pub;

const salted = (salt, id) => sha256(`${salt}:${id}`);

// The receipt for a booking at this moment. `b` is settle.js's booking, `n` its negotiation (engine.js, internal).
export function issue(b, n, event) {
  const salt = crypto.randomBytes(16).toString("hex");
  const body = {
    type: "JoinReceipt", version: 1, event, issued: new Date().toISOString(),
    booking: b.id, venue: b.venue, activity: b.activity, date: b.date, start: b.start, minutes: b.minutes, unit: b.unit, unitName: unitName(b.activity, b.unit), currency: "USD", total: b.total,
    negotiation: (n?.history || []).map((h) => ({ at: h.at, by: h.by === "organizer" ? "organizer" : h.by, type: h.type, amount: h.amount ?? null })),
    split: b.splitRule || "even",
    payments: b.players.map((pid) => { const p = b.payments[pid] || {}; return {
      player: salted(salt, pid), role: pid === b.organizer ? "organizer" : "player", share: b.shares[pid], status: b.declined.includes(pid) ? "declined" : p.status || "none",
      captured: p.status === "captured" || p.status === "refunded" ? (p.captured ?? p.amount) : 0, via: p.via || null,
      paypal: { order: p.orderId || null, authorization: p.authorizationId || null, capture: p.captureId || null } }; }),
    payout: b.payout ? { amount: b.payout.amount, batch: b.payout.batchId, status: b.payout.item || b.payout.status } : null,
    paypalMode: b.paypalMode || null,
  };
  const hash = sha256(canonical(body));
  const signature = crypto.sign(null, Buffer.from(hash, "hex"), keys().priv).toString("base64url");
  const r = { id: `rcpt_${hash.slice(0, 16)}`, hash, body, signature, kid: keys().pub.kid, salts: Object.fromEntries(b.players.map((pid) => [pid, salt])), batch: null, proof: null };
  db.data.receipts.push(r); db.save();
  return r;
}

// A batch: the receipts not yet in one, as a Merkle tree; the root goes on chain (anchor is anchor.js's send, or null
// when no chain is configured: the batch is still made and signed, and says it is not anchored)
export async function batch(anchor) {
  const open = db.data.receipts.filter((r) => !r.batch);
  if (!open.length) return null;
  const tree = merkle(open.map((r) => r.hash));
  const b = { id: `batch_${tree.root.slice(0, 12)}`, root: tree.root, at: new Date().toISOString(), count: open.length, anchor: null };
  open.forEach((r, i) => { r.batch = b.id; r.proof = tree.proof(i); });
  db.data.batches.push(b); db.save();
  if (anchor) {
    try { b.anchor = await anchor(tree.root); } catch (e) { b.anchor = { error: e.message.slice(0, 200) }; }
    db.save();
  }
  return b;
}

// Anchor batches that failed or were made before a chain was configured
export async function retry(anchor) {
  if (!anchor) return;
  for (const b of db.data.batches.filter((x) => !x.anchor || x.anchor.error)) { try { b.anchor = await anchor(b.root); } catch (e) { b.anchor = { error: e.message.slice(0, 200) }; } db.save(); }
}

// A receipt as anyone may see it: no salts (a player's own copy adds theirs)
export function show(id, viewer = null) {
  const r = db.data.receipts.find((x) => x.id === id);
  if (!r) return null;
  const b = r.batch ? db.data.batches.find((x) => x.id === r.batch) : null;
  return { id: r.id, hash: r.hash, body: r.body, signature: r.signature, kid: r.kid, publicKey: publicKey(), proof: r.proof, batch: b ? { id: b.id, root: b.root, at: b.at, count: b.count, anchor: b.anchor } : null,
    ...(viewer && r.salts[viewer] ? { you: { salt: r.salts[viewer], player: salted(r.salts[viewer], viewer) } } : {}) };
}
export const forBooking = (bookingId) => db.data.receipts.filter((r) => r.body.booking === bookingId).map((r) => ({ id: r.id, event: r.body.event, issued: r.body.issued, batch: r.batch }));

// Checks a receipt the way an outsider would (also used by the tests and the verifier script)
export function verify(r) {
  const out = { hash: sha256(canonical(r.body)) === r.hash, signature: false, proof: null };
  try { out.signature = crypto.verify(null, Buffer.from(r.hash, "hex"), crypto.createPublicKey({ key: r.publicKey, format: "jwk" }), Buffer.from(r.signature, "base64url")); } catch {}
  if (r.proof && r.batch) out.proof = merkle.verify(r.hash, r.proof, r.batch.root);
  return out;
}

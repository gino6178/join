// Verifiable receipts: proof that what the agents agreed and what was paid has not been changed since.
//   1. When a booking is locked (and again if it is refunded or the venue is paid), Join writes a receipt: the deal's
//      negotiation, step by step; what each player paid and how; the PayPal ids of every order, authorization and capture.
//      Players appear only as salted hashes (each player's own copy carries their salt, so they can find themselves).
//   2. Join signs the receipt (Ed25519; the public key is at /.well-known/join-receipts.json).
//   3. Every few minutes the new receipts' hashes go into a Merkle tree (a batch). Each receipt keeps its path to the
//      batch's root.
//   4. Each batch's root is appended to Join's audit log, a hash chain in the manner of Certificate Transparency
//      (RFC 6962): every entry holds the hash of the one before, and after each append Join signs the log's head (its
//      size and the last entry's hash) and publishes it. A receipt is checked receipt -> batch root -> log entry ->
//      signed head.
// Anyone can check a receipt without trusting Join's server: hash it, check the signature, follow the Merkle path, and
// follow the log from its entry to a signed head. Anyone who keeps a signed head (a venue, a payer, a payment
// dispute team) can later show that the log still extends it: Join can't change or drop an earlier entry without
// every later head disagreeing with the copy they kept. No blockchain, no fees, no waiting for blocks.
// What a receipt does not prove: that PayPal moved the money. That is PayPal's record, which the receipt points to by id.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { store, stateFile } from "../store.js";
import { canonical, sha256, merkle } from "./merkle.js";
import { unitName } from "../world.js";

const db = store(stateFile("receipts"), { receipts: [], batches: [] });
export const receiptsStore = db;
// the audit log: one entry per batch, each chained to the one before, and the latest signed head
const log = store(stateFile("audit-log"), { entries: [], head: null });
export const auditLogStore = log;
const GENESIS = "0".repeat(64);

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

// A log entry's hash covers everything in it, including the previous entry's hash
export const entryHash = (e) => sha256(canonical({ seq: e.seq, batch: e.batch, root: e.root, count: e.count, at: e.at, prev: e.prev }));
// the signed head: what Join commits to about the whole log at this size
const headBody = (size, hash, at) => canonical({ type: "JoinAuditLogHead", size, head: hash, at });
function signHead() {
  const last = log.data.entries.at(-1), at = new Date().toISOString(), hash = last ? last.hash : GENESIS, size = log.data.entries.length;
  log.data.head = { size, head: hash, at, kid: keys().pub.kid, signature: crypto.sign(null, Buffer.from(headBody(size, hash, at)), keys().priv).toString("base64url") };
}

// A batch: the receipts not yet in one, as a Merkle tree, whose root is appended to the audit log
export async function batch() {
  const open = db.data.receipts.filter((r) => !r.batch);
  if (!open.length) return null;
  const tree = merkle(open.map((r) => r.hash));
  const b = { id: `batch_${tree.root.slice(0, 12)}`, root: tree.root, at: new Date().toISOString(), count: open.length };
  open.forEach((r, i) => { r.batch = b.id; r.proof = tree.proof(i); });
  const e = { seq: log.data.entries.length, batch: b.id, root: b.root, count: b.count, at: b.at, prev: log.data.entries.at(-1)?.hash || GENESIS };
  e.hash = entryHash(e);
  log.data.entries.push(e); b.log = e.seq;
  signHead();
  db.data.batches.push(b); db.save(); log.save();
  return b;
}

// The log from an entry on, and the signed head it must lead to
export const auditLog = (from = 0) => ({ entries: log.data.entries.slice(Math.max(0, from | 0)), head: log.data.head });

// A receipt as anyone may see it: no salts (a player's own copy adds theirs)
export function show(id, viewer = null) {
  const r = db.data.receipts.find((x) => x.id === id);
  if (!r) return null;
  const b = r.batch ? db.data.batches.find((x) => x.id === r.batch) : null;
  return { id: r.id, hash: r.hash, body: r.body, signature: r.signature, kid: r.kid, publicKey: publicKey(), proof: r.proof, batch: b ? { id: b.id, root: b.root, at: b.at, count: b.count, log: b.log } : null,
    // the log from this receipt's entry to the signed head, so it can be checked without another request
    log: b ? auditLog(b.log) : null,
    ...(viewer && r.salts[viewer] ? { you: { salt: r.salts[viewer], player: salted(r.salts[viewer], viewer) } } : {}) };
}
export const forBooking = (bookingId) => db.data.receipts.filter((r) => r.body.booking === bookingId).map((r) => ({ id: r.id, event: r.body.event, issued: r.body.issued, batch: r.batch }));

// Checks a receipt the way an outsider would (also used by the tests): the hash, the signature, the Merkle path, and
// the log from the batch's entry to a head signed by Join
export function verify(r) {
  const out = { hash: sha256(canonical(r.body)) === r.hash, signature: false, proof: null, log: null };
  const pub = (() => { try { return crypto.createPublicKey({ key: r.publicKey, format: "jwk" }); } catch { return null; } })();
  try { out.signature = crypto.verify(null, Buffer.from(r.hash, "hex"), pub, Buffer.from(r.signature, "base64url")); } catch {}
  if (r.proof && r.batch) out.proof = merkle.verify(r.hash, r.proof, r.batch.root);
  if (r.batch && r.log) out.log = verifyLog(r.batch, r.log, pub);
  return out;
}
// the entry for this batch, each entry's hash and link to the one before, and the head's signature
export function verifyLog(batchRef, { entries, head }, pub) {
  const first = entries[0];
  if (!first || first.seq !== batchRef.log || first.root !== batchRef.root || !head) return false;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (entryHash(e) !== e.hash || (i > 0 && (e.prev !== entries[i - 1].hash || e.seq !== entries[i - 1].seq + 1))) return false;
  }
  const last = entries.at(-1);
  if (head.size !== last.seq + 1 || head.head !== last.hash) return false;
  try { return crypto.verify(null, Buffer.from(headBody(head.size, head.head, head.at)), pub, Buffer.from(head.signature, "base64url")); } catch { return false; }
}

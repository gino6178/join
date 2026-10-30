// Verifiable receipts: proof that what the agents agreed and what was paid has not been changed since.
//   1. When a booking is locked (and again if it is refunded or the venue is paid), Join writes a receipt: the deal's
//      negotiation, step by step; what each player paid and how; the PayPal ids of every order, authorization and capture.
//      Players appear only as salted hashes (each player's own copy carries their salt, so they can find themselves).
//   2. Join signs the receipt (Ed25519; the public key is at /.well-known/join-receipts.json).
//   3. Every few minutes the new receipts' hashes go into a Merkle tree (a batch). Each receipt keeps its path to the
//      batch's root.
//   4. Each batch is appended to Join's transparency log, a Merkle tree exactly as Certificate Transparency defines it
//      (RFC 6962 / RFC 9162, tlog.js). After each append Join signs the tree head as a C2SP checkpoint (a signed note:
//      origin, size, root hash). Witnesses (anyone, a venue for instance) fetch a consistency proof from the last
//      checkpoint they saw, check it, and cosign the new checkpoint (c2sp.org/tlog-cosignature); their cosignatures are
//      published with it. A receipt is checked receipt -> batch root -> log entry -> inclusion proof -> signed checkpoint.
// Anyone can then check a receipt without trusting Join's server. And because Join never signs two checkpoints that
// disagree (a witness would refuse to cosign the second), it can't show different people different histories, or
// change or drop an entry, without the checkpoints people kept, and the witnesses' cosignatures, giving it away.
// What a receipt does not prove: that PayPal moved the money. That is PayPal's record, which the receipt points to by id.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { store, stateFile } from "../store.js";
import { canonical, sha256, merkle } from "./merkle.js";
import * as tlog from "./tlog.js";
import { unitName } from "../world.js";

const db = store(stateFile("receipts"), { receipts: [], batches: [] });
export const receiptsStore = db;
// the transparency log: one entry per batch, the latest checkpoint (a signed note, with witnesses' cosignatures added),
// and the witnesses Join accepts cosignatures from
const log = store(stateFile("transparency-log"), { entries: [], checkpoint: null, cosigned: [], witnesses: {} });
export const auditLogStore = log;
let origin = "join.localhost/receipts";
export const setOrigin = (o) => { origin = o; };

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
// (the same key signs AP2 mandates, mandates.js; it never leaves the server)
export const signBytes = (buf) => crypto.sign(null, buf, keys().priv);
export const verifyBytes = (buf, sig) => { try { return crypto.verify(null, buf, crypto.createPublicKey({ key: keys().pub, format: "jwk" }), sig); } catch { return false; } };

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
    ap2: b.ap2 || null, // hashes of the AP2 checkout and payment mandates (mandates.js)
  };
  const hash = sha256(canonical(body));
  const signature = crypto.sign(null, Buffer.from(hash, "hex"), keys().priv).toString("base64url");
  const r = { id: `rcpt_${hash.slice(0, 16)}`, hash, body, signature, kid: keys().pub.kid, salts: Object.fromEntries(b.players.map((pid) => [pid, salt])), batch: null, proof: null };
  db.data.receipts.push(r); db.save();
  return r;
}

// A log entry, as the bytes its leaf hash covers
const entryData = (e) => canonical({ seq: e.seq, batch: e.batch, root: e.root, count: e.count, at: e.at });
const leaves = () => log.data.entries.map((e) => tlog.leafHash(entryData(e)));
const b64 = (buf) => Buffer.from(buf).toString("base64");

// The current checkpoint, signed by Join; cosignatures for it are added as witnesses send them
function checkpoint() {
  const size = log.data.entries.length, text = tlog.checkpointText(origin, size, tlog.treeHash(leaves()));
  log.data.checkpoint = { size, text, signature: tlog.logSignatureLine(origin, text, (buf) => crypto.sign(null, buf, keys().priv), keys().pub), at: new Date().toISOString() };
  log.data.cosigned = [];
}
const note = () => (log.data.checkpoint ? `${log.data.checkpoint.text}\n${log.data.checkpoint.signature}${log.data.cosigned.map((c) => c.line).join("")}` : null);

// A batch: the receipts not yet in one, as a Merkle tree, whose root becomes the log's next entry
export async function batch() {
  const open = db.data.receipts.filter((r) => !r.batch);
  if (!open.length) return null;
  const tree = merkle(open.map((r) => r.hash));
  const b = { id: `batch_${tree.root.slice(0, 12)}`, root: tree.root, at: new Date().toISOString(), count: open.length };
  open.forEach((r, i) => { r.batch = b.id; r.proof = tree.proof(i); });
  const e = { seq: log.data.entries.length, batch: b.id, root: b.root, count: b.count, at: b.at };
  log.data.entries.push(e); b.log = e.seq;
  checkpoint();
  db.data.batches.push(b); db.save(); log.save();
  return b;
}

// What the log publishes: the checkpoint note (with cosignatures), the witnesses, the proofs and the entries
export const logInfo = () => ({ origin, size: log.data.entries.length, checkpoint: note(), key: { name: origin, type: "Ed25519 (C2SP signed-note type 0x01)", jwk: publicKey() },
  witnesses: Object.entries(log.data.witnesses).map(([name, jwk]) => ({ name, jwk, cosigned: log.data.cosigned.some((c) => c.name === name) })) });
export const entries = (from = 0, to = log.data.entries.length) => log.data.entries.slice(Math.max(0, from | 0), Math.max(0, to | 0));
export function inclusion(index, size = log.data.entries.length) {
  if (!(index >= 0 && index < size && size <= log.data.entries.length)) return null;
  return { index, size, proof: tlog.inclusionProof(index, leaves().slice(0, size)).map(b64) };
}
export function consistency(from, to = log.data.entries.length) {
  if (!(from >= 0 && from <= to && to <= log.data.entries.length)) return null;
  return { from, to, proof: tlog.consistencyProof(from, leaves().slice(0, to)).map(b64) };
}
// A witness Join accepts cosignatures from (set up by an operator), and a cosignature for the current checkpoint
export function addWitness(name, jwk) {
  if (!/^[^\s+]{1,255}$/.test(name) || jwk?.kty !== "OKP" || jwk?.crv !== "Ed25519" || typeof jwk?.x !== "string") return { error: "bad_witness" };
  log.data.witnesses[name] = { kty: "OKP", crv: "Ed25519", x: jwk.x }; log.save();
  return { ok: true };
}
export function cosign(name, line) {
  const jwk = log.data.witnesses[name], cp = log.data.checkpoint;
  if (!jwk || !cp) return { error: "unknown_witness", message: "Not a witness of this log, or no checkpoint yet." };
  const parsed = tlog.parseNote(`${cp.text}\n${String(line).trim()}\n`), time = parsed && tlog.verifyNoteSig(parsed, name, jwk, 0x04);
  if (!time) return { error: "bad_cosignature", message: "The cosignature doesn't verify for the current checkpoint." };
  log.data.cosigned = [...log.data.cosigned.filter((c) => c.name !== name), { name, line: `${String(line).trim()}\n`, time }]; log.save();
  return { ok: true, size: cp.size };
}

// A receipt as anyone may see it: no salts (a player's own copy adds theirs)
export function show(id, viewer = null) {
  const r = db.data.receipts.find((x) => x.id === id);
  if (!r) return null;
  const b = r.batch ? db.data.batches.find((x) => x.id === r.batch) : null;
  return { id: r.id, hash: r.hash, body: r.body, signature: r.signature, kid: r.kid, publicKey: publicKey(), proof: r.proof, batch: b ? { id: b.id, root: b.root, at: b.at, count: b.count, log: b.log } : null,
    // the batch's log entry, its inclusion proof and the checkpoint it leads to, so it can be checked without another request
    log: b && log.data.checkpoint ? { entry: log.data.entries[b.log], ...inclusion(b.log), checkpoint: note(), origin, key: publicKey() } : null,
    ...(viewer && r.salts[viewer] ? { you: { salt: r.salts[viewer], player: salted(r.salts[viewer], viewer) } } : {}) };
}
export const forBooking = (bookingId) => db.data.receipts.filter((r) => r.body.booking === bookingId).map((r) => ({ id: r.id, event: r.body.event, issued: r.body.issued, batch: r.batch }));

// Checks a receipt the way an outsider would (also used by the tests): the hash, the signature, the Merkle path, the
// log entry for its batch, the entry's inclusion in the checkpoint's tree, and Join's signature on the checkpoint
export function verify(r) {
  const out = { hash: sha256(canonical(r.body)) === r.hash, signature: false, proof: null, log: null };
  const pub = (() => { try { return crypto.createPublicKey({ key: r.publicKey, format: "jwk" }); } catch { return null; } })();
  try { out.signature = crypto.verify(null, Buffer.from(r.hash, "hex"), pub, Buffer.from(r.signature, "base64url")); } catch {}
  if (r.proof && r.batch) out.proof = merkle.verify(r.hash, r.proof, r.batch.root);
  if (r.batch && r.log) out.log = verifyLog(r.batch, r.log, r.publicKey);
  return out;
}
export function verifyLog(batchRef, l, jwk) {
  const e = l.entry, cp = tlog.parseNote(l.checkpoint || "");
  if (!e || !cp || e.seq !== batchRef.log || e.root !== batchRef.root || e.batch !== batchRef.id || cp.size !== l.size || cp.origin !== l.origin) return false;
  return tlog.verifyInclusion(tlog.leafHash(entryData(e)), l.index, l.size, l.proof.map((x) => Buffer.from(x, "base64")), cp.root) && tlog.verifyNoteSig(cp, l.origin, jwk, 0x01) === true;
}

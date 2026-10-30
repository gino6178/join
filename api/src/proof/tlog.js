// A transparency log as Certificate Transparency defines it (RFC 6962 / RFC 9162 §2.1), with its tree head as a C2SP
// checkpoint (c2sp.org/tlog-checkpoint, c2sp.org/signed-note) that witnesses can cosign (c2sp.org/tlog-cosignature).
// Pure functions: no state, no I/O. The same code is copied, not imported, into the verifier script and the browser.
import crypto from "node:crypto";

const sha = (...parts) => crypto.createHash("sha256").update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest();
export const leafHash = (data) => sha([0x00], data);
const node = (l, r) => sha([0x01], l, r);
const split = (n) => { let k = 1; while (k * 2 < n) k *= 2; return k; }; // the largest power of two below n

// MTH(D[n]) over leaf hashes
export function treeHash(leaves) {
  if (leaves.length === 0) return sha();
  if (leaves.length === 1) return leaves[0];
  const k = split(leaves.length);
  return node(treeHash(leaves.slice(0, k)), treeHash(leaves.slice(k)));
}
// PATH(m, D[n]): the audit path for leaf m
export function inclusionProof(m, leaves) {
  if (leaves.length <= 1) return [];
  const k = split(leaves.length);
  return m < k ? [...inclusionProof(m, leaves.slice(0, k)), treeHash(leaves.slice(k))] : [...inclusionProof(m - k, leaves.slice(k)), treeHash(leaves.slice(0, k))];
}
// PROOF(m, D[n]): that the tree of the first m leaves is a prefix of the tree of n
export function consistencyProof(m, leaves) {
  const sub = (m, d, complete) => {
    const n = d.length;
    if (m === n) return complete ? [] : [treeHash(d)];
    const k = split(n);
    return m <= k ? [...sub(m, d.slice(0, k), complete), treeHash(d.slice(k))] : [...sub(m - k, d.slice(k), false), treeHash(d.slice(0, k))];
  };
  return m === 0 || m >= leaves.length ? [] : sub(m, leaves, true);
}

// RFC 9162 §2.1.3.2: does the audit path take leaf `index` of a tree of `size` to `root`?
export function verifyInclusion(leaf, index, size, proof, root) {
  if (index >= size) return false;
  let fn = index, sn = size - 1, r = leaf;
  for (const p of proof) {
    if (sn === 0) return false;
    if (fn % 2 === 1 || fn === sn) { r = node(p, r); while (fn % 2 === 0 && fn !== 0) { fn >>= 1; sn >>= 1; } }
    else r = node(r, p);
    fn >>= 1; sn >>= 1;
  }
  return sn === 0 && Buffer.compare(r, root) === 0;
}
// RFC 9162 §2.1.4.2: is the tree (size1, root1) a prefix of (size2, root2)?
export function verifyConsistency(size1, size2, proof, root1, root2) {
  if (size1 === size2) return proof.length === 0 && Buffer.compare(root1, root2) === 0;
  if (size1 === 0) return proof.length === 0;
  if (size1 > size2 || proof.length === 0) return false;
  const path = (size1 & (size1 - 1)) === 0 ? [root1, ...proof] : proof; // size1 a power of two: start from root1
  let fn = size1 - 1, sn = size2 - 1;
  while (fn % 2 === 1) { fn >>= 1; sn >>= 1; }
  let fr = path[0], sr = path[0];
  for (const c of path.slice(1)) {
    if (sn === 0) return false;
    if (fn % 2 === 1 || fn === sn) { fr = node(c, fr); sr = node(c, sr); while (fn % 2 === 0 && fn !== 0) { fn >>= 1; sn >>= 1; } }
    else sr = node(sr, c);
    fn >>= 1; sn >>= 1;
  }
  return sn === 0 && Buffer.compare(fr, root1) === 0 && Buffer.compare(sr, root2) === 0;
}

// ---- C2SP signed notes and checkpoints --------------------------------------------------------------------------
const rawKey = (jwk) => Buffer.from(jwk.x, "base64url"); // a 32-byte Ed25519 public key
export const keyId = (name, type, pub) => sha(name, "\n", [type], pub).subarray(0, 4);
// The checkpoint's note text: origin, tree size, base64 root, each line ending in a newline
export const checkpointText = (origin, size, root) => `${origin}\n${size}\n${Buffer.from(root).toString("base64")}\n`;
// The log's own signature line (type 0x01: Ed25519 over the note text)
export function logSignatureLine(origin, text, signFn, pubJwk) {
  return `— ${origin} ${Buffer.concat([keyId(origin, 0x01, rawKey(pubJwk)), signFn(Buffer.from(text))]).toString("base64")}\n`;
}
// A witness's cosignature line (type 0x04: timestamp || Ed25519 over "cosignature/v1", the time, then the note text)
export const cosignatureMessage = (text, time) => `cosignature/v1\ntime ${time}\n${text}`;
export function cosignatureLine(name, text, time, signFn, pubJwk) {
  const ts = Buffer.alloc(8); ts.writeBigUInt64BE(BigInt(time));
  return `— ${name} ${Buffer.concat([keyId(name, 0x04, rawKey(pubJwk)), ts, signFn(Buffer.from(cosignatureMessage(text, time)))]).toString("base64")}\n`;
}
// Parse a signed note: its text, and its signature lines
export function parseNote(note) {
  const i = note.lastIndexOf("\n\n");
  if (i < 0) return null;
  const text = note.slice(0, i + 1), sigs = note.slice(i + 2).split("\n").filter(Boolean).map((l) => { const m = l.match(/^— (\S+) (\S+)$/); return m ? { name: m[1], sig: Buffer.from(m[2], "base64") } : null; }).filter(Boolean);
  const [origin, size, root] = text.split("\n");
  return { text, origin, size: +size, root: Buffer.from(root || "", "base64"), sigs };
}
// Check one key's signature on a note: the log's own (0x01) or a cosigner's (0x04); returns the cosignature's time, or true
export function verifyNoteSig(parsed, name, pubJwk, type) {
  const pub = crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: pubJwk.x }, format: "jwk" }), id = keyId(name, type, rawKey(pubJwk));
  for (const s of parsed.sigs.filter((x) => x.name === name && Buffer.compare(x.sig.subarray(0, 4), id) === 0)) {
    if (type === 0x01 && crypto.verify(null, Buffer.from(parsed.text), pub, s.sig.subarray(4))) return true;
    if (type === 0x04) { const time = Number(s.sig.readBigUInt64BE(4)); if (crypto.verify(null, Buffer.from(cosignatureMessage(parsed.text, time)), pub, s.sig.subarray(12))) return time; }
  }
  return false;
}

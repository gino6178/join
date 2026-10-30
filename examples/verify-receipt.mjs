// Check a Join receipt without trusting Join. This file shares no code with Join's server: it fetches the receipt, then
//   1. hashes the receipt's body (canonical JSON, SHA-256) and compares it with the hash Join signed
//   2. checks Join's Ed25519 signature with the public key Join publishes
//   3. follows the Merkle path from the receipt to its batch's root
//   4. finds that batch in Join's transparency log (an RFC 6962 Merkle tree), checks its inclusion proof against the latest
//      checkpoint, Join's signature on the checkpoint (a C2SP signed note), and any witnesses' cosignatures
//   5. with --head <file>, checks a consistency proof that today's log extends a checkpoint you saved (--save <file>)
//
//   node verify-receipt.mjs rcpt_... [--save checkpoint.txt] [--head checkpoint.txt]      (JOIN_URL defaults to http://localhost:8790)
import crypto from "node:crypto";
import fs from "node:fs";

const args = process.argv.slice(2), opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const [id] = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const JOIN = (process.env.JOIN_URL || "http://localhost:8790").replace(/\/$/, "");
if (!id) { console.error("usage: node verify-receipt.mjs <receipt id> [--save checkpoint.txt] [--head checkpoint.txt]"); process.exit(2); } // (nothing is open yet)

const sha256 = (x) => crypto.createHash("sha256").update(x).digest("hex");
const canonical = (v) => (v === null || typeof v !== "object" ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`);
const pair = (a, b) => sha256(Buffer.from(a < b ? a + b : b + a, "hex"));
// RFC 6962 / 9162 and C2SP signed notes, written out here so this file trusts nothing of Join's code
const H = (...p) => crypto.createHash("sha256").update(Buffer.concat(p.map((x) => Buffer.from(x)))).digest();
const node = (l, r) => H([0x01], l, r), b64d = (x) => Buffer.from(x, "base64");
const leaf = (e) => H([0x00], canonical({ seq: e.seq, batch: e.batch, root: e.root, count: e.count, at: e.at }));
function inclusion(lh, index, size, proof, root) {
  if (index >= size) return false;
  let fn = index, sn = size - 1, r = lh;
  for (const p of proof) { if (sn === 0) return false; if (fn % 2 === 1 || fn === sn) { r = node(p, r); while (fn % 2 === 0 && fn !== 0) { fn >>= 1; sn >>= 1; } } else r = node(r, p); fn >>= 1; sn >>= 1; }
  return sn === 0 && r.equals(root);
}
function consistent(s1, s2, proof, r1, r2) {
  if (s1 === s2) return proof.length === 0 && r1.equals(r2);
  if (s1 === 0 || s1 > s2 || !proof.length) return false;
  const path = (s1 & (s1 - 1)) === 0 ? [r1, ...proof] : proof;
  let fn = s1 - 1, sn = s2 - 1; while (fn % 2 === 1) { fn >>= 1; sn >>= 1; }
  let fr = path[0], sr = path[0];
  for (const c of path.slice(1)) { if (sn === 0) return false; if (fn % 2 === 1 || fn === sn) { fr = node(c, fr); sr = node(c, sr); while (fn % 2 === 0 && fn !== 0) { fn >>= 1; sn >>= 1; } } else sr = node(sr, c); fn >>= 1; sn >>= 1; }
  return sn === 0 && fr.equals(r1) && sr.equals(r2);
}
function parse(raw) {
  const i = raw.lastIndexOf("\n\n"), text = raw.slice(0, i + 1), [, size, root] = text.split("\n");
  return { raw, text, size: +size, root: b64d(root), sigs: raw.slice(i + 2).split("\n").map((l) => l.match(/^— (\S+) (\S+)$/)).filter(Boolean).map((m) => ({ name: m[1], sig: b64d(m[2]) })) };
}
function noteSig(n, name, k, type) {
  const key = crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: k.x }, format: "jwk" }), id = H(name, "\n", [type], Buffer.from(k.x, "base64url")).subarray(0, 4);
  for (const s of n.sigs.filter((x) => x.name === name && x.sig.subarray(0, 4).equals(id))) {
    if (type === 0x01 && crypto.verify(null, Buffer.from(n.text), key, s.sig.subarray(4))) return true;
    if (type === 0x04) { const t = Number(s.sig.readBigUInt64BE(4)); if (crypto.verify(null, Buffer.from(`cosignature/v1\ntime ${t}\n${n.text}`), key, s.sig.subarray(12))) return t; }
  }
  return false;
}
const ok = (b, what, extra = "") => { console.log(`${b ? "✔" : "✘"} ${what}${extra ? `  ${extra}` : ""}`); return b; };

// (exitCode rather than process.exit, so open sockets close first)
process.exitCode = await (async () => {
  const r = await (await fetch(`${JOIN}/api/receipts/${id}`)).json();
  if (r.error) { console.error(r.error); return 1; }
  const pub = await (await fetch(`${JOIN}/.well-known/join-receipts.json`)).json();
  const jwk = pub.keys.find((k) => k.kid === r.kid), key = jwk && crypto.createPublicKey({ key: jwk, format: "jwk" });
  console.log(`Receipt ${r.id}: ${r.body.event}, ${r.body.activity} ${r.body.date} ${r.body.start}, $${(r.body.total / 100).toFixed(2)}`);
  let all = true;
  all &= ok(sha256(canonical(r.body)) === r.hash, "the body hashes to the signed hash", r.hash.slice(0, 16));
  let sig = false;
  try { sig = !!key && crypto.verify(null, Buffer.from(r.hash, "hex"), key, Buffer.from(r.signature, "base64url")); } catch {}
  all &= ok(sig, "Join's signature checks with its published key", r.kid);
  if (!r.batch) { console.log("… not in a batch yet: try again after the next batch"); return all ? 0 : 1; }
  all &= ok(r.proof.reduce((h, s) => pair(h, s), r.hash) === r.batch.root, "the Merkle path leads to the batch's root", r.batch.root.slice(0, 16));

  // the batch's log entry, its inclusion in the tree of Join's latest checkpoint (fetched again from the public endpoints,
  // not taken from the receipt), and Join's signature on that checkpoint
  const note = parse(await (await fetch(`${JOIN}/api/receipts/log/checkpoint`)).text());
  const [entry] = await (await fetch(`${JOIN}/api/receipts/log/entries?from=${r.batch.log}&to=${r.batch.log + 1}`)).json();
  all &= ok(entry?.root === r.batch.root && entry?.batch === r.batch.id, `the batch is entry #${r.batch.log} of Join's transparency log`);
  const inc = await (await fetch(`${JOIN}/api/receipts/log/proof?index=${r.batch.log}&size=${note.size}`)).json();
  all &= ok(!!entry && inclusion(leaf(entry), r.batch.log, note.size, inc.proof.map(b64d), note.root), `that entry is in the log's Merkle tree (RFC 6962), size ${note.size}`);
  all &= ok(noteSig(note, pub.log.origin, jwk, 0x01) === true, `the checkpoint is signed by Join's log key`, pub.log.origin);
  for (const w of pub.log.witnesses || []) { const t = noteSig(note, w.name, w.jwk, 0x04); console.log(`${t ? "✔" : "·"} witness ${w.name} ${t ? `cosigned it at ${new Date(t * 1000).toISOString()}` : "hasn't cosigned this checkpoint yet"}`); }

  // a checkpoint saved earlier: today's tree must extend it (a consistency proof)
  const kept = opt("--head");
  if (kept) {
    const old = parse(fs.readFileSync(kept, "utf8"));
    const c = await (await fetch(`${JOIN}/api/receipts/log/consistency?from=${old.size}&to=${note.size}`)).json();
    all &= ok(noteSig(old, pub.log.origin, jwk, 0x01) === true && consistent(old.size, note.size, c.proof.map(b64d), old.root, note.root), `today's log (size ${note.size}) extends the checkpoint you kept (size ${old.size})`);
  }
  if (opt("--save")) { fs.writeFileSync(opt("--save"), note.raw); console.log(`saved the current checkpoint to ${opt("--save")}: keep it; later checkpoints must extend it`); }
  console.log(all ? "\nThis receipt is exactly as Join recorded it, and Join's log of it hasn't been rewritten." : "\nSomething does not check out.");
  return all ? 0 : 1;
})();

// Check a Join receipt without trusting Join. This file shares no code with Join's server: it fetches the receipt, then
//   1. hashes the receipt's body (canonical JSON, SHA-256) and compares it with the hash Join signed
//   2. checks Join's Ed25519 signature with the public key Join publishes
//   3. follows the Merkle path from the receipt to its batch's root
//   4. follows Join's audit log from that batch's entry to the latest head: each entry's hash, each link to the entry
//      before, and Join's signature on the head
//   5. with --head <file>, checks that today's log still extends a head you saved earlier (save one with --save <file>)
//
//   node verify-receipt.mjs rcpt_... [--save head.json] [--head head.json]      (JOIN_URL defaults to http://localhost:8790)
import crypto from "node:crypto";
import fs from "node:fs";

const args = process.argv.slice(2), opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const [id] = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const JOIN = (process.env.JOIN_URL || "http://localhost:8790").replace(/\/$/, "");
if (!id) { console.error("usage: node verify-receipt.mjs <receipt id> [--save head.json] [--head head.json]"); process.exit(2); } // (nothing is open yet)

const sha256 = (x) => crypto.createHash("sha256").update(x).digest("hex");
const canonical = (v) => (v === null || typeof v !== "object" ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`);
const pair = (a, b) => sha256(Buffer.from(a < b ? a + b : b + a, "hex"));
const entryHash = (e) => sha256(canonical({ seq: e.seq, batch: e.batch, root: e.root, count: e.count, at: e.at, prev: e.prev }));
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

  // the log, fetched again from the public endpoint rather than taken from the receipt
  const { entries, head } = await (await fetch(`${JOIN}/api/receipts/log?from=${r.batch.log}`)).json();
  all &= ok(entries[0]?.seq === r.batch.log && entries[0]?.root === r.batch.root, `the batch is entry #${r.batch.log} of Join's audit log`);
  let chained = true;
  entries.forEach((e, i) => { if (entryHash(e) !== e.hash || (i > 0 && e.prev !== entries[i - 1].hash)) chained = false; });
  all &= ok(chained, `each entry after it is hashed and linked to the one before (${entries.length} entries)`);
  const last = entries.at(-1);
  let headSig = false;
  try { headSig = head.size === last.seq + 1 && head.head === last.hash && crypto.verify(null, Buffer.from(canonical({ type: "JoinAuditLogHead", size: head.size, head: head.head, at: head.at })), key, Buffer.from(head.signature, "base64url")); } catch {}
  all &= ok(headSig, `the log's head is signed by Join`, `size ${head.size}, ${head.head.slice(0, 16)}, ${head.at}`);

  // a head saved earlier must still be in the log, unchanged
  const kept = opt("--head");
  if (kept) {
    const h = JSON.parse(fs.readFileSync(kept, "utf8"));
    const past = (await (await fetch(`${JOIN}/api/receipts/log?from=${h.size - 1}`)).json()).entries[0];
    all &= ok(!!past && past.hash === h.head, `today's log extends the head you kept (size ${h.size})`);
  }
  if (opt("--save")) { fs.writeFileSync(opt("--save"), JSON.stringify(head, null, 2)); console.log(`saved the current head to ${opt("--save")}: keep it; later heads must extend it`); }
  console.log(all ? "\nThis receipt is exactly as Join recorded it, and Join's log of it hasn't been rewritten." : "\nSomething does not check out.");
  return all ? 0 : 1;
})();

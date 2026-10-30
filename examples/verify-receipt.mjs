// Check a Join receipt without trusting Join. This file shares no code with Join's server: it fetches the receipt, then
//   1. hashes the receipt's body (canonical JSON, SHA-256) and compares it with the hash Join signed
//   2. checks Join's Ed25519 signature with the public key Join publishes
//   3. follows the Merkle path from the receipt to its batch's root, and from the batch root to the seal's root
//   4. with the chain's RPC, reads the transaction and checks that its data is "JOIN" + that root, sent from the address
//      Join publishes (any EVM chain: a local Hardhat / Anvil node, Base Sepolia, ...)
//
//   node verify-receipt.mjs rcpt_... [--rpc <the chain's RPC URL>]      (JOIN_URL defaults to http://localhost:8790)
import crypto from "node:crypto";

const [id] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const rpc = process.argv.includes("--rpc") ? process.argv[process.argv.indexOf("--rpc") + 1] : process.env.ANCHOR_RPC_URL;
const JOIN = (process.env.JOIN_URL || "http://localhost:8790").replace(/\/$/, "");
if (!id) { console.error("usage: node verify-receipt.mjs <receipt id> [--rpc <chain RPC URL>]"); process.exit(2); } // (nothing is open yet)

const sha256 = (x) => crypto.createHash("sha256").update(x).digest("hex");
const canonical = (v) => (v === null || typeof v !== "object" ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`);
const pair = (a, b) => sha256(Buffer.from(a < b ? a + b : b + a, "hex"));
const ok = (b, what, extra = "") => { console.log(`${b ? "✔" : "✘"} ${what}${extra ? `  ${extra}` : ""}`); return b; };

// (exitCode rather than process.exit, so open sockets close first)
process.exitCode = await (async () => {
  const r = await (await fetch(`${JOIN}/api/receipts/${id}`)).json();
  if (r.error) { console.error(r.error); return 1; }
  const pub = await (await fetch(`${JOIN}/.well-known/join-receipts.json`)).json();
  const key = pub.keys.find((k) => k.kid === r.kid);
  console.log(`Receipt ${r.id}: ${r.body.event}, ${r.body.activity} ${r.body.date} ${r.body.start}, $${(r.body.total / 100).toFixed(2)}`);
  let all = true;
  all &= ok(sha256(canonical(r.body)) === r.hash, "the body hashes to the signed hash", r.hash.slice(0, 16));
  let sig = false;
  try { sig = !!key && crypto.verify(null, Buffer.from(r.hash, "hex"), crypto.createPublicKey({ key, format: "jwk" }), Buffer.from(r.signature, "base64url")); } catch {}
  all &= ok(sig, "Join's signature checks with its published key", r.kid);
  if (!r.batch) { console.log("… not in a batch yet: try again after the next batch"); return all ? 0 : 1; }
  all &= ok(r.proof.reduce((h, s) => pair(h, s), r.hash) === r.batch.root, "the Merkle path leads to the batch's root", r.batch.root.slice(0, 16));
  let root = r.batch.root, a = r.batch.anchor;
  if (r.seal) {
    all &= ok(r.seal.proof.reduce((h, s) => pair(h, s), r.batch.root) === r.seal.root, `the batch root leads to the seal's root (${r.seal.batches} batches, ${r.seal.receipts} receipts)`, r.seal.root.slice(0, 16));
    root = r.seal.root; a = r.seal.anchor;
  }
  if (!a || a.error) { console.log(`… not on chain yet${a?.error ? ` (${a.error})` : ""}: the signature and the Merkle path are the proof so far`); return all ? 0 : 1; }
  if (!rpc) { console.log(`… on ${a.chain} in ${a.tx}; pass --rpc <its RPC URL> to check it yourself${a.url ? `: ${a.url}` : ""}`); return all ? 0 : 1; }
  const t = (await (await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionByHash", params: [a.tx] }) })).json()).result;
  all &= ok(!!t && String(t.input).toLowerCase() === `0x4a4f494e${root}`, "the transaction's data is JOIN + the root", a.tx);
  all &= ok(!!t && pub.chain && t.from.toLowerCase() === pub.chain.from.toLowerCase(), "it was sent from Join's published address", t?.from);
  all &= ok(!!t?.blockNumber, `it is in a block on ${a.chain}`, t?.blockNumber ? `#${parseInt(t.blockNumber, 16)}` : "");
  console.log(all ? "\nThis receipt is exactly as it was when that block was made." : "\nSomething does not check out.");
  return all ? 0 : 1;
})();

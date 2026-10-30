// Check a Join receipt without trusting Join. This file shares no code with Join's server: it fetches the receipt, then
//   1. hashes the receipt's body (canonical JSON, SHA-256) and compares it with the hash Join signed
//   2. checks Join's Ed25519 signature with the public key Join publishes
//   3. follows the Merkle path from the hash to the batch's root
//   4. with an Ethereum Sepolia RPC, reads the anchoring transaction and checks that its data is "JOIN" + that root,
//      sent from the address Join publishes
//
//   node verify-receipt.mjs rcpt_... [--rpc https://sepolia-rpc...]      (JOIN_URL defaults to http://localhost:8790)
import crypto from "node:crypto";

const [id] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const rpc = process.argv.includes("--rpc") ? process.argv[process.argv.indexOf("--rpc") + 1] : process.env.SEPOLIA_RPC_URL;
const JOIN = (process.env.JOIN_URL || "http://localhost:8790").replace(/\/$/, "");
if (!id) { console.error("usage: node verify-receipt.mjs <receipt id> [--rpc <Sepolia RPC URL>]"); process.exit(2); } // (nothing is open yet)

const sha256 = (x) => crypto.createHash("sha256").update(x).digest("hex");
const canonical = (v) => (v === null || typeof v !== "object" ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`);
const pair = (a, b) => sha256(Buffer.from(a < b ? a + b : b + a, "hex"));
const ok = (b, what, extra = "") => { console.log(`${b ? "✔" : "✘"} ${what}${extra ? `  ${extra}` : ""}`); return b; };

// (exitCode rather than process.exit, so open sockets close first)
process.exitCode = await (async () => {
  const r = await (await fetch(`${JOIN}/api/receipts/${id}`)).json();
  if (r.error) { console.error(r.error); return 1; }
  const pub = (await (await fetch(`${JOIN}/.well-known/join-receipts.json`)).json());
  const key = pub.keys.find((k) => k.kid === r.kid);
  console.log(`Receipt ${r.id}: ${r.body.event}, ${r.body.sport} ${r.body.date} ${r.body.start}, $${(r.body.total / 100).toFixed(2)}`);
  let all = true;
  all &= ok(sha256(canonical(r.body)) === r.hash, "the body hashes to the signed hash", r.hash.slice(0, 16));
  let sig = false;
  try { sig = !!key && crypto.verify(null, Buffer.from(r.hash, "hex"), crypto.createPublicKey({ key, format: "jwk" }), Buffer.from(r.signature, "base64url")); } catch {}
  all &= ok(sig, "Join's signature checks with its published key", r.kid);
  if (!r.batch) { console.log("… not in a batch yet: try again after the next batch"); return all ? 0 : 1; }
  all &= ok(r.proof.reduce((h, s) => pair(h, s), r.hash) === r.batch.root, "the Merkle path leads to the batch's root", r.batch.root.slice(0, 16));
  const a = r.batch.anchor;
  if (!a || a.error) { console.log(`… the batch is not anchored on chain${a?.error ? ` (${a.error})` : ""}`); return all ? 0 : 1; }
  if (!rpc) { console.log(`… anchored in ${a.tx} on ${a.chain}; pass --rpc <Sepolia RPC URL> to check it yourself: ${a.url}`); return all ? 0 : 1; }
  const t = (await (await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionByHash", params: [a.tx] }) })).json()).result;
  all &= ok(!!t && String(t.input).toLowerCase() === `0x4a4f494e${r.batch.root}`, "the transaction's data is JOIN + the root", a.tx);
  all &= ok(!!t && pub.chain && t.from.toLowerCase() === pub.chain.from.toLowerCase(), "it was sent from Join's published address", t?.from);
  all &= ok(!!t?.blockNumber, "it is in a block", t?.blockNumber ? `#${parseInt(t.blockNumber, 16)}` : "");
  console.log(all ? "\nThis receipt is exactly as it was when that block was made." : "\nSomething does not check out.");
  return all ? 0 : 1;
})();

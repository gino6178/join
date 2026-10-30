import { useEffect, useState } from "react";
import { api, money } from "../api.js";
import Icon from "../components/Icon.jsx";
import { sha256 as nobleSha256, sha512 } from "@noble/hashes/sha2.js";
import * as ed from "@noble/ed25519";

// A receipt anyone can check, in their own browser with WebCrypto: the body's hash, Join's Ed25519 signature, the Merkle
// path to the batch's root, and Join's audit log from that batch to a signed head (every entry hashed and linked to the
// one before). The checks run here, not on Join's server.
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));
// WebCrypto where the browser offers it (HTTPS or localhost); elsewhere (Join on a LAN address over plain HTTP) the
// same checks with the audited noble libraries, still entirely in this browser
const subtle = globalThis.crypto?.subtle;
ed.hashes.sha512 = sha512;
const sha = async (bytes) => hex(subtle ? await subtle.digest("SHA-256", bytes) : nobleSha256(bytes));
async function edVerify(jwk, sig, msg) {
  if (subtle) { const k = await subtle.importKey("jwk", { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, { name: "Ed25519" }, false, ["verify"]); return subtle.verify({ name: "Ed25519" }, k, sig, msg); }
  return ed.verify(sig, msg, b64u(jwk.x));
}
const canonical = (v) => (v === null || typeof v !== "object" ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`);
const pair = (a, b) => sha(fromHex(a < b ? a + b : b + a));
const b64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "==".slice(0, (4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));

const entryHash = (e) => sha(new TextEncoder().encode(canonical({ seq: e.seq, batch: e.batch, root: e.root, count: e.count, at: e.at, prev: e.prev })));

async function check(r) {
  const t0 = performance.now(), out = {};
  out.hash = (await sha(new TextEncoder().encode(canonical(r.body)))) === r.hash;
  try { out.signature = await edVerify(r.publicKey, b64u(r.signature), fromHex(r.hash)); } catch { out.signature = null; } // (if that fails: the verifier script)
  if (r.proof && r.batch) { let h = r.hash; for (const s of r.proof) h = await pair(h, s); out.proof = h === r.batch.root; }
  if (r.batch && r.log?.head) {
    const { entries, head } = r.log;
    let good = entries[0]?.seq === r.batch.log && entries[0]?.root === r.batch.root;
    for (let i = 0; good && i < entries.length; i++) good = (await entryHash(entries[i])) === entries[i].hash && (i === 0 || entries[i].prev === entries[i - 1].hash);
    const last = entries.at(-1);
    good &&= head.size === last.seq + 1 && head.head === last.hash;
    out.chain = good;
    try { out.head = await edVerify(r.publicKey, b64u(head.signature), new TextEncoder().encode(canonical({ type: "JoinAuditLogHead", size: head.size, head: head.head, at: head.at }))); } catch { out.head = null; }
  }
  out.ms = Math.max(1, Math.round(performance.now() - t0));
  return out;
}

export default function Receipt({ id }) {
  const [r, setR] = useState(null), [c, setC] = useState(null), [err, setErr] = useState(null);
  useEffect(() => { api(`/api/receipts/${id}`).then(async (x) => { setR(x); setC(await check(x)); }).catch(setErr); }, [id]);
  if (err) return <div className="page"><p className="err">{err.message}</p></div>;
  if (!r) return <div className="page"><p className="muted">Loading…</p></div>;
  const b = r.body, verified = c && c.hash && c.signature && c.proof && c.chain && c.head;
  const row = (state, label, detail) => <li className={state === true ? "yes" : state === false ? "no" : "wait"}><Icon name={state === true ? "check" : state === false ? "close" : "clock"} size={16} /><span><b>{label}</b><small>{detail}</small></span></li>;
  return (
    <div className="page">
      <header className="page-head"><h1>Receipt</h1><p className="muted">Proof that this deal and its payments have not changed since they were recorded. Checked here, in your browser.</p></header>
      <section className="card">
        <h3><Icon name="verify" size={18} />{b.event === "locked" ? "Paid and locked" : b.event === "refunded" ? "Cancelled and refunded" : "Venue paid"}</h3>
        <p>{b.activity} · {b.date} {b.start} · {b.minutes} min · {b.unitName} · <b>{money(b.total / 100)}</b></p>
        {verified && <p className="verified-badge"><Icon name="verify" size={18} />Cryptographically verified in your browser · {c.ms} ms{subtle ? "" : " (noble)"}</p>}
        <ul className="can checks">
          {row(c?.hash, "The receipt is complete and unchanged", `SHA-256 ${r.hash.slice(0, 24)}…`)}
          {row(c?.signature, c?.signature === null ? "Signature: check with the verifier script" : "Signed by Join", `Ed25519, key ${r.kid}`)}
          {row(r.batch ? c?.proof : null, r.batch ? "In a batch of receipts" : "Waiting for the next batch", r.batch ? `${r.batch.count} receipts, Merkle root ${r.batch.root.slice(0, 24)}…` : "batches close every few minutes")}
          {r.batch && row(c?.chain, "In Join's audit log, unchanged since", `entry #${r.batch.log}, ${r.log.entries.length - 1} entr${r.log.entries.length === 2 ? "y" : "ies"} after it, each linked to the one before`)}
          {r.batch && row(c?.head, c?.head === null ? "Log head: check with the verifier script" : "The log's head is signed by Join", `size ${r.log.head.size}, head ${r.log.head.head.slice(0, 24)}…, ${r.log.head.at.slice(0, 16).replace("T", " ")}`)}
        </ul>
        {r.batch && <p className="small muted">Keep a copy of the head (<code>verify-receipt.mjs --save</code>): any later head must extend it, so an earlier entry can't be changed or dropped without it showing.</p>}
      </section>
      {r.you && <p className="note good">You are in this receipt as <code>{r.you.player.slice(0, 16)}…</code> (your player id, hashed with your salt). Other players can't be identified from it.</p>}
      <section className="card">
        <h3>The negotiation</h3>
        <ol className="neg-steps">{b.negotiation.map((h, i) => <li key={i}><b>{h.by === "organizer" ? "Organizer's agent" : h.by === "venue" ? "Venue" : h.by}</b> {h.type}{h.amount != null && ` ${money(h.amount / 100)}`}</li>)}</ol>
        <h3>The payments</h3>
        <table className="pays"><thead><tr><th>Player</th><th>Share</th><th>Paid</th><th>PayPal ids</th></tr></thead><tbody>
          {b.payments.map((p, i) => <tr key={i}><td><code>{p.player.slice(0, 10)}…</code>{p.role === "organizer" && <small> organizer</small>}</td><td>{money(p.share / 100)}</td><td>{p.captured ? money(p.captured / 100) : p.status}</td><td><small>{[p.paypal.order, p.paypal.capture].filter(Boolean).join(" · ")}</small></td></tr>)}
        </tbody></table>
        <p className="small muted">What this proves: Join signed this receipt exactly so, and logged it in the batch above. Whether PayPal moved the money is PayPal's record; the ids above point to it.</p>
      </section>
      <section className="card snippet"><h3>Check it yourself</h3><pre>{`node examples/verify-receipt.mjs ${r.id} --save head.json`}</pre></section>
    </div>
  );
}

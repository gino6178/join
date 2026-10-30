import { useEffect, useState } from "react";
import { api, money } from "../api.js";
import Icon from "../components/Icon.jsx";

// A receipt anyone can check, in their own browser: the body's hash, Join's signature, the Merkle path to the batch's
// root, and the transaction that put the root on Ethereum Sepolia. The checks run here, not on Join's server.
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));
const sha = async (bytes) => hex(await crypto.subtle.digest("SHA-256", bytes));
const canonical = (v) => (v === null || typeof v !== "object" ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`);
const pair = (a, b) => sha(fromHex(a < b ? a + b : b + a));
const b64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "==".slice(0, (4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));

async function check(r) {
  const out = {};
  out.hash = (await sha(new TextEncoder().encode(canonical(r.body)))) === r.hash;
  try {
    const k = await crypto.subtle.importKey("jwk", { kty: r.publicKey.kty, crv: r.publicKey.crv, x: r.publicKey.x }, { name: "Ed25519" }, false, ["verify"]);
    out.signature = await crypto.subtle.verify({ name: "Ed25519" }, k, b64u(r.signature), fromHex(r.hash));
  } catch { out.signature = null; } // (a browser without Ed25519 in WebCrypto: use the verifier script)
  if (r.proof && r.batch) { let h = r.hash; for (const s of r.proof) h = await pair(h, s); out.proof = h === r.batch.root; }
  return out;
}

export default function Receipt({ id }) {
  const [r, setR] = useState(null), [c, setC] = useState(null), [err, setErr] = useState(null), [chain, setChain] = useState(undefined);
  useEffect(() => { api(`/api/receipts/${id}`).then(async (x) => { setR(x); setC(await check(x)); }).catch(setErr); }, [id]);
  useEffect(() => { api("/.well-known/join-receipts.json").then((k) => setChain(k.chain)).catch(() => setChain(null)); }, []);
  if (err) return <div className="page"><p className="err">{err.message}</p></div>;
  if (!r) return <div className="page"><p className="muted">Loading…</p></div>;
  const b = r.body, a = r.batch?.anchor;
  const row = (state, label, detail) => <li className={state === true ? "yes" : state === false ? "no" : "wait"}><Icon name={state === true ? "check" : state === false ? "close" : "clock"} size={16} /><span><b>{label}</b><small>{detail}</small></span></li>;
  return (
    <div className="page">
      <header className="page-head"><h1>Receipt</h1><p className="muted">Proof that this deal and its payments have not changed since they were recorded. Checked here, in your browser.</p></header>
      <section className="card">
        <h3><Icon name="verify" size={18} />{b.event === "locked" ? "Court paid and locked" : b.event === "refunded" ? "Cancelled and refunded" : "Venue paid"}</h3>
        <p>{b.sport} · {b.date} {b.start} · {b.minutes} min · court {b.court} · <b>{money(b.total / 100)}</b></p>
        <ul className="can checks">
          {row(c?.hash, "The receipt is complete and unchanged", `SHA-256 ${r.hash.slice(0, 24)}…`)}
          {row(c?.signature, c?.signature === null ? "Signature: check with the verifier script" : "Signed by Join", `Ed25519, key ${r.kid}`)}
          {row(r.batch ? c?.proof : null, r.batch ? "In a batch of receipts" : "Waiting for the next batch", r.batch ? `${r.batch.count} receipts, Merkle root ${r.batch.root.slice(0, 24)}…` : "batches close every few minutes")}
          {(a?.tx || chain) && row(a?.tx ? true : null, a?.tx ? "Recorded on Ethereum Sepolia" : a?.error ? "Not recorded on chain: the transaction failed" : "Not recorded on chain yet", a?.tx ? `block ${a.block}, transaction ${a.tx.slice(0, 18)}…` : "the next batch goes on chain in a few minutes")}
        </ul>
        {a?.url && <a className="btn" href={a.url} target="_blank" rel="noreferrer">See the transaction on Etherscan</a>}
        {chain === null && !a?.tx && <p className="small muted">This Join doesn't publish batch roots on a public chain; the signature and the Merkle path are the proof. With a chain configured, each batch's root also goes on Ethereum Sepolia as a public timestamp.</p>}
      </section>
      {r.you && <p className="note good">You are in this receipt as <code>{r.you.player.slice(0, 16)}…</code> (your player id, hashed with your salt). Other players can't be identified from it.</p>}
      <section className="card">
        <h3>The negotiation</h3>
        <ol className="neg-steps">{b.negotiation.map((h, i) => <li key={i}><b>{h.by === "organizer" ? "Organizer's agent" : h.by === "venue" ? "Venue" : h.by}</b> {h.type}{h.amount != null && ` ${money(h.amount / 100)}`}</li>)}</ol>
        <h3>The payments</h3>
        <table className="pays"><thead><tr><th>Player</th><th>Share</th><th>Paid</th><th>PayPal ids</th></tr></thead><tbody>
          {b.payments.map((p, i) => <tr key={i}><td><code>{p.player.slice(0, 10)}…</code>{p.role === "organizer" && <small> organizer</small>}</td><td>{money(p.share / 100)}</td><td>{p.captured ? money(p.captured / 100) : p.status}</td><td><small>{[p.paypal.order, p.paypal.capture].filter(Boolean).join(" · ")}</small></td></tr>)}
        </tbody></table>
        <p className="small muted">What this proves: the receipt existed exactly so by the time of that block. Whether PayPal moved the money is PayPal's record; the ids above point to it.</p>
      </section>
      <section className="card snippet"><h3>Check it yourself</h3><pre>{`node examples/verify-receipt.mjs ${r.id}${a?.tx ? " --rpc <a Sepolia RPC URL>" : ""}`}</pre></section>
    </div>
  );
}

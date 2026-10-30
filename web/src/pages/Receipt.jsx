import { useEffect, useState } from "react";
import { tr, lang, setLang } from "../i18n.js";
import { api, money } from "../api.js";
import Icon from "../components/Icon.jsx";
import { sha256 as nobleSha256, sha512 } from "@noble/hashes/sha2.js";
import * as ed from "@noble/ed25519";

// A receipt anyone can check, in their own browser: the body's hash, Join's Ed25519 signature, the Merkle path to the
// batch's root, the batch's inclusion in Join's transparency log (RFC 6962) and Join's signature on the log's checkpoint
// (a C2SP signed note), with any witnesses' cosignatures. The checks run here, not on Join's server.
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

// RFC 6962 / 9162: a leaf's hash, a node's, and the inclusion proof's walk up to the root (async: SHA-256 is)
const cat = (...xs) => { const out = new Uint8Array(xs.reduce((a, x) => a + x.length, 0)); let i = 0; for (const x of xs) { out.set(x, i); i += x.length; } return out; };
const enc = (t) => new TextEncoder().encode(t), b64 = (t) => Uint8Array.from(atob(t), (c) => c.charCodeAt(0));
const leafHash = async (e) => fromHex(await sha(cat([0], enc(canonical({ seq: e.seq, batch: e.batch, root: e.root, count: e.count, at: e.at })))));
const nodeHash = async (l, r) => fromHex(await sha(cat([1], l, r)));
async function included(lh, index, size, proof, root) {
  if (index >= size) return false;
  let fn = index, sn = size - 1, r = lh;
  for (const p of proof) { if (sn === 0) return false; if (fn % 2 === 1 || fn === sn) { r = await nodeHash(p, r); while (fn % 2 === 0 && fn !== 0) { fn >>= 1; sn >>= 1; } } else r = await nodeHash(r, p); fn >>= 1; sn >>= 1; }
  return sn === 0 && hex(r) === hex(root);
}
// a C2SP signed note: its text, the root on its third line, and the signature line for a key name
function parseNote(raw) {
  const i = raw.lastIndexOf("\n\n"), text = raw.slice(0, i + 1), [, size, root] = text.split("\n");
  return { text, size: +size, root: b64(root), sigs: raw.slice(i + 2).split("\n").map((l) => l.match(/^— (\S+) (\S+)$/)).filter(Boolean).map((m) => ({ name: m[1], sig: b64(m[2]) })) };
}

async function check(r) {
  const t0 = performance.now(), out = {};
  out.hash = (await sha(new TextEncoder().encode(canonical(r.body)))) === r.hash;
  try { out.signature = await edVerify(r.publicKey, b64u(r.signature), fromHex(r.hash)); } catch { out.signature = null; } // (if that fails: the verifier script)
  if (r.proof && r.batch) { let h = r.hash; for (const s of r.proof) h = await pair(h, s); out.proof = h === r.batch.root; }
  if (r.batch && r.log?.checkpoint) {
    const l = r.log, cp = parseNote(l.checkpoint);
    out.chain = l.entry.root === r.batch.root && l.entry.seq === r.batch.log && cp.size === l.size && await included(await leafHash(l.entry), l.index, l.size, l.proof.map(b64), cp.root);
    const s = cp.sigs.find((x) => x.name === l.origin);
    try { out.head = s ? await edVerify(r.publicKey, s.sig.slice(4), enc(cp.text)) : false; } catch { out.head = null; }
    out.witnesses = cp.sigs.filter((x) => x.name !== l.origin).map((x) => x.name);
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
      <header className="page-head"><h1>{tr("Receipt")}</h1><p className="muted">Proof that this deal and its payments have not changed since they were recorded. Checked here, in your browser.</p></header>
      <section className="card">
        <h3><Icon name="verify" size={18} />{b.event === "locked" ? tr("Paid and locked") : b.event === "refunded" ? "Cancelled and refunded" : tr("Venue paid")}</h3>
        <p>{b.activity} · {b.date} {b.start} · {b.minutes} min · {b.unitName} · <b>{money(b.total / 100)}</b></p>
        {verified && <p className="verified-badge"><Icon name="verify" size={18} />Cryptographically verified in your browser · {c.ms} ms{subtle ? "" : " (noble)"}</p>}
        <ul className="can checks">
          {row(c?.hash, "The receipt is complete and unchanged", `SHA-256 ${r.hash.slice(0, 24)}…`)}
          {row(c?.signature, c?.signature === null ? "Signature: check with the verifier script" : "Signed by Join", `Ed25519, key ${r.kid}`)}
          {row(r.batch ? c?.proof : null, r.batch ? "In a batch of receipts" : "Waiting for the next batch", r.batch ? `${r.batch.count} receipt${r.batch.count === 1 ? "" : "s"}, Merkle root ${r.batch.root.slice(0, 24)}…` : "batches close every few minutes")}
          {r.log && row(c?.chain, "In Join's transparency log", `entry #${r.batch.log} of ${r.log.size}, inclusion proof (RFC 6962) to the checkpoint's root`)}
          {r.log && row(c?.head, c?.head === null ? "Checkpoint: check with the verifier script" : "The checkpoint is signed by Join", `${r.log.origin}, size ${r.log.size} (a C2SP signed note)${c?.witnesses?.length ? `; cosigned by ${c.witnesses.join(", ")}` : "; no witness has cosigned it yet"}`)}
        </ul>
        {r.log && <p className="small muted">Keep a copy of the checkpoint (<code>verify-receipt.mjs --save</code>): later ones must extend it, which a consistency proof shows. Witnesses do the same and cosign, so Join can't rewrite or fork its history unnoticed.</p>}
      </section>
      {r.you && <p className="note good">You are in this receipt as <code>{r.you.player.slice(0, 16)}…</code> (your player id, hashed with your salt). Other players can't be identified from it.</p>}
      <section className="card">
        <h3>{tr("The negotiation")}</h3>
        <ol className="neg-steps">{b.negotiation.map((h, i) => <li key={i}><b>{h.by === "organizer" ? "Organizer's agent" : h.by === "venue" ? tr("Venue") : h.by}</b> {h.type}{h.amount != null && ` ${money(h.amount / 100)}`}</li>)}</ol>
        <h3>The payments</h3>
        <table className="pays"><thead><tr><th>{tr("Player")}</th><th>Share</th><th>Paid</th><th>PayPal ids</th></tr></thead><tbody>
          {b.payments.map((p, i) => <tr key={i}><td><code>{p.player.slice(0, 10)}…</code>{p.role === "organizer" && <small> organizer</small>}</td><td>{money(p.share / 100)}</td><td>{p.captured ? money(p.captured / 100) : p.status}</td><td><small>{[p.paypal.order, p.paypal.capture].filter(Boolean).join(" · ")}</small></td></tr>)}
        </tbody></table>
        <p className="small muted">What this proves: Join signed this receipt exactly so, and logged it in the batch above. Whether PayPal moved the money is PayPal's record; the ids above point to it.</p>
      </section>
      <section className="card snippet"><h3>Check it yourself</h3><p className="small muted">The checks above already ran in your browser. To check again without trusting this page, run Join's verifier from <a href="https://github.com/gino6178/join" target="_blank" rel="noreferrer">its public repository</a> (it shares no code with Join's server):</p><pre>{`node examples/verify-receipt.mjs ${r.id} --save checkpoint.txt`}</pre></section>
    </div>
  );
}

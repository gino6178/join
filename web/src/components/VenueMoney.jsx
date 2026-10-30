import { useEffect, useState } from "react";
import { api, money } from "../api.js";
import Icon from "./Icon.jsx";

// The venue's money, for its staff, on the PayPal Agent Toolkit (Join's back office calls the same tools PayPal gives AI
// agents): every capture and payout matched to PayPal's own transaction records, extras billed to a group's organizer
// with a PayPal invoice, and chargebacks answered with Join's signed receipt as evidence.
export default function VenueMoney({ id, bookings, reload }) {
  const [rec, setRec] = useState(null), [disp, setDisp] = useState(null), [msg, setMsg] = useState(null), [err, setErr] = useState(null), [busy, setBusy] = useState(false);
  const load = () => {
    api(`/api/venues/${id}/reconcile`).then(setRec).catch((e) => setErr(e.message));
    api(`/api/venues/${id}/disputes`).then(setDisp).catch((e) => setErr(e.message));
  };
  useEffect(() => { setMsg(null); setErr(null); load(); }, [id]);
  const paid = bookings.filter((b) => ["locked", "played", "venue_paid"].includes(b.state));
  const act = async (fn, ok) => { setBusy(true); setErr(null); try { const r = await fn(); setMsg(ok(r)); load(); reload?.(); } catch (e) { setErr(e.message); } setBusy(false); };
  return (
    <>
      <section className="card">
        <h3><Icon name="list" size={18} />Reconciliation <small className="muted">PayPal Agent Toolkit · list_transactions{rec?.mode === "stand-in" ? " · stand-in" : ""}</small></h3>
        {msg && <p className="note good">{msg}</p>}{err && <p className="err">{err}</p>}
        {!rec ? <p className="muted small">Loading…</p> : !rec.rows.length ? <p className="muted small">No payments yet.</p> : <table className="pays"><thead><tr><th>Booking</th><th>What</th><th>Amount</th><th>PayPal fee</th><th>In PayPal's records</th></tr></thead><tbody>
          {rec.rows.map((r) => <tr key={r.id}><td><small>{r.booking.slice(-6)}</small></td><td>{r.kind === "payout" ? "payout to you" : `share (${r.who})`}</td><td>{money(r.amount / 100)}</td><td>{r.fee != null ? money(r.fee / 100) : ""}</td><td><span className={`st ${r.paypal === "matched" ? "captured" : "awaiting_approval"}`}>{r.paypal}</span></td></tr>)}
        </tbody></table>}
        {rec?.error && <p className="small err">{rec.error}</p>}
      </section>
      {paid.length > 0 && <section className="card">
        <h3><Icon name="send" size={18} />Bill extras <small className="muted">PayPal invoice to the organizer · create_invoice, send_invoice</small></h3>
        {paid.map((b) => <Extras key={b.id} b={b} busy={busy} onBill={(items) => act(() => api(`/api/venues/${id}/bookings/${b.id}/extras`, { method: "POST", body: { items } }), (r) => `Invoice sent: ${money(r.total)}.`)} />)}
      </section>}
      <section className="card">
        <h3><Icon name="warn" size={18} />Disputes <small className="muted">list_disputes · answered with the signed receipt</small></h3>
        {!disp?.disputes?.length ? <p className="muted small">No disputes on this venue's payments.</p> : <ul className="tokens">{disp.disputes.map((d) => (
          <li key={d.id}><span><b>{d.id}</b><small>{String(d.reason).toLowerCase().replace(/_/g, " ")} · ${d.amount} · {String(d.status).toLowerCase().replace(/_/g, " ")}{d.booking ? ` · booking ${d.booking.slice(-6)}` : ""}</small></span>
            {d.status === "WAITING_FOR_SELLER_RESPONSE" && d.receipt && <button className="btn small" disabled={busy} onClick={() => act(() => api(`/api/venues/${id}/disputes/${d.id}/answer`, { method: "POST" }), () => "Sent the signed receipt to PayPal as evidence.")}>Answer with the receipt</button>}</li>))}</ul>}
        {disp?.toolkit === "stand-in" && paid[0]?.captures?.[0] && <button className="btn ghost small" disabled={busy} onClick={() => act(() => api("/api/demo/dispute", { method: "POST", body: { capture: paid[0].captures[0] } }), () => "A buyer opened a dispute (stand-in).")}>Simulate a buyer's dispute</button>}
      </section>
    </>
  );
}

function Extras({ b, onBill, busy }) {
  const [name, setName] = useState(""), [amt, setAmt] = useState("");
  return (
    <form className="ask-less" onSubmit={(e) => { e.preventDefault(); if (name && +amt > 0) onBill([{ name, amount: Math.round(+amt * 100) }]); setName(""); setAmt(""); }}>
      <span className="small"><b>{b.date} {b.start}</b> · {b.unitName} · {b.activity}{b.extras?.length ? ` · billed ${b.extras.map((x) => `$${x.total} (${x.status})`).join(", ")}` : ""}</span>
      <input placeholder="Overtime, 30 min" value={name} onChange={(e) => setName(e.target.value)} />
      <span className="money-in">$<input type="number" min="0" step="0.5" value={amt} onChange={(e) => setAmt(e.target.value)} /></span>
      <button className="btn ghost small" disabled={busy || !name || !(+amt > 0)}>Send invoice</button>
    </form>
  );
}

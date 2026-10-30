import { useState } from "react";
import { api, useApi, money, dayLabel, clock } from "../api.js";
import { useWorld, firstName } from "../components/Actor.jsx";
import Icon from "../components/Icon.jsx";

// Deals and bookings: where each one stands, who has paid, and the buttons a person may press themselves.
const STEPS = [["awaiting_organizer", "Deal"], ["held", "Court guaranteed"], ["locked", "Paid and locked"], ["played", "Played"], ["venue_paid", "Venue paid"]];
const ENDED = { released: "Released: nobody was charged", cancelled: "Cancelled: nobody was charged", refunded: "Cancelled: everyone refunded" };
const PAY = { invited: "invited, no answer yet", not_started: "not started", creating: "starting", awaiting_approval: "waiting for approval", authorized: "authorized", captured: "paid", voided: "voided", dropped: "didn't pay (covered)", declined: "declined", refunded: "refunded", failed: "failed", capture_failed: "failed", too_late: "too late" };

export default function Games({ entries, me, query }) {
  const [tick, setTick] = useState(0);
  const g = useApi("/api/games", entries.length + tick);
  const w = useWorld();
  const focus = query.get("booking");
  if (!g.data) return <div className="page"><p className="muted">Loading…</p></div>;
  return (
    <div className="page">
      <header className="page-head"><h1>Games</h1><p className="muted">Each deal your agent made, and how it is being paid.</p></header>
      {query.get("cancelled") && <p className="note warn">You left PayPal without approving. Your agent can send you the link again.</p>}
      {!g.data.bookings.length && <p className="empty card">No bookings yet.</p>}
      {g.data.bookings.map((b) => <Booking key={b.id} b={b} me={me.player.id} w={w} focus={b.id === focus} done={() => setTick((t) => t + 1)} />)}
      {g.data.negotiations.length > 0 && <>
        <h2 className="section">Negotiations</h2>
        {g.data.negotiations.slice().reverse().map((n) => <Negotiation key={n.id} n={n} w={w} />)}
      </>}
    </div>
  );
}

function Booking({ b, me, w, focus, done }) {
  const [busy, setBusy] = useState(null), [err, setErr] = useState(null);
  const act = async (a) => { setBusy(a); setErr(null); try { const r = await api(`/api/bookings/${b.id}/${a}`, { method: "POST" }); if (a === "pay" && r.you?.approveUrl) { location.href = r.you.approveUrl; return; } done(); } catch (e) { setErr(e.message); } setBusy(null); };
  const at = STEPS.findIndex(([s]) => s === (b.state === "locking" ? "held" : b.state));
  return (
    <section className={`card booking ${focus ? "focus" : ""}`}>
      <header>
        <div><h3>{b.venueName} · court {b.court}</h3><p className="muted">{b.sport} · {dayLabel(b.date)} {b.start} · {b.minutes} min · {money(b.total)} total</p></div>
        {ENDED[b.state] ? <span className="pill warn">{ENDED[b.state]}</span> : <span className="pill good">{STEPS[at]?.[1]}</span>}
      </header>
      {!ENDED[b.state] && <ol className="stepper">{STEPS.map(([s, label], i) => <li key={s} className={i < at ? "done" : i === at ? "now" : ""}><span />{label}</li>)}</ol>}
      {b.guaranteeBy && <p className="small"><Icon name="clock" size={14} />Held until {clock(b.guaranteeBy)} for {firstName(w, b.organizer)} to guarantee the whole court in PayPal.</p>}
      {b.payBy && <p className="small"><Icon name="clock" size={14} />Shares due by {clock(b.payBy)}. {firstName(w, b.organizer)} covers anyone who doesn't pay.</p>}
      <table className="pays"><thead><tr><th>Player</th><th>Pays</th><th>Status</th><th>How</th></tr></thead><tbody>
        {b.players.map((pid) => { const p = b.payments[pid]; return (
          <tr key={pid} className={pid === me ? "me" : ""}><td>{pid === me ? "You" : firstName(w, pid)}{pid === b.organizer && <small> organizer</small>}</td><td>{p.role === "organizer" ? <>{money(p.paid ?? p.share)}<small>{p.paid != null && +p.paid > +p.share ? " (covered others)" : ` · guarantees ${money(p.guarantee)}`}</small></> : money(p.share)}</td><td><span className={`st ${p.status}`}>{PAY[p.status] || p.status}</span></td><td><small>{p.via === "vault" ? "saved PayPal, by the agent" : p.via === "approval" ? "approved in PayPal" : ""}</small></td></tr>); })}
      </tbody></table>
      {b.receipts?.length > 0 && <p className="small"><Icon name="verify" size={14} />Receipts: {b.receipts.map((x) => <a key={x.id} href={`#/receipt/${x.id}`}>{x.event.replace("_", " ")}</a>).reduce((a, x) => [...a, a.length ? " · " : "", x], [])}</p>}
      {b.payout && <p className="small"><Icon name="send" size={14} />Venue paid {money(b.payout.amount)} with PayPal Payouts ({String(b.payout.status).toLowerCase()}), after PayPal's fees.</p>}
      {err && <p className="err">{err}</p>}
      <div className="actions">
        {b.you?.approveUrl && <a className="btn primary" href={b.you.approveUrl}>{me === b.organizer && b.state === "awaiting_organizer" ? "Guarantee the court in PayPal" : "Pay your share in PayPal"}</a>}
        {me !== b.organizer && ["awaiting_organizer", "held"].includes(b.state) && !b.payments[me]?.status?.match(/declined|captured/) && <>
          {!b.you && b.state === "held" && <button className="btn primary" disabled={!!busy} onClick={() => act("pay")}>Join and pay {money(b.invite?.share || 0)}</button>}
          <button className="btn" disabled={!!busy} onClick={() => act("decline")}>I can't play</button></>}
        {me === b.organizer && ["awaiting_organizer", "held", "locked"].includes(b.state) && <button className="btn ghost" disabled={!!busy} onClick={() => act("cancel")}>Cancel booking</button>}
        <span className="pp">PayPal {b.paypal === "mock" ? "simulated" : b.paypal}</span>
      </div>
    </section>
  );
}

function Negotiation({ n, w }) {
  const hist = n.history.filter((h) => h.amount);
  const max = Math.max(...hist.map((h) => +h.amount), +n.list);
  return (
    <section className="card nego">
      <header><div><h3>{n.venueName}</h3><p className="muted">{n.sport} · {dayLabel(n.date)} {n.start} · {n.players.map((p) => firstName(w, p)).join(", ")}</p></div><span className={`pill ${n.status === "agreed" ? "good" : n.status === "open" ? "" : "warn"}`}>{n.status}{n.agreed ? ` at ${money(n.agreed.amount)}` : ""}</span></header>
      <div className="bars">
        <div className="bar list"><span style={{ width: "100%" }} /><b>list {money(n.list)}</b></div>
        {hist.map((h, i) => <div key={i} className={`bar ${h.by === "organizer" ? "offer" : "ask"}`}><span style={{ width: `${(100 * +h.amount) / max}%` }} /><b>{h.by === "organizer" ? "your agent" : "venue"} {h.type} {money(h.amount)}</b></div>)}
      </div>
      {n.discounts?.length > 0 && <p className="small muted">Discounts: {n.discounts.map((d) => `${d.kind} (${d.why})`).join(", ")}</p>}
    </section>
  );
}

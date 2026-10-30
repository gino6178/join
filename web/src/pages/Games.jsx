import { useState } from "react";
import { api, useApi, money, dayLabel, clock } from "../api.js";
import { useWorld, firstName } from "../components/Actor.jsx";
import Icon from "../components/Icon.jsx";
import PayPalButtons from "../components/PayPalButtons.jsx";

// Deals and bookings: where each one stands, who has paid, and the buttons a person may press themselves.
const STEPS = [["awaiting_organizer", "Deal"], ["held", "Guaranteed"], ["locked", "Paid and locked"], ["played", "Played"], ["venue_paid", "Venue paid"]];
const ENDED = { released: "Released: nobody was charged", cancelled: "Cancelled: nobody was charged", refunded: "Cancelled: everyone refunded" };
const PAY = { invited: "invited, no answer yet", not_started: "not started", creating: "starting", awaiting_approval: "waiting for approval", authorized: "authorized", captured: "paid", voided: "voided", dropped: "didn't pay (covered)", declined: "declined", refunded: "refunded", failed: "failed", capture_failed: "failed", too_late: "too late" };

export default function Games({ entries, me, query, demo }) {
  const [tick, setTick] = useState(0);
  const g = useApi("/api/games", entries.length + tick);
  const w = useWorld();
  const focus = query.get("booking");
  if (!g.data) return <div className="page"><p className="muted">Loading…</p></div>;
  return (
    <div className="page">
      <header className="page-head"><h1>Plans</h1><p className="muted">Each deal your agent made, and how it is being paid.</p></header>
      {query.get("cancelled") && <p className="note warn">You left PayPal without approving. Your agent can send you the link again.</p>}
      <Balances tick={entries.length + tick} done={() => setTick((t) => t + 1)} />
      {!g.data.bookings.length && <p className="empty card">No bookings yet.</p>}
      {g.data.bookings.map((b) => <Booking key={b.id} b={b} me={me.player.id} w={w} focus={b.id === focus} demo={demo} done={() => setTick((t) => t + 1)} />)}
      {g.data.negotiations.length > 0 && <>
        <h2 className="section">Negotiations</h2>
        {g.data.negotiations.slice().reverse().map((n) => <Negotiation key={n.id} n={n} w={w} />)}
      </>}
    </div>
  );
}

function Booking({ b, me, w, focus, demo, done }) {
  const [busy, setBusy] = useState(null), [err, setErr] = useState(null);
  const act = async (a, body) => { setBusy(a); setErr(null); try { const r = await api(`/api/bookings/${b.id}/${a}`, { method: "POST", body }); if (a === "pay" && r.you?.approveUrl) { location.href = r.you.approveUrl; return; } done(); } catch (e) { setErr(e.message); } setBusy(null); };
  const at = STEPS.findIndex(([s]) => s === (b.state === "locking" ? "held" : b.state));
  return (
    <section className={`card booking ${focus ? "focus" : ""}`}>
      <header>
        <div><h3>{b.venueName} · {b.unitName}</h3><p className="muted">{b.activity} · {dayLabel(b.date)} {b.start} · {b.minutes} min · {money(b.total)} total</p></div>
        {ENDED[b.state] ? <span className="pill warn">{ENDED[b.state]}</span> : <span className="pill good">{STEPS[at]?.[1]}</span>}
      </header>
      {!ENDED[b.state] && <ol className="stepper">{STEPS.map(([s, label], i) => <li key={s} className={i < at ? "done" : i === at ? "now" : ""}><span />{label}</li>)}</ol>}
      {b.guaranteeBy && <p className="small"><Icon name="clock" size={14} />Held until {clock(b.guaranteeBy)} for {firstName(w, b.organizer)} to guarantee the whole booking in PayPal.</p>}
      {b.payBy && <p className="small"><Icon name="clock" size={14} />Shares due by {clock(b.payBy)}. {firstName(w, b.organizer)} covers anyone who doesn't pay.</p>}
      <table className="pays"><thead><tr><th>Player</th><th>Pays</th><th>Status</th><th>How</th></tr></thead><tbody>
        {b.players.map((pid) => { const p = b.payments[pid]; return (
          <tr key={pid} className={pid === me ? "me" : ""}><td><span className="avatar sm">{firstName(w, pid)[0]}</span> {pid === me ? "You" : firstName(w, pid)}{pid === b.organizer && <small> organizer</small>}</td><td>{p.role === "organizer" ? <>{money(p.paid ?? p.share)}<small>{p.paid != null && +p.paid > +p.share ? " (covered others)" : ` · guarantees ${money(p.guarantee)}`}</small></> : money(p.share)}</td><td><span className={`st ${p.status}`}>{PAY[p.status] || p.status}</span></td><td><small>{p.via === "vault" ? "saved PayPal, by the agent" : p.via === "approval" ? "approved in PayPal" : p.via === "sandbox test card" ? "PayPal sandbox test card" : ""}</small></td></tr>); })}
      </tbody></table>
      {(() => { // who the organizer paid for, said plainly (the table alone reads as if everyone paid)
        const org = b.payments[b.organizer], short = b.players.filter((pid) => pid !== b.organizer && b.payments[pid]?.status !== "captured");
        return org?.paid != null && +org.paid > +org.share && short.length ? <p className="small warn-text">{b.organizer === me ? "You" : firstName(w, b.organizer)} covered {short.map((pid) => (pid === me ? "you" : firstName(w, pid))).join(", ")}: {money(+org.paid - +org.share)} on top of {b.organizer === me ? "your" : "their"} own share. {b.organizer === me ? "You can ask anyone who joined and didn't pay to pay you back." : ""}</p> : null;
      })()}
      {(b.shareAsks || []).filter((x) => x.status === "pending").map((x) => (
        <div key={x.player} className="need ask">
          <span><b>{x.player === me ? "You asked" : `${firstName(w, x.player)} asks`} to pay {money(x.amount)} instead of {money(x.from)}</b><small>{me === b.organizer ? `You would cover ${money(x.from - x.amount)} more.` : "Waiting for the organizer's answer."}</small></span>
          {me === b.organizer && <span className="need-btns"><button className="btn ghost" disabled={!!busy} onClick={() => act("answer-share", { player: x.player, accept: false })}>Keep it</button><button className="btn primary" disabled={!!busy} onClick={() => act("answer-share", { player: x.player, accept: true })}>Agree</button></span>}
        </div>))}
      {b.invite && !(b.shareAsks || []).some((x) => x.status === "pending") && <AskLess onAsk={(amount) => act("propose-share", { amount })} share={b.invite.share} busy={!!busy} />}
      {b.review?.can && <ReviewForm b={b} done={done} />}
      {b.review?.done && <p className="small"><Icon name="check" size={14} />You rated {b.venueName} {b.review.done}★. Thank you: agents read verified reviews like yours when they pick venues.</p>}
      <Mandates id={b.id} />
      {b.receipts?.length > 0 && <p className="small"><Icon name="verify" size={14} />Receipts: {b.receipts.map((x) => <a key={x.id} href={`#/receipt/${x.id}`}>{x.event.replace("_", " ")}</a>).reduce((a, x) => [...a, a.length ? " · " : "", x], [])}</p>}
      {(b.extras || []).map((x, i) => <p key={i} className="small"><Icon name="store" size={14} />{b.venueName} billed extras ({x.items.join(", ")}): {money(x.total)}, {x.status === "paid" ? "paid" : "waiting to be paid"}{x.url && <> · <a href={x.url} target="_blank" rel="noreferrer">pay the PayPal invoice</a></>}</p>)}
      {(b.reimbursements || []).map((r) => <p key={r.player} className="small"><Icon name="send" size={14} />{r.player === me ? "You" : firstName(w, r.player)}: PayPal invoice for {money(r.amount)}, {r.status === "sent" ? "waiting to be paid" : r.status === "repaid" ? `paid; ${firstName(w, b.organizer)} was paid back with PayPal Payouts` : r.status.replace(/_/g, " ")}</p>)}
      {b.payout && <p className="small"><Icon name="send" size={14} />Venue paid {money(b.payout.amount)} with PayPal Payouts ({String(b.payout.status).toLowerCase()}), after PayPal's fees.</p>}
      {demo && me === b.organizer && b.state === "held" && <Seats b={b} w={w} done={done} />}
      {err && <p className="err">{err}</p>}
      <div className="actions">
        {b.you?.approveUrl && <PayPalButtons bookingId={b.id} orderId={b.you.orderId} approveUrl={b.you.approveUrl} label={me === b.organizer && b.state === "awaiting_organizer" ? "Guarantee the booking in PayPal" : "Pay your share in PayPal"} onDone={done} />}
        {me === b.organizer && ["locked", "played", "venue_paid"].includes(b.state) && b.players.filter((pid) => pid !== me && ["dropped", "failed", "capture_failed", "voided"].includes(b.payments[pid]?.status) && !(b.reimbursements || []).some((r) => r.player === pid)).map((pid) => (
          <button key={pid} className="btn ghost" disabled={!!busy} onClick={() => act("reimburse", { player: pid })}>Ask {firstName(w, pid)} to pay you back</button>))}
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
      <header><div><h3>{n.venueName}</h3><p className="muted">{n.activity} · {dayLabel(n.date)} {n.start} · {n.players.map((p) => firstName(w, p)).join(", ")}</p></div><span className={`pill ${n.status === "agreed" ? "good" : n.status === "open" ? "" : "warn"}`}>{n.status}{n.agreed ? ` at ${money(n.agreed.amount)}` : ""}</span></header>
      <Curve hist={hist} list={+n.list} max={max} />
      {n.discounts?.length > 0 && <p className="small muted">Discounts: {n.discounts.map((d) => `${d.kind}: ${d.why}`).join(", ")}</p>}
    </section>
  );
}

// What friends owe each other across plans (only shares someone joined and didn't pay, which the organizer covered),
// netted per friend, the fewest payments that would settle the whole group, and one PayPal invoice to settle up.
function Balances({ tick, done }) {
  const l = useApi("/api/ledger", tick), [msg, setMsg] = useState(null), [busy, setBusy] = useState(false);
  if (!l.data || (!l.data.friends.length && !l.data.settlements.length)) return null;
  const settle = async (friend) => { setBusy(true); try { const r = await api("/api/ledger/settle", { method: "POST", body: { friend } }); setMsg(`One PayPal invoice for ${money(r.amount)} covers ${r.plans} plan${r.plans > 1 ? "s" : ""}.`); done(); } catch (e) { setMsg(e.message); } setBusy(false); };
  return (
    <section className="card">
      <h3><Icon name="card" size={18} />Balances with friends <small className="muted">across your plans, netted</small></h3>
      {l.data.friends.map((f) => <div key={f.friend} className="need">
        <span><b>{+f.owesYou > 0 ? `${f.name} owes you ${money(f.owesYou)}` : `You owe ${f.name} ${money(f.youOwe)}`}</b><small>shares someone joined and didn't pay, which the organizer covered; netted over your plans together</small></span>
        {+f.owesYou > 0 && <button className="btn primary small" disabled={busy} onClick={() => settle(f.friend)}>Settle up: one invoice</button>}
      </div>)}
      {l.data.fewestPayments.length > 0 && <p className="small muted">For the whole group, {l.data.fewestPayments.length} payment{l.data.fewestPayments.length > 1 ? "s" : ""} would settle everything: {l.data.fewestPayments.map((t) => `${t.fromName} → ${t.toName} ${money(t.amount)}`).join(", ")}.</p>}
      {l.data.settlements.map((s) => <p key={s.id} className="small"><Icon name="send" size={14} />Settle-up for {money(s.amount)} ({s.plans} plans): {s.status === "sent" ? <a href={s.url} target="_blank" rel="noreferrer">invoice sent</a> : s.status}</p>)}
      {msg && <p className="small muted">{msg}</p>}
    </section>
  );
}

// The negotiation as a chart: the venue's asks step down round by round (its own concession schedule), the
// organizer's agent's offers come up to meet them. An offer under 70% of the ask is a lowball: it uses up a round and
// the venue doesn't move, which the chart marks.
function Curve({ hist, list, max }) {
  const W = 560, H = 170, L = 48, R = 12, T = 14, B = 26;
  const asks = [], offers = [];
  let round = 0, lastAsk = null;
  for (const h of hist) {
    if (h.by === "organizer") { offers.push({ round, amount: +h.amount, low: lastAsk != null && +h.amount < lastAsk * 0.7, accept: h.type === "accept" }); if (h.type !== "accept") round++; }
    else { asks.push({ round, amount: +h.amount, final: h.type === "final" }); lastAsk = +h.amount; }
  }
  const rounds = Math.max(1, Math.max(...asks.map((p) => p.round), ...offers.map((p) => p.round))), lo = Math.min(...hist.map((h) => +h.amount)) * 0.9;
  const x = (r) => L + (r / rounds) * (W - L - R), y = (v) => T + (1 - (v - lo) / (max - lo || 1)) * (H - T - B);
  const path = (pts) => pts.map((p, i) => `${i ? "L" : "M"}${x(p.round)},${y(p.amount)}`).join(" ");
  return (
    <figure className="curve">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Venue asks and offers per round">
        {[lo, (lo + max) / 2, max].map((v, i) => <g key={i}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="grid" /><text x={L - 6} y={y(v) + 4} textAnchor="end">${v.toFixed(0)}</text></g>)}
        <line x1={L} x2={W - R} y1={y(list)} y2={y(list)} className="list" /><text x={W - R} y={y(list) - 4} textAnchor="end" className="lbl">list ${list.toFixed(2)}</text>
        <path d={path(asks)} className="ask" />
        <path d={path(offers)} className="offer" />
        {asks.map((p, i) => <circle key={`a${i}`} cx={x(p.round)} cy={y(p.amount)} r={p.final ? 5.5 : 4} className={`ask ${p.final ? "final" : ""}`}><title>venue ${p.amount.toFixed(2)}{p.final ? " (best and final)" : ""}</title></circle>)}
        {offers.map((p, i) => <g key={`o${i}`}><circle cx={x(p.round)} cy={y(p.amount)} r={4} className={`offer ${p.low ? "low" : ""}`}><title>offer ${p.amount.toFixed(2)}</title></circle>{p.low && <text x={x(p.round) + 7} y={y(p.amount) + 4} className="lowtxt">lowball: venue didn't move</text>}</g>)}
        {Array.from({ length: rounds + 1 }, (_, r) => <text key={r} x={x(r)} y={H - 8} textAnchor={r === 0 ? "start" : r === rounds ? "end" : "middle"}>{r === 0 ? "ask" : `round ${r}`}</text>)}
      </svg>
      <figcaption className="small muted"><span className="key ask" /> venue's ask <span className="key offer" /> your agent's offer · the venue's floor is never shown</figcaption>
    </figure>
  );
}

// A verified review: stars, what was good and what wasn't (from a fixed list, so agents can count them), a few words.
// Only for people who were in the booking and paid; agents can't write reviews.
function ReviewForm({ b, done }) {
  const [stars, setStars] = useState(0), [liked, setLiked] = useState([]), [disliked, setDisliked] = useState([]), [text, setText] = useState(""), [err, setErr] = useState(null);
  const a = useApi("/api/reviews/aspects");
  const flip = (xs, set, k) => set(xs.includes(k) ? xs.filter((x) => x !== k) : [...xs, k]);
  const send = async () => { setErr(null); try { await api(`/api/bookings/${b.id}/review`, { method: "POST", body: { stars, liked, disliked, text } }); done(); } catch (e) { setErr(e.message); } };
  if (!a.data) return null;
  return (
    <div className="review-form">
      <b>How was {b.venueName}?</b>
      <span className="starsel">{[1, 2, 3, 4, 5].map((n) => <button key={n} className={n <= stars ? "on" : ""} onClick={() => setStars(n)} aria-label={`${n} stars`}>★</button>)}</span>
      <span className="chips">{Object.entries(a.data.liked).map(([k, label]) => <button key={k} className={`chip ${liked.includes(k) ? "on" : ""}`} onClick={() => flip(liked, setLiked, k)}>{label}</button>)}</span>
      <span className="chips">{Object.entries(a.data.complaints).map(([k, label]) => <button key={k} className={`chip bad ${disliked.includes(k) ? "on" : ""}`} onClick={() => flip(disliked, setDisliked, k)}>{label}</button>)}</span>
      <textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={400} placeholder="A few words for the next group (optional)" />
      <button className="btn primary small" disabled={!stars} onClick={send}>Post a verified review</button>
      {err && <p className="err">{err}</p>}
    </div>
  );
}

// The booking's AP2 mandates (Agent Payments Protocol): the checkout the agents agreed, each payer's payment mandate for
// it, and Join's signed receipts, decoded. Each is a JWS signed with Join's published key.
function Mandates({ id }) {
  const [m, setM] = useState(null), [open, setOpen] = useState(false);
  const load = async () => { setOpen(!open); if (!m) setM(await api(`/api/bookings/${id}/ap2`).catch(() => ({}))); };
  const short = (x) => (x?.payload ? { vct: x.payload.vct, ...Object.fromEntries(Object.entries(x.payload).filter(([k]) => !["iss", "iat", "exp", "vct", "checkout_jwt"].includes(k))) } : null);
  return (
    <div className="ap2">
      <button className="link-btn small" onClick={load}><Icon name="verify" size={14} />Signed authorizations (AP2) {open ? "▾" : "▸"}</button>
      {open && m && (m.checkoutMandate ? <div className="ap2-body">
        <p className="small muted">Signed by Join (Ed25519, the key at /.well-known/join-receipts.json) as the agent provider, in AP2's schema. The payments refer to the checkout by its hash.</p>
        <b className="small">Checkout <code>{m.checkout_hash.slice(0, 16)}…</code></b><pre>{JSON.stringify(m.checkout.payload, null, 1)}</pre>
        {m.open && <><b className="small">Open payment mandate the agent worked under</b><pre>{JSON.stringify(short(m.open.payment), null, 1)}</pre></>}
        {Object.entries(m.payments).map(([pid, x]) => <div key={pid}><b className="small">Payment mandate: {pid} · receipt {x.receipt?.payload?.result}</b><pre>{JSON.stringify(short(x.mandate), null, 1)}</pre></div>)}
      </div> : <p className="small muted">No AP2 mandates for this booking.</p>)}
    </div>
  );
}

// Demo only: the organizer plays the friends they invited, so the whole split can be seen from one window. Each step is
// the same call the friend's own agent would make, and the activity log marks it as a demo step.
const SEAT_STATUS = { authorized: "paid", awaiting_approval: "waiting for PayPal", declined: "can't come" };
function Seats({ b, w, done }) {
  const [busy, setBusy] = useState(null), [msg, setMsg] = useState(null);
  const go = async (act, player) => {
    setBusy(`${act}:${player || ""}`); setMsg(null);
    try { const r = await api(`/api/demo/bookings/${b.id}/${act}`, { method: "POST", body: { player } }); if (r?.result) setMsg(r.result); else if (r?.error) setMsg(r.message); done(); }
    catch (e) { setMsg(e.message); }
    setBusy(null);
  };
  const others = b.players.filter((p) => p !== b.organizer);
  return (
    <div className="seats">
      <p className="seats-head"><b>Demo: play your friends</b><small>Each button is what that friend's own agent would do. Logged as a demo step.</small></p>
      {others.map((pid) => { const st = b.payments[pid]?.status, open = !st || st === "invited"; return (
        <div key={pid} className="seat">
          <span className="avatar">{firstName(w, pid)[0]}</span><b>{firstName(w, pid)}</b><small>{money(b.payments[pid]?.share)} · {SEAT_STATUS[st] || (open ? "invited" : st)}</small>
          {open && <span className="seat-btns">
            <button className="btn primary small" disabled={!!busy} onClick={() => go("pay", pid)}>{b.paypal === "mock" ? "Pays (saved PayPal)" : "Pays (sandbox card)"}</button>
            {!(b.shareAsks || []).some((x) => x.player === pid) && <button className="btn small" disabled={!!busy} onClick={() => go("ask-less", pid)}>Asks $1 less</button>}
            <button className="btn ghost small" disabled={!!busy} onClick={() => go("decline", pid)}>Can't come</button>
          </span>}
        </div>); })}
      <button className="btn ghost small" disabled={!!busy} onClick={() => go("time-out")}>Time runs out now (you cover whoever hasn't paid)</button>
      {msg && <p className="small muted">{msg}</p>}
    </div>
  );
}

// An invited player can ask to pay less before joining; the organizer's agent (or the organizer) answers.
function AskLess({ share, onAsk, busy }) {
  const [v, setV] = useState("");
  return (
    <form className="ask-less" onSubmit={(e) => { e.preventDefault(); if (v !== "") onAsk(+v); }}>
      <span className="small muted">Your share is {money(share)}. Ask to pay</span>
      <span className="money-in">$<input type="number" min="0" step="0.5" max={share} value={v} onChange={(e) => setV(e.target.value)} placeholder={(+share - 1).toFixed(2)} /></span>
      <button className="btn ghost small" disabled={busy || v === ""}>Ask</button>
    </form>
  );
}

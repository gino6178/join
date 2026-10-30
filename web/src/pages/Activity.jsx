import { useMemo, useState } from "react";
import { tr, lang, setLang } from "../i18n.js";
import { api, useApi, when, money, clock } from "../api.js";
import Actor, { useWorld, firstName } from "../components/Actor.jsx";
import Icon from "../components/Icon.jsx";
import PayPalButtons from "../components/PayPalButtons.jsx";

// What the agents did, for the person they did it for: every search, offer, counter-offer, approval and payment, live,
// grouped by the deal it belongs to. Each line says who did it (your agent and which one, another player's agent, the
// venue, PayPal, Join) in words made by code from the facts. On top, what is waiting on you.
const ICON = { searched: "list", alternatives: "pin", negotiation_opened: "chat", venue_countered: "chat", deal: "check", venue_rejected: "warn", offer_refused: "warn", accept_refused: "warn", negotiation_refused: "warn",
  walked_away: "back", reimbursement_requested: "send", reimbursement_paid: "card", organizer_repaid: "check", invited: "send", joined: "check", share_asked: "chat", share_accepted: "check", share_refused: "close", place_held: "clock", approval_requested: "card", authorized: "verify", held: "lock", locked: "lock", played: "check", venue_paid: "send", payout_status: "send", released: "back", cancelled: "close", refunded: "back", declined: "close", vault_saved: "card", pay_requested: "card" };
const TONE = { deal: "good", locked: "good", venue_paid: "good", authorized: "good", venue_rejected: "bad", offer_refused: "warn", accept_refused: "warn", negotiation_refused: "warn", released: "warn", payment_failed: "bad", capture_failed: "bad" };

export default function Activity({ entries, me }) {
  const w = useWorld(), firstOf = (id) => firstName(w, id);
  const games = useApi("/api/games", entries.length);
  const waiting = (games.data?.bookings || []).filter((b) => b.you?.approveUrl || b.invite);
  const owing = (games.data?.bookings || []).filter((b) => b.owes);
  const groups = useMemo(() => {
    const by = new Map();
    for (const e of entries) { const k = e.ref || "_other"; if (!by.has(k)) by.set(k, []); by.get(k).push(e); }
    // a booking continues its negotiation: show them together
    const bookings = games.data?.bookings || [];
    for (const b of bookings) if (by.has(b.id) && by.has(b.negotiation)) { by.get(b.negotiation).push(...by.get(b.id)); by.delete(b.id); }
    return [...by.entries()].map(([k, list]) => ({ k, list: list.sort((a, b) => a.id - b.id) })).sort((a, b) => b.list.at(-1).id - a.list.at(-1).id);
  }, [entries, games.data]);
  return (
    <div className="page">
      <header className="page-head"><h1>{tr("Activity")}</h1><p className="muted">{tr("Everything the agents did for you, as it happens. Join writes each line from the facts; nothing here was written by an AI.")}</p></header>
      {waiting.length > 0 && <section className="needs">
        <h2><Icon name="bolt" size={18} />Waiting on you</h2>
        {waiting.map((b) => b.invite ? <Invite key={b.id} b={b} done={games.reload} /> : <div key={b.id} className="need">
          <span><b>{b.organizer === me.player.id ? "Guarantee the booking" : "Pay your share"}: {money(b.you.authorized)}</b><small>{b.venueName} · {b.activity} · {b.date} {b.start}{b.you.note ? ` · ${b.you.note}` : ""}</small></span>
          <PayPalButtons bookingId={b.id} orderId={b.you.orderId} approveUrl={b.you.approveUrl} onDone={games.reload} />
        </div>)}
      </section>}
      {owing.map((b) => <section key={b.id} className="needs"><div className="need"><span><b>Pay back {firstOf(b.organizer)}: {money(b.owes.amount)}</b><small>{b.venueName} · {b.activity} · {b.date} {b.start}. They covered your share; this is a PayPal invoice.</small></span><a className="btn primary" href={b.owes.url} target="_blank" rel="noreferrer">Pay the invoice</a></div></section>)}
      {!entries.length && <div className="empty card start">
        <Icon name="spark" size={28} />
        <p><b>{tr("Plan something with friends.")}</b> Tell Join's agent what you'd like to do, or bring your own agent. Every step, whoever takes it, shows up here.</p>
        <span className="row-btns"><button className="btn primary" onClick={() => dispatchEvent(new Event("join:open-agent"))}>{tr("Plan something")}</button><a className="btn ghost" href="#/connect">{tr("Use my own agent")}</a></span>
      </div>}
      {groups.map((g) => <Group key={g.k} list={g.list} me={me.player.id} booking={(games.data?.bookings || []).find((b) => b.id === g.k || b.negotiation === g.k)} />)}
    </div>
  );
}

// One plan's steps. A booking leads with a one-line summary (where, when, how much, who has paid); the steps below show
// the latest few, with the rest a click away.
const SHOWN = 3;
const STATE = { awaiting_organizer: "waiting for the guarantee", held: "friends paying", locking: "locking", locked: "paid and locked", played: "played", venue_paid: "venue paid", released: "released", cancelled: "cancelled", refunded: tr("refunded") };
function Group({ list, me, booking: b }) {
  const [all, setAll] = useState(false);
  const head = list.find((e) => e.action === "negotiation_opened") || list[0];
  const title = b ? `${b.activity[0].toUpperCase()}${b.activity.slice(1)} at ${b.venueName}` : head.action === "negotiation_opened" ? head.summary.replace(/^.*? asked /, "").replace(/\. Venue asks.*$/, "") : list[0].ref ? "A booking" : "Searches";
  const last = list.at(-1), shown = all ? list : list.slice(-SHOWN);
  const covered = b ? Object.entries(b.payments || {}).filter(([pid, p]) => pid !== b.organizer && p.status !== "captured").length : 0;
  const paid = b ? Object.values(b.payments || {}).filter((p) => p.status === "captured" || p.status === "authorized").length : 0;
  return (
    <section className="card group">
      <header><h3>{title.charAt(0).toUpperCase() + title.slice(1)}</h3><span className={`pill ${b ? (["locked", "played", "venue_paid"].includes(b.state) ? "good" : "") : TONE[last.action] || ""}`}>{b ? STATE[b.state] || b.state : last.action.replace(/_/g, " ")}</span></header>
      {b && <p className="summary">{b.date} {b.start} · {b.players.length} people · <b>{money(b.total)}</b> · {["locked", "played", "venue_paid"].includes(b.state) ? (covered ? `${covered} covered by the organizer` : tr("everyone paid")) : `${paid} of ${b.players.length} in, held in PayPal`} · <a href={`#/games?booking=${b.id}`}>{tr("Open the plan")}</a></p>}
      {list.length > SHOWN && !all && <button className="link-btn small" onClick={() => setAll(true)}>{lang === "zh" ? `顯示全部 ${list.length} 步` : `Show all ${list.length} steps`}</button>}
      <ol className="timeline">{shown.map((e) => (
        <li key={e.id} className={TONE[e.action] || ""}>
          <span className="dot"><Icon name={ICON[e.action] || "info"} size={14} /></span>
          <div>
            <p className="meta"><Actor actor={e.actor} me={me} /><time>{when(e.at)}</time></p>
            <p>{e.summary}</p>
            {e.data?.offer && <p className="ladder"><span className="you">offer {money(e.data.offer)}</span><Icon name="next" size={14} /><span className="them">venue {money(e.data.ask)}</span></p>}
            {e.data?.alternatives?.length > 0 && <div className="alts">
              <p className="small muted"><Icon name="pin" size={14} />{e.data.overBudget ? "Over budget, so Join offered these nearby:" : "Other places nearby:"}</p>
              <ul>{e.data.alternatives.slice(0, 4).map((a) => <li key={a.venue}><b>{a.name}</b> {a.start}<small>{a.why}</small></li>)}</ul>
              <a className="small" href="#/map">See them on the map</a>
            </div>}
          </div>
        </li>))}
      </ol>
    </section>
  );
}

// An invitation: say yes (which starts your share's payment) or no. Nothing is charged for anyone who hasn't said yes.
export function Invite({ b, done }) {
  const [busy, setBusy] = useState(false), [err, setErr] = useState(null);
  const act = async (a) => {
    setBusy(true); setErr(null);
    try { const r = await api(`/api/bookings/${b.id}/${a}`, { method: "POST" }); if (r.you?.approveUrl) location.href = r.you.approveUrl; else done(); } catch (e) { setErr(e.message); setBusy(false); }
  };
  return (
    <div className="need">
      <span><b>You're invited: {b.activity}, {b.date} {b.start}</b><small>{b.venueName} · {b.unitName} · your share {money(b.invite.share)} · answer by {clock(b.invite.payBy)}</small>{err && <small className="err">{err}</small>}</span>
      <span className="need-btns"><button className="btn ghost" disabled={busy} onClick={() => act("decline")}>Can't make it</button><button className="btn primary" disabled={busy} onClick={() => act("pay")}>Join and pay</button></span>
    </div>
  );
}

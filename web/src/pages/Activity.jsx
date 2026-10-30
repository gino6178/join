import { useMemo, useState } from "react";
import { api, useApi, when, money, clock } from "../api.js";
import Actor from "../components/Actor.jsx";
import Icon from "../components/Icon.jsx";

// What the agents did, for the person they did it for: every search, offer, counter-offer, approval and payment, live,
// grouped by the deal it belongs to. Each line says who did it (your agent and which one, another player's agent, the
// venue, PayPal, Join) in words made by code from the facts. On top, what is waiting on you.
const ICON = { searched: "list", alternatives: "pin", negotiation_opened: "chat", venue_countered: "chat", deal: "check", venue_rejected: "warn", offer_refused: "warn", accept_refused: "warn", negotiation_refused: "warn",
  walked_away: "back", invited: "send", joined: "check", share_asked: "chat", share_accepted: "check", share_refused: "close", court_held: "clock", approval_requested: "card", authorized: "verify", held: "lock", locked: "lock", played: "check", venue_paid: "send", payout_status: "send", released: "back", cancelled: "close", refunded: "back", declined: "close", vault_saved: "card", pay_requested: "card" };
const TONE = { deal: "good", locked: "good", venue_paid: "good", authorized: "good", venue_rejected: "bad", offer_refused: "warn", accept_refused: "warn", negotiation_refused: "warn", released: "warn", payment_failed: "bad", capture_failed: "bad" };

export default function Activity({ entries, me }) {
  const games = useApi("/api/games", entries.length);
  const waiting = (games.data?.bookings || []).filter((b) => b.you?.approveUrl || b.invite);
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
      <header className="page-head"><h1>Activity</h1><p className="muted">Everything the agents did for you, as it happens. Join writes each line from the facts; nothing here was written by an AI.</p></header>
      {waiting.length > 0 && <section className="needs">
        <h2><Icon name="bolt" size={18} />Waiting on you</h2>
        {waiting.map((b) => b.invite ? <Invite key={b.id} b={b} done={games.reload} /> : <div key={b.id} className="need">
          <span><b>{b.organizer === me.player.id ? "Guarantee the court" : "Pay your share"}: {money(b.you.amount)}</b><small>{b.venueName} · {b.sport} · {b.date} {b.start}{b.you.note ? ` · ${b.you.note}` : ""}</small></span>
          <a className="btn primary" href={b.you.approveUrl}>Approve in PayPal</a>
        </div>)}
      </section>}
      {!entries.length && <div className="empty card"><Icon name="key" size={28} /><p><b>No activity yet.</b> Connect an agent and ask it to set up a game; every step it takes shows up here.</p><a className="btn" href="#/connect">Connect your agent</a></div>}
      {groups.map((g) => <Group key={g.k} list={g.list} me={me.player.id} />)}
    </div>
  );
}

function Group({ list, me }) {
  const head = list.find((e) => e.action === "negotiation_opened") || list[0];
  const title = head.action === "negotiation_opened" ? head.summary.replace(/^.*? asked /, "").replace(/\. Venue asks.*$/, "") : list[0].ref ? "A booking" : "Searches";
  const last = list.at(-1);
  return (
    <section className="card group">
      <header><h3>{title.charAt(0).toUpperCase() + title.slice(1)}</h3><span className={`pill ${TONE[last.action] || ""}`}>{last.action.replace(/_/g, " ")}</span></header>
      <ol className="timeline">{list.map((e) => (
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
      <span><b>You're invited: {b.sport}, {b.date} {b.start}</b><small>{b.venueName} · court {b.court} · your share {money(b.invite.share)} · answer by {clock(b.invite.payBy)}</small>{err && <small className="err">{err}</small>}</span>
      <span className="need-btns"><button className="btn ghost" disabled={busy} onClick={() => act("decline")}>Can't make it</button><button className="btn primary" disabled={busy} onClick={() => act("pay")}>Join and pay</button></span>
    </div>
  );
}

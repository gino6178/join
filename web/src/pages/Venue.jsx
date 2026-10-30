import { useState } from "react";
import { useApi, money } from "../api.js";
import { useWorld } from "../components/Actor.jsx";

// A venue's side: its courts over a day, with the games Join booked. A court held while a group pays is dashed; once
// everyone has paid it is solid; a court that went back is gone. Public, read-only.
const START = 7 * 60, END = 23 * 60, pct = (m) => `${(100 * (m - START)) / (END - START)}%`;
const toMin = (s) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
const LIVE = { awaiting_organizer: "held", held: "held", locking: "held", locked: "locked", played: "played", venue_paid: "played" };

export default function Venue({ query }) {
  const w = useWorld();
  const [id, setId] = useState(query.get("id") || "westgate");
  const s = useApi(`/api/venues/${id}/schedule`);
  const v = w?.venues.find((x) => x.id === id);
  const live = (s.data?.bookings || []).filter((b) => LIVE[b.state]);
  const dates = [...new Set(live.map((b) => b.date))].sort();
  const [date, setDate] = useState(null);
  const day = date || dates[0];
  const courts = v ? Math.max(...Object.values(v.sports).map((x) => x.courts)) : 0;
  return (
    <div className="page wide">
      <header className="page-head"><h1>Venue view</h1><p className="muted">What a venue sees: its courts, with the games Join's agents booked. Dashed: held while the group pays. Solid: paid and locked.</p></header>
      <div className="seg">{w?.venues.map((x) => <button key={x.id} className={x.id === id ? "on" : ""} onClick={() => { setId(x.id); setDate(null); }}>{x.name}</button>)}</div>
      {dates.length > 0 && <div className="seg small">{dates.map((d) => <button key={d} className={d === day ? "on" : ""} onClick={() => setDate(d)}>{d}</button>)}</div>}
      <section className="card sched">
        <div className="hours">{Array.from({ length: (END - START) / 60 + 1 }, (_, i) => <span key={i} style={{ left: pct(START + i * 60) }}>{String(7 + i).padStart(2, "0")}</span>)}</div>
        {Array.from({ length: courts }, (_, k) => (
          <div key={k} className="lane"><b>Court {k + 1}</b><div className="track">
            {live.filter((b) => b.court === k + 1 && b.date === day).map((b) => <span key={b.id} className={`slot ${LIVE[b.state]}`} style={{ left: pct(toMin(b.start)), width: `calc(${pct(toMin(b.start) + b.minutes)} - ${pct(toMin(b.start))})` }} title={`${b.sport} ${b.start}, ${b.players} players, ${money(b.total)}, ${b.state}`}>{b.sport} · {money(b.total)}</span>)}
          </div></div>))}
        {!live.length && <p className="muted small">No games booked through Join at this venue yet.</p>}
      </section>
      {s.data?.bookings?.length > 0 && <section className="card"><h3>Bookings and payouts</h3><table className="pays"><thead><tr><th>Date</th><th>Time</th><th>Court</th><th>Total</th><th>State</th><th>Paid out</th></tr></thead><tbody>
        {s.data.bookings.map((b) => <tr key={b.id}><td>{b.date}</td><td>{b.start}</td><td>{b.court}</td><td>{money(b.total)}</td><td>{b.state.replace(/_/g, " ")}</td><td>{b.payout ? money(b.payout) : ""}</td></tr>)}
      </tbody></table></section>}
    </div>
  );
}

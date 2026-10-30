import { useEffect, useState } from "react";
import { api, useApi, money } from "../api.js";
import { useWorld } from "../components/Actor.jsx";

// A venue's side: its courts over a day, with the games Join booked. A court held while a group pays is dashed; once
// everyone has paid it is solid; a court that went back is gone. The schedule is public; the venue's rules are for its
// staff (Policy, below).
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
      <Policy id={id} name={v?.name} />
      {s.data?.bookings?.length > 0 && <section className="card"><h3>Bookings and payouts</h3><table className="pays"><thead><tr><th>Date</th><th>Time</th><th>Court</th><th>Total</th><th>State</th><th>Paid out</th></tr></thead><tbody>
        {s.data.bookings.map((b) => <tr key={b.id}><td>{b.date}</td><td>{b.start}</td><td>{b.court}</td><td>{money(b.total)}</td><td>{b.state.replace(/_/g, " ")}</td><td>{b.payout ? money(b.payout) : ""}</td></tr>)}
      </tbody></table></section>}
    </div>
  );
}

// The venue's own rules for agents: Join negotiates by them for the venue. Only the venue's staff see or change them
// (the floor never reaches an agent). The demo signs in by picking the venue.
const pctIn = (x) => Math.round(x * 100);
function Policy({ id, name }) {
  const [me, setMe] = useState(undefined), [p, setP] = useState(null), [msg, setMsg] = useState(null), [err, setErr] = useState(null);
  const load = () => api("/api/venue-me").then((r) => { setMe(r.venue); if (r.venue === id) api(`/api/venues/${id}/policy`).then((x) => setP(x.policy)); else setP(null); });
  useEffect(() => { setMsg(null); load(); }, [id]);
  const signIn = async () => { await api("/api/venue-session", { method: "POST", body: { venue: id } }); load(); };
  const save = async (e) => { e.preventDefault(); setErr(null); try { const r = await api(`/api/venues/${id}/policy`, { method: "PUT", body: p }); setP(r.policy); setMsg("Saved. The next negotiation uses these rules."); } catch (x) { setErr(x.body?.fields ? `Check: ${x.body.fields.join(", ")}` : x.message); } };
  const set = (k, v) => setP({ ...p, [k]: v }), setIn = (k, f, v) => setP({ ...p, [k]: { ...p[k], [f]: v } });
  if (me === undefined) return null;
  if (me !== id) return <section className="card venue-head"><span><b>Your rules for agents</b><br /><small className="muted">Staff of {name} set how Join negotiates for them.</small></span><button className="btn" onClick={signIn}>Sign in as {name} (demo)</button></section>;
  if (!p) return null;
  return (
    <form className="card form" onSubmit={save}>
      <h3>How Join negotiates for {name}</h3>
      <p className="small muted">Agents never see your floor. They see your list price, your discounts, and your counter-offers on the schedule you pick.</p>
      {msg && <p className="note good">{msg}</p>}{err && <p className="err">{err}</p>}
      <div className="policy">
        <label><span>Style</span><select value={p.style} onChange={(e) => set("style", e.target.value)}><option value="firm">Firm: never comes down</option><option value="standard">Standard: halfway to the floor</option><option value="eager">Eager: all the way to the floor</option></select></label>
        <label><span>Floor <small>(% of list price, never shown)</small></span><input type="number" min="50" max="100" value={pctIn(p.floorPct)} onChange={(e) => set("floorPct", +e.target.value / 100)} /></label>
        <label><span>Counter-offers <small>(1 to 5; the last is best and final)</small></span><input type="number" min="1" max="5" value={p.rounds} onChange={(e) => set("rounds", +e.target.value)} /></label>
        <label><span>Off-peak discount <small>(%)</small></span><input type="number" min="0" max="50" value={pctIn(p.offPeak.pct)} onChange={(e) => setIn("offPeak", "pct", +e.target.value / 100)} /></label>
        <label><span>Off-peak: games ending by</span><input type="time" value={p.offPeak.before} onChange={(e) => setIn("offPeak", "before", e.target.value)} /></label>
        <label><span>Group discount <small>(%)</small></span><input type="number" min="0" max="50" value={pctIn(p.group.pct)} onChange={(e) => setIn("group", "pct", +e.target.value / 100)} /></label>
        <label><span>Group: from how many players</span><input type="number" min="2" max="12" value={p.group.min} onChange={(e) => setIn("group", "min", +e.target.value)} /></label>
        <label><span>Last-minute discount <small>(%)</small></span><input type="number" min="0" max="50" value={pctIn(p.lastMinute.pct)} onChange={(e) => setIn("lastMinute", "pct", +e.target.value / 100)} /></label>
        <label><span>Last-minute: within hours</span><input type="number" min="1" max="48" value={p.lastMinute.withinHours} onChange={(e) => setIn("lastMinute", "withinHours", +e.target.value)} /></label>
      </div>
      <button className="btn primary">Save rules</button>
    </form>
  );
}

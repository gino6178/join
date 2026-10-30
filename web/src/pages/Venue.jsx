import { lazy, Suspense, useEffect, useState } from "react";
import { tr, lang, setLang } from "../i18n.js";
import { api, useApi, money } from "../api.js";
import { useWorld } from "../components/Actor.jsx";
import VenueMoney from "../components/VenueMoney.jsx";

// A venue's side: its courts, rooms or tables over a day, with the bookings Join made. Held while a group pays is
// dashed; once everyone has paid it is solid; a booking that went back is gone. The schedule is public; the venue's rules are for its
// staff (Policy, below).
const LIVE = { awaiting_organizer: "held", held: "held", locking: "held", locked: "locked", played: "played", venue_paid: "played" };
// Bryntum Scheduler is large, so it loads only on this page
const PlaceScheduler = lazy(() => import("../components/PlaceScheduler.jsx"));

export default function Venue({ query }) {
  const w = useWorld();
  const [id, setId] = useState(query.get("id") || "westgate");
  const [tick, setTick] = useState(0);
  // the schedule follows payments as they happen
  useEffect(() => { const t = setInterval(() => setTick((x) => x + 1), 3000); return () => clearInterval(t); }, []);
  const s = useApi(`/api/venues/${id}/schedule`, tick);
  const v = w?.venues.find((x) => x.id === id);
  const live = (s.data?.bookings || []).filter((b) => LIVE[b.state]);
  const dates = [...new Set(live.map((b) => b.date))].sort();
  const [date, setDate] = useState(null);
  const day = date || dates[0];
  const units = v ? Object.entries(v.offers).map(([a, o]) => ({ activity: a, unit: w.activities.find((x) => x.id === a)?.unit || "unit", count: o.units })) : [];
  return (
    <div className="page wide">
      <header className="page-head"><h1>{tr("Venue view")}</h1><p className="muted">{tr("What a venue sees: its courts, rooms or tables, with the bookings Join's agents made. Dashed: held while the group pays. Solid: paid and locked.")}</p></header>
      <div className="seg">{w?.venues.map((x) => <button key={x.id} className={x.id === id ? "on" : ""} onClick={() => { setId(x.id); setDate(null); }}>{x.name}</button>)}</div>
      {dates.length > 0 && <div className="seg small">{dates.map((d) => <button key={d} className={d === day ? "on" : ""} onClick={() => setDate(d)}>{d}</button>)}</div>}
      <section className="card sched">
        {day ? <Suspense fallback={<p className="muted small">Loading the schedule…</p>}><PlaceScheduler key={`${id}:${day}`} units={units} bookings={live} date={day} kind={LIVE} /></Suspense>
          : <p className="muted small">Nothing booked through Join at this venue yet.</p>}
        <p className="small muted legend-row"><span className="lg-bar held" />held while the group pays <span className="lg-bar locked" />paid and locked <span className="lg-bar played" />played</p>
      </section>
      <Policy id={id} name={v?.name} bookings={s.data?.bookings || []} />
      {s.data?.bookings?.length > 0 && <section className="card"><h3>Bookings and payouts</h3><table className="pays"><thead><tr><th>Date</th><th>Time</th><th>Place</th><th>Total</th><th>State</th><th>Paid out</th></tr></thead><tbody>
        {s.data.bookings.map((b) => <tr key={b.id}><td>{b.date}</td><td>{b.start}</td><td>{b.unitName}</td><td>{money(b.total)}</td><td>{b.state.replace(/_/g, " ")}</td><td>{b.payout ? money(b.payout) : ""}</td></tr>)}
      </tbody></table></section>}
    </div>
  );
}

// The venue's own rules for agents: Join negotiates by them for the venue. Only the venue's staff see or change them
// (the floor never reaches an agent). The demo signs in by picking the venue.
const pctIn = (x) => Math.round(x * 100);
function Policy({ id, name, bookings = [] }) {
  const [me, setMe] = useState(undefined), [p, setP] = useState(null), [msg, setMsg] = useState(null), [err, setErr] = useState(null);
  const load = () => api("/api/venue-me").then((r) => { setMe(r.venue); if (r.venue === id) api(`/api/venues/${id}/policy`).then((x) => setP(x.policy)); else setP(null); });
  useEffect(() => { setMsg(null); load(); }, [id]);
  const signIn = async () => { await api("/api/venue-session", { method: "POST", body: { venue: id } }); load(); };
  const save = async (e) => { e.preventDefault(); setErr(null); try { const r = await api(`/api/venues/${id}/policy`, { method: "PUT", body: p }); setP(r.policy); setMsg("Saved. The next negotiation uses these rules."); } catch (x) { setErr(x.body?.fields ? `Check: ${x.body.fields.join(", ")}` : x.message); } };
  const set = (k, v) => setP({ ...p, [k]: v }), setIn = (k, f, v) => setP({ ...p, [k]: { ...p[k], [f]: v } });
  if (me === undefined) return null;
  if (me !== id) return <section className="card venue-head"><span><b>Your rules for agents</b><br /><small className="muted">Staff of {name} set how Join negotiates for them.</small></span><button className="btn" onClick={signIn}>Sign in as {name} (demo)</button></section>;
  if (!p) return null;
  return (<>
    <VenueMoney id={id} bookings={bookings} />
    <VenueReviews id={id} />
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
  </>);
}

// What verified customers say: the venue sees the same reviews and score agents use, and can't remove any
function VenueReviews({ id }) {
  const r = useApi(`/api/venues/${id}/reviews`);
  if (!r.data) return null;
  const s = r.data;
  return (
    <section className="card">
      <h3>Reviews <small className="muted">verified: only people who booked and paid on Join{s.demoData ? "; this demo town's reviews are demo data" : ""}</small></h3>
      <p><b>★{s.score.toFixed(1)}</b> from {s.count} reviews ({s.recent} in the last 90 days). Agents rank venues with this score and repeat what's counted below.</p>
      {s.praise.length > 0 && <p className="small good-text">Liked: {s.praise.map((p) => `${p.label} (${p.count})`).join(", ")}</p>}
      {s.complaints.length > 0 && <p className="small warn-text">Complaints: {s.complaints.map((p) => `${p.label} (${p.count})`).join(", ")}</p>}
      <ul className="reviews-list">{s.latest.map((x, i) => <li key={i}><b>{"★".repeat(x.stars)}</b> <small className="muted">{x.at} · {x.activity} · {x.verified}</small><br />{x.text || <span className="muted">(no text)</span>}</li>)}</ul>
      <p className="small muted">Reviews can't be removed or hidden by the venue.</p>
    </section>
  );
}

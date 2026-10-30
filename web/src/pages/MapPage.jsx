import { useMemo } from "react";
import { useApi, money } from "../api.js";
import RealMap from "../components/RealMap.jsx";
import { useWorld } from "../components/Actor.jsx";
import Icon from "../components/Icon.jsx";

// The map, following the latest thing that happened: a price over budget marks that venue red and numbers the
// alternatives Join offered instead; a booking shows the place and everyone's trip to it.
export default function MapPage({ entries, me }) {
  const w = useWorld(), games = useApi("/api/games", entries.length);
  const last = useMemo(() => [...entries].reverse().find((e) => e.data?.alternatives?.length), [entries]);
  const booking = (games.data?.bookings || []).find((b) => !["released", "cancelled", "refunded"].includes(b.state));
  const overVenue = last?.ref && (games.data?.negotiations || []).find((n) => n.id === last.ref)?.venue;
  const fresh = last && (!booking || last.id > Math.max(0, ...entries.filter((e) => e.ref === booking.id).map((e) => e.id)));
  const alts = fresh ? last.data.alternatives : [];
  return (
    <div className="page wide">
      <header className="page-head"><h1>Map</h1><p className="muted">{w ? `${w.town.name}. ` : ""}Venues are round pins (click one for what it offers, or to plan there); squares are free public places such as park courts and picnic grills (first come, not bookable); blue circles are people's home areas, never addresses.</p></header>
      <div className="map-layout">
        <div className="card map-card"><RealMap world={w} me={me.player.id} over={fresh ? overVenue : null} alternatives={alts} booked={!fresh ? booking?.venue : null} people={!fresh ? booking?.players || [] : [me.player.id]} /></div>
        <aside className="map-side">
          {fresh ? <section className="card">
            <h3><Icon name="pin" size={18} />Alternatives</h3>
            <p className="small muted">{last.summary}</p>
            <ol className="alt-list">{alts.map((a, i) => <li key={a.venue}><span className="n">{i + 1}</span><span><b>{a.name}</b> {a.start} · {a.bookable ? `${money(a.price)} total` : "free"}<small>{a.why}</small></span></li>)}</ol>
          </section> : booking ? <section className="card">
            <h3><Icon name="lock" size={18} />{booking.venueName}</h3>
            <p className="small">{booking.unitName} · {booking.date} {booking.start} · {booking.state.replace(/_/g, " ")}</p>
            <p className="small muted">The fairest venue: the one where the longest trip in the group is shortest.</p>
          </section> : <section className="card"><p className="muted small">When your agent's deal is over your budget, the alternatives Join offered appear here.</p></section>}
          <section className="card legend">
            <p><span className="lg venue" />Venue</p><p><span className="lg over" />Over your budget</p><p><span className="lg alt" />Alternative</p><p><span className="lg pub" />Public place</p><p><span className="lg me" />You</p>
          </section>
        </aside>
      </div>
    </div>
  );
}

import { useWidth } from "../hooks.js";

// The club map, drawn here: no map tiles from anywhere, so it works offline and nobody's area leaves the app.
// It follows the agent's steps: the town and the venues, then everyone's home area (an area, never an address), the
// venues with a court free, and finally the venue in the middle with each person's trip to it.
const S = 100; // px of viewBox per km
const initials = (n) => n.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
const first = (n) => n.split(" ")[0];
const smooth = (pts) => pts.map(([x, y], i) => {
  if (!i) return `M${x * S} ${y * S}`;
  const [px, py] = pts[i - 1];
  return `Q${px * S} ${py * S} ${((px + x) / 2) * S} ${((py + y) / 2) * S}`;
}).join(" ") + ` L${pts.at(-1)[0] * S} ${pts.at(-1)[1] * S}`;
// a gentle curve from a home to the venue; each person's minutes sit under their own pin
function trip(a, b) {
  const [x1, y1, x2, y2] = [a.x * S, a.y * S, b.x * S, b.y * S], dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
  const cx = (x1 + x2) / 2 - (dy / len) * len * 0.12, cy = (y1 + y2) / 2 + (dx / len) * len * 0.12;
  return { d: `M${x1} ${y1} Q${cx} ${cy} ${x2} ${y2}` };
}

export default function PlayMap({ geo, steps = [], option = null }) {
  const [ref, w] = useWidth(600);
  if (!geo) return <div className="pmap-wrap" ref={ref} />;
  const k = 1000 / Math.max(280, w); // viewBox units per CSS px, so labels keep their size on a phone
  const map = steps.find((s) => s.tool === "open_map")?.map;
  const free = steps.find((s) => s.tool === "search_courts")?.free;
  const pick = steps.find((s) => s.tool === "travel")?.pick;
  const travel = option?.travel || pick?.travel || [];
  const pickId = option?.venue.id || pick?.venue;
  const g = geo.map, venues = geo.venues;
  const spot = (id) => (id === "you" ? map?.you : map?.people.find((p) => p.id === id));
  const going = travel.map((t) => ({ ...t, at: spot(t.id) })).filter((t) => t.at);
  const pv = venues.find((v) => v.id === pickId);
  const state = (v) => (pick || option ? (v.id === pickId ? "pick" : "rest") : free ? (free[v.id] ? "open" : "full") : map ? "idle" : "idle");
  const label = pv && going.length ? `Map: ${pv.name}, ${going.map((t) => `${t.id === "you" ? "you" : first(t.name)} ${t.min} minutes`).join(", ")}` : `Map of ${venues.length} venues in the club's town`;
  return (
    <div className="pmap-wrap" ref={ref}>
      <svg className="pmap" viewBox={`0 0 ${g.w * S} ${g.h * S}`} role="img" aria-label={label} style={{ "--k": k }}>
        <rect width={g.w * S} height={g.h * S} className="pm-land" />
        {g.parks.map((p, i) => <rect key={i} x={p.x * S} y={p.y * S} width={p.w * S} height={p.h * S} rx={22} className="pm-park" />)}
        <ellipse cx={g.lake.x * S} cy={g.lake.y * S} rx={g.lake.rx * S} ry={g.lake.ry * S} className="pm-water" />
        <path d={smooth(g.river)} className="pm-river" />
        {g.roads.map(([[x1, y1], [x2, y2]], i) => <line key={i} x1={x1 * S} y1={y1 * S} x2={x2 * S} y2={y2 * S} className="pm-road" />)}
        {w >= 520 && g.districts.map((d) => <text key={d.name} x={d.x * S} y={d.y * S} className="pm-district" style={{ fontSize: 12 * k }}>{d.name.toUpperCase()}</text>)}

        {map && map.people.map((p, i) => !going.some((t) => t.id === p.id) && (
          <circle key={p.id} cx={p.x * S} cy={p.y * S} r={5.5 * k} className="pm-member" style={{ animationDelay: `${i * 40}ms` }} />
        ))}

        {pv && going.map((t, i) => { const r = trip(t.at, pv); return (
          <g key={t.id} className="pm-trip" style={{ animationDelay: `${150 + i * 160}ms` }}>
            <path d={r.d} pathLength="1" className={`pm-route ${t.id === "you" ? "you" : ""}`} style={{ strokeWidth: 3.2 * k, animationDelay: `${150 + i * 160}ms` }} />
            <g transform={`translate(${t.at.x * S} ${t.at.y * S + (t.at.y > g.h - 0.8 ? -34 : 34) * k})`} className="pm-min" style={{ animationDelay: `${600 + i * 160}ms` }}>
              <rect x={-26 * k} y={-12 * k} width={52 * k} height={24 * k} rx={12 * k} />
              <text y={4.5 * k} style={{ fontSize: 12.5 * k }}>{t.min} min</text>
            </g>
          </g>
        ); })}

        {venues.map((v, i) => { const st = state(v); return (
          <g key={v.id} className={`pm-venue ${st}`} transform={`translate(${v.x * S} ${v.y * S})`} style={{ animationDelay: `${i * 70}ms` }}>
            {st === "pick" && <circle r={30 * k} className="pm-pulse" />}
            <circle r={(st === "pick" ? 15 : 11) * k} className="pm-pin" />
            <path d={`M${-5 * k} ${-4 * k}h${10 * k}v${8 * k}h${-10 * k}zM0 ${-4 * k}v${8 * k}`} className="pm-court" style={{ strokeWidth: 1.6 * k }} />
            <text y={(st === "pick" ? -24 : -18) * k} className="pm-vname" style={{ fontSize: (st === "pick" ? 14 : 12) * k }}>{v.name.replace(/ (Sports Centre|District Gym|School Hall|Community Gym|Badminton Hall)$/, "")}</text>
            {st === "open" && free && <text y={26 * k} className="pm-vfree" style={{ fontSize: 11.5 * k }}>{free[v.id]} times free</text>}
            {st === "pick" && option && <text y={32 * k} className="pm-vfree pick" style={{ fontSize: 12.5 * k }}>court {option.court} · {option.start}</text>}
          </g>
        ); })}

        {map?.you && !going.some((t) => t.id === "you") && (
          <g className="pm-person you" transform={`translate(${map.you.x * S} ${map.you.y * S})`}><circle r={13 * k} /><text y={4.5 * k} style={{ fontSize: 11 * k }}>You</text></g>
        )}
        {going.map((t, i) => (
          <g key={t.id} className={`pm-person ${t.id === "you" ? "you" : ""}`} transform={`translate(${t.at.x * S} ${t.at.y * S})`} style={{ animationDelay: `${i * 120}ms` }}>
            <circle r={15 * k} /><text y={4.5 * k} style={{ fontSize: 11.5 * k }}>{t.id === "you" ? "You" : initials(t.name)}</text>
          </g>
        ))}
      </svg>
      {!map && <p className="pmap-hint tiny">The agent opens the map when it starts looking.</p>}
    </div>
  );
}

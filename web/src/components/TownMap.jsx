// The town, drawn here (no map tiles from anywhere, so it works offline and nobody's area leaves the page), after
// Serve's club map: venues, free public courts, players' home areas (an area, never an address). It can mark one
// venue as over budget (red) and number the alternatives Join offered instead, with each player's trip to the first.
const S = 100;
const smooth = (pts) => pts.map(([x, y], i) => { if (!i) return `M${x * S} ${y * S}`; const [px, py] = pts[i - 1]; return `Q${px * S} ${py * S} ${((px + x) / 2) * S} ${((py + y) / 2) * S}`; }).join(" ") + ` L${pts.at(-1)[0] * S} ${pts.at(-1)[1] * S}`;
const short = (n) => n.replace(/ (Sports Center|Park Gym|School Gym|Community Gym|Badminton Club)$/, "");
function curve(a, b) {
  const [x1, y1, x2, y2] = [a.x * S, a.y * S, b.x * S, b.y * S], dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
  return `M${x1} ${y1} Q${(x1 + x2) / 2 - (dy / len) * len * 0.12} ${(y1 + y2) / 2 + (dx / len) * len * 0.12} ${x2} ${y2}`;
}

export default function TownMap({ world, me, over = null, alternatives = [], people = [], booked = null }) {
  if (!world) return <div className="tmap" />;
  const g = world.town.map, w = world.town.w, h = world.town.h;
  const altIndex = Object.fromEntries(alternatives.map((a, i) => [a.venue, i + 1]));
  const target = booked || alternatives[0]?.venue;
  const spot = (id) => world.venues.find((v) => v.id === id) || world.publicCourts.find((p) => p.id === id);
  const t = target && spot(target);
  const going = people.map((id) => world.players.find((p) => p.id === id)).filter((p) => p?.area);
  return (
    <svg className="tmap" viewBox={`0 0 ${w * S} ${h * S}`} role="img" aria-label="Map of the town's venues">
      <rect width={w * S} height={h * S} className="tm-land" rx="24" />
      {g.parks.map((p, i) => <rect key={i} x={p.x * S} y={p.y * S} width={p.w * S} height={p.h * S} rx={22} className="tm-park" />)}
      <ellipse cx={g.lake.x * S} cy={g.lake.y * S} rx={g.lake.rx * S} ry={g.lake.ry * S} className="tm-water" />
      <path d={smooth(g.river)} className="tm-river" />
      {g.roads.map(([[x1, y1], [x2, y2]], i) => <line key={i} x1={x1 * S} y1={y1 * S} x2={x2 * S} y2={y2 * S} className="tm-road" />)}
      {g.districts.map((d) => <text key={d.name} x={d.x * S} y={d.y * S} className="tm-district">{d.name.toUpperCase()}</text>)}
      {t && going.map((p) => <path key={p.id} d={curve(p.area, t)} className={`tm-trip ${p.id === me ? "me" : ""}`} />)}
      {world.players.filter((p) => p.area).map((p) => <circle key={p.id} cx={p.area.x * S} cy={p.area.y * S} r={going.some((x) => x.id === p.id) ? 13 : 6} className={`tm-person ${p.id === me ? "me" : ""} ${going.some((x) => x.id === p.id) ? "going" : ""}`}><title>{p.name} ({p.area.name})</title></circle>)}
      {world.publicCourts.map((p) => <g key={p.id} transform={`translate(${p.x * S} ${p.y * S})`} className={`tm-public ${altIndex[p.id] ? "alt" : ""}`}>
        <rect x={-8} y={-8} width={16} height={16} rx={4} /><text y={-14}>{altIndex[p.id] ? `${altIndex[p.id]}. ` : ""}{p.name.replace(/ (courts|blacktop)$/, "")}</text><title>{p.name}: free, first come, not bookable</title></g>)}
      {world.venues.map((v) => { const st = v.id === over ? "over" : v.id === booked ? "booked" : altIndex[v.id] ? "alt" : ""; return (
        <g key={v.id} transform={`translate(${v.x * S} ${v.y * S})`} className={`tm-venue ${st}`}>
          {(st === "alt" && altIndex[v.id] === 1) || st === "booked" ? <circle r={32} className="tm-pulse" /> : null}
          <circle r={st ? 16 : 12} className="tm-pin" />
          <text y={5} className="tm-num">{altIndex[v.id] || ""}</text>
          <text y={st ? -24 : -18} className="tm-name">{short(v.name)}</text>
          {st === "over" && <text y={32} className="tm-tag">over budget</text>}
        </g>); })}
    </svg>
  );
}

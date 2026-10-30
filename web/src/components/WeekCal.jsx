// Everyone's week side by side: one row per day, a lane per person for the times they are free, the band where
// everyone is free, and the slot the agent picked.
const FROM = 7 * 60, TO = 23 * 60, span = TO - FROM;
const LANE = ["var(--ink)", "var(--near)", "var(--far)", "#8e6bf0", "#c58b00"];
const pct = (m) => `${(100 * (Math.min(TO, Math.max(FROM, m)) - FROM)) / span}%`;
const wid = (a, b) => `${(100 * (Math.min(TO, b) - Math.max(FROM, a))) / span}%`;
const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const first = (n) => n.split(" ")[0];

export default function WeekCal({ calendar: c }) {
  if (!c) return null;
  const n = c.people.length;
  return (
    <figure className="wcal" aria-label="Everyone's free times this week">
      <figcaption className="wcal-legend">
        {c.people.map((p, i) => <span key={p.id}><i style={{ background: LANE[i % LANE.length] }} />{p.id === "you" ? "You" : first(p.name)}</span>)}
        <span><i className="all" />Everyone free</span>
      </figcaption>
      <div className="wcal-axis" aria-hidden="true">{[8, 12, 16, 20].map((h) => <span key={h} style={{ left: pct(h * 60) }}>{h}:00</span>)}</div>
      <ol className="wcal-days">
        {c.days.map((d, di) => {
          const picked = c.pick?.date === d.date;
          return (
            <li key={d.date} className={`wcal-day ${picked ? "picked" : ""}`} style={{ animationDelay: `${di * 60}ms` }}>
              <span className="wcal-d">{d.day}<b>{+d.date.slice(8)}</b></span>
              <div className="wcal-track" style={{ "--lanes": n }}>
                {d.all.map(([a, b], k) => <i key={`a${k}`} className="wcal-all" style={{ left: pct(a), width: wid(a, b) }} title={`Everyone free ${hm(a)}–${hm(b)}`} />)}
                {d.rows.map((ws, i) => ws.map(([a, b], k) => (
                  <i key={`${i}-${k}`} className="wcal-lane" style={{ left: pct(a), width: wid(a, b), top: `calc(6px + ${i} * var(--lane))`, background: LANE[i % LANE.length] }} />
                )))}
                {picked && <span className="wcal-pick" style={{ left: pct(c.pick.from), width: wid(c.pick.from, c.pick.to) }}><em>{hm(c.pick.from)}</em></span>}
              </div>
              <span className="sr-only">{d.all.length ? `${d.day}: everyone free ${d.all.map(([a, b]) => `${hm(a)} to ${hm(b)}`).join(", ")}` : `${d.day}: no time when everyone is free`}{picked ? `; picked ${hm(c.pick.from)} to ${hm(c.pick.to)}` : ""}</span>
            </li>
          );
        })}
      </ol>
    </figure>
  );
}

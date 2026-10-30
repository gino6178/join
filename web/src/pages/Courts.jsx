import { useEffect, useMemo, useState } from "react";
import Icon from "../components/Icon.jsx";
import { agentPlaces, agentWhere } from "../agent.js";
import { patchGame } from "../club/game.js";
import { go } from "../App.jsx";
import "./courts.css";

// Courts near you, in any ball sport: public courts, school fields, sports centres and parks from OpenStreetMap, each
// judged by your agent for the time you want to play: are there hoops or nets, lights for an evening game, a roof if
// rain is likely, crowds, something broken or locked. Every reason cites the map, a Google Maps review (quoted word for
// word, checked) or the forecast. A list, not a map: Google's reviews are never shown on another map.
const SPORTS = [["basketball", "Basketball"], ["badminton", "Badminton"], ["tennis", "Tennis"], ["soccer", "Soccer"], ["volleyball", "Volleyball"], ["table tennis", "Table tennis"], ["pickleball", "Pickleball"]];
const VERDICT = { good: ["check", "Good to play"], maybe: ["info", "Maybe"], no: ["close", "Not now"] };
const CITE = { map: ["pin", "Map"], google: ["chat", "Review"], weather: ["sun", "Forecast"] };
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const rad = (d) => (d * Math.PI) / 180;
const toGeo = (geo, a) => ({ lat: geo.lat - (a.y * geo.unitKm) / 110.57, lon: geo.lon + (a.x * geo.unitKm) / (111.32 * Math.cos(rad(geo.lat))) });
const ymd = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
const TAGS = (p) => [p.tags.lit === "yes" && "Lights", p.tags.lit === "no" && "No lights", p.tags.hoops && `${p.tags.hoops} hoops`, p.count > 1 && `${p.count} courts`, p.tags.surface && p.tags.surface.replace(/_/g, " "), !p.outdoor && "Indoor or covered", p.tags.access && p.tags.access !== "yes" && `Access: ${p.tags.access}`, p.tags.fee === "yes" && "Fee", p.kind === "park" && "Park"].filter(Boolean);

export default function Courts() {
  const [home, setHome] = useState(null);
  const [sport, setSport] = useState(() => { const m = /[?&]sport=([^&]+)/.exec(location.hash); const s = m && decodeURIComponent(m[1]); return SPORTS.some(([k]) => k === s) ? s : "basketball"; });
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() + i); return { date: ymd(d), label: i === 0 ? "Today" : i === 1 ? "Tomorrow" : `${DOW[d.getDay()]} ${d.getDate()}` }; }), []);
  const [date, setDate] = useState(days[0].date), [start, setStart] = useState("19:00");
  const [near, setNear] = useState(null), [q, setQ] = useState(""), [err, setErr] = useState("");
  const [run, setRun] = useState(null);
  useEffect(() => {
    Promise.all([fetch("/data/venues.json").then((r) => r.json()), fetch("/data/club.json").then((r) => r.json())]).then(([v, c]) => {
      const g = v.map?.geo; if (!g) return;
      const h = { ...toGeo(g, c.you.area), name: `your area (${c.you.area.name}, ${g.place})` }; setHome(h); setNear(h);
    }).catch(() => setErr("The club map could not be loaded."));
  }, []);
  const mine = () => navigator.geolocation?.getCurrentPosition((p) => setNear({ lat: p.coords.latitude, lon: p.coords.longitude, name: "where you are" }), () => setErr("Location is off for this site."));
  const find = async () => { setErr(""); try { const w = await agentWhere(q); if (w.error) throw new Error(w.error); setNear(w); } catch (e) { setErr(e.message); } };
  const search = async () => {
    if (!near) return;
    setRun({ steps: [], working: "Searching OpenStreetMap for courts and parks", result: null });
    try {
      const r = await agentPlaces({ lat: near.lat, lon: near.lon, sport, date, start }, (e) => setRun((x) => x && (e.type === "step" ? { ...x, steps: [...x.steps, e] } : { ...x, working: e.step })));
      setRun((x) => ({ ...x, result: r, working: null }));
    } catch (e) { setRun((x) => ({ ...x, working: null, error: e.message })); }
  };
  const plan = () => { patchGame((s) => ({ ...s, autopilot: { ...(s.autopilot || {}), goal: { ...(s.autopilot?.goal || {}), sport } } })); go("autopilot?run=1"); };
  const r = run?.result;

  return (
    <div className="page courts-page">
      <header className="report-head">
        <div>
          <span className="tag">Courts near you · OpenStreetMap, Google Maps, the forecast</span>
          <h1 className="h1">Where can we play?</h1>
          <p className="muted">Public courts, school fields and parks near you, for any ball sport. Your agent reads the map, the ratings and the weather for the hour you want, and says if you can play there, with the reason for every call.</p>
        </div>
      </header>

      <section className="panel ct-ask" aria-label="What to look for">
        <div className="ct-row">
          <span className="ct-l">Sport</span>
          <div className="seg sm" role="radiogroup" aria-label="Sport">{SPORTS.map(([k, l]) => <button key={k} role="radio" aria-checked={sport === k} onClick={() => setSport(k)}>{l}</button>)}</div>
        </div>
        <div className="ct-row">
          <span className="ct-l">When</span>
          <select value={date} onChange={(e) => setDate(e.target.value)} aria-label="Day">{days.map((d) => <option key={d.date} value={d.date}>{d.label}</option>)}</select>
          <select value={start} onChange={(e) => setStart(e.target.value)} aria-label="Time">{["07:00", "09:00", "12:00", "15:00", "17:00", "19:00", "20:00", "21:00"].map((t) => <option key={t}>{t}</option>)}</select>
        </div>
        <div className="ct-row">
          <span className="ct-l">Near</span>
          <span className="ct-near"><Icon name="pin" size={16} />{near ? near.name : "…"}</span>
          {home && near !== home && <button className="btn sm" onClick={() => setNear(home)}>My area</button>}
          <button className="btn sm" onClick={mine}>Use my location</button>
          <form className="ct-q" onSubmit={(e) => { e.preventDefault(); if (q.trim()) find(); }}><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Or a place: Da'an Park" aria-label="A place to search near" /><button className="btn sm">Go</button></form>
        </div>
        <div className="cta-row">
          <button className="btn primary" onClick={search} disabled={!near || run?.working}><Icon name="spark" size={18} />{run?.working ? "Looking…" : "Find courts"}</button>
          {err && <span className="ct-err small" role="alert">{err}</span>}
        </div>
      </section>

      {run && (
        <section className="ct-run" aria-live="polite">
          <ol className="ct-steps">
            {run.steps.map((s, i) => <li key={i}><span className="ap-tool">{s.tool}</span><span><b>{s.step}</b><span className="tiny muted">{s.detail}</span></span></li>)}
            {run.working && <li className="working"><span className="ap-tool">agent</span><span className="ap-now"><span className="dots"><i /><i /><i /></span>{run.working}</span></li>}
          </ol>
          {run.error && <p className="ct-err" role="alert">{run.error}</p>}
        </section>
      )}

      {r && (
        <section aria-labelledby="ct-h">
          <div className="ct-head">
            <h2 id="ct-h" className="sec-label">{r.places.length} places for {sport}, {days.find((d) => d.date === r.date)?.label.toLowerCase() || r.date} at {r.start}{r.weather ? ` · rain ${r.weather.rain}%, ${r.weather.temp} °C` : ""}</h2>
            <button className="btn sm primary" onClick={plan}><Icon name="spark" size={16} />Line up a {sport} game with Autopilot</button>
          </div>
          <ul className="ct-list">
            {r.places.map((p) => (
              <li key={p.id} className={`panel ct-place ${p.verdict}`}>
                <div className="ct-top">
                  <span className={`ct-v ${p.verdict}`}><Icon name={VERDICT[p.verdict][0]} size={14} />{VERDICT[p.verdict][1]}</span>
                  <span className="tiny muted">{p.dist < 1000 ? `${p.dist} m` : `${(p.dist / 1000).toFixed(1)} km`} {p.dir}{p.rating != null ? ` · ${p.rating} ★ (${p.ratings})` : ""}</span>
                </div>
                <h3>{p.name}</h3>
                <div className="ct-tags">{TAGS(p).map((t) => <span key={t}>{t}</span>)}</div>
                <ul className="ct-why">
                  {p.reasons.map((x, i) => (
                    <li key={i}><span className={`ct-cite ${x.cite}`} title={CITE[x.cite]?.[1]}><Icon name={CITE[x.cite]?.[0] || "info"} size={13} /></span>
                      <span>{x.text}{x.quote && <q className="ct-quote">{x.quote}</q>}{x.review && p.reviews.find((v) => v.n === x.review) && <span className="tiny muted"> · {p.reviews.find((v) => v.n === x.review).author}, {p.reviews.find((v) => v.n === x.review).when}, Google Maps</span>}</span></li>
                  ))}
                </ul>
                <div className="ct-foot">
                  <span className="tiny muted">{p.by === "model" ? "Judged by Muse Glimmer; every reason checked against its source" : "Judged by rules from the map and the forecast"}</span>
                  <a className="btn sm" href={p.url || `https://www.openstreetmap.org/${p.id.replace("osm:", "")}`} target="_blank" rel="noreferrer">{p.url ? "Google Maps" : "OpenStreetMap"}</a>
                </div>
              </li>
            ))}
          </ul>
          <p className="tiny muted">Places and tags © OpenStreetMap contributors (ODbL). {r.google ? `Ratings${r.reviews ? " and reviews (shown with their author)" : ""} from Google Maps, not stored.` : "Google Maps ratings are read when the server has a Google Maps key."} Forecast: Open-Meteo.</p>
        </section>
      )}
    </div>
  );
}

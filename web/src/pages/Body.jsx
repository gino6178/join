import { useEffect, useMemo, useRef, useState } from "react";
import Body3D from "../components/Body3D.jsx";
import Icon from "../components/Icon.jsx";
import { agentBodyRead, agentBodyReport, agentHealthImport, agentBasemap } from "../agent.js";
import { useBody, seedBody, addEntries, mergeImport, bodyInput } from "../club/body.js";
import { autopilotInput } from "../tasks.js";
import { go } from "../App.jsx";
import "./body.css";

// Body: you tell your agent what hurts and it keeps the record, on the 3D body, on the side it hurts. Your health app's
// export (Apple Health, Google Fit, or a GPX, TCX or CSV from any app) fills in your workouts, routes, heart rate and
// sleep; the agent links them to your booked games and works out your load. From all of it the agent decides, by
// code with the reasons shown: doubles first while a knee is sore, shorter games for a sore back, one game fewer in
// a week far over your usual load, a check-in two days later, and when it is worth seeing a physio. It records; it
// does not diagnose.
const PARTS = {
  neck: ["traps", "top", false], shoulder: ["deltoid", "center", true], elbow: ["forearm", "top", true], wrist: ["forearm", "bottom", true],
  upperback: ["traps", "center", false], lowerback: ["lowback", "center", false], chest: ["pecs", "center", false], core: ["obliques", "center", false],
  hip: ["hipflex", "center", true], glute: ["glutes", "center", true], thigh: ["quads", "center", true], hamstring: ["hams", "center", true],
  knee: ["quads", "bottom", true], shin: ["shin", "center", true], calf: ["calves", "center", true], achilles: ["calves", "bottom", true],
  ankle: ["shin", "bottom", true], foot: ["shin", "bottom", true],
};
const BACKSIDE = new Set(["traps", "lowback", "glutes", "hams", "calves"]);
const JOINTS = new Set(["knee", "ankle", "wrist", "elbow", "achilles", "foot", "neck"]);
const ACT = { limit: ["verify", "Limit"], cap: ["clock", "Game length"], physio: ["warn", "See a physio"], load: ["goals", "Load"], learned: ["heart", "From your watch"], follow: ["chat", "Check-in"] };
const SPORTS = ["badminton", "running", "tennis", "pickleball", "basketball"]; // fixed colour slots, by sport
const colorOf = (s) => (SPORTS.includes(s) ? `var(--vz-${SPORTS.indexOf(s) + 1})` : "var(--vz-other)");
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const day = (iso) => new Date(iso.length > 10 ? iso : `${iso}T12:00:00`);
const short = (iso) => { const d = day(iso); return `${DOW[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1}`; };
const TREND = { new: "new", better: "getting better", worse: "getting worse", same: "about the same" };

export default function Body() {
  const store = useBody();
  const [club, setClub] = useState(null);
  const [org, setOrg] = useState(null), [err, setErr] = useState("");
  const [text, setText] = useState(""), [sending, setSending] = useState(false), [said, setSaid] = useState(null);
  const [sel, setSel] = useState(null), [view, setView] = useState("front");
  useEffect(() => { fetch("/data/club.json").then((r) => r.json()).then((c) => { seedBody(c); setClub(c); }).catch(() => setErr("The club data could not be loaded.")); }, []);
  const input = useMemo(() => club && bodyInput(club, autopilotInput().history), [club, store]);
  useEffect(() => {
    if (!input) return;
    let live = true;
    agentBodyReport({ ...input, summary: false }).then((r) => { if (live) { setOrg(r.org); setErr(""); } }).catch((e) => live && setErr(`Your agent is offline (${e.message}).`));
    return () => { live = false; };
  }, [input]);

  const send = async (t = text) => {
    if (!t.trim() || !input) return;
    setSending(true); setSaid({ text: t, reply: null });
    try {
      const r = await agentBodyRead({ ...input, text: t });
      if (r.entries.length) addEntries(r.entries);
      setSaid({ text: t, reply: r.reply, by: r.by, n: r.entries.length });
      setText("");
      const k = r.entries[0]; if (k) { setSel(`${k.part}${k.side ? ":" + k.side : ""}`); setView(BACKSIDE.has(PARTS[k.part]?.[0]) ? "back" : "front"); }
    } catch (e) { setSaid({ text: t, reply: `Your agent is offline (${e.message}).`, by: "error" }); }
    setSending(false);
  };
  const asked = useRef(false); // said on the agent home: filed as soon as the page has the data
  useEffect(() => { const m = /[?&]say=([^&]+)/.exec(location.hash); if (input && m && !asked.current) { asked.current = true; send(decodeURIComponent(m[1])); } }, [input]);

  const parts = org?.parts || [];
  const marks = useMemo(() => parts.filter((p) => p.active || p.ageDays <= 3).map((p) => ({ key: p.key, region: PARTS[p.part]?.[0], at: PARTS[p.part]?.[1], sided: PARTS[p.part]?.[2], side: p.side, level: p.latest.kind === "fine" ? 0 : p.latest.level })).filter((m) => m.region), [org]);
  const scores = useMemo(() => {
    const s = {};
    // a sore muscle is coloured; a joint (knee, ankle, wrist, elbow, Achilles, foot, neck) only gets its marker
    for (const p of parts.filter((x) => x.active && !JOINTS.has(x.part))) {
      const [region, , sided] = PARTS[p.part] || [];
      if (!region) continue;
      const st = { v: p.latest.level / 5, level: p.latest.level >= 3 ? "high" : "medium", kind: "s" };
      if (sided && (p.side === "left" || p.side === "right")) s[`${region}:${p.side}`] = st; else s[region] = st;
    }
    return s;
  }, [org]);
  const cur = parts.find((p) => p.key === sel) || parts.find((p) => p.active) || parts[0];

  return (
    <div className="page body-page">
      <header className="report-head">
        <div>
          <span className="tag">Body log · Muse Glimmer on your own GPU</span>
          <h1 className="h1">Tell your agent what hurts</h1>
          <p className="muted">It keeps the record on your body, reads your health app, and plans your games around it: doubles while a knee is sore, shorter games for a sore back, one game fewer in a heavy week. Two days later it asks how it is.</p>
        </div>
        <div className="cta-row">
          <a className="btn" href="#bd-report"><Icon name="table" size={18} />Body report</a>
          <button className="btn primary" onClick={() => go("autopilot?run=1")}><Icon name="spark" size={18} />Plan my week around it</button>
        </div>
      </header>
      {err && <p className="bd-err" role="alert"><Icon name="warn" size={16} />{err}</p>}

      <div className="bd-top">
        <section className="bd-figure panel" aria-label="Your body">
          <div className="bd-figure-tools">
            <div className="seg sm" role="radiogroup" aria-label="Camera">
              {[["front", "Front"], ["back", "Back"], ["side", "Side"]].map(([k, l]) => <button key={k} role="radio" aria-checked={view === k} onClick={() => setView(k)}>{l}</button>)}
            </div>
            <span className="bd-key tiny"><i className="k4" />bad (4 to 5)<i className="k3" />hurts (3)<i className="k2" />a bit (1 to 2)<i className="k0" />fine</span>
          </div>
          <Body3D scores={scores} sel={null} onSel={(r) => { const p = parts.find((x) => PARTS[x.part]?.[0] === r); if (p) setSel(p.key); }} view={view} marks={marks} height={540} />
          {cur && (
            <div className="bd-cur">
              <b>{cap(cur.name)}</b>
              <span className={`bd-lv l${cur.latest.kind === "fine" ? 0 : cur.latest.level}`}>{cur.latest.kind === "fine" ? "fine" : `${cur.latest.kind} ${cur.latest.level}/5`}</span>
              <span className="tiny muted">{TREND[cur.trend]} · {cur.entries.length} entr{cur.entries.length > 1 ? "ies" : "y"} · last {short(cur.latest.at)}</span>
              {cur.latest.trigger && <span className="tiny muted">“{cur.latest.trigger}”</span>}
            </div>
          )}
        </section>

        <div className="bd-side">
          <section className="panel bd-tell" aria-labelledby="tell-h">
            <h2 id="tell-h" className="panel-h">Tell your agent</h2>
            <form onSubmit={(e) => { e.preventDefault(); send(); }}>
              <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="Where it hurts, how much, and when it started" aria-label="What hurts"
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} />
              <button className="btn primary sm" disabled={sending || !text.trim()}>{sending ? "Filing…" : "Tell"}</button>
            </form>
            {said && (
              <div className="bd-said" aria-live="polite">
                <p className="bd-you">{said.text}</p>
                {said.reply ? <div className="bd-agent">{said.reply.split("\n").map((l, i) => <p key={i}>{l}</p>)}
                  {said.by !== "error" && <span className="tiny muted">{said.by === "model" ? "Read by Muse Glimmer (one tool call, checked by code)" : "Read by the word list"} · {said.n} entr{said.n === 1 ? "y" : "ies"} filed</span>}</div>
                  : <p className="bd-agent working"><span className="dots"><i /><i /><i /></span>Muse Glimmer is reading it</p>}
              </div>
            )}
          </section>

          <section className="panel" aria-labelledby="do-h">
            <h2 id="do-h" className="panel-h">What your agent is doing about it</h2>
            {org?.actions.length ? (
              <ul className="bd-acts">
                {org.actions.map((a, i) => <li key={i} className={a.kind}><span className="bd-act-ic"><Icon name={ACT[a.kind]?.[0] || "info"} size={16} /></span><span><b>{ACT[a.kind]?.[1]}</b><span>{a.text}</span><span className="tiny muted">Why: {a.why}</span></span></li>)}
              </ul>
            ) : <p className="muted small">{org ? "Nothing to change: nothing is sore and your load is normal." : err ? "This shows once your agent is reachable." : "Loading…"}</p>}
            <p className="tiny muted">Every action is decided by code from your log and your sessions, with its reason. The Autopilot follows them when it lines up your games. This is a record, not a diagnosis.</p>
          </section>
        </div>
      </div>

      <section className="panel bd-log" aria-labelledby="log-h">
        <h2 id="log-h" className="panel-h">Your body log, the last two weeks</h2>
        {parts.length ? <ul className="bd-parts">{parts.map((p) => <PartRow key={p.key} p={p} today={org.today} on={cur?.key === p.key} pick={() => { setSel(p.key); setView(BACKSIDE.has(PARTS[p.part]?.[0]) ? "back" : "front"); }} />)}</ul>
          : <p className="muted small">Nothing logged yet.</p>}
      </section>

      {org && <Trail org={org} />}
      <HealthData store={store} />
      {org && <Report org={org} input={input} />}
    </div>
  );
}

// one part: its entries as dots over the last 14 days, each with its level
function PartRow({ p, today, on, pick }) {
  const days = Array.from({ length: 14 }, (_, i) => { const d = day(today); d.setDate(d.getDate() - 13 + i); return d.toISOString().slice(0, 10); });
  return (
    <li className={on ? "on" : ""}>
      <button onClick={pick} aria-label={`${p.name}: show on the body`}>
        <span className="bd-pn"><b>{cap(p.name)}</b><span className="tiny muted">{TREND[p.trend]}{p.physio ? " · worth seeing a physio" : ""}</span></span>
        <span className="bd-dots" aria-hidden="true">
          {days.map((d) => { const e = [...p.entries].reverse().find((x) => x.at.slice(0, 10) === d); return <i key={d} className={e ? `l${e.kind === "fine" ? 0 : e.level}` : ""} title={e ? `${short(d)}: ${e.kind === "fine" ? "fine" : `${e.kind} ${e.level}/5`}` : short(d)}>{e ? (e.kind === "fine" ? "✓" : e.level) : ""}</i>; })}
        </span>
        <span className={`bd-lv l${p.latest.kind === "fine" ? 0 : p.latest.level}`}>{p.latest.kind === "fine" ? "fine" : `${p.latest.level}/5`}</span>
      </button>
    </li>
  );
}

// ---- the activity trail: weeks of minutes by sport, every session, routes -------------------------------------
function Trail({ org }) {
  const [tip, setTip] = useState(null), [route, setRoute] = useState(null);
  const weeks = org.weeks, max = Math.max(60, ...weeks.map((w) => w.minutes));
  const sports = [...SPORTS, "other"].filter((s) => weeks.some((w) => Object.keys(w.sports).some((k) => (SPORTS.includes(k) ? k : "other") === s)));
  const W = 640, H = 210, L = 34, B = 26, bw = (W - L - 8) / weeks.length;
  const y = (v) => H - B - (v / max) * (H - B - 18);
  const w4 = weeks.slice(-4), mins = w4.reduce((a, w) => a + w.minutes, 0), n = w4.reduce((a, w) => a + w.sessions, 0);
  const d28 = org.days.slice(-28), avg = (k) => { const v = d28.map((x) => x[k]).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const runs = org.sessions.filter((s) => s.route?.length > 1);
  useEffect(() => { if (!route && runs[0]) setRoute(runs[0]); }, [runs.length]);
  const step = [30, 60, 90, 120, 150, 180, 240, 300].find((s) => max / s <= 4) || 300;
  const ticks = Array.from({ length: Math.floor(max / step) + 1 }, (_, i) => i * step);
  return (
    <section className="bd-trail" aria-labelledby="trail-h">
      <h2 id="trail-h" className="sec-label">Your activity trail</h2>
      <div className="bd-tiles">
        <div className="panel"><span className="tiny muted">Last 4 weeks</span><b>{n}</b><span className="small">sessions, {mins} min</span></div>
        <div className={`panel ${org.load.acwr > 1.5 ? "hot" : ""}`}><span className="tiny muted">This week's load</span><b>{org.load.acwr != null ? `${org.load.acwr}×` : "–"}</b><span className="small">your usual week{org.load.acwr > 1.5 ? ": a spike" : ""}</span></div>
        <div className="panel"><span className="tiny muted">Resting heart rate</span><b>{avg("restingHr") ? Math.round(avg("restingHr")) : "–"}</b><span className="small">bpm, 4-week average</span><Spark days={org.days} k="restingHr" unit="bpm" /></div>
        <div className="panel"><span className="tiny muted">Sleep</span><b>{avg("sleepH") ? avg("sleepH").toFixed(1) : "–"}</b><span className="small">hours a night</span><Spark days={org.days} k="sleepH" unit="h" /></div>
      </div>
      <div className="bd-trail-grid">
        <figure className="panel bd-chart">
          <figcaption><b>Minutes a week, by sport</b><span className="tiny muted">Load = minutes × effort (from heart rate when your watch has it)</span></figcaption>
          <ul className="bd-legend" aria-label="Sports">{sports.map((s) => <li key={s}><i style={{ background: colorOf(s) }} />{cap(s)}</li>)}</ul>
          <div className="bd-svgwrap" onMouseLeave={() => setTip(null)}>
            <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Minutes played each week, stacked by sport">
              {ticks.map((t) => <g key={t}><line x1={L} x2={W - 4} y1={y(t)} y2={y(t)} className="grid" /><text x={L - 6} y={y(t) + 4} className="ax" textAnchor="end">{t}</text></g>)}
              {weeks.map((w, i) => {
                let acc = 0;
                const segs = sports.map((s) => [s, Object.entries(w.sports).filter(([k]) => (SPORTS.includes(k) ? k : "other") === s).reduce((a, [, v]) => a + v, 0)]).filter(([, v]) => v > 0);
                const x = L + i * bw + bw * 0.2, bwi = bw * 0.6;
                return (
                  <g key={w.week}>
                    {segs.map(([s, v], j) => {
                      const y0 = y(acc), y1 = y(acc + v); acc += v;
                      const top = j === segs.length - 1, h = Math.max(1, y0 - y1 - (j ? 2 : 0)), yy = y1;
                      const r = top ? Math.min(4, h) : 0;
                      return <path key={s} d={`M${x},${yy + h} V${yy + r} Q${x},${yy} ${x + r},${yy} H${x + bwi - r} Q${x + bwi},${yy} ${x + bwi},${yy + r} V${yy + h} Z`} fill={colorOf(s)}
                        onMouseEnter={() => setTip({ x: x + bwi / 2, y: yy, t: `Week of ${short(w.week)} · ${cap(s)} ${v} min` })} />;
                    })}
                    <rect x={L + i * bw} y={0} width={bw} height={H - B} fill="transparent" onMouseEnter={() => setTip({ x: x + bwi / 2, y: y(w.minutes), t: `Week of ${short(w.week)} · ${w.minutes} min, ${w.sessions} sessions, load ${w.load}` })} style={{ pointerEvents: segsOf(w) ? "none" : "auto" }} />
                    {w.minutes > 0 && <text x={x + bwi / 2} y={y(w.minutes) - 6} className="val" textAnchor="middle">{w.minutes}</text>}
                    <text x={x + bwi / 2} y={H - 8} className="ax" textAnchor="middle">{short(w.week).split(" ")[1]}</text>
                  </g>
                );
              })}
            </svg>
            {tip && <div className="bd-tip" style={{ left: `${(tip.x / W) * 100}%`, top: `${(tip.y / H) * 100}%` }}>{tip.t}</div>}
          </div>
        </figure>
        <figure className="panel bd-route">
          <figcaption><b>{route ? `${cap(route.sport)}, ${short(route.date)}` : "Routes"}</b><span className="tiny muted">{route ? `${route.km ?? "?"} km · ${route.minutes} min${route.avgHr ? ` · ${route.avgHr} bpm average` : ""}` : "Workouts with GPS show up here"}</span></figcaption>
          {route ? <RouteMap pts={route.route} /> : <div className="bd-noroute muted small">Import your health app to see your routes.</div>}
          {runs.length > 1 && <div className="bd-runs">{runs.slice(0, 8).map((r) => <button key={r.date + r.start} className={`chip ${route === r ? "on" : ""}`} onClick={() => setRoute(r)}>{short(r.date)}</button>)}</div>}
        </figure>
      </div>
      <details className="panel bd-sessions">
        <summary><b>Every session</b> <span className="tiny muted">{org.sessions.length} in the last 120 days · games from the club, workouts from your health app, one list</span></summary>
        <table>
          <thead><tr><th>Day</th><th>Sport</th><th>Minutes</th><th>Heart rate</th><th>From</th></tr></thead>
          <tbody>{org.sessions.slice(0, 40).map((s, i) => <tr key={i}><td>{short(s.date)} {s.start || ""}</td><td><i className="bd-sw" style={{ background: colorOf(s.sport) }} />{cap(s.sport)}{s.with?.length ? <span className="tiny muted"> with {s.with.length}</span> : null}</td><td>{s.minutes}{s.booked && s.minutes !== s.booked ? <span className="tiny muted"> (booked {s.booked})</span> : null}</td><td>{s.avgHr ? `${s.avgHr} avg` : "–"}</td><td className="tiny muted">{s.from ? `${s.source} + ${s.from}` : s.source}</td></tr>)}</tbody>
        </table>
      </details>
    </section>
  );
}
const segsOf = (w) => Object.keys(w.sports).length;

// a one-series sparkline with a hover readout
function Spark({ days, k, unit }) {
  const pts = days.filter((d) => d[k] != null).slice(-42);
  const [h, setH] = useState(null);
  if (pts.length < 3) return null;
  const vs = pts.map((d) => d[k]), lo = Math.min(...vs), hi = Math.max(...vs), W = 160, H = 34;
  const xy = (d, i) => [(i / (pts.length - 1)) * (W - 4) + 2, H - 3 - ((d[k] - lo) / (hi - lo || 1)) * (H - 8)];
  return (
    <div className="bd-spark" onMouseLeave={() => setH(null)} onMouseMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); setH(Math.max(0, Math.min(pts.length - 1, Math.round(((e.clientX - r.left) / r.width) * (pts.length - 1))))); }}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        <polyline points={pts.map((d, i) => xy(d, i).join(",")).join(" ")} />
        {h != null && <><line x1={xy(pts[h], h)[0]} x2={xy(pts[h], h)[0]} y1={0} y2={H} /><circle cx={xy(pts[h], h)[0]} cy={xy(pts[h], h)[1]} r={3} /></>}
      </svg>
      <span className="tiny muted">{h != null ? `${short(pts[h].date)}: ${pts[h][k]} ${unit}` : `${short(pts[0].date)} to ${short(pts.at(-1).date)}`}</span>
    </div>
  );
}

// a GPS route on a map drawn in the app's own style: roads, rivers and parks from OpenStreetMap (through your
// server, kept a month), no labels. The area is snapped to a grid so routes from the same place share one map.
const baseCache = new Map();
function RouteMap({ pts }) {
  const W = 600, H = 320, g = 0.005;
  const lat = pts.map((p) => p[0]), lon = pts.map((p) => p[1]);
  const bb = { s: +(Math.floor(Math.min(...lat) / g) * g - g).toFixed(3), n: +(Math.ceil(Math.max(...lat) / g) * g + g).toFixed(3), w: +(Math.floor(Math.min(...lon) / g) * g - g).toFixed(3), e: +(Math.ceil(Math.max(...lon) / g) * g + g).toFixed(3) };
  const key = `${bb.s},${bb.w},${bb.n},${bb.e}`;
  const [base, setBase] = useState(baseCache.get(key) || null);
  useEffect(() => {
    if (baseCache.has(key)) return setBase(baseCache.get(key));
    let live = true; setBase(null);
    agentBasemap(bb).then((m) => { if (m.error) throw new Error(m.error); baseCache.set(key, m); if (live) setBase(m); }).catch(() => live && setBase({ roads: [], rivers: [], water: [], green: [], failed: true }));
    return () => { live = false; };
  }, [key]);
  // fit the route (not the whole area) with a margin; equirectangular is exact enough across a few kilometres
  const k = Math.cos((((Math.min(...lat) + Math.max(...lat)) / 2) * Math.PI) / 180);
  const spanX = (Math.max(...lon) - Math.min(...lon)) * k || 0.001, spanY = Math.max(...lat) - Math.min(...lat) || 0.001;
  const sc = Math.min((W - 70) / spanX, (H - 70) / spanY), cx = (Math.max(...lon) + Math.min(...lon)) / 2, cy = (Math.max(...lat) + Math.min(...lat)) / 2;
  const xy = ([a, b]) => `${(W / 2 + (b - cx) * k * sc).toFixed(1)},${(H / 2 - (a - cy) * sc).toFixed(1)}`;
  const line = (gg) => gg.map(xy).join(" ");
  const m = sc / 111320; // pixels per metre
  return (
    <div className="bd-map">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="The route on a map">
        <rect width={W} height={H} className="land" />
        {base && <>
          {base.green.map((x, i) => <polygon key={`g${i}`} points={line(x)} className="green" />)}
          {base.water.map((x, i) => <polygon key={`w${i}`} points={line(x)} className="water" />)}
          {base.rivers.map((x, i) => <polyline key={`r${i}`} points={line(x.g)} className="river" style={{ strokeWidth: Math.max(2, (x.k === "river" ? 120 : x.k === "canal" ? 18 : 8) * m) }} />)}
          {base.roads.filter((x) => x.k === "path").map((x, i) => <polyline key={`p${i}`} points={line(x.g)} className="path" />)}
          {base.roads.filter((x) => x.k === "minor").map((x, i) => <polyline key={`n${i}`} points={line(x.g)} className="minor" style={{ strokeWidth: Math.max(1.5, 9 * m) }} />)}
          {base.roads.filter((x) => x.k === "major").map((x, i) => <polyline key={`j${i}`} points={line(x.g)} className="major" style={{ strokeWidth: Math.max(3, 18 * m) }} />)}
        </>}
        <polyline points={line(pts)} className="route" />
        <circle cx={xy(pts[0]).split(",")[0]} cy={xy(pts[0]).split(",")[1]} r={6} className="start" />
      </svg>
      {!base && <span className="bd-attr loading">Drawing the map…</span>}
      <span className="bd-attr">Map data © OpenStreetMap contributors</span>
    </div>
  );
}

// ---- health data: your phone's export, read on your own server ---------------------------------------------------
function HealthData({ store }) {
  const [busy, setBusy] = useState(null), [fail, setFail] = useState("");
  const run = async (file) => {
    if (!file) return;
    setBusy({ name: file.name, steps: [], working: "Sending to your server" }); setFail("");
    try {
      const r = await agentHealthImport(file, (e) => setBusy((b) => b && (e.type === "step" ? { ...b, steps: [...b.steps, e] } : { ...b, working: e.step })));
      mergeImport(r);
      setBusy(null);
    } catch (e) { setFail(e.message); setBusy(null); }
  };
  const sample = async () => {
    const b = await fetch("/data/sample/serve_sample_health_export.zip").then((r) => r.blob());
    run(new File([b], "serve_sample_health_export.zip", { type: "application/zip" }));
  };
  const last = store.imports[0];
  return (
    <section className="bd-health" aria-labelledby="hd-h">
      <h2 id="hd-h" className="sec-label">Your health app</h2>
      <div className="bd-health-grid">
        <div className="panel">
          <h3 className="panel-h">Bring in your workouts</h3>
          <ul className="bd-src">
            <li><b>Apple Health</b><span className="tiny muted">On iPhone: Health, your picture, Export All Health Data. Choose the export.zip here, or share it to Serve in Messenger.</span></li>
            <li><b>Google Fit</b><span className="tiny muted">Google Takeout, Fit: the zip with your activities and daily metrics.</span></li>
            <li><b>Any app</b><span className="tiny muted">One GPX, TCX or CSV file from Strava, Garmin, Huawei, Samsung or a spreadsheet.</span></li>
          </ul>
          <div className="cta-row">
            <label className="btn primary sm"><input type="file" accept=".zip,.xml,.gpx,.tcx,.csv" hidden onChange={(e) => run(e.target.files?.[0])} disabled={!!busy} /><Icon name="plus" size={16} />Choose a file</label>
            <button className="btn sm" onClick={sample} disabled={!!busy}>Try the sample export</button>
          </div>
          <p className="tiny muted">The file goes to your own server only, is read there and deleted. Your agent links the workouts to your booked games and works out your load.</p>
        </div>
        <div className="panel" aria-live="polite">
          <h3 className="panel-h">{busy ? `Reading ${busy.name}` : "What your agent filed"}</h3>
          {busy ? (
            <ul className="bd-steps">{busy.steps.map((s, i) => <li key={i}><Icon name="check" size={14} /><span><b>{s.step}</b><span className="tiny muted">{s.detail}</span></span></li>)}<li className="working"><span className="dots"><i /><i /><i /></span>{busy.working}</li></ul>
          ) : last ? (
            <>
              <p className="small"><b>{last.source}</b> · {last.file}<br /><span className="muted">{last.counts.workouts} workouts ({last.counts.routes} with a GPS route), {last.counts.days} days of steps, heart rate and sleep · {last.added} new</span></p>
              <p className="tiny muted">{store.workouts.length} workouts and {store.days.length} days on this device. Imported {new Date(last.at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}.</p>
            </>
          ) : <p className="muted small">Nothing imported yet.</p>}
          {fail && <p className="bd-err small" role="alert">{fail}</p>}
        </div>
      </div>
    </section>
  );
}

// ---- the report: Muse Glimmer's summary (every number checked), the parts, the load, what the agent did ----------
function Report({ org, input }) {
  const [s, setS] = useState(null), [busy, setBusy] = useState(false);
  const write = async () => { setBusy(true); try { setS((await agentBodyReport({ ...input, summary: true })).summary); } catch (e) { setS({ text: `Your agent is offline (${e.message}).`, by: "error" }); } setBusy(false); };
  useEffect(() => { setS(null); }, [input]);
  const w4 = org.weeks.slice(-4), sports = Object.entries(w4.reduce((a, w) => { for (const [k, v] of Object.entries(w.sports)) a[k] = (a[k] || 0) + v; return a; }, {})).sort((a, b) => b[1] - a[1]);
  const print = () => { document.body.classList.add("print-report"); setTimeout(() => { window.print(); document.body.classList.remove("print-report"); }, 50); };
  return (
    <section id="bd-report" className="panel bd-report" aria-labelledby="rp-h">
      <header>
        <div><h2 id="rp-h" className="panel-h">Body report</h2><span className="tiny muted">The last four weeks to {short(org.today)}, for you or your physio</span></div>
        <div className="cta-row noprint">
          {!s && <button className="btn sm primary" onClick={write} disabled={busy}><Icon name="spark" size={16} />{busy ? "Muse Glimmer is writing…" : "Write the summary"}</button>}
          <button className="btn sm" onClick={print}><Icon name="download" size={16} />Download PDF</button>
        </div>
      </header>
      {s && <p className="bd-sum">{s.text}<span className="tiny muted">{s.by === "model" ? " Written by Muse Glimmer from your data; every number checked against it." : s.by === "rules" ? " Written by rules (the model's draft did not pass the check)." : ""}</span></p>}
      <div className="bd-rgrid">
        <div><h3>Sessions</h3><p>{w4.reduce((a, w) => a + w.sessions, 0)} sessions, {w4.reduce((a, w) => a + w.minutes, 0)} minutes</p><p className="small muted">{sports.map(([k, v]) => `${cap(k)} ${v} min`).join(" · ") || "none"}</p></div>
        <div><h3>Load</h3><p>{org.load.acwr != null ? `${org.load.acwr}× your usual week` : "no data"}</p><p className="small muted">{org.load.acute} this week, {org.load.chronic} a week on average (minutes × effort)</p></div>
        <div><h3>Body</h3>{org.parts.length ? <ul>{org.parts.map((p) => <li key={p.key}>{cap(p.name)}: {p.latest.kind === "fine" ? "fine" : `${p.latest.kind} ${p.latest.level}/5`}, {TREND[p.trend]} ({p.entries.length})</li>)}</ul> : <p>nothing logged</p>}</div>
        <div><h3>What the agent changed</h3>{org.actions.length ? <ul>{org.actions.map((a, i) => <li key={i}>{a.text}</li>)}</ul> : <p>nothing</p>}</div>
      </div>
      <p className="tiny muted">A record of what you told your agent and what your devices measured. It is not a medical assessment.</p>
    </section>
  );
}

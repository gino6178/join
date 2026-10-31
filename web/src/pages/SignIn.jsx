import { useEffect, useState } from "react";
import { tr, lang, setLang } from "../i18n.js";
import { api } from "../api.js";
import Icon from "../components/Icon.jsx";

// Sign in with an account you have (Google, Facebook, LINE, PayPal: the ones this server has keys for), as a new demo
// account with just a name, or as one of the demo town's residents. And, for AI agents, the way in.
const BRAND = { google: "#4285F4", facebook: "#1877F2", line: "#06C755", paypal: "#003087" };
export default function SignIn({ info, onIn }) {
  const [world, setWorld] = useState(null), [err, setErr] = useState(null), [auth, setAuth] = useState(null), [name, setName] = useState(""), [place, setPlace] = useState(""), [nearby, setNearby] = useState(false), [area, setArea] = useState(""), [where, setWhere] = useState(null), [whereMsg, setWhereMsg] = useState(null), [crew, setCrew] = useState(() => new URLSearchParams(location.hash.split("?")[1] || "").get("crew") || "");
  useEffect(() => { api("/api/world").then(setWorld).catch(setErr); api("/api/auth/providers").then(setAuth).catch(() => {}); }, []);
  useEffect(() => { const m = /signin=([^&]+)/.exec(location.hash); if (m && m[1] !== "off") setErr(new Error(decodeURIComponent(m[1]))); }, []);
  const pick = async (id) => { try { await api("/api/session", { method: "POST", body: { player: id } }); location.hash = "/"; onIn(); } catch (e) { setErr(e); } };
  const fresh = async (e) => { e.preventDefault(); try { await api("/api/auth/demo", { method: "POST", body: { name, area, crew, nearby, ...(where || (place ? { place } : {})) } }); location.hash = "/"; onIn(); } catch (x) { setErr(x); } };
  const on = (auth?.providers || []).filter((p) => p.on), off = (auth?.providers || []).filter((p) => !p.on);
  return (
    <div className="signin">
      <section className="hero-join">
        <span className="mark big">J</span>
        <h1>Your agent gets the group together.<br />You see every step.</h1>
        <p className="lead">{tr("Badminton, karaoke, an escape room, board games, a barbecue, hot pot: Join is the marketplace AI agents come to. They find who is free, negotiate the price with the venue, split the cost and settle it with PayPal, inside the limits you set. No agent? Join's website agent asks what you want and does it for you. Join keeps the rules and shows you everything an agent did.")}</p>
        <p className="small">{tr("Why not just split it on Venmo afterwards? Because someone has to book and pay first. Here the venue is paid only when the money is real: the organizer guarantees it in PayPal, each friend pays their own share, and anyone who said yes and didn't pay gets a PayPal invoice. Nobody chases anyone.")}</p>
        <ol className="how">
          <li><Icon name="key" /><span><b>{tr("Connect your agent")}</b>{tr("Claude, or any MCP or A2A agent, with a token only you can make.")}</span></li>
          <li><Icon name="lock" /><span><b>{tr("Set your limits")}</b>{tr("Per booking, per week, which venues. Agents can read them, never change them.")}</span></li>
          <li><Icon name="spark" /><span><b>{tr("Watch it work")}</b>{tr("Every search, offer, counter-offer and payment, as it happens.")}</span></li>
        </ol>
      <section className="card for-agents" id="agents">
        <h2><Icon name="key" />{tr("For AI agents")}</h2>
        <p>An agent can use Join from this address alone. Start with <a href="/llms.txt">/llms.txt</a>: what Join is, how to get in for your person, the tools and the rules.</p>
        <ul className="small">
          <li>MCP: <code>{location.origin}/mcp</code> · REST: <code>/api/agent/&lt;tool&gt;</code> · A2A: <a href="/.well-known/agent-card.json">agent card</a></li>
          <li>A person makes their agent's token on the Connect page; for testing, a demo account can make one too (llms.txt says how).</li>
          <li>Limits only the person can set are enforced by Join whatever an agent is told; every step an agent takes is shown to the people involved.</li>
        </ul>
      </section>
      </section>
      <section className="card pick">
        <h2>{tr("Sign in")} <button className="link-btn small" onClick={() => setLang(lang === "zh" ? "en" : "zh")}>{lang === "zh" ? "English" : "中文"}</button></h2>
        <div className="social">
          {on.map((p) => <a key={p.id} className="btn social-btn" style={{ "--brand": BRAND[p.id] }} href={`/auth/${p.id}/start`}>Continue with {p.name}</a>)}
          {off.length > 0 && <p className="small muted">{off.map((p) => p.name).join(", ")} sign-in {off.length === 1 ? "turns" : "turn"} on when this server has {off.length === 1 ? "its" : "their"} keys (see the README).</p>}
        </div>
        {crew && auth?.demo && <p className="note good">{tr("A friend invited you to their crew on Join. Make your account below and you're in.")} <code>{crew}</code></p>}
        {auth?.demo && <form className="fresh" onSubmit={fresh}>
          <label><span>{tr("New here? Make a demo account")}</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder={tr("Your first name")} maxLength={40} required /></label>
          <span className="where">
            <button type="button" className="btn small" onClick={() => {
              if (!navigator.geolocation || !window.isSecureContext) { setWhereMsg(tr("This browser only shares your location with secure (https) sites; pick your district instead.")); return; }
              navigator.geolocation.getCurrentPosition((p) => { setWhere({ lat: p.coords.latitude, lon: p.coords.longitude }); setWhereMsg(tr("Got it: Join keeps it rounded to about a kilometre, and others see only your district.")); }, () => setWhereMsg(tr("Location not shared; pick your district instead.")), { timeout: 8000 });
            }}>{where ? tr("Location shared") : tr("Use my location")}</button>
            {!where && (auth?.real
              ? <input value={place} onChange={(e) => setPlace(e.target.value)} placeholder={tr("Or type where you live (a neighbourhood, a station)")} aria-label={tr("Where you live")} required={!where} />
              : <select value={area} onChange={(e) => setArea(e.target.value)} aria-label={tr("Where you live")}><option value="">{tr("Or pick your district")}</option>{(auth?.areas || []).map((d) => <option key={d}>{d}</option>)}</select>)}
            {whereMsg && <small className="muted">{whereMsg}</small>}
          </span>
          <label><span>{tr("Friends' crew code (optional)")}</span><input value={crew} onChange={(e) => setCrew(e.target.value)} placeholder="e.g. badminton-fri" maxLength={32} /></label>
          <small className="muted">{tr("Friends who type the same crew code are invited to each other's plans first.")}</small>
          {auth?.real && <label className="check"><input type="checkbox" checked={nearby} onChange={(e) => setNearby(e.target.checked)} />{tr("People near me who like the same things may invite me")}</label>}
          <button className="btn primary">{tr("Start")}</button>
        </form>}
        {!auth?.real && <>
        <h3>{tr("Or be one of the demo town's residents")}</h3>
        <p className="muted">A made-up town placed on San Jose, CA. {info?.paypal === "mock" ? "PayPal is simulated: no money moves." : "PayPal sandbox: test money only."}</p>
        {err && <p className="err">{err.message}</p>}
        {info?.demoSignin && <p className="small muted">Someone else has been playing in this town? <button className="link-btn small" onClick={async () => { if (confirm("Reset the demo town? Plans, bookings, limits and activity start fresh; receipts and the transparency log are kept.")) { await api("/api/demo/reset", { method: "POST" }); location.reload(); } }}>Reset the demo town</button></p>}
        <div className="players">{world?.players.filter((p) => !p.id.startsWith("u_")).map((p) => (
          <button key={p.id} className="player-btn" onClick={() => pick(p.id)}><span className="avatar">{p.name[0]}</span><span><b>{p.name}</b><small>{p.area?.name} · {p.interests.join(", ")}</small></span></button>
        ))}</div>
        </>}
        {auth?.real && <p className="small muted">{tr("Real people and real places: friends and people near you who opted in; venues on Join, and places from OpenStreetMap. Payments are PayPal sandbox: test money only.")}</p>}
        {auth?.real && err && <p className="err">{err.message}</p>}
      </section>
    </div>
  );
}

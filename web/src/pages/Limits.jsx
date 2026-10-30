import { useState } from "react";
import { api, money } from "../api.js";
import { useWorld } from "../components/Actor.jsx";
import Icon from "../components/Icon.jsx";

// The person's mandate: what any of their agents may commit them to. Only here, signed in as themselves; an agent's
// token can read it and never change it. Saving PayPal (Vault) lets their agent pay within these limits without a
// redirect each time; without it, every payment waits for their approval in PayPal.
export default function Limits({ me, reload, query }) {
  const w = useWorld(), m = me.mandate;
  const [perGame, setPerGame] = useState((m.perGame / 100).toFixed(2)), [perWeek, setPerWeek] = useState((m.perWeek / 100).toFixed(2));
  const [venues, setVenues] = useState(m.venues), [msg, setMsg] = useState(query.get("saved") ? "PayPal saved for your agent." : null), [err, setErr] = useState(null);
  const save = async (patch) => { setErr(null); try { await api("/api/mandate", { method: "PUT", body: patch }); await reload(); setMsg("Saved. Your agents see the new limits on their next step."); } catch (e) { setErr(e.message); } };
  const submit = (e) => { e.preventDefault(); save({ perGame: Math.round(+perGame * 100), perWeek: Math.round(+perWeek * 100), venues }); };
  const vault = async () => { try { const r = await api("/api/vault", { method: "POST" }); location.href = r.approveUrl; } catch (e) { setErr(e.message); } };
  const forget = async () => { await api("/api/vault", { method: "DELETE" }); reload(); };
  return (
    <div className="page">
      <header className="page-head"><h1>Limits</h1><p className="muted">What your agents may commit you to. Join refuses anything over these before a venue sees it. Only you can change them, here.</p></header>
      {msg && <p className="note good">{msg}</p>}{err && <p className="err">{err}</p>}
      <form className="card form" onSubmit={submit}>
        <label><span>Most for one game (your share)</span><span className="money-in">$<input type="number" min="0" step="0.5" value={perGame} onChange={(e) => setPerGame(e.target.value)} /></span></label>
        <label><span>Most in one week</span><span className="money-in">$<input type="number" min="0" step="1" value={perWeek} onChange={(e) => setPerWeek(e.target.value)} /></span></label>
        <fieldset><legend>Venues</legend>
          <label className="check"><input type="radio" checked={venues === null} onChange={() => setVenues(null)} />Any venue</label>
          <label className="check"><input type="radio" checked={venues !== null} onChange={() => setVenues(venues || [])} />Only these:</label>
          {venues !== null && <div className="venue-checks">{w?.venues.map((v) => <label key={v.id} className="check"><input type="checkbox" checked={venues.includes(v.id)} onChange={(e) => setVenues(e.target.checked ? [...venues, v.id] : venues.filter((x) => x !== v.id))} />{v.name}</label>)}</div>}
        </fieldset>
        <button className="btn primary">Save limits</button>
      </form>
      <section className="card form">
        <h3><Icon name="card" size={18} />Let your agent pay without asking each time</h3>
        {me.vault ? <>
          <p>PayPal is saved for Join. {m.autopay ? `Your agent pays your share by itself when it is within ${money(m.perGame / 100)} a game and ${money(m.perWeek / 100)} a week; anything more still waits for you.` : "Turned off: every payment waits for your approval in PayPal."}</p>
          <label className="check"><input type="checkbox" checked={m.autopay} onChange={(e) => save({ autopay: e.target.checked })} />My agent may pay within my limits</label>
          <button className="btn ghost" onClick={forget}>Remove saved PayPal</button>
        </> : <>
          <p className="muted">Approve once in PayPal and save it for Join (PayPal Vault). Then your agent can pay your share of a game within your limits without sending you to PayPal each time. You can turn it off or remove it here at any time.</p>
          <button className="btn primary" onClick={vault}>Save PayPal for my agent</button>
        </>}
      </section>
    </div>
  );
}

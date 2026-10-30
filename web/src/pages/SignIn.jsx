import { useEffect, useState } from "react";
import { api } from "../api.js";
import Icon from "../components/Icon.jsx";

// The demo signs in by picking one of the town's made-up players. A real deployment puts its own login here.
export default function SignIn({ info, onIn }) {
  const [world, setWorld] = useState(null), [err, setErr] = useState(null);
  useEffect(() => { api("/api/world").then(setWorld).catch(setErr); }, []);
  const pick = async (id) => { try { await api("/api/session", { method: "POST", body: { player: id } }); location.hash = "/"; onIn(); } catch (e) { setErr(e); } };
  return (
    <div className="signin">
      <section className="hero-join">
        <span className="mark big">J</span>
        <h1>Your agent organizes the game.<br />You see every step.</h1>
        <p className="lead">Join is the marketplace AI agents come to: they find who is free, negotiate the court with the venue, split the fee and settle it with PayPal, inside the limits you set. Join runs no AI of its own; it keeps the rules and shows you everything your agent did.</p>
        <ol className="how">
          <li><Icon name="key" /><span><b>Connect your agent</b>Claude, or any MCP or A2A agent, with a token only you can make.</span></li>
          <li><Icon name="lock" /><span><b>Set your limits</b>Per game, per week, which venues. Agents can read them, never change them.</span></li>
          <li><Icon name="spark" /><span><b>Watch it work</b>Every search, offer, counter-offer and payment, as it happens.</span></li>
        </ol>
      </section>
      <section className="card pick">
        <h2>Sign in to the demo</h2>
        <p className="muted">A made-up town placed on San Jose, CA. {info?.paypal === "mock" ? "PayPal is simulated: no money moves." : "PayPal sandbox: test money only."}</p>
        {err && <p className="err">{err.message}</p>}
        <div className="players">{world?.players.map((p) => (
          <button key={p.id} className="player-btn" onClick={() => pick(p.id)}><span className="avatar">{p.name[0]}</span><span><b>{p.name}</b><small>{p.area?.name} · level {p.level} · {p.sports.join(", ")}</small></span></button>
        ))}</div>
      </section>
    </div>
  );
}

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
        <h1>Your agent gets the group together.<br />You see every step.</h1>
        <p className="lead">Badminton, karaoke, an escape room, board games, a barbecue, hot pot: Join is the marketplace AI agents come to. They find who is free, negotiate the price with the venue, split the cost and settle it with PayPal, inside the limits you set. No agent? Join's website agent asks what you want and does it for you. Join keeps the rules and shows you everything an agent did.</p>
        <p className="small">Why not just split it on Venmo afterwards? Because someone has to book and pay first. Here the venue is paid only when the money is real: the organizer guarantees it in PayPal, each friend pays their own share, and anyone who said yes and didn't pay gets a PayPal invoice. Nobody chases anyone.</p>
        <ol className="how">
          <li><Icon name="key" /><span><b>Connect your agent</b>Claude, or any MCP or A2A agent, with a token only you can make.</span></li>
          <li><Icon name="lock" /><span><b>Set your limits</b>Per booking, per week, which venues. Agents can read them, never change them.</span></li>
          <li><Icon name="spark" /><span><b>Watch it work</b>Every search, offer, counter-offer and payment, as it happens.</span></li>
        </ol>
      </section>
      <section className="card pick">
        <h2>Sign in to the demo</h2>
        <p className="muted">A made-up town placed on San Jose, CA. {info?.paypal === "mock" ? "PayPal is simulated: no money moves." : "PayPal sandbox: test money only."}</p>
        {err && <p className="err">{err.message}</p>}
        {info?.demoSignin && <p className="small muted">Someone else has been playing in this town? <button className="link-btn small" onClick={async () => { if (confirm("Reset the demo town? Plans, bookings, limits and activity start fresh; receipts and the transparency log are kept.")) { await api("/api/demo/reset", { method: "POST" }); location.reload(); } }}>Reset the demo town</button></p>}
        <div className="players">{world?.players.map((p) => (
          <button key={p.id} className="player-btn" onClick={() => pick(p.id)}><span className="avatar">{p.name[0]}</span><span><b>{p.name}</b><small>{p.area?.name} · {p.interests.join(", ")}</small></span></button>
        ))}</div>
      </section>
    </div>
  );
}

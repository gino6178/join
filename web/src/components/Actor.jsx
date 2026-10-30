import { useEffect, useState } from "react";
import { api } from "../api.js";
import Icon from "./Icon.jsx";

// The town (venues, players), loaded once and shared
let cache = null, wait = null;
export function useWorld() {
  const [w, setW] = useState(cache);
  useEffect(() => { if (cache) return; wait ||= api("/api/world").then((x) => (cache = x)); wait.then(setW).catch(() => {}); }, []);
  return w;
}
export const firstName = (w, id) => w?.players.find((p) => p.id === id)?.name.split(" ")[0] || id;

// Who did it, as a chip: your agent (green, with the agent's name), someone else's agent, a person, the venue, PayPal,
// or Join itself.
export default function Actor({ actor, me }) {
  const w = useWorld();
  const mine = actor.player && actor.player === me;
  if (actor.kind === "agent") return <span className={`actor agent ${mine ? "mine" : ""}`}><Icon name="spark" size={14} />{mine ? "Your agent" : `${firstName(w, actor.player)}'s agent`}{actor.client && <small>{actor.client}</small>}</span>;
  if (actor.kind === "player") return <span className="actor person"><Icon name="you" size={14} />{mine ? "You" : firstName(w, actor.player)}</span>;
  if (actor.kind === "venue") return <span className="actor venue"><Icon name="store" size={14} />Venue</span>;
  if (actor.kind === "paypal") return <span className="actor paypal"><Icon name="card" size={14} />PayPal</span>;
  return <span className="actor platform"><Icon name="verify" size={14} />Join</span>;
}

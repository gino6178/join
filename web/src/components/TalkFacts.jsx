import { useEffect, useState } from "react";
import Icon from "./Icon.jsx";
import { agentHolds } from "../agent.js";
import "./webfeat.css";

// What a talk between agents says about itself, shown quietly next to its messages and on the card that asks for a
// yes (the gateway's talk_meta.js):
//   Calendars  private (your agent proposed from your own week; each member's agent checked its own calendar) or shared
//              (your agent listed only times that fit the club's calendars)
//   HoldClock  once the agents agree a time, each member's agent holds it for 30 minutes while you decide
//   CardsNote  the other agents' Agent Cards were signed and matched the address they answered at
const first = (n) => String(n || "").split(" ")[0];

export function Calendars({ mode, short = false }) {
  if (mode !== "private" && mode !== "shared") return null;
  const priv = mode === "private";
  return (
    <span className={`talk-mode ${mode}`} title={priv ? "Your agent proposed times from your own week, and each member's agent checked them against its own calendar. Nobody's week left their agent." : "Your agent listed only the times that fit the club's shared calendars."}>
      <Icon name={priv ? "lock" : "shared"} size={14} />{priv ? (short ? "Private calendars" : "Private calendars: each agent checked its own") : (short ? "Shared calendars" : "Shared calendars: only times that fit everyone's")}
    </span>
  );
}

const mmss = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
// the countdown on the time the members' agents hold; it asks the gateway once whether the hold is still there (a
// booking or a no releases it, and it lapses by itself)
export function HoldClock({ option, done = false }) {
  const until = option?.holdUntil, ref = option?.hold, ids = (option?.partners || []).map((p) => p.id);
  const [now, setNow] = useState(Date.now()), [live, setLive] = useState(null);
  useEffect(() => { if (!until || done) return; const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, [until, done]);
  useEffect(() => {
    if (!ref || !until || done) return;
    let off = false;
    agentHolds(ref, ids).then((r) => { if (!off) setLive(r.holds.length > 0); }).catch(() => {});
    return () => { off = true; };
  }, [ref, until, done]);
  if (!until || done) return null;
  const left = until - now, names = (option.partners || []).map((p) => first(p.name));
  const who = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}'s agents` : `${names[0] || "Their"}'s agent`;
  if (live === false || left <= 0) return <span className="hold-clock gone" role="status"><Icon name="clock" size={14} />{left <= 0 ? "The hold lapsed" : "No longer held"}: booking checks the time again</span>;
  return (
    <span className={`hold-clock ${left < 5 * 60000 ? "soon" : ""}`} title={`${who} hold${names.length > 1 ? "" : "s"} this time for you until ${new Date(until).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}, while you decide. Another talk can't take it meanwhile.`}>
      <Icon name="clock" size={14} /><span>Held for you</span><b className="mono" aria-label={`${Math.ceil(left / 60000)} minutes left`}>{mmss(left)}</b>
    </span>
  );
}

// the other agents' signed cards, as a small detail: checked, or which one did not check out
export function CardsNote({ cards, names = {} }) {
  if (!Array.isArray(cards) || !cards.length) return null;
  const bad = cards.filter((c) => !c.verified && !c.skipped), skipped = cards.filter((c) => c.skipped);
  const nm = (c) => names[c.member] || first(c.member);
  if (bad.length) return <span className="cards-note bad"><Icon name="warn" size={14} />{bad.map(nm).join(", ")}'s agent card did not check out</span>;
  if (skipped.length === cards.length) return <span className="cards-note"><Icon name="info" size={14} />Agent cards not checked on this server</span>;
  return (
    <span className="cards-note" title={`Each agent's card is signed (${cards[0].alg || "Ed25519"}) with the key published at its own address, and names that address for its messages.`}>
      <Icon name="verify" size={14} />{cards.length === 1 ? `${nm(cards[0])}'s agent card checked` : `${cards.length} agent cards checked`}
    </span>
  );
}

// the three together, in one quiet line
export default function TalkFacts({ mode, option, cards, names, done = false, className = "" }) {
  const c = cards ?? option?.cards, m = mode ?? option?.calendars;
  if (!m && !option?.holdUntil && !c?.length) return null;
  return (
    <p className={`talk-facts ${className}`}>
      <Calendars mode={m} short />
      <HoldClock option={option} done={done} />
      <CardsNote cards={c} names={names} />
    </p>
  );
}

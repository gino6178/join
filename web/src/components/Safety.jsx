import Icon from "./Icon.jsx";
import "./webfeat.css";

// The safety checks your agent made, in plain words (the gateway's safety.js, through /api/safety): when a message or
// an answer was checked, the verdict and what happened. The text itself is never kept or shown, not even yours.
const about = (c) => (c.about?.length ? c.about.join(" and ") : c.categories?.length ? "unsafe content" : "unsafe content");
export function sayCheck(c) {
  const unchecked = c.verdict === "not checked";
  if (c.on === "message") {
    if (c.action === "helpline") return { tone: "flagged", head: "Your message got the helpline reply, not an answer", note: c.byWords ? "Its words were read as being about self-harm, so your agent did not act on it." : "It was flagged as being about self-harm, so your agent did not act on it." };
    if (c.action === "refused") return { tone: "flagged", head: "Your agent did not act on a message", note: `It was flagged as ${about(c)}; your agent said it can't help with that.` };
    return unchecked ? { tone: "unchecked", head: "Your message went through unchecked", note: `${c.why || "The safety check did not answer"}; your agent went on with it.` } : { tone: "safe", head: "Checked your message: safe", note: "Your agent acted on it." };
  }
  if (c.on === "answer") {
    if (c.action === "replaced") return { tone: "flagged", head: "An answer was replaced before you saw it", note: `It read as ${about(c)}, so you got a safe reply instead.` };
    return unchecked ? { tone: "unchecked", head: "An answer was sent without a check", note: `${c.why || "The safety check did not answer"}.` } : { tone: "safe", head: "Checked an answer before it was sent: safe", note: "Sent as written." };
  }
  if (c.on === "reviews") {
    if (c.flagged) return { tone: "flagged", head: `Left out ${c.flagged} of ${c.count} court review${c.count > 1 ? "s" : ""}`, note: "They read as instructions to an agent, so your agent never read them." };
    return unchecked ? { tone: "unchecked", head: `${c.count} court review${c.count > 1 ? "s" : ""} not checked`, note: `${c.why || "The check did not answer"}; reviews are only ever read as facts.` } : { tone: "safe", head: `Checked ${c.count} court review${c.count > 1 ? "s" : ""} for hidden instructions`, note: "None found." };
  }
  if (c.on === "idea") {
    if (c.action === "refused") return { tone: "flagged", head: "An idea was kept from the club", note: c.flagged ? "It read as instructions to an agent." : `It was flagged as ${about(c)}.` };
    if (c.action === "held") return { tone: "unchecked", head: "An idea waits to be checked", note: "It goes to the club only once the safety check passes it." };
    return { tone: "safe", head: "Checked an idea before it went to the club: safe", note: "" };
  }
  return { tone: unchecked ? "unchecked" : c.verdict === "flagged" ? "flagged" : "safe", head: "A safety check", note: "" };
}
const when = (t) => new Date(t).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export default function SafetyList({ checks = [], limit = 8, empty = "No checks yet." }) {
  if (!checks.length) return <p className="tiny muted">{empty}</p>;
  return (
    <ul className="safety-list">
      {checks.slice(0, limit).map((c, i) => {
        const s = sayCheck(c);
        return (
          <li key={`${c.at}-${i}`} className={s.tone}>
            <Icon name={s.tone === "flagged" ? "warn" : s.tone === "unchecked" ? "info" : "verify"} size={18} />
            <span><b>{s.head}</b>{s.note && <> · {s.note}</>}</span>
            <time dateTime={new Date(c.at).toISOString()}>{when(c.at)}</time>
            <span className="tiny muted">{c.model}{c.seconds != null ? `, ${c.seconds} s` : ""}, on your own server</span>
          </li>
        );
      })}
    </ul>
  );
}

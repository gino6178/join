import Icon from "./Icon.jsx";
import { dismiss, plain, answerMoved } from "../tasks.js";
import Mark from "./Mark.jsx";
import TalkFacts from "./TalkFacts.jsx";

// One job the agent did or is doing: what was asked, where it stands, and the trail of steps behind it. A game the
// Match helper set up also shows the agents' last messages, and, when they moved the time, asks to book it.
const JOB = { play: "Play", ask: "Your agent", match: "Best match", talk: "Agent to agent", autopilot: "Autopilot", game: "Match · Talk" };
const who = (from, names) => (from === "you" ? "Your agent" : `${names?.[from] || from}'s agent`);
// the messages worth showing: the counters and noes, and your agent's last word, in the order they were said
const talkShown = (ms) => { const keep = new Set([...ms.filter((x) => ["counter", "decline"].includes(x.intent)).slice(-2), ms.filter((x) => x.from === "you").at(-1)]); const out = ms.filter((x) => keep.has(x)); return out.length > 1 ? out : ms.slice(-2); };
export function ago(t) {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 45 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
}
function action(t) {
  if (t.state === "failed") return null;
  if (t.kind === "play") return t.booking ? (t.booking.state === "confirmed" ? "See the game" : "Follow the answers") : t.state === "needs" ? `Review ${t.result?.options?.length ?? ""} options` : t.state === "running" ? "Watch" : "Open";
  if (t.kind === "talk") return t.state === "needs" ? "Book it" : "See the talk";
  if (t.kind === "autopilot") return t.state === "needs" ? "Review the plan" : t.state === "running" ? "Watch" : "See the run";
  return { match: "See the matches" }[t.kind] || "Open";
}

export default function TaskCard({ t, steps = 3 }) {
  const last = t.steps.at(-1), more = Math.max(0, t.steps.length - steps);
  const said = ["play", "ask"].includes(t.kind) && !t.flagged;
  return (
    <article className={`task ${t.state}`} aria-label={`${JOB[t.kind] || "Task"}: ${t.title}`}>
      <span className={`task-av ${t.state}`} aria-hidden="true"><Mark size={22} /></span>
      <div className="task-body">
        <header>
          <b>{JOB[t.kind] || "Agent"}</b>
          <span className={`task-state ${t.state}`}>{t.state === "running" ? "Working" : t.state === "needs" ? "Needs you" : t.state === "failed" ? "Couldn't finish" : "Done"}</span>
          <span className="tiny muted">{ago(t.finished || t.started)}</span>
          <button className="icon-btn sm task-x" aria-label="Dismiss" onClick={() => dismiss(t.id)}><Icon name="close" size={14} /></button>
        </header>
        {said ? <p className="task-said">“{t.title}”</p> : <p className="task-said plain">{t.title}</p>}
        {t.state === "running"
          ? <p className="task-now" role="status"><span className="dots" aria-hidden="true"><i /><i /><i /></span>{t.working || (last ? `${last.step}…` : "Starting…")}</p>
          : <p className={`task-sum ${t.state}`}>{t.state === "failed" ? t.error : plain(t.summary)}</p>}
        {t.steps.length > 0 && (
          <ol className="task-steps" aria-label="Steps">
            {more > 0 && <li className="more">+{more} earlier step{more > 1 ? "s" : ""}</li>}
            {t.steps.slice(-steps).map((s, k) => <li key={k} title={s.detail} className={s.tool === "safety" ? `safety ${s.check?.verdict === "flagged" || ["refused", "helpline", "replaced"].includes(s.check?.action) ? "flagged" : ""}` : undefined}>
              <Icon name={s.tool !== "safety" ? "check" : s.check?.verdict === "flagged" || ["refused", "helpline", "replaced"].includes(s.check?.action) ? "warn" : "verify"} size={14} />{s.step}</li>)}
          </ol>
        )}
        {t.kind === "game" && t.messages?.length > 0 && (
          <ul className="task-talk" aria-label="What the agents said">
            {talkShown(t.messages).map((x, k) => <li key={k}><b>{who(x.from, t.names)}:</b> {x.text}{x.tier === "quick" && <span className="tiny muted"> · quick pick, {Math.round(x.confidence * 100)}% sure</span>}</li>)}
          </ul>
        )}
        {["game", "talk"].includes(t.kind) && t.result && (() => {
          const r = t.result, o = r.moved || r.agreed || r.book, names = t.names || (r.with ? { [r.with.id]: r.with.name.split(" ")[0] } : {});
          return <TalkFacts mode={r.calendars || o?.calendars} option={t.state === "needs" ? o : null} cards={r.cards || o?.cards} names={names} />;
        })()}
        {t.kind === "game" && t.state === "needs" && (
          <div className="ask-actions">
            <button className="btn primary sm" onClick={() => answerMoved(t, "book")}>Book it</button>
            <button className="btn ghost sm" onClick={() => answerMoved(t, "drop")}>Drop it</button>
          </div>
        )}
        {action(t) && t.href && <a className={`btn sm ${t.state === "needs" ? "primary" : "ghost"}`} href={`#/${t.href}`}>{action(t)}<Icon name="next" size={16} /></a>}
      </div>
    </article>
  );
}

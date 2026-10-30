import { useEffect, useMemo, useState } from "react";
import Icon from "../components/Icon.jsx";
import { useTasks } from "../tasks.js";
import { readGame, patchGame } from "../club/game.js";
import { shareLinks, postToClub } from "../club/share.js";
import { week, challenge } from "../club/week.js";
import "./club.css";
import "./goals.css";

// Goals: this week, the social way. How many games you play against your own goal, the weeks in a row you have
// played, the club's challenge that every member's games count towards, and bringing someone new to the club. All of
// it is counted from the club and from the games your agent books; the Autopilot is how you reach the goal.
const DAY = { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday" };
const first = (n) => n.split(" ")[0];
const initials = (n) => n.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export default function Goals({ club }) {
  const tasks = useTasks();
  const [g, setG] = useState(readGame);
  const [msg, setMsg] = useState("");
  useEffect(() => { const on = () => setG(readGame()); addEventListener("shuttlecoach:game", on); return () => removeEventListener("shuttlecoach:game", on); }, []);
  // the same goal the Autopilot plans to (Autopilot page, "Your goal")
  const goal = g.autopilot?.goal?.perWeek || club?.you?.goal?.perWeek || 2;
  const setGoal = (n) => setG(patchGame((s) => ({ ...s, autopilot: { ...(s.autopilot || {}), goal: { ...(club?.you?.goal || {}), ...(s.autopilot?.goal || {}), perWeek: n } } })));
  const w = useMemo(() => (club ? week(club, { results: g.arena?.results || [], tasks, goal }) : null), [club, g, tasks, goal]);
  if (!club || !w) return <div className="page"><p className="muted">Opening your goals…</p></div>;
  const ch = challenge(club, w), byId = Object.fromEntries(club.members.map((m) => [m.id, m]));
  const people = Object.keys(w.partners).length, top = Math.max(goal + 1, ...w.weeks.map((x) => x.n));
  const slots = Array.from({ length: Math.max(goal, w.played + w.booked.length) }, (_, k) => (k < w.played ? "played" : k < w.played + w.booked.length ? "booked" : "open"));
  const invites = g.invites || [];
  const link = `${location.origin}${location.pathname}#/about`;
  const invite = `Come and play with us at ${club.name}. On Serve your agent finds the court and the people; you just turn up. ${link}`;
  const sent = (via) => {
    setG(patchGame((s) => ({ ...s, invites: [...(s.invites || []), { at: Date.now(), via }].slice(-50) })));
    if (!invites.length) postToClub({ kind: "recruit", text: "Invited a friend to the club." });
  };
  const copy = async () => { try { await navigator.clipboard.writeText(invite); sent("copy"); setMsg("Invite copied: paste it wherever your friend is."); } catch { setMsg("Could not copy; select the text instead."); } };

  return (
    <div className="page goals-page">
      <header className="report-head">
        <div>
          <span className="tag">This week</span>
          <h1 className="h1">Goals</h1>
          <p className="muted">Play more: your goal for the week, the weeks in a row you have played, and what the club is doing together.</p>
        </div>
        <div className="cta-row">
          <a className="btn primary" href="#/play"><Icon name="book" size={18} />Find a game</a>
          <a className="btn ghost" href="#/autopilot?run=1"><Icon name="spark" size={18} />Plan my week</a>
        </div>
      </header>

      <dl className="readout club-me gl-readout" aria-label="Your week">
        <div><dt>This week</dt><dd>{w.played + w.booked.length} of {goal}</dd><small>{w.played} played · {w.booked.length} booked</small></div>
        <div><dt>Streak</dt><dd>{plural(w.streak, "week")}</dd><small>in a row with a game</small></div>
        <div><dt>Goal met</dt><dd>{w.met} of 8</dd><small>of the last eight weeks</small></div>
        <div><dt>Played with</dt><dd>{plural(people, "person", "people")}</dd><small>in the last eight weeks</small></div>
      </dl>

      <div className="gl-grid">
        <div className="gl-main">
          <section className="panel" aria-labelledby="wk-h">
            <header className="club-h">
              <h2 id="wk-h" className="panel-h">Your week</h2>
              <div className="seg sm" role="radiogroup" aria-label="Games a week">
                {[1, 2, 3, 4].map((n) => <button key={n} role="radio" aria-checked={goal === n} onClick={() => setGoal(n)}>{n} a week</button>)}
              </div>
            </header>
            <ol className="gl-slots" aria-label={`${w.played} played and ${w.booked.length} booked of ${goal}`}>
              {slots.map((s, k) => <li key={k} className={s}><span className="gl-dot" aria-hidden="true">{s === "played" ? <Icon name="check" size={16} /> : s === "booked" ? <Icon name="book" size={14} /> : null}</span><span className="tiny">{s === "played" ? "Played" : s === "booked" ? "Booked" : "Open"}</span></li>)}
            </ol>
            {w.booked.length > 0 && (
              <ul className="gl-games">
                {w.booked.map((o) => (
                  <li key={o.id}><a href={`#/${o.href || "club?tab=challenges"}`}>
                    <b>{DAY[o.day] || o.day} {o.start}</b>
                    <span className="tiny muted">{o.format} · {o.venue?.name}{o.partners?.length ? ` · with ${o.partners.map((p) => first(p.name)).join(", ")}` : ""}</span>
                    <span className={`task-state ${o.state === "confirmed" ? "done" : "running"}`}>{o.state === "confirmed" ? "Game on" : "Waiting for answers"}</span>
                  </a></li>
                ))}
              </ul>
            )}
            <p className="gl-left">{w.left ? <>{plural(w.left, "game")} to go this week. Your agent can line {w.left === 1 ? "it" : "them"} up with the people you play best with.</> : <>Goal reached this week. Anything more is a bonus.</>}</p>
            {w.left > 0 && <div className="cta-row gl-cta"><a className="btn primary sm" href="#/autopilot?run=1"><Icon name="spark" size={16} />Line up {w.left === 1 ? "a game" : `${w.left} games`}</a><a className="btn ghost sm" href="#/club?tab=challenges&spin=1">Draw a random match</a></div>}
          </section>

          <section className="panel" aria-labelledby="hist-h">
            <h2 id="hist-h" className="panel-h">The last eight weeks</h2>
            <ol className="gl-bars" style={{ "--goal": goal / top }} aria-label="Games a week">
              {w.weeks.map((x, k) => (
                <li key={k} className={`${x.n >= goal ? "met" : ""} ${k === 8 ? "now" : ""}`} aria-label={`${k === 8 ? "This week" : `Week of ${x.start.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`}: ${plural(x.n, "game")}`}>
                  <span className="gl-bar"><i style={{ transform: `scaleY(${x.n / top})` }} /></span>
                  <b className="mono">{x.n}</b>
                  <span className="tiny muted">{k === 8 ? "now" : x.start.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span>
                </li>
              ))}
            </ol>
            <p className="tiny muted">The line is your goal, {plural(goal, "game")} a week. A week with at least one game keeps the streak going.</p>
          </section>
        </div>

        <aside className="gl-side">
          {ch && (
            <section className="panel" aria-labelledby="ch-h">
              <header className="club-h"><h2 id="ch-h" className="panel-h">Club challenge</h2><span className="tiny muted">{plural(ch.weeks, "week")}</span></header>
              <p className="gl-ch-title">{ch.title}</p>
              <p className="tiny muted">{ch.text}</p>
              <span className="gl-meter" role="meter" aria-valuemin={0} aria-valuemax={ch.target} aria-valuenow={ch.total} aria-label="Club games so far"><i style={{ transform: `scaleX(${Math.min(1, ch.total / ch.target)})` }} /><em style={{ transform: `scaleX(${Math.min(1, ch.yours / ch.target)})` }} /></span>
              <p className="small"><b className="mono">{ch.total}</b> of {ch.target} games{ch.done ? ": done, together" : `, ${ch.target - ch.total} to go`} · <span className="gl-you">{plural(ch.yours, "game")} yours</span></p>
              <ol className="gl-rows">
                {ch.rows.slice(0, 5).map((r, i) => (
                  <li key={r.id} className={r.id === "you" ? "me" : ""}>
                    <span className="mono rk">{i + 1}</span>
                    <span className={`mav ${r.id === "you" ? "you" : ""}`} style={{ width: 28, height: 28 }} aria-hidden="true">{r.id === "you" ? "You" : initials(r.name)}</span>
                    <span>{r.id === "you" ? "You" : r.name}</span><b className="mono">{r.games}</b>
                  </li>
                ))}
              </ol>
            </section>
          )}

          <section className="panel" aria-labelledby="new-h">
            <h2 id="new-h" className="panel-h">Bring someone new</h2>
            <p className="tiny muted">A friend who would play if someone else did the organizing? Send them the club. Their first game counts for the challenge.</p>
            <div className="gl-share">
              <a className="chip" href={shareLinks(invite).whatsapp} target="_blank" rel="noopener noreferrer" onClick={() => sent("whatsapp")}><Icon name="share" size={14} />WhatsApp</a>
              <a className="chip" href={shareLinks(invite).threads} target="_blank" rel="noopener noreferrer" onClick={() => sent("threads")}><Icon name="share" size={14} />Threads</a>
              <button className="chip" onClick={copy}><Icon name="share" size={14} />Copy the invite</button>
            </div>
            {msg && <p className="tiny muted" role="status">{msg}</p>}
            <p className="small">{invites.length ? `${plural(invites.length, "invite")} sent from here.` : "No invites sent yet."}</p>
            {club.recruits?.length > 0 && (
              <ul className="gl-recruits">
                {club.recruits.map((r) => byId[r.who] && byId[r.by] && <li key={r.who}><span className="mav" style={{ width: 28, height: 28 }} aria-hidden="true">{initials(byId[r.who].name)}</span><span><b>{first(byId[r.by].name)}</b> brought <b>{first(byId[r.who].name)}</b><span className="tiny muted"> · {r.ago} ago</span></span></li>)}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}

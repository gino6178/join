import { useEffect, useMemo, useRef, useState } from "react";
import Icon from "../components/Icon.jsx";
import Mark from "../components/Mark.jsx";
import TaskCard from "../components/TaskCard.jsx";
import { habits } from "../club/habits.js";
import { useTasks, plain, startPlay, startAsk, intentOf, playerOf, dismiss } from "../tasks.js";
import { useGameAsk, soreNow, bodyLine, input } from "../club/ask.js";
import { seedBody, useBody } from "../club/body.js";
import { readGame } from "../club/game.js";
import { week } from "../club/week.js";
import { useReducedMotion } from "../hooks.js";
import { go } from "../App.jsx";
import { agentSafety } from "../agent.js";
import SafetyList from "../components/Safety.jsx";
import VoiceAsk from "../voice/VoiceAsk.jsx";
import "./agent.css";

// The agent home, the way Muse is laid out: say what you want, and every job the agent takes on shows up as a card
// with its steps, running in the background and checking back when it needs you. Above it, stories from the club.
// Your agent has three helpers, each with what it is on right now: Body keeps the body log, Match watches your usual
// times and asks "want a game?" (its question is the first card that needs you), Talk agrees games with the other
// players' agents.
const initials = (n) => n.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
const first = (n) => n.split(" ")[0];
const hello = () => { const h = new Date().getHours(); return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"; };

// the safety checks your agent made here (your questions, its answers and sentences, court reviews): read again when
// a job finishes. Only the verdict and what happened are kept, never the words.
function SafetySide({ tasks }) {
  const [checks, setChecks] = useState(null);
  const done = tasks.filter((t) => t.state !== "running").length;
  useEffect(() => { agentSafety("app", 4).then((r) => setChecks(r.checks)).catch(() => setChecks(null)); }, [done]);
  if (!checks) return null;
  return (
    <section className="panel side-card safety-side" aria-labelledby="sf-h">
      <h2 id="sf-h" className="panel-h">Safety checks</h2>
      <SafetyList checks={checks} limit={3} empty="Nothing checked yet. Your questions and your agent's answers go past Llama Guard 3 on your server." />
    </section>
  );
}

function Story({ items, at, onClose, onMove }) {
  const still = useReducedMotion(), it = items[at], box = useRef(null);
  useEffect(() => {
    box.current?.focus();
    const k = (e) => { if (e.key === "Escape") onClose(); if (e.key === "ArrowRight") onMove(1); if (e.key === "ArrowLeft") onMove(-1); };
    addEventListener("keydown", k); return () => removeEventListener("keydown", k);
  }, [at]);
  useEffect(() => { if (still) return; const id = setTimeout(() => onMove(1), 6000); return () => clearTimeout(id); }, [at, still]);
  if (!it) return null;
  return (
    <div className="story-scrim" onClick={onClose}>
      <div ref={box} tabIndex={-1} className="story dark-scope" role="dialog" aria-modal="true" aria-label={`${it.name}'s story`} onClick={(e) => e.stopPropagation()} style={{ "--cc": it.color }}>
        <div className="story-bars" aria-hidden="true">{items.map((x, k) => <i key={x.id} className={k < at ? "done" : k === at ? (still ? "done" : "now") : ""} />)}</div>
        <header>
          <span className="mav story-mav" aria-hidden="true">{initials(it.name)}</span>
          <span><b>{it.name}</b><span className="tiny">{it.sub}</span></span>
          <button className="icon-btn sm" aria-label="Close" onClick={onClose}><Icon name="close" size={16} /></button>
        </header>
        <p className="story-text">{it.text}</p>
        <div className="story-actions">{it.actions}</div>
        <button className="story-nav prev" aria-label="Previous story" onClick={() => onMove(-1)} />
        <button className="story-nav next" aria-label="Next story" onClick={() => onMove(1)} />
      </div>
    </div>
  );
}

export default function Agent({ club }) {
  const tasks = useTasks();
  const [text, setText] = useState("");
  const [story, setStory] = useState(null);
  const [seen, setSeen] = useState(() => { try { return JSON.parse(localStorage.getItem("shuttlecoach.stories.v1")) || []; } catch { return []; } });
  const field = useRef(null);
  useEffect(() => { if (club) seedBody(club); }, [club]);
  const game = useGameAsk(club), body = useBody();
  useEffect(() => { try { localStorage.setItem("shuttlecoach.stories.v1", JSON.stringify(seen)); } catch { /* ignore */ } }, [seen]);
  const you = useMemo(() => (club ? playerOf(club) : null), [club]);

  function ask(said) {
    const q = (said ?? text).trim();
    if (!q || !you) return;
    setText("");
    const kind = intentOf(q);
    if (kind === "play") return go(`play?task=${startPlay(q, you)}`);
    if (kind === "goals") return go("goals");
    if (kind === "highlight") return go("highlights");
    if (kind === "autopilot") return go("autopilot?run=1");
    if (kind === "body") return go(`body?say=${encodeURIComponent(q)}`);
    if (kind === "courts") return go(`courts?sport=${(q.match(/basketball|badminton|tennis|soccer|football|volleyball|pickleball|table tennis/i) || ["basketball"])[0].toLowerCase().replace("football", "soccer")}`);
    if (kind === "best") return go(`club?tab=challenges&best=1${/doubles|partner/i.test(q) ? "&fmt=doubles" : ""}`);
    if (kind === "random") return go(`club?tab=challenges&spin=1${/doubles/i.test(q) ? "&fmt=doubles" : ""}${/weekend/i.test(q) ? "&when=weekend" : /weekday|evening/i.test(q) ? "&when=weekday" : ""}`);
    if (kind === "ranks") return go("club?tab=ranks");
    // anything else is for your agent: it answers on Muse Glimmer from your games, bookings and body log
    startAsk(q, input(club));
  }

  const needs = tasks.filter((t) => t.state === "needs"), running = tasks.filter((t) => t.state === "running"), done = tasks.filter((t) => ["done", "failed"].includes(t.state)).slice(0, 6);
  const next = tasks.find((t) => ["play", "game"].includes(t.kind) && t.booking && t.booking.state !== "cancelled");
  const g = readGame(), goal = g.autopilot?.goal?.perWeek || club?.you?.goal?.perWeek || 2;
  const w = club ? week(club, { results: g.arena?.results || [], tasks, goal }) : null;
  // challenges members sent you, not answered yet (Club, Challenges tab)
  const asked = (club?.incoming || []).filter((c) => !g.arena?.answered?.[c.id]).map((c) => ({ ...c, m: club.members.find((x) => x.id === c.from) })).filter((c) => c.m);

  // stories: members who posted in the club
  const stories = !club ? [] : [
    ...club.feed.slice(0, 4).map((f) => { const mm = club.members.find((x) => x.id === f.who); return mm && { id: f.id, name: mm.name, sub: `${f.ago} · ${club.name}`, color: "var(--agent)", text: f.text,
      actions: <><button className="btn primary sm" onClick={() => { setStory(null); go(`play?task=${startPlay(`Doubles this week with ${first(mm.name)}`, you)}`); }}>Play with {first(mm.name)}</button><a className="btn ghost sm" href="#/club">See the club</a></> }; }).filter(Boolean),
  ];
  const open = (k) => { setStory(k); setSeen((s) => [...new Set([...s, stories[k].id])]); };
  const move = (d) => { const k = story + d; if (k < 0 || k >= stories.length) return setStory(null); open(k); };

  return (
    <div className="page agent">
      <div className="agent-grid">
        <div className="agent-main">
          {stories.length > 0 && (
            <ul className="stories" aria-label="Stories">
              {stories.map((s, k) => (
                <li key={s.id}>
                  <button className={`story-ring ${seen.includes(s.id) ? "seen" : ""}`} style={{ "--cc": s.color }} onClick={() => open(k)} aria-label={`${s.name}'s story`}>
                    <span className="mav" style={{ width: 58, height: 58, fontSize: 16 }} aria-hidden="true">{initials(s.name)}</span>
                  </button>
                  <span>{first(s.name)}</span>
                </li>
              ))}
            </ul>
          )}

          <section className="composer" aria-labelledby="ask-h">
            <div className="composer-head"><span className="agent-face" aria-hidden="true"><Mark size={22} /></span>
              <div><h1 id="ask-h" className="h1">{hello()}. What do you want to do?</h1>
                <p className="muted">Say when or who you'd like to play. Your agent finds the court and the people, agrees the time with their agents and books it when you say yes.</p></div></div>
            <form className="composer-box" onSubmit={(e) => { e.preventDefault(); ask(); }}>
              <label htmlFor="agent-q" className="sr-only">Tell your agent</label>
              <textarea id="agent-q" ref={field} rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="Doubles on Thursday evening"
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(); } }} />
              <VoiceAsk field={field} onText={(words) => setText((t) => (t.trim() ? `${t.trim()} ${words}` : words))} />
              <button className="send" aria-label="Send to your agent" disabled={!text.trim() || !you}><Icon name="up" size={20} /></button>
            </form>
          </section>

          {club && (() => {
            const h = habits(club.you.history || []).slice(0, 2), sore = soreNow(body.log || club.you.body || []);
            const talk = tasks.find((t) => t.messages?.length && t.state !== "running"), ap = tasks.find((x) => x.kind === "autopilot");
            const mates = (t) => [...new Set(t.messages.map((x) => x.from).filter((f) => f !== "you"))].map((id) => first(club.members.find((mm) => mm.id === id)?.name || id));
            const up = (t) => t.replace(/^./, (c) => c.toUpperCase());
            const rows = [
              { k: "body", ic: "heart", name: "Body", role: "Keeps your body log and checks in on what hurts",
                now: bodyLine(sore),
                go: ["Body log", "#/body"] },
              { k: "match", ic: "spark", name: "Match", role: "Watches your usual times and asks if you want a game",
                now: game.ask ? `Asking you about ${game.ask.opening.day} ${game.ask.opening.start}, below.` : next ? `Next game: ${next.booking.option.day} ${next.booking.option.start} at ${next.booking.option.venue.name}.` : game.none ? `${up(game.none)}.` : `You usually play ${h.map((x) => `${x.day} ${x.start}`).join(" and ")}.`,
                go: [ap?.state === "running" ? "Watch it plan" : "Plan my week", ap?.state === "running" ? "#/autopilot" : "#/autopilot?run=1"] },
              { k: "talk", ic: "chat", name: "Talk", role: "Takes your yes to the other players' agents",
                now: talk ? (() => {
                  const ms = mates(talk), rounds = Math.max(1, ...talk.messages.map((x) => x.round || 1));
                  const end = talk.state === "needs" && talk.kind === "game" ? "they asked for another time; it waits for you below" : talk.booking ? (talk.booking.state === "confirmed" ? "game on" : "booked, waiting for answers") : plain(talk.summary || "").replace(/\.$/, "");
                  return `Last: ${ms.join(", ").replace(/, ([^,]+)$/, " and $1")}'s agent${ms.length > 1 ? "s" : ""}, ${rounds} round${rounds > 1 ? "s" : ""}: ${end}.`;
                })() : "Nothing to agree yet. It starts when you say yes.",
                go: ["Challenges", "#/club?tab=challenges"] },
            ];
            return (
              <section className="helpers" aria-labelledby="helpers-h">
                <h2 id="helpers-h" className="sec-label">Your agent's helpers</h2>
                <ul>
                  {rows.map((r) => (
                    <li key={r.k} className={`helper ${r.k}`}>
                      <span className="helper-ic" aria-hidden="true"><Icon name={r.ic} size={20} /></span>
                      <span className="helper-txt"><b>{r.name}</b><span className="helper-role">{r.role}</span><span className="helper-now">{r.now}</span></span>
                      <a className="btn ghost sm" href={r.go[1]}>{r.go[0]}</a>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })()}

          {(needs.length > 0 || asked.length > 0 || game.ask) && (
            <section className="task-sec" aria-labelledby="needs-h">
              <h2 id="needs-h" className="sec-label">Needs you</h2>
              {game.ask && (
                <article className="task needs ask-card" aria-label="Match: want a game?">
                  <span className="task-av helper-ic" aria-hidden="true"><Icon name="spark" size={22} /></span>
                  <div className="task-body">
                    <header><b>Match</b><span className="task-state needs">Asks you</span>{game.ask.by === "model" && <span className="tiny muted">worded by Muse Glimmer, checked</span>}</header>
                    <p className="task-said plain">{game.ask.text}</p>
                    <p className="ask-meta">
                      <span className="mavs">{game.ask.opening.partners.map((p) => <span key={p.id} className="mav" aria-hidden="true">{initials(p.name)}</span>)}</span>
                      <span>{game.ask.opening.venue.name}, court {game.ask.opening.court}{game.ask.opening.trip != null ? ` · ${game.ask.opening.trip} min for you` : ""}</span>
                    </p>
                    <div className="ask-actions">
                      <button className="btn primary sm" disabled={!!game.busy} onClick={() => game.answer("yes")}>Yes, set it up</button>
                      <button className="btn ghost sm" disabled={!!game.busy} onClick={() => game.answer("other")}>{game.busy === "other" ? "Looking…" : "Another time"}</button>
                      <button className="link" disabled={!!game.busy} onClick={() => game.answer("week")}>Not this week</button>
                    </div>
                  </div>
                </article>
              )}
              {needs.map((t) => <TaskCard key={t.id} t={t} />)}
              {asked.length > 0 && (
                <article className="task needs" aria-label="Challenges for you">
                  <span className="task-av" aria-hidden="true"><Icon name="club" size={22} /></span>
                  <div className="task-body">
                    <header><b>{club.name}</b><span className="task-state needs">Needs you</span></header>
                    <p className="task-said plain">{asked.map((c) => first(c.m.name)).join(" and ")} challenged you</p>
                    <p className="task-sum">{first(asked[0].m.name)}: “{asked[0].note}”</p>
                    <a className="btn sm primary" href="#/club?tab=challenges">Answer<Icon name="next" size={16} /></a>
                  </div>
                </article>
              )}
            </section>
          )}
          {running.length > 0 && <section className="task-sec" aria-labelledby="run-h"><h2 id="run-h" className="sec-label">Working on it</h2>{running.map((t) => <TaskCard key={t.id} t={t} steps={4} />)}</section>}
          {done.length > 0 && (
            <section className="task-sec" aria-labelledby="done-h">
              <h2 id="done-h" className="sec-label">Done<button className="link" onClick={() => done.forEach((t) => dismiss(t.id))}>Clear</button></h2>
              {done.map((t) => <TaskCard key={t.id} t={t} steps={2} />)}
            </section>
          )}
          {!tasks.length && (
            <div className="agent-empty">
              <span className="agent-face lg" aria-hidden="true"><Mark size={30} /></span>
              <p><b>Nothing running yet.</b> Tell your agent when you'd like to play. It works in the background, shows each step it takes, and checks back when it needs you.</p>
            </div>
          )}
        </div>

        <aside className="agent-side" aria-label="Your week">
          <section className="panel side-card">
            <h2 className="panel-h">Up next</h2>
            {next ? (
              <a className="next-game" href={`#/${next.href || "club?tab=challenges"}`}>
                <span className="big">{next.booking.option.day} {next.booking.option.start}</span>
                <span>{next.booking.option.format} · {next.booking.option.venue.name}, court {next.booking.option.court}</span>
                <span className="mavs">{next.booking.invites.filter((i) => i.status !== "out").map((i) => <span key={i.id} className="mav" aria-hidden="true">{initials(i.name)}</span>)}</span>
                <span className={`task-state ${next.booking.state === "confirmed" ? "done" : "running"}`}>{next.booking.state === "confirmed" ? "Game on" : "Waiting for answers"}</span>
              </a>
            ) : <><p className="muted small">No game booked.</p><a className="btn primary sm" href="#/play">Find a game</a></>}
          </section>
          <section className="panel side-card">
            <h2 className="panel-h">This week</h2>
            <dl className="mini-stats">
              <div><dt>Games</dt><dd>{w ? `${w.played + w.booked.length} of ${goal}` : "…"}</dd></div>
              <div><dt>Streak</dt><dd>{w ? `${w.streak} week${w.streak === 1 ? "" : "s"}` : "…"}</dd></div>
            </dl>
            <a className="btn ghost sm" href="#/goals">Open goals</a>
          </section>
          <SafetySide tasks={tasks} />
          <p className="tiny muted side-foot"><span className="agent-dot" aria-hidden="true" />Muse Glimmer on your own server. Your videos, your body log and your memory never leave it.</p>
        </aside>
      </div>
      {story != null && <Story items={stories} at={story} onClose={() => setStory(null)} onMove={move} />}
    </div>
  );
}

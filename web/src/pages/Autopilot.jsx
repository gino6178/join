import { useEffect, useMemo, useRef, useState } from "react";
import Icon from "../components/Icon.jsx";
import Mark from "../components/Mark.jsx";
import { useTasks, startAutopilot, approveAutopilot, autopilotInput, playerOf } from "../tasks.js";
import { readGame, patchGame } from "../club/game.js";
import { habits, chemistry } from "../club/habits.js";
import { bodyInput, seedBody } from "../club/body.js";
import TraceView from "../components/TraceView.jsx";
import TalkFacts, { Calendars } from "../components/TalkFacts.jsx";
import "./autopilot.css";

// Autopilot: your agent keeps you playing. It learns when you usually play and who you play best with (games that run
// past the booking), and against your weekly goal it runs the week by itself on Muse Glimmer: it checks what is booked,
// picks your usual times that are still open, ranks partners, negotiates with their agents (all three at once for
// doubles), re-plans when someone counters or declines, and asks you once before anything is booked. Every step shows
// which tool ran, who decided (the model or, if it stalled, the rules), and why.
const initials = (n) => n.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
const first = (n) => n.split(" ")[0];
const DAY = { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday" };
const TOOL = { goal: "goal", get_week: "check week", check_body: "body log", find_places: "courts nearby", find_partners: "rank partners", negotiate: "negotiate", a2a: "agents", memory: "memory", recall: "recall", verify: "verified", request_approval: "ask you", align: "goal check", nudge: "nudge", fallback: "rules", report: "report" };
const SPORTS = ["badminton", "tennis", "pickleball", "basketball", "soccer"];

function Av({ m, size = 30 }) { return <span className="mav" style={{ width: size, height: size, fontSize: Math.round(size / 2.8) }} aria-hidden="true">{m ? initials(m.name) : "?"}</span>; }

export default function Autopilot({ data }) {
  const tasks = useTasks();
  const [club, setClub] = useState(null);
  useEffect(() => { fetch("/data/club.json").then((r) => r.json()).then((c) => { seedBody(c); setClub(c); }).catch(() => {}); }, []);
  const you = useMemo(() => (data ? playerOf(data) : null), [data]);
  const [goal, setGoal] = useState(() => ({ perWeek: 2, sport: "badminton", approval: "ask", maxTrip: 30, ...(readGame().autopilot?.goal || {}) }));
  const setG = (patch) => { const g = { ...goal, ...patch }; setGoal(g); patchGame((s) => ({ ...s, autopilot: { ...(s.autopilot || {}), goal: g } })); };
  const t = tasks.find((x) => x.kind === "autopilot");
  const byId = useMemo(() => Object.fromEntries((club?.members || []).map((m) => [m.id, m])), [club]);

  const input = autopilotInput();
  const hist = [...(club?.you?.history || []), ...input.history];
  const hab = habits(hist).slice(0, 3), chem = chemistry(hist).slice(0, 3);
  // the body log and the health app go along: the agent plans around what hurts and how heavy the week has been
  const runNow = () => you && club && startAutopilot({ you: { limit: you.limit }, goal, upcoming: input.upcoming, history: input.history, body: (({ log, workouts, days }) => ({ log, workouts: workouts.map(({ route, ...w }) => w), days }))(bodyInput(club, input.history)) });
  const asked = useRef(false);
  useEffect(() => { if (!asked.current && you && club && /[?&]run=1/.test(location.hash)) { asked.current = true; runNow(); } }, [you, club]); // asked for from the agent home
  // "book within my limits": the agents' agreement is the yes, so the games are booked as soon as the run ends
  const autoed = useRef(null);
  // (never a draft: the goal check held that plan back, so it waits for the player's own look)
  useEffect(() => { if (t?.state === "needs" && goal.approval === "auto" && !t.result?.approval?.draft && autoed.current !== t.id) { autoed.current = t.id; approveAutopilot(t, "all"); } }, [t?.state]);

  const r = t?.result, games = r?.agreed || [], draft = !!r?.approval?.draft;
  const threads = useMemo(() => { const g = {}; (t?.messages || []).forEach((m) => (g[m.game ?? 0] ||= []).push(m)); return Object.entries(g); }, [t?.messages]);
  // the calendars the run's talks used: said by the trail while it runs, by the result once it is done
  const mode = r?.calendars || (t?.steps?.some((s) => s.calendars === "private") ? "private" : null);

  return (
    <div className="page autopilot">
      <header className="report-head">
        <div>
          <span className="tag">Autopilot · Muse Glimmer on your own GPU</span>
          <h1 className="h1">Your agent keeps you playing</h1>
          <p className="muted">It learns when you usually play and who you play best with, then lines up the week and agrees every game with the other players' agents. You only say yes.</p>
        </div>
        <div className="cta-row">
          <button className="btn primary" onClick={runNow} disabled={!you || t?.state === "running"}><Icon name="spark" size={18} />{t?.state === "running" ? "Running…" : "Run my week now"}</button>
        </div>
      </header>

      <div className="ap-top">
        <section className="panel" aria-labelledby="goal-h">
          <h2 id="goal-h" className="panel-h">Your goal</h2>
          <div className="ap-goal">
            <label>Games a week<div className="seg sm" role="radiogroup" aria-label="Games a week">{[1, 2, 3, 4].map((n) => <button key={n} role="radio" aria-checked={goal.perWeek === n} onClick={() => setG({ perWeek: n })}>{n}</button>)}</div></label>
            <label>Sport<div className="seg sm" role="radiogroup" aria-label="Sport">{SPORTS.map((s) => <button key={s} role="radio" aria-checked={goal.sport === s} onClick={() => setG({ sport: s })}>{s[0].toUpperCase() + s.slice(1)}</button>)}</div></label>
            <label>Before booking<div className="seg sm" role="radiogroup" aria-label="Before booking">{[["ask", "Ask me first"], ["auto", "Book within my limits"]].map(([k, l]) => <button key={k} role="radio" aria-checked={goal.approval === k} onClick={() => setG({ approval: k })}>{l}</button>)}</div></label>
          </div>
          <p className="tiny muted">{goal.approval === "auto" ? `It books on its own when every agent agrees, trips stay under ${goal.maxTrip} min and it is one of your usual times. You can cancel any game.` : "It agrees the games with the other agents, then waits for your yes. Nothing is booked before that."} On Monday mornings it runs by itself for players who switched it on in Messenger (/autopilot).</p>
        </section>

        <section className="panel" aria-labelledby="learn-h">
          <h2 id="learn-h" className="panel-h">What it learned</h2>
          <p className="tiny muted">From your last {hist.length} games{input.history.length ? `, ${input.history.length} reported here` : ""}.</p>
          <ul className="ap-habits">
            {hab.map((h) => <li key={h.day + h.start}><b>{DAY[h.day]} {h.start}</b><span className="ap-bar" aria-hidden="true"><i style={{ transform: `scaleX(${h.count / h.weeks})` }} /></span><span className="tiny muted">{h.count} of the last {h.weeks} weeks · usually {h.minutes} min{h.sport !== "badminton" ? ` · ${h.sport}` : ""}</span></li>)}
          </ul>
          <ul className="ap-chem">
            {chem.map((c) => { const m = byId[c.id]; return m && <li key={c.id}><Av m={m} /><span><b>{m.name}</b><span className="tiny muted">{c.ext > 0 ? `your games ran ${c.ext}% past the booking` : "games end on time"} · {c.n} game{c.n > 1 ? "s" : ""}</span></span>{c.ext >= 15 && <span className="badge">You click</span>}</li>; })}
          </ul>
          <p className="tiny muted">A game that runs past its booking means you two kept playing: those partners come first. Report a result with how long you played and it learns from that too.</p>
        </section>
      </div>

      {!t && <section className="panel ap-empty"><Mark size={28} /><p>Run your week and watch the agent plan it: every step, every choice and why, and the agents agreeing the times. About two minutes on Muse Glimmer.</p></section>}

      {t && (
        <section className="panel ap-run" aria-labelledby="run-h" aria-live="polite">
          <header className="club-h">
            <h2 id="run-h" className="panel-h">{t.state === "running" ? "Running your week" : "The last run"}</h2>
            {r?.report && <span className="tiny muted mono">{r.report.seconds} s · {r.report.toolCalls} tool calls · {r.report.modelCalls} Muse Glimmer calls, up to {r.report.parallelPeak} at once{r.report.rules ? " · rules finished" : ""}</span>}
          </header>
          <div className="ap-grid">
            <ol className="ap-steps">
              {t.steps.map((s, i) => (
                <li key={i} className={`${s.error ? "refused" : ""} t-${s.tool || "step"}`}>
                  <span className="ap-tool">{TOOL[s.tool] || s.tool}</span>
                  <div><b>{s.step}</b>{s.by === "model" && <span className="ap-by">Muse Glimmer decided</span>}{s.by === "rules" && <span className="ap-by rules">rules</span>}{s.by === "code" && <span className="ap-by rules">run by code, every week starts here</span>}
                    {s.detail && <p className="tiny">{s.detail}</p>}
                    {s.reason && <p className="ap-why">“{s.reason}”</p>}</div>
                </li>
              ))}
              {t.state === "running" && <li className="ap-now"><span className="dots" aria-hidden="true"><i /><i /><i /></span>{t.working || "Working…"}</li>}
              {t.state === "failed" && <li className="refused"><b>Could not finish</b><p className="tiny">{t.error}</p></li>}
            </ol>
            <div className="ap-side">
              {threads.map(([g, ms]) => {
                const who = [...new Set(ms.filter((m) => m.from !== "you").map((m) => m.from))].map((id) => byId[id]).filter(Boolean);
                return (
                  <div key={g} className="a2a ap-thread">
                    <p className="a2a-h"><Icon name="chat" size={16} /><b>Your agent</b> and {who.map((m) => `${first(m.name)}'s`).join(", ")} agent{who.length > 1 ? "s" : ""}{who.length > 1 && <span className="tiny muted">answered at the same time</span>}</p>
                    {mode && <p className="talk-facts"><Calendars mode={mode} /></p>}
                    <ol className="a2a-thread">
                      {ms.map((x, i) => (
                        <li key={i} className={x.from === "you" ? "mine" : "theirs"}>
                          <span className="a2a-who">{x.from === "you" ? <><Mark size={14} />Your agent{x.round > 1 ? ` · round ${x.round}` : ""}</> : <><Av m={byId[x.from]} size={20} />{first(byId[x.from]?.name || x.from)}'s agent</>}</span>
                          <p>{x.text}</p>
                          <span className={`a2a-intent ${x.intent}`}>{{ propose: "Proposes", counter: "Counter-offer", accept: "Agrees", decline: "Declines", none: "No answer" }[x.intent]}{x.intent !== "accept" && x.when ? ` · ${x.when}` : ""}{x.checked === false ? " · ✗ does not fit" : x.intent === "counter" && x.checked ? " · ✓ fits everyone" : ""}{x.tier === "quick" ? ` · quick pick, ${Math.round(x.confidence * 100)}% sure` : x.tier === "agent" ? " · full agent" : ""}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                );
              })}
            </div>
          </div>

          {r?.leftOut?.length > 0 && (
            <div className="ap-leftout" aria-labelledby="lo-h">
              <h3 id="lo-h" className="panel-h"><Icon name="memory" size={18} />Left out because of what you told your agent</h3>
              <ul>
                {r.leftOut.map((x) => (
                  <li key={x.id}><Av m={byId[x.id] || { name: x.name }} size={26} />
                    <span><b>{first(x.name)}</b>{x.because ? <> · you said “{x.because}”{x.said ? <span className="tiny muted"> ({new Date(x.said).toLocaleDateString("en-GB", { day: "numeric", month: "short" })})</span> : null}</> : " · you asked your agent to leave them out"}</span></li>
                ))}
              </ul>
              <p className="tiny muted">Your agent found it among what you told it, by meaning, before it ranked partners. Change it on <a href="#/memory">Your memory</a>.</p>
            </div>
          )}

          {r?.report?.trace && (
            <details className="ap-trace">
              <summary>How it ran: the OpenTelemetry trace of this run</summary>
              <TraceView id={r.report.trace} />
            </details>
          )}

          {games.length > 0 && (
            <div className={`ap-approve ${t.state}`}>
              <h3 className="panel-h">{t.state === "needs" ? `${draft ? "Draft: " : ""}${games.length} game${games.length > 1 ? "s" : ""} agreed by every agent` : t.answered === "none" ? "Not this week" : "Booked"}</h3>
              {t.state === "needs" && draft && <p className="tiny">{r.summary}</p>}
              <ul>
                {games.map((o) => (
                  <li key={o.id}>
                    <span className="ap-when"><b>{DAY[o.day]}</b>{o.start}</span>
                    <span><b>{o.format === "doubles" ? "Doubles" : "Singles"} at {o.venue.name}, court {o.court}</b><span className="tiny muted">with {o.partners.map((p) => first(p.name)).join(", ")} · trips {o.travel.map((x) => `${x.id === "you" ? "you" : first(x.name)} ${x.min} min`).join(", ")} · NT${o.each} each</span>
                      <TalkFacts option={o} names={Object.fromEntries(o.partners.map((p) => [p.id, first(p.name)]))} done={t.state !== "needs"} /></span>
                    <span className="ap-av">{o.partners.map((p) => <Av key={p.id} m={byId[p.id]} size={28} />)}</span>
                  </li>
                ))}
              </ul>
              {t.state === "needs" && (
                <div className="cta-row">
                  <button className="btn primary" onClick={() => approveAutopilot(t, "all")}>{games.length > 1 ? "Book both" : "Book it"}</button>
                  {games.length > 1 && <button className="btn ghost" onClick={() => approveAutopilot(t, "first")}>Only the first</button>}
                  <button className="btn ghost" onClick={() => approveAutopilot(t, "none")}>Not this week</button>
                  <span className="tiny muted">Every other player's agent already said yes.</span>
                </div>
              )}
              {t.state === "done" && t.summary && <p className="tiny muted">{t.summary}. Follow the games on Club → Challenges.</p>}
            </div>
          )}
          {r?.summary && <p className="ap-summary"><Mark size={16} />{r.summary}</p>}
        </section>
      )}

      <section className="panel ap-how" aria-labelledby="how-h">
        <h2 id="how-h" className="panel-h">How it decides</h2>
        <ol>
          <li><b>Muse Glimmer chooses every step.</b> It works through tools (check the week, check your body log, rank partners, find public courts, negotiate, ask you) and gives a reason for each choice.</li>
          <li><b>Your body comes first.</b> With something sore in your <a href="#/body">body log</a> it plays doubles and skips jump sports; in a week far over your usual load (from your health app) it lines up one game fewer.</li>
          <li><b>It follows what you told it.</b> Before it ranks partners it looks up what you told your agent (<a href="#/memory">Your memory</a>), and leaves out a person, a time or a place you asked it to avoid.</li>
          <li><b>Code does the exact work.</b> Calendars, courts, trips and ratings come from code, and a tool refuses a time nobody is free or a member who is busy, so the agent has to re-plan.</li>
          <li><b>Agents agree with agents.</b> Every member's agent answers from what that member shares with it, all at the same time. A counter-offer is checked against everyone's calendar before your agent moves to it.</li>
          <li><b>You stay in charge.</b> Nothing is booked without your yes, or within the limits you set. If the model stalls, rules finish the same plan, and the trail says so.</li>
        </ol>
      </section>
    </div>
  );
}

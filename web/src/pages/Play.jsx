import { useEffect, useMemo, useRef, useState } from "react";
import Icon from "../components/Icon.jsx";
import Mark from "../components/Mark.jsx";
import PlayMap from "../components/PlayMap.jsx";
import WeekCal from "../components/WeekCal.jsx";
import { ago } from "../components/TaskCard.jsx";
import { useTasks, startPlay, bookFor, rebookFor, cancelFor, playerOf } from "../tasks.js";
import { shareLinks } from "../club/share.js";
import { go } from "../App.jsx";
import "./club.css";
import "./agent.css";
import "./play.css";

// Play: say you want to play and the agent does the tedious part, in the open: it reads the request on Muse Glimmer,
// opens the map, checks the courts, lines up everyone's calendar, picks the venue in the middle and writes the invites.
// Each step shows up on the map and in the trail as it finishes. Nothing is booked until you confirm; then the court
// is held, invites go out, and the agent follows up until the game is on.
const TOOL = { read_request: "spark", open_map: "pin", search_courts: "book", match_style: "coaches", find_players: "coaches", likely: "chat", calendar: "clock", travel: "route", health_limit: "heart", write_invites: "send", verify: "verify" };
// what a member's agent said before anyone was asked: a band, worked out on their side from their own record (their
// answers, their games), which never reaches you
const SAID = /'s agent says /;
const PHRASE = { unlikely: "Their agent thinks a yes is unlikely.", maybe: "Their agent says maybe.", likely: "Their agent thinks a yes is likely.", "very likely": "Their agent thinks a yes is very likely." };
function Band({ p }) {
  if (!p.likely) return null;
  // (a member who chose to share the exact chance gives it too, rounded to 5%)
  const pct = p.chance != null ? `${Math.round(p.chance * 100)}%` : null;
  return <span className={`band band-${p.likely.replace(" ", "-")}`} title={`${first(p.name)}'s agent worked this out from ${first(p.name)}'s own record of answers and games. Only ${pct ? "the word and the chance come" : "the word comes"} back to you.`}>{p.likely}{pct ? ` · ${pct}` : ""}</span>;
}
const initials = (n) => n.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
const first = (n) => n.split(" ")[0];
const hashParam = (k) => new URLSearchParams(location.hash.split("?")[1] || "").get(k);

function ics(b) {
  const o = b.option, d = o.date.replace(/-/g, ""), t = (x) => `${d}T${x.replace(":", "")}00`;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const who = b.invites.filter((i) => i.status === "in").map((i) => i.name).join(", ");
  const body = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Serve//Play//EN", "BEGIN:VEVENT", `UID:${b.id}@serve`, `DTSTAMP:${stamp}`,
    `DTSTART:${t(o.start)}`, `DTEND:${t(o.end)}`, `SUMMARY:Badminton ${o.format} at ${o.venue.name}`, `LOCATION:${o.venue.name}, court ${o.court}`,
    `DESCRIPTION:With ${who || "the club"}. NT$${o.each} each, pay at the venue. Ref ${b.id}. Booked with Serve.`, "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  return URL.createObjectURL(new Blob([body], { type: "text/calendar" }));
}
const trips = (o) => (o.travel || []).map((t) => <span key={t.id} className={`trip ${t.min === o.longest ? "long" : ""}`}><Icon name="route" size={14} />{t.id === "you" ? "You" : first(t.name)} {t.min} min</span>);

function Trail({ t }) {
  return (
    <ol className="trail" aria-label="What the agent did" aria-live="polite">
      {t.steps.map((s, k) => (
        <li key={k} className={`trail-step ${s.tool || ""}`}>
          <span className="trail-ic" aria-hidden="true"><Icon name={TOOL[s.tool] || "check"} size={16} /></span>
          <div><b>{s.step}</b><span>{s.detail}</span></div>
          {s.seconds ? <span className="trail-t tiny">{Math.round(s.seconds)} s</span> : null}
        </li>
      ))}
      {t.state === "running" && (
        <li className="trail-step now"><span className="trail-ic" aria-hidden="true"><span className="spin" /></span><div><b>{t.working || "Working"}</b><span><Seconds since={t.steps.at(-1)?.at || t.started} /></span></div></li>
      )}
      {t.state === "failed" && <li className="trail-step failed"><span className="trail-ic" aria-hidden="true"><Icon name="warn" size={16} /></span><div><b>Couldn't finish</b><span>{t.error}</span></div></li>}
    </ol>
  );
}
function Seconds({ since }) {
  const [s, setS] = useState(0);
  useEffect(() => { const id = setInterval(() => setS(Math.round((Date.now() - since) / 1000)), 1000); return () => clearInterval(id); }, [since]);
  return <>{s} s on Muse Glimmer, your server</>;
}

function Booking({ t, you }) {
  const b = t.booking, st = b.state, o = b.option;
  const [err, setErr] = useState("");
  // someone asked for by name said no: offer the next option that has them all at another time
  const said = b.invites.filter((i) => i.asked && i.status === "out");
  const alt = said.length ? (t.result?.options || []).find((x) => x.id !== o.id && (x.date !== o.date || x.start !== o.start) && said.every((i) => x.partners.some((p) => p.id === i.id))) : null;
  return (
    <section className={`panel booking ${st}`} aria-labelledby="bk-h" aria-live="polite">
      <header className="club-h">
        <h2 id="bk-h" className="panel-h">{st === "confirmed" ? "Game on" : st === "cancelled" ? "Cancelled" : st === "short" ? "Not enough players yet" : "Waiting for answers"} · {o.day} {o.start}–{o.end} · {o.venue.name}, court {o.court}</h2>
        <span className="tiny muted">Ref {b.id} · NT${o.each} each, pay at the venue</span>
      </header>
      <ul className="rsvp">
        <li className="in"><span className="mav you" aria-hidden="true">You</span><b>You</b><span className="rs">host</span></li>
        {b.invites.map((i) => (
          <li key={i.id} className={i.status}>
            <span className="mav" aria-hidden="true">{initials(i.name)}</span>
            <b>{i.name}</b>
            <span className="rs">{i.status === "in" ? "✓ in" : i.status === "out" ? "✕ can't make it" : "invite sent…"}{i.replaces ? " · replacement" : ""}</span>
            <a className="chip" href={shareLinks(i.text).whatsapp} target="_blank" rel="noopener noreferrer" title={i.text}>Send on WhatsApp</a>
          </li>
        ))}
      </ul>
      <ol className="play-log">{b.log.map((l, k) => <li key={k}><span className="mono tiny">{new Date(l.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>{l.text}</li>)}</ol>
      <div className="play-actions">
        {st === "confirmed" && <a className="btn primary" href={ics(b)} download={`serve_${b.id}.ics`}><Icon name="download" size={16} />Add to calendar</a>}
        {st === "confirmed" && <a className="btn ghost" href={shareLinks(`Badminton ${o.format}, ${o.day} ${o.start}-${o.end} at ${o.venue.name}, court ${o.court}. NT$${o.each} each. With ${b.invites.filter((i) => i.status === "in").map((i) => first(i.name)).join(", ")}.`).whatsapp} target="_blank" rel="noopener noreferrer">Share to the group chat</a>}
        {st !== "cancelled" && <button className="btn ghost" onClick={() => cancelFor(t.id).catch((x) => setErr(`Could not cancel (${x.message}).`))}>Cancel booking</button>}
      </div>
      {said.length > 0 && st !== "cancelled" && (
        <div className="rebook">
          <p><b>{said.map((i) => first(i.name)).join(" and ")} can't make {o.day} {o.start}.</b> {alt ? `${alt.day} ${alt.start}–${alt.end} at ${alt.venue.name} also suits you both.` : "No other time this week suits you both yet."}</p>
          {alt && <button className="btn primary" onClick={() => rebookFor(t.id, alt, you).catch((x) => setErr(`Could not book that time (${x.message}).`))}>Ask for {alt.day} {alt.start} instead</button>}
        </div>
      )}
      {err && <p className="err" role="alert">{err}</p>}
      <p className="tiny muted">Demo: the venues and the other members are made up, so they answer by themselves within a few seconds. {st === "confirmed" ? "This game counts in the club: +30 XP." : "If someone can't make it, the agent invites the next best player."}</p>
    </section>
  );
}

export default function Play({ data }) {
  const tasks = useTasks();
  const [hash, setHash] = useState(location.hash);
  const [text, setText] = useState("");
  const [geo, setGeo] = useState(null);
  const [confirm, setConfirm] = useState(null); // the option waiting for the player's yes
  const [err, setErr] = useState("");
  const dlg = useRef(null), asked = useRef(null);
  const you = useMemo(() => (data ? playerOf(data) : null), [data]);
  useEffect(() => { fetch("/data/venues.json").then((r) => r.json()).then(setGeo).catch(() => {}); }, []);
  useEffect(() => { const on = () => setHash(location.hash); addEventListener("hashchange", on); return () => removeEventListener("hashchange", on); }, []);
  // a link like #/play?q=... (from the club or the agent) asks straight away
  useEffect(() => {
    const q = hashParam("q");
    if (q && you && asked.current !== hash) { asked.current = hash; go(`play?task=${startPlay(q, you)}`); }
  }, [hash, you]);
  // the confirmation is a modal: focus in, Escape closes
  useEffect(() => {
    if (!confirm) return;
    dlg.current?.querySelector("button.primary")?.focus();
    const k = (e) => e.key === "Escape" && setConfirm(null);
    addEventListener("keydown", k); return () => removeEventListener("keydown", k);
  }, [confirm]);

  const plays = tasks.filter((x) => x.kind === "play");
  const tid = new URLSearchParams(hash.split("?")[1] || "").get("task");
  const t = (tid && plays.find((x) => x.id === tid)) || plays[0] || null;
  const res = t?.result, chosen = t?.booking ? res?.options.find((o) => o.id === t.chosen) || t.booking.option : null;
  const shown = chosen || res?.options[0] || null;

  function ask(e, said) {
    e?.preventDefault();
    const q = (said ?? text).trim(); if (!q || !you) return;
    setText(""); setErr("");
    go(`play?task=${startPlay(q, you)}`);
  }
  async function doBook() {
    const o = confirm; setConfirm(null); setErr("");
    try { await bookFor(t.id, o, you); } catch (x) { setErr(`Booking failed (${x.message}).`); }
  }

  if (!you) return <div className="page"><p className="muted">Loading…</p></div>;
  return (
    <div className={`page play ${t ? "has-job" : ""}`}>
      <header className="play-top">
        <h1 className="h1">Play</h1>
        <p className="muted">Say when, who or how. Your agent finds a time that suits everyone, a court in the middle, and the people.</p>
      </header>
      <form className="composer-box play-ask" onSubmit={ask}>
        <label htmlFor="play-q" className="sr-only">What do you feel like playing?</label>
        <textarea id="play-q" rows={1} value={text} onChange={(e) => setText(e.target.value)} placeholder="Doubles on Thursday evening"
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(); } }} />
        <button className="send" aria-label="Find a game" disabled={!text.trim()}><Icon name="up" size={20} /></button>
      </form>
      {err && <p className="err" role="alert">{err}</p>}

      {t ? (
        <section className="play-job" aria-labelledby="job-h">
          <div className="job-head">
            <span className={`task-av ${t.state}`} aria-hidden="true"><Mark size={22} /></span>
            <div>
              <h2 id="job-h" className="task-said">“{t.title}”</h2>
              <p className="tiny muted">{t.state === "running" ? `Working · started ${ago(t.started)}` : t.state === "failed" ? "Couldn't finish" : `${t.steps.length} steps · ${res?.seconds ? `${Math.round(res.seconds)} s on Muse Glimmer` : ago(t.finished || t.started)}`}</p>
            </div>
          </div>
          <div className="job-grid">
            <div className="job-map"><PlayMap geo={geo} steps={t.steps} option={shown && res ? shown : null} /></div>
            <Trail t={t} />
            {t.steps.find((s) => s.tool === "calendar") && <div className="job-cal"><h3 className="panel-h">Everyone's week</h3><WeekCal calendar={res?.calendar || t.steps.find((s) => s.tool === "calendar").calendar} /></div>}
          </div>

          {t.booking && <Booking t={t} you={you} />}

          {res && !t.booking && (
            <div className="play-res">
              {res.options.length ? <p className="play-msg">{res.message}</p> : <p className="muted">{res.message}</p>}
              <div className="options">
                {res.options.map((o, k) => (
                  <article key={o.id} className={`panel option ${k === 0 ? "best" : ""}`}>
                    <header>
                      {k === 0 && <span className="tag best-tag">Best fit</span>}
                      <b className="opt-when">{o.day} {o.date.slice(5).replace("-", "/")} · {o.start}–{o.end}</b>
                      <span className="muted small">{o.venue.name} · court {o.court} · {o.courtsFree} court{o.courtsFree > 1 ? "s" : ""} free</span>
                    </header>
                    <div className="trips">{trips(o)}</div>
                    <dl className="readout opt-facts">
                      <div><dt>Format</dt><dd>{o.format}</dd></div>
                      <div><dt>Each</dt><dd>NT${o.each}</dd></div>
                      <div><dt>Players</dt><dd>{o.players}</dd></div>
                    </dl>
                    <ul className="opt-people">
                      {o.partners.map((p) => <li key={p.id}><span className="mav" aria-hidden="true">{initials(p.name)}</span><span><b>{p.name} <Band p={p} /></b><span className="tiny muted">{p.likely ? `${PHRASE[p.likely] || ""} ` : ""}{p.why.filter((w) => !SAID.test(w)).join(" · ") || "free then"}</span></span></li>)}
                    </ul>
                    <button className={`btn ${k === 0 ? "primary" : "ghost"}`} onClick={() => setConfirm(o)}>{res.intent?.challenge ? "Send the challenge" : "Book and invite"}</button>
                  </article>
                ))}
              </div>
              <p className="tiny muted">{res.demo}</p>
            </div>
          )}
        </section>
      ) : (
        <section className="play-job idle" aria-label="The club's town">
          <div className="job-map"><PlayMap geo={geo} /></div>
        </section>
      )}

      {plays.length > 1 && (
        <section className="play-past" aria-labelledby="past-h">
          <h2 id="past-h" className="sec-label">Earlier</h2>
          <ul>{plays.filter((x) => x !== t).slice(0, 4).map((x) => <li key={x.id}><a href={`#/play?task=${x.id}`}><b>“{x.title}”</b><span className="tiny muted">{x.summary || x.error || "working"} · {ago(x.finished || x.started)}</span></a></li>)}</ul>
        </section>
      )}

      {confirm && (
        <div className="rt-peek" onClick={() => setConfirm(null)}>
          <div ref={dlg} className="play-confirm" role="dialog" aria-modal="true" aria-labelledby="cf-h" onClick={(e) => e.stopPropagation()}>
            <h2 id="cf-h" className="panel-h">{res.intent?.challenge ? "Send this challenge?" : "Book this game?"}</h2>
            <p>Serve will hold <b>court {confirm.court} at {confirm.venue.name}</b> on <b>{confirm.day} {confirm.start}–{confirm.end}</b> and invite {confirm.partners.map((p) => first(p.name)).join(", ")}. You pay <b>NT${confirm.each}</b> at the venue; nothing is charged here.</p>
            <div className="trips">{trips(confirm)}</div>
            <h3 className="tiny muted">The invites{res.invites && confirm.id === res.options[0]?.id ? ", written by Muse Glimmer and checked against this booking" : ""}</h3>
            <ul className="cf-invites">{confirm.partners.map((p) => <li key={p.id}><b>{first(p.name)}</b> {(confirm.id === res.options[0]?.id && res.invites[p.id]) || `Hi ${first(p.name)}, ${confirm.format} on ${confirm.day} ${confirm.start}–${confirm.end} at ${confirm.venue.name}? NT$${confirm.each} each.`}</li>)}</ul>
            <div className="play-actions">
              <button className="btn primary" onClick={doBook}>{res.intent?.challenge ? "Book and send the challenge" : "Book and send invites"}</button>
              <button className="btn ghost" onClick={() => setConfirm(null)}>Not yet</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

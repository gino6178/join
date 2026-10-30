import { useEffect, useMemo, useRef, useState } from "react";
import Icon from "../components/Icon.jsx";
import Mark from "../components/Mark.jsx";
import TaskCard from "../components/TaskCard.jsx";
import TalkFacts from "../components/TalkFacts.jsx";
import { useTasks, startPlay, startBest, startTalk, bookAgreed } from "../tasks.js";
import { postToClub } from "../club/share.js";
import { patchGame } from "../club/game.js";
import { randomMatch, askFor, stakes, chance, WHEN } from "../club/arena.js";
import { go } from "../App.jsx";
import { agentReadScore } from "../agent.js";

// The club's competitive side, in two tabs of the Club page.
//   Rankings: the club rating (Elo from every challenge), games played in the club challenge and wins, with a podium
//   and your place.
//   Challenges: your best match (your agent scores every member, then talks to that member's agent to agree a time
//   and a court: agent to agent); a random match drawn fairly from the members free when you are; challenges sent to you; your booked
//   games, where you report the result and the ratings move; open challenges on the club board; recent results.
// Booking always goes through your agent on Play (map, calendars, the venue in the middle), so a challenge accepted
// here is booked the same way as one you type.
const initials = (name) => name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
const first = (name) => name.split(" ")[0];
const DAY = { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday" };
const partOf = (h) => (h < 12 ? "morning" : h < 17 ? "afternoon" : "evening");
const whenText = (w) => { const [d, h] = w.split(" "); return `${DAY[d]} ${partOf(+h.split("-")[0])}`; };
const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function Av({ m, size = 36, ring }) {
  return <span className={`mav ${m.id === "you" ? "you" : ""} ${ring ? `ring-${ring}` : ""}`} style={{ width: size, height: size, fontSize: Math.round(size / 3) }} aria-hidden="true">{m.id === "you" ? "You" : initials(m.name)}</span>;
}
const Form = ({ f }) => <span className="form" aria-label={`Last ${f.length}: ${f.join(" ")}`}>{f.map((x, i) => <i key={i} className={x === "W" ? "w" : "l"}>{x}</i>)}</span>;

// your agent and the other member's agent, agreeing a game: each message, what it proposes, and whether it was checked
const INTENT = { propose: "Proposes", counter: "Counter-offer", accept: "Agrees", decline: "Declines" };
function Thread({ t, byId, you }) {
  const them = byId[t.with], name = them ? first(them.name) : "Their";
  return (
    <div className="a2a" aria-live="polite">
      <p className="a2a-h"><Icon name="chat" size={16} /><b>Your agent</b> and <b>{name}'s agent</b><span className="tiny muted">agent to agent, on Muse Glimmer · every time checked by code against both calendars and the courts</span></p>
      {t.result && <TalkFacts mode={t.result.calendars} option={t.state === "needs" ? t.result.agreed : null} cards={t.result.cards} names={{ [t.with]: name }} />}
      <ol className="a2a-thread">
        {(t.messages || []).map((x, i) => (
          <li key={i} className={x.from === "you" ? "mine" : "theirs"}>
            <span className="a2a-who">{x.from === "you" ? <><Mark size={14} />Your agent</> : <><Av m={them} size={20} />{name}'s agent</>}</span>
            <p>{x.text}</p>
            <span className={`a2a-intent ${x.intent}`}>{INTENT[x.intent]}{x.when ? ` · ${x.when}` : ""}{x.checked ? " · ✓ fits both calendars" : x.checked === false ? " · ✗ does not fit" : ""}</span>
          </li>
        ))}
        {t.state === "running" && <li className="typing"><span className="dots" aria-hidden="true"><i /><i /><i /></span>{t.working || "…"}</li>}
      </ol>
      {t.state === "failed" && <p className="muted small">{t.error}</p>}
      {t.state === "needs" && t.result?.agreed && (
        <div className="cta-row a2a-book">
          <button className="btn primary" onClick={() => (t.result.agreed.format === "doubles" ? go(`play?task=${startPlay(`Doubles on ${DAY[t.result.agreed.day]} ${partOf(+t.result.agreed.start.slice(0, 2))} with ${name}`, { ...you, from: t.result.agreed.hold })}`) : bookAgreed(t, you))}>{t.result.agreed.format === "doubles" ? "Find our opponents" : "Book it"}</button>
          <span className="tiny muted">{name}'s agent already said yes. Nothing is booked until you do.</span>
        </div>
      )}
      {t.state === "done" && t.result?.agreed && <p className="tiny muted">{t.summary}</p>}
    </div>
  );
}

// your place, in one line at the top of both tabs
export function Standing({ me, r, rec, rank, of, ahead }) {
  return (
    <div className="standing" aria-label="Your standing">
      <Av m={me} size={44} />
      <div><b>#{rank} of {of}</b><span className="tiny muted">club rating</span></div>
      <div><b className="mono">{r.you}</b><span className="tiny muted">{rec.you.w}–{rec.you.l} this season</span></div>
      <div><Form f={rec.you.form} /><span className="tiny muted">last {rec.you.form.length}</span></div>
      {ahead && <p className="tiny muted standing-next">{r[ahead.id] - r.you + 1} points to pass {first(ahead.name)} (#{rank - 1}). A win over them is worth +{stakes(r.you, r[ahead.id]).win}.</p>}
    </div>
  );
}

const BOARDS = [["rating", "Rating"], ["games", "Games"], ["wins", "Wins"]];
export function Rankings({ club, members, r, rec, onChallenge }) {
  const [board, setBoard] = useState("rating");
  const val = (m) => board === "rating" ? r[m.id] : board === "games" ? m.games || 0 : rec[m.id].w;
  const list = [...members].sort((a, b) => val(b) - val(a) || r[b.id] - r[a.id]);
  const shown = (m) => board === "rating" ? <><b className="mono">{r[m.id]}</b><small>rating</small></>
    : board === "games" ? <><b className="mono">{m.games || 0}</b><small>games in the challenge</small></>
    : <><b className="mono">{rec[m.id].w}</b><small>{rec[m.id].w}–{rec[m.id].l} · {Math.round(100 * rec[m.id].w / Math.max(1, rec[m.id].w + rec[m.id].l))}%</small></>;
  const podium = list.slice(0, 3);
  return (
    <section className="panel ranks" aria-labelledby="rk-h">
      <header className="club-h">
        <h2 id="rk-h" className="panel-h">Leaderboard</h2>
        <div className="seg sm" role="radiogroup" aria-label="Rank by">
          {BOARDS.map(([k, l]) => <button key={k} role="radio" aria-checked={board === k} onClick={() => setBoard(k)}>{l}</button>)}
        </div>
      </header>
      <ol className="podium" aria-label="Top three">
        {[podium[1], podium[0], podium[2]].map((m, i) => m && (
          <li key={m.id} className={`p${[2, 1, 3][i]} ${m.id === "you" ? "me" : ""}`}>
            <Av m={m} size={[56, 72, 56][i]} ring={[2, 1, 3][i]} />
            <b>{m.id === "you" ? "You" : first(m.name)}</b>
            <span className="podium-val">{shown(m)}</span>
            <span className="podium-step" aria-hidden="true">{[2, 1, 3][i]}</span>
          </li>
        ))}
      </ol>
      <ol className="rank-list" start={4}>
        {list.slice(3).map((m) => {
          const i = list.indexOf(m), s = m.id !== "you" && stakes(r.you, r[m.id]);
          return (
            <li key={m.id} className={m.id === "you" ? "me" : ""}>
              <span className="mono rk">{i + 1}</span>
              <Av m={m} size={34} />
              <span className="lg-who"><b>{m.id === "you" ? "You" : m.name}</b>
                <span className="tiny muted">level {m.level} · {rec[m.id].w}–{rec[m.id].l} <Form f={rec[m.id].form} /></span>
                {s && board === "rating" && <span className="tiny muted">win chance {chance(r.you, r[m.id])}% · +{s.win} / −{s.loss}</span>}
              </span>
              <span className="lg-num">{shown(m)}</span>
              {m.id !== "you" && <button className="btn ghost sm" onClick={() => onChallenge(m)}>Challenge</button>}
            </li>
          );
        })}
      </ol>
      <p className="tiny muted">{board === "rating" ? "The club rating moves with every challenge and random match you report: beat someone rated above you and you gain more." : board === "games" ? `Games played in the club challenge, “${club.challenge?.title}”.` : "Games won this season, with the win rate."}</p>
    </section>
  );
}

// the draw: avatars flick past while the agent picks, then the match lands
function useDraw() {
  const [face, setFace] = useState(null);
  const timer = useRef();
  useEffect(() => () => clearInterval(timer.current), []);
  const roll = (pool, ms) => new Promise((done) => {
    if (reduced() || !pool.length) return done();
    let n = 0;
    timer.current = setInterval(() => { setFace(pool[n++ % pool.length]); }, 90);
    setTimeout(() => { clearInterval(timer.current); setFace(null); done(); }, ms);
  });
  return { face, roll };
}

export function Challenges({ club, members, r, rec, g, you, me }) {
  const tasks = useTasks();
  const byId = useMemo(() => Object.fromEntries(members.map((m) => [m.id, m])), [members]);
  const a = g.arena || {};
  // through the club game's store, so a post to the feed right after cannot overwrite it
  const patch = (fn) => patchGame((s) => ({ ...s, arena: fn({ results: [], answered: {}, sent: [], ...(s.arena || {}) }) }));
  const q = new URLSearchParams(location.hash.split("?")[1] || "");
  const [fmt, setFmt] = useState(q.get("fmt") === "doubles" ? "doubles" : "singles");
  const [when, setWhen] = useState(WHEN[q.get("when")] ? q.get("when") : "week");
  const [close, setClose] = useState(true);
  const [match, setMatch] = useState(null);
  const [drawing, setDrawing] = useState(false);
  const [note, setNote] = useState("");
  const { face, roll } = useDraw();

  // the best match: your agent scores every member (on the gateway), then can talk to that member's agent
  const bestT = tasks.find((t) => t.kind === "match"), talkT = tasks.find((t) => t.kind === "talk");
  const [bestFmt, setBestFmt] = useState(q.get("fmt") === "doubles" ? "doubles" : "singles");
  const played = (a.results || []).flatMap((x) => x.vs).reduce((o, id) => ({ ...o, [id]: (o[id] || 0) + 1 }), {});
  const findBest = () => startBest({ you: { level: you?.level || "B", limit: you?.limit }, ratings: r, played, format: bestFmt });
  const talk = (x) => startTalk({ with: x.id, format: bestT?.result?.format || bestFmt, you: { limit: you?.limit } }, x.name);
  const asked = useRef(false);
  useEffect(() => { if (!asked.current && q.get("best") === "1" && you) { asked.current = true; findBest(); } }, [you]); // asked for from the agent

  const spin = async () => {
    setDrawing(true); setMatch(null);
    const m = randomMatch({ club, you: { ...club.you, id: "you" }, r, format: fmt, when, close });
    const pool = club.members.filter((x) => x.prefers === "any" || x.prefers === fmt);
    await roll(pool, 1400);
    setMatch(m); setDrawing(false);
  };
  const spun = useRef(false);
  useEffect(() => { if (!spun.current && q.get("spin") === "1") { spun.current = true; spin(); } }, []); // asked for from the agent
  const book = (text, who) => {
    patch((x) => ({ ...x, sent: [{ id: `s-${Date.now()}`, who, text, at: Date.now() }, ...x.sent].slice(0, 20) }));
    go(`play?task=${startPlay(text, you)}`);
  };

  // challenges sent to you
  const incoming = (club.incoming || []).filter((c) => !a.answered?.[c.id]);
  const answer = (c, yes) => {
    patch((x) => ({ ...x, answered: { ...x.answered, [c.id]: yes ? "accepted" : "declined" } }));
    if (yes) book(`Challenge ${first(byId[c.from].name)} to a ${c.format} match on ${whenText(c.when)}`, [c.from]);
    else setNote(`Declined. ${first(byId[c.from].name)} gets a friendly note from your agent, and the challenge stays open on the board.`);
  };

  // your booked games, waiting for a result
  const reported = new Set((a.results || []).map((x) => x.id));
  const games = tasks.filter((t) => t.kind === "play" && t.booking?.state === "confirmed" && !reported.has(t.booking.id)).map((t) => t.booking);
  const [rep, setRep] = useState(null); // { id, vs, partner, format, won, score, label }
  // the score read from a photo of the scoreboard or the sheet, on your own server, and checked against the rules
  const [photo, setPhoto] = useState(null); // { busy } | { ok, text }
  async function readPhoto(file) {
    if (!file || !rep) return;
    setPhoto({ busy: true });
    const vs = rep.vs.filter(Boolean).map((id) => first(byId[id].name));
    try {
      const r = await agentReadScore(file, vs);
      if (!r.read) return setPhoto({ ok: false, text: `Couldn't read a score: ${r.why}.` });
      const read = r.games.map((g) => `${g.first}–${g.second}`).join(" ");
      if (!r.valid) return setPhoto({ ok: false, text: `Read ${read}, but that can't be a final score: ${r.problems.join("; ")}. Type it instead.` });
      // which side is you: the one whose name is not an opponent's; the score is then written your side first
      const names = [r.names?.first, r.names?.second].map((n) => String(n || "").toLowerCase()), opp = vs.map((n) => n.toLowerCase());
      const side = names.findIndex((n) => n && opp.some((o) => n.includes(o)));
      const youWon = side < 0 ? null : (r.winner === "first") === (side === 1);
      const yours = side === 0 ? r.games.map((g) => `${g.second}–${g.first}`).join(" ") : read;
      setRep((x) => ({ ...x, score: yours, ...(youWon != null ? { won: youWon } : {}) }));
      setPhoto({ ok: true, text: `Read ${yours}${youWon != null ? `: you ${youWon ? "won" : "lost"}` : ""}. It fits the rules of the game; correct it if it's wrong.` });
    } catch (e) { setPhoto({ ok: false, text: `The photo could not be read (${e.message}).` }); }
  }
  const openReport = (b) => {
    const ids = b.invites.filter((i) => i.status === "in").map((i) => i.id).filter((id) => byId[id]);
    const singles = b.option.format === "singles";
    setRep({ id: b.id, label: `${b.option.format} · ${b.option.day} ${b.option.start} · ${b.option.venue.name}`, format: b.option.format, players: ids, partner: singles ? null : ids[0] ?? null, vs: singles ? ids.slice(0, 1) : ids.slice(1, 3), won: true, score: "", booked: b.option.minutes || 90, played: b.option.minutes || 90, start: b.option.start, sport: b.option.sport || "badminton" });
  };
  const logOne = () => setRep({ id: `m-${Date.now()}`, label: "A game played outside the app", format: "singles", players: club.members.map((m) => m.id), partner: null, vs: [club.members[0].id], won: true, score: "", free: true, booked: 90, played: 90 });
  const submit = (e) => {
    e.preventDefault();
    const x = rep, vs = x.vs.filter(Boolean);
    if (!vs.length) return;
    const mine = x.partner ? (r.you + r[x.partner]) / 2 : r.you, theirs = vs.reduce((s, id) => s + r[id], 0) / vs.length;
    const st = stakes(mine, theirs), d = x.won ? st.win : -st.loss;
    const res = { id: x.id, vs, partner: x.partner, won: x.won, score: x.score.trim(), at: Date.now(), gap: Math.round(theirs - mine), d, booked: x.booked || 90, played: +x.played || x.booked || 90, start: x.start, sport: x.sport };
    patch((s) => ({ ...s, results: [...s.results, res] }));
    const names = vs.map((id) => first(byId[id].name)).join(" and ");
    postToClub({ kind: "result", text: `${x.won ? "Beat" : "Lost to"} ${names}${x.partner ? ` with ${first(byId[x.partner].name)}` : ""}${res.score ? ` ${res.score}` : ""} (${d > 0 ? "+" : ""}${d} club rating).` });
    setNote(`${x.won ? "Win" : "Result"} saved: your rating ${d > 0 ? "goes up" : "goes down"} ${Math.abs(d)} to ${r.you + d}, and it is posted to the club feed.`);
    setRep(null);
  };

  const open = club.feed.filter((f) => f.open?.challenge);
  const mineOpen = (g.mine || []).filter((f) => f.open?.challenge);
  const [post, setPost] = useState({ fmt: "singles", when: "weekend" });
  const postOpen = () => {
    const lo = r.you - 100, hi = r.you + 100;
    postToClub({ kind: "challenge", text: `Open ${post.fmt} challenge, ${WHEN[post.when].label.toLowerCase()}: anyone rated ${lo}–${hi}?`, open: { challenge: true, day: post.when === "weekend" ? "Sat" : "Thu", start: post.when === "weekend" ? "09:00" : "19:00", venue: "the venue in the middle", spots: 1 } });
    setNote("Posted to the club board. Your agent books it as soon as someone takes it.");
  };

  const results = [...(a.results || []).map((x) => ({ id: x.id, a: ["you", ...(x.partner ? [x.partner] : [])], b: x.vs, win: x.won ? "a" : "b", score: x.score, day: "today", kind: "yours", d: x.d })).reverse(), ...(club.results || [])];
  const team = (ids) => ids.map((id) => (id === "you" ? "You" : first(byId[id]?.name ?? id))).join(" & ");

  return (
    <div className="arena">
      <section className="panel best" aria-labelledby="bm-h">
        <header className="club-h"><h2 id="bm-h" className="panel-h">Best match</h2><span className="tiny muted">your agent ranks every member for a game this week, then talks to their agent</span></header>
        <div className="draw-opts">
          <div className="seg sm" role="radiogroup" aria-label="Looking for">{[["singles", "An opponent"], ["doubles", "A doubles partner"]].map(([k, l]) => <button key={k} role="radio" aria-checked={bestFmt === k} disabled={bestT?.state === "running"} onClick={() => setBestFmt(k)}>{l}</button>)}</div>
          <button className="btn primary sm" disabled={bestT?.state === "running" || !you} onClick={findBest}><Icon name="spark" size={16} />{bestT ? "Look again" : "Find my best match"}</button>
        </div>
        {bestT?.state === "running" && <TaskCard t={bestT} steps={4} />}
        {bestT?.state === "failed" && <p className="muted small">{bestT.error}</p>}
        {bestT?.result && bestT.state !== "running" && (
          <>
            <p className="best-why"><span className="agent-dot" aria-hidden="true"><Mark size={16} /></span><span>{bestT.result.why}{bestT.result.by === "model" && <span className="tiny muted"> · Muse Glimmer, every number checked</span>}</span></p>
            <ol className="best-list">
              {bestT.result.top.map((x, i) => { const mm = byId[x.id]; if (!mm) return null; return (
                <li key={x.id} className={i === 0 ? "top" : ""}>
                  <Av m={mm} size={48} />
                  <div className="best-body">
                    <p><b>{x.name}</b> <span className="tiny muted">rated {r[x.id]} · level {x.level} · win chance {chance(r.you, r[x.id])}%</span></p>
                    <div className="fit-row"><span className="fit" aria-hidden="true"><i style={{ transform: `scaleX(${x.fit / 100})` }} /></span><span className="tiny"><b>{x.fit}%</b> fit</span></div>
                    <ul className="best-parts">{x.parts.slice(0, 5).map((p) => <li key={p.k} className={p.good ? "good" : ""}>{p.text}</li>)}</ul>
                    <button className="btn ghost sm" disabled={talkT?.state === "running"} onClick={() => talk(x)}><Icon name="chat" size={16} />Talk to {first(x.name)}'s agent</button>
                  </div>
                </li>
              ); })}
            </ol>
          </>
        )}
        {!bestT && <p className="muted small">Fair by rating, free when you are, a short trip for both, and the format you want. Your agent weighs every member, Muse Glimmer says why, and the two agents agree the time.</p>}
        {talkT && <Thread t={talkT} byId={byId} you={you} />}
      </section>

      <section className="panel draw" aria-labelledby="rm-h">
        <header className="club-h"><h2 id="rm-h" className="panel-h">Random match</h2><span className="tiny muted">a fair opponent, picked at random from the members free when you are</span></header>
        <div className="draw-opts">
          <div className="seg sm" role="radiogroup" aria-label="Format">{[["singles", "Singles"], ["doubles", "Doubles"]].map(([k, l]) => <button key={k} role="radio" aria-checked={fmt === k} disabled={drawing} onClick={() => setFmt(k)}>{l}</button>)}</div>
          <div className="seg sm" role="radiogroup" aria-label="When">{Object.entries(WHEN).map(([k, w]) => <button key={k} role="radio" aria-checked={when === k} disabled={drawing} onClick={() => setWhen(k)}>{w.label}</button>)}</div>
          <label className="tiny"><input type="checkbox" checked={close} disabled={drawing} onChange={() => setClose((c) => !c)} /> Close to my rating (±150)</label>
        </div>
        <div className={`draw-stage ${drawing ? "rolling" : ""}`} aria-live="polite">
          {drawing ? (
            <div className="vs-row"><span className="vs-side"><Av m={me} size={64} /><b>You</b></span><span className="vs-mark">VS</span><span className="vs-side">{face ? <Av m={face} size={64} /> : <span className="mav q" style={{ width: 64, height: 64 }}>?</span>}<b>{face ? first(face.name) : "…"}</b></span></div>
          ) : match?.vs ? (
            <div className="match-card">
              <div className="vs-row">
                <span className="vs-side"><span className="pair"><Av m={me} size={64} />{match.partner && <Av m={match.partner} size={48} />}</span><b>{match.partner ? `You & ${first(match.partner.name)}` : "You"}</b><span className="mono tiny">{match.partner ? Math.round((r.you + r[match.partner.id]) / 2) : r.you}</span></span>
                <span className="vs-mark">VS</span>
                <span className="vs-side"><span className="pair">{match.vs.map((m) => <Av key={m.id} m={m} size={match.vs.length > 1 ? 48 : 64} />)}</span><b>{match.vs.map((m) => first(m.name)).join(" & ")}</b><span className="mono tiny">{Math.round(match.vs.reduce((s, m) => s + r[m.id], 0) / match.vs.length)}</span></span>
              </div>
              <ul className="match-facts">
                <li><Icon name="clock" size={16} />All free {DAY[match.slot.d]} {match.slot.start}</li>
                <li><Icon name="goals" size={16} />Win chance {match.chance}% · +{match.stakes.win} if you win, −{match.stakes.loss} if not</li>
                <li><Icon name="spark" size={16} />Drawn at random from {match.pool} member{match.pool > 1 ? "s" : ""} free then{close ? ", within 150 points" : ""}{match.partner ? `; the two sides are ${Math.abs(Math.round((r.you + r[match.partner.id]) / 2) - Math.round(match.vs.reduce((s, m) => s + r[m.id], 0) / match.vs.length))} points apart on average` : ""}</li>
              </ul>
              <div className="cta-row">
                <button className="btn primary" onClick={() => book(askFor(match), match.vs.map((m) => m.id))}>Send the challenge</button>
                <button className="btn ghost" onClick={spin}>Draw again</button>
              </div>
              <p className="tiny muted">Your agent books it like any game: the map, everyone's calendar, the venue in the middle. Nothing is booked until you confirm.</p>
            </div>
          ) : match ? (
            <p className="muted">Nobody plays {fmt} {WHEN[when].label.toLowerCase()} when you are free{close ? " within 150 points" : ""}. Try another time{close ? " or untick “close to my rating”" : ""}.</p>
          ) : (
            <div className="club-empty"><p>Can't find a game? Let the club draw one. The agent only draws members who are free when you are and play {fmt}, and the closer their rating, the likelier they come up.</p><button className="btn primary" onClick={spin}><Icon name="spark" size={18} />Draw a random match</button></div>
          )}
        </div>
      </section>

      {note && <p className="arena-note" role="status">{note} <button className="link" onClick={() => setNote("")}>OK</button></p>}

      <div className="arena-grid">
        <section className="panel" aria-labelledby="in-h">
          <h2 id="in-h" className="panel-h">Challenges for you</h2>
          {!incoming.length && <p className="muted small">No challenges waiting. Draw a random match, or put one on the board below.</p>}
          <ul className="challenges">
            {incoming.map((c) => {
              const m = byId[c.from], s = stakes(r.you, r[m.id]);
              return (
                <li key={c.id} className="challenge">
                  <Av m={m} size={44} />
                  <div className="ch-body">
                    <p><b>{m.name}</b> challenged you · {c.format} · {whenText(c.when)}</p>
                    <p className="ch-note">“{c.note}”</p>
                    <p className="tiny muted">Rated {r[m.id]} · win chance {chance(r.you, r[m.id])}% · +{s.win} / −{s.loss}{c.stake ? ` · ${c.stake}` : ""}</p>
                    <div className="cta-row"><button className="btn primary sm" onClick={() => answer(c, true)}>Accept</button><button className="btn ghost sm" onClick={() => answer(c, false)}>Decline</button></div>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="panel" aria-labelledby="gm-h">
          <header className="club-h"><h2 id="gm-h" className="panel-h">Report a result</h2><button className="link" onClick={logOne}>Log another game</button></header>
          {!games.length && !rep && <p className="muted small">Games your agent booked show up here once they are on. Report who won and the ratings move.</p>}
          <ul className="challenges">
            {games.map((b) => (
              <li key={b.id} className="challenge">
                <span className="mav" style={{ width: 44, height: 44 }} aria-hidden="true"><Icon name="book" size={18} /></span>
                <div className="ch-body">
                  <p><b>{b.option.format === "singles" ? "Singles" : "Doubles"}</b> · {b.option.day} {b.option.start} · {b.option.venue.name}</p>
                  <p className="tiny muted">with {b.invites.filter((i) => i.status === "in").map((i) => first(i.name)).join(", ")}</p>
                  <button className="btn ghost sm" onClick={() => openReport(b)}>Report the result</button>
                </div>
              </li>
            ))}
          </ul>
          {rep && (
            <form className="report" onSubmit={submit}>
              <p className="tiny muted">{rep.label}</p>
              <div className="seg sm" role="radiogroup" aria-label="Result">{[[true, rep.partner ? "We won" : "I won"], [false, rep.partner ? "We lost" : "I lost"]].map(([k, l]) => <button key={l} type="button" role="radio" aria-checked={rep.won === k} onClick={() => setRep({ ...rep, won: k })}>{l}</button>)}</div>
              {rep.free && (
                <label className="tiny">Against <select value={rep.vs[0]} onChange={(e) => setRep({ ...rep, vs: [e.target.value] })}>{club.members.map((m) => <option key={m.id} value={m.id}>{m.name} ({r[m.id]})</option>)}</select></label>
              )}
              {!rep.free && rep.format !== "singles" && (
                <label className="tiny">My partner <select value={rep.partner ?? ""} onChange={(e) => { const p = e.target.value; setRep({ ...rep, partner: p, vs: rep.players.filter((id) => id !== p).slice(0, 2) }); }}>{rep.players.map((id) => <option key={id} value={id}>{byId[id].name}</option>)}</select></label>
              )}
              <label className="tiny">Score (optional) <input value={rep.score} onChange={(e) => setRep({ ...rep, score: e.target.value })} placeholder="21–17 19–21 21–15" /></label>
              <div className="photo-score">
                <label className={`btn ghost sm${photo?.busy ? " busy" : ""}`}><Icon name="plus" size={16} />{photo?.busy ? "Reading the photo…" : "Read it from a photo"}
                  <input type="file" accept="image/*" capture="environment" hidden disabled={!!photo?.busy} onChange={(e) => { readPhoto(e.target.files?.[0]); e.target.value = ""; }} /></label>
                {photo && !photo.busy && <span className={`tiny ${photo.ok ? "good" : "bad"}`} role="status">{photo.text}</span>}
              </div>
              <label className="tiny">How long did you play? <span className="row-inline"><input type="number" min="15" max="300" step="5" value={rep.played} onChange={(e) => setRep({ ...rep, played: e.target.value })} /> min of {rep.booked} booked</span>
                {+rep.played - rep.booked >= 15 && <span className="tiny good">You kept playing: the Autopilot will pair you up again.</span>}</label>
              {(() => { const vs = rep.vs.filter(Boolean); if (!vs.length) return null; const mine = rep.partner ? (r.you + r[rep.partner]) / 2 : r.you, th = vs.reduce((s, id) => s + r[id], 0) / vs.length, st = stakes(mine, th); return <p className="tiny muted">Against {vs.map((id) => first(byId[id].name)).join(" & ")} ({Math.round(th)}): {rep.won ? `+${st.win}` : `−${st.loss}`} to your rating.</p>; })()}
              <div className="cta-row"><button className="btn primary sm">Save the result</button><button type="button" className="btn ghost sm" onClick={() => { setRep(null); setPhoto(null); }}>Cancel</button></div>
            </form>
          )}
        </section>

        <section className="panel" aria-labelledby="op-h">
          <h2 id="op-h" className="panel-h">Open challenges</h2>
          <ul className="challenges">
            {open.map((f) => { const m = byId[f.who]; return (
              <li key={f.id} className="challenge">
                <Av m={m} size={44} />
                <div className="ch-body">
                  <p><b>{m.name}</b> · rated {r[m.id]} · {f.open.day} {f.open.start}</p>
                  <p className="ch-note">“{f.text}”</p>
                  <button className="btn primary sm" onClick={() => book(`Challenge ${first(m.name)} to a singles match this weekend`, [m.id])}>Take it on</button>
                </div>
              </li>
            ); })}
            {mineOpen.map((f) => <li key={f.id} className="challenge"><Av m={me} size={44} /><div className="ch-body"><p><b>You</b> · {f.text}</p><p className="tiny muted">On the board, waiting for a taker</p></div></li>)}
          </ul>
          <div className="post-open">
            <div className="seg sm" role="radiogroup" aria-label="Format">{[["singles", "Singles"], ["doubles", "Doubles"]].map(([k, l]) => <button key={k} role="radio" aria-checked={post.fmt === k} onClick={() => setPost({ ...post, fmt: k })}>{l}</button>)}</div>
            <div className="seg sm" role="radiogroup" aria-label="When">{[["weekend", "This weekend"], ["weekday", "A weekday evening"]].map(([k, l]) => <button key={k} role="radio" aria-checked={post.when === k} onClick={() => setPost({ ...post, when: k })}>{l}</button>)}</div>
            <button className="btn ghost sm" onClick={postOpen}>Post an open challenge</button>
          </div>
        </section>

        <section className="panel" aria-labelledby="rs-h">
          <h2 id="rs-h" className="panel-h">Recent results</h2>
          <ul className="results">
            {results.slice(0, 8).map((x) => (
              <li key={x.id} className={x.kind === "yours" ? "mine" : ""}>
                <span className={x.win === "a" ? "won" : ""}>{team(x.a)}</span><span className="tiny muted">{x.win === "a" ? "beat" : "lost to"}</span><span className={x.win === "b" ? "won" : ""}>{team(x.b)}</span>
                <span className="tiny muted res-meta">{x.score}{x.score ? " · " : ""}{x.kind === "yours" ? `${x.d > 0 ? "+" : ""}${x.d} rating` : x.kind === "random" ? "random match" : "challenge"} · {x.day}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

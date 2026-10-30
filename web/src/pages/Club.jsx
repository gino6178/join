import { useEffect, useMemo, useState } from "react";
import Icon from "../components/Icon.jsx";
import { memory } from "../memory.js";
import { readGame, saveGame } from "../club/game.js";
import { postToClub } from "../club/share.js";
import { useTasks, startPlay, playerOf } from "../tasks.js";
import { week, challenge } from "../club/week.js";
import { ratings, records } from "../club/arena.js";
import { Rankings, Challenges, Standing } from "./Arena.jsx";
import { go } from "../App.jsx";
import Ideas from "../loop/Ideas.jsx";
import Feed from "../club/Feed.jsx";
import "./club.css";
import "./agent.css";

// The club: the feed (what members post, open games to join, a challenge to take up) beside the top of the table and
// what the club sees of you; the leaderboard; the challenges (best match, random match, challenges for you, results
// that move the club rating; see Arena.jsx); and the ideas members share to make Serve better (loop/Ideas.jsx).
// Your posts and results live in this browser; the club only sees what you share. Goals is a page of its own.
const initials = (name) => name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
const first = (name) => name.split(" ")[0];
const hurt = (texts) => texts.some((t) => /knee|ankle|膝|腳踝/i.test(t) && /sore|pain|hurt|injur|avoid jump|痛|痠|傷/i.test(t));
const share = (text) => ({ wa: `https://wa.me/?text=${encodeURIComponent(text)}`, threads: `https://www.threads.net/intent/post?text=${encodeURIComponent(text)}` });

function Member({ m, size = 36 }) {
  return <span className={`mav ${m.id === "you" ? "you" : ""}`} style={{ width: size, height: size }} aria-hidden="true">{m.id === "you" ? "You" : initials(m.name)}</span>;
}
function ShareLinks({ text }) {
  const l = share(text);
  return (
    <span className="share-links">
      <a className="chip" href={l.wa} target="_blank" rel="noopener noreferrer"><Icon name="share" size={14} />WhatsApp</a>
      <a className="chip" href={l.threads} target="_blank" rel="noopener noreferrer"><Icon name="share" size={14} />Threads</a>
    </span>
  );
}

export default function Club({ club }) {
  const tasks = useTasks();
  const [g, setG] = useState(() => ({ shares: { goals: true, progress: true, highlights: false, limits: true }, activity: [], cheers: {}, mine: [], joined: {}, ...readGame() }));
  const tabOf = () => new URLSearchParams(location.hash.split("?")[1] || "").get("tab") || "feed";
  const [tab, setTab] = useState(tabOf);
  const [hash, setHash] = useState(location.hash); // a new ask (#/club?tab=challenges&spin=1&fmt=doubles) starts the draw again
  useEffect(() => { const on = () => { setTab(tabOf()); setHash(location.hash); }; addEventListener("hashchange", on); return () => removeEventListener("hashchange", on); }, []);
  const [all, setAll] = useState({ feed: false });
  const [post, setPost] = useState("");
  useEffect(() => saveGame(g), [g]);
  // an agent task (a booked game) or a share elsewhere changed the game: take it in
  useEffect(() => { const on = () => setG((s) => ({ ...s, ...readGame() })); addEventListener("shuttlecoach:game", on); return () => removeEventListener("shuttlecoach:game", on); }, []);
  const limited = hurt(memory.all().map((m) => m.text));
  const you = useMemo(() => (club ? playerOf(club) : null), [club]);
  if (!club || !you) return <div className="page"><p className="muted">Opening the club…</p></div>;
  const res = g.arena?.results || [];
  // you, as the club sees you: from club.json (where "you" is a member like the others) and the games you played
  const w = week(club, { results: res, tasks, goal: g.autopilot?.goal?.perWeek || club.you.goal?.perWeek || 2 }), ch = challenge(club, w);
  const me = { id: "you", name: "You", level: club.you.level || "B", games: ch?.yours ?? 0, limit: limited ? "no jump landings" : null, shares: { ...g.shares } };
  const members = [me, ...club.members];
  const byId = Object.fromEntries(members.map((m) => [m.id, m]));
  // the club rating: the demo table plus every result you report (club/arena.js)
  const r = ratings(club, res), rec = records(club, res);
  const table = [...members].sort((a, b) => r[b.id] - r[a.id]), myRank = table.findIndex((m) => m.id === "you") + 1;
  const challengeTo = (m) => go(`play?task=${startPlay(`Challenge ${first(m.name)} to a singles match this week`, you)}`);
  const standing = <Standing me={me} r={r} rec={rec} rank={myRank} of={table.length} ahead={table[myRank - 2]} />;
  const feed = [...g.mine.map((f) => ({ ...f, ago: f.at ? agoOf(f.at) : "today" })), ...club.feed];
  const cheer = (id) => setG((s) => ({ ...s, cheers: { ...s.cheers, [id]: !s.cheers[id] } }));
  const toggle = (k) => setG((s) => ({ ...s, shares: { ...s.shares, [k]: !s.shares[k] } }));
  const join = (f) => { setG((s) => ({ ...s, joined: { ...s.joined, [f.id]: true } })); postToClub({ kind: "game", text: `Joined ${first(byId[f.who].name)}'s game: ${f.open.day} ${f.open.start} at ${f.open.venue}.` }); };
  const send = (e) => { e.preventDefault(); const t = post.trim(); if (!t) return; postToClub({ kind: "note", text: t }); setPost(""); };

  return (
    <div className="page club feedview">
      <header className="report-head">
        <div>
          <span className="tag">{members.length} members · demo club</span>
          <h1 className="h1">{club.name}</h1>
          <p className="muted">Post a game or join one, challenge anyone and climb the club table; your agent does the organizing. Members make Serve better too: share an idea under Ideas. {club.note}</p>
        </div>
        <div className="cta-row">
          <a className="btn primary" href="#/play"><Icon name="book" size={18} />Find a game</a>
          <a className="btn ghost" href="#/goals"><Icon name="goals" size={18} />This week</a>
        </div>
      </header>

      <nav className="club-tabs" aria-label="Club">
        {[["feed", "Feed"], ["ranks", "Leaderboard"], ["challenges", "Challenges"], ["ideas", "Ideas"]].map(([k, l]) => <a key={k} href={k === "feed" ? "#/club" : `#/club?tab=${k}`} aria-current={tab === k ? "page" : undefined}>{l}</a>)}
      </nav>
      {tab === "ranks" && <>{standing}<Rankings club={club} members={members} r={r} rec={rec} onChallenge={challengeTo} /></>}
      {tab === "challenges" && <>{standing}<Challenges key={hash} club={club} members={members} r={r} rec={rec} g={g} you={you} me={me} /></>}
      {tab === "ideas" && <Ideas />}
      {tab === "feed" && <div className="club-grid">
        {/* the club feed, made by agents and people together (club/Feed.jsx, the gateway's feed/) */}
        <Feed club={club} members={club.members} local={g.mine} joined={g.joined || {}} onJoin={join}
          onChallenge={(m) => go(`play?task=${startPlay(`Challenge ${first(m.name)} to a singles match this weekend`, you)}`)} />

        <aside className="club-side">
          <section className="panel" aria-labelledby="l-h">
            <header className="club-h"><h2 id="l-h" className="panel-h">Top of the table</h2><a className="link" href="#/club?tab=ranks">Leaderboard</a></header>
            <ol className="league-list">
              {table.filter((m, i) => i < 5 || m.id === "you").map((m) => (
                <li key={m.id} className={m.id === "you" ? "me" : ""}>
                  <span className="mono rk">{table.indexOf(m) + 1}</span><Member m={m} size={32} />
                  <span className="lg-who"><b>{m.id === "you" ? "You" : m.name}</b><span className="tiny muted">{rec[m.id].w}–{rec[m.id].l} · level {m.level}</span></span>
                  <span className="lg-num"><b className="mono">{r[m.id]}</b><small>rating</small></span>
                </li>
              ))}
            </ol>
            <a className="btn primary sm" href="#/club?tab=challenges&spin=1"><Icon name="spark" size={16} />Draw a random match</a>
          </section>

          <section className="panel" aria-labelledby="s-h">
            <h2 id="s-h" className="panel-h">What the club sees</h2>
            <ul className="privacy-list">
              {[["goals", "Your weekly goal and streak"], ["progress", "How many games you play"], ["highlights", "Your highlight reels"], ["limits", "Health limits, as “avoids jumps” only"]].map(([k, l]) => (
                <li key={k}><label><input type="checkbox" checked={!!g.shares[k]} onChange={() => toggle(k)} />{l}</label></li>
              ))}
            </ul>
            <p className="tiny muted">Never shared: your chats with your agent, your memory, where you live or what an injury is. Your videos only with your yes. {limited && !g.shares.limits ? "With health limits off, the club will not know to keep you off jump landings." : ""}</p>
          </section>
        </aside>
      </div>}
    </div>
  );
}
function agoOf(t) { const s = (Date.now() - t) / 1000; return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min` : s < 86400 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} d`; }

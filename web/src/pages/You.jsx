import Icon from "../components/Icon.jsx";
import { memory } from "../memory.js";
import { readGame } from "../club/game.js";
import { useTasks } from "../tasks.js";
import PrivateCalendars from "../components/PrivateCalendars.jsx";
import MatchSettings from "../components/MatchSettings.jsx";

// You: the profile. Your games, your highlights, what your agent remembers.
export default function You({ club }) {
  const tasks = useTasks();
  const g = readGame();
  const games = (g.activity || []).filter((a) => a.kind === "game").length;
  const notes = memory.all().length;
  const booked = tasks.filter((t) => t.kind === "play" && t.booking && t.booking.state !== "cancelled");
  return (
    <div className="page you">
      <header className="you-head">
        <span className="mav you you-av" aria-hidden="true">You</span>
        <div>
          <h1 className="h1">You</h1>
          <p className="muted">Level {club?.you?.level || "B"}{club ? ` · ${club.name}` : ""}</p>
          <dl className="you-stats">
            <div><dd>{games}</dd><dt>{games === 1 ? "game booked" : "games booked"}</dt></div>
            <div><dd>{notes}</dd><dt>{notes === 1 ? "note to your agent" : "notes to your agent"}</dt></div>
          </dl>
        </div>
        <a className="btn primary" href="#/highlights"><Icon name="play" size={18} />Film a highlight</a>
      </header>

      {booked.length > 0 && (
        <section aria-labelledby="g-h" className="you-sec">
          <h2 id="g-h" className="sec-label">Your games</h2>
          <ul className="you-games">
            {booked.slice(0, 4).map((t) => { const o = t.booking.option; return (
              <li key={t.id}><a href={`#/${t.href}`}><b>{o.day} {o.start} · {o.format}</b><span className="tiny muted">{o.venue.name}, court {o.court} · {t.booking.state === "confirmed" ? "game on" : t.booking.state}</span></a></li>
            ); })}
          </ul>
        </section>
      )}

      {/* Settings, kept on your own server: one .setting row per component (finding a game has its own section,
          MatchSettings, below) */}
      <section aria-labelledby="s-h" className="you-sec">
        <h2 id="s-h" className="sec-label">Settings</h2>
        <div className="panel settings">
          <PrivateCalendars />
        </div>
      </section>

      <section aria-labelledby="o-h" className="you-sec">
        <h2 id="o-h" className="sec-label">Your data</h2>
        <ul className="view-grid plain">
          <li><a href="#/body"><Icon name="heart" size={22} /><span><b>Body log</b><span className="tiny muted">What hurts, your health app, your trail and report</span></span></a></li>
          <li><a href="#/memory"><Icon name="memory" size={22} /><span><b>Your memory</b><span className="tiny muted">What your agent remembers, and what to forget</span></span></a></li>
          <li><a href="#/about"><Icon name="info" size={22} /><span><b>About Serve</b><span className="tiny muted">How it works and what stays private</span></span></a></li>
        </ul>
      </section>
      <MatchSettings />
    </div>
  );
}

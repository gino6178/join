import { useEffect, useRef, useState } from "react";
import Agent from "./pages/Agent.jsx";
import Landing from "./pages/Landing.jsx";
import Club from "./pages/Club.jsx";
import Goals from "./pages/Goals.jsx";
import Play from "./pages/Play.jsx";
import You from "./pages/You.jsx";
import Autopilot from "./pages/Autopilot.jsx";
import Body from "./pages/Body.jsx";
import Courts from "./pages/Courts.jsx";
import Highlights from "./pages/Highlights.jsx";
import Memory from "./pages/Memory.jsx";
import Messages from "./pages/Messages.jsx";
import Maintain from "./pages/Maintain.jsx";
import { AskOutLoud } from "./voice/VoiceAsk.jsx";
import { loadClub } from "./club/data.js";
import { useTasks, plain } from "./tasks.js";
import Icon from "./components/Icon.jsx";
import Mark from "./components/Mark.jsx";

// Serve's shell: a sidebar on a computer and a tab bar on a phone, the way a social app has them. Five tabs (your
// agent, the club, play, goals and you), Messenger as the inbox, and the rest under More. Pages are picked by the
// address (#/club?tab=ranks); every page reads the demo club, which ships with the app (public/data/club.json).
const route = () => location.hash.replace(/^#\/?/, "").split("?")[0] || "home";
export function go(path) { location.hash = "/" + path; window.scrollTo(0, 0); }

const TABS = [
  { k: "home", label: "Agent", icon: "spark", on: ["home", "autopilot"] },
  { k: "club", label: "Club", icon: "coaches", on: ["club"] },
  { k: "play", label: "Play", icon: "book", on: ["play", "courts"] },
  { k: "goals", label: "Goals", icon: "goals", on: ["goals"] },
  { k: "you", label: "You", icon: "you", on: ["you", "body", "memory", "highlights", "match"] },
];
const INBOX = { k: "messages", label: "Messenger", icon: "send", on: ["messages"] };
const MORE = [
  { k: "autopilot", label: "Autopilot", note: "Your agent lines up your week", icon: "spark" },
  { k: "body", label: "Body log", note: "Tell your agent what hurts; your health app", icon: "heart" },
  { k: "courts", label: "Courts near you", note: "Any sport, judged from reviews and weather", icon: "pin" },
  { k: "highlights", label: "Film a highlight", note: "Your own video, as a reel to post", icon: "play" },
  { k: "memory", label: "Your memory", note: "What your agent remembers", icon: "memory" },
  { k: "messages", label: "Serve in Messenger", note: "Your agent, in your chats", icon: "chat" },
  { k: "about", label: "About Serve", note: "Why it exists, how it works", icon: "info" },
];
const href = (k) => `#/${k === "home" ? "" : k}`;
const THEME = "shuttlecoach.theme";

// a menu that closes on Escape, on a click outside it and on navigation
function useMenu() {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return;
    const key = (e) => e.key === "Escape" && setOpen(false), click = (e) => !box.current?.contains(e.target) && setOpen(false), nav = () => setOpen(false);
    addEventListener("keydown", key); addEventListener("pointerdown", click); addEventListener("hashchange", nav);
    return () => { removeEventListener("keydown", key); removeEventListener("pointerdown", click); removeEventListener("hashchange", nav); };
  }, [open]);
  return [open, setOpen, box];
}
function useTheme() {
  const [t, setT] = useState(() => { try { return localStorage.getItem(THEME) || "system"; } catch { return "system"; } });
  useEffect(() => {
    if (t === "system") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
    try { if (t === "system") localStorage.removeItem(THEME); else localStorage.setItem(THEME, t); } catch { /* this visit only */ }
  }, [t]);
  return [t, setT];
}

function Shell({ page, club }) {
  const cur = (it) => (it.on ?? [it.k]).includes(page) ? "page" : undefined;
  const [more, setMore, moreBox] = useMenu();
  const [theme, setTheme] = useTheme();
  const tasks = useTasks();
  const needs = tasks.filter((t) => t.state === "needs").length, busy = tasks.some((t) => t.state === "running");
  const badge = (it) => it.k === "home" && (needs ? <em className="nav-count" aria-label={`${needs} need you`}>{needs}</em> : busy ? <i className="nav-busy" aria-label="working" /> : null);
  return (
    <>
      <header className="side">
        <a className="brand" href="#/" aria-label="Serve, your agent"><Mark /><span>serve</span></a>
        <nav className="side-nav" aria-label="Main">
          {[...TABS, INBOX].map((it) => (
            <a key={it.k} href={href(it.k)} aria-current={cur(it)} title={it.label} className={it === INBOX ? "inbox" : ""}>
              <Icon name={it.icon} size={24} /><span className="lbl">{it.label}</span>{badge(it)}
            </a>
          ))}
        </nav>
        <div className="side-tools">
          <a className="btn primary side-new" href="#/play" title="Find a game: your agent finds the court and the people"><Icon name="book" size={18} /><span className="lbl">Find a game</span></a>
          <AskOutLoud />
          <a className="icon-btn side-inbox" href="#/messages" aria-label="Messenger" aria-current={cur(INBOX)}><Icon name="send" size={20} /></a>
          <div className="side-more" ref={moreBox}>
            <button className="side-more-btn" aria-expanded={more} aria-haspopup="true" aria-label="More" onClick={() => setMore(!more)}>
              <Icon name="menu" size={22} /><span className="lbl">More</span>
            </button>
            {more && (
              <div className="more-pop" role="menu">
                {MORE.map((it) => <a key={it.k} role="menuitem" href={href(it.k)} aria-current={cur(it)}><Icon name={it.icon} /><span><b>{it.label}</b><em>{it.note}</em></span></a>)}
                <div className="more-theme" role="group" aria-label="Theme">
                  <span><Icon name="sun" size={18} />Theme</span>
                  <div className="seg sm" role="radiogroup" aria-label="Theme">
                    {[["system", "System"], ["light", "Light"], ["dark", "Dark"]].map(([k, l]) => <button key={k} role="radio" aria-checked={theme === k} onClick={() => setTheme(k)}>{l}</button>)}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
        <p className="side-status" title="Every agent runs on Muse Glimmer on a GPU you own; your videos, body log and memory never leave it"><i aria-hidden="true" /><span className="lbl">Muse Glimmer · your server</span></p>
      </header>
      <nav className="tabbar" aria-label="Main">
        {TABS.map((it) => <a key={it.k} href={href(it.k)} aria-current={cur(it)}><span className="tab-ic"><Icon name={it.icon} size={24} />{badge(it)}</span><span>{it.label}</span></a>)}
      </nav>
    </>
  );
}

// when a job finishes while the player is elsewhere, say so, with a way to open it
function CheckBack() {
  const tasks = useTasks();
  const seen = useRef(null), [note, setNote] = useState(null);
  useEffect(() => {
    if (!seen.current) { seen.current = Object.fromEntries(tasks.map((t) => [t.id, t.state])); return; }
    for (const t of tasks) {
      const was = seen.current[t.id];
      // the agent home lists every job, so it needs no check-back; neither does the page the job belongs to
      if (was && was !== t.state && t.state !== "running" && route() !== "home" && !location.hash.includes(t.id) && route() !== (t.href || "").split(/[?/]/)[0]) setNote(t);
      seen.current[t.id] = t.state;
    }
  }, [tasks]);
  useEffect(() => { if (!note) return; const id = setTimeout(() => setNote(null), 7000); return () => clearTimeout(id); }, [note]);
  if (!note) return null;
  return (
    <div className="toast checkback" role="status">
      <span className="agent-dot" aria-hidden="true" />
      <span><b>{note.state === "needs" ? "Needs you" : note.state === "failed" ? "Couldn't finish" : "Done"}</b> {plain(note.summary || note.error || note.title)}</span>
      {note.href && <a className="btn sm primary" href={`#/${note.href}`} onClick={() => setNote(null)}>Open</a>}
      <button className="icon-btn sm" aria-label="Dismiss" onClick={() => setNote(null)}><Icon name="close" size={16} /></button>
    </div>
  );
}

// (#/match was the old address of the highlight reel: it opens Highlights)
const PAGES = {
  home: (c) => <Agent club={c} />, about: () => <Landing />, club: (c) => <Club club={c} />, goals: (c) => <Goals club={c} />,
  play: (c) => <Play data={c} />, you: (c) => <You club={c} />, autopilot: (c) => <Autopilot data={c} />, body: () => <Body />,
  courts: () => <Courts />, highlights: () => <Highlights />, match: () => <Highlights />, memory: () => <Memory />, messages: () => <Messages />, maintain: () => <Maintain />,
};

export default function App() {
  const [page, setPage] = useState(route());
  const [club, setClub] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    const on = () => setPage(route());
    addEventListener("hashchange", on);
    loadClub().then(setClub).catch((e) => setErr(`The club could not be loaded (${e.message}).`));
    return () => removeEventListener("hashchange", on);
  }, []);
  const show = PAGES[page] || PAGES.home;
  return (
    <>
      <Shell page={page} club={club} />
      <main>
        {err && <p className="page muted" role="alert">{err}</p>}
        {show(club)}
      </main>
      <CheckBack />
    </>
  );
}

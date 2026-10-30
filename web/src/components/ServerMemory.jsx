import { useEffect, useState } from "react";
import { agentNotes, agentRemember, agentForgetNote, agentForgetNotes, agentForgetAbout, agentPlayers } from "../agent.js";
import Icon from "./Icon.jsx";
import "./webfeat.css";

const day = (t) => new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const short = (d) => new Date(`${d}T12:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
// the rule a note asks the Autopilot to keep, in words
const ruleText = (r, until) => `${r.kind === "avoid_person" ? `Leaves ${r.name || r.who} out` : `No games on ${r.day}`}${until ? ` until ${short(until)}` : ""}`;
// What your agent remembers on your server (memory.js, through /api/memory): short notes of what you told it, in
// Messenger or here, found again by meaning. The Autopilot follows them (a person, a time or a place you asked it to
// avoid), and keeps the rules in them by code. A newer note that changes an older one replaces it (Muse Glimmer
// decides, code checks); the older one stays here struck through, as does a note past its last day, and neither is
// followed any more. Each chat's notes are its own; deleting one, the ones about a person or topic, or all works as
// /forget does for notes.
export default function ServerMemory() {
  const [chats, setChats] = useState([]), [who, setWho] = useState("app");
  const [st, setSt] = useState({ phase: "loading", notes: [], error: null, finds: null, on: true });
  const [text, setText] = useState(""), [said, setSaid] = useState(""), [busy, setBusy] = useState(false), [confirm, setConfirm] = useState(false);
  const [about, setAbout] = useState(""), [showOld, setShowOld] = useState(true);
  useEffect(() => { agentPlayers().then((ps) => setChats(ps.map((p) => ({ id: p.id, name: p.name })))).catch(() => {}); }, []);
  const load = (p = who) => agentNotes(p).then((r) => setSt({ phase: "ready", notes: r.notes, finds: r.finds, on: r.on, error: null })).catch((e) => setSt((s) => ({ ...s, phase: "error", error: e.message })));
  useEffect(() => { setSt((s) => ({ ...s, phase: "loading" })); setConfirm(false); setSaid(""); load(who); }, [who]);
  const act = async (fn, done) => { setBusy(true); try { const r = await fn(); setSt({ phase: "ready", notes: r.notes, finds: r.finds, on: r.on, error: null }); done?.(r); } catch (e) { setSaid(`Your server did not answer (${e.message}).`); } finally { setBusy(false); } };
  const tell = (e) => {
    e.preventDefault(); const t = text.trim(); if (!t) return;
    act(() => agentRemember(t), (r) => {
      if (!r.kept) return setSaid(r.reply || "Not kept.");
      setText("");
      const mine = r.notes.find((n) => n.text === t), replaced = mine ? r.notes.filter((n) => n.status === "replaced" && n.replacedBy === t) : [];
      setSaid(replaced.length ? `Noted, and it replaces ${replaced.length === 1 ? "an older note" : `${replaced.length} older notes`}. The Autopilot follows the new one from its next run.` : "Noted. The Autopilot follows it from its next run.");
    });
  };
  const forgetAbout = (e) => {
    e.preventDefault(); const a = about.trim(); if (!a) return;
    act(() => agentForgetAbout(a, who), (r) => { setAbout(""); setSaid(r.forgotten?.length ? `Forgotten: ${r.forgotten.length} note${r.forgotten.length > 1 ? "s" : ""} about ${a}, deleted from your server. The rest stay.` : `No notes about ${a}.`); });
  };
  const name = who === "app" ? null : chats.find((c) => c.id === who)?.name;
  const old = st.notes.filter((n) => n.status && n.status !== "live"), shown = showOld ? st.notes : st.notes.filter((n) => !n.status || n.status === "live");
  return (
    <section className="panel sm-panel" aria-labelledby="srv-h">
      <div className="sm-head">
        <h2 id="srv-h" className="panel-h">On your server: what your agent remembers</h2>
        {st.phase === "ready" && st.notes.length > 0 && (confirm
          ? <span className="tiny">Forget all {st.notes.length}{name ? ` from ${name}'s chat` : ""}? <button className="link danger" disabled={busy} onClick={() => act(() => agentForgetNotes(who), () => { setConfirm(false); setSaid("Forgotten: those notes are deleted from your server."); })}>Forget all</button> · <button className="link" onClick={() => setConfirm(false)}>Keep</button></span>
          : <button className="link" onClick={() => setConfirm(true)}>Forget all</button>)}
      </div>
      <p className="small muted">Short notes of what you told your agent. When the Autopilot plans your week it looks up the closest ones and follows them: a person, a time or a place you asked it to avoid. When a newer note changes an older one ("Tomás is fine again"), the older one is struck through and no longer followed. {st.finds === "words" ? "On this server they are found by their words." : st.finds === "off" ? "Memory is switched off on this server." : "They are found by meaning, on your own server."}</p>
      {chats.length > 0 && (
        <div className="seg sm" role="radiogroup" aria-label="Whose notes">
          <button role="radio" aria-checked={who === "app"} onClick={() => setWho("app")}>This app</button>
          {chats.map((c) => <button key={c.id} role="radio" aria-checked={who === c.id} onClick={() => setWho(c.id)}>Messenger · {c.name}</button>)}
        </div>
      )}
      {who === "app" && st.on && (
        <form className="sm-tell" onSubmit={tell}>
          <label htmlFor="srv-text" className="sr-only">Tell your agent</label>
          <input id="srv-text" value={text} onChange={(e) => setText(e.target.value)} maxLength={400} placeholder="e.g. Leave Tomás out for a while" />
          <button className="btn primary sm" disabled={!text.trim() || busy}>Tell your agent</button>
        </form>
      )}
      {st.phase === "ready" && st.notes.length > 0 && (
        <div className="sm-tools">
          <form className="sm-forget" onSubmit={forgetAbout}>
            <label htmlFor="srv-about" className="sr-only">Forget what you said about</label>
            <input id="srv-about" value={about} onChange={(e) => setAbout(e.target.value)} maxLength={200} placeholder="Forget what I said about… (a person, a place, a topic)" />
            <button className="btn ghost sm" disabled={!about.trim() || busy}>Forget</button>
          </form>
          {old.length > 0 && <button className="link" aria-pressed={showOld} onClick={() => setShowOld((v) => !v)}>{showOld ? `Hide replaced and expired (${old.length})` : `Show replaced and expired (${old.length})`}</button>}
        </div>
      )}
      {said && <p className="tiny muted" role="status">{said}</p>}
      {st.phase === "loading" && !st.notes.length && <p className="tiny muted">Loading what your server keeps…</p>}
      {st.phase === "error" && <p className="tiny muted" role="alert">Your server did not answer ({st.error}). The notes on this device are below.</p>}
      {st.phase === "ready" && !st.notes.length && <p className="tiny muted">{who === "app" ? "Nothing yet. What you tell your agent in Messenger is kept in that chat's notes; here, use the box above." : "Nothing kept from this chat."}</p>}
      {shown.length > 0 && (
        <ul className="sm-notes">
          {shown.map((n) => {
            const gone = n.status === "replaced" || n.status === "expired";
            return (
              <li key={n.id} className={gone ? "sm-old" : undefined}>
                <p>{n.text}</p>
                <span className="tiny muted">{day(n.at)} · {n.kind === "said" ? (who === "app" ? "you told your agent here" : "you said in Messenger") : n.kind}{n.status === "replaced" ? " · replaced, no longer followed" : n.status === "expired" ? ` · ended ${short(n.until)}, no longer followed` : n.until ? ` · until ${short(n.until)}` : ""}</span>
                {n.rule && <span className={`sm-rule${gone ? " off" : ""}`}><Icon name={gone ? "close" : "check"} size={12} />Autopilot: {ruleText(n.rule, n.until)}</span>}
                {n.status === "replaced" && n.replacedBy && <p className="sm-why">Replaced on {day(n.replacedAt)} by “{n.replacedBy}”</p>}
                <button className="icon-btn sm" aria-label={`Delete from your server: ${n.text}`} disabled={busy} onClick={() => act(() => agentForgetNote(n.id, who), () => setSaid("Deleted from your server."))}><Icon name="close" size={16} /></button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

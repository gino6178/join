import { useState, useEffect } from "react";
import { AGENT_URL, agentPlayers, agentRemind, agentSafety, agentStatus } from "../agent.js";
import Mark from "../components/Mark.jsx";
import SafetyList from "../components/Safety.jsx";
import "./messages.css";
// Serve in Messenger: your agent in your chats, through a Facebook Page on the Messenger Platform. The status of the
// model and the Page, the steps to connect a real Page, and each linked player: what the agent learned, their
// calendar and body log, and the conversation itself.
// a time as the page shows it: "28 Oct, 19:05"
const STAMP = { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" };
const when = (t) => new Date(t).toLocaleString("en-GB", STAMP);
const EVERY_MS = 5000; // how often the page asks the gateway again
// The gateway's status and its players, asked for now and every few seconds while the page is open, then each chat's
// own safety checks (what was checked, the verdict, what happened; never the text). A failed ask keeps what was shown
// and says why; a chat whose checks the server does not give has null.
const checksOf = (ps) => Promise.all(ps.map((p) => agentSafety(p.id, 12).then((r) => [p.id, r.checks]).catch(() => [p.id, null])));
const useGateway = () => {
  const [seen, setSeen] = useState({ st: null, ps: [], err: null, checks: {} });
  useEffect(() => {
    const ask = () => Promise.all([agentStatus(), agentPlayers()])
      .then(async ([st, ps]) => { setSeen((s) => ({ ...s, st, ps, err: null })); const checks = Object.fromEntries(await checksOf(ps)); setSeen((s) => ({ ...s, checks })); })
      .catch((e) => setSeen((s) => ({ ...s, err: e.message })));
    ask();
    const timer = setInterval(ask, EVERY_MS);
    return () => clearInterval(timer);
  }, []);
  return seen;
};
// the three readings at the top: the model, the Page, and how many players are linked
const Status = ({ st, llm, ms }) => (
  <dl className="status-strip" aria-label="Status"><div><dt>Model</dt><dd><span className={llm?.ready ? "ok" : "bad"}>{llm ? (llm.ready ? "Ready" : "Not ready") : "…"}</span></dd>
      <dd>{[llm?.model ?? "", llm?.device ? `on ${llm.device}` : ""].join(" ")}{llm?.error ? ` · ${llm.error}` : ""}</dd></div>
    <div><dt>Messenger</dt><dd><span className={ms?.enabled ? "ok" : "bad"}>{ms?.enabled ? ms.page || "Page connected" : "Not set up"}</span></dd>
      <dd>{ms?.enabled ? (ms.lastEvent ? `Last message ${when(ms.lastEvent)}` : "Waiting for the first message") : ms?.error ?? "Needs a Page token."}</dd></div>
    <div><dt>Players linked</dt><dd>{st?.players ?? "–"}</dd><dd>/forget deletes everything stored about a player.</dd></div></dl>
);
// Until someone has linked, the steps to get there, each ticked once the gateway reports it done.
const Setup = ({ steps }) => (
  <section className="panel"><h2 className="panel-h">Connect a Page</h2>
    <p className="muted small">Ticks appear as each step is detected.</p>
    <ol className="setup">{steps.map(({ done, t }, k) => <li key={k} className={done ? "done" : ""}><span>{t}</span></li>)}</ol></section>
);
// One linked player: what was learned and what is coming up, beside the conversation as Messenger had it.
const Player = ({ p, checks }) => (
  <section className="panel msg-player">
    <header><h3>{p.name}</h3><span className="tiny muted">chat {p.id} · {p.events.length} in the calendar · {p.body?.log?.length || 0} body log entries · {p.body?.workouts?.length || 0} workouts</span></header>
    <div className="msg-grid"><div>
      <h4>Learned from your chats</h4>
      {p.memories.length > 0 ? <ul className="msg-mem">{p.memories.map(({ text, at }, k) => <li key={k}>{text}<span className="tiny muted"> · {when(at)}</span></li>)}</ul> : <p className="tiny muted">Nothing yet.</p>}
      <h4>Coming up</h4>
      {p.events.length ? <ul className="msg-mem">{p.events.slice(0, 6).map((e) => <li key={e.id}>{e.date} {e.start} {e.title}</li>)}</ul> : <p className="tiny muted">Nothing in the calendar.</p>}
      <h4>Safety checks</h4>
      {checks ? <SafetyList checks={checks} limit={6} empty="No message checked yet." /> : <p className="tiny muted">Not available from this server.</p>}
      <p className="tiny muted">Every message goes past Llama Guard 3 before your agent acts on it, and every answer a model writes before it is sent. Only the verdict is kept, never the words. What you told your agent is under <a href="#/memory">Your memory</a>.</p>
    </div><div className="msg-log">
      {p.history.map((h, k) => (
        <div key={k} className={`chat-msg ${h.role}`} style={{ "--cc": "var(--agent)" }}>
          {h.role === "assistant" ? <span className="chat-agent" aria-hidden="true"><Mark size={18} /></span> : <span />}
          <div><p>{h.content}</p>{h.role === "assistant" && <span className="tiny chat-meta">{h.verified ? "✓ checked" : "⚠ not checked"} · {when(h.at)}</span>}</div>
        </div>))}</div></div></section>
); // Player
const Messages = () => {
  const { st, ps, err, checks } = useGateway();
  const [msg, setMsg] = useState("");
  const llm = st?.llm, ms = st?.messenger;
  const steps = [ // what is still needed before players can chat, in this order
    { done: !err && !!st, t: <>The gateway runs on your GPU server ({AGENT_URL}).</> },
    { done: !!llm?.ready, t: <>Muse Glimmer is loaded ({llm?.model ?? "muse-glimmer"}).</> },
    { done: !!ms?.enabled, t: <>A Facebook Page and a Meta app with Messenger: the Page token, the app secret and a verify token go in <code>agent/.env</code>; the app's webhook points at <code>https://your-tunnel/webhook/messenger</code>, subscribed to messages and postbacks.</> },
    { done: ps.length > 0, t: <>Send the Page a message. The first message links you; with standard access, only people with a role in the app (admins, developers, testers) can.</> }];
  const sendToday = () => agentRemind().then((r) => setMsg(`Today's calendar sent to ${r.sent.length} player(s).`)).catch((e) => setMsg(e.message));
  return <div className="page messages">
    <header className="report-head"><div>
      <span className="tag">Serve in Messenger · Muse Glimmer</span>
      <h1 className="h1">Your agent, in your chats</h1>
      <p className="muted">"Want a game?" when your usual time is open, with a tap to say yes; the week lined up and approved with a tap; a reminder an hour before every game and a check-in after; what hurts; a health export shared into the chat; courts near a place. Every reply is written by Muse Glimmer on your own server and checked before it is sent.</p>
    </div><div className="cta-row"><button className="btn ghost" disabled={!ps.length} onClick={sendToday}>Send today's calendar now</button></div></header>
    {err ? <div className="notice" role="alert"><b>Agent gateway not reachable</b> at {AGENT_URL} ({err}).</div> : null}
    {msg ? <p className="tiny muted" role="status">{msg}</p> : null}
    <Status st={st} llm={llm} ms={ms} />
    {ps.length ? null : <Setup steps={steps} />}
    {ps.map((p) => <Player key={p.id} p={p} checks={checks[p.id]} />)}
  </div>;
};
export default Messages;

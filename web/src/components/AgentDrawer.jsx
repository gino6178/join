import { useEffect, useRef, useState } from "react";
import { api, money, dayLabel } from "../api.js";
import { useWorld } from "./Actor.jsx";
import Icon from "./Icon.jsx";
import PayPalButtons from "./PayPalButtons.jsx";
import { byRules, byQwen, loadQwen, qwenReady, webgpu, missing, ASK, MODEL } from "../scout/understand.js";
import { search, negotiate, acceptDeal, walkAway, alternatives } from "../scout/agent.js";

// Join's website agent, for people who don't have an agent of their own. It asks what they want (activity, day, how
// many, budget), then does what any agent does on Join, as them and under their limits: finds options, haggles,
// accepts. The person approves the payment in PayPal themselves. The understanding runs in this browser: Qwen on WebGPU
// if they choose to download it, otherwise plain rules. Everything it does shows up on the Activity page like any agent's.
const EXAMPLES = ["Karaoke Friday night, 4 of us, $15 each", "Badminton this weekend with 3 friends", "週六晚上 5 個人吃火鍋 每人 20 塊", "An escape room tomorrow for 4"];

export default function AgentDrawer({ me, open, onClose }) {
  const w = useWorld();
  const [msgs, setMsgs] = useState([{ from: "agent", text: `Hi ${me.player.name.split(" ")[0]}. Tell me what you'd like to do with friends, and I'll find a time and a place, haggle with the venue, and get it ready for PayPal.` }]);
  const [brief, setBrief] = useState({});
  const [text, setText] = useState(""), [busy, setBusy] = useState(false);
  const [qwen, setQwen] = useState(qwenReady() ? "ready" : "off"), [progress, setProgress] = useState(null);
  const [cards, setCards] = useState(null), [deal, setDeal] = useState(null), [pending, setPending] = useState(null), [booking, setBooking] = useState(null);
  const end = useRef(null);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [msgs, cards, deal, booking]);
  const model = qwen === "ready" ? "qwen" : "rules";
  const say = (t) => setMsgs((m) => [...m, { from: "agent", text: t }]);
  const ctx = () => ({ activities: w.activities, people: w.players.filter((p) => p.id !== me.player.id), today: new Date(), me: me.player.name });

  const startQwen = async () => {
    setQwen("loading");
    try { await loadQwen((p) => setProgress(p)); setQwen("ready"); say("Qwen is running in your browser now. Nothing you type here leaves it for this part."); }
    catch (e) { setQwen("failed"); say(`Qwen couldn't start here (${e.message}). I'll keep using simple rules.`); }
    setProgress(null);
  };

  const send = async (t = text) => {
    if (!t.trim() || busy || !w) return;
    const history = [...msgs, { from: "me", text: t }];
    setMsgs(history); setText(""); setBusy(true); setCards(null);
    try {
      let next = brief, reply = "";
      if (qwen === "ready") {
        try { ({ brief: next, reply } = await byQwen(history.filter((m) => m.text).map((m) => ({ role: m.from === "me" ? "user" : "assistant", content: m.text })), brief, ctx())); }
        catch { next = byRules(t, brief, ctx()); }
      } else next = byRules(t, brief, ctx());
      setBrief(next);
      const gap = missing(next);
      if (gap.length) { say(reply && qwen === "ready" ? reply : ASK[gap[0]]); return; }
      say(reply && qwen === "ready" ? reply : `Looking for ${next.activity} for ${next.players + 1}${next.budget ? `, about ${money(next.budget)} each` : ""}…`);
      const r = await search(next, model);
      if (r.error) { say(r.error); return; }
      if (!r.options.length) { say(r.note || "Nothing fits. Try another day or a smaller group."); return; }
      say(`Here ${r.options.length === 1 ? "is one option" : `are ${r.options.length} options`}. Your limit is ${money(r.limit)} a person. Pick one and I'll negotiate.`);
      setCards(r.options);
    } finally { setBusy(false); }
  };

  const choose = async (o) => {
    setCards(null); setBusy(true); setPending(null);
    try {
      say(`Talking to ${o.venueName} about ${dayLabel(o.date)} ${o.start}…`);
      const r = await negotiate(o, brief, model, say);
      await finish(r, o);
    } finally { setBusy(false); }
  };
  const finish = async (r, o) => {
    if (r.deal) {
      setDeal(r.deal);
      say(`Deal: ${money(r.deal.agreed.amount)} in total, ${money(r.deal.agreed.share)} each. ${r.deal.venueName} holds it while you guarantee the booking in PayPal; your friends' agents are asked to pay their shares.`);
      for (let i = 0; i < 10; i++) {
        const g = await api("/api/games").catch(() => null), b = g?.bookings.find((x) => x.negotiation === r.deal.id);
        if (b && (b.you?.approveUrl || b.you?.status === "authorized" || b.state !== "awaiting_organizer")) { setBooking(b); return; }
        await new Promise((ok) => setTimeout(ok, 700));
      }
      return;
    }
    if (r.pending) { setPending({ n: r.pending, o }); say(`${r.note} Accept anyway, or should I look elsewhere?`); return; }
    say(r.error || "That didn't work.");
    const alts = r.alternatives || (o ? (await alternatives(o, brief, model)).alternatives : null);
    if (alts?.length) say(`Other places then: ${alts.slice(0, 3).map((a) => `${a.name} (${a.bookable === false ? "free" : `$${a.share} each`})`).join(", ")}. The Map page shows them.`);
  };

  const reset = () => { setBrief({}); setCards(null); setDeal(null); setPending(null); setBooking(null); say("Starting over. What would you like to do?"); };
  if (!open) return null;
  return (
    <aside className="drawer" role="dialog" aria-label="Join's website agent">
      <header className="drawer-head">
        <span><b><Icon name="spark" size={16} /> Join's agent</b><small>{qwen === "ready" ? `${MODEL}, running in your browser` : "Simple rules in your browser · no AI model yet"}</small></span>
        <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="close" size={18} /></button>
      </header>
      {qwen !== "ready" && <div className="drawer-model">
        {qwen === "loading" ? <><p className="small">Downloading Qwen to your browser{progress ? `: ${Math.round((progress.progress || 0) * 100)}%` : "…"}</p><progress max="1" value={progress?.progress || 0} /></>
          : qwen === "failed" ? <p className="small">Qwen couldn't run on this device's GPU, so the agent uses simple rules. Say the activity, the day, how many people and a budget.</p>
          : webgpu() ? <p className="small">Want it to understand anything you write, in any language? <button className="link" onClick={startQwen}>Use Qwen in your browser</button> (about 1 GB, once; no key, nothing sent to an AI service).</p>
          : <p className="small">This browser has no WebGPU, so the agent uses simple rules. Say the activity, the day, how many people and a budget.</p>}
      </div>}
      <div className="drawer-body">
        {msgs.map((m, i) => <p key={i} className={`bubble ${m.from}`}>{m.text}</p>)}
        {msgs.length === 1 && <div className="chips">{EXAMPLES.map((e) => <button key={e} className="chip" onClick={() => send(e)}>{e}</button>)}</div>}
        {cards?.map((o, i) => <div key={i} className={`rec ${o.over ? "over" : ""}`}>
          <b>{o.venueName}</b><span className="muted small">{dayLabel(o.date)} · {o.start} · {o.minutes} min</span>
          <span>{o.names.map((n) => n.split(" ")[0]).join(", ")}</span>
          <span><b>{money(o.askPrice)}</b> asked · {money(o.share)} each{o.over ? " · over your budget, I'll haggle" : ""}</span>
          <small className="muted">{o.why.join(" · ")}</small>
          <button className="btn primary small" disabled={busy} onClick={() => choose(o)}>Negotiate this</button>
        </div>)}
        {pending && <div className="drawer-actions">
          <button className="btn primary small" disabled={busy} onClick={async () => { setBusy(true); const p = pending; setPending(null); await finish(await acceptDeal(p.n, model), p.o); setBusy(false); }}>Accept {money(pending.n.ask)}</button>
          <button className="btn small" disabled={busy} onClick={async () => { setBusy(true); const p = pending; setPending(null); await walkAway(p.n, model); await finish({ error: "I walked away." }, p.o); setBusy(false); }}>Look elsewhere</button>
        </div>}
        {booking && <div className="rec">
          {booking.you?.status === "authorized" ? <p><Icon name="verify" size={14} /> PayPal authorized your guarantee ({booking.you.via}).</p>
            : booking.you?.approveUrl ? <><b>Guarantee {money(booking.you.authorized)} in PayPal</b><PayPalButtons bookingId={booking.id} orderId={booking.you.orderId} approveUrl={booking.you.approveUrl} onDone={() => say("Approved. Join authorized it with PayPal; nothing is captured until everyone has paid.")} /></>
            : <p>{booking.state}</p>}
          <a className="btn small" href={`#/games?booking=${booking.id}`} onClick={onClose}>See the booking</a>
        </div>}
        {busy && <p className="bubble agent typing">…</p>}
        <div ref={end} />
      </div>
      <form className="drawer-input" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. hot pot Saturday evening for 5" disabled={busy} aria-label="Message" />
        <button className="btn primary small" disabled={busy || !text.trim()}>Send</button>
        {(deal || Object.keys(brief).length > 0) && <button type="button" className="btn ghost small" onClick={reset}>New plan</button>}
      </form>
    </aside>
  );
}

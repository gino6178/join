import { useEffect, useRef, useState } from "react";
import { api, money } from "../api.js";
import { useWorld } from "./Actor.jsx";
import Icon from "./Icon.jsx";
import PayPalButtons from "./PayPalButtons.jsx";
import { search, negotiate, acceptDeal, walkAway, alternatives, each } from "../scout/agent.js";
import { WORDS, langOf } from "../scout/words.js";

// Join's website agent, for people who don't have an agent of their own. It asks what they want (activity, day, how
// many, budget), then does what any agent does on Join, as them and under their limits: finds options, haggles,
// accepts. The person approves the payment in PayPal themselves. Join's server understands what they write (Qwen2.5 0.5B
// on Join's own machine, or rules); nothing is downloaded. It answers in the language the person writes in. Everything
// it does shows up on the Activity page like any agent's.
const EXAMPLES = ["Karaoke Friday night, 4 of us, $15 each", "Badminton this weekend with 3 friends", "週六晚上 5 個人吃火鍋 每人 20 塊", "An escape room tomorrow for 4"];

export default function AgentDrawer({ me, info, open, onClose }) {
  const world = useWorld();
  const [lang, setLang] = useState("en"), w = WORDS[lang];
  const [msgs, setMsgs] = useState([{ from: "agent", text: WORDS.en.hello(me.player.name.split(" ")[0]) }]);
  const [brief, setBrief] = useState({});
  const [text, setText] = useState(""), [busy, setBusy] = useState(false);
  const [cards, setCards] = useState(null), [deal, setDeal] = useState(null), [pending, setPending] = useState(null), [booking, setBooking] = useState(null), [confirm, setConfirm] = useState(null);
  const [model, setModel] = useState(info?.scout || "rules");
  const end = useRef(null);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [msgs, cards, deal, booking]);
  const say = (t) => setMsgs((m) => [...m, { from: "agent", text: t }]);
  const firstName = (id) => world?.players.find((p) => p.id === id)?.name.split(" ")[0] || id;

  const send = async (t = text) => {
    if (!t.trim() || busy || !world) return;
    const l = langOf(t, lang), W = WORDS[l];
    const history = [...msgs, { from: "me", text: t }];
    setLang(l); setMsgs(history); setText(""); setBusy(true); setCards(null);
    try {
      const u = await api("/api/scout/understand", { method: "POST", body: { brief, lang: l, history: history.slice(1).map((m) => ({ role: m.from === "me" ? "user" : "assistant", content: m.text })) } });
      const next = u.brief;
      setBrief(next); setModel(u.model);
      say(u.reply);
      if (u.missing.length) return;
      const r = await search(next, u.model, W);
      if (r.error) { say(r.error); return; }
      if (next.budget != null && next.budget > r.limit) say(W.overLimit(next.budget, r.limit));
      if (!r.options.length) { say(W.nothing({ ...next, players: next.players }, W.likes(next.activity))); return; }
      say(W.options(r.options.length, r.cap));
      setCards(r.options);
    } catch (e) { say(W.wrong(e.message)); } finally { setBusy(false); }
  };

  // before negotiating, the person hears what a deal would commit them to, and says yes
  const ask = (o) => {
    const people = o.players.length, cap = each(brief, o.limit);
    setCards(null); setPending(null); setConfirm(o);
    say(w.confirm(o.venueName, cap * people, cap, people));
  };
  const choose = async (o) => {
    setConfirm(null); setBusy(true);
    try {
      say(w.talking(o.venueName, o.date, o.start));
      await finish(await negotiate(o, brief, model, say, w), o);
    } finally { setBusy(false); }
  };
  const finish = async (r, o) => {
    if (r.deal) {
      setDeal(r.deal);
      const k = r.deal.players.length, t = Math.round(+r.deal.agreed.amount * 100);
      say(w.deal(r.deal.agreed.amount, (t - Math.floor(t / k) * (k - 1)) / 100, r.deal.venueName));
      for (let i = 0; i < 10; i++) {
        const g = await api("/api/games").catch(() => null), b = g?.bookings.find((x) => x.negotiation === r.deal.id);
        if (b && (b.you?.approveUrl || b.you?.status === "authorized" || b.state !== "awaiting_organizer")) { setBooking(b); return; }
        await new Promise((ok) => setTimeout(ok, 700));
      }
      return;
    }
    if (r.pending) { setPending({ n: r.pending, o }); say(r.note); return; }
    say(r.error || w.failed);
    // what else there is at that time, within what the person may pay; if nothing, say so and what they can change
    const alts = (r.alternatives || (o ? (await alternatives(o, brief, model)).alternatives : null) || []).filter((a) => a.venue !== o?.venue && a.withinBudget !== false);
    say(alts.length ? w.others(alts.slice(0, 3).map(w.other)) : w.noOthers(brief.activity, each(brief, o?.limit ?? brief.budget ?? 0)));
  };

  const reset = () => { setBrief({}); setCards(null); setDeal(null); setPending(null); setBooking(null); setConfirm(null); say(w.reset); };
  if (!open) return null;
  return (
    <aside className="drawer" role="dialog" aria-label="Join's website agent">
      <header className="drawer-head">
        <span><b><Icon name="spark" size={16} /> Join's agent</b><small>{model === "rules" ? "Simple rules on Join's server" : `Qwen (${model}) on Join's own server · no AI service, no key`}</small></span>
        <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="close" size={18} /></button>
      </header>
      <div className="drawer-body">
        {msgs.map((m, i) => <p key={i} className={`bubble ${m.from}`}>{m.text}</p>)}
        {msgs.length === 1 && <div className="chips">{EXAMPLES.map((e) => <button key={e} className="chip" onClick={() => send(e)}>{e}</button>)}</div>}
        {cards?.map((o, i) => <div key={i} className={`rec ${o.fit !== "ok" ? "over" : ""}`}>
          <b>{o.venueName}</b><span className="muted small">{w.day(o.date)} · {o.start} · {o.minutes} min</span>
          <span>{o.names.map((n) => n.split(" ")[0]).join(", ")}</span>
          {o.missing.length > 0 && <small className="warn-text">{w.notFree(o.missing.map(firstName))}</small>}
          <span><b>{money(o.askPrice)}</b> {w.card.asked} · {money(o.share)} {w.card.each}{o.fit !== "ok" ? ` · ${w.card[o.fit]}` : ""}</span>
          <span className="tags">{(o.discounts || []).length > 0 && <span className="tag good">{o.discounts.map((d) => w.why.discount(d)).join(" + ")}</span>}{world?.venues.find((v) => v.id === o.venue)?.style && <span className="tag">{w.style[world.venues.find((v) => v.id === o.venue).style]}</span>}</span>
          <small className="muted">{o.why.filter((x, i) => i < 2).join(" · ")}</small>
          <button className="btn primary small" disabled={busy || o.fit === "tooFar"} onClick={() => ask(o)}>{w.card.negotiate}</button>
        </div>)}
        {confirm && <div className="drawer-actions">
          <button className="btn primary small" disabled={busy} onClick={() => choose(confirm)}>{w.go}</button>
          <button className="btn small" disabled={busy} onClick={() => { setConfirm(null); say(w.stopped); }}>{w.notThis}</button>
        </div>}
        {pending && <div className="drawer-actions">
          <button className="btn primary small" disabled={busy} onClick={async () => { setBusy(true); const p = pending; setPending(null); await finish(await acceptDeal(p.n, model), p.o); setBusy(false); }}>{w.accept(pending.n.ask)}</button>
          <button className="btn small" disabled={busy} onClick={async () => { setBusy(true); const p = pending; setPending(null); await walkAway(p.n, model); await finish({ error: w.walked }, p.o); setBusy(false); }}>{w.elsewhere}</button>
        </div>}
        {booking && <div className="rec">
          {booking.you?.status === "authorized" ? <p><Icon name="verify" size={14} /> {w.authorized(booking.you.via)}</p>
            : booking.you?.approveUrl ? <><b>{w.guarantee(booking.you.authorized)}</b><PayPalButtons bookingId={booking.id} orderId={booking.you.orderId} approveUrl={booking.you.approveUrl} onDone={() => say(w.approved)} /></>
            : <p>{booking.state}</p>}
          <a className="btn small" href={`#/games?booking=${booking.id}`} onClick={onClose}>{w.see}</a>
        </div>}
        {busy && <p className="bubble agent typing">…</p>}
        <div ref={end} />
      </div>
      <form className="drawer-input" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={w.placeholder} disabled={busy} aria-label="Message" />
        <button className="btn primary small" disabled={busy || !text.trim()}>{w.send}</button>
        {(deal || Object.keys(brief).length > 0) && <button type="button" className="btn ghost small" onClick={reset}>{w.newPlan}</button>}
      </form>
    </aside>
  );
}

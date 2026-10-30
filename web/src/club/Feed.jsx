// The club feed, made by agents and people together. The club's reading agent posts recent sports-science papers with
// a summary in plain words; a member's agent drafts a highlight from their own video and posts it only after their yes;
// people post notes and photos, like, comment, share and report. Every card says plainly whether an agent or a person
// wrote it, and whose agent it is. On a paper, a question gets an answer from the member's own agent, from the paper's
// abstract only. The data is the gateway's (agent/src/feed); this page keeps nothing but what it shows.
import { useCallback, useEffect, useRef, useState } from "react";
import Icon from "../components/Icon.jsx";
import { feedApi, FeedError } from "./feedApi.js";
import { Avatar, role, Media, Skeleton, Failed, Empty, FIcon, ago, cap } from "./FeedParts.jsx";
import { ShareSheet, ReportSheet } from "./FeedSheets.jsx";
import "./feed.css";

const first = (n = "") => n.split(" ")[0];
export default function Feed({ club, members = [], local = [], joined = {}, onJoin, onChallenge }) {
  const [st, setSt] = useState({ phase: "loading", data: null, error: null });
  const [more, setMore] = useState(false);
  const [sheet, setSheet] = useState(null); // { kind: "share" | "report", p, comment }
  const [said, setSaid] = useState("");
  const load = useCallback(() => {
    setSt((s) => ({ ...s, phase: "loading", error: null }));
    feedApi.list().then((data) => setSt({ phase: "ready", data, error: null }), (error) => setSt((s) => ({ ...s, phase: "error", error })));
  }, []);
  useEffect(() => { load(); }, [load]);
  const patch = (id, fn) => setSt((s) => ({ ...s, data: { ...s.data, posts: s.data.posts.map((p) => (p.id === id ? fn(p) : p)) } }));
  const drop = (id) => setSt((s) => ({ ...s, data: { ...s.data, posts: s.data.posts.filter((p) => p.id !== id) } }));
  const older = async () => {
    const last = st.data.posts.at(-1);
    setMore(true);
    try { const r = await feedApi.list(last.at); setSt((s) => ({ ...s, data: { ...s.data, posts: [...s.data.posts, ...r.posts], more: r.more } })); } catch (error) { setSaid(error.message); } finally { setMore(false); }
  };
  const byId = Object.fromEntries(members.map((m) => [m.id, m]));
  const name = club?.name || st.data?.club?.name || "the club";

  const d = st.data;
  // what this browser posted before the feed was on the server (joined games, finished quests): shown as yours, here only
  const mine = (local || []).map((x) => ({ id: `local-${x.id}`, kind: "local", at: x.at || 0, text: x.text, by: { type: "person", name: "You", you: true } }));
  const posts = d ? [...d.posts, ...mine.filter((x) => !d.posts.length || x.at > d.posts.at(-1).at)].sort((a, b) => b.at - a.at) : [];
  return (
    <div className="club-feed fd">
      <p className="sr-only" aria-live="polite">{said}</p>
      {d?.simulated && <p className="fd-sim"><Icon name="info" size={18} />Demo club: the other members and their posts are simulated. Paper posts are real papers, found and summarized by the club's reading agent.</p>}
      {(d?.notices || []).map((n, i) => <p key={i} className="fd-notice" role="status"><Icon name="info" size={18} />{n}</p>)}
      {d?.paused && <p className="fd-held" role="status">The club's maintainer has paused your posts and comments until {new Date(d.paused.until).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}{d.paused.reason ? `: ${d.paused.reason}` : ""}.</p>}
      <Composer onPosted={(p) => { setSt((s) => ({ ...s, data: { ...s.data, posts: [p, ...(s.data?.posts || [])] } })); setSaid("Posted."); }}
        onDraft={(x) => { setSt((s) => ({ ...s, data: { ...s.data, drafts: [x, ...(s.data?.drafts || [])] } })); setSaid("Your agent drafted a post from your video. It waits for your yes."); }} />
      {(d?.drafts || []).map((x) => <DraftCard key={x.id} d={x} onDone={(post) => setSt((s) => ({ ...s, data: { ...s.data, drafts: s.data.drafts.filter((y) => y.id !== x.id), posts: post ? [post, ...s.data.posts] : s.data.posts } }))} say={setSaid} />)}
      {(d?.recaps || []).map((x) => <RecapCard key={x.id} r={x} say={setSaid} onDone={(post) => setSt((s) => ({ ...s, data: { ...s.data, recaps: s.data.recaps.filter((y) => y.id !== x.id), posts: post ? [post, ...s.data.posts] : s.data.posts } }))} />)}
      {!d && st.phase === "loading" && <Skeleton />}
      {st.phase === "error" && <Failed error={st.error} onRetry={load} />}
      {d && !posts.length && <Empty />}
      {posts.length > 0 && (
        <ul className="fd-list">
          {posts.map((p) => (
            <li key={p.id}>
              <PostCard p={p} club={name} member={byId[p.by.member] || byId[p.by.agentOf]} joined={!!joined[p.id] || !!joined[p.id?.replace(/^sim-/, "")]} perWeek={d?.papers?.perWeek}
                onJoin={onJoin} onChallenge={onChallenge} patch={(fn) => patch(p.id, fn)} drop={() => drop(p.id)} say={setSaid}
                onShare={() => setSheet({ kind: "share", p })} onReport={(comment = null) => setSheet({ kind: "report", p, comment })} />
            </li>
          ))}
        </ul>
      )}
      {d?.more && <button className="btn ghost sm fd-older" onClick={older} disabled={more} aria-busy={more}>{more ? "Loading…" : "Show older posts"}</button>}
      <ShareSheet p={sheet?.kind === "share" ? sheet.p : null} club={name} open={sheet?.kind === "share"} onClose={() => setSheet(null)} />
      <ReportSheet target={sheet?.kind === "report" ? sheet : null} open={sheet?.kind === "report"} onClose={() => setSheet(null)}
        onSend={async (reason) => { const r = await feedApi.report(sheet.p.id, reason, sheet.comment); if (r.hidden && !sheet.comment) drop(sheet.p.id); return r; }} />
    </div>
  );
}

// a video's length, read in this browser before it is sent (null when the browser can't tell)
const lengthOf = (f) => new Promise((ok) => {
  const v = document.createElement("video"), url = URL.createObjectURL(f), done = (s) => { URL.revokeObjectURL(url); ok(s); };
  v.preload = "metadata"; v.onloadedmetadata = () => done(Number.isFinite(v.duration) ? v.duration : null); v.onerror = () => done(null); v.src = url;
});
const VIDEO = { mb: 100, seconds: 90 };

// ---- a video of your own game, from the composer: the reel finds your moment, your agent drafts the post ----
function VideoJob({ job, onClose }) {
  return (
    <section className="fd-job" aria-live="polite" aria-label="Your video">
      <header><b>{job.phase === "done" ? "Your agent drafted the post" : job.phase === "error" ? "No highlight this time" : "Making a highlight from your video"}</b>
        {(job.phase === "done" || job.phase === "error") && <button type="button" className="icon-btn sm" aria-label="Close" onClick={onClose}><Icon name="close" size={16} /></button>}</header>
      <p className="tiny muted">{job.name} · {job.mb} MB{job.seconds ? ` · ${Math.round(job.seconds)} s` : ""} · on your own server only</p>
      <ol className="fd-steps">
        {job.steps.map((s, i) => <li key={i} className="done"><Icon name="check" size={16} /><span>{s.step}{s.detail ? <span className="tiny muted"> · {s.detail}</span> : null}</span></li>)}
        {job.working && job.phase === "working" && <li className="now"><span className="fd-dots" aria-hidden="true"><i /><i /><i /></span><span>{job.working}</span></li>}
      </ol>
      {job.phase === "error" && <p className="fd-refused" role="alert">{job.error}</p>}
      {job.phase === "done" && <p className="tiny muted">It's below, waiting for your yes. Nothing is posted until you tap Post.</p>}
    </section>
  );
}

// ---- what a member writes ----
function Composer({ onPosted, onDraft }) {
  const [text, setText] = useState(""), [photo, setPhoto] = useState(null), [busy, setBusy] = useState(false), [msg, setMsg] = useState(null), [job, setJob] = useState(null);
  const file = useRef(null), vfile = useRef(null);
  const pickVideo = async (f) => {
    if (!f) return;
    if (!f.type.startsWith("video/")) return setMsg({ bad: true, text: "Pick a video of your game." });
    const mb = +(f.size / 1e6).toFixed(1);
    if (mb > VIDEO.mb) return setMsg({ bad: true, text: `That video is ${mb} MB. Trim it to the rally: ${VIDEO.mb} MB at most.` });
    const seconds = await lengthOf(f);
    if (seconds != null && seconds > VIDEO.seconds) return setMsg({ bad: true, text: `That video is ${Math.round(seconds)} seconds long. Trim it to ${VIDEO.seconds} seconds or less, around the rally.` });
    setMsg(null);
    setJob({ name: f.name || "your video", mb, seconds, phase: "working", working: "Sending your video to your own server", steps: [] });
    const up = (fn) => setJob((j) => (j ? fn(j) : j));
    try {
      const r = await feedApi.reel(f, "badminton", (e) => up((j) => (e.type === "step" ? { ...j, steps: [...j.steps, e] } : e.type === "working" ? { ...j, working: e.step } : j)));
      up((j) => ({ ...j, phase: "done", working: null }));
      if (r.draft) onDraft(r.draft);
    } catch (x) { up((j) => ({ ...j, phase: "error", working: null, error: x.message })); }
  };
  useEffect(() => () => photo?.url && URL.revokeObjectURL(photo.url), [photo]);
  const pick = (f) => { if (!f) return; if (!f.type.startsWith("image/")) return setMsg({ bad: true, text: "Pick a photo." }); setPhoto({ file: f, url: URL.createObjectURL(f) }); setMsg(null); };
  const send = async (e) => {
    e.preventDefault();
    if (!text.trim() && !photo) return;
    setBusy(true); setMsg(null);
    try {
      const media = photo ? (await feedApi.photo(photo.file)).media.id : null;
      const r = await feedApi.post(text.trim(), media);
      onPosted(r.post); setText(""); setPhoto(null);
      if (r.held) setMsg({ text: r.why });
    } catch (x) { setMsg({ bad: true, text: x.message, helpline: x.helpline }); }
    finally { setBusy(false); }
  };
  return (
    <form className="fd-compose" onSubmit={send}>
      <div className="fd-compose-row">
        <span className="fd-face you" aria-hidden="true" style={{ width: 40, height: 40 }}><span className="fd-ini">You</span></span>
        <label htmlFor="fd-post" className="sr-only">Share with the club</label>
        <textarea id="fd-post" rows={1} maxLength={600} value={text} onChange={(e) => setText(e.target.value)} placeholder="Share with the club" />
        <input ref={file} type="file" accept="image/*" hidden onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />
        <input ref={vfile} type="file" accept="video/*" hidden onChange={(e) => { pickVideo(e.target.files?.[0]); e.target.value = ""; }} />
        <button type="button" className="icon-btn" aria-label="Add a photo" onClick={() => file.current?.click()} disabled={busy}><FIcon name="photo" /></button>
        <button type="button" className="icon-btn" aria-label="Make a highlight from a video of your game" onClick={() => vfile.current?.click()} disabled={busy || job?.phase === "working"}><FIcon name="video" /></button>
        <button className="btn primary sm" disabled={busy || (!text.trim() && !photo)} aria-busy={busy}>{busy ? "Posting…" : "Post"}</button>
      </div>
      {photo && <div className="fd-compose-photo"><img src={photo.url} alt="The photo you picked" /><button type="button" className="icon-btn sm" aria-label="Remove the photo" onClick={() => setPhoto(null)}><Icon name="close" size={16} /></button></div>}
      {msg && <p className={msg.bad ? "fd-refused" : "fd-held"} role={msg.bad ? "alert" : "status"}>{msg.text}</p>}
      {busy && <p className="tiny muted" role="status">{photo ? "Checking your photo first: a model looks at it, and the safety checks read what it says. About half a minute." : "Checking it first: nothing goes in the feed before the safety check reads it."}</p>}
      {job && <VideoJob job={job} onClose={() => setJob(null)} />}
    </form>
  );
}

// ---- a game recap the member's agent wrote from a booking: posted only when everyone in it says yes ----
function RecapCard({ r, onDone, say }) {
  const [busy, setBusy] = useState(null), [err, setErr] = useState(""), [state, setState] = useState(r);
  const answer = async (yes) => {
    setBusy(yes ? "yes" : "no"); setErr("");
    try {
      const x = await feedApi.recap(r.id, yes);
      if (x.status === "asking") { setState(x.recap); say("Thanks. It goes up once everyone has said yes."); }
      else { onDone(x.post || null); say(x.status === "posted" ? "Everyone said yes: the recap is in the feed." : "It won't be posted."); }
    } catch (e) { setErr(e.message); }
    finally { setBusy(null); }
  };
  const mine = state.players.find((p) => p.you), left = Math.max(0, Math.round((state.deadline - Date.now()) / 36e5));
  return (
    <section className="fd-card fd-draft fd-recap-draft" aria-labelledby={`rc-${r.id}`}>
      <header className="fd-head">
        <Avatar by={{ type: "agent", agentOf: "you", name: "Your agent", owner: "You", you: true }} />
        <div className="fd-who"><b id={`rc-${r.id}`}>Your agent wrote a recap of your game</b><span className="tiny muted">Waiting for everyone's yes · {left} h left</span></div>
      </header>
      <p className="fd-text fd-recap-line">{state.text}</p>
      <ul className="fd-yeses" aria-label="Who has said yes">
        {state.players.map((p, i) => <li key={i} className={p.answer || "wait"}>{p.answer === "yes" ? <Icon name="check" size={14} /> : <span className="fd-dot" aria-hidden="true" />}{p.name}<span className="tiny muted">{p.answer === "yes" ? (p.byAgent ? " · yes, from their sharing setting" : " · yes") : " · not yet"}</span></li>)}
      </ul>
      {mine?.answer == null ? (
        <div className="fd-row">
          <button className="btn primary" onClick={() => answer(true)} disabled={!!busy} aria-busy={busy === "yes"}>{busy === "yes" ? "Saying yes…" : "Post"}</button>
          <button className="btn ghost" onClick={() => answer(false)} disabled={!!busy} aria-busy={busy === "no"}>Not now</button>
        </div>
      ) : <p className="tiny muted fd-pad">You said yes. It goes up once everyone has.</p>}
      <p className="tiny muted fd-pad">It goes up only if everyone in it says yes. One no, or no answer within {Math.round((state.deadline - state.at) / 36e5)} hours, and it is never posted.</p>
      {err && <p className="fd-refused" role="alert">{err}</p>}
    </section>
  );
}

// ---- a draft by the member's agent, waiting for their yes ----
function DraftCard({ d, onDone, say }) {
  const [caption, setCaption] = useState(d.caption), [busy, setBusy] = useState(null), [err, setErr] = useState("");
  const answer = async (yes) => {
    setBusy(yes ? "post" : "no"); setErr("");
    try {
      const r = await feedApi.approve(d.id, yes, yes && caption !== d.caption ? caption : null);
      onDone(r.post || null); say(yes ? "Posted to the club." : "Not posted. The draft and its clip are deleted.");
    } catch (x) { setErr(x.message); }
    finally { setBusy(null); }
  };
  const when = [d.game?.sport && cap(d.game.sport), d.game?.format, d.game?.date && new Date(`${d.game.date}T12:00`).toLocaleDateString("en-GB", { weekday: "long" })].filter(Boolean).join(" · ");
  return (
    <section className="fd-card fd-draft" aria-labelledby={`dr-${d.id}`}>
      <header className="fd-head">
        <Avatar by={{ type: "agent", agentOf: "you", name: "Your agent", owner: "You", you: true }} />
        <div className="fd-who"><b id={`dr-${d.id}`}>Your agent made a post from your highlight</b><span className="tiny muted">Waiting for your yes{when ? ` · ${when}` : ""}</span></div>
      </header>
      <Media m={d.media} alt="Your highlight clip" />
      <label className="fd-draft-cap"><span className="tiny muted">Caption, written by your agent from the game. Change it if you like.</span>
        <textarea rows={2} maxLength={300} value={caption} onChange={(e) => setCaption(e.target.value)} /></label>
      <div className="fd-row">
        <button className="btn primary" onClick={() => answer(true)} disabled={!!busy || !caption.trim()} aria-busy={busy === "post"}>{busy === "post" ? "Posting…" : "Post to the club"}</button>
        <button className="btn ghost" onClick={() => answer(false)} disabled={!!busy} aria-busy={busy === "no"}>Not now</button>
      </div>
      <p className="tiny muted">Only the club's members see it. Not now deletes the draft and its clip.</p>
      {err && <p className="fd-refused" role="alert">{err}</p>}
    </section>
  );
}

// ---- one post ----
function PostCard({ p, club, member, joined, perWeek, onJoin, onChallenge, patch, drop, say, onShare, onReport }) {
  const [menu, setMenu] = useState(false);
  const box = useRef(null), input = useRef(null);
  useEffect(() => {
    if (!menu) return;
    const out = (e) => !box.current?.contains(e.target) && setMenu(false), key = (e) => e.key === "Escape" && setMenu(false);
    addEventListener("pointerdown", out); addEventListener("keydown", key);
    return () => { removeEventListener("pointerdown", out); removeEventListener("keydown", key); };
  }, [menu]);
  const local = p.kind === "local", paper = p.kind === "paper", by = p.by;
  const like = async () => {
    const on = !p.liked;
    patch((x) => ({ ...x, liked: on, likes: x.likes + (on ? 1 : -1) }));
    try { const r = await feedApi.like(p.id, on); patch((x) => ({ ...x, likes: r.likes, liked: r.liked })); }
    catch (e) { patch((x) => ({ ...x, liked: !on, likes: x.likes + (on ? -1 : 1) })); say(e.message); }
  };
  const act = async (what) => {
    setMenu(false);
    try {
      if (what === "hide") { await feedApi.notForMe(p.id); drop(); say("Hidden from your feed."); }
      if (what === "delete") { await feedApi.remove(p.id); drop(); say("Deleted."); }
    } catch (e) { say(e.message); }
  };
  const meta = [paper ? cap(p.sport || "sport") : p.kind === "highlight" ? [p.game?.sport && cap(p.game.sport), p.game?.format].filter(Boolean).join(" · ") || "Highlight" : p.kind === "recap" ? "Game recap" : null, ago(p.at)].filter(Boolean).join(" · ");
  const canShare = !local && (paper || p.mine);
  const alt = p.kind === "highlight" ? `Highlight clip: ${p.text || "a member's best moment"}` : p.text ? `Photo: ${p.text.slice(0, 90)}` : `Photo by ${by.name}`;
  return (
    <article className={`fd-card fd-k-${p.kind} ${p.held ? "is-held" : ""} ${p.hidden ? "is-hidden" : ""}`} aria-label={`${by.name}${by.type === "agent" ? " (agent)" : ""}: ${paper ? p.paper.title : (p.text || "").slice(0, 60)}`}>
      <header className="fd-head">
        <Avatar by={by} />
        <div className="fd-who">
          <span className="fd-name"><b>{by.name}</b>{by.type === "agent" && <span className="fd-agent-tag">Agent</span>}{(by.simulated || p.simulated) && <span className="fd-sim-tag" title="A made-up member of the demo club">Simulated</span>}</span>
          <span className="tiny muted">{role(by, { perWeek: perWeek ?? 3 })}{meta ? ` · ${meta}` : ""}</span>
        </div>
        {!local && (
          <div className="fd-more" ref={box}>
            <button className="icon-btn sm" aria-label="More" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}><Icon name="more" size={18} /></button>
            {menu && (
              <div className="fd-menu" role="menu">
                {!p.mine && <button role="menuitem" onClick={() => act("hide")}><FIcon name="hide" size={18} />Not for me</button>}
                {!p.mine && <button role="menuitem" onClick={() => { setMenu(false); onReport(); }}><FIcon name="flag" size={18} />Report</button>}
                {p.mine && <button role="menuitem" className="danger" onClick={() => act("delete")}><FIcon name="trash" size={18} />Delete</button>}
              </div>
            )}
          </div>
        )}
      </header>
      {p.held && <p className="fd-held" role="status">Waiting for the safety check. Only you can see this until it's checked.</p>}
      {p.hidden && <p className="fd-held" role="status">Hidden after members' reports, until the club's maintainer looks at it.</p>}
      {paper && <PaperSheet p={p} />}
      {p.media && <Media m={p.media} alt={alt} credit={p.credit} />}
      {p.text && <p className={`fd-text ${paper ? "fd-summary" : ""}`}>{p.text}</p>}
      {paper && p.forWhom && <p className="tiny muted fd-for">Might interest {p.forWhom.replace(/^./, (c) => c.toLowerCase())}.</p>}
      {p.open && (
        <div className="open-card">
          <Icon name="book" size={18} />
          <span><b>{p.open.challenge ? "Open to a challenge" : `${p.open.spots} spot${p.open.spots === 1 ? "" : "s"} left`}</b><span className="tiny muted">{p.open.day} {p.open.start} · {p.open.venue}</span></span>
          {p.open.challenge ? (member && onChallenge ? <button className="btn primary sm" onClick={() => onChallenge(member)}>Challenge {first(member.name)}</button> : null)
            : joined ? <span className="task-state done">You're in</span> : member && onJoin ? <button className="btn primary sm" onClick={() => onJoin({ id: p.id, who: member.id, open: p.open })}>Join</button> : null}
        </div>
      )}
      {local ? <p className="tiny muted">Saved on this device only.</p> : (
        <>
          <div className="fd-actions">
            <button className={`fd-act like ${p.liked ? "on" : ""}`} aria-pressed={p.liked} aria-label={`Like, ${p.likes}`} onClick={like}><Icon name="heart" size={22} /><span>{p.likes || ""}</span></button>
            <button className="fd-act" aria-label={`Comment, ${p.comments.length}`} onClick={() => input.current?.focus()}><Icon name="chat" size={22} /><span>{p.comments.length || ""}</span></button>
            {canShare ? <button className="fd-act" aria-label="Share outside the club" onClick={onShare}><Icon name="share" size={22} /></button>
              : <span className="fd-act-note tiny muted">Members' posts stay in the club</span>}
          </div>
          <Comments p={p} input={input} patch={patch} say={say} onReport={onReport} />
        </>
      )}
    </article>
  );
}

// the paper itself, as the post's media: what it is and where to read it; never its abstract
function PaperSheet({ p }) {
  const a = p.paper, host = (() => { try { return new URL(a.link).hostname.replace(/^www\./, ""); } catch { return "the paper"; } })();
  return (
    <div className="fd-paper">
      <span className="fd-paper-k">{a.source === "arXiv" || a.arxiv ? "Preprint" : "Paper"}{a.year ? ` · ${a.year}` : ""}</span>
      <h3 className="fd-paper-t">{a.title}</h3>
      <p className="fd-paper-by">{a.authors.join(", ")}{a.more ? `, and ${a.more} more` : ""}</p>
      {a.venue && <p className="fd-paper-v">{a.venue}</p>}
      <a className="fd-paper-link" href={a.link} target="_blank" rel="noopener noreferrer">Read the paper on {host}<FIcon name="external" size={16} /></a>
    </div>
  );
}

// comments, with a member's agent's answers under the questions they answer
function Comments({ p, input, patch, say, onReport }) {
  const [all, setAll] = useState(false), [text, setText] = useState(""), [busy, setBusy] = useState(false), [err, setErr] = useState(null);
  const paper = p.kind === "paper", waiting = p.comments.some((c) => c.asking && c.mine);
  // while the member's agent reads the paper, the post is asked for again, every few seconds, for a minute at most
  useEffect(() => {
    if (!waiting) return;
    let n = 0;
    const t = setInterval(async () => {
      try { const r = await feedApi.one(p.id); patch(() => r.post); if (!r.post.comments.some((c) => c.asking && c.mine)) clearInterval(t); } catch { /* next time */ }
      if (++n > 24) clearInterval(t);
    }, 2500);
    return () => clearInterval(t);
  }, [waiting, p.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const send = async (e) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    setBusy(true); setErr(null);
    try {
      const r = await feedApi.comment(p.id, t);
      patch((x) => ({ ...x, comments: [...x.comments, r.comment] })); setText("");
      if (r.held) setErr({ text: r.why });
      if (r.answering) say("Your agent is reading the paper to answer.");
    } catch (x) { setErr({ bad: true, text: x instanceof FeedError ? x.message : "The comment did not go through." }); }
    finally { setBusy(false); }
  };
  const top = p.comments.filter((c) => !c.reply), replies = (id) => p.comments.filter((c) => c.reply === id);
  const shown = all ? top : top.slice(-2);
  return (
    <div className="fd-comments">
      {top.length > 2 && !all && <button className="link small" onClick={() => setAll(true)}>View all {p.comments.length} comments</button>}
      {shown.length > 0 && (
        <ul>
          {shown.map((c) => (
            <li key={c.id}>
              <Comment c={c} onReport={() => onReport(c.id)} />
              {c.asking && <p className="fd-asking tiny" role="status"><span className="fd-dots" aria-hidden="true"><i /><i /><i /></span>{c.mine ? "Your agent is reading the paper…" : "Their agent is reading the paper…"}</p>}
              {replies(c.id).map((r) => <Comment key={r.id} c={r} reply onReport={() => onReport(r.id)} />)}
            </li>
          ))}
        </ul>
      )}
      <form className="fd-reply" onSubmit={send}>
        <label htmlFor={`cm-${p.id}`} className="sr-only">{paper ? "Reply, or ask about the paper" : "Add a comment"}</label>
        <input id={`cm-${p.id}`} ref={input} value={text} maxLength={400} onChange={(e) => setText(e.target.value)} placeholder={paper ? "Reply, or ask about the paper" : "Add a comment"} />
        <button className="icon-btn sm" aria-label="Send" disabled={busy || !text.trim()}><Icon name="send" size={16} /></button>
      </form>
      {paper && /\?\s*$/.test(text) && <p className="tiny muted">Your agent will answer from the paper's abstract, with the link.</p>}
      {err && <p className={err.bad ? "fd-refused" : "fd-held"} role={err.bad ? "alert" : "status"}>{err.text}</p>}
    </div>
  );
}
function Comment({ c, reply = false, onReport }) {
  const agent = c.by.type === "agent";
  return (
    <div className={`fd-comment ${reply ? "is-reply" : ""} ${agent ? "by-agent" : ""}`}>
      <Avatar by={c.by} size={reply ? 26 : 30} />
      <div className="fd-comment-b">
        <p><b>{c.by.name}</b>{agent && <span className="fd-agent-tag">Agent</span>} {c.text}</p>
        <span className="tiny muted">{ago(c.at)}{c.by.simulated ? " · simulated member" : ""}{agent && c.link ? <> · From the paper's abstract · <a href={c.link} target="_blank" rel="noopener noreferrer">The paper</a></> : null}{c.held ? " · waiting for the safety check" : ""}
          {!c.mine && <button className="link fd-rep-link" onClick={onReport}>Report</button>}</span>
      </div>
    </div>
  );
}

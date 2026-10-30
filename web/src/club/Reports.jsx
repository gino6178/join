// #/maintain?tab=reports: the club feed's reports, for the club's maintainer. Each reported post or comment with what it
// says, who wrote it, every reason and how many members gave it, the checks it passed, and whether it is hidden; the
// actions (hide, restore, dismiss, limit the author, lift the limit); and the audit log of every action. Reporters stay
// unnamed. The maintainer's token goes with every call (feedApi.js reportsApi), as with decisions and rollbacks.
import { useCallback, useEffect, useState } from "react";
import Icon from "../components/Icon.jsx";
import { reportsApi } from "./feedApi.js";
import { Loading, Failed, Empty, ago, when } from "../loop/parts.jsx";
import "./feed.css";

const REASON = { spam: "Spam", unkind: "Unkind or harassing", private: "Private details", unsafe: "Unsafe or harmful", wrong: "Misleading about a paper", other: "Something else" };
const KIND = { comment: "Comment", photo: "Photo", note: "Post", paper: "Paper", highlight: "Highlight", recap: "Recap", game: "Open game" };
const ACTION = { hide: "Hid", restore: "Restored", dismiss: "Dismissed", limit: "Limited the author of", unlimit: "Lifted the limit on the author of" };

export default function Reports({ token }) {
  const [all, setAll] = useState(false);
  const [st, setSt] = useState({ phase: "loading", data: null, log: null, error: null });
  const load = useCallback(() => {
    setSt((s) => ({ ...s, phase: "loading", error: null }));
    Promise.all([reportsApi.queue(token, all), reportsApi.audit(token)]).then(([q, a]) => setSt({ phase: "ready", data: q.items, log: a.entries, error: null }), (error) => setSt((s) => ({ ...s, phase: "error", error })));
  }, [token, all]);
  useEffect(() => { load(); }, [load]);
  const edit = (item, entry) => setSt((s) => ({ ...s, data: s.data.map((x) => (x.post === item.post && x.comment === item.comment ? item : x)), log: [entry, ...(s.log || [])] }));
  if (!st.data) return st.phase === "error" ? <Failed what="The club feed's reports" error={st.error} onRetry={load} tech /> : <Loading what="the reports" />;
  const open = st.data.filter((x) => x.open).length, hidden = st.data.filter((x) => x.hidden).length;
  return (
    <div className="rp">
      <header className="rp-h">
        <p className="muted small">{open} open · {hidden} hidden. Three members' reports hide an item until you look. Reporters are not named.</p>
        <label className="rp-all"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />Show reviewed reports too</label>
      </header>
      {st.phase === "error" && <Failed what="The latest reports" error={st.error} onRetry={load} tech />}
      {st.data.length === 0 ? <Empty title="No reports">When members report a post or a comment in the club feed, it shows here with their reasons.</Empty>
        : <ul className="rp-list">{st.data.map((x) => <Item key={`${x.post}:${x.comment || ""}`} x={x} token={token} onDone={edit} />)}</ul>}
      <section className="rp-log" aria-labelledby="rp-log-h">
        <h2 id="rp-log-h" className="panel-h">Audit log</h2>
        {!st.log?.length ? <p className="muted small">No actions yet. Every hide, restore, dismissal and limit is recorded here, with its reason.</p> : (
          <ol>
            {st.log.map((a) => <li key={a.id}><span className="tiny muted">{when(a.at)}</span><span><b>{ACTION[a.action] || a.action}</b> a {a.comment ? "comment" : "post"} by {a.authorName || "a member"}{a.days ? ` for ${a.days} day${a.days === 1 ? "" : "s"}` : ""}{a.reason ? `: “${a.reason}”` : ""}<span className="tiny muted"> · {a.reports} report{a.reports === 1 ? "" : "s"} · by {a.by}</span></span></li>)}
          </ol>
        )}
      </section>
    </div>
  );
}

function Item({ x, token, onDone }) {
  const [reason, setReason] = useState(""), [days, setDays] = useState(7), [busy, setBusy] = useState(null), [err, setErr] = useState(""), [img, setImg] = useState(null);
  useEffect(() => {
    const id = x.media?.poster || (x.media?.type === "image/jpeg" ? x.media.id : null);
    if (id) reportsApi.media(token, id).then(setImg, () => {});
  }, [x.media, token]);
  const act = async (action) => {
    setBusy(action); setErr("");
    try { const r = await reportsApi.act(token, { post: x.post, comment: x.comment, action, reason: reason.trim(), days }); onDone(r.item || { ...x, open: false }, r.entry); setReason(""); }
    catch (e) { setErr(e.message); }
    finally { setBusy(null); }
  };
  const c = x.checks || {}, checks = [c.llamaGuard && `Llama Guard: ${c.llamaGuard}`, c.standard && `club standard: ${c.standard}`, c.photo && `photo: ${c.photo.verdict}`].filter(Boolean);
  const member = x.author.id && x.author.id !== "club";
  return (
    <li className={`rp-item ${x.hidden ? "is-hidden" : ""} ${x.open ? "is-open" : ""}`}>
      <div className="rp-top">
        <span className="rp-kind">{KIND[x.kind] || "Post"}</span>
        <b>{x.author.name}</b>{x.author.type === "agent" && <span className="fd-agent-tag">Agent</span>}{x.simulated && <span className="fd-sim-tag">Simulated</span>}
        {x.paused && <span className="rp-paused">Paused until {new Date(x.paused.until).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span>}
        <span className="tiny muted">{ago(x.at)}</span>
      </div>
      {x.on && <p className="tiny muted rp-on">On: “{x.on}”</p>}
      <div className="rp-body">
        {img && <img src={img} alt="The reported post's photo" />}
        {x.paper ? <p><b>{x.paper.title}</b></p> : null}
        {x.text ? <p className="rp-text">{x.text}</p> : !x.paper && <p className="tiny muted">(no text)</p>}
      </div>
      <ul className="rp-reasons" aria-label="Reasons given">
        {Object.entries(x.reasons).map(([k, n]) => <li key={k}>{REASON[k] || k}{n > 1 ? ` × ${n}` : ""}</li>)}
      </ul>
      <p className="tiny muted">{x.reports} report{x.reports === 1 ? "" : "s"} from {x.reporters} member{x.reporters === 1 ? "" : "s"}{x.lastReport ? `, the last ${ago(x.lastReport)}` : ""}{checks.length ? ` · passed when posted: ${checks.join(", ")}` : ""}
        {x.hidden ? ` · hidden ${x.hidden.by === "reports" ? "by members' reports" : "by the maintainer"}` : ""}{x.dismissed && !x.open ? " · reviewed" : ""}</p>
      <div className="rp-act">
        <label className="sr-only" htmlFor={`rp-r-${x.post}${x.comment || ""}`}>Reason, for the log</label>
        <input id={`rp-r-${x.post}${x.comment || ""}`} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="Reason, for the audit log" />
        <div className="fd-row rp-buttons">
          {x.hidden ? <button className="btn ghost sm" onClick={() => act("restore")} disabled={!!busy} aria-busy={busy === "restore"}>Restore</button>
            : <button className="btn primary sm" onClick={() => act("hide")} disabled={!!busy} aria-busy={busy === "hide"}><Icon name="close" size={14} />Hide</button>}
          {x.open && <button className="btn ghost sm" onClick={() => act("dismiss")} disabled={!!busy} aria-busy={busy === "dismiss"}>Dismiss</button>}
          {member && (x.paused
            ? <button className="btn ghost sm" onClick={() => act("unlimit")} disabled={!!busy} aria-busy={busy === "unlimit"}>Lift the limit</button>
            : <span className="rp-limit">
                <label className="sr-only" htmlFor={`rp-d-${x.post}${x.comment || ""}`}>Days</label>
                <select id={`rp-d-${x.post}${x.comment || ""}`} value={days} onChange={(e) => setDays(+e.target.value)}>{[1, 3, 7, 30].map((d) => <option key={d} value={d}>{d} day{d === 1 ? "" : "s"}</option>)}</select>
                <button className="btn ghost sm" onClick={() => act("limit")} disabled={!!busy} aria-busy={busy === "limit"}>Limit the author</button>
              </span>)}
        </div>
      </div>
      {err && <p className="err" role="alert">{err}</p>}
    </li>
  );
}

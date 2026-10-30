// #/maintain: the community loop, for the club's maintainer. Proposals with their spec (the problem with its counts, the
// change class, files, oracle, privacy note and the Rule-of-Two row of every stage), the gates one by one, Approve and
// Refuse with a note, and the flags the changes ship behind, with a Rollback button. The page is locked until the
// maintainer's token is typed in; it is kept in this browser tab only and sent only with decisions and rollbacks.
import { useCallback, useEffect, useRef, useState } from "react";
import Icon from "../components/Icon.jsx";
import { loop, source, maintainerToken } from "../loop/api.js";
import { StatusPill, statusOf, ClassPill, classNote, Loading, Failed, Empty, ago, when, LockIcon } from "../loop/parts.jsx";
import "../loop/loop.css";
import Reports from "../club/Reports.jsx";

const query = () => new URLSearchParams(location.hash.split("?")[1] || "");
function useQuery() {
  const [q, setQ] = useState(query);
  useEffect(() => { const on = () => setQ(query()); addEventListener("hashchange", on); return () => removeEventListener("hashchange", on); }, []);
  return q;
}
// a link inside this page that keeps the data switches (loop=, mock=) of the current address
function link(extra = {}) {
  const now = query(), o = new URLSearchParams();
  for (const k of ["loop", "mock"]) if (now.get(k)) o.set(k, now.get(k));
  for (const [k, v] of Object.entries(extra)) o.set(k, v);
  const s = o.toString();
  return `#/maintain${s ? `?${s}` : ""}`;
}
const NEEDS_YOU = new Set(["open", "review"]);
const ORDER = ["review", "open", "gated", "approved", "building", "shipped", "rolledBack", "refused"];
const BY = { code: "code", maintainer: "the maintainer", rules: "the rules" };
const ORACLE = { check: "A check in code", unit: "A unit test", eval: "An eval" };
const STAGE = {
  collect: "The member's own record", screen: "The guard screens shared items", cluster: "Code groups shared items",
  summarize: "Muse Glimmer summarizes each cluster", draft: "Muse Glimmer drafts the spec from the summaries", review: "Rules and the never-list",
  build: "The coding agent, on its own branch", gates: "Code runs the gates", merge: "The maintainer merges", ship: "Code sets the flag",
};
const FLAG = { off: ["Off", "neutral"], canary: ["Canary", "agent"], on: ["On", "good"], rolledBack: ["Rolled back", "warn"] };
const fmt = (v) => (v === true ? "on" : v === false ? "off" : v == null ? "—" : String(v));

export default function Maintain() {
  const [token, setToken] = useState(() => maintainerToken.get());
  const [why, setWhy] = useState(""); // why the page locked itself
  const lock = (reason = "") => { maintainerToken.clear(); setToken(""); setWhy(reason); };
  const mock = source() === "mock";
  return (
    <div className="page lp-maintain">
      <header className="report-head">
        <div>
          <span className="tag">{mock ? "Sample data · simulated club, seed 7" : "Your gateway"}</span>
          <h1 className="h1">Maintainer review</h1>
          <p className="muted">What the club asked for, drafted as proposals. The safety review and the gates decide what may ship; you approve or refuse what needs a person, and can roll back any flag.</p>
        </div>
        {token && <div className="cta-row"><button className="btn ghost" onClick={() => lock()}><LockIcon size={18} />Lock</button></div>}
      </header>
      {token ? <Desk token={token} onAuthFail={lock} /> : <Locked why={why} mock={mock} onUnlock={(t) => { maintainerToken.set(t); setToken(t); setWhy(""); }} />}
    </div>
  );
}

function Locked({ why, mock, onUnlock }) {
  const [t, setT] = useState(""), [show, setShow] = useState(false), [miss, setMiss] = useState(false);
  const input = useRef(null);
  const submit = (e) => { e.preventDefault(); const v = t.trim(); if (v) onUnlock(v); else { setMiss(true); input.current?.focus(); } };
  return (
    <section className="panel lp-locked" aria-labelledby="lp-lock-h">
      <span className="lp-lock-ic"><LockIcon size={26} /></span>
      <h2 id="lp-lock-h">Locked</h2>
      <p>This page is for the club's maintainer. Unlock it with the gateway's maintainer token (<span className="mono">MAINTAINER_TOKEN</span> on your server).</p>
      {why && <p className="lp-reason t-bad" role="alert"><b>Locked again</b>{why}</p>}
      <form className="lp-lock-form" onSubmit={submit} noValidate>
        <label htmlFor="lp-token">Maintainer token</label>
        <div className="lp-token-row">
          <input id="lp-token" ref={input} type={show ? "text" : "password"} value={t} onChange={(e) => { setT(e.target.value); setMiss(false); }}
            autoComplete="off" autoCapitalize="off" spellCheck={false} aria-invalid={miss} aria-describedby="lp-token-note" />
          <button type="button" className="btn ghost" aria-pressed={show} onClick={() => setShow(!show)}>{show ? "Hide" : "Show"}</button>
        </div>
        {miss && <p className="err" role="alert">Type the token first.</p>}
        <button className="btn primary" type="submit"><LockIcon size={18} />Unlock</button>
      </form>
      <p id="lp-token-note" className="tiny muted">The token stays in this browser tab and goes only to your gateway, with each decision and rollback. It is never part of the app's build; closing the tab forgets it.{mock ? " With the sample data, any token unlocks the page and nothing leaves the browser." : ""}</p>
    </section>
  );
}

function useLoad(fn) {
  const [st, setSt] = useState({ phase: "loading", data: null, error: null });
  const load = useCallback(() => {
    setSt((s) => ({ ...s, phase: "loading", error: null }));
    fn().then((data) => setSt({ phase: "ready", data, error: null }), (error) => setSt((s) => ({ ...s, phase: "error", error })));
  }, [fn]);
  useEffect(() => { load(); }, [load]);
  return [st, load, (f) => setSt((s) => ({ ...s, data: f(s.data) }))];
}

function Desk({ token, onAuthFail }) {
  const q = useQuery();
  const tab = q.get("tab") === "flags" ? "flags" : q.get("tab") === "reports" ? "reports" : "proposals";
  const [specs, loadSpecs, editSpecs] = useLoad(loop.proposals);
  const [flags, loadFlags, editFlags] = useLoad(loop.flags);
  // the builder's work (maintainer's token), read again every few seconds while a build runs
  const [built, loadBuilt] = useLoad(useCallback(() => loop.builds(token), [token]));
  const building = Object.values(built.data || {}).some((b) => b.status === "building");
  useEffect(() => { if (!building) return; const id = setTimeout(() => { loadBuilt(); loadSpecs(); }, 5000); return () => clearTimeout(id); }, [building, built.data]);
  useEffect(() => { if (built.error?.kind === "auth") onAuthFail("The gateway refused that token. Unlock again with the maintainer token."); }, [built.error]);
  const needs = specs.data?.filter((x) => NEEDS_YOU.has(x.status)).length ?? 0;
  const live = flags.data?.filter((f) => f.status === "canary" || f.status === "on").length ?? 0;
  const authFail = () => onAuthFail("The gateway refused that token. Unlock again with the maintainer token.");
  // a decision re-sorts the list: the decided proposal stays on screen, not whichever comes first now
  const [pinned, setPinned] = useState(null);
  return (
    <>
      <nav className="lp-tabs" aria-label="Maintainer">
        <a href={link()} aria-current={tab === "proposals" ? "page" : undefined}>Proposals{needs ? <em>{needs} need you</em> : null}</a>
        <a href={link({ tab: "flags" })} aria-current={tab === "flags" ? "page" : undefined}>Flags{live ? <em className="live">{live} live</em> : null}</a>
        <a href={link({ tab: "reports" })} aria-current={tab === "reports" ? "page" : undefined}>Reports</a>
      </nav>
      {tab === "reports" ? <Reports token={token} /> : tab === "proposals"
        ? <Proposals st={specs} reload={loadSpecs} flags={flags.data || []} sel={q.get("p")} pinned={pinned} token={token} onAuthFail={authFail}
            builds={built.data || {}} onBuild={() => { loadBuilt(); loadSpecs(); }}
            onSpec={(p) => { setPinned(p.id); editSpecs((d) => d.map((x) => (x.id === p.id ? p : x))); }} />
        : <Flags st={flags} reload={loadFlags} specs={specs.data || []} token={token} onAuthFail={authFail}
            onFlag={(f) => {
              // show the answer at once, then read both again: the flag's history and its proposal's status moved too
              editFlags((d) => d.map((x) => (x.key === f.key ? { ...f, history: f.history.length ? f.history : x.history } : x)));
              loadFlags(); loadSpecs();
            }} />}
    </>
  );
}

// ---------- proposals: the list, and the selected spec ----------
function Proposals({ st, reload, flags, sel, pinned, token, onAuthFail, onSpec, builds = {}, onBuild }) {
  if (!st.data) return st.phase === "error" ? <Failed tech what="Proposals" error={st.error} onRetry={reload} /> : <Loading what="proposals" />;
  const list = [...st.data].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || String(a.id).localeCompare(String(b.id)));
  if (!list.length) return <Empty title="No proposals yet">A proposal is drafted once an idea has 5 or more members, from weekday and weekend players both. The club's ideas are on the Club page, under Ideas.</Empty>;
  const cur = list.find((x) => x.id === sel) || list.find((x) => x.id === pinned) || list[0];
  return (
    <>
      {st.phase === "error" && <Failed tech what="The latest proposals" error={st.error} onRetry={reload} />}
      <div className={`lp-split ${sel ? "picked" : ""}`}>
        <nav className="lp-plist" aria-label="Proposals">
          <ul>
            {list.map((x) => (
              <li key={x.id}>
                <a href={link({ p: x.id })} aria-current={x.id === cur.id ? "true" : undefined}
                  aria-label={`${x.id}, ${x.title}. ${statusOf(x.status).label}, class ${x.change.class}${NEEDS_YOU.has(x.status) ? ", needs you" : ""}`}>
                  <span className="lp-plist-top"><span className="mono">{x.id}</span><ClassPill c={x.change.class} /><StatusPill status={x.status} /></span>
                  <b>{x.title}</b>
                  <span className="tiny muted">{x.problem.members} members · {x.problem.votes} votes{NEEDS_YOU.has(x.status) ? " · needs you" : ""}</span>
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <Spec key={cur.id} x={cur} flag={flags.find((f) => f.key === cur.change.key)} token={token} onAuthFail={onAuthFail} onSpec={onSpec} build={builds[cur.id] || null} onBuild={onBuild} />
      </div>
    </>
  );
}

function Spec({ x, flag, token, onAuthFail, onSpec, build, onBuild }) {
  const c = x.change, hid = `sp-${x.id}`, decideRef = useRef(null);
  return (
    <article className="lp-spec" aria-labelledby={hid}>
      <a className="lp-back link" href={link()}><Icon name="back" size={16} />All proposals</a>
      <header className="lp-spec-h">
        <div className="lp-row"><span className="mono lp-id">{x.id}</span><StatusPill status={x.status} /><ClassPill c={c.class} /></div>
        <h2 id={hid}>{x.title}</h2>
        <p className="muted small">{statusOf(x.status).note}.{x.cluster ? ` From cluster ${x.cluster}.` : ""}
          {NEEDS_YOU.has(x.status) && <> <button className="link" onClick={() => decideRef.current?.scrollIntoView({ block: "center" })}>Go to the decision</button></>}</p>
      </header>
      {x.reasons.length > 0 && (x.status === "refused" || x.status === "rolledBack") && (
        <p className={`lp-reason ${x.status === "refused" ? "t-bad" : "t-warn"}`}><b>{x.status === "refused" ? "Refused" : "Rolled back"}</b>{x.reasons.join(" ")}</p>
      )}

      <section className="lp-sec" aria-labelledby={`${hid}-pb`}>
        <h3 id={`${hid}-pb`}>Problem</h3>
        <p>{x.problem.text || "No problem statement."}</p>
        <dl className="readout lp-counts">
          <div><dt>Members</dt><dd>{x.problem.members}</dd></div>
          <div><dt>Unmet requests</dt><dd>{x.problem.unmet}</dd></div>
          <div><dt>Wishes</dt><dd>{x.problem.wishes}</dd></div>
          <div><dt>Votes</dt><dd>{x.problem.votes}</dd></div>
        </dl>
      </section>

      <section className="lp-sec" aria-labelledby={`${hid}-ch`}>
        <h3 id={`${hid}-ch`}>Change</h3>
        <p className="lp-classline"><ClassPill c={c.class} /><span>{classNote(c.class)}</span></p>
        {c.summary && <p>{c.summary}</p>}
        {c.key && (
          <p className="lp-setting">
            <span className="mono">{c.key}</span>
            <span>{flag ? <>{fmt(flag.default)} → <b>{fmt(c.value)}</b>{flag.range ? <span className="muted"> · range {flag.range[0]}–{flag.range[1]}</span> : null}</> : <>set to <b>{fmt(c.value)}</b></>}</span>
          </p>
        )}
        <h4>Files</h4>
        {c.files.length ? <ul className="lp-files">{c.files.map((f) => <li key={f} className="mono">{f}</li>)}</ul> : <p className="muted small">No files listed.</p>}
        {x.branch && <p className="tiny muted">Built on the branch <span className="mono">{x.branch}</span></p>}
      </section>

      <div className="lp-sec lp-two">
        <section aria-labelledby={`${hid}-or`}>
          <h3 id={`${hid}-or`}>Oracle</h3>
          {x.oracle ? <p><span className="lp-tag">{ORACLE[x.oracle.kind] || x.oracle.kind}</span> {x.oracle.how}</p> : <p className="muted small">No oracle: nothing would show the change worked.</p>}
        </section>
        <section aria-labelledby={`${hid}-pv`}>
          <h3 id={`${hid}-pv`}>Privacy</h3>
          <p>{x.privacy || <span className="muted">No privacy note.</span>}</p>
        </section>
      </div>

      <section className="lp-sec" aria-labelledby={`${hid}-r2`}>
        <h3 id={`${hid}-r2`}>Rule of Two</h3>
        <RuleOfTwo rows={x.ruleOfTwo} />
      </section>

      {x.review && (
        <section className="lp-sec" aria-labelledby={`${hid}-rv`}>
          <h3 id={`${hid}-rv`}>Safety review</h3>
          <p className={`lp-verdict ${x.review.allowed ? "t-good" : "t-bad"}`}>
            <Icon name={x.review.allowed ? "verify" : "warn"} size={18} />
            {x.review.allowed ? (x.review.needs === "none" ? "Allowed; needs no maintainer" : "Allowed; needs the maintainer") : "Not allowed: it can never ship"}
          </p>
          {(x.review.reasons || []).length > 0 && <ul className="lp-files plain">{x.review.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
        </section>
      )}

      {c.class !== "C0" && (build || ["approved", "building", "gated"].includes(x.status)) && (
        <section className="lp-sec" aria-labelledby={`${hid}-bd`}>
          <h3 id={`${hid}-bd`}>Build</h3>
          <Build x={x} b={build} token={token} onAuthFail={onAuthFail} onBuild={onBuild} />
        </section>
      )}

      <section className="lp-sec" aria-labelledby={`${hid}-gt`}>
        <h3 id={`${hid}-gt`}>Gates</h3>
        <Gates g={x.gates} status={x.status} />
      </section>

      <section className="lp-sec" aria-labelledby={`${hid}-dc`} ref={decideRef}>
        <h3 id={`${hid}-dc`}>Decision</h3>
        <Decide x={x} token={token} onAuthFail={onAuthFail} onSpec={onSpec} />
      </section>

      <section className="lp-sec" aria-labelledby={`${hid}-hs`}>
        <h3 id={`${hid}-hs`}>History</h3>
        {x.history.length ? (
          <ol className="lp-hist">
            {[...x.history].reverse().map((h, i) => (
              <li key={i}>
                <StatusPill status={h.status} />
                <span className="small">by {BY[h.by] || h.by || "—"}</span>
                {h.at && <time className="tiny muted" dateTime={new Date(h.at).toISOString()}>{when(h.at)}</time>}
                {h.note && <p>“{h.note}”</p>}
              </li>
            ))}
          </ol>
        ) : <p className="muted small">No history yet.</p>}
      </section>
    </article>
  );
}

function RuleOfTwo({ rows }) {
  if (!rows.length) return <p className="lp-verdict t-bad"><Icon name="warn" size={18} />The spec lists no stages, so the rule cannot be checked.</p>;
  const all3 = (r) => r.untrusted && r.private && r.power;
  const broken = rows.filter(all3);
  return (
    <>
      <p className={`lp-verdict ${broken.length ? "t-bad" : "t-good"}`}>
        <Icon name={broken.length ? "warn" : "check"} size={18} />
        {broken.length
          ? `Broken at ${broken.map((r) => r.stage).join(", ")}: untrusted text, private data and the power to change the system in one stage.`
          : "Holds at every stage: none has untrusted text, private data and the power to change the system at once."}
      </p>
      <div className="tscroll">
        <table className="lp-r2">
          <thead><tr><th scope="col">Stage</th><th scope="col">Untrusted text</th><th scope="col">Private data</th><th scope="col">Power to change</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.stage}-${i}`} className={all3(r) ? "t-bad" : ""}>
                <th scope="row"><b>{r.stage}</b>{STAGE[r.stage] && <span className="tiny muted">{STAGE[r.stage]}</span>}</th>
                {["untrusted", "private", "power"].map((k) => <td key={k}><span className={`lp-yes ${r[k] ? "on" : ""}`}>{r[k] ? "Yes" : "No"}</span></td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Gates({ g, status }) {
  if (!g || !g.results.length) {
    const why = status === "refused" ? "Not run: the proposal was refused."
      : ["open", "review", "approved"].includes(status) ? "Not run yet. The gates run on the builder's branch (C1–C3) or before a C0 value ships."
      : "No gate results yet.";
    return <p className="muted small">{why}</p>;
  }
  const n = (ok) => g.results.filter((r) => r.ok === ok).length;
  const failed = n(false), here = !g.pass && !failed && g.subset && g.subsetOk; // (a build runs the gates without the GPU)
  return (
    <>
      <p className={`lp-verdict ${g.pass || here ? "t-good" : failed ? "t-bad" : ""}`}>
        <Icon name={g.pass || here ? "check" : failed ? "close" : "clock"} size={18} />
        {g.pass ? "Passed" : failed ? "Failed" : here ? "Passed on the branch" : "Not finished"} · {n(true)} passed, {failed} failed, {n(null)} not run{here ? " · the GPU gates are yours to run before merging" : ""}
      </p>
      <ol className="lp-gates">
        {g.results.map((r, i) => {
          const k = r.ok === true ? "ok" : r.ok === false ? "fail" : "skip";
          return (
            <li key={`${r.id}-${i}`} className={`g-${k}`}>
              <span className="lp-gate-ic" aria-hidden="true"><Icon name={k === "ok" ? "check" : k === "fail" ? "close" : "more"} size={16} /></span>
              <div>
                <p className="lp-gate-h"><b><span className="lp-gate-n">{i + 1}</span>{r.label}</b><span className="lp-gate-res">{k === "ok" ? "Pass" : k === "fail" ? "Fail" : "Not run"}</span></p>
                {r.what && <p className="tiny muted">{r.what}</p>}
                {r.details && <p className="lp-gate-d">{r.details}</p>}
              </div>
            </li>
          );
        })}
      </ol>
    </>
  );
}

// ---------- the builder's work on an approved C1-C3 proposal: shown above the gates and the decision ----------
const GATE_NAME = { policy: "never-list policy", scan: "code scan", unit: "unit tests", crash_matrix: "crash matrix", redteam: "red team", e2e: "end to end", autopilot_eval: "Autopilot eval", oracle: "the spec's oracle", privacy: "privacy canary" };
const gateList = (gs) => gs.map((g) => GATE_NAME[g] || g).join(", ");
const unitText = (u) => (!u ? "unit tests not run" : u.ok ? `unit tests passed (${u.pass})` : `unit tests failed (${u.fail} of ${u.pass + u.fail})`);
const mins = (s) => (s == null ? "—" : s < 90 ? `${Math.round(s)} s` : `${Math.round(s / 60)} min`);
const STOP = { failed: "The build stopped", refused: "Not built", stopped: "The build was cut off" };
function DiffView({ diff }) {
  const lines = String(diff || "").split("\n");
  return (
    <pre className="lp-diff" aria-label="The branch's diff against its base">
      {lines.map((l, i) => <span key={i} className={l.startsWith("+++") || l.startsWith("---") || l.startsWith("diff ") ? "h" : l.startsWith("@@") ? "at" : l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : ""}>{l}{"\n"}</span>)}
    </pre>
  );
}
function Build({ x, b, token, onAuthFail, onBuild }) {
  const [busy, setBusy] = useState(false), [err, setErr] = useState("");
  const start = async () => {
    setBusy(true); setErr("");
    try { await loop.build(token, x.id); onBuild?.(); } catch (e) { if (e.kind === "auth") onAuthFail(); else setErr(e.message || "The build did not start."); } finally { setBusy(false); }
  };
  const canStart = x.status === "approved" && (!b || b.status !== "building");
  const button = canStart && (
    <div className="lp-row">
      <button className="btn primary" onClick={start} disabled={busy} aria-busy={busy}><Icon name="spark" size={18} />{busy ? "Starting…" : b ? "Build it again" : "Build it"}</button>
      <span className="tiny muted">On its own branch, <span className="mono">loop/{x.id}</span>. The builder never merges, pushes or deploys.</span>
    </div>
  );
  if (!b) return <div className="lp-build">{x.status === "approved" ? <p className="muted small">Approved, not built yet. The builder reads the spec's change and files, never what members wrote, and works in a worktree with no data and no network.</p> : <p className="muted small">No build on record.</p>}{button}{err && <p className="err" role="alert">{err}</p>}</div>;
  const att = b.attempts || [], last = att.at(-1), run = b.gatesRun || [], notRun = b.gatesNotRun || [];
  return (
    <div className="lp-build">
      {b.status === "building" ? (
        <p className="lp-verdict" role="status"><span className="dots" aria-hidden="true"><i /><i /><i /></span>
          {b.phase === "gates" ? `Built on ${b.branch}; the gates are running on it` : `Building: attempt ${b.attempt || att.length + 1} of 3`} · started {ago(b.startedAt)}</p>
      ) : b.status === "built" ? (
        <p className={`lp-verdict ${b.gates?.subsetOk ? "t-good" : "t-bad"}`}><Icon name={b.gates?.subsetOk ? "check" : "warn"} size={18} />
          Built on <span className="mono">{b.branch}</span> in {att.length} attempt{att.length === 1 ? "" : "s"}{b.gates ? (b.gates.subsetOk ? `; ${b.gates.pass ? "every gate" : "the gates run here"} passed` : `; ${b.gates.results.filter((g) => !g.ok).map((g) => GATE_NAME[g.gate] || g.gate).join(", ")} failed`) : ""}</p>
      ) : (
        <p className="lp-reason t-bad"><b>{STOP[b.status] || "Not finished"}</b>{(b.reasons || []).join(" ") || "No reason was recorded."}</p>
      )}
      <dl className="lp-kvs">
        <div><dt>Branch</dt><dd>{b.branch ? <span className="mono">{b.branch}</span> : <span className="muted">{b.status === "building" ? "none yet" : "none"}</span>}{b.commit && <span className="muted"> · {String(b.base || "").slice(0, 7)} → {b.commit.slice(0, 7)}</span>}</dd></div>
        <div><dt>Changed</dt><dd>{b.stat || (last?.changed?.length ? last.changed.join(", ") : <span className="muted">{b.status === "building" ? "nothing yet" : "nothing"}</span>)}</dd></div>
        <div><dt>Base</dt><dd>{b.baseUnit ? unitText(b.baseUnit) : <span className="muted">—</span>}</dd></div>
        <div><dt>Cost</dt><dd>{b.tokens ? `${Math.round((b.tokens.prompt + b.tokens.output) / 1000)}k tokens · ${mins(b.buildSeconds)}` : <span className="muted">—</span>}</dd></div>
      </dl>
      {b.summary && <p className="small">“{b.summary}” <span className="muted">· the builder's own summary</span></p>}
      {att.length > 0 && (
        <ol className="lp-attempts" aria-label="Attempts">
          {att.map((a) => (
            <li key={a.n} className={a.ok ? "ok" : "no"}>
              <span className="lp-gate-ic" aria-hidden="true"><Icon name={a.ok ? "check" : "close"} size={14} /></span>
              <div>
                <p className="lp-gate-h"><b>Attempt {a.n}</b><span className="tiny muted">{a.why} · {a.steps ?? "?"} steps, {a.toolCalls} tool calls · {mins(a.seconds)}</span></p>
                <p className="tiny">{a.changed.length ? `Changed ${a.changed.join(", ")}` : "Changed nothing"} · {unitText(a.unit)}{a.refused.length ? ` · ${a.refused.length} write${a.refused.length > 1 ? "s" : ""} refused` : ""}</p>
                {a.refused.length > 0 && <ul className="lp-files plain tiny">{a.refused.map((r, i) => <li key={i}><span className="mono">{r.path || r.tool}</span>: {r.reason}</li>)}</ul>}
                {a.verify && !a.verify.ok && <p className="tiny lp-gate-d">The spec's check: {a.verify.output}</p>}
              </div>
            </li>
          ))}
          {b.status === "building" && b.phase !== "gates" && <li className="now"><span className="lp-gate-ic" aria-hidden="true"><Icon name="more" size={14} /></span><div><p className="lp-gate-h"><b>Attempt {b.attempt || att.length + 1}</b><span className="tiny muted">working</span></p></div></li>}
        </ol>
      )}
      {b.diff && (
        <details className="lp-diffbox" open={b.diff.length < 4000}>
          <summary>The diff{b.stat ? ` · ${b.stat}` : ""}{b.diffCut ? " (cut at 120,000 characters)" : ""}</summary>
          <DiffView diff={b.diff} />
        </details>
      )}
      {(b.status === "building" || b.status === "built") && (run.length > 0 || notRun.length > 0) && <p className="tiny muted">On the branch, after the build: {gateList(run) || "none"}.{notRun.length ? ` Not run here, for you to run on the GPU before merging: ${gateList(notRun)}.` : ""}</p>}
      {button}
      {err && <p className="err" role="alert">{err}</p>}
    </div>
  );
}

function Decide({ x, token, onAuthFail, onSpec }) {
  const [note, setNote] = useState(""), [busy, setBusy] = useState(null), [err, setErr] = useState(""), [said, setSaid] = useState("");
  const box = useRef(null);
  const nid = `lp-note-${x.id}`;
  const never = x.review && x.review.allowed === false;
  if (!NEEDS_YOU.has(x.status)) {
    const last = [...x.history].reverse().find((h) => h.status === x.status) || x.history.at(-1);
    return (
      <div role="status" className="lp-decided">
        <p className="small">{said || <>{statusOf(x.status).label}{last ? ` by ${BY[last.by] || last.by}, ${ago(last.at)}` : ""}.</>}</p>
        {last?.note && !said && <p className="small muted">“{last.note}”</p>}
        {x.status === "gated" && <p className="tiny muted">{x.gates?.pass ? "Through every gate." : "Through the gates that ran; the build above lists what is still yours to run."} Merging is yours, outside this page: the builder never merges or deploys.</p>}
        {x.change.class === "C0" && x.status === "shipped" && <p className="tiny muted">A C0 change ships by code, without a maintainer. Its flag is under Flags.</p>}
      </div>
    );
  }
  const go = async (decision) => {
    if (decision === "refuse" && !note.trim()) { setErr("Say why: a refusal's note is shown to the club as the reason."); box.current?.focus(); return; }
    setBusy(decision); setErr("");
    try {
      const spec = await loop.decide(token, x.id, decision, note.trim());
      setSaid(decision === "approve" ? `Approved ${x.id}. The builder takes it from here.` : `Refused ${x.id}. The club sees your note as the reason.`);
      onSpec(spec);
    } catch (e) {
      if (e.kind === "auth") onAuthFail(); else setErr(e.message || "The decision did not go through.");
    } finally { setBusy(null); }
  };
  return (
    <div className="lp-decide">
      {x.change.class === "C0" && <p className="tiny muted">A C0 change ships by code without a maintainer; you can still refuse it.</p>}
      {never && <p className="lp-reason t-bad"><b>Cannot be approved</b>The safety review found it on the never-list.</p>}
      <label htmlFor={nid}>Note</label>
      <textarea id={nid} ref={box} rows={3} value={note} onChange={(e) => { setNote(e.target.value); setErr(""); }} placeholder="What you checked, or why not" aria-describedby={`${nid}-h`} aria-invalid={!!err} />
      <p id={`${nid}-h`} className="tiny muted">Kept in the proposal's history. A refusal's note is shown to the club as the reason.</p>
      {err && <p className="err" role="alert">{err}</p>}
      <div className="lp-row">
        <button className="btn primary" onClick={() => go("approve")} disabled={!!busy || never} aria-busy={busy === "approve"}><Icon name="check" size={18} />{busy === "approve" ? "Approving…" : "Approve"}</button>
        <button className="btn ghost lp-danger" onClick={() => go("refuse")} disabled={!!busy} aria-busy={busy === "refuse"}><Icon name="close" size={18} />{busy === "refuse" ? "Refusing…" : "Refuse"}</button>
      </div>
    </div>
  );
}

// ---------- flags ----------
function Flags({ st, reload, specs, token, onAuthFail, onFlag }) {
  // live flags first, in the order they first loaded: a rollback must not move the card that was just used
  const seen = useRef(null);
  if (!st.data) return st.phase === "error" ? <Failed tech what="Flags" error={st.error} onRetry={reload} /> : <Loading what="flags" />;
  if (!st.data.length) return <Empty title="No flags declared">A C0 change may only set a key declared in the flags file, inside its range. None is declared yet.</Empty>;
  const STATUS_ORDER = ["canary", "on", "rolledBack", "off"];
  seen.current ||= [...st.data].sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status)).map((f) => f.key);
  const at = (k) => (seen.current.indexOf(k) + 1 || 999);
  const list = [...st.data].sort((a, b) => at(a.key) - at(b.key));
  return (
    <>
      {st.phase === "error" && <Failed tech what="The latest flags" error={st.error} onRetry={reload} />}
      <p className="muted small lp-flags-note">A beta member in the canary gets the new value; when a flag is on, everyone does; otherwise everyone gets the default. A breach turns a flag off by itself.</p>
      <ul className="lp-flags">
        {list.map((f) => <Flag key={f.key} f={f} spec={specs.find((p) => p.id === f.proposal)} token={token} onAuthFail={onAuthFail} onFlag={onFlag} />)}
      </ul>
    </>
  );
}

function Flag({ f, spec, token, onAuthFail, onFlag }) {
  const [open, setOpen] = useState(false), [reason, setReason] = useState(""), [busy, setBusy] = useState(false), [err, setErr] = useState("");
  const box = useRef(null);
  const live = f.status === "canary" || f.status === "on";
  const [label, tone] = FLAG[f.status] || [f.status, "neutral"];
  const rid = `lp-rb-${f.key.replace(/\W/g, "-")}`;
  useEffect(() => { if (open) box.current?.focus(); }, [open]);
  const submit = async (e) => {
    e.preventDefault();
    if (!reason.trim()) { setErr("Say why: the reason is kept in the flag's history."); box.current?.focus(); return; }
    setBusy(true); setErr("");
    try { const nf = await loop.rollback(token, f.key, reason.trim()); setOpen(false); setReason(""); onFlag(nf); }
    catch (e2) { if (e2.kind === "auth") onAuthFail(); else setErr(e2.message || "The rollback did not go through."); }
    finally { setBusy(false); }
  };
  const gets = f.status === "canary" ? `Beta members in the canary get ${fmt(f.value)}; everyone else gets ${fmt(f.default)}.`
    : f.status === "on" ? `Everyone gets ${fmt(f.value)}.` : `Everyone gets the default, ${fmt(f.default)}.`;
  return (
    <li className="panel lp-flag">
      <header className="lp-flag-h">
        <h3 className="mono">{f.key}</h3>
        <span className={`lp-status t-${tone}`}><i aria-hidden="true" />{label}</span>
      </header>
      <dl className="lp-kvs">
        <div><dt>Value</dt><dd><b>{fmt(f.value)}</b> <span className="muted">default {fmt(f.default)}{f.range ? `, range ${f.range[0]}–${f.range[1]}` : ""}{f.type ? ` · ${f.type}` : ""}</span></dd></div>
        <div><dt>Canary</dt><dd>{Math.round(f.canary * 100)}% of beta members</dd></div>
        <div><dt>Beta</dt><dd>{f.beta} {f.beta === 1 ? "member" : "members"}</dd></div>
        <div><dt>Since</dt><dd>{f.since ? when(f.since) : "—"}</dd></div>
        <div><dt>Proposal</dt><dd>{f.proposal ? <><a href={link({ p: f.proposal })}>{f.proposal}</a>{spec ? <span className="muted"> · {spec.title}</span> : null}</> : <span className="muted">none</span>}</dd></div>
      </dl>
      <p className="small lp-gets">{gets}</p>
      {!f.history.length ? <p className="small muted lp-nohist">History: no changes yet.</p> : (
      <details className="lp-fhist" open={f.history.length <= 2}>
        <summary>History ({f.history.length})</summary>
        <ol>
          {f.history.map((h, i) => (
            <li key={i}>
              <span className="lp-row">
                {h.status && <span className={`lp-status t-${(FLAG[h.status] || [, "neutral"])[1]}`}><i aria-hidden="true" />{(FLAG[h.status] || [h.status])[0]}</span>}
                {h.value !== undefined && <span className="small">value {fmt(h.value)}</span>}
                <span className="small muted">by {BY[h.by] || h.by || "—"}</span>
                {h.at && <time className="tiny muted" dateTime={new Date(h.at).toISOString()}>{when(h.at)}</time>}
              </span>
              {(h.reason || h.note) && <p>{h.reason || h.note}</p>}
            </li>
          ))}
        </ol>
      </details>)}
      {live ? (open ? (
        <form className="lp-rollback" onSubmit={submit} noValidate>
          <label htmlFor={rid}>Why roll back {f.key}?</label>
          <textarea id={rid} ref={box} rows={2} value={reason} onChange={(e) => { setReason(e.target.value); setErr(""); }} aria-invalid={!!err} placeholder="What you saw" />
          {err && <p className="err" role="alert">{err}</p>}
          <p className="tiny muted">Everyone gets the default, {fmt(f.default)}, at once{f.proposal ? `, and ${f.proposal} is marked rolled back` : ""}.</p>
          <div className="lp-row">
            <button className="btn lp-danger" type="submit" disabled={busy} aria-busy={busy}><Icon name="back" size={18} />{busy ? "Rolling back…" : "Roll back now"}</button>
            <button className="btn ghost" type="button" onClick={() => { setOpen(false); setErr(""); }} disabled={busy}>Cancel</button>
          </div>
        </form>
      ) : <button className="btn ghost lp-danger lp-rb" onClick={() => setOpen(true)}><Icon name="back" size={18} />Roll back</button>)
        : <p className="tiny muted">{f.status === "rolledBack" ? "Rolled back: everyone has the default." : "Off: nothing has shipped on this key."}</p>}
    </li>
  );
}

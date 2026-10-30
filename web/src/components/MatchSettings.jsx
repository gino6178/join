import { useEffect, useState } from "react";
import { agentFetch } from "../agent.js";
import "./MatchSettings.css";

// Finding a game: what your agent tells other players' agents, whether your records help improve the predictions,
// and (for the club) fair exposure; for the maintainer, the prediction in use, retraining and rolling back. Everything
// starts off for you, and /forget in Messenger sets it back to off. The settings live on your gateway.
const get = (p) => agentFetch(p).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`gateway ${r.status}`))));
const post = (p, body) => agentFetch(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`gateway ${r.status}`))));
const label = (v) => String(v || "").replace(/^likely-[a-z]+-/, "");

function Switch({ id, on, disabled, onChange, children, note }) {
  return (
    <li className={`ms-row ${disabled ? "off" : ""}`}>
      <input id={id} type="checkbox" role="switch" checked={!!on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <label htmlFor={id}><b>{children}</b>{note && <span className="tiny muted">{note}</span>}</label>
    </li>
  );
}

export default function MatchSettings({ player = "you" }) {
  const [s, setS] = useState(null), [err, setErr] = useState(""), [models, setModels] = useState(null), [job, setJob] = useState(null);
  const load = () => get(`/api/match/settings?player=${encodeURIComponent(player)}`).then(setS).catch((e) => setErr(`Couldn't reach your agent (${e.message}).`));
  useEffect(() => { load(); get("/api/match/models").then(setModels).catch(() => {}); }, [player]);
  const change = (patch) => post("/api/match/settings", { player, ...patch }).then((x) => setS({ ...s, ...x })).catch((e) => setErr(`Couldn't save (${e.message}).`));
  const club = (patch) => post("/api/match/club", patch).then((c) => setS({ ...s, club: c })).catch((e) => setErr(`Couldn't save (${e.message}).`));
  const retrain = () => post("/api/match/retrain", {}).then((r) => { setJob(r.job); const t = setInterval(() => get("/api/match/retrain").then((j) => { setJob(j); if (j.state !== "running") { clearInterval(t); get("/api/match/models").then(setModels); } }), 3000); }).catch((e) => setErr(`Couldn't start (${e.message}).`));
  const back = () => post("/api/match/rollback", {}).then(() => get("/api/match/models").then(setModels)).catch((e) => setErr(`Couldn't roll back (${e.message}).`));
  if (!s) return <section className="you-sec match-settings" aria-labelledby="ms-h"><h2 id="ms-h" className="sec-label">Finding a game</h2><p className="muted small">{err || "Loading…"}</p></section>;
  return (
    <section className="you-sec match-settings" aria-labelledby="ms-h">
      <h2 id="ms-h" className="sec-label">Finding a game</h2>
      <ul className="ms-list">
        <Switch id="ms-bands" on={s.bands} onChange={(v) => change({ bands: v })}
          note="When another player's agent asks how likely you are to say yes, your agent answers with one word: unlikely, maybe, likely or very likely. It works that out on your server from your own answers and games, which never leave it.">
          Tell other players' agents how likely I am to say yes
        </Switch>
        <Switch id="ms-exact" on={s.exact} disabled={!s.bands} onChange={(v) => change({ exact: v })}
          note={`Your exact chance instead of a word, rounded to 5% and only from 15% up. It tells the other agent a little more about you. ${s.measured?.exact || ""}`}>
          Share my exact chance
        </Switch>
        <Switch id="ms-learn" on={s.learn} onChange={(v) => change({ learn: v })}
          note="Your answers and games may be used, on your server only, to make the predictions better for everyone. This is separate from the switch above.">
          Use my records to improve the predictions
        </Switch>
      </ul>
      <h3 className="ms-h3">For the club</h3>
      <ul className="ms-list">
        <Switch id="ms-fair" on={s.club?.fairExposure} onChange={(v) => club({ fairExposure: v })}
          note={`Two of the twelve agents asked are people the usual order would not reach, and among equal answers the person asked least this week goes first. ${s.measured?.fairExposure || ""}`}>
          Fair exposure
        </Switch>
      </ul>
      {models && (
        <div className="ms-models">
          <p className="small"><b>Prediction in use:</b> {label(models.inUse) || "simple rules"}{models.history?.length ? ` · ${models.history.length} change${models.history.length > 1 ? "s" : ""} on record` : ""}</p>
          <div className="play-actions">
            <button className="btn ghost" onClick={retrain} disabled={job?.state === "running"}>{job?.state === "running" ? "Retraining…" : "Retrain from agreed records"}</button>
            {models.active && <button className="btn ghost" onClick={back}>Roll back</button>}
          </div>
          {job?.report && <p className="tiny muted" role="status">{job.report.installed ? `A new prediction passed every check and is in use (${label(job.report.version)}).` : `Nothing changed: ${job.report.reason || (job.report.gate?.why || []).join("; ") || job.report.error || "it did not pass the checks"}.`}</p>}
          <p className="tiny muted">A new prediction is used only if, on answers it never saw, it is as accurate as the one in use and each word still means what it says.</p>
        </div>
      )}
      {err && <p className="err" role="alert">{err}</p>}
    </section>
  );
}

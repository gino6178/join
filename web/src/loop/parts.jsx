// Small pieces both loop pages use: status and class labels, the loading, error and empty states, times.
import Icon from "../components/Icon.jsx";
import { source } from "./api.js";

// a proposal's status, as the club reads it; the tone colours a dot beside the label, never the only signal
export const STATUS = {
  open: { label: "Open", tone: "neutral", note: "Collecting support from the club" },
  review: { label: "In review", tone: "warn", note: "The safety review is checking it" },
  approved: { label: "Approved", tone: "agent", note: "A maintainer said yes; it is built next" },
  building: { label: "Building", tone: "agent", note: "Being built and tested on its own branch" },
  gated: { label: "Gated", tone: "agent", note: "Through the safety gates, waiting to ship" },
  shipped: { label: "Shipped", tone: "good", note: "Live behind a flag that switches itself off if anything goes wrong" },
  rolledBack: { label: "Rolled back", tone: "warn", note: "Its flag was switched off" },
  refused: { label: "Refused", tone: "bad", note: "Not allowed; the reason is shown" },
};
export const statusOf = (s) => STATUS[s] || { label: String(s), tone: "neutral", note: "" };

export function StatusPill({ status }) {
  const s = statusOf(status);
  return <span className={`lp-status t-${s.tone}`} title={s.note}><i aria-hidden="true" />{s.label}</span>;
}

// change classes: C0 is a config value inside its declared range, shipped by code; C1 to C3 change code
export const classNote = (c) => (c === "C0"
  ? "A config value inside its declared range. Ships by code behind a flag, to a canary of beta members, with no maintainer."
  : "A code change. It needs the maintainer, is built on its own branch and goes through every gate.");
export function ClassPill({ c }) {
  return <span className={`lp-class ${c === "C0" ? "c0" : ""}`} title={classNote(c)}>{c}</span>;
}

export function Loading({ what }) {
  return <div className="lp-state" role="status"><span className="lp-dots" aria-hidden="true"><i /><i /><i /></span><span>Loading {what}…</span></div>;
}
// tech: the maintainer's page, where the hint can name the gateway and its settings; members get plain words
export function Failed({ error, what, onRetry, tech = false }) {
  const hint = !tech ? (error?.kind === "offline" ? "Try again in a moment." : null)
    : error?.kind === "offline" ? "Check that the gateway is running and that VITE_AGENT_URL points at it."
    : error?.kind === "missing" ? "The community loop's routes (/api/loop/*) are not on this gateway yet. Until they are, the page can show its sample data."
    : null;
  return (
    <div className="lp-state is-err" role="alert">
      <Icon name="warn" size={22} />
      <div>
        <b>{what} could not be loaded.</b>
        <p>{error?.message || "Something went wrong."}{hint ? ` ${hint}` : ""}</p>
        <div className="lp-row">
          {onRetry && <button className="btn ghost sm" onClick={onRetry}>Try again</button>}
          {tech && error?.kind === "missing" && source() === "live" && <a className="btn ghost sm" href={withParam("loop", "mock")}>Show the sample data</a>}
        </div>
      </div>
    </div>
  );
}
export function Empty({ title, children }) {
  return <div className="lp-state is-empty"><b>{title}</b>{children && <p>{children}</p>}</div>;
}

// the current address with one query value set (the pages' state lives in the hash: #/page?k=v)
export function withParam(k, v) {
  const [path, q = ""] = location.hash.split("?");
  const p = new URLSearchParams(q);
  if (v == null) p.delete(k); else p.set(k, v);
  const s = p.toString();
  return `${path || "#/"}${s ? `?${s}` : ""}`;
}

export function ago(t) {
  if (!t) return "";
  const s = (Date.now() - t) / 1000;
  return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
}
export const when = (t) => (t ? new Date(t).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");

export function LockIcon({ size = 20 }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="10.5" width="14" height="10" rx="2" /><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3M12 14.5v2.5" />
    </svg>
  );
}

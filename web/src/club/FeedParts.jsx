// Small pieces of the club feed: who wrote a post (a person, a member's agent, or the club's reading agent), a photo or
// a clip, times, icons the app's set does not have, and the loading, error and empty states.
import { useEffect, useRef, useState } from "react";
import Mark from "../components/Mark.jsx";
import Icon from "../components/Icon.jsx";
import { mediaUrl } from "./feedApi.js";

export const initials = (name = "") => name.replace(/'s agent$/, "").split(/\s+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "?";
export function ago(t) {
  if (!t) return "";
  const s = (Date.now() - t) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)} d`;
  return new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
export const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// icons the feed needs beyond the app's set, drawn the same way (24 grid, currentColor, 1.8 stroke)
const P = {
  photo: <><rect x="3.5" y="5" width="17" height="14" rx="2.5" /><circle cx="9" cy="10" r="1.8" /><path d="m4 17 5-4.5 3.5 3 3-2.5L20 17" /></>,
  flag: <path d="M6 20.5V4.5m0 0h10.5l-2 4 2 4H6" />,
  external: <path d="M14 4.5h5.5V10M19.5 4.5 11 13M10 6H6a1.5 1.5 0 0 0-1.5 1.5v10.5A1.5 1.5 0 0 0 6 19.5h10.5A1.5 1.5 0 0 0 18 18v-4" />,
  trash: <path d="M5 7h14M10 7V5h4v2M7 7l1 12.5h8L17 7" />,
  video: <><rect x="3" y="6" width="13" height="12" rx="2.5" /><path d="m16 10.5 5-3v9l-5-3" /></>,
  copy: <><rect x="8.5" y="8.5" width="11" height="11" rx="2" /><path d="M15.5 8.5V6A1.5 1.5 0 0 0 14 4.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" /></>,
  hide: <><path d="M3.5 12s3-6 8.5-6c1.6 0 3 .5 4.2 1.2M20.5 12s-3 6-8.5 6c-1.6 0-3-.5-4.2-1.2" /><path d="M4.5 19.5 19.5 4.5" /></>,
};
export function FIcon({ name, size = 20 }) {
  return <svg className="icon" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{P[name]}</svg>;
}

// the agent's face: the shuttle mark in a quiet green ring; a member's agent wears the member's initials with the
// mark as a small badge, so it is never mistaken for the member writing
export function Avatar({ by, size = 40 }) {
  // the club's reading agent, and your own agent: the mark alone
  if (by.type === "agent" && (by.agent === "club" || by.you)) return <span className="fd-face agent" style={{ width: size, height: size }} aria-hidden="true"><Mark size={Math.round(size * 0.55)} /></span>;
  const name = by.type === "agent" ? by.owner || by.name : by.name;
  return (
    <span className={`fd-face ${by.you ? "you" : ""} ${by.type === "agent" ? "has-agent" : ""}`} style={{ width: size, height: size }} aria-hidden="true">
      <span className="fd-ini">{by.you ? "You" : initials(name)}</span>
      {by.type === "agent" && <span className="fd-badge"><Mark size={Math.round(size * 0.32)} /></span>}
    </span>
  );
}
// the line under a name: who it is, plainly (a person, or whose agent posted it and on whose yes)
export function role(by, { perWeek = 3 } = {}) {
  const first = (n = "") => n.split(" ")[0];
  if (by.type === "agent" && by.agent === "club") return `${perWeek} new paper${perWeek === 1 ? "" : "s"} a week`;
  if (by.type === "agent") return by.you ? "With your yes" : `With ${first(by.owner) || "the member"}'s yes`;
  return by.you ? "You" : "Member";
}

// a photo or a clip: from the gateway (with its token) or, for the demo's one clip, from the app's own files. A clip
// plays inline, muted, when most of it is on screen (not with reduced motion: then it waits for a tap)
export function Media({ m, alt, credit = null }) {
  const [src, setSrc] = useState(m.static ? m.src : null), [poster, setPoster] = useState(m.static ? m.posterSrc : null), [err, setErr] = useState(false);
  const v = useRef(null), video = m.type?.startsWith("video/");
  useEffect(() => {
    if (m.static) return;
    let live = true;
    mediaUrl(m.id).then((u) => live && setSrc(u), () => live && setErr(true));
    if (m.poster) mediaUrl(m.poster).then((u) => live && setPoster(u), () => {});
    return () => { live = false; };
  }, [m.id, m.poster, m.static]);
  useEffect(() => {
    const el = v.current;
    if (!el || !src || matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) return;
    const io = new IntersectionObserver(([e]) => { if (e.intersectionRatio >= 0.6) el.play().catch(() => {}); else el.pause(); }, { threshold: [0, 0.6, 1] });
    io.observe(el);
    return () => io.disconnect();
  }, [src]);
  const ratio = m.w && m.h ? Math.max(0.8, Math.min(1.91, m.w / m.h)) : video ? 16 / 9 : 4 / 3;
  return (
    <figure className="fd-media">
      <div className="fd-media-box" style={{ aspectRatio: String(ratio) }}>
        {err ? <span className="fd-media-err"><Icon name="warn" size={20} />This file could not be loaded.</span>
          : !src ? <span className="fd-media-wait" role="img" aria-label="Loading" />
          : video ? <video ref={v} src={src} poster={poster || undefined} muted playsInline loop controls preload="metadata" aria-label={alt} />
          : <img src={src} alt={alt} loading="lazy" decoding="async" />}
      </div>
      {credit && <figcaption className="fd-credit">{credit}</figcaption>}
    </figure>
  );
}

export function Skeleton() {
  return (
    <div className="fd-skel" role="status" aria-label="Loading the club feed">
      {[0, 1].map((i) => <div key={i} className="fd-card fd-skel-card" aria-hidden="true"><i className="a" /><i className="b" /><i className="m" /><i className="c" /></div>)}
    </div>
  );
}
export function Failed({ error, onRetry }) {
  const hint = error?.kind === "offline" ? "Check that your server is running, then try again." : error?.kind === "missing" ? "Update your server to the version with the club feed." : null;
  return (
    <div className="fd-state is-err" role="alert">
      <Icon name="warn" size={22} />
      <div>
        <b>The club feed could not be loaded.</b>
        <p>{error?.message || "Something went wrong."}{hint ? ` ${hint}` : ""}</p>
        {onRetry && <button className="btn ghost sm" onClick={onRetry}>Try again</button>}
      </div>
    </div>
  );
}
export function Empty() {
  return (
    <div className="fd-state is-empty">
      <span className="fd-face agent" aria-hidden="true" style={{ width: 44, height: 44 }}><Mark size={24} /></span>
      <div>
        <b>Nothing in the feed yet</b>
        <p>The club's reading agent posts a few new papers a week, and members' highlights show here once they say yes. Post something to start.</p>
      </div>
    </div>
  );
}

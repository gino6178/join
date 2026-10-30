import Icon from "./Icon.jsx";
import "./effect.css";

// The highlight's camera effect (agent/src/reel.js with video/pose/orbit.py on your GPU server): for your moment the
// server decides a zoom and cut (the default), a short orbit (time stops and the camera turns round you) only when the
// footage allows it, or none when you are not in the picture then (its exists check). What it chose and why, in plain
// words, and the effect's clip drawn into the reel as its replay.

// the effect the server rendered, or null (not asked for, skipped or failed)
export const effectOf = (d) => (d?.effects && !d.effects.failed && !d.effects.skipped ? d.effects : null);

// "Add a camera effect": the choice before the video goes to the server (shown only when the server can make one)
export function EffectChoice({ on, onChange, disabled }) {
  return (
    <label className="fx-choice"><input type="checkbox" checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span><b>Add a camera effect</b><em>Zoom and cut into your moment, or a short orbit round you when your video allows it. Only while you are in the picture. About a minute more on your server.</em></span></label>
  );
}

const ofN = (x) => { const m = /^(\d+)\/(\d+)$/.exec(String(x || "")); return m ? `${m[1]} of ${m[2]}` : null; };
// what the server chose for the moment, and why
export function EffectNote({ fx }) {
  const off = fx.skipped || fx.failed, seen = ofN(fx.exists?.player), hand = ofN(fx.exists?.hand);
  return (
    <div className={`fx-note ${off ? "none" : fx.mode}`} role="note">
      <p className="fx-note-h"><Icon name={fx.mode === "orbit" ? "route" : fx.mode === "zoom" ? "spark" : "info"} size={18} /><b>{off ? "No camera effect" : fx.chose}</b></p>
      {fx.why?.length > 0 && <ul>{fx.why.map((w, i) => <li key={i}>{w.replace(/^./, (c) => c.toUpperCase())}.</li>)}</ul>}
      {seen && <p className="tiny muted">Checked first that you were in the picture: {seen} looks around the moment{hand ? `, your racket hand ${hand}` : ""}. An effect never aims at you where you aren't.</p>}
      {!off && fx.mode !== "none" && <p className="tiny muted">The reel plays it as its replay{fx.seconds ? ` · ${Math.round(fx.seconds)} s on your GPU` : ""}.</p>}
    </div>
  );
}

// the effect's badge on the picture
export const effectBadge = (fx) => (fx.mode === "orbit" ? `▶ ORBIT · ${Math.abs(fx.sweep?.[0] || 0) + Math.abs(fx.sweep?.[1] || 0)}°` : "▶ ZOOM · SLOW-MO");

// one frame of the effect's clip in the picture's box: the zoom's clip already follows you; the orbit's keeps the
// phone's framing, so its crop is centred across on x (0..1, where you stood at the moment)
export function effectFrame(ctx, box, e, fx, x = .5) {
  const k = Math.max(box.w / e.videoWidth, box.h / e.videoHeight), sw = box.w / k, sh = box.h / k;
  const sx = Math.max(0, Math.min(e.videoWidth - sw, (fx.mode === "orbit" ? x : .5) * e.videoWidth - sw / 2));
  ctx.drawImage(e, sx, (e.videoHeight - sh) / 2, sw, sh, box.x, box.y, box.w, box.h);
}

// play the effect's clip once, calling frame(clip) on every screen frame; false when it could not be played
export async function playEffect(fx, stop, frame) {
  const clip = document.createElement("video");
  clip.muted = true; clip.playsInline = true; clip.src = fx.video;
  await new Promise((ready) => { clip.oncanplay = ready; clip.onerror = ready; setTimeout(ready, 4000); });
  if (!clip.videoWidth || stop.current) return false;
  await clip.play().catch(() => {});
  const until = Math.max(.2, (clip.duration || 3) - .05);
  await new Promise((done) => {
    const tick = () => { if (stop.current || clip.ended || clip.currentTime >= until) return done(); frame(clip); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  clip.pause();
  return true;
}

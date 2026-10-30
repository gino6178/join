import { useEffect, useRef, useState } from "react";
import { shareLinks } from "../club/share.js";
import { feedApi } from "../club/feedApi.js";
import { agentCaption, agentReel, agentStatus } from "../agent.js";
import Brand from "../components/Brand.jsx";
import Icon from "../components/Icon.jsx";
import { EffectChoice, EffectNote, effectOf, effectBadge, effectFrame, playEffect } from "../components/Effect.jsx";
import "./highlights.css";

// Film a highlight: a clip you filmed of your own game, in any ball sport, becomes a reel to post. The clip goes to your
// own GPU server once (agent/src/reel.js runs video/pose/reel.py): DETR finds you, Sapiens2 reads your pose on every
// frame, SAM 2.1 cuts you out, and your best moment is found (the fastest swing, the top of a jump, a kick). This page
// then cuts the reel in the browser: the moment at real speed, a slow-motion replay that pushes in on you, a hold on
// contact and a freeze, with your footage on top and how Serve sees you under it. Muse Glimmer writes the caption.
// Nothing is posted until you pick an app; until then the video exists only on this device. Without a video of your own,
// a sample clip (public/media/samples, trimmed from CC BY 3.0 videos) goes the same way, with its credit wherever it
// plays: on the page, on the reel's frames and in the caption. With "Add a camera effect" the server also decides and
// renders a camera effect for the moment (components/Effect.jsx), which the reel plays as its replay.
const ME = "#6FB6FF", THEM = "#FF8A6B", CREAM = "#F2E6C9", INK = "#04070A";
const FORMATS = {
  vertical: { kind: "vertical", W: 720, H: 1280, label: "9:16 vertical", note: "Reels, TikTok, Shorts", zoom: 1.05, vid: { x: 0, y: 170, w: 720, h: 560 }, ai: { x: 0, y: 742, w: 720, h: 370 } },
  wide: { kind: "wide", W: 1280, H: 720, label: "16:9 wide", note: "YouTube, club screens", zoom: 1.3, vid: { x: 0, y: 0, w: 1280, h: 720 }, ai: { x: 856, y: 430, w: 400, h: 225 } },
};
export const SPORTS = [["badminton", "Badminton"], ["tennis", "Tennis"], ["pickleball", "Pickleball"], ["table tennis", "Table tennis"], ["basketball", "Basketball"], ["volleyball", "Volleyball"], ["soccer", "Soccer"]];
// the moment the server found, by sport: a smash, a shot, a jump shot, a spike or a kick
const kindOf = (d) => d?.kind || "smash";
const MOMENT = { smash: "your fastest overhead swing", shot: "your fastest swing", "jump shot": "the top of your jump", spike: "the top of your jump", kick: "your fastest kick" };
const TYPES = ["video/mp4;codecs=avc1.42E01E", "video/mp4", "video/webm;codecs=vp9", "video/webm"];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const lerp = (a, b, u) => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
export const creditOf = (s) => `CC BY 3.0, ${s.author}, trimmed`;

// ---- the people on a frame: keypoints [x, y, score] (COCO-17, then big toes, heels, neck, index fingertips) and an
// outline (flat [x0, y0, x1, y1, ...]), in the clip's pixels; [you, the other player] per frame
const seen = (q) => q && q[2] > .3;
const at = (d, t) => { const i = Math.round(t * d.fps), f = d.frames; return f[i] || f[i - 1] || f[i + 1] || null; };
const BONES = [[5, 7], [7, 9], [6, 8], [8, 10], [5, 6], [5, 11], [6, 12], [11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [15, 17], [16, 18], [15, 19], [16, 20], [9, 22], [10, 23], [0, 21], [21, 5], [21, 6]];
const FEET = [15, 16, 19, 20];
function middle(p) {
  const q = p.k.filter(seen);
  return q.length ? [q.reduce((s, x) => s + x[0], 0) / q.length, q.reduce((s, x) => s + x[1], 0) / q.length] : null;
}
const height = (p) => { const f = FEET.map((i) => p.k[i]).filter(seen); return seen(p.k[0]) && f.length ? Math.max(...f.map((q) => q[1])) - p.k[0][1] : 0; };
// the racket head (or the hand, without a racket): past the higher wrist, along the forearm, a third of your height
function reach(p) {
  const w = [9, 10].filter((i) => seen(p.k[i])).sort((a, b) => p.k[a][1] - p.k[b][1])[0];
  if (w == null) return null;
  const W = p.k[w], E = p.k[w - 2], len = .3 * (height(p) || 120);
  if (!seen(E)) return [W[0], W[1]];
  const d = Math.hypot(W[0] - E[0], W[1] - E[1]) || 1;
  return [W[0] + ((W[0] - E[0]) / d) * len, W[1] + ((W[1] - E[1]) / d) * len];
}

// ---- drawing ----
// the camera's crop of the clip for a box on the canvas, and the map from clip pixels onto the canvas
function crop(box, cam, d) {
  const ar = box.w / box.h, ch = Math.min(d.h, d.w / ar) / cam.z, cw = ch * ar;
  const sx = Math.max(0, Math.min(d.w - cw, cam.x - cw / 2)), sy = Math.max(0, Math.min(d.h - ch, cam.y - ch / 2)), k = box.w / cw;
  return { sx, sy, cw, ch, k, P: ([x, y]) => [box.x + (x - sx) * k, box.y + (y - sy) * k] };
}
function outline(ctx, m, P) { ctx.beginPath(); for (let i = 0; i < m.length; i += 2) { const [x, y] = P([m[i], m[i + 1]]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); } ctx.closePath(); }
function bones(ctx, p, P, lw, color = "#ffffffd9") {
  ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.lineCap = "round";
  for (const [a, b] of BONES) if (seen(p.k[a]) && seen(p.k[b])) { const [x0, y0] = P(p.k[a]), [x1, y1] = P(p.k[b]); ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); }
  ctx.fillStyle = color;
  p.k.forEach((q, i) => { if (!seen(q) || (i > 0 && i < 5)) return; const [x, y] = P(q); ctx.beginPath(); ctx.arc(x, y, lw * (i === 9 || i === 10 ? 1.7 : 1.1), 0, 7); ctx.fill(); });
}
// the replay's spotlight: the picture dims except you (SAM 2.1's cut-out), with a rim of light
let spotCanvas;
function spotlight(ctx, box, p, P, strength) {
  const c = (spotCanvas ||= document.createElement("canvas"));
  if (c.width !== ctx.canvas.width || c.height !== ctx.canvas.height) { c.width = ctx.canvas.width; c.height = ctx.canvas.height; }
  const o = c.getContext("2d");
  o.clearRect(0, 0, c.width, c.height);
  o.fillStyle = `rgba(4,7,10,${.62 * strength})`; o.fillRect(box.x, box.y, box.w, box.h);
  o.globalCompositeOperation = "destination-out"; o.filter = "blur(8px)";
  outline(o, p.m, P); o.fillStyle = "#000"; o.fill();
  o.filter = "none"; o.globalCompositeOperation = "source-over";
  ctx.drawImage(c, 0, 0);
  ctx.save(); ctx.globalAlpha = strength; ctx.shadowColor = ME; ctx.shadowBlur = 22; ctx.strokeStyle = ME; ctx.lineWidth = 2.5; outline(ctx, p.m, P); ctx.stroke(); ctx.restore();
}
function label(ctx, box, text) {
  ctx.fillStyle = "#ffffffa8"; ctx.font = `600 ${Math.min(17, Math.round(box.w / 26))}px Segoe UI, sans-serif`;
  if (box.y) ctx.fillText(text, box.x + Math.min(24, box.w / 30), box.y + Math.min(32, box.h / 9));
  else { ctx.textAlign = "right"; ctx.fillText(text, box.x + box.w - 24, box.y + box.h - 44); ctx.textAlign = "left"; }
}

// how Serve sees you: your outline lit up, your skeleton, and the path of your racket hand over the last half second
function serveView(ctx, box, d, t, cam, phase) {
  const { P, k } = crop(box, cam, d), f = at(d, t), lit = phase !== "live";
  ctx.save(); ctx.beginPath(); ctx.rect(box.x, box.y, box.w, box.h); ctx.clip();
  const bg = ctx.createLinearGradient(0, box.y, 0, box.y + box.h); bg.addColorStop(0, "#04080A"); bg.addColorStop(1, "#0C1D17");
  ctx.fillStyle = bg; ctx.fillRect(box.x, box.y, box.w, box.h);
  const trail = [];
  for (let j = 0; j <= 15; j++) { const g = at(d, t - j / 30)?.[0], tip = g && reach(g); if (tip) trail.push(P(tip)); }
  ctx.lineCap = "round";
  for (let j = 1; j < trail.length; j++) { ctx.globalAlpha = .85 * (1 - j / trail.length); ctx.strokeStyle = CREAM; ctx.lineWidth = Math.max(1.5, 3.2 * k * (1 - j / (trail.length + 2))); ctx.beginPath(); ctx.moveTo(...trail[j - 1]); ctx.lineTo(...trail[j]); ctx.stroke(); }
  ctx.globalAlpha = 1;
  for (const side of [1, 0]) {
    const p = f?.[side];
    if (!p) continue;
    const me = side === 0, col = me ? ME : THEM, lw = Math.max(1.2, k * (me ? 1.3 : .9));
    const feet = FEET.map((i) => p.k[i]).filter(seen);
    if (feet.length) { const [x, y] = P([feet.reduce((s, q) => s + q[0], 0) / feet.length, Math.max(...feet.map((q) => q[1]))]); ctx.fillStyle = "#00000088"; ctx.beginPath(); ctx.ellipse(x, y, 20 * lw, 5 * lw, 0, 0, 7); ctx.fill(); }
    ctx.save(); ctx.globalAlpha = me ? 1 : .45;
    if (p.m) {
      outline(ctx, p.m, P);
      if (me) { ctx.shadowColor = col; ctx.shadowBlur = lit ? 34 : 18; }
      ctx.fillStyle = col + (me ? "F0" : "B0"); ctx.fill();
      ctx.shadowBlur = 0; ctx.strokeStyle = me ? "#ffffff" : col; ctx.lineWidth = me ? 2 : 1; ctx.stroke();
      bones(ctx, p, P, lw, me && phase === "impact" ? "#ffffff" : "#04070A88");
    } else bones(ctx, p, P, lw * 3, col);
    ctx.restore();
  }
  ctx.restore();
  label(ctx, box, box.w < 500 ? "How Serve sees you" : "How Serve sees you · DETR, Sapiens2, SAM 2.1");
}

// one frame of the reel: phase is live, replay, impact, effect or winner (the demo recorder, video/record.mjs, waits on
// it); in the effect, video is the server's effect clip
function draw(ctx, F, d, video, t, cam, phase) {
  const { W, H, vid } = F, c = crop(vid, cam, d), me = at(d, t)?.[0], kind = kindOf(d), fx = phase === "effect" ? effectOf(d) : null;
  const lit = phase === "replay" || phase === "impact" || !!fx;
  ctx.canvas.dataset.phase = phase;
  ctx.fillStyle = INK; ctx.fillRect(0, 0, W, H);
  if (fx) { const p = at(d, fx.cut?.freeze ?? t)?.[0], m = p && middle(p); effectFrame(ctx, vid, video, fx, m ? m[0] / d.w : .5); }
  else if (video.videoWidth) ctx.drawImage(video, c.sx * video.videoWidth / d.w, c.sy * video.videoHeight / d.h, c.cw * video.videoWidth / d.w, c.ch * video.videoHeight / d.h, vid.x, vid.y, vid.w, vid.h);
  if (lit && !fx && me?.m) { ctx.save(); ctx.beginPath(); ctx.rect(vid.x, vid.y, vid.w, vid.h); ctx.clip(); spotlight(ctx, vid, me, c.P, phase === "impact" ? 1 : cam.u ?? 1); ctx.restore(); }
  if (phase === "impact" && me) bones(ctx, me, c.P, Math.max(1.5, c.k * .9));
  if (lit) {
    const bar = vid.h * .07;
    ctx.fillStyle = "#000"; ctx.fillRect(vid.x, vid.y, vid.w, bar); ctx.fillRect(vid.x, vid.y + vid.h - bar, vid.w, bar);
    const by = vid.y + bar + (F.kind === "wide" ? 100 : 16);
    const badge = fx ? effectBadge(fx) : phase === "impact" ? (kind === "kick" ? "● THE KICK" : /jump|spike/.test(kind) ? "● TOP OF THE JUMP" : "● CONTACT") : `▶ ${kind.toUpperCase()} · SLOW-MO`;
    ctx.font = "800 24px Consolas, monospace"; ctx.fillStyle = "#D6332A"; ctx.beginPath(); ctx.roundRect(vid.x + 24, by, ctx.measureText(badge).width + 28, 46, 8); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.fillText(badge, vid.x + 38, by + 31);
    if (phase === "impact") {
      ctx.fillStyle = `rgba(255,255,255,${Math.max(0, .35 - (cam.t || 0) * .9)})`; ctx.fillRect(vid.x, vid.y, vid.w, vid.h);
      const tip = me && reach(me);
      if (tip) {
        const [x, y] = c.P(tip);
        ctx.save(); ctx.beginPath(); ctx.rect(vid.x, vid.y, vid.w, vid.h); ctx.clip();
        ctx.strokeStyle = CREAM; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(x, y, (14 + 50 * (cam.t || 0)) * c.k, 0, 7); ctx.stroke();
        ctx.restore();
      }
    }
  }
  if (phase === "winner") {
    ctx.fillStyle = "#04070A88"; ctx.fillRect(vid.x, vid.y, vid.w, vid.h);
    ctx.save(); ctx.translate(vid.x + vid.w / 2, vid.y + vid.h / 2); ctx.rotate(-0.08);
    ctx.strokeStyle = CREAM; ctx.lineWidth = 6; ctx.strokeRect(-230, -70, 460, 140);
    ctx.fillStyle = CREAM; ctx.textAlign = "center"; ctx.font = "900 64px Bahnschrift, Segoe UI, sans-serif"; ctx.fillText(d.smash != null ? `${kind.toUpperCase()}!` : "RALLY!", 0, 6);
    ctx.font = "700 26px Consolas, monospace"; ctx.fillText("MY GAME · SERVE", 0, 48);
    ctx.restore();
  }
  const a = F.ai, wide = F.kind === "wide";
  if (wide) { ctx.fillStyle = INK; ctx.beginPath(); ctx.roundRect(a.x - 5, a.y - 5, a.w + 10, a.h + 10, 12); ctx.fill(); }
  serveView(ctx, a, d, t, cam, phase);
  if (wide) { ctx.strokeStyle = "#ffffffcc"; ctx.lineWidth = 2; ctx.beginPath(); ctx.roundRect(a.x, a.y, a.w, a.h, 8); ctx.stroke(); }
  const when = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  ctx.fillStyle = CREAM; ctx.font = `600 ${wide ? 20 : 22}px Consolas, monospace`;
  if (!wide) {
    ctx.fillText(`SERVE · MY ${kind.toUpperCase()}`, 40, 62);
    ctx.fillStyle = "#EEF1F2"; ctx.font = "700 40px Segoe UI, sans-serif"; ctx.fillText(fx?.mode === "orbit" ? "Time stops, the camera turns" : "Me, in slow motion", 40, 120);
    ctx.fillStyle = "#8A979E"; ctx.font = "400 22px Segoe UI, sans-serif"; ctx.fillText(d.sample ? `Sample clip · ${d.sample.credit}` : `My own video · ${when}`, 40, 152);
    const y0 = a.y + a.h + 58;
    ctx.fillStyle = CREAM; ctx.font = "800 44px Bahnschrift, Segoe UI, sans-serif"; ctx.fillText(d.smash != null ? `My ${kind}` : "My game", 40, y0);
    ctx.fillStyle = "#8A979E"; ctx.font = "600 20px Consolas, monospace"; ctx.textAlign = "right"; ctx.fillText(phase === "live" ? "REAL SPEED" : fx ? "CAMERA EFFECT" : "QUARTER SPEED", W - 40, y0); ctx.textAlign = "left";
    ctx.fillStyle = "#5FD39A"; ctx.font = "500 18px Consolas, monospace"; ctx.fillText(fx ? "● effect chosen and rendered on my own GPU" : "● read on my own GPU · DETR, Sapiens2, SAM 2.1", 40, H - 30);
  } else {
    const g = ctx.createLinearGradient(0, 0, 0, 140); g.addColorStop(0, "#04070ACC"); g.addColorStop(1, "#04070A00");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, 140);
    ctx.fillStyle = CREAM; ctx.fillText(`SERVE · MY ${kind.toUpperCase()}`, 32, 44);
    ctx.fillStyle = "#EEF1F2"; ctx.font = "800 40px Bahnschrift, Segoe UI, sans-serif"; ctx.fillText(`${fx?.mode === "orbit" ? "Time stops, the camera turns" : "Me, in slow motion"} · ${when}`, 32, 92);
  }
  // a sample clip's credit, on the footage itself
  if (d.sample) {
    ctx.font = "600 16px Segoe UI, sans-serif"; const tw = ctx.measureText(d.sample.credit).width, y = vid.y + vid.h - 40;
    ctx.fillStyle = "#04070AB8"; ctx.beginPath(); ctx.roundRect(vid.x + 16, y, tw + 20, 28, 8); ctx.fill();
    ctx.fillStyle = "#EEF1F2"; ctx.fillText(d.sample.credit, vid.x + 26, y + 19);
  }
}

// the title card before the reel, and the picture before a video is chosen
function card(ctx, F, d) {
  const { W, H } = F;
  ctx.fillStyle = INK; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = CREAM; ctx.font = "600 24px Consolas, monospace"; ctx.fillText(d?.sample ? "SAMPLE CLIP" : d ? "MY OWN VIDEO" : "SERVE · FILM A HIGHLIGHT", 60, H / 2 - 70);
  ctx.fillStyle = "#EEF1F2"; ctx.font = "800 64px Bahnschrift, Segoe UI, sans-serif"; ctx.fillText(d ? `My ${kindOf(d)}` : "Your best moment", 60, H / 2);
  ctx.fillStyle = "#8A979E"; ctx.font = "400 28px Segoe UI, sans-serif"; ctx.fillText(d?.sample ? d.sample.credit : d ? "Read by Sapiens2 and SAM 2.1" : "Choose a video of your game", 60, H / 2 + 54);
}

function playUntil(v, until, stop, frame) {
  return new Promise((done) => {
    let last = performance.now();
    const tick = (now) => {
      const dt = Math.min(.1, (now - last) / 1000); last = now;
      if (stop.current || v.ended || (until != null && v.currentTime >= until)) return done();
      frame(dt); requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

// the reel: the moment at real speed; then the replay: the server's camera effect when it made one, else into slow
// motion pushing in on you, a hold on contact, and out again; and none when the effect was held (you were not in the
// picture at the moment, so nothing aims at you)
async function play(canvas, F, clip, stop) {
  const ctx = canvas.getContext("2d"), d = clip.data;
  card(ctx, F, d);
  const v = document.createElement("video");
  v.muted = true; v.playsInline = true; v.src = clip.url;
  await Promise.all([new Promise((ok) => { v.oncanplay = ok; v.onerror = ok; }), wait(900)]);
  if (!v.videoWidth || stop.current) return;
  const seek = (x) => new Promise((ok) => { v.onseeked = ok; v.currentTime = x; });
  const cam = { x: d.w / 2, y: d.h / 2, z: 1 }, z = F.zoom * 1.25;
  const toward = (dt, zGoal, [tx, ty], rate = 2.4, zRate = 1.6) => {
    const a = 1 - Math.exp(-dt * rate);
    cam.x += (tx - cam.x) * a; cam.y += (ty - cam.y) * a; cam.z += (zGoal - cam.z) * (1 - Math.exp(-dt * zRate));
  };
  // the camera follows you; in the replay it aims part of the way up to your racket, so the contact stays in view
  const you = (t, up = 0) => { const p = at(d, t)?.[0], c = p && middle(p); if (!c) return [cam.x, cam.y]; const tip = up && reach(p); return tip ? lerp(c, tip, up) : c; };
  const fx = effectOf(d), s = d.smash ?? fx?.cut?.freeze ?? null, end = (v.duration || d.n / d.fps) - .05;
  await seek(s != null ? Math.max(0, s - 3) : 0);
  [cam.x, cam.y] = you(v.currentTime); cam.z = z;
  await v.play().catch(() => {});
  await playUntil(v, s != null ? Math.min(end, s + 1.2) : end, stop, (dt) => { toward(dt, z, you(v.currentTime)); draw(ctx, F, d, v, v.currentTime, cam, "live"); });
  if (s != null && !stop.current) v.pause();
  const effect = s != null && !stop.current && fx?.video ? await playEffect(fx, stop, (e) => draw(ctx, F, d, e, s, cam, "effect")) : false;
  if (s != null && !stop.current && !effect && fx?.mode !== "none") {
    const from = Math.max(0, s - 1.4);
    v.pause(); await seek(from);
    v.playbackRate = .6; await v.play().catch(() => {});
    await playUntil(v, s, stop, (dt) => {
      const u = Math.min(1, (v.currentTime - from) / Math.max(.2, s - from));
      v.playbackRate = Math.max(.25, .6 - .35 * u); cam.u = u;
      toward(dt, z * (1 + 1.1 * u), you(v.currentTime, .4 * u), 3.2, 2.2);
      draw(ctx, F, d, v, v.currentTime, cam, "replay");
    });
    if (!stop.current) {
      v.pause();
      const t0 = performance.now();
      await new Promise((done) => {
        const tick = () => { cam.t = (performance.now() - t0) / 1000; toward(1 / 60, z * 2.2, you(s, .4), 3.2, 3); draw(ctx, F, d, v, v.currentTime, cam, "impact"); cam.t < .8 && !stop.current ? requestAnimationFrame(tick) : done(); };
        tick();
      });
      cam.t = 0; v.playbackRate = .3; await v.play().catch(() => {});
      await playUntil(v, Math.min(end, s + .8), stop, (dt) => {
        const u = Math.min(1, (v.currentTime - s) / .8);
        cam.u = 1 - .6 * u; toward(dt, z * (2.1 - .8 * u), you(v.currentTime), 2, 1.4);
        draw(ctx, F, d, v, v.currentTime, cam, "replay");
      });
      v.pause(); cam.u = 1;
    }
  }
  draw(ctx, F, d, v, v.currentTime, cam, "winner");
  await wait(stop.current ? 0 : 1400);
}

export default function Highlights() {
  const [sport, setSport] = useState("badminton");
  // the clip: { url, state: reading | ready | failed, steps, working, error, data }
  const [clip, setClip] = useState(null);
  const [fmt, setFmt] = useState("vertical");
  const [state, setState] = useState("idle"); // idle | preview | recording
  const [file, setFile] = useState(null); // the finished video: { url, blob, ext }
  const [cap, setCap] = useState(null); // { text, by } from Muse Glimmer
  const [writing, setWriting] = useState(false);
  const [msg, setMsg] = useState("");
  const [samples, setSamples] = useState([]), [pick, setPick] = useState(null); // the sample clips, and the one on show
  const [fxReady, setFxReady] = useState(false), [fxOn, setFxOn] = useState(true); // the camera effect: can the server make one, and do you want it
  useEffect(() => { agentStatus().then((s) => setFxReady(!!s.reelEffects)).catch(() => {}); }, []);
  useEffect(() => { fetch("/media/samples/samples.json").then((r) => (r.ok ? r.json() : null)).then((j) => { setSamples(j?.clips || []); setPick((p) => p || j?.clips?.[0] || null); }).catch(() => {}); }, []);
  const canvas = useRef(null), stop = useRef(false);
  const F = FORMATS[fmt], ready = clip?.state === "ready" ? clip : null, d = ready?.data, kind = kindOf(d);
  useEffect(() => () => { stop.current = true; }, []);
  useEffect(() => { if (canvas.current && state === "idle" && !file) card(canvas.current.getContext("2d"), F, d); }, [fmt, state, file, d]);

  const choose = async (f, sample = null) => {
    if (!f) return;
    if (clip?.url) URL.revokeObjectURL(clip.url);
    const c = { url: URL.createObjectURL(f), state: "reading", steps: [], working: sample ? "Sending the sample clip to your own server" : "Sending your video to your own server" };
    setClip(c); setFile(null); setCap(null); setMsg("");
    const mine = (fn) => setClip((x) => (x && x.url === c.url ? fn(x) : x));
    try {
      const data = await agentReel(f, (e) => mine((x) => (e.type === "step" ? { ...x, steps: [...x.steps, e] } : { ...x, working: e.step })), sample?.sport || sport, fxReady && fxOn);
      mine((x) => ({ ...x, state: "ready", working: null, data: { ...data, sample: sample ? { credit: creditOf(sample) } : null } }));
    } catch (e) { mine((x) => ({ ...x, state: "failed", working: null, error: e.message })); }
  };
  // a sample clip goes the same way as a video of your own
  const trySample = async (s) => {
    try { const b = await (await fetch(`/media/samples/${s.file}`)).blob(); await choose(new File([b], s.file, { type: "video/mp4" }), s); }
    catch (e) { setMsg(`The sample could not be loaded (${e.message}).`); }
  };
  const clear = () => { if (clip?.url) URL.revokeObjectURL(clip.url); setClip(null); setFile(null); setCap(null); setMsg(""); };

  const tag = (d?.sport || sport).replace(/\s+/g, "");
  const how = d?.effects?.mode === "orbit" ? "time stopped and the camera turned" : "slowed right down";
  const rule = d?.sample ? `A ${kind}, ${how}: Serve found the player, read the pose and cut them out of the video. #${tag} #${kind.replace(/\s+/g, "")} #ServeApp`
    : `My ${kind}, ${how}: Serve found me, read my pose and cut me out of the video. #${tag} #${kind.replace(/\s+/g, "")} #ServeApp`;
  const caption = `${cap?.text || rule}${d?.sample ? `\n\nFootage: ${d.sample.credit}` : ""}`;
  const write = async () => {
    setWriting(true);
    try { setCap(await agentCaption({ own: { what: d?.smash != null ? `my ${kind} in ${d.sport || sport}, replayed in slow motion` : `a moment from my ${d?.sport || sport} game`, sport: d?.sport || sport, kind } })); }
    catch { setCap(null); setMsg("Muse Glimmer could not be reached; the caption below is the template."); }
    setWriting(false);
  };

  const run = async (record) => {
    if (!ready) return;
    stop.current = false; setFile(null); setMsg(""); setState(record ? "recording" : "preview");
    await new Promise((r) => requestAnimationFrame(r)); // the canvas mounts again if a finished video was showing
    let rec, chunks = [], type;
    if (record) {
      type = TYPES.find((x) => MediaRecorder.isTypeSupported(x));
      rec = new MediaRecorder(canvas.current.captureStream(30), { mimeType: type, videoBitsPerSecond: 4e6 }); // sharp at 720p, small enough to share
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.start(500);
      if (!cap) write();
    }
    await play(canvas.current, F, ready, stop);
    if (rec) {
      await new Promise((ok) => { rec.onstop = ok; rec.stop(); });
      if (!stop.current) { const blob = new Blob(chunks, { type: type.split(";")[0] }); setFile({ url: URL.createObjectURL(blob), blob, ext: type.startsWith("video/mp4") ? "mp4" : "webm" }); }
    }
    setState("idle");
  };

  const name = `serve_my_${kind.replace(/\s+/g, "_")}_${fmt === "vertical" ? "9x16" : "16x9"}`;
  const asFile = () => new File([file.blob], `${name}.${file.ext}`, { type: file.blob.type });
  const share = async (app) => {
    const f = asFile();
    if (navigator.canShare?.({ files: [f] })) {
      try { await navigator.share({ files: [f], title: "My highlight", text: caption }); setMsg(app ? `Shared. Pick ${app === "instagram" ? "Instagram" : "Facebook"} in the share sheet if it did not open.` : "Shared."); } catch { setMsg("Sharing cancelled."); }
      return;
    }
    if (!app) return setMsg("This browser cannot share files directly: download the video and post it with the caption.");
    // on a computer: the reel is saved and the caption copied, and the site opens for the post
    const a = document.createElement("a"); a.href = file.url; a.download = f.name; a.click();
    try { await navigator.clipboard.writeText(caption); } catch { /* the caption is in the box below */ }
    window.open(app === "instagram" ? "https://www.instagram.com/" : "https://www.facebook.com/", "_blank", "noopener");
    setMsg(`The reel is saved and the caption copied: post it from ${app === "instagram" ? "Instagram (Create · Reel)" : "Facebook (Reel)"}.`);
  };
  const copy = async () => { try { await navigator.clipboard.writeText(caption); setMsg("Caption copied."); } catch { setMsg("Could not copy; select the caption text instead."); } };
  // the club feed takes the member's own footage only: their agent drafts the post from the reel, and it waits in the
  // Club feed for their yes (club/feedApi.js, the gateway's feed/highlights.js)
  const toClub = async () => {
    if (d?.sample) return setMsg("A sample clip is not yours to post to the club. Film your own game and post that.");
    setMsg("Your agent is drafting a club post…");
    try { await feedApi.draft(file.blob, { sport: d?.sport || sport, moment: kind, date: new Date().toISOString().slice(0, 10) }); setMsg("Your agent drafted a club post. It waits in the Club feed for your yes."); }
    catch (e) { setMsg(e.message); }
  };

  return (
    <div className="page highlights">
      <header className="report-head">
        <div>
          <span className="tag">Your own video</span>
          <h1 className="h1">Film a highlight</h1>
          <p className="muted">Film your game on your phone, in any ball sport. Your own server finds you, reads your pose and cuts you out, then your best moment comes back as a slow-motion reel to post. The video goes nowhere else.</p>
        </div>
      </header>
      <section className={`hl-grid ${fmt} ${ready || file ? "has-clip" : ""}`}>
        <div className="panel">
          <div className={`own-card ${clip ? clip.state : ""}`}>
            <div className="own-h"><b>{ready ? `Your ${kind}, from your video` : "Choose a video"}</b>
              {clip && state === "idle" && <button className="link" onClick={clear}>{ready ? "Use another video" : "Cancel"}</button>}</div>
            {!clip && <p className="tiny muted">A rally or two with you in the picture is enough. On your GPU server, Meta's DETR finds you, Sapiens2 reads your pose and SAM 2.1 cuts you out; then the reel replays your best moment (a smash, a swing, a jump shot, a spike, a kick).</p>}
            {!clip && (
              <div className="own-row">
                <label className="tiny">Sport <select value={sport} onChange={(e) => setSport(e.target.value)}>{SPORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
                <label className="btn primary sm own-pick"><input type="file" accept="video/*" onChange={(e) => choose(e.target.files?.[0])} /><Icon name="plus" size={16} />Choose a video</label>
              </div>
            )}
            {!clip && fxReady && <EffectChoice on={fxOn} onChange={setFxOn} />}
            {clip && (
              <ol className="own-steps">
                {clip.steps.map((x, i) => <li key={i}><Icon name="check" size={16} /><span><b>{x.step}</b><em>{x.detail}</em></span></li>)}
                {clip.working && <li className="working"><span className="dots" aria-hidden="true"><i /><i /><i /></span><span><b>{clip.working}</b></span></li>}
                {clip.state === "failed" && <li className="failed"><span><b>Could not make the reel</b><em>{clip.error}</em></span></li>}
              </ol>
            )}
            {ready && <p className="tiny muted">{d.smash != null ? `Your ${kind} at ${d.smash.toFixed(1)} s: ${MOMENT[kind] || "your best moment"}.` : effectOf(d)?.cut?.freeze != null ? `Your moment at ${effectOf(d).cut.freeze.toFixed(1)} s: your fastest swing.` : "No clear moment was found, so the reel shows the rally."} Preview it or create the video, then post it.</p>}
            {ready && d.effects && <EffectNote fx={d.effects} />}
            {clip?.state === "failed" && <label className="btn ghost sm own-pick"><input type="file" accept="video/*" onChange={(e) => choose(e.target.files?.[0])} />Try another video</label>}
          </div>
          {!clip && samples.length > 0 && (
            <div className="hl-samples">
              <span className="tiny muted">No video yet? Try a sample clip.</span>
              <ul>
                {samples.map((s) => (
                  <li key={s.file}><button className={`hl-sample ${pick?.file === s.file ? "on" : ""}`} aria-pressed={pick?.file === s.file} onClick={() => setPick(s)}>
                    <video src={`/media/samples/${s.file}#t=2`} muted playsInline preload="metadata" aria-hidden="true" />
                    <span><b>{s.label}</b><em>{creditOf(s)}</em></span>
                  </button></li>
                ))}
              </ul>
              {pick && <button className="btn primary sm" onClick={() => trySample(pick)}><Icon name="spark" size={16} />Make a reel from this clip</button>}
            </div>
          )}
          <div className="seg" role="radiogroup" aria-label="Format">
            {Object.entries(FORMATS).map(([k, f]) => <button key={k} role="radio" aria-checked={fmt === k} disabled={state !== "idle"} onClick={() => { setFmt(k); setFile(null); }}>{f.label}</button>)}
          </div>
          <p className="tiny muted">The camera follows you. {effectOf(d)?.mode === "orbit" ? "The replay is the server's orbit: time stops and the camera turns round you." : effectOf(d)?.mode === "zoom" ? "The replay is the server's zoom and cut: slow motion into your moment, pushing in on you." : effectOf(d)?.mode === "none" ? "No replay: you were not in the picture at the moment." : "The replay goes back to your moment, ramps down to quarter speed and pushes in on you, holds on contact, then eases out and freezes."} {F.note}.</p>
          <div className="hl-actions hl-sticky">
            {state === "idle" ? <>
              <button className="btn ghost" disabled={!ready} onClick={() => run(false)}>Preview reel</button>
              <button className="btn primary" disabled={!ready} onClick={() => run(true)}>Create video</button>
            </> : <button className="btn ghost" onClick={() => { stop.current = true; }}>{state === "recording" ? "Cancel" : "Stop"}</button>}
          </div>
          {state === "recording" && <p className="tiny muted">Recording your {kind}. The video is rendered in this browser.</p>}
          {file && (
            <div className="hl-done">
              <b>Your reel is ready · {(file.blob.size / 1e6).toFixed(1)} MB · .{file.ext}</b>
              <div className="hl-actions">
                <button className="btn primary" onClick={() => share("instagram")}><Brand name="instagram" size={18} color="currentColor" />Instagram</button>
                <button className="btn ghost" onClick={() => share("facebook")}><Brand name="facebook" size={18} />Facebook</button>
                <button className="btn ghost" onClick={() => share(null)}>Share…</button>
                <a className="btn ghost" href={file.url} download={`${name}.${file.ext}`}>Download</a>
                <button className="btn ghost" onClick={copy}>Copy caption</button>
                <button className="btn ghost" onClick={toClub}>Post to the club…</button>
                <a className="chip" href={shareLinks(caption).whatsapp} target="_blank" rel="noopener noreferrer">WhatsApp</a>
                <a className="chip" href={shareLinks(caption).threads} target="_blank" rel="noopener noreferrer">Threads</a>
              </div>
              <p className="tiny muted">{writing ? "Muse Glimmer is writing the caption…" : cap?.by === "model" ? "Caption written by Muse Glimmer · checked" : "Caption from the template"}{!writing && <> · <button className="link" onClick={write}>Write another</button></>}</p>
              <textarea readOnly value={caption} rows={4} aria-label="Suggested caption" />
              {msg && <p className="tiny muted">{msg}</p>}
              <p className="tiny muted">Sharing only happens when you pick an app; until then the video exists only on this device.</p>
            </div>
          )}
          {!file && msg && <p className="tiny muted">{msg}</p>}
        </div>
        <div className="hl-view">
          {file && <video src={file.url} controls playsInline className="hl-canvas" />}
          {!clip && !file && pick && <><video key={pick.file} src={`/media/samples/${pick.file}`} controls muted loop autoPlay playsInline className="hl-canvas hl-sample-play" aria-label={`Sample clip: ${pick.label}`} /><p className="tiny muted hl-credit">Sample clip: <a href={pick.source} target="_blank" rel="noopener noreferrer">{creditOf(pick)}</a> (<a href={pick.license} target="_blank" rel="noopener noreferrer">licence</a>)</p></>}
          <canvas ref={canvas} width={F.W} height={F.H} className="hl-canvas" hidden={!!file || (!clip && !!pick)} aria-label="Highlight reel preview" />
          {d?.sample && <p className="tiny muted hl-credit">Sample clip: {d.sample.credit}</p>}
          <p className="tiny muted hl-how">On top, you, as you will post it. Under it, how Serve sees you: Meta's <b>DETR</b> finds you, <b>Sapiens2</b> reads your pose and <b>SAM 2.1</b> cuts you out; the light line is your racket hand.</p>
        </div>
      </section>
    </div>
  );
}

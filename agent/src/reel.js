// Your own video, made into a highlight reel. The app sends the clip to this gateway on your own GPU server;
// video/pose/reel.py finds you (Meta's DETR), reads your pose (Sapiens2), cuts you out (SAM 2.1) and finds your smash,
// and its steps stream back to the app as they finish. The clip and the working files are deleted as soon as the
// result is sent. Set REEL_PYTHON and REEL_SCRIPT (server/start.sh does), and optionally REEL_GPU, REEL_HF_CACHE and
// REEL_MAX_MB (default 300).
// The camera effect, an optional step (effects: the app's "Add a camera effect"): video/pose/orbit.py decides, for your
// moment, between a zoom and cut (the default), a short orbit (time stops and the camera moves round you, only when the
// footage carries it) and no effect, and renders it. Every effect needs its target in frame: orbit.py's exists check
// (SAM 2.1 tracking you, Sapiens2's racket hand) cuts the effect to where you are, or holds it so the clip plays
// plain. Set REEL_EFFECTS_SCRIPT (orbit.py) and REEL_EFFECTS_PYTHON (the reel's own environment with MapAnything
// added; REEL_PYTHON by default), and optionally ORBIT_MAPANYTHING (a local copy of the weights). It runs on REEL_GPU
// (GPU 0), at nice 19 with 8 CPU threads at most, after the reel, and its clip comes back with the reel.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const MAX = +(process.env.REEL_MAX_MB || 300) * 1e6;
let busy = false; // one reel at a time: the GPU reads one video at a time
export const ready = () => !!(process.env.REEL_PYTHON && process.env.REEL_SCRIPT && fs.existsSync(process.env.REEL_SCRIPT));
export const effectsReady = () => ready() && !!(process.env.REEL_EFFECTS_SCRIPT && fs.existsSync(process.env.REEL_EFFECTS_SCRIPT));
const gpuEnv = () => ({ CUDA_VISIBLE_DEVICES: process.env.REEL_GPU || "0", ...(process.env.REEL_HF_CACHE ? { HF_HUB_CACHE: process.env.REEL_HF_CACHE } : {}) });

export async function make(req, send, sport = "badminton", { effects = false } = {}) {
  if (busy) throw new Error("Another reel is being made on the server. Try again in a minute.");
  busy = true;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reel-")), src = path.join(dir, "in.mp4"), out = path.join(dir, "out.json");
  try {
    let n = 0;
    await new Promise((ok, bad) => {
      const f = fs.createWriteStream(src);
      req.on("data", (c) => { n += c.length; if (n > MAX) { req.destroy(); bad(new Error(`The video is over ${MAX / 1e6} MB. Trim it to the rally.`)); } });
      req.on("error", bad); f.on("error", bad); f.on("finish", ok);
      req.pipe(f);
    });
    send({ type: "step", step: "Received your video", tool: "upload", detail: `${(n / 1e6).toFixed(1)} MB, on your own server only` });
    send({ type: "working", step: "Finding you in every frame" });
    await new Promise((ok, bad) => {
      const env = { ...process.env, ...(process.env.REEL_GPU ? { CUDA_VISIBLE_DEVICES: process.env.REEL_GPU } : {}), ...(process.env.REEL_HF_CACHE ? { HF_HUB_CACHE: process.env.REEL_HF_CACHE } : {}) };
      // at the lowest CPU priority on a shared server (REEL_NICE=off runs it as it is)
      const args = [process.env.REEL_SCRIPT, src, out, String(sport || "badminton").replace(/[^a-z ]/gi, "").slice(0, 20) || "badminton"];
      const nice = process.platform !== "win32" && process.env.REEL_NICE !== "off";
      const p = nice ? spawn("nice", ["-n", "19", process.env.REEL_PYTHON, ...args], { env }) : spawn(process.env.REEL_PYTHON, args, { env });
      let buf = "", err = "";
      const next = { "Opened your video": "Finding you in every frame", "Found you": "Reading your pose and cutting you out", "Read your pose": "Finding your best moment" };
      p.stdout.on("data", (c) => {
        buf += c;
        for (let i; (i = buf.indexOf("\n")) >= 0;) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          try { const x = JSON.parse(line); send({ type: "step", step: x.step, tool: "vision", detail: x.detail }); if (next[x.step]) send({ type: "working", step: next[x.step] }); } catch { /* not a step line */ }
        }
      });
      p.stderr.on("data", (c) => { err = (err + c).slice(-4000); });
      p.on("error", bad);
      p.on("close", (code) => (code === 0 ? ok() : bad(new Error(`The reel step stopped (exit ${code}). ${err.trim().split("\n").pop() || ""}`))));
    });
    const r = JSON.parse(fs.readFileSync(out, "utf8"));
    if (r.error) throw new Error("Nobody stays in the picture long enough. Film the rally with the whole court in view.");
    if (effects) r.effects = effectsReady() ? await effect(src, out, dir, send) : { mode: "none", skipped: true, chose: "No camera effect", why: ["camera effects are not set up on this server"] };
    return r;
  } finally {
    busy = false;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---- the camera effect ------------------------------------------------------------------------------------------
// orbit.py's reasons, in the player's words (its own are an engineer's)
const PLAIN = [
  [/cut off by the frame's edge/, "you are at the edge of the picture, so there is no room to turn the camera"],
  [/cut-out is unsure/, "the outline around you is not clean enough to lift you off the court"],
  [/cut-out is in pieces/, "something is in front of you at the moment"],
  [/pose is not read well/, "your pose is not clear enough at the moment"],
  [/another player overlaps/, "another player overlaps you"],
  [/too small in the frame/, "you are small in the picture: film from closer"],
  [/blurred/, "you are blurred at the moment"],
  [/depth's scale is off|depth at the player disagrees|ambiguous/, "the court's depth could not be read reliably around you"],
  [/court behind the player was ever seen|barely seen/, "not enough of the court behind you was filmed to fill in the turn"],
  [/too little room to orbit/, "the background has too little room to turn the camera"],
  [/rendered orbit invented too much|lost the player/, "the turned view would have had to invent too much of the picture"],
  [/racket hand or the body is hidden or out of frame at the moment/, "your racket hand or body is hidden or out of the picture at the moment"],
  [/not in frame long enough/, "you are not in the picture long enough around the moment"],
  [/never found in the window/, "you are not in the picture around the moment"],
  [/leaves the frame or is hidden in part/, "you leave the picture for part of it, so the effect is cut to where you are"],
  [/not read near the moment/, "you were not read clearly around the moment"],
];
export const plainWhy = (t) => { const s = String(t || ""); for (const [rx, say] of PLAIN) if (rx.test(s)) return say; return s.replace(/\bthe player\b/g, "you").replace(/\bSAM 2\.1\b|\bMapAnything\b|\bSapiens2\b/g, "the model"); };
// what orbit.py's plan means for the player: which effect, why, and how long the cut is
export function summarize(res, { video = null } = {}) {
  const p = res?.plan || {}, ex = p.exists || {}, mode = p.mode || "none";
  const sweep = Array.isArray(p.sweep_deg) ? p.sweep_deg : [0, 0], arc = Math.abs(sweep[0]) + Math.abs(sweep[1]);
  const chose = mode === "orbit" ? `A short orbit: time stops and the camera turns ${arc}° round you`
    : mode === "zoom" ? "Zoom and cut: slow motion into your moment, pushing in on you" : "No camera effect: the clip plays as filmed";
  const why = mode === "orbit" ? [ex.verdict === "cut" ? plainWhy(ex.why) : "you stay in the picture, and the footage has room to turn the camera"]
    : mode === "zoom" ? [...new Set((p.why_not_orbit || []).map(plainWhy))].slice(0, 2)
    : [plainWhy(ex.why) || "you are not in the picture at the moment"];
  if (mode === "zoom" && ex.verdict === "cut") why.push(plainWhy(ex.why));
  if (mode === "zoom" && !why.length) why.push("the zoom is the default; an orbit is added only when the footage allows it");
  return { mode, chose, why: why.filter(Boolean), exists: { verdict: ex.verdict || null, why: ex.why ? plainWhy(ex.why) : null, player: ex.player_on || null, hand: ex.hit_on || null },
    cut: p.cut || null, sweep: mode === "orbit" ? sweep : null, zoom: p.zoom ?? null, shortened: !!p.shortened, seconds: res?.time_s?.total ?? null, ...(video ? { video } : {}) };
}
function effect(src, reelJson, dir, send) {
  send({ type: "working", step: "Choosing a camera effect for your moment" });
  const fx = path.join(dir, "effect.mp4"), plan = path.join(dir, "effect.json"), t0 = Date.now();
  const py = process.env.REEL_EFFECTS_PYTHON || process.env.REEL_PYTHON, args = [process.env.REEL_EFFECTS_SCRIPT, src, reelJson, fx, "--plan", plan];
  const threads = String(Math.min(8, +(process.env.REEL_EFFECTS_THREADS || 8)));
  const env = { ...process.env, ...gpuEnv(), ORBIT_THREADS: threads, OMP_NUM_THREADS: threads, MKL_NUM_THREADS: threads, OPENBLAS_NUM_THREADS: threads };
  // at the lowest CPU priority: the server's CPUs are shared
  const [cmd, argv] = process.platform === "linux" ? ["nice", ["-n", "19", py, ...args]] : [py, args];
  return new Promise((ok) => {
    let err = "", done = false;
    const p = spawn(cmd, argv, { env, stdio: ["ignore", "ignore", "pipe"] });
    const stop = setTimeout(() => { try { p.kill("SIGKILL"); } catch { /* gone */ } }, +(process.env.REEL_EFFECTS_TIMEOUT_MS || 900000));
    const fail = (why) => { if (done) return; done = true; clearTimeout(stop); send({ type: "step", step: "No camera effect this time", tool: "effect", detail: why }); ok({ mode: "none", failed: true, chose: "No camera effect", why: [why] }); };
    p.stderr.on("data", (c) => { err = (err + c).slice(-3000); });
    p.on("error", (e) => fail(`the effect step did not start (${e.code || e.message})`));
    p.on("close", (code) => {
      if (done) return;
      let res = null;
      try { res = JSON.parse(fs.readFileSync(plan, "utf8")); } catch { /* no plan */ }
      // (orbit.py ends with {"error": …} on its last line when the moment can't carry any effect)
      const last = err.trim().split("\n").pop() || "";
      let said = null; try { said = JSON.parse(last).error || null; } catch { /* not its message */ }
      if (code !== 0 || !res?.plan) return fail(said ? plainWhy(said) : `the effect step stopped (exit ${code})${last ? `: ${last.slice(0, 140)}` : ""}`);
      done = true; clearTimeout(stop);
      let video = null;
      try { if (res.plan.mode !== "none" && fs.existsSync(fx) && fs.statSync(fx).size < 40e6) video = `data:video/mp4;base64,${fs.readFileSync(fx).toString("base64")}`; } catch { /* the plan alone */ }
      const s = summarize(res, { video });
      send({ type: "step", step: `Chose the effect: ${s.mode === "orbit" ? "a short orbit" : s.mode === "zoom" ? "zoom and cut" : "none"}`, tool: "effect", detail: `${s.why[0] || ""}${s.why[0] ? " · " : ""}${((Date.now() - t0) / 1000).toFixed(0)} s on your GPU` });
      ok(s);
    });
  });
}

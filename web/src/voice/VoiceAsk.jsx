import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Icon from "../components/Icon.jsx";
import { agentAsr, agentAsrWarm } from "../agent.js";
import "./voice.css";

// Ask out loud. Tap the mic and say it, then tap stop. The browser records a short clip with MediaRecorder (WebM/Opus;
// MP4 in Safari) and sends it to your own server, where Meta's Omnilingual ASR writes it down on the CPU (POST
// /api/asr, English). The words land in the box for you to read over and send: nothing goes to your agent until you
// press send, and the server deletes the clip once it has the words.
const LIMIT = 15; // seconds: a request to your agent is a sentence or two
const SHORTEST = 0.6;
const KINDS = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
const kind = () => KINDS.find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || "";
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s) % 60).padStart(2, "0")}`;

// what the mic is doing, for the sidebar's button too: idle | starting | recording | sending | error
let phaseNow = "idle", wanted = false;
const subs = new Set();
const announce = (p) => { phaseNow = p; subs.forEach((f) => f()); };
const usePhase = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => phaseNow);

// the sidebar's "Ask out loud": opens your agent's home and starts listening there (or stops, if it is listening)
export function AskOutLoud() {
  const p = usePhase(), on = p === "recording";
  const press = () => { wanted = true; if (!/^#\/?(\?|$)/.test(location.hash)) location.hash = "/"; dispatchEvent(new Event("serve:listen")); };
  return (
    <button type="button" className={`voice-btn ${on ? "va-on" : ""}`} onClick={press} aria-pressed={on} title={on ? "Listening: tap to stop" : "Ask your agent out loud"}>
      <Icon name="mic" size={22} /><span className="lbl">{on ? "Listening…" : "Ask out loud"}</span>
    </button>
  );
}

function trouble(e) {
  if (!window.MediaRecorder || !navigator.mediaDevices?.getUserMedia) return "This browser can't record. Type it instead.";
  if (e?.name === "NotAllowedError" || e?.name === "SecurityError") return "The mic is blocked. Allow it for this site, or type it instead.";
  if (e?.name === "NotFoundError") return "No microphone found. Type it instead.";
  return `Couldn't start the mic (${e?.message || e}).`;
}

// the mic in a text box. onText(words) fills the box; field (a ref to it) gets the focus back, caret at the end
export default function VoiceAsk({ onText, field }) {
  const phase = usePhase();
  const [secs, setSecs] = useState(0);
  const [level, setLevel] = useState(0);
  const [problem, setProblem] = useState("");
  const rec = useRef(null), turn = useRef(0), mic = useRef(null), stopBtn = useRef(null), again = useRef(null);

  const free = (s) => {
    clearInterval(s.timer); cancelAnimationFrame(s.raf);
    s.ctx?.close().catch(() => {});
    s.stream.getTracks().forEach((t) => t.stop());
    if (rec.current === s) rec.current = null;
    setLevel(0);
  };
  const fail = (text) => { setProblem(text); announce("error"); requestAnimationFrame(() => again.current?.focus()); };
  const reset = (focus) => { turn.current++; if (rec.current) stop(false); setProblem(""); announce("idle"); if (focus) requestAnimationFrame(() => focus.current?.focus()); };

  async function send(blob, took) {
    if (took < SHORTEST || blob.size < 400) return fail("Too short to hear. Tap the mic and say it again.");
    const mine = ++turn.current;
    announce("sending");
    try {
      const r = await agentAsr(blob);
      if (mine !== turn.current) return; // cancelled while it was being written down
      const words = String(r.text || "").trim();
      if (!words) return fail("I didn't catch any words. Try again a little closer to the mic.");
      announce("idle");
      onText(words, r);
      requestAnimationFrame(() => { const f = field?.current; if (!f) return; f.focus(); const n = f.value.length; f.setSelectionRange?.(n, n); });
    } catch (e) {
      if (mine !== turn.current) return;
      fail(/not set up/i.test(e.message) ? "Speech to text isn't set up on your server yet. Type it instead." : `Couldn't write it down: ${e.message}`);
    }
  }

  // a live level, so you can see it hears you (no meter if the browser has no Web Audio; the clock still runs)
  function meter(s) {
    try {
      const ctx = new AudioContext(), probe = ctx.createAnalyser();
      probe.fftSize = 512;
      ctx.createMediaStreamSource(s.stream).connect(probe);
      const wave = new Float32Array(probe.fftSize);
      s.ctx = ctx;
      const tick = () => {
        probe.getFloatTimeDomainData(wave);
        let sum = 0; for (const v of wave) sum += v * v;
        setLevel(Math.min(1, Math.sqrt(sum / wave.length) * 7));
        s.raf = requestAnimationFrame(tick);
      };
      tick();
    } catch { /* no meter */ }
  }

  async function start() {
    if (rec.current || phaseNow === "starting" || phaseNow === "sending") return;
    setProblem(""); announce("starting");
    let stream;
    try {
      if (!window.MediaRecorder) throw new Error("no MediaRecorder");
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    } catch (e) { return fail(trouble(e)); }
    agentAsrWarm().catch(() => {}); // the model loads on the server while you talk
    const type = kind(), recorder = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 32000 } : undefined);
    const parts = [], s = { recorder, stream, t0: performance.now(), keep: true };
    rec.current = s;
    recorder.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
    recorder.onstop = () => {
      const took = (performance.now() - s.t0) / 1000;
      free(s);
      if (s.keep) send(new Blob(parts, { type: recorder.mimeType || type || "audio/webm" }), took);
      else announce("idle");
    };
    meter(s);
    s.timer = setInterval(() => { const t = (performance.now() - s.t0) / 1000; setSecs(t); if (t >= LIMIT) stop(true); }, 200);
    setSecs(0);
    recorder.start();
    announce("recording");
    requestAnimationFrame(() => stopBtn.current?.focus());
  }
  function stop(keep = true) {
    const s = rec.current;
    if (!s) return;
    s.keep = keep;
    if (s.recorder.state !== "inactive") s.recorder.stop(); else { free(s); announce("idle"); }
  }

  // the sidebar's button: start here, or stop if this is already listening
  useEffect(() => {
    const heard = () => { if (!wanted) return; wanted = false; rec.current ? stop(true) : start(); };
    heard();
    addEventListener("serve:listen", heard);
    return () => removeEventListener("serve:listen", heard);
  });
  // leaving the page stops the mic and drops the clip
  useEffect(() => () => { turn.current++; const s = rec.current; if (s) { s.keep = false; s.recorder.state !== "inactive" ? s.recorder.stop() : free(s); } announce("idle"); }, []);
  // Escape cancels while it listens or writes it down
  useEffect(() => {
    if (phase === "idle") return;
    const key = (e) => { if (e.key === "Escape") reset(mic); };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [phase]);

  const bars = [0.55, 0.8, 1, 0.8, 0.55].map((w, k) => <i key={k} style={{ "--h": Math.min(1, level * w * (0.8 + 0.4 * Math.abs(Math.sin(secs * 3 + k)))) }} />);
  const said = { starting: "Opening the mic.", recording: "Listening. Press Escape to cancel.", sending: "Writing it down on your server.", error: problem }[phase] || "";
  return (
    <>
      <span className="sr-only" role="status" aria-live="polite">{said}</span>
      <button ref={mic} type="button" className="va-mic" onClick={start} aria-label="Ask out loud: record what you want" title="Ask out loud">
        <Icon name="mic" size={22} />
      </button>
      {phase !== "idle" && (
        <div className={`va-live ${phase}`}>
          {phase === "recording" && (
            <>
              <span className="va-dot" aria-hidden="true" />
              <span className="va-time">{clock(secs)}</span>
              <span className="va-bars" aria-hidden="true">{bars}</span>
              <span className="va-say">{secs >= LIMIT - 5 ? `Stopping at ${clock(LIMIT)}` : "Listening… tap stop when you're done"}</span>
              <button type="button" className="va-x" onClick={() => reset(mic)} aria-label="Cancel: don't keep it" title="Cancel"><Icon name="close" size={18} /></button>
              <button ref={stopBtn} type="button" className="va-stop" onClick={() => stop(true)} aria-label="Done: write it down" title="Done">
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2.5" /></svg>
              </button>
            </>
          )}
          {phase === "starting" && <><span className="va-spin" aria-hidden="true" /><span className="va-say">Opening the mic…</span></>}
          {phase === "sending" && (
            <>
              <span className="va-spin" aria-hidden="true" />
              <span className="va-say">Writing it down on your server…</span>
              <button type="button" className="va-x" onClick={() => reset(mic)} aria-label="Cancel" title="Cancel"><Icon name="close" size={18} /></button>
            </>
          )}
          {phase === "error" && (
            <>
              <Icon name="warn" size={18} />
              <span className="va-say">{problem}</span>
              <button ref={again} type="button" className="va-again" onClick={() => { setProblem(""); announce("idle"); start(); }}><Icon name="mic" size={16} />Again</button>
              <button type="button" className="va-x" onClick={() => reset(field)} aria-label="Close and type instead" title="Type instead"><Icon name="close" size={18} /></button>
            </>
          )}
        </div>
      )}
    </>
  );
}

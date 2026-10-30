// The app's routes for what the gateway already does but the app did not show (docs/web_features.md). server.js hands
// every /api/ request here first, after its own checks (the gateway's token; the maintainer's for MAINTAINER), and
// answers the rest itself.
//   GET  /api/prefs                    the player's settings: private calendars (theirs, and the server's default)
//   POST /api/prefs                    { privateCalendars: true | false | null (back to the server's default) }
//   GET  /api/memory/notes?player=     what the player told their agent, as the server keeps it (memory.js)
//   POST /api/memory/notes             { text }: the app's player tells their agent something to remember
//   POST /api/memory/delete            { player, id }: one note gone
//   POST /api/memory/forget            { player }: every note gone (memory.js forget, as /forget does for notes)
//   POST /api/memory/forget-about      { player, about }: the notes about one member or topic gone (memory.js forgetAbout)
//   GET  /api/safety?player=&n=        the safety checks made for that player: when, which guard, the verdict and
//                                      what happened; never the text (safety.js)
//   GET  /api/holds?ref=&members=      what each member's agent is holding for a talk now, and until when
//   POST /api/asr?lang=                a short recording (the raw audio is the body) -> its words, on this server
//   POST /api/asr/warm                 load the speech model now (the app's mic just opened): { warming }
//   GET  /api/loop/builds              (maintainer) the builder's work on approved C1-C3 proposals (loop/builds.js)
//   POST /api/loop/build               (maintainer) { proposal }: build it on its own branch, then run its gates
// `player` is "app" (the app's own player, the default) or a chat linked on Messenger; any other id is not found.
import * as privacy from "./privacy.js";
import * as memory from "./memory.js";
import * as safety from "./safety.js";
import * as store from "./store.js";
import * as guard from "./guard.js";
import { holds } from "./talk_meta.js";
import * as builds from "./loop/builds.js";
import * as asr from "./asr.js";

export const MAINTAINER = ["/api/loop/builds", "/api/loop/build"];
const AUDIO = /^(audio|video)\/(webm|ogg|wav|x-wav|wave|mp4|mpeg|aac|x-m4a)\b/i, ASR_MAX = 2e6;
// a body up to max bytes, or null when it is bigger (what is over is read and dropped, so the answer still goes back)
const capped = (req, max) => new Promise((ok) => { const parts = []; let n = 0; req.on("data", (c) => { n += c.length; if (n <= max) parts.push(c); }); req.on("end", () => ok(n > max ? null : Buffer.concat(parts))); req.on("error", () => ok(null)); });
const linked = (p) => (!p || p === "app" ? "app" : store.get(String(p)) ? String(p) : null);
const notesOf = (who) => ({ player: who, notes: memory.list(who), on: memory.memoryOn(), finds: memory.how() });
const FALLBACK = "I can't answer that one here. Ask me about your games, your week or what hurts, and I'll plan around it.";

// the app's question to its agent (answer.js, POST /api/agent/answer { text, you }), past the same guards as a
// Messenger message: Llama Guard on the way in (a message about violence, crime, weapons, hate, sexual content or
// self-harm is not acted on; self-harm gets the helpline) and on the answer on the way out (a diagnosis, a dose or a
// hazard is replaced). The checks it made come back with the answer (safety), so the app can show them.
export async function answer(b, answerer) {
  const text = String(b.text || "").slice(0, 600);
  const { result, checks } = await safety.collect("app", async () => {
    if (!text) return { text: "Ask me something.", verified: { ok: true, numbers: 0, bad: [] }, facts: 0 };
    const stop = guard.stopsIn(await guard.screen([{ role: "user", content: text }]), text);
    if (stop) return { text: guard.refusal(stop), refused: true, helpline: stop.includes("S11"), verified: { ok: true, numbers: 0, bad: [] }, facts: 0 };
    const r = await answerer({ text, app: b.you || {} });
    const out = await guard.checkOut(r.text, { ask: text, fallback: FALLBACK });
    return out.flagged ? { ...r, text: out.text, replaced: true } : r;
  });
  return { ...result, safety: checks };
}

export async function route(req, res, u, { json, bodyOf, o }) {
  const p = u.pathname, post = req.method === "POST", send = (code, body) => { json(res, code, body, o); return true; };
  if (p === "/api/prefs") {
    if (!post) return send(200, await privacy.describe("app"));
    const b = await bodyOf(req), v = b.privateCalendars;
    if (!(v === true || v === false || v === null)) return send(400, { error: "privateCalendars is true, false or null" });
    await privacy.set("app", v);
    return send(200, await privacy.describe("app"));
  }
  if (p === "/api/memory/notes") {
    if (!post) { const who = linked(u.searchParams.get("player")); return who ? send(200, notesOf(who)) : send(404, { error: "no such player" }); }
    const b = await bodyOf(req), text = String(b.text || "").replace(/\s+/g, " ").trim().slice(0, 400);
    if (!text) return send(400, { error: "say what your agent should remember" });
    if (!memory.memoryOn()) return send(409, { error: "memory is off on this server (MEMORY=off)" });
    // the player's own words, past Llama Guard first, as in Messenger: what it stops is not kept
    const { result: stop, checks } = await safety.collect("app", async () => guard.stopsIn(await guard.screen([{ role: "user", content: text }]), text));
    if (stop) return send(200, { ...notesOf("app"), kept: false, reply: guard.refusal(stop), safety: checks });
    const n = await memory.remember("app", [{ text, kind: "said" }]);
    return send(200, { ...notesOf("app"), kept: n > 0, ...(n > 0 ? {} : { reply: "Your agent already has a note that says this." }), safety: checks });
  }
  // "forget what I said about Tomás": the notes about one member, or one topic, deleted (memory.js forgetAbout)
  if (p === "/api/memory/forget-about" && post) {
    const b = await bodyOf(req), who = linked(b.player), about = String(b.about || "").replace(/\s+/g, " ").trim().slice(0, 200);
    if (!who) return send(404, { error: "no such player" });
    if (!about) return send(400, { error: "say what your agent should forget (a member, or a topic)" });
    const r = await memory.forgetAbout(who, about);
    return send(200, { ...notesOf(who), forgotten: r.deleted, by: r.by });
  }
  if (p === "/api/memory/delete" && post) {
    const b = await bodyOf(req), who = linked(b.player);
    if (!who) return send(404, { error: "no such player" });
    if (!memory.drop(who, String(b.id || ""))) return send(404, { error: "no such note" });
    return send(200, notesOf(who));
  }
  if (p === "/api/memory/forget" && post) {
    const b = await bodyOf(req), who = linked(b.player);
    if (!who) return send(404, { error: "no such player" });
    memory.forget(who);
    return send(200, notesOf(who));
  }
  if (p === "/api/safety") {
    const who = linked(u.searchParams.get("player"));
    if (!who) return send(404, { error: "no such player" });
    const since = who === "app" ? 0 : store.get(who)?.linkedAt || 0;
    return send(200, { player: who, checks: safety.list({ player: who, n: +(u.searchParams.get("n") || 30), since }), on: guard.guardOn(), promptGuard: guard.guardOn() && process.env.PROMPT_GUARD !== "off" });
  }
  if (p === "/api/holds") {
    const ref = String(u.searchParams.get("ref") || ""), ids = String(u.searchParams.get("members") || "").split(",").filter((x) => /^[\w-]{1,40}$/.test(x)).slice(0, 4);
    if (!/^[\w-]{1,80}$/.test(ref)) return send(400, { error: "ref is a talk's id" });
    return send(200, { ref, holds: holds(ref, ids), now: Date.now() });
  }
  // a short recording from the app (WebM/Opus, Ogg, WAV or MP4 audio; 2 MB at most, about a minute) -> its words,
  // heard on this server's CPU by Meta's Omnilingual ASR (asr.js). English unless ?lang= names another (eng_Latn,
  // cmn_Hant, ...). The audio is deleted once read; the ledger gets a row with the seconds, never the words.
  if (p === "/api/asr/warm" && post) return send(200, { warming: asr.warm() });
  if (p === "/api/asr" && post) {
    if (!asr.available()) return send(503, { error: "Speech to text is not set up on this server." });
    const type = String(req.headers["content-type"] || "");
    if (!AUDIO.test(type)) return send(415, { error: "Send the recording as audio (WebM, Ogg, WAV or MP4)." });
    const lang = String(u.searchParams.get("lang") || process.env.ASR_LANG || "eng_Latn");
    if (!/^[a-z]{3}_[A-Z][a-z]{3}$/.test(lang)) return send(400, { error: "lang is a language code such as eng_Latn" });
    const audio = await capped(req, ASR_MAX);
    if (!audio) return send(413, { error: "The recording is too long (2 MB at most): keep it to a sentence or two." });
    if (audio.length < 200) return send(400, { error: "The recording is empty." });
    const r = await asr.transcribe(audio, { lang, site: "asr.app", denoise: true }).catch((e) => ({ error: e.message }));
    return send(r.error ? 502 : 200, r.error ? r : { text: r.text, seconds: r.seconds, audioSeconds: r.audioSeconds, lang });
  }
  if (p === "/api/loop/builds") return send(200, { builds: builds.list(), gates: { run: builds.gatesWanted(), all: builds.ALL_GATES } });
  if (p === "/api/loop/build" && post) {
    const b = await bodyOf(req), r = builds.start(String(b.proposal || ""));
    return r.error ? send(r.code || 400, { error: r.error }) : send(200, r);
  }
  return false;
}

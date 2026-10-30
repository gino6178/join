// Client for the agent gateway (../agent): your agent and its helpers on Muse Glimmer, on your own server.
// Without VITE_AGENT_URL the app looks for the gateway on this machine; with it, wherever it points (a trailing slash
// is dropped).
const LOCAL_GATEWAY = "http://127.0.0.1:8787";
export const AGENT_URL = (import.meta.env.VITE_AGENT_URL || LOCAL_GATEWAY).replace(/\/$/, "");
// the gateway's token (its AGENT_TOKEN), from web/.env.local: this build is for the club's own machine, not the web
const AUTH = import.meta.env.VITE_AGENT_TOKEN ? { authorization: `Bearer ${import.meta.env.VITE_AGENT_TOKEN}` } : {};
// fetch from the gateway, with its token
export const agentFetch = (path, init = {}) => fetch(AGENT_URL + path, { ...init, headers: { ...(init.headers || {}), ...AUTH } });
// A refused call, as an Error with the gateway's own message when it sent one ({ error }), else its status.
const refusal = async (r) => {
  const said = await r.json().catch(() => ({}));
  return new Error(said.error || `gateway ${r.status}`);
};
// One JSON call: a POST when there is a body, a GET when there is none.
const call = async (path, body) => {
  const r = await agentFetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  if (r.ok) return r.json();
  throw await refusal(r);
};
const read = (path) => call(path);
const post = (path, body = {}) => call(path, body);
// a long agent job, streamed as NDJSON: onEvent hears each {type: "working" | "step"} as it happens, and the promise
// resolves with the job's result
async function stream(path, body, onEvent) {
  const r = await agentFetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, stream: true }) });
  return steps(r, onEvent);
}
// the best match this week, scored by your agent; then your agent and that member's agent agree a time and a court
export const agentBest = (body, onEvent) => stream("/api/match/best", body, onEvent);
// the Autopilot: your agent plans the week against your goal, then waits for your yes
export const agentAutopilot = (body, onEvent) => stream("/api/autopilot/run", body, onEvent);
export const agentAutopilotAnswer = (id, choice) => call("/api/autopilot/answer", { id, choice });
export const agentTalk = (body, onEvent) => stream("/api/match/talk", body, onEvent);
// "want a game?": the Match helper's next opening (body: { history, upcoming, body, skip }), and your answer to it
// (yes: the Talk helper agrees it with the other agents and it is booked; other; week; book or drop when they moved it)
export const agentAskNext = (body) => call("/api/ask/next", body);
// a photo of a scoreboard or a score sheet, read on your own server: the score of each game, checked against the rules
export async function agentReadScore(file, players = [], sport = "badminton") {
  const r = await agentFetch(`/api/vision/score?sport=${encodeURIComponent(sport)}&players=${encodeURIComponent(players.join(","))}`, { method: "POST", headers: { "content-type": file.type || "image/jpeg" }, body: file });
  if (r.ok) return r.json();
  throw await refusal(r);
}
export const agentAskAnswer = (id, choice, onEvent) => stream("/api/ask/answer", { id, choice }, onEvent);
// your own video, sent to your own GPU server only: the steps stream back, then both players read on every frame;
// with effects, the camera effect the decision chose for your moment (zoom and cut, a short orbit, or none) and why
export async function agentReel(file, onEvent, sport = "badminton", effects = false) {
  const r = await agentFetch(`/api/reel?sport=${encodeURIComponent(sport)}${effects ? "&effects=1" : ""}`, { method: "POST", headers: { "content-type": file.type || "video/mp4" }, body: file });
  return steps(r, onEvent);
}
// the body log: what you say hurts, read into entries; and the organized log, load and report
export const agentBodyRead = (body) => call("/api/body/read", body);
export const agentBodyReport = (body) => call("/api/body/report", body);
// a health app's export, sent to your own server only and deleted once read
export async function agentHealthImport(file, onEvent) {
  const tz = -new Date().getTimezoneOffset();
  const r = await agentFetch(`/api/health/import?name=${encodeURIComponent(file.name || "export")}&tz=${tz}`, { method: "POST", headers: { "content-type": file.type || "application/octet-stream" }, body: file });
  return steps(r, onEvent);
}
// courts and parks near a point, judged playable or not from the map, Google Maps reviews and the forecast
export const agentPlaces = (body, onEvent) => stream("/api/places", body, onEvent);
export const agentWhere = (q) => call(`/api/places/where?q=${encodeURIComponent(q)}`);
// roads, rivers and parks around a route, for the app to draw in its own style
export const agentBasemap = ({ s, w, n, e }) => call(`/api/map/base?s=${s}&w=${w}&n=${n}&e=${e}`);
async function steps(r, onEvent) {
  if (!r.ok || !r.body) throw new Error((await r.json().catch(() => ({}))).error || `gateway ${r.status}`);
  const rd = r.body.getReader(), dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      const e = JSON.parse(line);
      if (e.type === "done") return e.result;
      if (e.type === "error") throw new Error(e.error);
      onEvent?.(e);
    }
  }
  throw new Error("the agent stopped before it finished");
}
// The gateway's state (model, Messenger, players) and its players; the day's reminder sent out on Messenger; a
// question for your agent, answered from your own games, bookings and body log (body: { text, you }).
export const agentStatus = () => read("/api/status");
export const agentPlayers = () => read("/api/players");
export const agentRemind = () => post("/api/remind");
export const agentAnswer = (text, you) => post("/api/agent/answer", { text, you });
// your settings on the server: private calendars (your choice, or the server's default with null)
export const agentPrefs = () => read("/api/prefs");
export const agentSetPrefs = (prefs) => post("/api/prefs", prefs);
// what you told your agent, as the server keeps it (player: "app", or a Messenger chat's id): list, add, delete, forget
export const agentNotes = (player = "app") => read(`/api/memory/notes?player=${encodeURIComponent(player)}`);
export const agentRemember = (text) => post("/api/memory/notes", { text });
export const agentForgetNote = (id, player = "app") => post("/api/memory/delete", { id, player });
export const agentForgetNotes = (player = "app") => post("/api/memory/forget", { player });
// the notes about one member or topic ("Tomás", "Riverside"), deleted: { notes, forgotten: [{ id, text }] }
export const agentForgetAbout = (about, player = "app") => post("/api/memory/forget-about", { about, player });
// the safety checks made for a player: when, which guard, the verdict and what happened (never the text)
export const agentSafety = (player = "app", n = 20) => read(`/api/safety?player=${encodeURIComponent(player)}&n=${n}`);
// a short recording -> its words, heard on your own server by Meta's Omnilingual ASR (English unless lang says otherwise)
export async function agentAsr(blob, lang = "eng_Latn") {
  const r = await agentFetch(`/api/asr?lang=${encodeURIComponent(lang)}`, { method: "POST", headers: { "content-type": (blob.type || "audio/webm").split(";")[0] }, body: blob });
  if (r.ok) return r.json();
  throw await refusal(r);
}
// the mic just opened: the server loads the speech model while you talk
export const agentAsrWarm = () => post("/api/asr/warm");
// what the other players' agents are holding for a talk, and until when
export const agentHolds = (ref, members = []) => read(`/api/holds?ref=${encodeURIComponent(ref)}&members=${members.map(encodeURIComponent).join(",")}`);
// play: find a game (court, partners, everyone's calendar, the venue in the middle), book it once the player
// confirms, and follow the answers
export const agentPlay = (text, you, on) => stream("/api/play/plan", { text, you }, on);
export const agentBook = (option, invites, you) => call("/api/play/book", { option, invites, you });
export const agentBooking = (id) => call(`/api/play/booking?id=${encodeURIComponent(id)}`);
export const agentCancel = (id) => call("/api/play/cancel", { id });
// a highlight reel's caption for Instagram and Facebook, written by Muse Glimmer and checked
export const agentCaption = (reel) => call("/api/highlight/caption", reel);

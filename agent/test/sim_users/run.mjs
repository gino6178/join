// Twenty simulated users try Serve for three days, through its real surfaces, on a gateway of the simulation's own.
//   node test/sim_users/run.mjs --seed 1 --run s1 [--users 20] [--days 3] [--start 2026-11-05]
// Run on the GPU server from a tree with agent/node_modules and asr/ beside agent/ (docs/simulated_users.md). It
// makes a folder of its own for the run (SIM_DIR/runs/<run>, by default ~/shuttlecoach-meta/simusers/runs/<run>):
// a copy of agent/src and agent/test, the trial club as web/public/data/club.json (the twenty personas as members,
// nobody else), and agent/data for everything the gateway keeps. Nothing goes in any other agent/data.
//
// What runs for real: the gateway (src/server.js, with CLUB_PLAYERS=1 so each user's agent plans from their own
// profile), on Muse Glimmer at LLM_TARGET (an A100 test endpoint, never the live 11435), Llama Guard, the members'
// agents over A2A, the matchmaking bands, the holds, the Autopilot, the Match helper's noon ask, the reminders, the
// community loop's night run, and the Club feed when the branch has it. The users reach it only as people would:
// Messenger, through the signed webhook and a fake Graph API (as test/e2e.mjs does), and the web API with the token.
// The clock: the gateway runs on a simulated clock (clock.mjs) that the runner moves forward between events, only
// when nothing is in flight, and holds at the hours the gateway's own minute ticks act on.
// What the users do: whether they act is the inertia model's (inertia.mjs), what they say the persona model's
// (persona_llm.mjs). At the end, the same days without Serve (baseline.mjs), and the measures (metrics.mjs).
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generate, trialClub, load as loadPersonas } from "./personas.mjs";
import * as I from "./inertia.mjs";
import { u, stream } from "./rng.mjs";
import * as P from "./persona_llm.mjs";
import { runBaseline } from "./baseline.mjs";
import { measure } from "./metrics.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url)), AGENT = path.resolve(HERE, "../.."), REPO = path.resolve(AGENT, "..");
const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const SEED = +arg("seed", 1), RUN = arg("run", `s${SEED}`), NUSERS = +arg("users", 20), NDAYS = +arg("days", 4), START = arg("start", "2026-11-05");
const GW_PORT = +arg("port", 24789), GRAPH_PORT = +arg("graph", 24796), LLM_PROXY = GW_PORT + 1, GUARD_PROXY = GW_PORT + 2, ORIGIN = `http://127.0.0.1:${GW_PORT + 3}`;
const LLM_TARGET = (process.env.LLM_TARGET || "http://127.0.0.1:11446").replace(/\/+$/, ""), GUARD_TARGET = (process.env.GUARD_TARGET || "http://127.0.0.1:11436").replace(/\/+$/, "");
if (/:(11434|11435)\b/.test(LLM_TARGET)) throw new Error("the simulation never uses the live model server (11434, 11435)");
const SIM_DIR = path.resolve(process.env.SIM_DIR || path.join(os.homedir(), "shuttlecoach-meta/simusers")), DIR = path.join(SIM_DIR, "runs", RUN);
const K = +(process.env.SIM_CONCURRENCY || 5); // users acting at once
// --informed: the users were told how to ask (the phrasings Serve reads as a request, and /autopilot); a second arm, to
// separate how people word a request from what Serve does once it has one
const INFORMED = process.argv.includes("--informed"), ARM = `${INFORMED ? "informed" : "natural"}${arg("lazy-shift") ? ` laziness${+arg("lazy-shift") > 0 ? "+" : ""}${arg("lazy-shift")}` : ""}`;
const SECRET = crypto.randomBytes(16).toString("hex"), TOKEN = `sim-${crypto.randomBytes(12).toString("hex")}`, AUTH = { authorization: `Bearer ${TOKEN}` };
const MIN = 6e4, H = 36e5;
const LOG = path.join(DIR, "run.jsonl");

// ---- the run's own tree --------------------------------------------------------------------------------------------
function setup(personas) {
  if (fs.existsSync(DIR)) throw new Error(`${DIR} exists: a run is never overwritten (pick another --run)`);
  const liveData = path.resolve(os.homedir(), "shuttlecoach-meta/agent/data");
  if (path.resolve(DIR, "agent/data").startsWith(liveData)) throw new Error("refusing to use the live agent/data");
  fs.mkdirSync(path.join(DIR, "agent/data"), { recursive: true });
  fs.mkdirSync(path.join(DIR, "web/public/data"), { recursive: true });
  for (const d of ["src", "test"]) fs.cpSync(path.join(AGENT, d), path.join(DIR, "agent", d), { recursive: true, filter: (s) => !/[\\/](data|node_modules)([\\/]|$)/.test(path.relative(AGENT, s)) });
  fs.copyFileSync(path.join(AGENT, "package.json"), path.join(DIR, "agent/package.json"));
  fs.symlinkSync(fs.realpathSync(process.env.SIM_NODE_MODULES || path.join(AGENT, "node_modules")), path.join(DIR, "agent/node_modules"));
  const asr = process.env.SIM_ASR || path.join(REPO, "asr");
  if (fs.existsSync(asr)) fs.symlinkSync(fs.realpathSync(asr), path.join(DIR, "asr"));
  const web = path.join(REPO, "web/public/data");
  // (the gateway's modules that still read the web app's code: facts.js)
  if (fs.existsSync(path.join(REPO, "web/src"))) fs.cpSync(path.join(REPO, "web/src"), path.join(DIR, "web/src"), { recursive: true });
  // (the loop's policy gate reads the web app's dependencies)
  if (fs.existsSync(path.join(REPO, "web/package.json"))) fs.copyFileSync(path.join(REPO, "web/package.json"), path.join(DIR, "web/package.json"));
  fs.copyFileSync(path.join(web, "venues.json"), path.join(DIR, "web/public/data/venues.json"));
  // (the Autopilot reads the demo's match file for a partner's style; it has nothing of the trial in it)
  for (const f of ["matches.json"]) if (fs.existsSync(path.join(web, f))) fs.copyFileSync(path.join(web, f), path.join(DIR, "web/public/data", f));
  fs.writeFileSync(path.join(DIR, "web/public/data/club.json"), JSON.stringify(trialClub(personas), null, 1));
  fs.writeFileSync(path.join(DIR, "personas.json"), JSON.stringify({ simulated: true, personas }, null, 1));
}
const log = (x) => fs.appendFileSync(LOG, JSON.stringify({ at: new Date(simNow()).toISOString(), ...x }) + "\n");

// ---- the simulated clock (the runner's copy; the gateway's is clock.mjs) ---------------------------------------------
let offset = 0;
const simNow = () => Date.now() + offset;
let gw = null, acks = new Map();
async function jump(t) {
  if (t <= simNow()) return;
  offset = t - Date.now();
  const id = crypto.randomUUID();
  await new Promise((ok) => { acks.set(id, ok); gw.send({ simClock: t, id }); setTimeout(ok, 5000); });
}

// ---- the fake Graph API, and proxies that count what is in flight ------------------------------------------------------
const inbox = {}; // user -> [{ id, at, text, buttons, payloads, tag, read }]
let lastGraph = 0, graphN = 0;
const listeners = new Set();
function graphServer() {
  return http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      let body = {}; try { body = JSON.parse(b || "{}"); } catch { /* a typing indicator */ }
      res.writeHead(200, { "content-type": "application/json" });
      const to = body.recipient?.id, m = body.message;
      if (to && m?.text) {
        lastGraph = Date.now();
        const x = { id: `m${++graphN}`, at: simNow(), text: m.text, buttons: m.quick_replies?.map((q) => q.title) || [], payloads: m.quick_replies?.map((q) => q.payload) || [], tag: body.tag || null, read: false };
        (inbox[to] ||= []).push(x);
        log({ kind: "agent", to, id: x.id, text: x.text, buttons: x.buttons, payloads: x.payloads, tag: x.tag });
        for (const f of listeners) f(to, x);
      }
      res.end(JSON.stringify({ recipient_id: to, message_id: `mid.${graphN}` }));
    });
  }).listen(GRAPH_PORT, "127.0.0.1");
}
const flight = { llm: 0, guard: 0, llmCalls: 0, guardCalls: 0, guardUnsafe: 0, lastLlm: 0 };
function proxy(port, target, kind) {
  return http.createServer((req, res) => {
    const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", async () => {
      flight[kind]++; flight[`${kind}Calls`]++;
      try {
        const r = await fetch(`${target}${req.url}`, { method: req.method, headers: { "content-type": req.headers["content-type"] || "application/json" }, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks), signal: AbortSignal.timeout(300000) });
        const buf = Buffer.from(await r.arrayBuffer());
        if (kind === "guard" && /"response":"\s*unsafe/.test(buf.toString("utf8"))) flight.guardUnsafe++;
        if (!r.ok) flight[`${kind}Errors`] = (flight[`${kind}Errors`] || 0) + 1;
        res.writeHead(r.status, { "content-type": r.headers.get("content-type") || "application/json" }); res.end(buf);
      } catch (e) { flight[`${kind}Errors`] = (flight[`${kind}Errors`] || 0) + 1; log({ kind: "proxy-error", via: kind, error: String(e.message || e).slice(0, 160) }); res.writeHead(502); res.end(JSON.stringify({ error: String(e.message || e) })); }
      finally { flight[kind]--; if (kind === "llm") flight.lastLlm = Date.now(); }
    });
  }).listen(port, "127.0.0.1");
}

// ---- the gateway ---------------------------------------------------------------------------------------------------------
function startGateway(startMs) {
  const env = {
    ...process.env, TZ: "Asia/Taipei", PORT: String(GW_PORT), SIM_CLOCK_START: String(startMs),
    MESSENGER_PAGE_TOKEN: "SIM", MESSENGER_APP_SECRET: SECRET, MESSENGER_VERIFY_TOKEN: "sim-verify", MESSENGER_PAGE_NAME: "Serve (simulated users' Page)", MESSENGER_API: `http://127.0.0.1:${GRAPH_PORT}/v21.0`,
    AGENT_TOKEN: TOKEN, ALLOW_ORIGINS: ORIGIN, MAINTAINER_TOKEN: crypto.randomBytes(16).toString("hex"),
    LLM_URL: `http://127.0.0.1:${LLM_PROXY}/v1`, LLM_SLOTS: process.env.SIM_LLM_SLOTS || "8", EMBED_URL: `http://127.0.0.1:${LLM_PROXY}`, GUARD_URL: `http://127.0.0.1:${GUARD_PROXY}`,
    CLUB_PLAYERS: "1", MATCH_DEMO_RECORDS: "0", LOOP_NIGHTLY: "1", LOOP_HOUR: "5", LOOP_GUARDS: process.env.LOOP_GUARDS || "llama-guard", LOOP_SIMULATED: "1", SIM_SEED: String(SEED),
    LOOP_SHIP_GATES: process.env.LOOP_SHIP_GATES || "policy,scan,unit,oracle,privacy", FEED_DEMO: "off", NIGHTLY: "0",
    // DRAMA (memory and the loop's clusters) and Prompt Guard read their weights from the server's model cache, as the
    // live gateway does (start.sh): without it the loop cannot cluster what members share
    REEL_HF_CACHE: process.env.SIM_HF_CACHE || process.env.REEL_HF_CACHE || "/mnt/nas/shuttlecoach-meta/hf",
    // (nothing of the sim's own starts: no SIM_MEMBERS, no SIM_USERS: the club is the run's club.json)
    SIM_MEMBERS: "", SIM_USERS: "", SIM_ONLY: "",
  };
  delete env.LLM_API; delete env.MODEL_API_KEY; delete env.LLM_API_KEY;
  const out = fs.openSync(`/tmp/serve_simusers_${RUN}_gateway.log`, "a");
  gw = spawn(process.execPath, ["--import", pathToFileURL(path.join(DIR, "agent/test/sim_users/clock.mjs")).href, "src/server.js"], { cwd: path.join(DIR, "agent"), env, stdio: ["ignore", out, out, "ipc"] });
  gw.on("message", (m) => { if (m?.simClockAck !== undefined) { acks.get(m.simClockAck)?.(); acks.delete(m.simClockAck); } });
  gw.on("exit", (c) => log({ kind: "gateway-exit", code: c }));
  fs.writeFileSync(path.join(DIR, "gateway.pid"), String(gw.pid));
}
const G = `http://127.0.0.1:${GW_PORT}`;
const api = (p, body) => fetch(`${G}${p}`, body ? { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, ...AUTH }, body: JSON.stringify(body) } : { headers: AUTH }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
let inFlightHooks = 0, lastHook = 0;
async function hook(psid, message) {
  const body = JSON.stringify({ object: "page", entry: [{ id: "page", time: simNow(), messaging: [{ sender: { id: psid }, recipient: { id: "page" }, timestamp: simNow(), message: { mid: `sim.${crypto.randomUUID()}`, ...message } }] }] });
  inFlightHooks++; lastHook = Date.now();
  try { const r = await fetch(`${G}/webhook/messenger`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=" + crypto.createHmac("sha256", SECRET).update(body).digest("hex") }, body }); return r.status; }
  finally { inFlightHooks--; lastHook = Date.now(); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// nothing in flight: no model or guard call, no webhook, no message to a user for a few seconds, no user acting
async function idle({ quietMs = 8000, maxMs = 12 * 60000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const quiet = Date.now() - Math.max(lastGraph, lastHook, flight.lastLlm);
    if (!flight.llm && !flight.guard && !inFlightHooks && !acting.size && quiet >= quietMs) return true;
    if (Date.now() - t0 > maxMs) { log({ kind: "stall", llm: flight.llm, guard: flight.guard, acting: [...acting] }); return false; }
    await sleep(500);
  }
}

// ---- the people ------------------------------------------------------------------------------------------------------------
const dates = Array.from({ length: NDAYS }, (_, i) => { const d = new Date(`${START}T12:00`); d.setDate(d.getDate() + i); return I.ymd(d); });
const LAST = dates.at(-1);
const dayIndex = (date) => dates.indexOf(date) + 1;
let personas = [], byId = {};
const st = {}; // per user: what happened to them (the runner's own notes, for the persona and the measures)
const acting = new Set();
const sent = (id, what, extra = {}) => { st[id].actions.push({ at: simNow(), what, ...extra }); if (extra.text) (st[id].said ||= []).push({ at: simNow(), text: extra.text }); log({ kind: "user", who: id, what, ...extra }); };
// a message, and everything the agent sends back until `until` matches one (or a time limit)
async function say(id, text, { until = null, waitMs = 150000, what = "message" } = {}) {
  const before = (inbox[id] || []).length;
  sent(id, what, { text });
  await hook(id, { text });
  const t0 = Date.now();
  while (Date.now() - t0 < waitMs) {
    const got = (inbox[id] || []).slice(before);
    if (got.length && (!until || got.some((m) => until.test(m.text))) && Date.now() - lastGraph > 2500) return got;
    await sleep(500);
  }
  return (inbox[id] || []).slice(before);
}
// in the chat already: what came back with buttons is answered now, not after their usual delay
async function talk(id, text, opts = {}) {
  const got = await say(id, text, opts);
  for (const m of got.filter((x) => x.payloads.length && !x.answered && x.read !== "acted")) await respond(id, m.id);
  for (const m of got) if (!m.read) m.read = "seen";
  return got;
}
async function tap(id, m, k, what = "tap") {
  sent(id, what, { button: m.buttons[k], payload: m.payloads[k], on: m.id });
  m.answered = { k, at: simNow() };
  await hook(id, { text: m.buttons[k], quick_reply: { payload: m.payloads[k] } });
}
const recent = (id) => [...(st[id].said || []).map((x) => ({ ...x, from: "user" })), ...(inbox[id] || []).map((x) => ({ from: "agent", text: x.text, at: x.at }))].sort((a, b) => a.at - b.at).slice(-4);

// what the queue holds: { t, kind, ... }
const queue = [];
const at = (date, time) => new Date(`${date}T${time}`).getTime();
const push = (e) => { queue.push(e); queue.sort((a, b) => a.t - b.t); };
// the next time a user looks at their phone, from `t`, on a day they open the chat (within the trial)
function nextLook(id, t) {
  const p = byId[id];
  for (const date of dates) {
    const d = I.dayPlan(SEED, p, date);
    if (!d.open) continue;
    for (const s of [...d.sessions].sort()) { const x = at(date, s); if (x >= t) return x; }
  }
  return null;
}
// a message in: when will they answer it
function onMessage(id, m) {
  const p = byId[id];
  if (!p) return;
  const date = I.ymd(new Date(m.at)), d = I.dayPlan(SEED, p, date);
  const asks = m.payloads.length > 0, notice = /^Your agent said yes for you:/.test(m.text), checkin = /^How did today's session go\?/.test(m.text);
  if (!asks && !notice && !checkin) return;
  let t = null;
  if (d.open) { const look = nextLook(id, m.at), soon = m.at + I.replyDelay(SEED, p, m.id) * MIN; t = look != null ? Math.min(look, soon) : soon; }
  else t = nextLook(id, m.at);
  if (t == null || t > at(LAST, "23:59")) return;
  push({ t, kind: "respond", who: id, msg: m.id });
}
listeners.add(onMessage);

// the games: the bookings the gateway made (read from its own file: measuring, not acting), and how each went
const games = new Map(); // key -> { key, id, date, start, minutes, format, by, with, venue, court, created, notice: {}, honor: {}, turnout, played }
const bookingsFile = () => path.join(DIR, "agent/data/bookings.json");
function syncGames() {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(bookingsFile(), "utf8")).bookings || []; } catch { return; }
  for (const b of list) {
    if (games.has(b.id) || !b.option?.by) continue;
    const o = b.option, g = { key: b.id, id: b.id, date: o.date, start: o.start, minutes: o.minutes || 90, format: o.format, sport: o.sport, by: o.by, with: (o.partners || []).map((x) => x.id), venue: o.venue?.name, court: o.court, created: b.created, talk: o.talk || null, notice: {}, honor: {}, inTrial: dates.includes(o.date) };
    games.set(b.id, g);
    log({ kind: "booked", game: g });
    const s = at(g.date, g.start);
    if (g.inTrial && s > simNow()) {
      push({ t: s - 72 * MIN, kind: "hold", what: "presession", ms: 66000 });
      push({ t: s, kind: "game", key: g.key });
    }
  }
}
const mine = (id) => [...games.values()].filter((g) => g.by === id || g.with.includes(id));
const needOf = (id) => I.trialNeed(byId[id], NDAYS) - mine(id).filter((g) => g.inTrial && g.played !== false && !(g.honor[id] === false)).length;
const burnedBy = (id, others) => others.some((o) => (st[id].stoodUp || []).includes(o));

// ---- what a user does ----------------------------------------------------------------------------------------------------
const DAYNAMES = { Monday: "Mon", Tuesday: "Tue", Wednesday: "Wed", Thursday: "Thu", Friday: "Fri", Saturday: "Sat", Sunday: "Sun" };
// the day and time an agent's message is about ("Thursday 19:00"), as a date in the next week
function whenIn(text, from) {
  const m = /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday) (\d\d:\d\d)/.exec(text);
  if (!m) return null;
  for (let i = 0; i < 8; i++) { const d = new Date(from); d.setDate(d.getDate() + i); if (I.DAYS[d.getDay()] === DAYNAMES[m[1]] && at(I.ymd(d), m[2]) > from) return { date: I.ymd(d), start: m[2] }; }
  return null;
}
const namesIn = (text) => personas.filter((p) => text.includes(p.name.split(" ")[0])).map((p) => p.id);
async function respond(id, msgId) {
  const p = byId[id], m = (inbox[id] || []).find((x) => x.id === msgId);
  if (!m || m.answered || m.read === "acted") return;
  m.read = "acted";
  const now = simNow();
  if (/^Your agent said yes for you:/.test(m.text)) return notice(id, m);
  if (/^How did today's session go\?/.test(m.text)) return checkin(id, m);
  const kind = m.payloads[0]?.split(":")[0];
  // a newer question of the same kind replaced this one
  if ((inbox[id] || []).some((x) => x.at > m.at && x.payloads[0]?.split(":")[0] === kind && x.payloads.length)) return;
  if (kind === "gm" || kind === "ap") {
    // (a question can follow a "No deal" in the same message: the question is its last paragraph)
    const lines = kind === "ap" ? m.text.split("\n").filter((l) => l.startsWith("• ")) : [m.text.split("\n\n").at(-1)];
    const decisions = lines.map((l) => { const w = whenIn(l, now); return w ? I.answerGame(SEED, p, { ...w, need: needOf(id), burned: burnedBy(id, namesIn(l)), key: `${m.id}:${w.date}:${w.start}` }) : "ignore"; });
    const yes = decisions[0] === "yes", pl = m.payloads;
    let k = -1;
    if (kind === "gm" && /:yes$/.test(pl[0])) k = yes ? 0 : decisions[0] === "other" ? 1 : decisions[0] === "week" ? 2 : -1;
    else if (kind === "gm" && /:book$/.test(pl[0])) k = yes ? 0 : decisions[0] === "ignore" ? -1 : 1;
    else if (kind === "gm" && /:one$/.test(pl[0])) k = 0;
    else if (kind === "ap") { const all = decisions.every((x) => x === "yes"); k = all ? 0 : pl.length === 3 && yes ? 1 : decisions.every((x) => x === "ignore") ? -1 : pl.length - 1; }
    st[id].decisions.push({ at: now, on: m.id, kind, text: m.text.slice(0, 200), decisions, tapped: k >= 0 ? m.buttons[k] : null });
    if (k >= 0) await tap(id, m, k, kind === "gm" ? "answer-ask" : "answer-plan"); else log({ kind: "ignored", who: id, on: m.id });
    return;
  }
  // their agent asks before a game another player's agent agreed with it is booked (CLUB_PLAYERS, /confirm): in or out
  if (kind === "pc") {
    const w = whenIn(m.text, m.at - 60000), a = w ? I.answerGame(SEED, p, { ...w, need: needOf(id), burned: burnedBy(id, namesIn(m.text)), key: `confirm:${m.id}` }) : "ignore";
    st[id].decisions.push({ at: now, on: m.id, kind, text: m.text.slice(0, 200), decisions: [a], tapped: a === "yes" ? m.buttons[0] : a === "ignore" ? null : m.buttons[1] });
    if (a === "yes") { (st[id].confirmed ||= []).push(`${w.date} ${w.start}`); return tap(id, m, 0, "answer-confirm"); }
    if (a === "ignore") return log({ kind: "ignored", who: id, on: m.id });
    return tap(id, m, 1, "answer-confirm");
  }
  if (kind === "sh") return tap(id, m, u(SEED, "share", id, m.id) < (p.civic >= 0.3 ? 0.85 : 0.5) ? 0 : 1, "share-answer");
  if (kind === "qv") return tap(id, m, Math.floor(u(SEED, "vote-pick", id, m.id) * m.payloads.length), "vote");
  if (kind === "bd") return tap(id, m, u(SEED, "body", id, m.id) < 0.6 ? 0 : 1, "body-answer");
  if (kind === "wx") return tap(id, m, 1, "weather-answer");
  if (kind === "fb" && u(SEED, "fb", id, m.id) < 0.12 * p.civic) return tap(id, m, 0, "thumb");
}
// a game their agent agreed for them: do they keep it, now they know
async function notice(id, m) {
  syncGames();
  const p = byId[id], w = whenIn(m.text, m.at - 60000), g = w && [...games.values()].find((x) => x.with.includes(id) && x.date === w.date && x.start === w.start);
  if (!g) return;
  g.notice[id] = simNow();
  const a = I.answerGame(SEED, p, { date: g.date, start: g.start, minutes: g.minutes, need: needOf(id) + 1, burned: burnedBy(id, [g.by, ...g.with].filter((x) => x !== id)), key: `notice:${g.key}` });
  g.honor[id] = a === "yes";
  log({ kind: "notice-read", who: id, game: g.key, keeps: g.honor[id], answer: a });
  if (!g.honor[id] && u(SEED, "bail-says", id, g.key) < 1 - 0.5 * p.inertia.laziness) {
    const text = await P.write(p, "bail", { game: `${g.format} ${I.dayOf(g.date)} ${g.start} at ${g.venue}` }, recent(id));
    await say(id, text, { what: "bail" });
  }
}
async function checkin(id, m) {
  const p = byId[id], today = I.ymd(new Date(m.at)), g = mine(id).find((x) => x.date === today && x.played !== undefined);
  if (!g || !I.logsGame(SEED, p, `checkin:${today}`)) return;
  const others = [g.by, ...g.with].filter((x) => x !== id).map((x) => byId[x].name.split(" ").at(-1).split("-")[0]);
  const text = await P.write(p, "checkin", g.played ? { played: true, minutes: g.minutes, format: g.format, with: others.join(", ") } : { played: false, why: g.turnout?.find((x) => !x.shows && x.id !== id)?.why ? "the others didn't show up" : "I couldn't make it" }, recent(id));
  await say(id, text, { what: "checkin-reply" });
}
// one look at the phone
async function session(id, date, first) {
  const p = byId[id], s = st[id], day = dayIndex(date);
  s.days.add(date);
  // the first time: a hello links the chat
  if (!s.linked) {
    s.linked = simNow(); s.activated = date;
    const t = await P.write(p, "hello", {}, []);
    await talk(id, t, { until: /linked/, what: "hello" });
  }
  // what came in and still waits: answered now
  for (const m of (inbox[id] || []).filter((x) => !x.read && (x.payloads.length || /^Your agent said yes for you:|^How did today's session go\?/.test(x.text)))) await respond(id, m.id);
  for (const m of inbox[id] || []) if (!m.read) m.read = "seen";
  // the choices they make once: /improve on, /bands on, /beta on
  for (const [what, cmd] of [["improve", "/improve on"], ["bands", "/bands on"], ["beta", "/beta on"]]) {
    if (p.choices[what] && !s.chose[what] && day >= I.choiceDay(SEED, p, what)) { s.chose[what] = date; await say(id, cmd, { what: `choice:${what}` }); }
  }
  // a game: on their first look of the day, if they still want one this trial and bother to ask
  // (not while a question from their agent is still waiting for them)
  const waiting = (inbox[id] || []).some((m) => m.payloads.some((x) => /^(gm|ap):/.test(x)) && !m.answered && simNow() - m.at < 20 * H);
  if (first && needOf(id) > 0 && !waiting && I.initiates(SEED, p, date)) {
    const slot = I.wantedSlot(SEED, p, new Date(simNow()), { until: LAST, exclude: mine(id).map((g) => g.date) });
    if (slot) {
      const part = toPart(slot.start), when = slot.date === I.ymd(new Date(simNow())) ? (part === "evening" ? "tonight" : `this ${part}`) : `${{ Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday" }[slot.day]} ${part}`;
      const text = await P.write(p, "request", { sport: "badminton", format: slot.format, when, informed: INFORMED }, recent(id));
      s.episodes.push({ at: simNow(), slot, text, kind: "request" });
      const UNTIL = /Book (it|them)\?|No deal|couldn't|Booked|No game|No other opening|Want a game\?|calendar|\?$/;
      let got = await talk(id, text, { what: "request", until: UNTIL, waitMs: 240000 });
      // not taken up (no "On it", no question with buttons): they may try once or twice more, the way they would after
      // reading the agent's reply (a command it mentioned, other words), unless they give up
      for (let k = 1; k <= 2; k++) {
        const taken = got.some((m) => /^On it/.test(m.text) || m.payloads.some((x) => /^(gm|ap):/.test(x)));
        if (taken || u(SEED, "retry", id, date, k) > (1 - p.inertia.laziness) * 0.75) break;
        const said = got.filter((m) => !/^\(Noted:/.test(m.text)).map((m) => m.text).join(" / ").slice(0, 400) || "(no reply)";
        const again = await P.write(p, "retry", { sport: "badminton", format: slot.format, when, said }, recent(id));
        s.episodes.push({ at: simNow(), slot, text: again, kind: "retry" });
        got = await talk(id, again, { what: "request", until: UNTIL, waitMs: 240000 });
      }
    }
  }
  // an aside: a question about the app, or a niggle for the body log
  const a = first && I.aside(SEED, p, day);
  if (a === "question") await say(id, await P.write(p, "question", { topic: P.topicFor(u(SEED, "topic", id, day)) }, recent(id)), { what: "question" });
  if (a === "niggle" && !s.niggled) { s.niggled = date; await say(id, await P.write(p, "niggle", { part: p.niggle }, recent(id)), { what: "niggle" }); }
  // trash talk before a game (a guard may misread it)
  const next = mine(id).find((g) => g.inTrial && at(g.date, g.start) > simNow());
  if (first && p.trashTalk && next && u(SEED, "trash", id, date) < 0.5) await say(id, await P.write(p, "trash", { game: `${next.format} ${I.dayOf(next.date)}` }, recent(id)), { what: "trash-talk" });
  // the community loop: an idea, a vote
  if (first && I.sharesIdea(SEED, p, day) && !s.ideaOn?.includes(date)) {
    (s.ideaOn ||= []).push(date);
    const exp = experience(id);
    const text = await P.write(p, "idea", { days: day, experience: exp, theme: p.idea }, []);
    await talk(id, `/idea ${text}`, { what: "idea", until: /Share with the club|couldn't put|won't share|Answer the last/ });
  }
  if (first && I.votes(SEED, p, day)) await talk(id, "/ideas", { what: "ideas" });
  if (first && feedOn) await feedVisit(id, date);
}
const toPart = (s) => { const h = +s.slice(0, 2); return h < 12 ? "morning" : h < 17 ? "afternoon" : "evening"; };
function experience(id) {
  const g = mine(id), played = g.filter((x) => x.played).length, stood = (st[id].stoodUp || []).length;
  const asks = st[id].actions.filter((a) => a.what === "request").length;
  return [asks ? `You asked it for a game ${asks} time${asks > 1 ? "s" : ""}.` : "You haven't asked it for a game yet.", g.length ? `It booked ${g.length} game${g.length > 1 ? "s" : ""} for you, and you played ${played}.` : "It hasn't booked you a game.", stood ? "Someone didn't turn up to one." : ""].join(" ");
}
// the Club feed, when the branch has it: likes on what others posted, now and then a comment
let feedOn = false;
async function feedVisit(id, date) {
  const p = byId[id], n = I.likesToday(SEED, p, date);
  if (!n) return;
  const f = await api(`/api/feed?player=${id}&n=20`);
  sent(id, "feed-open");
  const posts = (f.body?.posts || []).filter((x) => !x.mine && !x.liked);
  for (const x of posts.slice(0, n)) { const r = await api("/api/feed/like", { player: id, post: x.id, on: true }); sent(id, "feed-like", { post: x.id, kind: x.kind, ok: r.status === 200 && r.body?.liked === true }); }
  const c = posts.find((x) => x.kind !== "paper") || posts[0];
  if (c && I.comments(SEED, p, `${date}:${c.id}`)) {
    const text = await P.write(p, "comment", { post: String(c.text || "").slice(0, 200) });
    const r = await api("/api/feed/comment", { player: id, post: c.id, text });
    sent(id, "feed-comment", { post: c.id, text, ok: r.status === 200 && !!r.body?.comment, held: !!r.body?.held, refused: r.body?.refused ? r.body.why || "refused" : null, error: r.body?.error || null });
  }
}
// after a game: tell the agent, and maybe post about it
async function afterGame(id, key) {
  const p = byId[id], g = games.get(key);
  if (!g) return;
  const others = [g.by, ...g.with].filter((x) => x !== id).map((x) => byId[x].name.split(" ").at(-1).split("-")[0]).join(", ");
  if (g.played && I.logsGame(SEED, p, `log:${key}`)) await say(id, await P.write(p, "log", { minutes: g.minutes, format: g.format, with: others }, recent(id)), { what: "log" });
  if (g.played && feedOn && I.postsAfterGame(SEED, p, key)) {
    const text = await P.write(p, "post", { format: g.format, with: others, venue: g.venue });
    const r = await api("/api/feed/post", { player: id, text });
    sent(id, "feed-post", { text, ok: r.status === 200 && !!r.body?.post, held: !!r.body?.held, refused: r.body?.refused ? r.body.why || "refused" : null, error: r.body?.error || null });
  }
}
// the game itself: who turns up
function playGame(key) {
  const g = games.get(key);
  if (!g) return;
  g.turnout = [g.by, ...g.with].map((id) => {
    const p = byId[id], partner = id !== g.by;
    // (a partner who said "I'm in" to their agent's question knows, and keeps it)
    if (partner && (st[id].confirmed || []).includes(`${g.date} ${g.start}`)) g.honor[id] = true;
    let knows = !partner || g.notice[id] != null || g.honor[id] === true || I.seesPush(SEED, p, `push:${key}`);
    if (partner && g.honor[id] === undefined && knows) g.honor[id] = I.answerGame(SEED, p, { date: g.date, start: g.start, minutes: g.minutes, need: needOf(id) + 1, key: `notice:${g.key}` }) === "yes";
    if (partner && knows && g.honor[id] === false) return { id, shows: false, why: "kept away from a game their agent agreed for them" };
    return { id, ...I.shows(SEED, p, { date: g.date, start: g.start, minutes: g.minutes, knows, key: `game:${g.date}:${g.start}:${id}` }) };
  });
  g.played = g.turnout.every((x) => x.shows);
  for (const x of g.turnout) if (x.shows && !g.played) for (const y of g.turnout.filter((z) => !z.shows)) (st[x.id].stoodUp ||= []).push(y.id);
  log({ kind: "game", key, played: g.played, turnout: g.turnout });
  for (const x of g.turnout.filter((t) => t.shows)) push({ t: at(g.date, g.start) + (g.minutes + 20 + Math.floor(u(SEED, "after", x.id, key) * 60)) * MIN, kind: "after", who: x.id, key });
}

// ---- the days -------------------------------------------------------------------------------------------------------------
function schedule() {
  for (const date of dates) {
    // the gateway's own hours: the loop's night run, the morning reminder, the noon ask, the evening check-in
    push({ t: at(date, "05:00") + 20000, kind: "hold", what: "loop", ms: 66000, idleMs: 25 * 60000 });
    push({ t: at(date, "07:00") + 20000, kind: "hold", what: "morning", ms: 66000 });
    push({ t: at(date, "12:00") + 20000, kind: "hold", what: "ask", ms: 66000 });
    push({ t: at(date, "21:00") + 20000, kind: "hold", what: "checkin", ms: 66000 });
    for (const p of personas) {
      const d = I.dayPlan(SEED, p, date);
      [...d.sessions].sort().forEach((s, i) => push({ t: at(date, s), kind: "session", who: p.id, date, first: i === 0 }));
    }
  }
  push({ t: at(LAST, "23:30"), kind: "end" });
}
async function handle(e) {
  // a hold keeps the clock in the hour the gateway's minute tick acts on, then waits for what the tick started
  // (the morning reminder and the evening check-in only matter on a day with a game; the loop's night run only once
  // something was shared with the club)
  if (e.kind === "hold") {
    const today = I.ymd(new Date(simNow()));
    if (["morning", "checkin"].includes(e.what) && ![...games.values()].some((g) => g.date === today)) return;
    if (e.what === "loop" && !Object.values(inbox).flat().some((m) => /^Shared with the club as/.test(m.text))) return;
    log({ kind: "hold", what: e.what }); await sleep(e.ms); if (e.idleMs) await idle({ maxMs: e.idleMs, quietMs: 15000 }); return;
  }
  if (e.kind === "session") return session(e.who, e.date, e.first);
  if (e.kind === "respond") return respond(e.who, e.msg);
  if (e.kind === "game") { syncGames(); return playGame(e.key); }
  if (e.kind === "after") return afterGame(e.who, e.key);
}
async function loop() {
  const running = new Set();
  for (;;) {
    // what is due now runs, a few users at a time (one thing at a time per user)
    while (queue.length && queue[0].t <= simNow() && running.size < K) {
      const i = queue.findIndex((e) => e.t <= simNow() && (!e.who || !acting.has(e.who)));
      if (i < 0) break;
      const [e] = queue.splice(i, 1);
      if (e.kind === "end") { await Promise.all(running); return; }
      if (e.who) acting.add(e.who);
      const p = handle(e).catch((x) => log({ kind: "error", event: e.kind, who: e.who, error: String(x.stack || x).slice(0, 400) })).finally(() => { running.delete(p); if (e.who) acting.delete(e.who); });
      running.add(p);
    }
    if (!queue.length && !running.size) return;
    if (!running.size && queue.length && queue[0].t > simNow()) {
      await idle({ maxMs: queue[0].kind === "hold" && queue[0].idleMs ? queue[0].idleMs : 12 * 60000 });
      syncGames();
      if (queue[0].t > simNow()) { await jump(queue[0].t); log({ kind: "clock", to: new Date(queue[0].t).toISOString() }); }
    }
    // a hold needs the gateway's work after it done before the clock moves on (the loop's run can take minutes)
    await sleep(300);
  }
}

// ---- the run ----------------------------------------------------------------------------------------------------------------
async function main() {
  const all = fs.existsSync(path.join(HERE, "personas.json")) ? loadPersonas() : generate();
  personas = all.slice(0, NUSERS);
  // --eager: a flow check only (everyone opens the chat, asks and answers at once); never for results
  if (process.argv.includes("--eager")) personas = personas.map((p) => ({ ...p, inertia: { ...p.inertia, laziness: 0.05, pOpen: 1, replyMin: 3, pNotThisWeek: 0.05, flaky: 0.01, pBusy: 0.05 } }));
  // --lazy-shift d: everyone d lazier (or less lazy, d < 0), for the sensitivity check (inertia.withLaziness)
  if (arg("lazy-shift")) personas = personas.map((p) => I.withLaziness(p, p.inertia.laziness + +arg("lazy-shift")));
  byId = Object.fromEntries(personas.map((p) => [p.id, p]));
  for (const p of personas) st[p.id] = { actions: [], days: new Set(), chose: {}, episodes: [], decisions: [], stoodUp: [] };
  setup(personas);
  const start = at(dates[0], "00:00");
  offset = start - Date.now();
  const servers = [graphServer(), proxy(LLM_PROXY, LLM_TARGET, "llm"), proxy(GUARD_PROXY, GUARD_TARGET, "guard")];
  startGateway(start);
  log({ kind: "start", run: RUN, seed: SEED, arm: ARM, users: NUSERS, days: dates, llm: LLM_TARGET, guard: GUARD_TARGET, persona: process.env.PERSONA_LLM_URL || "http://127.0.0.1:11448" });
  for (let k = 0; k < 120; k++) { try { if ((await api("/api/status")).status === 200) break; } catch { /* starting */ } await sleep(1000); }
  const f = await api("/api/feed?player=u01").catch(() => ({ status: 0 }));
  feedOn = f.status === 200;
  log({ kind: "feed", on: feedOn });
  schedule();
  const t0 = Date.now();
  try { await loop(); await idle({ maxMs: 10 * 60000 }); } catch (e) { log({ kind: "error", error: String(e.stack || e) }); }
  syncGames();
  // what the gateway kept, for the measures and the seed (read from the run's own data folder)
  const players = (await api("/api/players")).body || [], ideas = (await api("/api/loop/ideas")).body, proposals = (await api("/api/loop/proposals")).body, flags = (await api("/api/loop/flags")).body;
  const audit = {}; for (const p of personas) audit[p.id] = (await api(`/api/match/audit?from=${p.id}`)).body?.estimates || [];
  const feed = feedOn ? (await api("/api/feed?player=u01&n=200")).body : null;
  const ledger = (await api("/api/ledger?n=1")).body;
  const serve = { games: [...games.values()], st: Object.fromEntries(Object.entries(st).map(([k, v]) => [k, { ...v, days: [...v.days] }])), inbox, players, ideas, proposals, flags, audit, feed, ledger: ledger?.bySite || null, flight, persona: P.stats, realMinutes: Math.round((Date.now() - t0) / 6e4) };
  fs.writeFileSync(path.join(DIR, "serve.json"), JSON.stringify(serve));
  const venues = JSON.parse(fs.readFileSync(path.join(DIR, "web/public/data/venues.json"), "utf8"));
  const base = runBaseline({ personas, venues, seed: SEED, dates });
  fs.writeFileSync(path.join(DIR, "baseline.json"), JSON.stringify(base));
  const result = measure({ run: RUN, seed: SEED, arm: ARM, dates, personas, serve, base, dataDir: path.join(DIR, "agent/data") });
  fs.writeFileSync(path.join(DIR, `sim_users_${RUN}.json`), JSON.stringify(result, null, 1));
  log({ kind: "done", realMinutes: serve.realMinutes });
  gw.kill(); servers.forEach((s) => s.close());
  console.log(JSON.stringify(result.headline, null, 1));
  process.exit(0);
}
main().catch((e) => { console.error(e); try { gw?.kill(); } catch { /* gone */ } process.exit(1); });

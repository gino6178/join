// Agent gateway: the player's agent and its helpers for the web app (an HTTP API that streams every step), the same
// agent in Facebook Messenger (webhook /webhook/messenger) with its reminders and check-ins, and the club members'
// agents over A2A. Configure in .env (see .env.example).
import fs from "node:fs";
import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";

for (const f of [".env"]) if (fs.existsSync(f)) for (const l of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
}
const { health, withPriority: llmPriority } = await import("./llm.js");
const msn = await import("./messenger.js");
const { todayText } = await import("./pocket.js");
const store = await import("./store.js");
const agentAnswer = await import("./answer.js");
const guard = await import("./guard.js");
const life = await import("./life.js");
const club = await import("./club.js");
const play = await import("./play.js");
const social = await import("./social.js");
const reel = await import("./reel.js");
const match = await import("./match.js");
const autopilot = await import("./autopilot.js");
const a2aMod = await import("./a2a.js"), { court } = a2aMod;
const matchSettings = await import("./match/settings.js");
const { readJSON, writeJSON } = await import("./jsonfile.js");
const bodylog = await import("./body.js");
const healthImport = await import("./health.js");
const places = await import("./places.js");
const pocketMod = await import("./pocket.js");
const asks = await import("./ask.js");
const matchmaking = await import("./match/index.js");
const ledger = await import("./ledger.js");
const vision = await import("./vision.js");
const asr = await import("./asr.js");
const tracing = await import("./trace.js");
const auth = await import("./auth.js");
const { crashPoint } = await import("./crash.js");
const attribution = await import("./attribution.js");
// the app's routes for what the gateway does but the app did not show (webapi.js), and whose safety checks are whose
const webapi = await import("./webapi.js");
const safety = await import("./safety.js");
// the community loop (docs/community_loop.md): signals, ideas and proposals here; the review, flags, gates and builder
// from their own modules, or stand-ins that fail closed until those are on this branch (loop/parts.js)
const loopSignals = await import("./loop/signals.js");
const loopProposals = await import("./loop/proposals.js");
const loopCycle = await import("./loop/cycle.js");
const loopParts = await (await import("./loop/parts.js")).load();
// the club feed, made by agents and people together (feed/, docs/club_feed.md)
const feed = await import("./feed/index.js");
const { fetchFile } = await import("./files.js");
// the club's notes the flags make ("Shipped, asked for by 7 members: …", "Rolled back: …") go with the ideas
try { loopParts.flags.onNote?.((n) => loopProposals.addNote(n)); } catch { /* the stand-in */ }

const PORT = +(process.env.PORT || 8787);
// the club members' agents are served here over A2A, and your agent reaches them at this address (a2a.js)
// this gateway's own addresses (its members' agents): the only ones its token goes to; A2A_BASE when it is set (a LAN
// address, with A2A_PUBLIC=1), or this machine
const ownBase = process.env.A2A_BASE;
process.env.A2A_BASE ||= `http://127.0.0.1:${PORT}`;
process.env.A2A_SELF ||= [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`, ...(ownBase ? [ownBase] : [])].join(",");
const a2aServer = await import("./a2a_server.js");
const ORIGINS = (process.env.ALLOW_ORIGINS || "http://127.0.0.1:5190,http://localhost:5190").split(",");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const cors = (origin) => (ORIGINS.includes(origin) ? { "access-control-allow-origin": origin, "access-control-allow-headers": "content-type, authorization", vary: "origin" } : {});
const json = (res, code, body, origin) => {
  res.writeHead(code, { "content-type": "application/json", ...cors(origin) });
  res.end(JSON.stringify(body));
};
// a long agent job as NDJSON: one line per step while it works, then {type: "done", result}
const stream = async (res, origin, run) => {
  res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-cache", ...cors(origin) });
  const send = (x) => res.write(JSON.stringify(x) + "\n");
  try { send({ type: "done", result: await run(send) }); } catch (e) { send({ type: "error", error: String(e.message || e) }); }
  res.end();
};
const rawOf = (req) => new Promise((ok) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => ok(b)); });
// a raw body up to a size, or null when it is bigger
const rawBytes = (req, max) => new Promise((ok) => { const parts = []; let n = 0, over = false; req.on("data", (c) => { n += c.length; if (n > max) over = true; else parts.push(c); }); req.on("end", () => ok(over ? null : Buffer.concat(parts))); });
const bodyOf = (req) => new Promise((ok) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { ok(JSON.parse(b || "{}")); } catch { ok({}); } }); });

// the morning message: today's calendar, for players with something on today
async function remind(force = false) {
  const now = new Date(), day = now.toISOString().slice(0, 10), out = [];
  for (const p of store.players()) {
    if (!life.today(p, now).length || (!force && (now.getHours() !== (p.prefs.reminderHour ?? 7) || p.prefs.lastReminder === day))) continue;
    try { await msn.pocket.send(p.id, todayText(p, now), msn.REMINDER); store.markReminded(p.id, day); out.push(p.id); } catch (e) { out.push(`${p.id}: ${e.message}`); }
  }
  return out;
}
// your agent: a message an hour before each session or game, and an evening
// check-in on training days that have nothing logged yet. force=true (tests, the web button) ignores the clock.
async function lifeTick({ kind = "all", force = false } = {}) {
  const now = new Date(), day = life.ymd(now), out = [];
  for (const p of store.players()) {
    try {
      if (kind === "all" || kind === "presession") {
        const soon = p.events.filter((e) => ["training", "match"].includes(e.kind) && e.start && !e.reminded && (force ? life.at(e) > now : life.at(e) - now > 0 && life.at(e) - now <= 75 * 60000));
        for (const e of soon.slice(0, 1)) {
          store.update(p.id, (q) => { const x = q.events.find((y) => y.id === e.id); if (x) x.reminded = true; });
          await msn.pocket.send(p.id, `Coming up: ${life.evText(e)}.`, msn.REMINDER);
          out.push(`${p.id}: presession ${e.id}`);
        }
      }
      if (kind === "all" || kind === "checkin") {
        const trainedToday = life.today(p, now).some((e) => ["training", "match"].includes(e.kind));
        const logged = p.logs.some((l) => l.date === day);
        if (force || (now.getHours() === (p.prefs.checkinHour ?? 21) && p.prefs.lastCheckin !== day && trainedToday && !logged)) {
          await msn.pocket.send(p.id, "How did today's session go? Tell me what you did, roughly how long, and anything sore. I'll log it and plan your next games around it.", msn.REMINDER);
          store.markReminded(p.id, day, "lastCheckin"); out.push(`${p.id}: checkin`);
        }
      }
    } catch (e) { out.push(`${p.id}: ${e.message}`); }
  }
  return out;
}
// nightly, only with NIGHTLY=1: the matchmaking prediction is retrained on consenting members' records, gated (match/api.js)
async function nightly() {
  if (process.env.NIGHTLY !== "1") return;
  matchmaking.nightly(new Date());
}
// the Autopilot in Messenger: the plan comes back as one message with buttons; a yes books the games. The two
// messages a run can end with go through the run (notify, notifyNone), which sends each once, also for a run resumed
// after a restart (autopilot.resumeRuns, below)
const apMessages = (psid) => ({
  notify: async (id, games, summary, { draft = false } = {}) => {
    const one = games.length === 1;
    // a draft (the goal check found the plan off what was asked, or could not check it): shown, plainly marked
    await msn.direct(psid, `${summary}\n\n${draft ? "Draft:\n" : ""}${games.map((o) => `• ${autopilot.describe(o)}`).join("\n")}\n\n${draft ? `Look it over. Book ${one ? "it" : "them"} anyway?` : `Everyone's agent already said yes. Book ${one ? "it" : "them"}?`}`, {
      buttons: one ? [{ title: "Book it", payload: `ap:${id}:all` }, { title: "Not this week", payload: `ap:${id}:none` }]
        : [{ title: "Book both", payload: `ap:${id}:all` }, { title: "Only the first", payload: `ap:${id}:first` }, { title: "Not this week", payload: `ap:${id}:none` }] });
  },
  notifyNone: async (id, summary) => { await msn.direct(psid, summary || "No game fit your usual times this week. Want me to try other days?"); },
});
const apNow = () => (process.env.AUTOPILOT_NOW ? new Date(process.env.AUTOPILOT_NOW) : new Date());
async function autopilotFor(psid) {
  const me = store.get(psid), upcoming = (me?.events || []).filter((e) => e.kind === "match" && e.with?.length).map((e) => ({ date: e.date, start: e.start, with: e.with }));
  return autopilot.run({ messenger: psid, history: me?.games || [], upcoming, body: me?.body, now: apNow(), ...apMessages(psid) });
}
// book games the player said yes to; for a Messenger player they go in the calendar, so the hour-before reminder and the
// evening check-in follow them
// CLUB_PLAYERS=1: a partner who is one of this gateway's players and keeps "ask me first" on (match/settings.js
// confirm, on by default; /confirm off) is not committed by their agent's yes in the talk. Their agent holds the time and
// asks them, with buttons, the way a booking waits for the asker's own yes. All in: the game is booked. Backing out:
// the hold is let go, the asker hears so, and the asker's agent looks for someone else (leaving them out).
const PENDING_FILE = path.resolve(process.env.CONFIRM_FILE || "data/partner_confirm.json");
const pending = readJSON(PENDING_FILE, {});
const savePending = () => writeJSON(PENDING_FILE, pending);
const needsYes = (psid, o) => (club.clubPlayers() && psid ? o.partners.filter((p) => p.id !== psid && store.get(p.id) && matchSettings.get(p.id).confirm !== false) : []);
async function askPartners(psid, o, who) {
  const id = `pc-${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`, me = { id: psid, name: club.readClub().you?.name || "a club member" };
  pending[id] = { id, by: psid, byName: me.name, option: o, waiting: who.map((p) => p.id), at: Date.now() }; savePending();
  for (const p of who) await msn.direct(p.id, `${me.name.split(" ")[0]} wants a game with you: ${autopilot.describe({ ...o, partners: [me, ...o.partners.filter((x) => x.id !== p.id)] })}. Your agent is holding the time for you. Are you in?`,
    { tag: msn.REMINDER.tag, buttons: [{ title: "I'm in", payload: `pc:${id}:yes` }, { title: "Can't make it", payload: `pc:${id}:no` }] }).catch(() => {});
  return { asking: who.map((p) => p.name) };
}
async function confirmAnswer(psid, payload) {
  const m = /^pc:([\w-]+):(yes|no)$/.exec(payload), P = m && pending[m[1]];
  if (!P || !P.waiting.includes(psid)) return msn.direct(psid, "That game isn't waiting for you any more.");
  const o = P.option, first = (n) => String(n).split(" ")[0], mine = P.option.partners.find((x) => x.id === psid)?.name || "Your partner";
  if (m[2] === "no") {
    delete pending[P.id]; savePending();
    await a2aMod.releaseHolds(o, { why: "dropped" }).catch(() => {});
    await msn.direct(psid, `OK, you're out of it. I've let go of the time and told ${first(P.byName)}'s agent.`);
    return club.asPlayer(P.by, async () => {
      await msn.direct(P.by, `${first(mine)} can't make ${autopilot.describe(o)} after all, so nothing is booked. Looking for someone else…`);
      const r = await asks.request({ who: P.by, text: `I want to play ${o.format} on ${o.day} at ${o.start}`, upcoming: inputOf(P.by).upcoming, leaveOut: [psid] });
      return deliverGame(P.by, r.id, r);
    });
  }
  P.waiting = P.waiting.filter((x) => x !== psid); savePending();
  if (P.waiting.length) return msn.direct(psid, "Thanks, you're in. I'll book it once everyone has said yes.");
  delete pending[P.id]; savePending();
  return club.asPlayer(P.by, async () => {
    const [b] = await bookFor(P.by, [o], { confirmed: true });
    if (b?.error) { await msn.direct(P.by, `${autopilot.describe(o)} wasn't booked: ${b.error}`); return msn.direct(psid, `It couldn't be booked after all: ${b.error}`); }
    await msn.direct(P.by, `Booked: ${autopilot.describe(o)}, court ${o.court}. ${first(mine)} said yes. I'll remind you an hour before.`);
  });
}
async function bookFor(psid, options, { confirmed = false } = {}) {
  const out = [], players = club.clubPlayers() && psid;
  // (with CLUB_PLAYERS=1 the booking names whose agent booked it, so that player counts as playing then: play.js playing)
  for (const o of options) {
    const who = confirmed ? [] : needsYes(psid, o);
    out.push(who.length ? await askPartners(psid, o, who) : await play.book({ option: players ? { ...o, by: psid } : o, invites: {}, you: {} }));
  }
  if (out.some((b) => b?.asking)) { const k = out.map((b, i) => (b?.asking ? -1 : i)).filter((i) => i >= 0); options = options.map((o, i) => (k.includes(i) ? o : null)); }
  // a booking that was refused (the court just taken, a partner booked into another game since) is not in the
  // calendar; a game booked again (an outbox sent again after a crash) is added once (addEvents skips one it has)
  const fresh = options.filter((o, k) => o && !out[k]?.error && !out[k]?.asking);
  const event = (o, partners) => ({ date: o.date, start: o.start, end: o.end, title: autopilot.describe({ ...o, partners }), kind: "match", with: partners.map((x) => x.id), booked: o.minutes, sport: o.sport,
    ...(o.venue.public && o.venue.lat != null ? { place: { lat: o.venue.lat, lon: o.venue.lon, name: o.venue.name, outdoor: o.venue.outdoor !== false } } : {}) });
  if (psid && store.get(psid) && fresh.length) life.addEvents(psid, fresh.map((o) => event(o, o.partners)));
  // CLUB_PLAYERS=1: a partner who is one of this gateway's Messenger players hears that their agent said yes for them,
  // and the game goes in their calendar too (their reminder before it, their check-in after it, their next asks)
  // (a game booked again, an outbox sent again after a crash, is told once: addEvents keeps one copy of it)
  if (players) for (const o of fresh) {
    const me = { id: psid, name: club.readClub().you?.name || "a club member" };
    for (const p of o.partners.filter((x) => x.id !== psid && store.get(x.id))) {
      if (store.get(p.id).events.some((e) => e.date === o.date && e.start === o.start && e.kind === "match")) continue;
      const with_ = [me, ...o.partners.filter((x) => x.id !== p.id)], e = event(o, with_);
      life.addEvents(p.id, [e]);
      await msn.direct(p.id, confirmed ? `Booked: ${e.title}. It's in your calendar, and I'll remind you an hour before.` : `Your agent said yes for you: ${e.title}. It's in your calendar, and I'll remind you an hour before.`, msn.REMINDER).catch(() => {});
    }
  }
  return out;
}
// (the yes is saved with its games before they are booked, and cleared after: a restart in between books them then)
async function bookApproved(id, choice, psid = null) {
  const p = autopilot.answer(id, choice);
  if (!p) return { error: "That plan was already answered." };
  const bookings = await bookFor(psid, p.options);
  crashPoint("autopilot-booked");
  autopilot.booked(id);
  return { bookings, options: p.options };
}
msn.hooks.autopilot = autopilotFor;
msn.hooks.payload = async (psid, payload) => {
  if (payload.startsWith("wx:")) return weatherAnswer(psid, payload);
  if (payload.startsWith("gm:")) return gameAnswer(psid, payload);
  if (payload.startsWith("pc:")) return confirmAnswer(psid, payload);
  const m = /^ap:([\w-]+):(all|first|none)$/.exec(payload);
  if (!m) return;
  const r = await bookApproved(m[1], m[2], psid);
  if (r.error) return msn.direct(psid, r.error);
  if (!r.options.length) return msn.direct(psid, "OK, nothing booked this week. I'll look again on Monday.");
  const ok = r.options.filter((o, k) => !r.bookings[k]?.error && !r.bookings[k]?.asking), no = r.options.map((o, k) => [o, r.bookings[k]]).filter(([, b]) => b?.error), wait = r.options.filter((o, k) => r.bookings[k]?.asking);
  await msn.direct(psid, [ok.length && `Booked:\n${ok.map((o) => `• ${autopilot.describe(o)}, court ${o.court}`).join("\n")}`,
    wait.length && `Waiting for your partners' yes:\n${wait.map((o) => `• ${autopilot.describe(o)}`).join("\n")}`,
    no.length && `Not booked:\n${no.map(([o, b]) => `• ${autopilot.describe(o)}: ${b.error}`).join("\n")}`, ok.length ? "I'll remind you an hour before each game." : "Send /autopilot to look again."].filter(Boolean).join("\n"));
};
// "Want a game?" in Messenger: the Match helper asks with three buttons; a yes goes to the Talk helper, which agrees it
// with the other players' agents and shows the player what they said
const inputOf = (psid) => { const me = store.get(psid); return { history: me?.games || [], upcoming: (me?.events || []).filter((e) => e.kind === "match" && e.with?.length).map((e) => ({ date: e.date, start: e.start, with: e.with })), body: me?.body || null }; };
const ASK_BUTTONS = (id) => [{ title: "Yes, set it up", payload: `gm:${id}:yes` }, { title: "Another time", payload: `gm:${id}:other` }, { title: "Not this week", payload: `gm:${id}:week` }];
async function gameFor(psid, { ahead = 7, quiet = false } = {}) {
  const r = await asks.ask({ who: psid, ...inputOf(psid), ahead });
  if (r.none) { if (!quiet) await msn.direct(psid, `No game to suggest right now: ${r.none}. Send /autopilot to have me plan the whole week.`); return r; }
  await msn.direct(psid, r.text, { buttons: ASK_BUTTONS(r.id) });
  return r;
}
// the agents' messages, as the player sees them: who said what, in order
function talkText(log = [], club0 = club.readClub()) {
  const who = (id) => id === "you" ? "Your agent" : `${club0.members.find((m) => m.id === id)?.name.split(" ")[0] || id}'s agent`;
  return log.map((x) => `› ${who(x.from)}: ${x.text}`).join("\n");
}
async function gameAnswer(psid, payload) {
  const m = /^gm:([\w-]+):(yes|other|week|book|drop|one|two)$/.exec(payload);
  if (!m) return;
  const [, id, choice] = m, a = asks.get(id);
  // (with /improve on: Yes and Not this week are the Match helper's 👍 and 👎, and every answer is counted; no words)
  if (choice === "yes" || choice === "week") loopSignals.record(psid, { kind: "thumb", feature: "match", value: choice === "yes" ? 1 : -1 });
  loopSignals.record(psid, { kind: "count", site: `ask.${choice}`, n: 1 });
  if (choice === "yes" && a?.status === "asked") await msn.direct(psid, `Talking to ${a.opening.partners.map((p) => p.name.split(" ")[0]).join(", ")}'s agent${a.opening.partners.length > 1 ? "s" : ""} about ${a.opening.day} ${a.opening.start}…`);
  const r = await asks.answer(id, choice);
  if (r.error) return msn.direct(psid, r.error);
  return deliverGame(psid, id, r);
}
// a question's result to the player. It goes through an outbox kept with the question: written before anything is
// done, the booking marked once made, cleared once the message is sent. After a crash the outbox is delivered again
// (at least once), and a booking already made is not made twice.
async function deliverGame(psid, id, r) {
  if (r.choose) return msn.direct(psid, r.text, { buttons: r.buttons }); // a game today: one at a time or two at once
  if (r.snoozed || (r.text && !r.moved && !r.book && !r.next && !r.failed)) return msn.direct(psid, r.text);
  // a game whose time has passed (an outbox sent again late) is not booked
  if (r.book && !r.bookedAt && asks.passed(r.book)) { asks.outbox(id, null); asks.fail(id, "its time passed before it was booked"); return msn.direct(psid, `The game ${r.book.day} ${r.book.start} wasn't booked: its time has passed. Send /game to look again.`); }
  asks.outbox(id, r);
  if (r.book && !r.bookedAt) {
    const [b] = await bookFor(psid, [r.book]);
    // refused when it was booked (a partner booked into another game since their yes, the court just taken)
    if (b?.error) { asks.fail(id, b.error); r = { ...r, book: null, failed: `${autopilot.describe(r.book)} wasn't booked: ${b.error.replace(/\.$/, "")}` }; }
    // (a partner who keeps "ask me first" on is asked; the game is booked once they say yes: confirmAnswer)
    else if (b?.asking) r = { ...r, waiting: { option: r.book, names: b.asking }, book: null, bookedAt: Date.now() };
    else r = { ...r, bookedAt: Date.now() };
    asks.outbox(id, r);
  }
  await sendResult(psid, id, r);
  asks.outbox(id, null);
}
async function sendResult(psid, id, r) {
  const talk = r.log?.length ? `${talkText(r.log)}\n\n` : "";
  if (r.book) return msn.direct(psid, `${talk}Booked: ${autopilot.describe(r.book)}, court ${r.book.court}. I'll remind you an hour before.`);
  if (r.waiting) return msn.direct(psid, `${talk}${autopilot.describe(r.waiting.option)}: their agent${r.waiting.names.length > 1 ? "s" : ""} agreed, and I've asked ${r.waiting.names.map((n) => n.split(" ")[0]).join(" and ")} to confirm. I'll book it as soon as they say yes.`);
  if (r.moved) return msn.direct(psid, `${talk}${r.text}`, { buttons: [{ title: "Book it", payload: `gm:${id}:book` }, { title: "Drop it", payload: `gm:${id}:drop` }] });
  const next = r.next, lead = r.failed ? `${talk}No deal: ${r.failed}.` : "";
  if (next && !next.none) return msn.direct(psid, `${lead ? lead + "\n\n" : ""}${next.text}`, { buttons: ASK_BUTTONS(next.id) });
  return msn.direct(psid, `${lead ? lead + " " : ""}No other opening at your usual times in the next days. Send /autopilot and I'll look at the rest of your week.`);
}
// a setting the community loop may change for beta members (loop/flags.js), or its default here
// (each reader names its key in flags.get, as the oracle of a C0 change checks: flags.schema.json lists this file)
const flagOr = (read, fallback) => { try { const v = read(); return Number.isFinite(v) ? v : fallback; } catch { return fallback; } };
// once a day at ASK_HOUR (12:00), for Messenger players who wrote in the last day (Messenger's standard messaging
// window): the Match helper asks about the next three days, if the week is short of the goal. For a beta member in a
// canary the hour (ask.hour) and the days ahead (ask.ahead) are the flags' values
async function askTick(now = new Date(), force = false) {
  let n = 0;
  for (const p of store.players()) {
    if (!msn.state.enabled || p.prefs.ask === false) continue;
    if (!force && now.getHours() !== flagOr(() => loopParts.flags.get("ask.hour", p.id), +(process.env.ASK_HOUR ?? 12))) continue;
    const today = life.ymd(now);
    if (!force && (p.prefs.lastAsk === today || !p.lastSeen || Date.now() - p.lastSeen > 23 * 36e5 || asks.open(p.id))) continue;
    store.setPref(p.id, "lastAsk", today);
    const r = await club.asPlayer(p.id, () => gameFor(p.id, { ahead: force ? 7 : flagOr(() => loopParts.flags.get("ask.ahead", p.id), 3), quiet: true })).catch(() => null);
    if (r && !r.none) n++;
  }
  return n;
}
msn.hooks.game = (psid) => gameFor(psid);
// "I want to play" in Messenger (match/flow.js): the likeliest yeses' agents first; the agreed game waits for Book it
msn.hooks.play = async (psid, text) => {
  await msn.direct(psid, "On it: asking the agents of the people most likely to say yes, then agreeing a time and a court.");
  const r = await asks.request({ who: psid, text, upcoming: inputOf(psid).upcoming });
  return deliverGame(psid, r.id, r);
};
msn.hooks.seen = (psid) => store.update(psid, (q) => { q.lastSeen = Date.now(); });
// the club feed in Messenger: Post or Not now for a highlight the member's agent drafted, and a video sent to the chat
msn.hooks.feed = (psid, payload) => feed.answerInMessenger(psid, payload, (id, text) => msn.direct(id, text));
msn.hooks.video = (psid, url) => feed.fromMessenger(psid, url, { fetchFile, reel, send: (id, text, opts) => msn.direct(id, text, opts) });
feed.start({ send: (id, text, opts) => msn.direct(id, text, opts) });

// the Autopilot on its own: on Monday morning, for players who switched it on, if the week is short of the goal
const ran = {};
async function autopilotTick(now = new Date()) {
  if (now.getDay() !== 1 || now.getHours() !== +(process.env.AUTOPILOT_HOUR ?? 8)) return;
  for (const p of store.players()) {
    if (!p.prefs.autopilot || ran[p.id] === life.ymd(now)) continue;
    ran[p.id] = life.ymd(now);
    await club.asPlayer(p.id, () => autopilotFor(p.id)).catch(() => {});
  }
}
// the weather watch: three hours before a game on an outdoor court, the agent checks the forecast for that hour. When
// rain is likely it finds a club venue with a free court at the same time and asks the player, with buttons, whether to
// move the game there (the other players' agents are told when it moves).
const WET = +(process.env.RAIN_MOVE_AT || 60);
async function weatherTick(now = new Date(), force = false) {
  let n = 0;
  for (const p of store.players()) {
    for (const e of (p.events || []).filter((x) => x.place?.outdoor && x.start && !x.weather)) {
      const mins = (new Date(`${e.date}T${e.start}`) - now) / 6e4;
      if (!force && (mins < 150 || mins > 210)) continue;
      const w = await places.forecast(e.place.lat, e.place.lon, e.date, e.start);
      store.update(p.id, (q) => { const x = q.events.find((y) => y.id === e.id); if (x) x.weather = { ...(w || {}), at: Date.now() }; });
      if (!w || w.rain < WET) continue;
      const venues = play.helpers.readVenues(), club0 = club.readClub(), d = new Date(`${e.date}T12:00`);
      const people = [{ id: "you", name: "You", area: club0.you.area }, ...(e.with || []).map((id) => club0.members.find((m) => m.id === id)).filter(Boolean)];
      const c = court({ date: e.date, day: DAYS[d.getDay()] }, play.helpers.toMin(e.start), e.booked || 90, people, venues, e.sport || "basketball");
      const alt = c ? `${c.v.name} has court ${c.court} free at ${e.start} (NT$${Math.round((c.v.price * (e.booked || 90)) / 60 / people.length)} each, ${c.travel.find((t) => t.id === "you")?.min ?? "?"} min for you).` : "No indoor court is free at that time.";
      store.update(p.id, (q) => { const x = q.events.find((y) => y.id === e.id); if (x) x.move = c ? { venue: c.v.id, name: c.v.name, court: c.court } : null; });
      await msn.direct(p.id, `Rain is ${w.rain}% likely at ${e.start} at ${e.place.name}. ${alt}${c ? " Move the game there?" : ""}`, { tag: msn.REMINDER.tag, ...(c ? { buttons: [{ title: "Move it", payload: `wx:${e.id}:move` }, { title: "Keep it", payload: `wx:${e.id}:keep` }] } : {}) }).catch(() => {});
      n++;
    }
  }
  return n;
}
async function weatherAnswer(psid, payload) {
  const m = /^wx:(\w+):(move|keep)$/.exec(payload), p = store.get(psid);
  const e = p?.events.find((x) => x.id === m?.[1]);
  if (!e) return msn.direct(psid, "That game is no longer in your calendar.");
  if (m[2] === "keep" || !e.move) { store.update(psid, (q) => { const x = q.events.find((y) => y.id === e.id); if (x) x.move = null; }); return msn.direct(psid, "OK, the game stays outdoors. Bring a towel."); }
  const to = e.move;
  store.update(psid, (q) => { const x = q.events.find((y) => y.id === e.id); if (x) { x.title = x.title.replace(/ at .+? with /, ` at ${to.name} with `).replace(" (public court, free)", ""); x.place = { ...x.place, outdoor: false, name: to.name }; x.move = null; } });
  const names = (e.with || []).map((id) => club.readClub().members.find((mm) => mm.id === id)?.name.split(" ")[0]).filter(Boolean);
  return msn.direct(psid, `Moved: ${e.start} at ${to.name}, court ${to.court}. It's in your calendar.${names.length ? ` Let ${names.join(", ")} know.` : ""}`);
}

// the body log's follow-up: two days after something sore was logged, at 10:00, "How is your right knee today?"
async function bodyTick(now = new Date(), force = false, all = false) {
  if (!force && now.getHours() !== +(process.env.BODY_HOUR ?? 10)) return 0;
  let n = 0;
  for (const p of store.players()) {
    if (!msn.state.enabled && !force) continue;
    const asked = p.prefs.bodyAsked || {}, today = life.ymd(now);
    for (const f of pocketMod.organizeFor(p, now).followUps.filter((x) => (x.due || all) && asked[x.key] !== today)) {
      store.update(p.id, (q) => { q.prefs.bodyAsked = { ...(q.prefs.bodyAsked || {}), [f.key]: today }; });
      await msn.direct(p.id, f.text, { tag: msn.REMINDER.tag, buttons: [{ title: "Fine now", payload: `bd:${f.key}:fine` }, { title: "About the same", payload: `bd:${f.key}:same` }, { title: "Worse", payload: `bd:${f.key}:worse` }] }).catch(() => {});
      n++;
    }
  }
  return n;
}
setInterval(() => { remind().catch(() => {}); lifeTick().catch(() => {}); nightly().catch(() => {}); autopilotTick().catch(() => {}); bodyTick().catch(() => {}); weatherTick().catch(() => {}); askTick().catch(() => {}); }, 60000);

// ---- the community loop (docs/community_loop.md) ----
// the maintainer's token (MAINTAINER_TOKEN), for deciding proposals and rolling flags back; without one, nobody can
const MAINTAINER = ["/api/loop/decide", "/api/loop/rollback", "/api/feed/papers/run", "/api/feed/reports", "/api/feed/reports/media", "/api/feed/moderate", "/api/feed/audit", ...webapi.MAINTAINER];
function maintainer(req) {
  const t = String(process.env.MAINTAINER_TOKEN || "").trim(), m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || "");
  if (!t || !m) return false;
  const h = (x) => crypto.createHash("sha256").update(x).digest();
  return crypto.timingSafeEqual(h(m[1]), h(t));
}
// the maintainer's decision on a proposal: approve (with a note, which is what a builder reads besides the spec's own
// fields) or refuse. What the never-list refuses, nobody approves
function loopDecide(id, decision, note) {
  const sp = loopProposals.get(id);
  if (!sp) return { error: "no such proposal", code: 404 };
  if (!["approve", "refuse"].includes(decision)) return { error: "decision is approve or refuse", code: 400 };
  if (!["open", "review", "approved", "gated", "rolledBack"].includes(sp.status)) return { error: `it is ${sp.status}`, code: 409 };
  if (decision === "refuse") return loopProposals.setStatus(id, "refused", [note || "refused by the maintainer"], "maintainer");
  if (sp.review?.needs === "never") return { error: `the never-list refuses it: ${(sp.review.reasons || []).join("; ")}`, code: 409 };
  return loopProposals.setStatus(id, "approved", note ? [note] : [], "maintainer", { extra: { build: { ...sp.build, note: note || null } } });
}
// the flags as the flags' module keeps them (agent/data/loop/flags.json), each with its history
function loopFlags() {
  let list = [];
  if (!loopParts.stubs.includes("flags")) { try { list = loopParts.flags.list() || []; } catch { /* none yet */ } }
  else try { list = JSON.parse(fs.readFileSync(process.env.LOOP_FLAGS_FILE || `${loopSignals.DIR}/flags.json`, "utf8")); } catch { /* none yet */ }
  const rows = Array.isArray(list) ? list : Object.entries(list).map(([key, v]) => ({ key, ...v }));
  // (the beta list as a count, never the HMACs)
  return Object.fromEntries(rows.filter((f) => f && f.key).map((f) => { let history = []; try { history = loopParts.flags.history(f.key) || []; } catch { /* none */ } return [f.key, { ...f, beta: Array.isArray(f.beta) ? f.beta.length : f.beta ?? 0, history }]; }));
}
// nightly with LOOP_NIGHTLY=1 (at LOOP_HOUR, 5:00): one turn of the loop; and every five minutes, the flags' monitor,
// which turns a shipped flag off on a breach
const loopDone = { day: null, busy: false };
async function loopTick(now = new Date()) {
  if (process.env.LOOP_NIGHTLY !== "1" || now.getHours() !== +(process.env.LOOP_HOUR ?? 5) || loopDone.day === life.ymd(now) || loopDone.busy) return;
  loopDone.day = life.ymd(now); loopDone.busy = true;
  try { await llmPriority("background", () => loopCycle.cycle()); } finally { loopDone.busy = false; }
}
setInterval(() => { loopTick().catch(() => {}); }, 60000);
setInterval(() => { if (process.env.LOOP_WATCH !== "off") loopCycle.watch().catch(() => {}); }, 5 * 60000);

// Messenger's webhook: Meta checks it once with a GET, then signs every POST with the app secret
async function webhook(req, res, u) {
  if (req.method === "GET") { const c = msn.verify(u); res.writeHead(c ? 200 : 403, { "content-type": "text/plain" }); return res.end(c ?? "forbidden"); }
  const raw = await rawOf(req);
  if (!msn.signed(raw, req.headers["x-hub-signature-256"])) { res.writeHead(403); return res.end(); }
  res.writeHead(200); res.end("EVENT_RECEIVED"); // answer at once; Messenger retries slow webhooks
  let body = {}; try { body = JSON.parse(raw); } catch { return; }
  return msn.receive(body).catch((e) => { msn.state.error = String(e.message || e); });
}
// WEBHOOK_PORT: a second port, on this machine only, that serves the webhook and nothing else, for the tunnel that
// Meta reaches it through (so the rest of the API is never on the internet)
if (process.env.WEBHOOK_PORT) http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/webhook/messenger") return webhook(req, res, u);
  res.writeHead(404); res.end();
}).on("error", (e) => { msn.state.error = `webhook port ${process.env.WEBHOOK_PORT}: ${e.code || e.message}`; console.error(msn.state.error); }) // a taken port must not take the gateway down
  .listen(+process.env.WEBHOOK_PORT, "127.0.0.1", () => console.log(`Messenger webhook only, on 127.0.0.1:${process.env.WEBHOOK_PORT}`));

http.createServer(async (req, res) => {
  const o = req.headers.origin, u = new URL(req.url, "http://x");
  if (req.method === "OPTIONS") return json(res, 204, {}, o);
  // Facebook Messenger: GET once to verify the webhook, then a signed POST for every message
  if (u.pathname === "/webhook/messenger") return webhook(req, res, u);
  // the club members' agents (A2A protocol, on the official SDK; their JSON-RPC checks the token itself, auth.js)
  if (u.pathname.startsWith("/a2a/")) return a2aServer.handle(req, res);
  // the API: the token when AGENT_TOKEN is set (the status stays open, for the app's "is the gateway up" check), and
  // never a POST another site's page could make through the player's browser
  if (u.pathname.startsWith("/api/")) {
    const x = auth.crossSite(req, ORIGINS);
    if (x) return json(res, 403, { error: x }, o);
    if (!auth.openTo(req)) return json(res, 403, { error: "this gateway has no AGENT_TOKEN, so it answers its own machine only" }, o);
    // the maintainer's routes (deciding a proposal, rolling a flag back) take the maintainer's own token instead
    if (MAINTAINER.includes(u.pathname)) { if (!maintainer(req)) return json(res, 401, { error: "this route needs the maintainer's token: Authorization: Bearer <MAINTAINER_TOKEN>" }, o); }
    else if (u.pathname !== "/api/status" && !auth.authorized(req)) return json(res, 401, { error: "this gateway needs its token: Authorization: Bearer <AGENT_TOKEN>" }, o);
    safety.enter("app");
  }
  try {
    if (u.pathname.startsWith("/api/") && await webapi.route(req, res, u, { json, bodyOf, o })) return;
    if (u.pathname === "/api/status") {
      return json(res, 200, { llm: await health(), messenger: { enabled: msn.state.enabled, page: msn.state.page, error: msn.state.error, lastEvent: msn.state.lastEvent }, reel: reel.ready(), reelEffects: reel.effectsReady(), places: places.ready(), health: true,
        players: store.players().length }, o);
    }
    // OpenTelemetry spans: one trace (?trace=<id>), or the latest traces of one kind of agent run (?root=invoke_agent autopilot&n=1)
    // (with ?trace=, a run that ended short also gets its failure attribution: the step it ended on, and what kind)
    if (u.pathname === "/api/traces") { const sp = tracing.spans({ trace: u.searchParams.get("trace"), root: u.searchParams.get("root"), n: +(u.searchParams.get("n") || 1) }); return json(res, 200, { spans: sp, attribution: u.searchParams.get("trace") ? attribution.attribute(sp) : null }, o); }
    // the token ledger: what each call site has cost since the gateway started, and the latest calls
    if (u.pathname === "/api/ledger") return json(res, 200, { total: ledger.totals(ledger.calls(100000)), bySite: ledger.bySite(ledger.calls(100000)), recent: ledger.calls(+(u.searchParams.get("n") || 30)) }, o);
    if (u.pathname === "/api/players") return json(res, 200, store.players().map(({ id, name, memories, history, prefs, events, logs, games, body }) => ({ id, name, memories, history: history.slice(-20), prefs, events, logs, games, body })), o);
    // a question for your agent from the app: answered from your games, bookings and body log (body: { text, you }),
    // past the guards both ways, with the checks they made (webapi.answer)
    if (u.pathname === "/api/agent/answer" && req.method === "POST") return json(res, 200, await webapi.answer(await bodyOf(req), agentAnswer.answer), o);
    // play: "I want to play" -> courts, partners and invites; nothing is booked until the player confirms
    if (u.pathname === "/api/play/plan" && req.method === "POST") {
      const b = await bodyOf(req);
      return b.stream ? stream(res, o, (send) => play.plan({ text: b.text, you: b.you, onStep: send })) : json(res, 200, await play.plan({ text: b.text, you: b.you }), o);
    }
    // the Autopilot: your agent plans the week against your goal (body: { you, history, goal, ratings, upcoming })
    // (AUTOPILOT_NOW, for the crash test only: every run plans from that moment, so a run and its resumed self see one week)
    if (u.pathname === "/api/autopilot/run" && req.method === "POST") { const b = await bodyOf(req); const now = apNow(); return stream(res, o, (send) => autopilot.run({ ...b, now, player: "app", notes: null, onStep: send })); }
    // where a run is (its stream ends with the gateway; a run cut off by a restart goes on by itself): working, with the
    // steps done, or done, with its plan
    if (u.pathname === "/api/autopilot/run" && req.method === "GET") { const s = autopilot.status(String(u.searchParams.get("id") || "")); return json(res, s ? 200 : 404, s || { error: "no such run" }, o); }
    // your answer to the Autopilot's plan, from the app (body: { id, choice: all | first | none })
    if (u.pathname === "/api/autopilot/answer" && req.method === "POST") { const b = await bodyOf(req); return json(res, 200, await bookApproved(b.id, b.choice), o); }
    // "Want a game?" from the app (body: { history, upcoming, body, skip }); the answer streams the agents' talk
    if (u.pathname === "/api/ask/next" && req.method === "POST") { const b = await bodyOf(req); return json(res, 200, await asks.ask({ who: "app", history: b.history || [], upcoming: b.upcoming || [], body: b.body || null, skip: b.skip || [], ahead: b.ahead || 3 }), o); }
    if (u.pathname === "/api/ask/answer" && req.method === "POST") {
      const b = await bodyOf(req);
      return stream(res, o, async (send) => {
        const r = await asks.answer(String(b.id || ""), String(b.choice || ""), { say: (x) => send({ type: "a2a", ...x, to: Array.isArray(x.to) ? x.to[0] : x.to }), tell: (x) => send({ type: "step", ...x }), work: (step) => send({ type: "working", step }) });
        // (the result is in the question's outbox until the booking is made: made again after a crash, it is the same one)
        if (r.book) { asks.outbox(b.id, r); r.booking = await play.book({ option: r.book, invites: {}, you: {} }); crashPoint("booked"); asks.outbox(b.id, null); }
        // refused when it was booked (a partner booked into another game since their yes, the court just taken)
        if (r.booking?.error) { asks.fail(b.id, r.booking.error); return { ...r, book: null, booking: null, failed: `${autopilot.describe(r.book)} wasn't booked: ${r.booking.error.replace(/\.$/, "")}` }; }
        return r;
      });
    }
    // a photo of a scoreboard or a score sheet -> the score of each game, checked against the rules of the sport
    // (the raw image is the body; ?players=Leo,Kenji the names it may show; ?sport=badminton)
    if (u.pathname === "/api/vision/score" && req.method === "POST") {
      const img = await rawBytes(req, 8e6);
      if (!img) return json(res, 413, { error: "The photo is too big (8 MB at most)." }, o);
      return json(res, 200, await vision.readScore(img.toString("base64"), { sport: u.searchParams.get("sport") || "badminton", players: (u.searchParams.get("players") || "").split(",").filter(Boolean).slice(0, 4) }), o);
    }
    // (a recording from the app -> its words: /api/asr, in webapi.js)
    // a test hook: the Match helper's daily ask, now
    if (u.pathname === "/api/ask/tick" && req.method === "POST") return json(res, 200, { sent: await askTick(new Date(), true) }, o);
    // "I want to play" from the app (match/flow.js): streamed steps, then the agreed game as a question (book with
    // /api/ask/answer {choice: "book"}); and who asked about whom (the estimates, never the records)
    if (u.pathname === "/api/match/find" && req.method === "POST") { const b = await bodyOf(req); return stream(res, o, (send) => asks.request({ who: "app", text: String(b.text || "").slice(0, 300), upcoming: b.upcoming || [], par: 1, say: (x) => send({ type: "a2a", ...x, to: Array.isArray(x.to) ? x.to[0] : x.to }), tell: (x) => send({ type: "step", ...x }), work: (step) => send({ type: "working", step }) }).then((r) => { if (r.id) asks.outbox(r.id, null); return r; })); } // (streamed: its outbox is done)
    { const r = u.pathname.startsWith("/api/match/") ? await matchmaking.api(u, req, bodyOf) : null; if (r) return json(res, r.code || 200, r.body, o); } // the audit, settings, models (match/api.js)
    // the club feed: posts, likes, comments, reports, drafts, media, the reading agent (feed/api.js)
    if (u.pathname === "/api/feed" || u.pathname.startsWith("/api/feed/")) return feed.handle(req, res, u, { cors: cors(o), maintainer: maintainer(req) });
    // best match: your agent ranks the members for a game (body: { you, ratings, played, format })
    if (u.pathname === "/api/match/best" && req.method === "POST") { const b = await bodyOf(req); return stream(res, o, (send) => match.best({ ...b, onStep: send })); }
    // agent to agent: your agent and the member's agent agree a time and a court (body: { with, format, you })
    if (u.pathname === "/api/match/talk" && req.method === "POST") { const b = await bodyOf(req); return stream(res, o, (send) => match.talk({ ...b, onStep: send })); }
    // the body log: what the player says hurts -> entries (body: { text, log, games, workouts, days }), organized with the rest
    if (u.pathname === "/api/body/read" && req.method === "POST") {
      const b = await bodyOf(req), r = await bodylog.read(String(b.text || "").slice(0, 600));
      const org = bodylog.organize({ log: [...(b.log || []), ...r.entries], games: b.games || [], workouts: b.workouts || [], days: b.days || [] });
      return json(res, 200, { ...r, org, reply: r.entries.length ? bodylog.said(r.entries, org) : "I couldn't tell which part of your body you mean. Try \"my right knee is sore after jumping\"." }, o);
    }
    // the body report: organized, with Muse Glimmer's summary (checked: every number from the facts)
    if (u.pathname === "/api/body/report" && req.method === "POST") {
      const b = await bodyOf(req), org = bodylog.organize({ log: b.log || [], games: b.games || [], workouts: b.workouts || [], days: b.days || [] });
      return json(res, 200, { org, summary: b.summary === false ? null : await bodylog.summary(org) }, o);
    }
    // a health app's export (the raw file is the body; ?name= its file name, ?tz= minutes east of UTC)
    if (u.pathname === "/api/health/import" && req.method === "POST")
      return stream(res, o, (send) => healthImport.upload(req, send, { name: u.searchParams.get("name") || "export", tz: +(u.searchParams.get("tz") ?? 480), days: +(u.searchParams.get("days") || 120) }));
    // courts and parks near a point, judged playable or not (body: { lat, lon, sport, date, start, radius })
    if (u.pathname === "/api/places" && req.method === "POST") { const b = await bodyOf(req); return stream(res, o, (send) => places.search({ ...b, onStep: send })); }
    if (u.pathname === "/api/places/where") return json(res, 200, await places.where(u.searchParams.get("q") || "").catch((e) => ({ error: e.message })), o);
    // the map under a GPS route: roads, rivers and parks in an area (?s=&w=&n=&e=), drawn by the app
    if (u.pathname === "/api/map/base") { const q = Object.fromEntries(["s", "w", "n", "e"].map((k) => [k, +u.searchParams.get(k)])); return json(res, 200, await places.basemap(q).catch((e) => ({ error: e.message })), o); }
    // a test hook: send the body log's follow-ups now
    // a test hook: check the weather for every outdoor game now
    if (u.pathname === "/api/weather/check" && req.method === "POST") return json(res, 200, { sent: await weatherTick(new Date(), true) }, o);
    if (u.pathname === "/api/body/followups" && req.method === "POST") return json(res, 200, { sent: await bodyTick(new Date(), true, u.searchParams.get("all") === "1") }, o);
    // your own video -> a highlight reel (the raw video is the body): you found, read and cut out, your smash found
    if (u.pathname === "/api/reel" && req.method === "POST") {
      if (!reel.ready()) return json(res, 503, { error: "Making reels from your own video is not set up on this server (REEL_PYTHON, REEL_SCRIPT)." }, o);
      return stream(res, o, (send) => reel.make(req, send, u.searchParams.get("sport") || "badminton", { effects: u.searchParams.get("effects") === "1" }));
    }
    // the caption for a highlight reel on Instagram or Facebook (body: { player, event, picks })
    if (u.pathname === "/api/highlight/caption" && req.method === "POST") { const b = await bodyOf(req); return json(res, 200, await social.caption(b), o); }
    if (u.pathname === "/api/play/book" && req.method === "POST") { const b = await bodyOf(req); return json(res, 200, await play.book(b), o); }
    if (u.pathname === "/api/play/booking") return json(res, 200, play.status(u.searchParams.get("id")), o);
    if (u.pathname === "/api/play/cancel" && req.method === "POST") { const b = await bodyOf(req); return json(res, 200, play.cancel(b.id), o); }
    // the community loop: the ideas members shared (5 or more members), votes, proposals with their review and gates, flags
    if (u.pathname === "/api/loop/ideas") return json(res, 200, { ideas: loopProposals.ideas({ who: loopSignals.whoOf("app") }), notes: loopProposals.notes().slice(-10), credits: loopProposals.credits(loopSignals.whoOf("app")), simulated: process.env.LOOP_SIMULATED === "1" ? { seed: +(process.env.SIM_SEED || 7) } : null }, o);
    if (u.pathname === "/api/loop/vote" && req.method === "POST") { const b = await bodyOf(req), r = loopProposals.vote(loopSignals.whoOf("app"), String(b.proposal || ""), +b.votes); return json(res, r.ok ? 200 : 400, r, o); }
    if (u.pathname === "/api/loop/proposals") return json(res, 200, { proposals: loopProposals.specs(), stubs: loopParts.stubs }, o);
    if (u.pathname === "/api/loop/flags") return json(res, 200, { flags: loopFlags(), stubs: loopParts.stubs }, o);
    if (u.pathname === "/api/loop/decide" && req.method === "POST") { const b = await bodyOf(req), r = loopDecide(String(b.proposal || ""), String(b.decision || ""), String(b.note || "").slice(0, 600)); return json(res, r.error ? r.code : 200, r, o); }
    if (u.pathname === "/api/loop/rollback" && req.method === "POST") {
      const b = await bodyOf(req), key = String(b.key || ""), reason = String(b.reason || "the maintainer rolled it back").slice(0, 300);
      try {
        const flag = await loopParts.flags.rollback(key, reason, { by: "maintainer" });
        for (const sp of loopProposals.specs().filter((x) => x.change?.key === key && ["shipped", "gated"].includes(x.status))) loopProposals.setStatus(sp.id, "rolledBack", [reason], "maintainer");
        return json(res, 200, { flag }, o);
      } catch (e) { return json(res, 400, { error: String(e.message || e) }, o); }
    }
    if (u.pathname === "/api/remind" && req.method === "POST") {
      const b = await bodyOf(req);
      return json(res, 200, { sent: b.kind && b.kind !== "morning" ? await lifeTick({ kind: b.kind, force: true }) : await remind(true) }, o);
    }
    return json(res, 404, { error: "not found" }, o);
  } catch (e) { return json(res, 500, { error: String(e.message || e) }, o); }
}).listen(PORT, process.env.GW_HOST || undefined, () => { // (GW_HOST=127.0.0.1: this machine only, as on a peer gateway's VM)
  console.log(`agent gateway on http://127.0.0.1:${PORT} · LLM ${process.env.LLM_URL || "http://127.0.0.1:11435/v1"} · Messenger ${msn.state.enabled ? "on" : "off (no page token)"} · API ${auth.required() ? "needs its token" : process.env.AGENT_OPEN === "1" ? "OPEN to this network (AGENT_OPEN=1): set AGENT_TOKEN" : "this machine only: set AGENT_TOKEN"}`);
  // after a restart: results not yet sent go out, and talks that were cut off are finished (once the server listens,
  // since the members' agents are reached over A2A on this same server)
  (async () => {
    // an app's booking still in the outbox is made (once: play.book is idempotent), unless its time has passed
    const deliverApp = async (id, r) => { if (r?.book && !asks.passed(r.book)) await play.book({ option: r.book, invites: {}, you: {} }); asks.outbox(id, null); };
    for (const p of asks.pendingOutbox()) await (p.who === "app" ? deliverApp(p.id, p.result) : club.asPlayer(p.who, () => deliverGame(p.who, p.id, p.result))).catch((e) => console.error("outbox", p.id, e.message));
    // a talk from the app that ends in a yes at the time the player said yes to is booked, as it would have been live
    const n = await asks.resumeTalking((who, id, r) => (who !== "app" ? deliverGame(who, id, r) : deliverApp(id, r)));
    if (n) console.log(`resumed ${n} talk${n > 1 ? "s" : ""} cut off by the restart`);
    // the Autopilot: a yes whose games were not all booked yet is booked (play.book gives back a game it already has),
    // then every run a restart cut off goes on from its journal, its messages sent once
    for (const p of autopilot.toBook()) {
      const out = await bookFor(p.messenger, p.options).catch(() => null);
      autopilot.booked(p.id);
      if (p.messenger && out) await msn.direct(p.messenger, `Booked:\n${p.options.filter((x, k) => !out[k]?.error).map((x) => `• ${autopilot.describe(x)}, court ${x.court}`).join("\n")}`).catch(() => {});
    }
    const ap = await autopilot.resumeRuns((start) => (start.messenger ? apMessages(start.messenger) : {}));
    if (ap.length) console.log(`resumed ${ap.length} Autopilot run${ap.length > 1 ? "s" : ""} cut off by the restart`);
  })().catch((e) => console.error("resume", e.message));
});

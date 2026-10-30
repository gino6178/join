// Facebook Messenger: your agent and its helpers in the player's Messenger, through a Facebook Page on the Messenger Platform.
// Messenger calls the gateway's webhook (/webhook/messenger) with each message, signed with the app secret; replies
// go out through the Send API. The conversation itself is pocket.js. Set in .env:
//   MESSENGER_PAGE_TOKEN   the Page access token
//   MESSENGER_APP_SECRET   the Meta app's secret, to check each webhook call's signature
//   MESSENGER_VERIFY_TOKEN any string, entered again when the webhook is set up in the app dashboard
//   MESSENGER_PAGE_NAME    shown in the app (optional)
// The webhook must be reachable over HTTPS from Meta (a tunnel to WEBHOOK_PORT, which serves only the webhook).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createPocket } from "./pocket.js";
import { FILES } from "./files.js";
import { readJSON, writeJSON } from "./jsonfile.js";
import * as signals from "./loop/signals.js";
import { asPlayer } from "./club.js";
import * as safety from "./safety.js";

const TOKEN = process.env.MESSENGER_PAGE_TOKEN, SECRET = process.env.MESSENGER_APP_SECRET, VERIFY = process.env.MESSENGER_VERIFY_TOKEN;
const API = (process.env.MESSENGER_API || "https://graph.facebook.com/v21.0").replace(/\/$/, "");
// files shared to the chat are downloaded only from Facebook's own file servers (MESSENGER_FILE_RX overrides, for tests)
export const state = { enabled: !!TOKEN, page: process.env.MESSENGER_PAGE_NAME || null, error: TOKEN ? null : "MESSENGER_PAGE_TOKEN not set", lastEvent: null };

async function graph(body) {
  if (!TOKEN) throw new Error("Messenger is not set up (no MESSENGER_PAGE_TOKEN)");
  const r = await fetch(`${API}/me/messages?access_token=${encodeURIComponent(TOKEN)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`Send API: ${j.error?.message ?? r.status}`);
  return j;
}
// Messenger caps a message at 2000 characters: longer replies go out in parts, split between paragraphs
function parts(text, max = 1900) {
  const out = [];
  let cur = "";
  for (const para of String(text).split("\n\n")) {
    const add = cur ? `${cur}\n\n${para}` : para;
    if (add.length <= max) { cur = add; continue; }
    if (cur) out.push(cur);
    cur = para;
    while (cur.length > max) { out.push(cur.slice(0, max)); cur = cur.slice(max); }
  }
  if (cur) out.push(cur);
  return out;
}
async function send(id, text, { feedback, tag, buttons } = {}) {
  const chunks = parts(text);
  for (let k = 0; k < chunks.length; k++) {
    const message = { text: chunks[k] };
    if (k === chunks.length - 1 && feedback != null) message.quick_replies = [
      { content_type: "text", title: "👍 Helpful", payload: `fb:${feedback}:1` },
      { content_type: "text", title: "👎 Not helpful", payload: `fb:${feedback}:-1` },
    ];
    // an agent's question with its answers as buttons (the Autopilot asking before it books)
    if (k === chunks.length - 1 && buttons?.length) message.quick_replies = buttons.map((b) => ({ content_type: "text", title: b.title.slice(0, 20), payload: b.payload }));
    // a reply to the player is a RESPONSE; a reminder about a session the player put in their calendar goes out with
    // the event-update tag, which Messenger allows after the 24-hour window
    await graph({ recipient: { id }, messaging_type: tag ? "MESSAGE_TAG" : "RESPONSE", ...(tag ? { tag } : {}), message });
  }
}
const typing = (id) => graph({ recipient: { id }, sender_action: "typing_on" });

// answers to an agent's buttons that the gateway handles itself (payloads "ap:" the Autopilot, "gm:" the Match helper's
// "want a game?", "wx:" the weather watch), the Autopilot and the ask when a player asks for them here, and when the
// player last wrote (the gateway fills these in)
export const hooks = { payload: null, autopilot: null, game: null, seen: null, play: null, feed: null, video: null };
export const pocket = createPocket({ name: "Messenger", send, typing, onAutopilot: (id) => (hooks.autopilot ? hooks.autopilot(id) : Promise.resolve()), onGame: (id) => (hooks.game ? hooks.game(id) : Promise.resolve()),
  // "I want to play" (match/flow.js); without the gateway's hook, the Match helper's usual question
  onPlay: (id, text) => (hooks.play ? hooks.play(id, text) : hooks.game ? hooks.game(id) : Promise.resolve()) });
export const direct = send;
export const REMINDER = { tag: "CONFIRMED_EVENT_UPDATE" };

// GET: Meta checks the webhook once, when it is set up
export function verify(u) {
  const ok = u.searchParams.get("hub.mode") === "subscribe" && VERIFY && u.searchParams.get("hub.verify_token") === VERIFY;
  return ok ? u.searchParams.get("hub.challenge") : null;
}
// POST: every call is signed with the app secret over the raw body
export function signed(raw, header) {
  if (!SECRET || !header?.startsWith("sha256=")) return false;
  const want = Buffer.from(crypto.createHmac("sha256", SECRET).update(raw).digest("hex")), got = Buffer.from(header.slice(7));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
// Messenger can deliver the same event twice (it retries a webhook that was slow to answer): each message id is
// handled once. The ids seen are kept on disk, the latest 2000, so a restart does not handle them again.
const SEEN = path.resolve(process.env.MESSENGER_SEEN_FILE || "data/messenger_seen.json");
let seen = readJSON(SEEN, []);
const seenSet = new Set(seen);
function firstTime(mid) {
  if (!mid) return true;
  if (seenSet.has(mid)) return false;
  seen.push(mid); seenSet.add(mid);
  if (seen.length > 2000) seenSet.delete(seen.shift());
  try { writeJSON(SEEN, seen); } catch { /* kept in memory */ }
  return true;
}
export async function receive(body) {
  if (body.object !== "page") return;
  state.lastEvent = Date.now();
  for (const entry of body.entry || []) for (const ev of entry.messaging || []) {
    const id = String(ev.sender?.id || "");
    if (!id) continue;
    if (!firstTime(ev.message?.mid || ev.postback?.mid)) continue;
    if (!ev.message?.is_echo) hooks.seen?.(id);
    // (every safety check made while this event is handled is this chat's own: safety.js, shown on Messages)
    // (with CLUB_PLAYERS=1, the gateway works for this player as the club member they are: club.js asPlayer)
    await safety.as(id, () => asPlayer(id, () => event(id, ev)));
  }
}
async function event(id, ev) {
  try {
    const fb = /^fb:(\d+):(-?1)$/.exec(ev.message?.quick_reply?.payload || "");
    // (with /improve on, a 👍 or 👎 on an answer is also counted for the community loop, with no words)
    if (fb) { pocket.feedback(id, +fb[1], +fb[2]); signals.record(id, { kind: "thumb", feature: "answers", value: +fb[2] }); await send(id, +fb[2] > 0 ? "Thanks, noted." : "Thanks, noted: I'll do better on that."); return; }
    const qp = ev.message?.quick_reply?.payload || ev.postback?.payload || "";
    if (/^(ap|wx|gm|pc):/.test(qp) && hooks.payload) { await hooks.payload(id, qp); return; }
    if (qp.startsWith("bd:")) { await pocket.bodyAnswer(id, qp); return; }
    if (qp.startsWith("sc:")) { await pocket.scoreAnswer(id, qp); return; }
    // the community loop: Share or Don't for one idea (sh:), a vote for one (qv:)
    if (/^(sh|qv):/.test(qp)) { await pocket.loopAnswer(id, qp); return; }
    // the club feed: Post or Not now for a highlight the member's agent drafted (fd:); a video they shared, made
    // into one (feed/highlights.js)
    if (/^f[dr]:/.test(qp)) { await hooks.feed?.(id, qp); return; } // (fr: a game recap's Post or Not now)
    const vid = (ev.message?.attachments || []).find((a) => a.type === "video" && FILES.test(a.payload?.url || ""));
    if (vid && !ev.message.is_echo && hooks.video) { await hooks.video(id, vid.payload.url); return; }
    // a photo shared to the chat (a scoreboard after a game): only from Facebook's own servers. A sticker (the 👍
    // button sends one) is an image too, with a sticker_id: it is not a photo to read
    const pic = !ev.message?.sticker_id && (ev.message?.attachments || []).find((a) => a.type === "image" && !a.payload?.sticker_id && FILES.test(a.payload?.url || ""));
    if (pic && !ev.message.is_echo) { await pocket.photo(id, pic.payload.url); return; }
    // a voice note: heard on this server, then handled as if it had been typed
    const clip = (ev.message?.attachments || []).find((a) => a.type === "audio" && FILES.test(a.payload?.url || ""));
    if (clip && !ev.message.is_echo) { await pocket.voice(id, clip.payload.url); return; }
    // a file shared to the chat (a health app's export, a GPX): only from Facebook's own file servers
    const att = (ev.message?.attachments || []).find((a) => a.type === "file" && FILES.test(a.payload?.url || ""));
    if (att && !ev.message.is_echo) { await pocket.file(id, att.payload.url, decodeURIComponent(new URL(att.payload.url).pathname.split("/").pop() || "export")); return; }
    if (ev.postback?.payload === "GET_STARTED") { await pocket.handle(id, "there", "/start"); return; }
    if (ev.message?.text && !ev.message.is_echo) await pocket.handle(id, "there", ev.message.text);
    state.error = null;
  } catch (e) { state.error = String(e.message || e); }
}

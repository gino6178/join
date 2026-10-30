// Highlights, posted the way a member would on Instagram, but only with their yes. After a game, when a member has a
// highlight from their own video (a reel the app made with /api/reel, or a video they sent their agent in Messenger),
// their agent drafts a post: the clip and its cover frame, and a caption code writes from the game's facts (the sport,
// the moment, the day, singles or doubles; never anyone's name). The draft waits: in Messenger as "Post this to the
// club?" with Post and Not now, in the app as a draft card. Post puts it in the feed as the member's agent's post,
// approved by them; Not now deletes the draft and its clip. A draft no one answers is deleted after a week.
// Only the member's own footage is posted (the demo's one clip is the CC BY 3.0 one credited in CREDITS.md).
import { Readable } from "node:stream";
import { deps } from "./deps.js";
import * as S from "./store.js";
import * as T from "./text.js";
import { SPORTS } from "./query.js";
import { limited, moderate, view, mediaView } from "./posts.js";
import * as M from "./media.js";

const DAY = 864e5, DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MOMENTS = ["smash", "shot", "jump shot", "spike", "kick", "serve", "rally", "save", "best moment"];
// Messenger's side, set by the gateway: send(psid, text, { buttons })
let messenger = null;
export const useMessenger = (send) => { messenger = send; };

// the facts a caption may use, checked: anything else is left out
export function factsOf(g = {}) {
  const sport = SPORTS.includes(String(g.sport || "").toLowerCase()) ? String(g.sport).toLowerCase() : null;
  const moment = MOMENTS.includes(String(g.moment || "").toLowerCase()) ? String(g.moment).toLowerCase() : null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(g.date || "")) ? g.date : null;
  const format = ["singles", "doubles"].includes(g.format) ? g.format : null;
  return { sport, moment, date, format };
}
// the caption, written by code from the facts
export function caption(f) {
  const day = f.date ? DAYS[new Date(`${f.date}T12:00:00`).getDay()] : null;
  const game = f.format ? `${f.format}` : f.sport ? `${f.sport} game` : "game";
  const what = f.moment && f.moment !== "best moment" ? `My ${f.moment}` : "My best moment";
  const tags = [f.sport && `#${f.sport.replace(/ /g, "")}`, "#ServeApp"].filter(Boolean).join(" ");
  return `${what} from ${day ? `${day}'s ` : "my last "}${game}. ${tags}`;
}

// a draft from a member's clip: { draft } and, for a member on Messenger, the question sent there
export async function draft(player, { bytes, type, game = {}, from = null, seconds = null, cover = null, via = "app" }) {
  const lim = limited(player, "draft"); if (lim) return lim;
  const kind = M.sniff(bytes);
  if (!["video/mp4", "video/webm"].includes(kind) || (type && !String(type).startsWith(kind.split("/")[0]))) return { error: "A highlight is an MP4 or WebM clip.", code: 400 };
  if (bytes.length > M.LIMITS.clip) return { error: `The clip is over ${M.LIMITS.clip / 1e6} MB. Trim it to the moment.`, code: 413 };
  let made;
  if (await M.ffmpegReady()) {
    try { made = await M.clip(bytes, { from, seconds, cover }); } catch (e) { return { error: `The clip could not be read (${String(e.message).slice(0, 80)}).`, code: 400 }; }
  } else made = { bytes, type: kind, poster: null, w: null, h: null }; // (a clip the app recorded from its canvas carries no place or device)
  const media = S.putMedia(made.bytes, made.type);
  const poster = made.poster ? S.putMedia(made.poster, "image/jpeg") : null;
  const facts = factsOf(game);
  const d = S.change((db) => {
    (db.rate[player] ||= {}).draft = [...(db.rate[player].draft || []), deps.now()].slice(-50);
    const x = { id: S.newId("d"), player, at: deps.now(), via, media: { ...media, w: made.w, h: made.h, ...(poster ? { poster } : {}) }, game: facts, caption: caption(facts), by: "code" };
    db.drafts.push(x);
    return x;
  });
  if (messenger && via === "messenger") await offer(player, d).catch(() => {});
  return { draft: draftView(d) };
}
export const QUESTION = (d) => `Your agent made a post from your highlight:\n“${d.caption}”\n\nPost this to the club? Only the club's members see it.`;
export const BUTTONS = (d) => [{ title: "Post", payload: `fd:${d.id}:post` }, { title: "Not now", payload: `fd:${d.id}:no` }];
async function offer(player, d) { await messenger(player, QUESTION(d), { buttons: BUTTONS(d) }); }

export const draftView = (d) => ({ id: d.id, at: d.at, caption: d.caption, game: d.game, media: mediaView(d.media) });
export const drafts = (player) => S.data().drafts.filter((d) => d.player === player).sort((a, b) => b.at - a.at).map(draftView);

// the member's answer: Post (with the caption as it stands, or as they edited it in the app) or Not now
export async function approve(player, id, yes, { caption: edited = null } = {}) {
  const d = S.data().drafts.find((x) => x.id === id);
  if (!d || d.player !== player) return { error: "That draft is not there any more.", code: 404 };
  if (!yes) { S.change((db) => { S.dropMedia(d.media); db.drafts = db.drafts.filter((x) => x !== d); }); return { declined: true }; }
  let text = d.caption, checks = { caption: "code" };
  if (edited != null && T.tidy(edited, 300) !== d.caption) {
    // a caption the member wrote is a person's text: checked like any post
    text = T.tidy(edited, 300);
    const m = await moderate(text, player);
    if (!m.ok) return { refused: true, why: m.down ? "The safety check isn't answering right now. Try posting again in a minute." : m.why, keep: true };
    checks = { caption: "member", llamaGuard: m.verdict };
  }
  const p = S.change((db) => {
    const x = { id: S.newId("p"), kind: "highlight", at: deps.now(), by: { type: "agent", agentOf: player }, approved: { by: player, at: deps.now() }, text, media: d.media, game: d.game, likes: [], comments: [], reports: [], checks };
    db.posts.push(x);
    db.drafts = db.drafts.filter((y) => y !== d);
    return x;
  });
  return { post: view(p, player) };
}
// Messenger's buttons (fd:<draft>:post|no)
export async function answerInMessenger(psid, payload, send) {
  const m = /^fd:(d[a-z0-9]+):(post|no)$/.exec(payload);
  if (!m) return;
  const r = await approve(psid, m[1], m[2] === "post");
  if (r.error) return send(psid, "That draft has gone, so nothing was posted.");
  if (r.declined) return send(psid, "OK, not posted. I deleted the draft and its clip.");
  return send(psid, "Posted to the club feed. Send /forget at any time to delete your posts.");
}
// drafts nobody answered, deleted after a week
export function expire() {
  const old = S.data().drafts.filter((d) => deps.now() - d.at > 7 * DAY);
  if (old.length) S.change((db) => { old.forEach((d) => S.dropMedia(d.media)); db.drafts = db.drafts.filter((d) => !old.includes(d)); });
  return old.length;
}

// A video of the member's own game, from the post composer or sent to their agent in Messenger: checked (a video, 100 MB
// and 90 seconds at most), their best moment found on this server (reel.js: DETR, Sapiens2, SAM 2.1 on the GPU the
// reel already uses, at the lowest CPU priority, and only when the GPU has REEL_MIN_FREE_MB free), four seconds
// around it cut by ffmpeg, then the draft, which waits for their yes. onStep hears each step as it happens.
// { draft } or { error, code }
const MOMENT = { smash: "smash", shot: "shot", "jump shot": "jump shot", spike: "spike", kick: "kick" };
export async function fromVideo(player, bytes, { sport = "badminton", onStep = () => {}, via = "app" } = {}) {
  const lim = limited(player, "draft"); if (lim) return lim;
  if (!bytes?.length) return { error: "Pick a video of your game.", code: 400 };
  if (bytes.length > M.LIMITS.upload) return { error: `The video is over ${M.LIMITS.upload / 1e6} MB. Trim it to the rally.`, code: 413 };
  if (!["video/mp4", "video/webm"].includes(M.sniff(bytes))) return { error: "That is not a video this server can read (MP4, MOV or WebM).", code: 415 };
  const reel = await deps.reel();
  if (!reel.ready() || !(await M.ffmpegReady())) return { error: "Making highlights from a video is not set up on this server.", code: 503 };
  const secs = await M.duration(bytes);
  if (secs == null) return { error: "That video could not be read.", code: 400 };
  if (secs > M.LIMITS.uploadSeconds) return { error: `The video is ${Math.round(secs)} seconds long. Trim it to ${M.LIMITS.uploadSeconds} seconds or less, around the rally.`, code: 413 };
  const free = await M.gpuFree();
  if (free != null && free < +(process.env.REEL_MIN_FREE_MB || 6000)) return { error: "The server's GPU is busy right now. Try again in a few minutes.", code: 503 };
  sport = SPORTS.includes(String(sport).toLowerCase()) ? String(sport).toLowerCase() : "badminton";
  let r;
  try { r = await reel.make(Readable.from([bytes]), (e) => onStep(e), sport); } catch (e) { return { error: `No moment could be found in that video (${String(e.message).slice(0, 140)})`, code: 422 }; }
  onStep({ type: "working", step: "Cutting four seconds around your moment" });
  const at = Number.isFinite(r.smash) ? r.smash : null;
  const out = await draft(player, { bytes, type: M.sniff(bytes), from: at != null ? Math.max(0, at - 2.5) : null, seconds: 4, cover: at != null ? Math.min(2.5, at) : 0.5, via,
    game: { sport: r.sport || sport, moment: MOMENT[r.kind] || "smash", date: new Date(deps.now()).toISOString().slice(0, 10) } });
  if (out.draft) onStep({ type: "step", step: "Your agent drafted the post", tool: "draft", detail: out.draft.caption });
  return out;
}
// A video the member sent their agent in Messenger: the same, then "Post this to the club?" there
export async function fromMessenger(psid, url, { fetchFile, send, sport = "badminton" }) {
  const reel = await deps.reel();
  if (!reel.ready() || !(await M.ffmpegReady())) return send(psid, "I can't make highlights from a video on this server yet. Open the app's highlight page to make one.");
  if (limited(psid, "draft")) return send(psid, "That's enough highlights for today. Send another tomorrow.");
  let bytes;
  try { bytes = await fetchFile(url, M.LIMITS.upload); } catch (e) { return send(psid, `I couldn't open that video (${e.message}).`); }
  await send(psid, "Got your video. Finding your best moment on your own server…");
  const out = await fromVideo(psid, bytes, { sport, via: "messenger" });
  if (out.error) return send(psid, out.error);
}

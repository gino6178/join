// The club feed's routes on the gateway (server.js hands it every /api/feed path), behind the gateway's token like the
// rest of the API; the reading agent's manual run takes the maintainer's token instead (MAINTAINER_TOKEN).
//   GET  /api/feed?player=&before=&n=          the feed as that member sees it, their drafts and any notices
//   GET  /api/feed/post?id=&player=             one post (the app asks again while a member's agent is answering)
//   GET  /api/feed/media?id=&player=            a photo, clip or cover frame (a draft's only to its member)
//   POST /api/feed/media?player=                a photo (JPEG, 6 MB at most), kept an hour until it is posted
//   POST /api/feed/post     {player, text, media}
//   POST /api/feed/comment  {player, post, text}
//   POST /api/feed/like     {player, post, on}
//   POST /api/feed/notforme {player, post}
//   POST /api/feed/report   {player, post, comment, reason}
//   POST /api/feed/delete   {player, post, comment}
//   POST /api/feed/draft?player=&sport=&moment=&date=&format=   a highlight clip (MP4 or WebM): the agent's draft
//   POST /api/feed/approve  {player, draft, yes, caption}
//   POST /api/feed/reel?player=&sport=          a video of the member's own game (100 MB, 90 s at most): the reel
//                                               pipeline's steps stream back as NDJSON, then the highlight draft
//   POST /api/feed/recap    {player, recap, yes} a player's answer to a game recap their agent drafted
//   POST /api/feed/recaps/check?force=1         a test hook: draft the recaps of booked games now
//   GET  /api/feed/papers                       the reading agent's runs and this week's numbers
// The maintainer's routes (MAINTAINER_TOKEN; server.js lists them):
//   POST /api/feed/papers/run {n}               the reading agent, now
//   GET  /api/feed/reports?all=1                the queue of reported posts and comments
//   POST /api/feed/moderate {post, comment, action: hide|restore|dismiss|limit|unlimit, reason, days}
//   GET  /api/feed/audit?n=                     every moderation action, newest first
// player is a Messenger id or "app" (the club's web app), as in the other routes.
import fs from "node:fs";
import * as S from "./store.js";
import * as P from "./posts.js";
import * as H from "./highlights.js";
import * as R from "./recaps.js";
import * as MOD from "./moderation.js";
import * as papers from "./papers.js";
import * as M from "./media.js";
import { deps } from "./deps.js";

const PLAYER = /^[\w:.-]{1,64}$/;
const readRaw = (req, max) => new Promise((ok) => { const parts = []; let n = 0, over = false; req.on("data", (c) => { n += c.length; if (n > max) over = true; else parts.push(c); }); req.on("end", () => ok(over ? null : Buffer.concat(parts))); req.on("error", () => ok(null)); });
const readJson = async (req) => { const b = await readRaw(req, 64e3); try { return b ? JSON.parse(b.toString("utf8") || "{}") : null; } catch { return {}; } };

export async function handle(req, res, u, { cors = {}, maintainer = false } = {}) {
  const send = (code, body) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", ...cors }); res.end(JSON.stringify(body)); };
  const p = u.pathname, post = req.method === "POST", q = (k) => u.searchParams.get(k);
  try {
    const body = post && !["/api/feed/media", "/api/feed/draft", "/api/feed/reel"].includes(p) ? await readJson(req) : {};
    if (body == null) return send(413, { error: "That is too long." });
    const player = String(body.player || q("player") || "app");
    if (!PLAYER.test(player)) return send(400, { error: "player is a member's id" });
    const out = (r) => send(r?.code || (r?.error ? 400 : 200), r);

    if (p === "/api/feed" && !post) {
      const f = P.feed(player, { before: +(q("before") || Infinity) || Infinity, n: +(q("n") || 30) });
      const club = deps.club(), w = papers.weekCap();
      return send(200, { ...f, drafts: H.drafts(player), recaps: R.pendingFor(player), paused: P.paused(player), club: { name: club.name || "Your club" }, papers: { perWeek: papers.perWeekFor(player), club: w.club }, simulated: S.data().posts.some((x) => x.simulated) });
    }
    if (p === "/api/feed/post" && !post) { const x = P.find(String(q("id") || "")); return x && !(x.held && x.by.player !== player) ? send(200, { post: P.view(x, player) }) : send(404, { error: "That post is not in the feed any more." }); }
    if (p === "/api/feed/media" && !post) return media(res, String(q("id") || ""), player, cors, send);
    if (p === "/api/feed/media" && post) {
      const lim = P.limited(player, "upload"); if (lim) return out(lim);
      const b = await readRaw(req, M.LIMITS.photo);
      if (!b) return send(413, { error: `The photo is over ${M.LIMITS.photo / 1e6} MB.` });
      const kind = M.sniff(b);
      if (kind !== "image/jpeg") return send(415, { error: kind?.startsWith("image/") ? "Send the photo as a JPEG." : "That is not a photo." });
      const c = M.cleanJpeg(b);
      if (!c) return send(400, { error: "That photo could not be read." });
      const m = S.putMedia(c.bytes, "image/jpeg");
      P.upload(player, { ...m, w: c.w, h: c.h });
      S.change((d) => { const r = (d.rate[player] ||= {}); r.upload = [...(r.upload || []), deps.now()].slice(-50); });
      return send(200, { media: { id: m.id, w: c.w, h: c.h } });
    }
    if (p === "/api/feed/post" && post) return out(await P.post(player, { text: body.text, media: body.media || null }));
    if (p === "/api/feed/comment" && post) return out(await P.comment(player, String(body.post || ""), body.text));
    if (p === "/api/feed/like" && post) return out(P.like(player, String(body.post || ""), body.on !== false));
    if (p === "/api/feed/notforme" && post) return out(P.notForMe(player, String(body.post || "")));
    if (p === "/api/feed/report" && post) return out(P.report(player, String(body.post || ""), { comment: body.comment || null, reason: String(body.reason || "other") }));
    if (p === "/api/feed/delete" && post) return out(P.remove(player, String(body.post || ""), body.comment || null));
    if (p === "/api/feed/draft" && post) {
      const b = await readRaw(req, M.LIMITS.clip);
      if (!b) return send(413, { error: `The clip is over ${M.LIMITS.clip / 1e6} MB. Trim it to the moment.` });
      return out(await H.draft(player, { bytes: b, type: req.headers["content-type"], game: { sport: q("sport"), moment: q("moment"), date: q("date"), format: q("format") }, via: q("via") === "messenger" ? "messenger" : "app" }));
    }
    if (p === "/api/feed/approve" && post) return out(await H.approve(player, String(body.draft || ""), body.yes === true, { caption: typeof body.caption === "string" ? body.caption : null }));
    if (p === "/api/feed/reel" && post) {
      const b = await readRaw(req, M.LIMITS.upload);
      if (!b) return send(413, { error: `The video is over ${M.LIMITS.upload / 1e6} MB. Trim it to the rally.` });
      res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store", ...cors });
      const line = (x) => res.write(JSON.stringify(x) + "\n");
      line({ type: "step", step: "Received your video", tool: "upload", detail: `${(b.length / 1e6).toFixed(1)} MB, on your own server only` });
      const r = await H.fromVideo(player, b, { sport: q("sport") || "badminton", onStep: line, via: "app" }).catch((e) => ({ error: String(e.message || e) }));
      line(r.error ? { type: "error", error: r.error, code: r.code || 500 } : { type: "done", result: r });
      return res.end();
    }
    if (p === "/api/feed/recap" && post) return out(await R.answer(player, String(body.recap || ""), body.yes === true));
    if (p === "/api/feed/recaps/check" && post) return send(200, await R.tick({ force: q("force") === "1" }));
    // the maintainer's own: the queue of reports, an action on one item, the log of actions
    if (["/api/feed/reports", "/api/feed/reports/media", "/api/feed/moderate", "/api/feed/audit"].includes(p)) {
      if (!maintainer) return send(401, { error: "this route needs the maintainer's token: Authorization: Bearer <MAINTAINER_TOKEN>" });
      if (p === "/api/feed/reports/media") {
        // a reported post's photo, clip or cover, hidden or not, for the maintainer to look at
        const id = String(q("id") || ""), x = S.data().posts.find((y) => y.media && (y.media.id === id || y.media.poster?.id === id) && (y.reports?.length || y.hidden));
        const file = x && (x.media.id === id ? S.mediaFile(id, x.media.type) : S.mediaFile(id, "image/jpeg"));
        if (!file) return send(404, { error: "no such file" });
        res.writeHead(200, { "content-type": x.media.id === id ? x.media.type : "image/jpeg", "cache-control": "no-store", "x-content-type-options": "nosniff", ...cors });
        return fs.createReadStream(file).pipe(res);
      }
      if (p === "/api/feed/reports" && !post) return send(200, { items: MOD.reportQueue({ all: q("all") === "1" }), reasons: P.REASONS, actions: MOD.ACTIONS });
      if (p === "/api/feed/moderate" && post) return out(MOD.act({ post: body.post, comment: body.comment || null, action: String(body.action || ""), reason: body.reason, days: body.days }));
      if (p === "/api/feed/audit" && !post) return send(200, { entries: MOD.auditLog({ n: +(q("n") || 100) }) });
    }
    if (p === "/api/feed/papers" && !post) {
      const runs = (S.data().papers.runs || []).slice(-10).reverse(), w = papers.weekCap();
      return send(200, { runs, perWeek: w.club, cap: w.cap, week: papers.weekOf(deps.now()).week, scheduled: process.env.FEED_PAPERS === "1" });
    }
    if (p === "/api/feed/papers/run" && post) {
      if (!maintainer) return send(401, { error: "this route needs the maintainer's token: Authorization: Bearer <MAINTAINER_TOKEN>" });
      return send(200, await papers.run({ manual: true, n: Math.max(1, Math.min(7, +body.n || 1)) }));
    }
    return send(404, { error: "not found" });
  } catch (e) { return send(500, { error: String(e.message || e).slice(0, 200) }); }
}

// a file of the feed: one in a post anyone in the feed can see, or one of the member's own drafts or uploads
function media(res, id, player, cors, send) {
  const d = S.data(), of = (m) => m && (m.id === id || m.poster?.id === id);
  const inPost = d.posts.find((x) => of(x.media) && !((x.held || x.hidden) && x.by.player !== player && x.by.agentOf !== player));
  const own = d.drafts.find((x) => x.player === player && of(x.media)) || d.uploads.find((x) => x.player === player && x.id === id);
  const m = inPost?.media || own?.media || own;
  if (!m) return send(404, { error: "no such file" });
  const [file, type] = m.id === id ? [S.mediaFile(m.id, m.type), m.type] : [S.mediaFile(m.poster.id, "image/jpeg"), "image/jpeg"];
  if (!file) return send(404, { error: "no such file" });
  res.writeHead(200, { "content-type": type, "content-length": fs.statSync(file).size, "cache-control": "private, max-age=86400", "x-content-type-options": "nosniff", ...cors });
  fs.createReadStream(file).pipe(res);
}

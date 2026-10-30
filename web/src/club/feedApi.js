// The club feed's routes on the gateway (agent/src/feed/api.js), with the gateway's token like every other call. The
// app is one member, "app", the same as in the other routes. Photos are made into JPEGs in this browser before they
// leave it (which also drops what a phone writes into them, such as where they were taken); the server checks again.
import { AGENT_URL, agentFetch } from "../agent.js";

// an error the feed can explain: offline (no answer), missing (no feed routes on this gateway), auth, limit (rate
// limit), refused (a check stopped it, with the reason), or the server's own message
export class FeedError extends Error {
  constructor(kind, message, extra = {}) { super(message); this.kind = kind; Object.assign(this, extra); }
}
async function call(path, body) {
  let r;
  try {
    r = await agentFetch(path, body instanceof Blob ? { method: "POST", headers: { "content-type": body.type || "application/octet-stream" }, body }
      : body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  } catch { throw new FeedError("offline", "Your server did not answer."); }
  const j = await r.json().catch(() => null);
  if (r.status === 404 && !j?.error) throw new FeedError("missing", "This server does not have the club feed yet.");
  if (r.status === 401 || r.status === 403) throw new FeedError("auth", j?.error || "The gateway refused the token.");
  if (r.status === 429) throw new FeedError("limit", j?.error || "That's the limit for now. Try again later.");
  if (!r.ok) throw new FeedError("server", j?.error || `The gateway answered ${r.status}.`);
  if (j == null) throw new FeedError("server", "Your server's answer was not the club feed.");
  if (j.refused) throw new FeedError("refused", j.why || "Not posted.", { helpline: !!j.helpline });
  return j;
}

export const feedApi = {
  list: (before = null) => call(`/api/feed?n=30${before ? `&before=${before}` : ""}`),
  one: (id) => call(`/api/feed/post?id=${encodeURIComponent(id)}`),
  post: (text, media = null) => call("/api/feed/post", { text, media }),
  like: (post, on) => call("/api/feed/like", { post, on }),
  comment: (post, text) => call("/api/feed/comment", { post, text }),
  report: (post, reason, comment = null) => call("/api/feed/report", { post, reason, comment }),
  notForMe: (post) => call("/api/feed/notforme", { post }),
  remove: (post, comment = null) => call("/api/feed/delete", { post, comment }),
  approve: (draft, yes, caption = null) => call("/api/feed/approve", { draft, yes, ...(caption != null ? { caption } : {}) }),
  async photo(file) { return call("/api/feed/media", await toJpeg(file)); },
  recap: (recap, yes) => call("/api/feed/recap", { recap, yes }),
  // a video of the member's own game, through the reel pipeline on the server: onStep hears each step, the promise
  // gives the agent's draft
  async reel(file, sport, onStep) {
    let r;
    try { r = await agentFetch(`/api/feed/reel?sport=${encodeURIComponent(sport || "badminton")}`, { method: "POST", headers: { "content-type": file.type || "video/mp4" }, body: file }); }
    catch { throw new FeedError("offline", "Your server did not answer."); }
    if (!r.ok || !r.body) { const j = await r.json().catch(() => null); throw new FeedError(r.status === 413 ? "limit" : "server", j?.error || `The gateway answered ${r.status}.`); }
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
        if (e.type === "done") { if (e.result?.error) throw new FeedError("refused", e.result.error); return e.result; }
        if (e.type === "error") throw new FeedError(e.code === 503 ? "busy" : "refused", e.error);
        onStep?.(e);
      }
    }
    throw new FeedError("server", "The server stopped before the highlight was ready.");
  },
  // a highlight clip (the reel made from the member's own video): the agent's draft, waiting for their yes
  draft: (blob, game = {}) => call(`/api/feed/draft?${new URLSearchParams(Object.entries(game).filter(([, v]) => v != null && v !== "")).toString()}`, blob),
};

// The maintainer's side (#/maintain, Reports): with the maintainer's token, typed into that page and kept in its tab
async function asMaintainer(token, path, body) {
  let r;
  try { r = await fetch(AGENT_URL + path, body ? { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) } : { headers: { authorization: `Bearer ${token}` } }); }
  catch { throw new FeedError("offline", "Your server did not answer."); }
  const j = await r.json().catch(() => null);
  if (r.status === 401 || r.status === 403) throw new FeedError("auth", j?.error || "The gateway refused the maintainer's token.");
  if (r.status === 404 && !j?.error) throw new FeedError("missing", "This server does not have the club feed's reports yet.");
  if (!r.ok) throw new FeedError("server", j?.error || `The gateway answered ${r.status}.`);
  return j;
}
export const reportsApi = {
  queue: (token, all = false) => asMaintainer(token, `/api/feed/reports${all ? "?all=1" : ""}`),
  act: (token, body) => asMaintainer(token, "/api/feed/moderate", body),
  audit: (token) => asMaintainer(token, "/api/feed/audit?n=50"),
  media: (token, id) => fetch(`${AGENT_URL}/api/feed/reports/media?id=${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${token}` } }).then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`media ${r.status}`)))).then((b) => URL.createObjectURL(b)),
};

// a photo as the feed takes it: a JPEG at most 1600 px on its long side, drawn again so nothing but the pixels is kept
export async function toJpeg(file, max = 1600) {
  if (!file?.type?.startsWith("image/")) throw new FeedError("refused", "That is not a photo.");
  const bmp = await createImageBitmap(file).catch(() => { throw new FeedError("refused", "That photo could not be opened."); });
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height)), c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return new Promise((ok, no) => c.toBlob((b) => (b ? ok(b) : no(new FeedError("refused", "That photo could not be made smaller."))), "image/jpeg", 0.86));
}

// a photo or clip of the feed, fetched with the token and kept as a blob URL for this visit
const blobs = new Map();
export function mediaUrl(id) {
  if (!blobs.has(id)) blobs.set(id, agentFetch(`/api/feed/media?id=${encodeURIComponent(id)}`).then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`media ${r.status}`)))).then((b) => URL.createObjectURL(b)).catch((e) => { blobs.delete(id); throw e; }));
  return blobs.get(id);
}

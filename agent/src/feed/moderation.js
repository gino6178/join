// The maintainer's side of the club feed (behind MAINTAINER_TOKEN, api.js): the queue of reported posts and comments,
// what can be done about one, and the audit log of every action.
//   The queue: every post and comment with an open report or a hide, worst first. It shows what the item says, who
//   wrote it, each reason and how many members gave it, the checks it passed (Llama Guard's verdict, the club's
//   standard, the photo screen), and whether its author is paused. The reporters stay unnamed.
//   The actions: hide; restore; dismiss (reviewed, nothing to do; shown again if reports had hidden it); limit the author
//   (their posts and comments paused for 1 to 30 days, posts.paused); and unlimit.
//   The log: who did what to which item, about whom, why, and when. /forget takes the member's id out of it.
import { deps } from "./deps.js";
import * as S from "./store.js";
import * as T from "./text.js";
import { find, mediaView, authorOf, paused } from "./posts.js";

const authorId = (x) => x.by?.player || x.by?.agentOf || (x.by?.agent === "club" ? "club" : null);
const nameOf = (x, who) => (who === "club" ? "The club's reading agent" : x.by?.type === "agent" ? `${authorOf(who) || "A member"}'s agent` : authorOf(who) || "A member");

export function reportQueue({ all = false } = {}) {
  const items = [];
  for (const p of S.data().posts) {
    for (const x of [p, ...p.comments]) {
      const reps = x.reports || [], last = reps.reduce((a, r) => Math.max(a, r.at), 0), comment = x !== p;
      const open = reps.length > 0 && !(x.dismissed && x.dismissed >= last);
      if (!open && !x.hidden && !(all && reps.length)) continue;
      const who = authorId(x);
      items.push({
        post: p.id, comment: comment ? x.id : null, kind: comment ? "comment" : p.kind, at: x.at, text: String(x.text || "").slice(0, 500),
        ...(!comment && p.media ? { media: mediaView(p.media) } : {}),
        ...(!comment && p.paper ? { paper: { title: p.paper.title, link: p.paper.link } } : {}),
        ...(comment ? { on: String(p.text || p.paper?.title || "").slice(0, 120) } : {}),
        author: { id: who, type: x.by?.type, name: nameOf(x, who) },
        reports: reps.length, reporters: new Set(reps.map((r) => r.player)).size,
        reasons: reps.reduce((a, r) => ({ ...a, [r.reason]: (a[r.reason] || 0) + 1 }), {}), lastReport: last || null,
        hidden: x.hidden ? { at: x.hidden.at, why: x.hidden.why, by: x.hidden.by || "reports" } : null, open, dismissed: x.dismissed || null,
        checks: x.checks || null, ...(x.simulated || p.simulated ? { simulated: true } : {}), paused: who && who !== "club" ? paused(who) : null,
      });
    }
  }
  return items.sort((a, b) => b.open - a.open || (b.hidden ? 1 : 0) - (a.hidden ? 1 : 0) || b.reporters - a.reporters || (b.lastReport || 0) - (a.lastReport || 0));
}

export const ACTIONS = ["hide", "restore", "dismiss", "limit", "unlimit"];
export function act({ post, comment = null, action, reason = "", days = 7 } = {}, { by = "maintainer" } = {}) {
  if (!ACTIONS.includes(action)) return { error: `an action is one of ${ACTIONS.join(", ")}`, code: 400 };
  const p = find(String(post || "")), x = p && (comment ? p.comments.find((c) => c.id === comment) : p);
  if (!x) return { error: "That post or comment is not there any more.", code: 404 };
  const why = T.tidy(reason, 300), now = deps.now(), who = authorId(x);
  if ((action === "limit" || action === "unlimit") && (!who || who === "club")) return { error: "Only a member can be limited.", code: 400 };
  const days0 = Math.max(1, Math.min(30, Math.floor(+days || 7)));
  S.change((d) => {
    if (action === "hide") x.hidden = { at: now, why: why || "hidden by the maintainer", by };
    if (action === "restore") { delete x.hidden; x.dismissed = now; }
    if (action === "dismiss") { x.dismissed = now; if (x.hidden && x.hidden.by !== by) delete x.hidden; }
    if (action === "limit") (d.limits ||= {})[who] = { until: now + days0 * 864e5, reason: why || null, at: now };
    if (action === "unlimit" && d.limits) delete d.limits[who];
    (d.audit ||= []).push({ id: S.newId("a"), at: now, by, action, post: p.id, comment: comment || null, author: who, authorName: who === "club" ? "The club's reading agent" : authorOf(who) || null,
      reason: why || null, ...(action === "limit" ? { days: days0 } : {}), reports: (x.reports || []).length });
    d.audit = d.audit.slice(-2000);
  });
  return { ok: true, item: reportQueue({ all: true }).find((i) => i.post === p.id && i.comment === (comment || null)) || null, entry: S.data().audit.at(-1) };
}
export const auditLog = ({ n = 100 } = {}) => (S.data().audit || []).slice(-Math.max(1, Math.min(500, n))).reverse();

// The club feed, made by agents and people together (docs/club_feed.md):
//   the club's reading agent posts recent sports-science papers with a plain summary (papers.js);
//   a member's agent drafts a highlight from their own video and posts it only with their yes (highlights.js);
//   a game recap from a booking goes up only when every player in it says yes (recaps.js);
//   people post, comment, like, share and report, past code's checks, Llama Guard and, for photos, a model's look
//   (posts.js); the maintainer works through the reports (moderation.js).
// Everything is kept on this server (store.js). The gateway calls start() once, routes /api/feed/* to handle(), sends
// Messenger's fd: and fr: buttons to answerInMessenger(), and /forget calls forget().
import * as P from "./posts.js";
import * as H from "./highlights.js";
import * as R from "./recaps.js";
import * as papers from "./papers.js";
import { seed } from "./seed.js";

export { handle } from "./api.js";
export { fromMessenger } from "./highlights.js";

let timers = [];
// send(psid, text, { buttons }): how the agent asks a Messenger member "Post this to the club?"
export function start({ send = null } = {}) {
  seed();
  if (send) { H.useMessenger(send); R.useMessenger(send); }
  timers.forEach(clearInterval);
  timers = [
    setInterval(() => { P.retryHeld().catch(() => {}); }, 2 * 6e4), // what waited for a check, checked again
    setInterval(() => { H.expire(); }, 60 * 6e4), // drafts nobody answered, after a week
    setInterval(() => { papers.tick().catch(() => {}); }, 10 * 6e4), // the reading agent, with FEED_PAPERS=1
    setInterval(() => { if (process.env.FEED_RECAPS !== "off") R.tick().catch(() => {}); }, 10 * 6e4), // recaps of booked games that ended
  ];
  timers.forEach((t) => t.unref?.());
}
// Messenger's buttons: fd: a highlight draft, fr: a game recap
export function answerInMessenger(psid, payload, send) {
  if (payload.startsWith("fr:")) return R.answerInMessenger(psid, payload, send);
  return H.answerInMessenger(psid, payload, send);
}
// /forget: the member's posts, comments, likes, reports, drafts and recaps, with their photos and clips
export function forget(player) { const recaps = R.forget(player); return { ...P.forget(player), recaps }; }
export const heldFor = (player) => P.heldFor(player);

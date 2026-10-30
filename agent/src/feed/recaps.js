// Game recaps from bookings. After a booked game has been played (its end time passed, not cancelled), the booking
// player's agent drafts one line from the booking's facts, written by code ("Leo and Hana played doubles on Thursday at
// Riverside Sports Centre"), and asks every player in it.
//   The rule: it is posted only when every player in it has said yes. One no, or no answer from someone within
//   FEED_RECAP_HOURS (48), and it is never posted; the draft is deleted. Nobody is left out quietly: a recap that names
//   fewer people than played is not one.
//   Who is asked, and how: a player on this server through their own agent: in Messenger with Post and Not now
//   (fr:<id>:yes|no), in the app with a draft card. A demo member's agent answers by itself, from that member's own
//   sharing setting in the club's data (shares.highlights: whether they share their games with the club).
//   /forget: a draft or a posted recap with the member in it is deleted.
import { deps } from "./deps.js";
import * as S from "./store.js";
import { view } from "./posts.js";
import { lineFor } from "./line.js";

const HOURS = () => +(process.env.FEED_RECAP_HOURS || 48);
let messenger = null;
export const useMessenger = (send) => { messenger = send; };

const endOf = (o) => new Date(`${o.date}T${o.end || o.start || "23:59"}:00`).getTime() + (o.end ? 0 : (o.minutes || 90) * 6e4);
// who played: the booking player and everyone who said yes to the invite (a replacement included), or, on a public
// court, the partners the agents agreed it with
function playersOf(b) {
  const club = deps.club(), name = (id) => club.members?.find((m) => m.id === id)?.name || id;
  const ins = b.public ? (b.option.partners || []).map((p) => p.id) : (b.invites || []).filter((i) => i.accept && (i.answered || deps.now() >= (i.answerAt || 0))).map((i) => i.id);
  return [...new Set(ins)].map((id) => ({ id, name: name(id), member: true }));
}
// whose booked game it is: a Messenger player whose calendar has it, or the app
function ownerOf(b) {
  const o = b.option, with_ = new Set((o.partners || []).map((p) => p.id));
  const p = deps.players().find((x) => (x.events || []).some((e) => e.kind === "match" && e.date === o.date && e.start === o.start && (e.with || []).every((w) => with_.has(w))));
  return p ? p.id : "app";
}
// the booked games that have ended in the last 3 days (force: every confirmed game of the next and last week, a test hook)
export async function tick({ force = false } = {}) {
  const now = deps.now(), db = S.data(), made = [];
  for (const b of deps.bookings()) {
    const o = b.option || {};
    if (b.cancelled || !o.date || (db.recaps || []).some((r) => r.booking === b.id)) continue;
    const end = endOf(o);
    if (!force && (end > now || now - end > 3 * 864e5)) continue;
    if (force && Math.abs(end - now) > 7 * 864e5) continue;
    const members = playersOf(b);
    if (!members.length) continue;
    const owner = ownerOf(b);
    const club = deps.club();
    // each demo member's agent answers by itself, from the member's sharing setting
    const players = [{ id: owner, member: false, answer: null }, ...members.map((m) => {
      const shares = club.members?.find((x) => x.id === m.id)?.shares || {};
      return { ...m, answer: shares.highlights === true ? "yes" : "no", by: "their agent, from their sharing setting", at: now };
    })];
    const r = S.change((d) => {
      const x = { id: S.newId("r"), booking: b.id, owner, at: now, deadline: now + HOURS() * 36e5, status: "asking", players,
        game: { date: o.date, start: o.start, sport: o.sport || "badminton", format: o.format || null, venue: o.venue?.name || "the club", minutes: o.minutes || null } };
      (d.recaps ||= []).push(x);
      return x;
    });
    made.push(r.id);
    await settle(r.id);
    const cur = (S.data().recaps || []).find((x) => x.id === r.id);
    if (cur?.status === "asking" && messenger && deps.linked(owner)) await ask(owner, cur).catch(() => {});
  }
  // a deadline passed: never posted
  const late = (S.data().recaps || []).filter((r) => r.status === "asking" && now > r.deadline);
  if (late.length) S.change(() => { for (const r of late) { r.status = "expired"; r.closedAt = now; } });
  return { made: made.length, expired: late.length };
}
export const QUESTION = (r, viewer) => `Your agent wrote a recap of your game:\n“${lineFor(r, viewer)}”\n\nPost it to the club? It goes up only if everyone in it says yes.`;
const BUTTONS = (r) => [{ title: "Post", payload: `fr:${r.id}:yes` }, { title: "Not now", payload: `fr:${r.id}:no` }];
async function ask(player, r) { await messenger(player, QUESTION(r, player), { buttons: BUTTONS(r) }); }

// a player's answer: yes or no. The recap is posted once everyone has said yes; one no closes it for good.
export async function answer(player, id, yes) {
  const r = (S.data().recaps || []).find((x) => x.id === id);
  const me = r?.players.find((p) => p.id === player && !p.member);
  if (!r || !me) return { error: "That recap is not there any more.", code: 404 };
  if (r.status !== "asking") return { error: r.status === "posted" ? "That recap is already posted." : "That recap was not posted, and won't be.", code: 409, status: r.status };
  if (deps.now() > r.deadline) { S.change(() => { r.status = "expired"; r.closedAt = deps.now(); }); return { error: "The time to answer that recap has passed, so it won't be posted.", code: 409, status: "expired" }; }
  S.change(() => { me.answer = yes ? "yes" : "no"; me.at = deps.now(); me.by = "them"; });
  return settle(id, player);
}
// everyone said yes: posted, as the booking player's agent's post; anyone said no: closed
async function settle(id, viewer = null) {
  const r = (S.data().recaps || []).find((x) => x.id === id);
  if (r.players.some((p) => p.answer === "no")) { S.change(() => { r.status = "declined"; r.closedAt = deps.now(); }); return { status: "declined", recap: recapView(r, viewer) }; }
  if (!r.players.every((p) => p.answer === "yes")) return { status: "asking", recap: recapView(r, viewer) };
  const post = S.change((d) => {
    const x = { id: S.newId("p"), kind: "recap", at: deps.now(), by: { type: "agent", agentOf: r.owner }, recap: r.id, crew: r.players.map(({ id, name, member }) => ({ id, name: name || null, member: !!member })),
      approved: { by: r.players.map((p) => p.id), at: deps.now() }, text: null, game: r.game, likes: [], comments: [], reports: [] };
    d.posts.push(x);
    r.status = "posted"; r.post = x.id; r.closedAt = deps.now();
    return x;
  });
  return { status: "posted", recap: recapView(r, viewer), post: viewer ? view(post, viewer) : null };
}
// a recap as one of its players sees it while it waits: the line, and who has said yes
export const recapView = (r, viewer) => ({ id: r.id, at: r.at, deadline: r.deadline, status: r.status, text: lineFor(r, viewer), game: r.game,
  players: r.players.map((p) => ({ name: p.id === viewer ? "You" : p.member ? p.name.split(" ")[0] : deps.nameOf(p.id) || "A member", you: p.id === viewer, answer: p.answer, ...(p.member ? { byAgent: true } : {}) })) });
export const pendingFor = (player) => (S.data().recaps || []).filter((r) => r.status === "asking" && r.players.some((p) => p.id === player && !p.member && p.answer == null)).map((r) => recapView(r, player));

// Messenger's buttons (fr:<recap>:yes|no)
export async function answerInMessenger(psid, payload, send) {
  const m = /^fr:(r[a-z0-9]+):(yes|no)$/.exec(payload);
  if (!m) return;
  const r = await answer(psid, m[1], m[2] === "yes");
  if (r.error) return send(psid, r.error);
  if (r.status === "posted") return send(psid, "Everyone said yes: the recap is in the club feed.");
  if (r.status === "declined") return send(psid, m[2] === "no" ? "OK, it won't be posted." : "Someone in it said no, so it won't be posted.");
  const waiting = r.recap.players.filter((p) => p.answer == null).map((p) => p.name);
  return send(psid, `Thanks. It goes up once ${waiting.join(" and ")} say${waiting.length === 1 ? "s" : ""} yes too.`);
}
// /forget: every recap the member is in, asked or posted
export function forget(player) {
  let n = 0;
  S.change((d) => {
    const mine = (d.recaps || []).filter((r) => r.players.some((p) => p.id === player));
    n = mine.length;
    const posts = new Set(mine.map((r) => r.post).filter(Boolean));
    d.posts = d.posts.filter((p) => !posts.has(p.id) && !(p.kind === "recap" && (p.crew || []).some((c) => c.id === player)));
    d.recaps = (d.recaps || []).filter((r) => !mine.includes(r));
  });
  return n;
}

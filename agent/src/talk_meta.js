// What a finished talk says about itself, for the app to show next to the agents' messages (a2a.js calls annotate when
// a talk ends):
//   calendars  "private" (your agent proposed from your own week; each member's agent checked its own calendar) or
//              "shared" (your agent listed only the times that fit the club's shared calendars)
//   cards      for each member's agent reached over A2A: whether its signed Agent Card checked out against the key
//              published at its own address (/a2a/keys.json), and when (a2a_client.js checks it once per agent)
//   holdUntil  on an agreed game: when the members' agents let the time go if the player has not said yes (play.js
//              holds it for 30 minutes; a booking or a no releases it sooner)
import * as client from "./a2a_client.js";
import { held } from "./play.js";

const viaA2A = () => process.env.A2A_TRANSPORT !== "local" && !!process.env.A2A_BASE;
const memberUrl = (id) => `${String(process.env.A2A_BASE || "").replace(/\/$/, "")}/a2a/members/${id}/`;

// each member's card as your agent checked it; null when the talk ran in this process (no A2A, no card)
export function cards(members = []) {
  if (!viaA2A()) return null;
  return members.map((m) => {
    const c = client.cardCheck(memberUrl(m.id));
    return { member: m.id, verified: !!c?.verified, ...(c?.skipped ? { skipped: true } : {}), ...(c?.at ? { at: c.at } : {}), ...(c?.alg ? { alg: c.alg } : {}), ...(c?.reason ? { reason: c.reason } : {}) };
  });
}
// the time the agreed game is held until: the earliest of the members' holds for this talk (null: none held)
export function holdUntil(ref, members = []) {
  const until = members.flatMap((m) => held(m.id).filter((l) => l.ref === ref).map((l) => l.until));
  return until.length ? Math.min(...until) : null;
}
// what each member's agent is holding for this talk now (the app reads it to follow the countdown)
export const holds = (ref, ids = []) => ids.flatMap((id) => held(id).filter((l) => l.ref === ref).map((l) => ({ member: id, until: l.until, date: l.date, from: l.from, to: l.to })));

export function annotate(r, { id, members = [], privateCalendars = false } = {}) {
  if (!r || typeof r !== "object") return r;
  r.calendars = privateCalendars ? "private" : "shared";
  const cs = cards(members);
  if (cs) r.cards = cs;
  if (r.agreed) {
    r.agreed.calendars = r.calendars;
    if (cs) r.agreed.cards = cs;
    const u = r.agreed.hold ? holdUntil(r.agreed.hold, members) : null;
    if (u) r.agreed.holdUntil = u;
  }
  return r;
}

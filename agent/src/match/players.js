// A real player as a member whose agent other agents can ask (docs/agent_matchmaking_plan.md, section 12). A linked
// Messenger player (store.js) or the web app's player ("you") gets an agent at /a2a/members/<id>, made from their own
// week and profile on this server. It answers "how likely is a yes" only after the player said yes (`/bands on`,
// settings.js); until then its card declares no estimate-yes skill and no extension, and an estimate is refused.
// Simulated and demo members (club.json, population.js) are not changed here: they give bands, labelled as simulated.
import * as store from "../store.js";
import { readClub } from "../club.js";
import * as settings from "./settings.js";

export const isReal = (id) => id === "you" || !!store.get(id);
export function asMember(id, club = readClub()) {
  if (!isReal(id)) return null;
  const p = id === "you" ? null : store.get(id), you = club.you || {}, s = settings.get(id);
  return { id, name: p?.name && p.name !== "there" ? p.name : "You", real: true, level: you.level || "B", rating: you.rating || 1500, free: you.free || [], area: you.area || null, venue: you.venue || null,
    prefers: "any", sports: you.sports || ["badminton"], rules: {}, rulesComplete: true, shares: { likely: s.bands, exact: s.exact }, agent: "" };
}
// a club member, or a real player who has an agent here
export const memberById = (id, club = readClub()) => club.members.find((m) => m.id === id) || asMember(id, club);

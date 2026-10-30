// Each player's spending mandate: what their agent may commit them to. Set by the player on the website (signed in as
// themselves), never by an agent: the agent's token can read it, not change it. Money in integer cents.
//   perGame    the most their share of one game may be
//   perWeek    the most their shares may add up to in the 7 days around a game
//   venues     null for any venue, or the only venues their agent may book
//   autopay    the player saved a PayPal payment method (Vault) and lets their agent pay within these limits without
//              asking each time; otherwise every payment waits for the player's approval in PayPal
// The shape follows the Intent Mandate of the Agent Payments Protocol (AP2): conditions a person approved in advance,
// under which an agent may act while they are away.
import { store } from "./store.js";

const DEFAULT = { perGame: 1500, perWeek: 4000, venues: null, autopay: false };
const db = store(process.env.MANDATES_FILE || null, { mandates: {} });
export const mandatesStore = db;

export const getMandate = (playerId) => ({ ...DEFAULT, ...(db.data.mandates[playerId] || {}), player: playerId });

export function setMandate(playerId, m) {
  const cur = getMandate(playerId), next = { ...cur };
  const money = (x) => Number.isInteger(x) && x >= 0 && x <= 100000;
  if (m.perGame !== undefined) { if (!money(m.perGame)) return { error: "perGame must be cents, 0 to 100000" }; next.perGame = m.perGame; }
  if (m.perWeek !== undefined) { if (!money(m.perWeek)) return { error: "perWeek must be cents, 0 to 100000" }; next.perWeek = m.perWeek; }
  if (m.venues !== undefined) { if (m.venues !== null && !(Array.isArray(m.venues) && m.venues.every((v) => typeof v === "string"))) return { error: "venues must be null or a list of venue ids" }; next.venues = m.venues; }
  if (m.autopay !== undefined) next.autopay = m.autopay === true;
  delete next.player;
  db.data.mandates[playerId] = { ...next, updated: new Date().toISOString() };
  db.save();
  return getMandate(playerId);
}

// Does a share fit the player's mandate? spentThisWeek is what their other games around that date already commit them to.
export function fits(playerId, { venue, share, spentThisWeek = 0 }) {
  const m = getMandate(playerId), why = [];
  if (share > m.perGame) why.push(`their share ($${(share / 100).toFixed(2)}) is over their per-game limit ($${(m.perGame / 100).toFixed(2)})`);
  if (spentThisWeek + share > m.perWeek) why.push(`it would take them over their weekly limit ($${(m.perWeek / 100).toFixed(2)})`);
  if (m.venues && !m.venues.includes(venue)) why.push("that venue is not on their list");
  return { ok: why.length === 0, why, mandate: m };
}

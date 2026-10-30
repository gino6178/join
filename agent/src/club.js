// The demo club (web/public/data/club.json, made up for the demo): its members, their free times and games, and the
// player ("you"). SIM_MEMBERS=n adds n simulated members (population.js, from SIM_SEED), each with an A2A agent like
// every member, for measuring at scale; SIM_ONLY=1 leaves the demo members out (a club of strangers to the player).
// SIM_USERS=<folder> adds the simulated users' members (test/sim_users/seed). With CLUB_PLAYERS=1 the club's members
// are its Messenger players, each one planning as themselves (asPlayer, below).
import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { population } from "./population.js";
import * as store from "./store.js";
import * as settings from "./match/settings.js";

const DATA = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), "../../web/public/data");
// SIM_USERS=<folder>: the simulated users' members (its members.json, test/sim_users/seed) join the club, each marked
// simulated, with an A2A agent like every member (a member that is not marked simulated is left out)
const simUsers = () => {
  const dir = process.env.SIM_USERS;
  if (!dir) return [];
  try { return (JSON.parse(fs.readFileSync(path.join(path.resolve(dir), "members.json"), "utf8")).members || []).filter((m) => m && m.simulated === true && m.id); } catch { return []; }
};
const baseClub = () => {
  const c = JSON.parse(fs.readFileSync(path.join(DATA, "club.json"), "utf8")), n = +(process.env.SIM_MEMBERS || 0), extra = simUsers();
  const members = [...(process.env.SIM_ONLY === "1" && (n > 0 || extra.length) ? [] : c.members), ...extra.filter((m) => !c.members.some((x) => x.id === m.id)), ...(n > 0 ? population(n, +(process.env.SIM_SEED || 7)) : [])];
  return n > 0 || extra.length ? { ...c, members } : c;
};
// CLUB_PLAYERS=1: the club's members are its Messenger players, each member's Messenger id being their member id.
// While the gateway works for one of them (their message, their daily ask, their Autopilot: asPlayer), the club as
// their agent sees it has them as "you" (their own free times, home, level, sports and goal; the games they played
// come from their own record) and everyone else as the members. Off (the default), every Messenger player is the
// demo's "you", as before.
const acting = new AsyncLocalStorage();
export const clubPlayers = () => process.env.CLUB_PLAYERS === "1";
export const asPlayer = (id, fn) => (clubPlayers() && id ? acting.run(String(id), fn) : fn());
export const actingPlayer = () => (clubPlayers() ? acting.getStore() || null : null);
export function viewOf(c, me) {
  const goal = { perWeek: 2, sport: (me.sports || ["badminton"])[0], approval: "ask", maxTrip: 30, ...(me.goal || {}) };
  return { ...c, you: { name: me.name, level: me.level, rating: me.rating, hand: me.hand, weak: me.weak, strength: me.strength, free: me.free || [], venue: me.venue, area: me.area, sports: me.sports || ["badminton"], goal, prefers: me.prefers || "any", history: me.history || [], w: me.w ?? 0, l: me.l ?? 0, form: me.form || [], body: [], simulated: !!me.simulated },
    members: c.members.filter((m) => m.id !== me.id) };
}
// (a member who is one of this gateway's Messenger players gives "how likely is a yes" only after their /bands on, as a
// real player's agent does: match/players.js)
const consented = (c) => ({ ...c, members: c.members.map((m) => { if (!store.get(m.id)) return m; const s = settings.get(m.id); return { ...m, shares: { ...(m.shares || {}), likely: s.bands, exact: s.exact } }; }) });
export const readClub = () => {
  const c0 = baseClub(), c = clubPlayers() ? consented(c0) : c0, id = actingPlayer(), me = id && c.members.find((m) => m.id === id);
  return me ? viewOf(c, me) : c;
};

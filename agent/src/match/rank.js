// The order of whom to ask, for each place in Serve that picks partners (docs/agent_matchmaking_plan.md, section 3):
//   rankRows        the Autopilot's find_partners (its rows, ordered by band, then its own fit)
//   bandsFor        the Match helper's daily ask (ask.js opening: the bands at the time it found)
//   rerankOptions   the Play page's options (each option's partners and spares, by band; a member asked for by name stays)
// The bands come from the members' own agents (likely.js), over A2A or in process; only bands come back.
import { readClub } from "../club.js";
import { helpers } from "../play.js";
import { breaks, first } from "../a2a.js";
import { order, ledger, said, on } from "./ask.js";
import { ensureDemo, noteInvite, store } from "./records.js";
import { features } from "./features.js";
import { predict } from "./model.js";
import crypto from "node:crypto";

const { travelMin, readVenues, DAYS } = helpers;
const local = () => { const club = readClub(); return { club, venues: readVenues(), breaks, travelMin }; };

// the bands for some members at some times, with their order
export async function rankMembers(members, { prior = () => 0, times, sport = "badminton", format = "singles", minutes = 90, from = "you", now = Date.now(), seed = "", probe } = {}) {
  const ctx = local();
  await ensureDemo(ctx.club).catch(() => 0);
  return order(members.map((m) => ({ m, prior: prior(m) })), { from, times, sport, format, minutes, now, seed, probe }, ctx);
}

// find_partners: rows {id, name, fit, why}, best fit first; returns them ordered by band, each with `likely`
export async function rankRows(rows, { members, date, start, format, sport, minutes, from }) {
  if (!on() || !rows.length) return rows;
  const byId = new Map(members.map((m) => [m.id, m])), fit = new Map(rows.map((r) => [r.id, r.fit]));
  const ordered = await rankMembers(rows.map((r) => byId.get(r.id)).filter(Boolean), { prior: (m) => fit.get(m.id), times: [{ date, start }], sport, format, minutes, from, seed: `${date} ${start} ${format}` });
  const row = new Map(rows.map((r) => [r.id, r]));
  return ordered.map((c) => { const r = row.get(c.m.id); return { ...r, likely: c.band, why: c.band ? [said(first(r.name), c.band), ...r.why] : r.why }; });
}

// ask.js opening: o.candidates [{id, score}] at o.date o.start -> { "date start": { id: band } }
export async function bandsFor(o, { from = "you" } = {}) {
  if (!on() || !o?.candidates?.length) return null;
  const club = readClub(), score = new Map(o.candidates.map((c) => [c.id, c.score]));
  const ms = o.candidates.map((c) => club.members.find((m) => m.id === c.id)).filter(Boolean);
  const ordered = await rankMembers(ms, { prior: (m) => score.get(m.id), times: [{ date: o.date, start: o.start, ...(o.venue?.id ? { venue: o.venue.id } : {}) }], sport: o.sport, format: o.format, minutes: o.minutes, from, seed: `${o.date} ${o.start}` });
  return { [`${o.date} ${o.start}`]: Object.fromEntries(ordered.filter((c) => c.probed).map((c) => [c.m.id, c.band])) };
}

// play.js plan: for each option, its partners and spares by band (a member asked for by name stays in); the trips are
// worked out again for whoever is in
export async function rerankOptions(s, { intent, tell = () => {} } = {}) {
  if (!on() || !s?.options?.length) return s;
  const club = readClub(), venues = readVenues(), me = { id: "you", name: "You", area: club.you?.area }, counts = { asked: 0, bands: {} };
  for (const o of s.options) {
    const need = o.partners.length, fixed = o.partners.filter((p) => (intent?.with || []).includes(p.id)).map((p) => p.id);
    const ids = [...o.partners.map((p) => p.id), ...(o.spare || [])], ms = ids.map((id) => club.members.find((m) => m.id === id)).filter(Boolean);
    const pos = new Map(ids.map((id, k) => [id, ids.length - k])); // the option's own order is the fit
    const ordered = await rankMembers(ms, { prior: (m) => pos.get(m.id) + (fixed.includes(m.id) ? 100 : 0), times: [{ date: o.date, start: o.start, venue: o.venue.id }], sport: o.sport, format: o.format, minutes: o.minutes, seed: o.id, probe: ms.length });
    counts.asked += ordered.filter((c) => c.probed).length;
    ordered.forEach((c) => { if (c.band) counts.bands[c.band] = (counts.bands[c.band] || 0) + 1; });
    const inIds = [...fixed, ...ordered.map((c) => c.m.id).filter((id) => !fixed.includes(id))].slice(0, need);
    const was = new Map(o.partners.map((p) => [p.id, p])), band = new Map(ordered.map((c) => [c.m.id, c.band])), chance = new Map(ordered.filter((c) => c.p != null).map((c) => [c.m.id, c.p]));
    o.partners = inIds.map((id) => { const m = club.members.find((x) => x.id === id), p = was.get(id), b = band.get(id); return { id, name: m.name, level: m.level, why: [...(b ? [said(first(m.name), b)] : []), ...(p?.why || ["free then"])].slice(0, 3), likely: b || null, ...(chance.has(id) ? { chance: chance.get(id) } : {}) }; });
    o.spare = ordered.map((c) => c.m.id).filter((id) => !inIds.includes(id));
    const v = venues.venues.find((x) => x.id === o.venue.id);
    if (v) { o.travel = [me, ...inIds.map((id) => club.members.find((m) => m.id === id))].filter((x) => x?.area).map((x) => ({ id: x.id, name: x.name, min: travelMin(x.area, v), km: +helpers.kmBetween(x.area, v).toFixed(1) })); o.longest = Math.max(0, ...o.travel.map((t) => t.min)); }
  }
  const b = Object.entries(counts.bands).map(([k, n]) => `${n} ${k}`).join(", ");
  tell({ step: "Asked their agents how likely a yes is", tool: "likely", detail: `${counts.asked} agents answered on their own side${b ? `: ${b}` : ""}; only a band comes back, never their records` });
  return s;
}

// The demo's invites (play.js book, 12.8): a demo or simulated member answers by its own agent's chance of a yes for
// that game (its records, the model in use), drawn with a seed from the booking, so likely members tend to come and the
// demo is the same every time. The talk's own answer is left out (it is the agent's yes, not the member's). A real
// player is not answered for (null: play.js keeps its own rule).
export function inviteAnswer(memberId, option, seed) {
  const club = readClub(), m = club.members.find((x) => x.id === memberId);
  if (!m || !option?.date) return null;
  const rec = store().of(memberId), v = readVenues().venues.find((x) => x.id === option.venue?.id);
  const f = features({ ...rec, asked: (rec.asked || []).filter((a) => !option.talk || a.ref !== option.talk) }, { from: "you", date: option.date, start: option.start, minutes: option.minutes || 90, format: option.format === "doubles" ? "doubles" : "singles",
    now: Date.now(), gap: (m.rating || 1500) - (club.you?.rating || 1500), trip: v && m.area ? travelMin(m.area, v) : 15, prefersDoubles: m.prefers === "doubles" });
  const u = parseInt(crypto.createHash("sha256").update(`${seed}|${memberId}|yes`).digest("hex").slice(0, 8), 16) / 2 ** 32;
  return u < predict(f);
}
// an invite answered (play.js status): the member's own record of it, and the gateway's ledger of the band it gave
export function onInvite(memberId, option, accept) {
  try { noteInvite(memberId, option, accept); } catch { /* not noted */ }
  const p = (option?.partners || []).find((x) => x.id === memberId);
  try { if (p?.likely) ledger().outcome(memberId, p.likely, accept); } catch { /* not noted */ }
}
export { DAYS };

// The member's side of "how likely is a yes" (serve.likely; docs/agent_matchmaking_plan.md, sections 5 and 6). A
// member's agent answers an estimate from its own member's records, in code, with no model reading anything the asker
// sent. Only a band crosses: unlikely, maybe, likely, very likely.
//   1. The member opted out (shares.likely false), a budget ran out, or the request is not for a game: a refusal,
//      the same one whatever the reason.
//   2. The same asker, member and times within 30 minutes: the same answer again, from the cache, at no cost.
//   3. The member's hard rules and calendar first (a2a.js breaks): a time that breaks one does not count. When none
//      is left the band is "unlikely", the same band as "free but not keen", so a band never says "not free".
//   4. The chance of a yes to the best time left (features.js, model.js), as a band.
// Every estimate asked for is in the audit (who asked whom, how many times, the band or the refusal), and /forget
// deletes the member's rows and the rows where they asked.
import path from "node:path";
import crypto from "node:crypto";
import { readJSON, writeJSON } from "../jsonfile.js";
import { features } from "./features.js";
import { predict, bandOf, version, published, BANDS, exactOf, EXACT_STEP, CUTS } from "./model.js";
import { store as records } from "./records.js";
import * as disclosure from "../disclosure.js";

export const EXT_PATH = "/a2a/ext/likely/v1";
export const REFUSAL = "This agent does not give an estimate now.";
const H = 36e5;
export const limits = () => ({ perAskerDay: +(process.env.MATCH_PER_ASKER_DAY || 4), perAskerWeek: +(process.env.MATCH_PER_ASKER_WEEK || 10), perMemberWeek: +(process.env.MATCH_PER_MEMBER_WEEK || 40), askerDay: +(process.env.MATCH_ASKER_DAY || 60), maxTimes: 12, validMinutes: 30 });

// the audit and the cache: on disk (MATCH_AUDIT_FILE), or in memory for the evals
export function createState(file = null, { keep = 5000 } = {}) {
  let db = file ? readJSON(file, { audit: [], cache: {} }) : { audit: [], cache: {} };
  let timer = null;
  const save = () => { if (file && !timer) timer = setTimeout(() => { timer = null; writeJSON(file, db); }, 200); };
  // the budgets count answered, uncached estimates: kept as times per asker and member, per member, per asker
  const idx = { pair: new Map(), member: new Map(), from: new Map() };
  const push = (m, k, t) => { const a = m.get(k) || []; a.push(t); while (a.length && t - a[0] > 7 * 24 * H) a.shift(); m.set(k, a); };
  const index = (e) => { if (!e.counted) return; push(idx.pair, `${e.from}|${e.member}`, e.at); push(idx.member, e.member, e.at); push(idx.from, e.from, e.at); };
  db.audit.forEach(index);
  return {
    log(e) { db.audit.push(e); index(e); if (db.audit.length > keep) db.audit = db.audit.slice(-keep); save(); },
    audit: (f = () => true) => db.audit.filter(f),
    // how many counted estimates since `since` (ms)
    count(kind, key, since) { const a = idx[kind].get(key) || []; let n = 0; for (let i = a.length - 1; i >= 0 && a[i] >= since; i--) n++; return n; },
    cached(k, now) { const c = db.cache[k]; return c && c.until > now ? c : null; },
    cache(k, v) { db.cache[k] = v; const ks = Object.keys(db.cache); if (ks.length > 4000) for (const x of ks.slice(0, ks.length - 4000)) delete db.cache[x]; save(); },
    forget(id) {
      db.audit = db.audit.filter((a) => a.member !== id && a.from !== id);
      for (const [k, c] of Object.entries(db.cache)) if (c.member === id || c.from === id) delete db.cache[k];
      for (const m of Object.values(idx)) for (const k of [...m.keys()]) if (k === id || k.startsWith(`${id}|`) || k.endsWith(`|${id}`)) m.delete(k);
      save();
    },
    flush() { if (timer) { clearTimeout(timer); timer = null; } if (file) writeJSON(file, db); },
  };
}
let main = null;
export const state = () => (main ||= createState(path.resolve(process.env.MATCH_AUDIT_FILE || "data/match_audit.json")));
export const useState = (s) => { main = s; };

// what a member's Agent Card declares (A2A v1.0 capabilities.extensions), and the description served at its URI
// (a member who chose to share the exact chance declares it, with its step and the band edge below which it is not given)
export function extension(base, m = null) {
  const l = limits();
  return { uri: `${base}${EXT_PATH}`, description: `Answers serve.likely with a calibrated band${m?.shares?.exact ? " and the exact chance" : ""}: how likely this member is to say yes to the best of the listed times.`, required: false,
    params: { bands: published().ranges, budget: { perAskerDay: l.perAskerDay, perAskerWeek: l.perAskerWeek, perMemberWeek: l.perMemberWeek }, maxTimes: l.maxTimes, validMinutes: l.validMinutes,
      ...(m?.shares?.exact ? { exact: { step: EXACT_STEP, from: CUTS[0] } } : {}) } };
}
export const describe = () => ({ name: "serve.likely", version: 1, request: "a data part {kind: 'serve.likely', from, sport, format, minutes, times: [{date, start, venue}]}, at most 12 times, facts only",
  answer: "a 'likely' artifact {band, model, until}, and p (the calibrated chance rounded to 0.05, from 0.15 up) for a member whose card declares exact; or TASK_STATE_REJECTED with one fixed sentence, whatever the reason", bands: BANDS, ...published(), budget: limits(),
  meaning: "the chance that the member says yes to the best of the listed times, if asked now; 'unlikely' also covers 'none of these times works', and no exact chance is given below 0.15" });

// can this asker ask about this member now (the budgets, counted over the audit's answered, uncached estimates)
function withinBudget(st, member, from, now) {
  const l = limits(), day = now - 24 * H, week = now - 7 * 24 * H, pair = `${from}|${member}`;
  return st.count("pair", pair, day) < l.perAskerDay && st.count("pair", pair, week) < l.perAskerWeek && st.count("from", from, day) < l.askerDay && st.count("member", member, week) < l.perMemberWeek;
}

// m: the member (club.json or population.js); req: a serve.likely data part (already schema-checked);
// ctx: { now, club, venues, breaks (a2a.js), travelMin, records, state, sore }
export function answer(m, req, ctx = {}) {
  const now = ctx.now ?? Date.now(), st = ctx.state || state(), rs = ctx.records || records();
  const times = (req.times || []).slice(0, limits().maxTimes);
  const k = crypto.createHash("sha256").update(JSON.stringify([m.id, !!m.shares?.exact, req.from, req.sport, req.format, req.minutes || 90, times.map((x) => [x.date, x.start, x.venue || ""]).sort()])).digest("hex").slice(0, 24);
  const hit = st.cached(k, now);
  if (hit) { st.log({ at: now, member: m.id, from: req.from, times: times.length, band: hit.band, ...(hit.p != null ? { p: hit.p } : {}), cached: true }); return { band: hit.band, model: hit.model, until: hit.until, ...(hit.p != null ? { p: hit.p } : {}) }; }
  const refuse = (why) => { st.log({ at: now, member: m.id, from: req.from, times: times.length, refused: true, why }); return { refused: true }; };
  if (m.shares?.likely === false) return refuse("opted out");
  if (!(m.sports || ["badminton"]).includes(req.sport)) return refuse("does not play that sport");
  if (!withinBudget(st, m.id, req.from, now)) return refuse("budget");
  const minutes = req.minutes || 90, venues = ctx.venues?.venues || [], asker = ctx.club ? (req.from === "you" || !ctx.club.members.some((x) => x.id === req.from) ? ctx.club.you : ctx.club.members.find((x) => x.id === req.from)) : null;
  const rec = rs.of(m.id);
  let best = 0;
  for (const x of times) {
    const v = venues.find((y) => y.id === x.venue) || venues.find((y) => y.id === m.venue) || null;
    const trip = v && m.area && ctx.travelMin ? ctx.travelMin(m.area, v) : null;
    const [h, mm] = x.start.split(":").map(Number), day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(`${x.date}T12:00:00`).getDay()];
    // its own calendar and rules first (as for a proposal); a venue it can't place with a longest-trip rule is a no
    if (ctx.breaks && ctx.breaks(m, { slot: { date: x.date, day }, start: h * 60 + mm, trip, ...(trip == null && x.venue ? { unplaced: true } : {}) }, minutes)) continue;
    const f = features(rec, { from: req.from, date: x.date, start: x.start, minutes, format: req.format, now, gap: (m.rating || 1500) - (asker?.rating || 1500), trip: trip ?? 15, prefersDoubles: m.prefers === "doubles", ...(ctx.sore != null ? { sore: ctx.sore } : {}) });
    best = Math.max(best, predict(f, ctx.model)); // (ctx.model: an eval comparing versions; otherwise the one in use)
  }
  // the exact chance only for a member who chose to share it, and only from the lowest band edge up
  const band = bandOf(best || 0.02), p = m.shares?.exact ? exactOf(best || 0.02) : null;
  // the member's disclosure budget (disclosure.js), shared with its answers to proposals: a band says something about
  // every hour it covers, so all of them must fit, or none is answered (whether they fit is decided without the band;
  // a one-time band is kept as that hour's yes or no for the inference check)
  const dl = disclosure.settings();
  if (dl.on && (ctx.disclosure || disclosure.ledger()).grant(m.id, req.from, times.map((x, i) => ({ id: i, cell: disclosure.cellOf(x.date, x.start), ...(times.length === 1 ? { v: band !== "unlikely", n: dl.bandNoIfFree } : {}) })), now, { all: true, limits: dl }).withheld.length) return refuse("disclosure budget");
  const out = { band, model: ctx.model?.version || version(), until: now + limits().validMinutes * 60000, ...(p != null ? { p } : {}) };
  st.cache(k, { ...out, member: m.id, from: req.from });
  st.log({ at: now, member: m.id, from: req.from, times: times.length, band, ...(p != null ? { p } : {}), counted: true });
  return out;
}
// who asked about a member, for the member and the maintainer (no records, only the estimates)
export const auditOf = ({ member = null, from = null, n = 200 } = {}) => state().audit((a) => (!member || a.member === member) && (!from || a.from === from)).slice(-n);
export const forget = (id) => state().forget(id);

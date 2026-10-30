// The asking side: which members' agents to ask first (docs/agent_matchmaking_plan.md, section 3, step 4).
// Your agent asks up to twelve candidates' agents for an estimate at once: ten by fit (play.js partnerScore, or the
// caller's own score) and two drawn from the rest, so the same members are not the only ones ever asked. Each answers
// with a band (likely.js, on its own side). Your agent orders by band, then who was asked least this week, then fit.
// A refusal, or an agent whose bands the calibration ledger caught out, is "unknown": ordered as the club's average,
// never as a no. Your agent never sees a record, only bands.
//   MATCH=off turns it all off (the callers then keep their own order); MATCH_FAIR=0 probes the twelve best by fit.
import path from "node:path";
import crypto from "node:crypto";
import * as client from "../a2a_client.js";
import { validate, LIKELY, LIKELY_ANSWER } from "../schema.js";
import { readJSON, writeJSON } from "../jsonfile.js";
import { binomCdf } from "./fit.js";
import { answer as localAnswer, EXT_PATH } from "./likely.js";
import * as peer from "../peer.js";
import { bandOf, CUTS, RANGES } from "./model.js";
import { club as clubSettings } from "./settings.js";

const MID = Object.fromEntries(Object.entries(RANGES).map(([b, [lo, hi]]) => [b, (lo + hi) / 2]));
import { a2aCall } from "../trace.js";

export const on = () => process.env.MATCH !== "off";
const PROBE = 12, FAIR = 2;
const viaA2A = () => process.env.A2A_TRANSPORT !== "local" && !!process.env.A2A_BASE;

// the calibration ledger and the asks sent this week, kept by the gateway (MATCH_STATE_FILE), or in memory (evals)
export function createLedger(file = null) {
  let db = file ? readJSON(file, { ledger: {}, sent: {} }) : { ledger: {}, sent: {} };
  let timer = null;
  const save = () => { if (file && !timer) timer = setTimeout(() => { timer = null; writeJSON(file, db); }, 200); };
  const week = (t) => Math.floor((t + 3 * 864e5) / (7 * 864e5));
  return {
    // a band given, and what happened next: a yes (the talk agreed and the member took the game) or a no
    outcome(id, band, yes, now = Date.now()) {
      if (!band || !["likely", "very likely"].includes(band)) return;
      const x = (db.ledger[id] ||= { n: 0, y: 0, low: 0 });
      x.n++; x.y += yes ? 1 : 0; x.low += band === "very likely" ? CUTS[2] : CUTS[1];
      // at least six "likely" or better, and fewer yeses than the bands' lower edges allow (one-sided, p < 0.01)
      if (x.n >= 6 && binomCdf(x.y, x.n, x.low / x.n) < 0.01) x.flagged = now;
      save();
    },
    flagged: (id, now = Date.now()) => !!db.ledger[id]?.flagged && now - db.ledger[id].flagged < 30 * 864e5,
    sent(id, now = Date.now()) { const k = `${week(now)}:${id}`; db.sent[k] = (db.sent[k] || 0) + 1; save(); },
    sentThisWeek: (id, now = Date.now()) => db.sent[`${week(now)}:${id}`] || 0,
    forget(id) { delete db.ledger[id]; for (const k of Object.keys(db.sent)) if (k.endsWith(`:${id}`)) delete db.sent[k]; save(); },
    raw: () => db,
  };
}
let main = null;
export const ledger = () => (main ||= createLedger(path.resolve(process.env.MATCH_STATE_FILE || "data/match_state.json")));
export const useLedger = (l) => { main = l; };

// one estimate from one member's agent: over A2A (a serve.likely message) or in this process. Never throws: an agent
// that can't be reached, refuses, or answers in a form that does not fit is "unknown". A member on a peer gateway
// (peer.js) is asked there, always over A2A. The request names the extension (A2A-Extensions, with the URI the agent's
// card declares).
export async function estimate(m, req, ctx = {}) {
  if (validate(LIKELY, req).length) return { unknown: true, error: "not a serve.likely" };
  const far = peer.isRemote(m);
  if (far && ctx.local) return { unknown: true, error: "on another gateway" };
  if ((!viaA2A() && !far) || ctx.local) {
    const r = localAnswer(m, req, ctx);
    return r.refused ? { refused: true } : r;
  }
  if (far && !(await peer.reachable(peer.remoteOf(m).origin))) return { unknown: true, unreachable: true, error: "its gateway is not reachable now" };
  try {
    const url = peer.baseFor(m), messageId = `lk-${crypto.randomUUID()}`, contextId = `lk-${crypto.randomUUID().slice(0, 13)}`;
    const task = await a2aCall({ member: m.id, url, messageId, contextId, kind: "likely" }, () => client.send(url, { messageId, contextId, role: "ROLE_USER", metadata: {}, parts: [{ data: req, mediaType: "application/json" }] }, { extensions: [EXT_PATH], signal: AbortSignal.timeout(+(process.env.A2A_LIKELY_TIMEOUT_MS || 30000)) }));
    if (task?.status?.state === "TASK_STATE_REJECTED") return { refused: true };
    const d = client.dataOf(task, "likely");
    if (!d || task.status?.state !== "TASK_STATE_COMPLETED" || validate(LIKELY_ANSWER, d).length) return { unknown: true };
    // an exact chance counts only on the published step (0.05), and only with the band it falls in
    if (d.p != null && (Math.abs(d.p / 0.05 - Math.round(d.p / 0.05)) > 1e-6 || bandOf(d.p) !== d.band)) { const { p, ...rest } = d; return rest; }
    return d;
  } catch (e) { return { unknown: true, error: String(e.message || e).slice(0, 120) }; }
}

// Order candidates. cands: [{ m, prior, ...anything }]; q: { from, times: [{date, start, venue}], sport, format,
// minutes, seed, now, fair, probe }; ctx: what likely.js needs in process (club, venues, breaks, travelMin) and the
// ledger. Returns the same objects, ordered, each with band (null when unknown) and probed.
export async function order(cands, q, ctx = {}) {
  // fair exposure: the club's setting (settings.js; on by default), MATCH_FAIR=0|1 over it, the caller's over both
  const led = ctx.ledger || ledger(), now = q.now ?? Date.now(), probe = q.probe ?? PROBE;
  const fair = q.fair ?? (process.env.MATCH_FAIR ? process.env.MATCH_FAIR !== "0" : clubSettings().fairExposure);
  const byPrior = [...cands].sort((a, b) => b.prior - a.prior);
  if (!on() || !q.times?.length) return byPrior.map((c) => ({ ...c, band: null, probed: false }));
  const h = (s) => parseInt(crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 8), 16);
  const rest = byPrior.slice(probe - (fair ? FAIR : 0)).sort((a, b) => h(`${q.seed}|${a.m.id}`) - h(`${q.seed}|${b.m.id}`));
  const asked = fair ? [...byPrior.slice(0, probe - FAIR), ...rest.slice(0, FAIR)] : byPrior.slice(0, probe);
  const req = { kind: "serve.likely", from: q.from || "you", sport: q.sport || "badminton", format: q.format === "doubles" ? "doubles" : "singles", minutes: q.minutes || 90, times: q.times.slice(0, 12).map((x) => ({ date: x.date, start: x.start, ...(x.venue ? { venue: x.venue } : {}) })) };
  const got = await Promise.all(asked.map((c) => (ctx.estimate || estimate)(c.m, req, { ...ctx, now }))); // (ctx.estimate: the evals' liars)
  // the order: the band first, for everyone (a member who shares the exact chance counts as their band); a refusal,
  // or an agent the ledger caught out, counts as "maybe", neither above nor below it. Within a band, with fair exposure,
  // whoever was asked least this week goes first; the exact chance orders only after that (it never overrides the
  // fairness rule), then fit. Without fair exposure: the band, then the exact chance, then fit.
  const scored = asked.map((c, k) => {
    const g = got[k], ok = g.band && !led.flagged(c.m.id, now), band = ok ? g.band : null, p = ok && g.p != null ? g.p : null;
    return { ...c, band, ...(p != null ? { p } : {}), refused: !!g.refused, probed: true, _b: MID[band || "maybe"], _p: p ?? MID[band || "maybe"], _n: led.sentThisWeek(c.m.id, now) };
  }).sort((a, b) => b._b - a._b || (fair ? a._n - b._n || b._p - a._p : b._p - a._p) || b.prior - a.prior);
  const seen = new Set(asked.map((c) => c.m.id));
  return [...scored.map(({ _b, _p, _n, ...c }) => c), ...byPrior.filter((c) => !seen.has(c.m.id)).map((c) => ({ ...c, band: null, probed: false }))];
}

// a band in plain words, for the player (the UI and Messenger): the band is the other agent's; the rest is ours
export const said = (name, band) => (band ? `${name}'s agent says ${band}` : null);
export const forget = (id) => ledger().forget(id);

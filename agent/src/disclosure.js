// A member's disclosure budget (docs/privacy_budget.md). With private calendars every talk still tells the asking agent
// one yes or no per listed time and member (the acceptable set, a2a.js), and a "how likely" band (match/likely.js) says
// something about the times it covers. One talk tells little; forty talks from the same curious agent can map a
// member's week (test/privacy_probe.mjs measures it). So a member's agent, the side that answers, keeps count:
//   - what is counted is the hours of the week an asker has learned something about, a weekday and the hour a game
//     starts ("Thu 19"), not the answers. An hour already told to that asker inside the window costs nothing again, so
//     the same two players agreeing their usual Thursday every week never run out; an asker that walks the whole week
//     does.
//   - per asker: at most A2A_BUDGET_CELLS new hours (24) in a rolling A2A_BUDGET_DAYS (28); and per member, from all
//     askers together, at most A2A_BUDGET_MEMBER_CELLS (72), so many asker ids buy no more than a few.
//   - an hour over the budget is withheld: the answer says which listed times it does not answer (`withheld`), the
//     asking side neither rules them out as a no nor learns them, and which times are withheld depends only on what was
//     asked and in what order, never on the member's calendar, so a withheld time tells the asker nothing.
//   - a band covers all its times or none: a request with an hour over the budget is refused, with the same sentence
//     as every other refusal.
// A2A_BUDGET=on|off; unset, it is on when the server's calendars are private by default (A2A_PRIVATE=1). With shared
// calendars the gateway sees the members' weeks anyway. A2A_DISCLOSE_MIN=m (an alternative measured beside it, off):
// answer only the proposed time and the first m listed times that work.
// What the ledger keeps: who was told about which hours of whose week, and when; never what the answer was. /forget
// deletes a member's rows and the rows where they asked (match/index.js).
import path from "node:path";
import { readFileSync } from "node:fs";
import { readJSON, writeJSON } from "./jsonfile.js";

const DAY = 864e5, DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const settings = () => {
  const v = process.env.A2A_BUDGET;
  return {
    on: v === "on" || v === "1" ? true : v === "off" || v === "0" ? false : process.env.A2A_PRIVATE === "1",
    cells: +(process.env.A2A_BUDGET_CELLS || 24), memberCells: +(process.env.A2A_BUDGET_MEMBER_CELLS || 72), days: +(process.env.A2A_BUDGET_DAYS || 28),
    minimal: process.env.A2A_DISCLOSE_MIN ? +process.env.A2A_DISCLOSE_MIN : null,
    // the inference check (below): withhold what would make the asker this sure of a day's window (0: off)
    sure: +(process.env.A2A_BUDGET_SURE ?? 0.9), check: process.env.A2A_BUDGET_CHECK === "hour" ? "hour" : "day", noIfFree: +(process.env.A2A_BUDGET_NO_IF_FREE || 0.07), bandNoIfFree: 0.1,
  };
};
// the hour of the week a time falls in: its weekday and the hour it starts ("Thu 19")
export function cellOf(date, start) {
  const d = new Date(`${date}T12:00:00`), h = typeof start === "number" ? Math.floor(start / 60) : +String(start).slice(0, 2);
  return `${DAYS[d.getDay()]} ${String(h).padStart(2, "0")}`;
}

// ---- the inference check (A2A_BUDGET_SURE, off by default): what the asker could work out, not only what it was told ----
// The cap above counts hours; but in a club whose weeks look alike (weekday evenings, weekend mornings), two or three
// well-chosen hours pin a whole day: test/privacy_probe.mjs measures it. So a member's agent can also run the asker's
// own reasoning on what it has told that asker: a posterior over each weekday's free window (none, or [a, b) in whole
// hours), from a prior of the club's weeks (the gateway's own members, in aggregate), updated by each yes and no it
// told. A new hour is withheld when either answer to it, yes or no, would make the asker sure of that day's window (a
// posterior of A2A_BUDGET_SURE or more, higher than before). The check looks only at what was already told and at the
// question, never at the true answer, so withholding says nothing (simulatable auditing: Kenthapadi, Mishra and Nissim,
// PODS 2005). What it keeps for the check is the yes or no told to that asker for each hour, on the member's side.
export const HYP = [{ a: null, b: null }];
for (let a = 6; a <= 22; a++) for (let b = a + 2; b <= Math.min(24, a + 8); b++) HYP.push({ a, b });
const EPS = 0.002, MIN = 90;
const fitsH = (H, s) => H.a != null && H.a * 60 <= s && s + MIN <= H.b * 60;
// the prior: how often each window comes up on each weekday among these members' calendars ("Mon 19-22"), smoothed
export function priorFrom(members, alpha = 0.2) {
  return DAYS.map((_, d) => {
    const n = HYP.map(() => alpha);
    for (const m of members || []) {
      const w = (m.free || []).map((x) => x.match(/^(\w{3})\s+(\d{1,2})-(\d{1,2})$/)).find((x) => x && DAYS.indexOf(x[1]) === d);
      const k = w ? HYP.findIndex((H) => H.a === +w[2] && H.b === +w[3]) : 0;
      n[k >= 0 ? k : 0] += 1;
    }
    const tot = n.reduce((x, y) => x + y, 0); return n.map((x) => Math.log(x / tot));
  });
}
let auditPrior = null;
export const useAuditPrior = (p) => { auditPrior = p; };
const prior = () => (auditPrior ||= (() => { try { return priorFrom(JSON.parse(readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), "../../web/public/data/club.json"), "utf8")).members); } catch { return priorFrom([]); } })());
// how sure an asker can be of weekday d's window, from these answers ({ s: start in minutes, v: yes or no, n: the chance
// of a no to a time that fits the calendar, the member's rules))
function postOf(d, obs) {
  const lw = [...prior()[d]];
  for (const o of obs) HYP.forEach((H, k) => { const f = fitsH(H, o.s); lw[k] += Math.log(o.v ? (f ? 1 - o.n : EPS) : (f ? o.n : 1 - EPS)); });
  const mx = Math.max(...lw), w = lw.map((x) => Math.exp(x - mx)), z = w.reduce((a, b) => a + b, 0);
  return w.map((x) => x / z);
}
export const sureOf = (d, obs) => Math.max(...postOf(d, obs));
// (A2A_BUDGET_CHECK=hour: how sure it can be, hour by hour, that the member is free or not, 07-23)
const HOURS = Array.from({ length: 16 }, (_, i) => 7 + i);
export const hoursOf = (d, obs) => { const w = postOf(d, obs); return HOURS.map((h) => HYP.reduce((s, H, k) => s + (H.a != null && H.a <= h && h + 1 <= H.b ? w[k] : 0), 0)); };
// would telling hour s of weekday d (either way) make the asker newly sure of something past what it was asked?
function tooSure(limits, d, s, n, past, askedHours) {
  if (limits.check === "hour") {
    const before = hoursOf(d, past), sure = (p) => p >= limits.sure || p <= 1 - limits.sure, span = new Set([s / 60, s / 60 + 1]);
    return [true, false].some((v) => { const after = hoursOf(d, [...past, { s, v, n }]); return HOURS.some((h, i) => !span.has(h) && !askedHours.has(h) && sure(after[i]) && !sure(before[i])); });
  }
  const now0 = sureOf(d, past);
  return [true, false].some((v) => { const p = sureOf(d, [...past, { s, v, n }]); return p >= limits.sure && p > now0 + 0.01; });
}
const dayOfCell = (c) => DAYS.indexOf(c.slice(0, 3)), startOfCell = (c) => +c.slice(4, 6) * 60;

// the ledger: { pair: { "member|asker": { cell: at } }, member: { member: { cell: at } }, told: { "member|asker":
// { cell: { v, n } } } }, on disk (DISCLOSURE_FILE) or in memory (the evals and tests make their own)
export function createLedger(file = null) {
  const db = file ? readJSON(file, { pair: {}, member: {}, told: {} }) : { pair: {}, member: {}, told: {} };
  db.told ||= {};
  let timer = null;
  const save = () => { if (file && !timer) timer = setTimeout(() => { timer = null; writeJSON(file, db); }, 200); };
  // a map of cells, with the ones older than the window dropped
  const live = (o, since) => { for (const [c, at] of Object.entries(o)) if (at < since) delete o[c]; return o; };
  return {
    // which of these items (in the order they would be told) may be told now; the ones that may are recorded.
    // items: [{ id, cell, v (the true answer, recorded once told; never read to decide), n }]. all: every one or none
    // (a band). Returns { allowed: Set of ids, withheld: [ids] }.
    grant(member, asker, items, now = Date.now(), { all = false, limits = settings() } = {}) {
      const since = now - limits.days * DAY, pk = `${member}|${asker}`;
      const pair = live((db.pair[pk] ||= {}), since), mine = live((db.member[member] ||= {}), since), told = (db.told[pk] ||= {});
      for (const c of Object.keys(told)) if (pair[c] == null) delete told[c];
      let nPair = Object.keys(pair).length, nMember = Object.keys(mine).length;
      const allowed = new Set(), withheld = [], fresh = new Map(), heard = Object.entries(told).map(([c, o]) => ({ d: dayOfCell(c), s: startOfCell(c), v: o.v, n: o.n }));
      for (const it of items) {
        if (pair[it.cell] != null || fresh.has(it.cell)) { allowed.add(it.id); continue; }
        const newForMember = mine[it.cell] == null && !fresh.has(it.cell);
        let ok = nPair < limits.cells && (!newForMember || nMember < limits.memberCells);
        if (ok && limits.sure > 0) {
          const d = dayOfCell(it.cell), s = startOfCell(it.cell), past = heard.filter((o) => o.d === d);
          // (the hours already told, and the two a game at this hour covers, are the asker's to know)
          const asked = new Set(past.flatMap((o) => [o.s / 60, o.s / 60 + 1]));
          ok = !tooSure(limits, d, s, it.n ?? limits.noIfFree, past, asked);
        }
        if (ok) { allowed.add(it.id); fresh.set(it.cell, newForMember); nPair++; if (newForMember) nMember++; if (it.v != null) heard.push({ d: dayOfCell(it.cell), s: startOfCell(it.cell), v: it.v, n: it.n ?? limits.noIfFree }); }
        else withheld.push(it.id);
      }
      if (all && withheld.length) return { allowed: new Set(), withheld: items.map((x) => x.id) };
      // what is told is recorded (an hour told again refreshes its time, so it stays free while the two keep playing then)
      for (const it of items) if (allowed.has(it.id)) { pair[it.cell] = now; mine[it.cell] = Math.max(mine[it.cell] || 0, now); if (limits.sure > 0 && it.v != null && !told[it.cell]) told[it.cell] = { v: it.v, n: it.n ?? limits.noIfFree }; }
      save();
      return { allowed, withheld };
    },
    // how many hours of this member's week this asker has been told about in the window, and the member's total
    used(member, asker, now = Date.now(), limits = settings()) {
      const since = now - limits.days * DAY;
      return { pair: Object.keys(live(db.pair[`${member}|${asker}`] || {}, since)).length, member: Object.keys(live(db.member[member] || {}, since)).length, ...limits };
    },
    forget(id) {
      for (const k of Object.keys(db.pair)) if (k.startsWith(`${id}|`) || k.endsWith(`|${id}`)) delete db.pair[k];
      for (const k of Object.keys(db.told)) if (k.startsWith(`${id}|`) || k.endsWith(`|${id}`)) delete db.told[k];
      delete db.member[id]; save();
    },
    flush() { if (timer) { clearTimeout(timer); timer = null; } if (file) writeJSON(file, db); },
  };
}
let main = null;
export const ledger = () => (main ||= createLedger(path.resolve(process.env.DISCLOSURE_FILE || "data/disclosure.json")));
export const useLedger = (l) => { main = l; };
export const forget = (id) => ledger().forget(id);

// A member's answer to a proposal, cut to what the budget allows (both for this server's agents in process and over
// A2A, a2a_server.js). j: the decision (intent, works, date and start for a counter); cur: the proposed time; offered:
// the listed times ({ id, slot: { date }, start }). The proposed time is told first, then the others in the order
// they were listed. A decision that would tell a withheld time is changed to one that does not: a yes to a withheld
// proposed time becomes the first allowed time that works, or not this week; a counter to a withheld time, the same.
export function limitAnswer(memberId, asker, cur, offered, j, { now = Date.now(), ledger: lg = null, limits = settings() } = {}) {
  if (!limits.on || !j || j.intent === "none" || !Array.isArray(offered) || !offered.some((x) => x.id)) return j;
  const order = [cur, ...offered.filter((x) => x !== cur && x.id !== cur.id)].filter((x) => x?.id);
  const works = new Set(Array.isArray(j.works) ? j.works : j.intent === "accept" ? [cur.id] : []);
  if (j.intent === "counter") { const a = offered.find((x) => x.slot.date === j.date && hmOf(x.start) === j.start); if (a) works.add(a.id); }
  let told = order;
  // minimal disclosure (A2A_DISCLOSE_MIN): the proposed time, and the first m listed times that work
  if (limits.minimal != null) { const ok = order.slice(1).filter((x) => works.has(x.id)).slice(0, limits.minimal); told = [cur, ...ok]; }
  const g = (lg || ledger()).grant(memberId, asker, told.map((x) => ({ id: x.id, cell: cellOf(x.slot.date, x.start), v: works.has(x.id) })), now, { limits });
  const withheld = order.filter((x) => !g.allowed.has(x.id)).map((x) => x.id);
  if (!withheld.length) return j;
  const out = { ...j, works: [...works].filter((id) => g.allowed.has(id)), withheld, budget: true };
  const firstOk = order.find((x) => x !== cur && g.allowed.has(x.id) && works.has(x.id));
  const curOk = g.allowed.has(cur.id);
  if (!curOk || (j.intent === "counter" && !out.works.some((id) => offered.find((x) => x.id === id && x.slot.date === j.date && hmOf(x.start) === j.start)))) {
    if (curOk && works.has(cur.id)) Object.assign(out, { intent: "accept", date: "", start: "" });
    else if (firstOk) Object.assign(out, { intent: "counter", date: firstOk.slot.date, start: hmOf(firstOk.start) });
    else Object.assign(out, { intent: "decline", date: "", start: "" });
  }
  return out;
}
const hmOf = (m) => (typeof m === "number" ? `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}` : String(m));

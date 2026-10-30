// A simulated club's behaviour, for the evals, the training and the demo club's history; never used to decide anything
// for a real player (docs/agent_matchmaking_plan.md, 7.1).
// population.js gives each member a week, a level, a home, habits and hard rules. On top of that every member gets
// hidden traits that no feature sees: general keenness, a liking for each free window, how many games a week they
// want, how much back-to-back days, a level gap, a long trip or short notice put them off, a few friends (mostly from
// their home venue), busy weeks (a Markov chain) and sore spells (only three in four logged in the body log). The
// habits in the member's own words ("would rather play weekends", "avoids two games on consecutive days") shape them
// too. A yes is drawn from a logistic function of those traits, with a threshold (k games a week) and an interaction
// (a sore spell weighs on singles) the features do not spell out, so a model learns from what an agent observes, not
// from the generator's own variables.
// Every draw is a hash of what it is about (common random numbers): the same ask gets the same draw under every policy.
import { helpers, partnerScore } from "../play.js";
import { dayNum, atOf } from "./features.js";

const { windows, travelMin, readVenues, DAYS } = helpers;
const MIN = 90, DAY = 864e5, WEEK = 7 * DAY;
export const sig = (z) => 1 / (1 + Math.exp(-z));
const h01 = (s) => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return ((h >>> 0) + 0.5) / 4294967297; };
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const toMin = (s) => { const [h, m] = String(s).split(":").map(Number); return h * 60 + (m || 0); };
const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const mondayOf = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };

export function makeWorld(members, { seed = 7, start = new Date(2026, 0, 5), weeks = 30 } = {}) {
  const u = (...k) => h01([seed, ...k].join("|"));
  const gaussK = (...k) => Math.sqrt(-2 * Math.log(u(...k, "g1"))) * Math.cos(2 * Math.PI * u(...k, "g2"));
  const base = mondayOf(start), venues = readVenues().venues.filter((v) => !v.sports || v.sports.badminton);
  const X = new Map();
  for (const m of members) {
    const r = rng(Math.floor(h01(`${seed}|traits|${m.id}`) * 4294967296)), g = () => Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r());
    const wins = windows(m.free).map((w) => ({ dow: w.day, from: w.from, to: w.to })), said = String(m.agent || "");
    const x = { m, id: m.id, wins, friends: new Set(),
      h: { base: -0.2 + 0.7 * g(), winPref: wins.map(() => 0.8 * g()), target: 1 + Math.floor(r() * 3), b2b: /consecutive days/.test(said) ? 3 : 0.3 + 1.2 * r(),
        weekend: /weekends than weeknights/.test(said) ? 1 : 0, early: /earliest start/.test(said) ? 0.6 : 0, home: /home venue/.test(said) ? 0.7 : 0,
        gap: 0.2 + 0.6 * r(), trip: 0.02 + 0.06 * r(), notice: 0.3 + 0.7 * r(), act: 0.25 + 0.6 * r() },
      said: { weekend: /weekends than weeknights/.test(said) ? 1 : 0, b2b: /consecutive days/.test(said) ? 1 : 0, home: /home venue/.test(said) ? 1 : 0, early: /earliest start/.test(said) ? 1 : 0 },
      busy: [], sore: [], soreLogged: [] };
    // how often this member, as the asker, drops a game after the other said yes (and cancels half as often after it
    // was booked): mostly rarely, one in ten often. A draw of its own, so the other traits are as before.
    { const f = h01(`${seed}|flake|${m.id}`); x.h.flake = f < 0.7 ? 0.03 : f < 0.9 ? 0.12 : 0.35; }
    let busy = false, left = 0, logged = false;
    for (let w = 0; w < weeks + 2; w++) {
      busy = r() < (busy ? 0.45 : 0.1);
      if (left <= 0 && r() < 0.04) { left = 1 + Math.floor(r() * 3); logged = r() < 0.75; }
      x.busy.push(busy); x.sore.push(left > 0); x.soreLogged.push(left > 0 && logged); left--;
    }
    X.set(m.id, x);
  }
  // friends: three to six, mostly from the same home venue, both ways
  const all = [...X.values()], fr = rng(Math.floor(h01(`${seed}|friends`) * 4294967296));
  for (const a of all) {
    const near = all.filter((b) => b !== a && b.m.venue === a.m.venue), k = 3 + Math.floor(fr() * 4);
    for (let t = 0; t < 40 && a.friends.size < k; t++) { const pool = fr() < 0.75 && near.length ? near : all, b = pool[Math.floor(fr() * pool.length)]; if (b !== a) { a.friends.add(b.id); b.friends.add(a.id); } }
  }

  const dateOfDay = (day) => new Date(base.getFullYear(), base.getMonth(), base.getDate() + day);
  const tOf = (day, min) => { const d = dateOfDay(day); d.setMinutes(min); return d.getTime(); };
  const weekOfT = (t) => Math.floor((t - base.getTime()) / WEEK);
  const slotOf = (day, start) => { const d = dateOfDay(day); return { day, date: ymd(d), start: hm(start), min: start, dow: d.getDay(), dayName: DAYS[d.getDay()] }; };
  const winAt = (x, slot) => x.wins.findIndex((w) => w.dow === slot.dow && w.from <= slot.min && slot.min + MIN <= w.to);
  // the venue in the middle for two people (the longest trip shortest), and each one's trip
  const middle = (a, b) => venues.map((v) => ({ v, ta: travelMin(a.m.area, v), tb: travelMin(b.m.area, v) })).sort((p, q) => Math.max(p.ta, p.tb) - Math.max(q.ta, q.tb))[0];
  // hard rules, as a2a.js breaks keeps them
  function breaks(x, slot, trip) {
    const r = x.m.rules || {};
    if (winAt(x, slot) < 0) return "not free then";
    if (r.noDays?.includes(slot.dayName)) return `no games on ${slot.dayName}`;
    if (r.endBy && slot.min + MIN > toMin(r.endBy)) return `it ends after ${r.endBy}`;
    const nb = r.notBefore && ([0, 6].includes(slot.dow) ? r.notBefore.weekend : r.notBefore.weekday);
    if (nb && slot.min < toMin(nb)) return `it starts before ${nb}`;
    if (r.maxTrip != null && trip > r.maxTrip) return `a ${trip}-minute trip`;
    if (r.maxMinutes && MIN > r.maxMinutes) return "too long";
    return null;
  }
  const gamesOf = (store, id) => store.of(id).games;
  const weekNo = (date) => Math.floor((dayNum(date) + 3) / 7);
  const loadOf = (store, id, slot, t) => {
    let wk = 0, b2b = 0; const d0 = dayNum(slot.date), w0 = weekNo(slot.date);
    for (const g of gamesOf(store, id)) { if (g.t > t || (g.cancelled && (g.cancelledAt ?? g.t) <= t)) continue; const d = dayNum(g.date); if (Math.floor((d + 3) / 7) === w0) wk++; if (d === d0 - 1 || d === d0 + 1) b2b = 1; }
    return { wk, b2b };
  };
  // what member j went through with asker a: yeses the asker then dropped, and games the asker cancelled
  const letDown = (store, j, a, t) => {
    const r = store.of(j); let n = 0;
    for (const e of r.asked) if (e.from === a && e.dropped && (e.droppedAt ?? e.t) <= t) n++;
    for (const g of r.games) if (g.cancelled && (g.cancelledAt ?? g.t) <= t && g.with?.includes(a)) n++;
    return n;
  };
  // the truth: how likely member j is to say yes to asker a, now (t), for this time and venue
  function pTrue(store, j, a, slot, v, t, format = "singles") {
    const x = X.get(j), y = X.get(a) || { m: { rating: 1500 } }, h = x.h, wi = winAt(x, slot), w = Math.floor((slot.day) / 7);
    if (wi < 0) return 0;
    const { wk, b2b } = loadOf(store, j, slot, t), sat = Math.max(0, wk - h.target + 1), we = slot.dow === 0 || slot.dow === 6, notice = (tOf(slot.day, slot.min) - t) / 36e5;
    const mismatch = (format === "singles" && x.m.prefers === "doubles") || (format === "doubles" && x.m.prefers === "singles");
    const z = 0.55 + h.base + h.winPref[wi] + (x.friends.has(a) ? 1.3 : 0) - h.gap * Math.abs((x.m.rating || 1500) - (y.m.rating || 1500)) / 100 - h.trip * travelMin(x.m.area, v) - 1.4 * sat - h.b2b * b2b
      - (x.sore[w] ? (format === "singles" ? 1.8 : 0.6) : 0) - (x.busy[weekOfT(t)] ? 2 : 0) - (mismatch ? 1 : 0) - (notice < 24 ? h.notice : 0)
      + h.weekend * (we ? 1 : -0.3) + h.early * (slot.min === x.wins[wi].from ? 1 : -0.2) + h.home * (v.id === x.m.venue ? 1 : 0) + 0.3 * gaussK("noise", j, a, slot.date, slot.start)
      // let down by this asker before (their own experience), and the club's word on a flaky asker (which no agent sees)
      - 0.9 * Math.min(2, letDown(store, j, a, t)) - ((y.h?.flake ?? 0) >= 0.3 ? 0.6 : 0);
    return sig(z);
  }
  // the member's own Match helper suggesting a usual time (ask.js): taken or not
  function pSelf(store, i, slot, t) {
    const x = X.get(i), h = x.h, wi = winAt(x, slot), w = Math.floor(slot.day / 7), { wk, b2b } = loadOf(store, i, slot, t), sat = Math.max(0, wk - h.target + 1);
    return sig(0.9 + h.base + h.winPref[wi] - 1.4 * sat - h.b2b * b2b - (x.sore[w] ? 1.8 : 0) - (x.busy[weekOfT(t)] ? 2 : 0) + h.weekend * (slot.dow === 0 || slot.dow === 6 ? 1 : -0.3));
  }
  const prior = (a, j, v) => partnerScore(X.get(j).m, { intent: { with: [] }, opp: null, you: { weak: X.get(a).m.weak, level: X.get(a).m.level }, format: "singles", venue: v }).s;
  const nextDay = (fromDay, dow) => { for (let d = fromDay + 1; d <= fromDay + 7; d++) if (dateOfDay(d).getDay() === dow) return d; return fromDay + 7; };
  // the requests of one week: each member's Match helper suggests a usual time (taken or not), and members ask by themselves
  function events(store, w) {
    const ev = [];
    for (const x of all) {
      const i = x.id;
      if (u("helper", i, w) < 0.55) {
        const day = w * 7 + Math.floor(u("hd", i, w) * 3), t = tOf(day, 720);
        const cnt = x.wins.map((wd) => gamesOf(store, i).filter((g) => { const gt = (g._at ??= atOf(g.date, g.start)), sm = toMin(g.start); return new Date(gt).getDay() === wd.dow && sm >= wd.from && sm < wd.to && gt < t && t - gt <= 56 * DAY; }).length);
        const best = Math.max(0, ...cnt), wi = best > 0 ? cnt.indexOf(best) : (w + all.indexOf(x)) % x.wins.length, wd = x.wins[wi];
        if (!wd) continue;
        const st = wd.from + (wd.to - wd.from >= MIN + 60 && u("hs", i, w) < 0.5 ? 60 : 0);
        ev.push({ t, i, kind: "helper", slot: slotOf(nextDay(day, wd.dow), st) });
      }
      if (x.wins.length && u("text", i, w) < x.h.act * 0.35) {
        const t = base.getTime() + w * WEEK + Math.floor(u("tt", i, w) * WEEK), z = x.h.winPref.map((p) => Math.exp(p)), tot = z.reduce((p, q) => p + q, 0);
        let r0 = u("tw", i, w) * tot, wi = 0; for (; wi < z.length - 1 && (r0 -= z[wi]) > 0; wi++);
        const wd = x.wins[wi], st = wd.from + (wd.to - wd.from >= MIN + 60 && u("ts", i, w) < 0.5 ? 60 : 0);
        ev.push({ t, i, kind: "text", slot: slotOf(nextDay(Math.floor((t - base.getTime()) / DAY), wd.dow), st) });
      }
    }
    return ev.sort((p, q) => p.t - q.t || String(p.i).localeCompare(String(q.i)));
  }
  const gameOn = (store, id, date) => gamesOf(store, id).some((g) => g.date === date && !g.cancelled);
  // one week under a policy: policy(ctx) -> { order, probes, par, declared } (may be async)
  async function runWeek(store, w, policy, log, { K = 6, after = null } = {}) {
    for (const e of events(store, w)) {
      if (e.kind === "helper") {
        const yes = u("self", e.i, e.slot.date, e.slot.start) < pSelf(store, e.i, e.slot, e.t);
        store.own(e.i, { t: e.t, yes, src: "sim" });
        if (!yes) continue;
      }
      const a = e.i, slot = e.slot, A = X.get(a), tSlot = tOf(slot.day, slot.min);
      if (gameOn(store, a, slot.date) || tSlot - e.t < 3 * 36e5) continue;
      const cands = [], ruled = [];
      for (const x of all) {
        if (x.id === a || gameOn(store, x.id, slot.date) || winAt(x, slot) < 0) continue;
        const mv = middle(A, x), c = { id: x.id, m: x.m, v: mv.v, trip: mv.tb, prior: prior(a, x.id, mv.v) };
        (breaks(x, slot, mv.tb) ? ruled : cands).push(c);
      }
      log.requests ||= [];
      if (!cands.length) { log.requests.push({ w, a, agreed: false, asks: 0, probes: 0, rounds: 0, cands: 0 }); continue; }
      const ctx = { store, a, slot, t: e.t, w, cands, ruled, world: api };
      const { order, probes = 0, par = 1, declared = null } = await policy(ctx);
      let asks = 0, rounds = 0, agreed = null, released = 0, dropped = false;
      log.lastAsked = []; log.lastT = e.t;
      for (let k = 0; k < order.length && asks < K && !agreed; k += par) {
        rounds++;
        const yes = [];
        for (const c of order.slice(k, k + par)) {
          asks++; log.lastAsked.push(c.id);
          const p = c.ruled ? 0 : pTrue(store, c.id, a, slot, c.v, e.t), ok = !c.ruled && u("ask", c.id, a, slot.date, slot.start) < p && u("reach", c.id, a, slot.date) > 0.03;
          (log.asksWeek ||= {})[`${c.id}|${w}`] = (log.asksWeek[`${c.id}|${w}`] || 0) + 1;
          // after a yes, the asker may drop the game (a flaky asker more often): the member's agent sees its hold let go
          const drop = ok && u("drop", a, c.id, slot.date, slot.start) < A.h.flake;
          if (!c.ruled) {
            log.onAsk?.({ w, j: c.id, a, slot, v: c.v, trip: c.trip, t: e.t, y: ok ? 1 : 0, p, prior: c.prior });
            store.asked(c.id, { t: e.t, from: a, date: slot.date, start: slot.start, yes: ok, src: "sim", ...(drop ? { dropped: true, droppedAt: e.t + 36e5 } : {}) });
            (log.asked ||= {})[c.id] = (log.asked[c.id] || 0) + 1;
            if (declared?.has(c.id)) (log.ledger ||= []).push({ j: c.id, declared: declared.get(c.id), y: ok ? 1 : 0 });
          }
          if (ok && drop) { log.dropped = (log.dropped || 0) + 1; dropped = true; break; }
          if (ok) yes.push(c);
        }
        if (dropped) break; // the asker let it go: no game from this request
        if (yes.length) { agreed = yes[0]; released += yes.length - 1; }
      }
      for (const c of cands) (log.eligible ||= {})[c.id] = (log.eligible[c.id] || 0) + 1;
      if (agreed) {
        const over = Math.round((A.friends.has(agreed.id) ? 20 : 0) + 10 * gaussK("over", a, agreed.id, slot.date) - 3);
        // a booked game the asker cancels later (half as often as they drop): no game, and the member remembers it
        const cancel = u("cancel", a, agreed.id, slot.date, slot.start) < A.h.flake / 2, when = e.t + (tSlot - e.t) / 2, cx = cancel ? { cancelled: true, cancelledAt: when } : {};
        store.game(a, { t: e.t, date: slot.date, start: slot.start, minutes: MIN, with: [agreed.id], over, src: "sim", ...cx });
        store.game(agreed.id, { t: e.t, date: slot.date, start: slot.start, minutes: MIN, with: [a], over, src: "sim", ...cx });
        if (cancel) log.cancelled = (log.cancelled || 0) + 1;
        (log.games ||= {})[a] = (log.games[a] || 0) + 1; log.games[agreed.id] = (log.games[agreed.id] || 0) + 1;
      }
      log.requests.push({ w, a, agreed: !!agreed, asks, probes, rounds, released, cands: cands.length, firstYes: agreed ? asks : null, dropped });
      after?.(log);
    }
  }
  // the body log: the sore spells that were logged, as date ranges
  const soreSpells = (id) => { const x = X.get(id), out = []; for (let w = 0; w < x.soreLogged.length; w++) if (x.soreLogged[w]) { const last = out.at(-1), from = ymd(dateOfDay(w * 7)), to = ymd(dateOfDay(w * 7 + 6)); if (last && last.wk === w - 1) { last.to = to; last.wk = w; } else out.push({ from, to, wk: w }); } return out.map(({ wk, ...s }) => s); };
  // the logging policy: fit, history together, and noise, so the logs cover many members
  const logging = ({ store, a, cands, slot }) => ({ order: cands.map((c) => ({ c, s: c.prior + 1.5 * Math.log1p(gamesOf(store, a).filter((g) => g.with?.includes(c.id)).length) - 1.2 * Math.log(-Math.log(u("gumbel", a, c.id, slot.date, slot.start))) })).sort((p, q) => q.s - p.s).map((x) => x.c) });
  // a real date and start as a slot of this world (for an eval whose talks agree real dates)
  const slotFor = (date, start) => slotOf(Math.round((new Date(`${date}T12:00:00`) - new Date(base.getFullYear(), base.getMonth(), base.getDate(), 12)) / DAY), toMin(start));
  const api = { X, base, u, slotOf, slotFor, tOf, dateOfDay, winAt, middle, breaks, pTrue, pSelf, prior, events, runWeek, soreSpells, logging, members: all };
  return api;
}

// The demo club's history: eight weeks up to now under the logging policy, written to the records of the members in
// `only` (asks and games before now only; a game the sim would book next week is not a real booking).
export async function seedHistory(members, store, { only = null, now = new Date(), weeks = 8, seed = 7 } = {}) {
  const start = new Date(now); start.setDate(start.getDate() - weeks * 7);
  const W = makeWorld(members, { seed, start, weeks: weeks + 2 }), mem = { members: {} }, tmp = storeShim(mem);
  for (let w = 0; w < weeks; w++) await W.runWeek(tmp, w, W.logging, {});
  const t = now.getTime(), today = ymd(now); let n = 0;
  for (const m of members) {
    if (only && !only.has(m.id)) continue;
    const r = mem.members[m.id] || { asked: [], own: [], games: [] };
    for (const e of r.asked) if (e.t < t) { store.asked(m.id, e); n++; }
    for (const e of r.own) if (e.t < t) store.own(m.id, e);
    for (const g of r.games) if (atOf(g.date, g.start) < t) store.game(m.id, g);
    store.sore(m.id, W.soreSpells(m.id).filter((s) => s.from <= today));
    store.mark(m.id, "simulated", true);
  }
  return n;
}
// a records store in memory, with the same calls as records.js createStore (kept here so world.js needs nothing else)
function storeShim(db) {
  const rec = (id) => (db.members[id] ||= { asked: [], own: [], games: [], sore: [] });
  return {
    of: (id) => db.members[id] || { asked: [], own: [], games: [], sore: [] },
    asked: (id, e) => { rec(id).asked.push({ t: e.t, from: e.from, date: e.date, start: e.start, yes: e.yes ? 1 : 0, src: e.src || "sim", ...(e.dropped ? { dropped: 1, droppedAt: e.droppedAt ?? e.t } : {}) }); },
    own: (id, e) => { rec(id).own.push({ t: e.t, yes: e.yes ? 1 : 0, src: e.src || "sim" }); },
    game: (id, e) => { rec(id).games.push({ t: e.t, date: e.date, start: e.start, minutes: e.minutes || 90, with: e.with || [], over: e.over ?? null, src: e.src || "sim", ...(e.cancelled ? { cancelled: true, cancelledAt: e.cancelledAt ?? e.t } : {}) }); },
    sore: (id, s) => { rec(id).sore = s; },
    mark: () => {},
  };
}
export { storeShim };

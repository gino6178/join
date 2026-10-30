// "How likely is a yes", measured on a simulated club with the production code (docs/agent_matchmaking_plan.md, 7).
// No real player's data is read and no model server is needed (plain Node, CPU).
//   1. Offline. The logs (logs.mjs: population.js seed 7, 400 members, 26 weeks, hidden behaviour from
//      src/match/world.js). Train on weeks 0-17, calibrate on 18-20, test on 21-25, with a third of the members held
//      out of training and calibration altogether. AUC, Brier, log loss, ECE (cluster-bootstrap intervals over
//      members), reliability bins and plot, each band's observed yes rate; the rules, the asking side's own counts,
//      a2a.js memory, play.js's fit, boosted trees, the shipped model (src/match/model.json) and the truth.
//   2. Online. From the records at week 21, every ordering policy runs weeks 21-25 on the same requests and the same
//      draws (common random numbers). The band policies go through the production path: match/ask.js order() asks
//      each candidate's agent (match/likely.js answer(): rules, budgets, cache, audit, the shipped model) and gets a
//      band. Asks per agreed game, success@1/@3/@6, rounds and time to agreement (15 s a talk, scale.md's p50),
//      estimates and refusals, fairness (members never asked, Gini of asks, the most asks in a week), the bands'
//      observed yes rates as given online; with liars, refusals and randomized response.
//   node test/matchplan/likely_sim.mjs [out.json]      (from agent/; MP_MEMBERS=400, MP_SEED=7)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "serve_matchplan_sim_"));
for (const [k, v] of Object.entries({ BOOKINGS_FILE: `${tmp}/bookings.json`, A2A_FILE: `${tmp}/a2a.json`, NEGOTIATIONS_FILE: `${tmp}/neg.json`, LEDGER_FILE: `${tmp}/ledger.jsonl`, TRACE_FILE: `${tmp}/traces.jsonl`,
  MATCH_RECORDS_FILE: `${tmp}/records.json`, MATCH_AUDIT_FILE: `${tmp}/audit.json`, MATCH_STATE_FILE: `${tmp}/state.json`, A2A_TRANSPORT: "local", A2A_LEASE: "off" })) process.env[k] ||= v;
// (each run to a file of its own: the time of the run in its name unless a path is given; never one a doc cites)
const OUT = process.argv[2] || `test/matchplan/results/likely_sim_${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}.json`, N = +(process.env.MP_MEMBERS || 400), SEED = +(process.env.MP_SEED || 7), TALK_S = 15;
const { makeLogs, WEEKS, TRAIN_W, TEST_W0 } = await import("./logs.mjs");
const F = await import("../../src/match/fit.js");
const { createStore } = await import("../../src/match/records.js");
const { createState, answer: likelyAnswer } = await import("../../src/match/likely.js");
const { order, createLedger } = await import("../../src/match/ask.js");
const M = await import("../../src/match/model.js");
const { features, FEATURES, V1, dowOf } = await import("../../src/match/features.js");
const { breaks } = await import("../../src/a2a.js");
const { helpers } = await import("../../src/play.js");
const t0 = Date.now();

// ---- 1. the logs, and the offline check ----
const { members, world, rows, snapshot } = await makeLogs({ n: N, seed: SEED });
const u = world.u, y = (rs) => rs.map((r) => r.y);
const train = rows.filter((r) => r.w < TRAIN_W), cal = rows.filter((r) => r.w >= TRAIN_W && r.w < TEST_W0), test = rows.filter((r) => r.w >= TEST_W0);
const heldOut = new Set(members.filter((m) => u("heldout", m.id) < 1 / 3).map((m) => m.id));
const tr = train.filter((r) => !heldOut.has(r.j)), ca = cal.filter((r) => !heldOut.has(r.j)), mu = tr.reduce((a, r) => a + r.y, 0) / tr.length;
console.log(`logs: ${rows.length} asks answered (${train.length} train, ${cal.length} calibration, ${test.length} test), yes rate ${(rows.reduce((a, r) => a + r.y, 0) / rows.length).toFixed(3)}, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
// lr: every feature, the asker's reliability included; lr_v1: the 24 before it (the first shipped model's)
const v1 = (f) => f.slice(0, V1.length);
const lr = F.fitLR(tr.map((r) => r.f), y(tr)), lr1 = F.fitLR(tr.map((r) => v1(r.f)), y(tr)), lrw = F.fitLR(tr.map((r) => r.fw), y(tr)), gb = F.fitGBDT(tr.map((r) => r.f), y(tr));
const raw = { rules: (r) => M.ruleScore(r.f), asker: (r) => r.mine, lr: (r) => F.applyLR(lr, r.f), lr_v1: (r) => F.applyLR(lr1, v1(r.f)), lr_words: (r) => F.applyLR(lrw, r.fw), gbdt: (r) => gb(r.f) };
const iso = (k) => { const m = F.fitIsotonic(ca.map(raw[k]), y(ca), mu); return (r) => F.applyIsotonic(m, raw[k](r)); };
const calibrated = { prior: () => mu, rules: iso("rules"), asker: iso("asker"), lr_raw: raw.lr, lr_platt: ((c) => (r) => c(raw.lr(r)))(F.fitPlatt(ca.map(raw.lr), y(ca))), lr: iso("lr"), lr_v1: iso("lr_v1"), lr_words: iso("lr_words"), gbdt_raw: raw.gbdt, gbdt: iso("gbdt"),
  shipped: (r) => M.predict(r.f), truth: (r) => r.p };
// the two models the online policies compare, both from every member's rows of the training weeks
const allTr = train, allCa = cal, fitOn = (cols) => { const m = F.fitLR(allTr.map((r) => cols(r.f)), y(allTr)), k = F.fitIsotonic(allCa.map((r) => F.applyLR(m, cols(r.f))), y(allCa), mu); return { lr: m, iso: k }; };
const V1MODEL = M.compile({ version: "likely-lr-v1-sim", features: V1, ...fitOn(v1) }), V2MODEL = M.compile({ version: "likely-lr-v2-sim", features: FEATURES, ...fitOn((f) => f) });
const report = (rs) => Object.fromEntries(Object.entries(calibrated).map(([k, f]) => { const p = rs.map(f), yy = y(rs), a = F.auc(p, yy); return [k, { n: rs.length, auc: a && +a.toFixed(3), brier: +F.brier(p, yy).toFixed(4), logloss: +F.logloss(p, yy).toFixed(4), ece: +F.ece(p, yy).toFixed(4) }]; }));
function bootstrap(rs, fn, B = 200) {
  const by = new Map(); rs.forEach((r) => { if (!by.has(r.j)) by.set(r.j, []); by.get(r.j).push(r); });
  const groups = [...by.values()], out = [];
  for (let b = 0; b < B; b++) { const s = []; for (let k = 0; k < groups.length; k++) s.push(...groups[Math.floor(u("boot", b, k) * groups.length)]); out.push(fn(s)); }
  out.sort((p, q) => p - q); return [out[Math.floor(0.025 * B)], out[Math.floor(0.975 * B)]].map((v) => +v.toFixed(4));
}
const offline = { all: report(test), heldOutMembers: report(test.filter((r) => heldOut.has(r.j))), seenMembers: report(test.filter((r) => !heldOut.has(r.j))) };
// the asker's reliability where it can matter: asks from a flaky asker (one in ten drops a third of their games), and
// asks where this member had already said yes to this asker before
const flaky = (r) => (world.X.get(r.a).h.flake >= 0.3), before = (r) => r.f[5] > 0;
offline.reliability_gain = Object.fromEntries([["all", () => true], ["flakyAskers", flaky], ["memberSaidYesToAskerBefore", before], ["flakyAndBefore", (r) => flaky(r) && before(r)]].map(([k, f]) => {
  const rs = test.filter(f), m = (fn) => { const p = rs.map(fn), yy = y(rs); return { auc: +(F.auc(p, yy) ?? 0).toFixed(3), brier: +F.brier(p, yy).toFixed(4), ece: +F.ece(p, yy).toFixed(4) }; };
  return [k, { n: rs.length, yes: rs.length ? +(rs.reduce((a, r) => a + r.y, 0) / rs.length).toFixed(3) : null, without: m(calibrated.lr_v1), with: m(calibrated.lr) }];
}));
offline.orderings = { a2a_memory: +F.auc(test.map((r) => r.memory), y(test)).toFixed(3), play_partnerScore: +F.auc(test.map((r) => r.prior), y(test)).toFixed(3) };
offline.ci = Object.fromEntries(["lr", "shipped", "gbdt", "rules", "asker"].map((k) => [k, { ece: bootstrap(test, (s) => F.ece(s.map(calibrated[k]), y(s))), brier: bootstrap(test, (s) => F.brier(s.map(calibrated[k]), y(s))), auc: bootstrap(test, (s) => F.auc(s.map(calibrated[k]), y(s))) }]));
offline.reliability = Object.fromEntries(["lr", "lr_raw", "shipped", "gbdt", "rules", "asker"].map((k) => [k, F.bins(test.map(calibrated[k]), y(test))]));
offline.lrWeights = FEATURES.map((n, k) => [n, +lr.w[k + 1].toFixed(3)]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
offline.baseRate = { train: +mu.toFixed(3), test: +(test.reduce((a, r) => a + r.y, 0) / test.length).toFixed(3) };
offline.bands = M.BANDS.map((name, b) => { const rs = test.filter((r) => M.rank(M.bandOf(M.predict(r.f))) === b); return { band: name, range: M.RANGES[name], n: rs.length, share: +(rs.length / test.length).toFixed(3), observedYes: rs.length ? +(rs.reduce((a, r) => a + r.y, 0) / rs.length).toFixed(3) : null }; });
console.log("offline (test weeks):", JSON.stringify({ lr: offline.all.lr, shipped: offline.all.shipped, gbdt: offline.all.gbdt, rules: offline.all.rules, asker: offline.all.asker, truth: offline.all.truth }));

// ---- 2. online: every policy from the same records at week 21 ----
const club = { you: { rating: 1500 }, members }, venues = helpers.readVenues();
const LIARS = new Set(members.filter((m) => u("liar", m.id) < 0.1).map((m) => m.id)), REFUSE = new Set(members.filter((m) => u("refuse", m.id) < 0.15).map((m) => m.id));
const byPrior = (cs) => [...cs].sort((a, b) => b.prior - a.prior);
const req = (ctx) => ({ from: ctx.a, times: [{ date: ctx.slot.date, start: ctx.slot.start }], sport: "badminton", format: "singles", minutes: 90, now: ctx.t, seed: `${ctx.a}|${ctx.slot.date}|${ctx.slot.start}` });
// the production path: the members' agents answer estimates (likely.js) from their own records
// (opts.model: the model the members' agents use; opts.exact(id): the members who share the exact chance)
const viaBands = (opts = {}) => async (ctx) => {
  const cs = ctx.cands.map((c) => (opts.refuse && REFUSE.has(c.id) ? { ...c, m: { ...c.m, shares: { ...c.m.shares, likely: false } } } : opts.exact?.(c.id) ? { ...c, m: { ...c.m, shares: { ...c.m.shares, exact: true } } } : c));
  const o = await order(cs, { ...req(ctx), fair: opts.fair !== false }, { ...ctx.run, model: opts.model || V1MODEL, ...(opts.estimate ? { estimate: opts.estimate } : {}) });
  return { order: o, probes: o.filter((c) => c.probed).length, declared: new Map(o.filter((c) => c.probed).map((c) => [c.id, c.band])), par: opts.par || 1 };
};
const local = (m, r, ctx) => { const a = likelyAnswer(m, r, ctx); return a.refused ? { refused: true } : a; };
const policies = {
  random: ({ cands, slot, a }) => ({ order: [...cands].sort((p, q) => u("rand", a, p.id, slot.date) - u("rand", a, q.id, slot.date)) }),
  "play.js ranking (today)": ({ cands }) => ({ order: byPrior(cands) }),
  "play.js ranking, rule-breakers asked too": ({ cands, ruled }) => ({ order: byPrior([...cands, ...ruled.map((c) => ({ ...c, ruled: true }))]) }),
  "a2a.js memory, then play.js": ({ store, cands, slot }) => { const dh = `${dowOf(slot.date)}|${slot.start}`; return { order: cands.map((c) => ({ c, s: 10 * store.of(c.id).asked.reduce((a, e) => a + (`${dowOf(e.date)}|${e.start}` === dh ? (e.yes ? 2 : -3) : 0), 0) + c.prior })).sort((p, q) => q.s - p.s).map((x) => x.c) }; },
  "bands, top 12 by fit (fair exposure off)": viaBands({ fair: false }),
  "bands, fair exposure (the default)": viaBands(),
  "bands with the asker's reliability (MATCH_RELIABILITY=on)": viaBands({ model: V2MODEL }),
  "exact chance, every member shares it": viaBands({ exact: () => true }),
  "exact chance, a third of members share it": viaBands({ exact: (id) => u("exact", id) < 1 / 3 }),
  "exact chance, every member, fair exposure off": viaBands({ exact: () => true, fair: false }),
  "probability, top 12 by fit (no bands)": ({ store, cands, slot, t, a }) => ({ order: byPrior(cands).slice(0, 12).map((c) => ({ c, p: M.predict(features(store.of(c.id), { from: a, date: slot.date, start: slot.start, minutes: 90, format: "singles", now: t, gap: (c.m.rating || 1500) - (world.X.get(a).m.rating || 1500), trip: helpers.travelMin(c.m.area, venues.venues.find((v) => v.id === c.m.venue) || venues.venues[0]), prefersDoubles: c.m.prefers === "doubles" })) })).sort((p, q) => q.p - p.p).map((x) => x.c).concat(byPrior(cands).slice(12)) }),
  "bands, randomized response (eps 2)": viaBands({ estimate: (m, r, ctx) => { const a = local(m, r, ctx); if (!a.band) return a; const keep = Math.exp(2) / (Math.exp(2) + 3), r1 = u("rr", m.id, r.from, r.times[0].date, r.times[0].start), others = M.BANDS.filter((b) => b !== a.band); return { ...a, band: r1 < keep ? a.band : others[Math.floor(((r1 - keep) / (1 - keep)) * 3) % 3] }; } }),
  "bands, two at a time": viaBands({ par: 2 }),
  "bands, 1 in 10 agents inflate, no ledger": viaBands({ estimate: (m, r, ctx) => (LIARS.has(m.id) ? { band: "very likely", model: "x", until: 0 } : local(m, r, ctx)) }),
  "bands, 1 in 10 agents inflate, ledger": viaBands({ estimate: (m, r, ctx) => (LIARS.has(m.id) ? { band: "very likely", model: "x", until: 0 } : local(m, r, ctx)) }),
  "bands, 15% refuse": viaBands({ refuse: true }),
  "oracle (true chance, the same 12)": ({ store, cands, a, slot, t }) => ({ order: byPrior(cands).slice(0, 12).map((c) => ({ c, p: world.pTrue(store, c.id, a, slot, c.v, t) })).sort((p, q) => q.p - p.p).map((x) => x.c) }),
  "oracle (true chance, everyone free)": ({ store, cands, a, slot, t }) => ({ order: cands.map((c) => ({ c, p: world.pTrue(store, c.id, a, slot, c.v, t) })).sort((p, q) => q.p - p.p).map((x) => x.c) }),
};
const online = {};
for (const [name, pol] of Object.entries(policies)) {
  const store = createStore(null); store.replace(structuredClone(snapshot));
  const state = createState(null, { keep: 1e7 }), ledger = createLedger(null), useLedger = name.endsWith(", ledger");
  const run = { records: store, state, ledger: useLedger ? ledger : { ...ledger, flagged: () => false, outcome: () => {} }, club, venues, breaks, travelMin: helpers.travelMin };
  const log = {};
  const wrapped = (ctx) => pol({ ...ctx, run });
  // after each request: the asks sent this week (as a2a.js counts them through match/hooks.js), and the ledger
  const after = (lg) => { for (const id of lg.lastAsked || []) ledger.sent(id, lg.lastT); for (const e of (lg.ledger || []).splice(0)) { (lg.seen ||= []).push(e); if (useLedger) ledger.outcome(e.j, e.declared, e.y); } };
  for (let w = TEST_W0; w < WEEKS; w++) await world.runWeek(store, w, wrapped, log, { after });
  const rq = (log.requests || []).filter((r) => r.cands > 0), ok = rq.filter((r) => r.agreed), asks = rq.reduce((a, r) => a + r.asks, 0);
  const eligible = members.filter((m) => (log.eligible?.[m.id] || 0) >= 5), asked = eligible.map((m) => log.asked?.[m.id] || 0);
  const share = (set) => { const xs = eligible.filter((m) => set.has(m.id)); return xs.length ? +(xs.reduce((a, m) => a + (log.asked?.[m.id] || 0) / log.eligible[m.id], 0) / xs.length).toFixed(3) : null; };
  const audit = state.audit(), seen = log.seen || [];
  online[name] = { requests: rq.length, agreed: ok.length, successRate: +(ok.length / rq.length).toFixed(3), success1: +(ok.filter((r) => r.firstYes <= 1).length / rq.length).toFixed(3), success3: +(ok.filter((r) => r.firstYes <= 3).length / rq.length).toFixed(3),
    asksPerGame: +(asks / ok.length).toFixed(2), declinesPerRequest: +((asks - ok.length) / rq.length).toFixed(2), roundsWhenAgreed: +(ok.reduce((a, r) => a + r.rounds, 0) / ok.length).toFixed(2), secondsWhenAgreed: Math.round((TALK_S * ok.reduce((a, r) => a + r.rounds, 0)) / ok.length),
    estimatesPerRequest: +(rq.reduce((a, r) => a + r.probes, 0) / rq.length).toFixed(1), estimates: audit.length, refused: audit.filter((a) => a.refused).length, cached: audit.filter((a) => a.cached).length, releasedYes: rq.reduce((a, r) => a + (r.released || 0), 0),
    askerDropped: log.dropped || 0, cancelledAfterBooking: log.cancelled || 0, exactGiven: audit.filter((a) => a.p != null).length,
    fairness: { eligibleMembers: eligible.length, neverAsked: +(asked.filter((v) => !v).length / eligible.length).toFixed(3), giniAsks: F.gini(asked), giniGames: F.gini(members.map((m) => log.games?.[m.id] || 0)), maxAsksInAWeek: Math.max(0, ...Object.values(log.asksWeek || {})) },
    ...(seen.length ? { bandsOnline: Object.fromEntries(M.BANDS.map((b) => { const xs = seen.filter((e) => e.declared === b); return [b, { asks: xs.length, observedYes: xs.length ? +(xs.reduce((a, e) => a + e.y, 0) / xs.length).toFixed(3) : null }]; })) } : {}),
    ...(name.includes("inflate") ? { liars: LIARS.size, liarsFlagged: [...LIARS].filter((id) => ledger.flagged(id)).length, honestFlagged: members.filter((m) => !LIARS.has(m.id) && ledger.flagged(m.id)).length } : {}),
    ...(name.includes("refuse") ? { askedPerEligible: { refusers: share(REFUSE), others: share(new Set(members.filter((m) => !REFUSE.has(m.id)).map((m) => m.id))) } } : {}) };
  console.log(name.padEnd(44), JSON.stringify(online[name]));
}

// ---- 3. inference: what single-time estimates tell a prober, with bands and with the exact chance ----
// 80 members, every hour from 08:00 to 21:00 of the first test week asked about one at a time (98 times), from one
// asker, budgets set aside to count what each answer carries. Two things to learn: whether the member is free and
// keeps their rules then (their schedule), and, at the hours they are free, whether they already have a game that week
// (private state). The scores: the band's rank; the exact chance as served (only from 0.15 up, else the band); and the
// exact chance with no floor, the design not chosen.
const attack = (() => {
  const store = createStore(null); store.replace(structuredClone(snapshot));
  const targets = members.filter((m) => u("target", m.id) < 0.25).slice(0, 80), asker = members.find((m) => !targets.includes(m))?.id;
  const day0 = TEST_W0 * 7, t = world.tOf(day0, 8 * 60), out = [];
  for (const m of targets) {
    const x = world.X.get(m.id), v = venues.venues.find((y) => y.id === m.venue) || venues.venues[0], trip = helpers.travelMin(m.area, v);
    const wk = store.of(m.id).games.some((g) => !g.cancelled && Math.floor((world.slotFor(g.date, g.start).day) / 7) === TEST_W0 && g.t <= t);
    for (let d = 0; d < 7; d++) for (let h = 8; h <= 21; h++) {
      const slot = world.slotOf(day0 + d, h * 60), dayGame = store.of(m.id).games.some((g) => !g.cancelled && g.date === slot.date && g.t <= t);
      const free = world.winAt(x, slot) >= 0 && !world.breaks(x, slot, trip) && !dayGame;
      const p = free ? M.predict(features(store.of(m.id), { from: asker, date: slot.date, start: slot.start, minutes: 90, format: "singles", now: t, gap: (m.rating || 1500) - (world.X.get(asker).m.rating || 1500), trip, prefersDoubles: m.prefers === "doubles" }), V1MODEL) : 0.02;
      out.push({ free: free ? 1 : 0, booked: wk ? 1 : 0, band: M.rank(M.bandOf(p)), exact: M.exactOf(p) ?? 0, raw: +(Math.round(p / 0.05) * 0.05).toFixed(2) });
    }
  }
  const aucOf = (rs, k, lab) => +(F.auc(rs.map((r) => r[k]), rs.map((r) => r[lab])) ?? 0).toFixed(3), freeRows = out.filter((r) => r.free);
  const distinct = (k) => new Set(out.map((r) => r[k])).size;
  return { targets: targets.length, probesEach: 98, rows: out.length, freeShare: +(freeRows.length / out.length).toFixed(3),
    schedule: { bands: aucOf(out, "band", "free"), exact: aucOf(out, "exact", "free"), exactNoFloor: aucOf(out, "raw", "free") },
    alreadyBookedThatWeek: { bands: aucOf(freeRows, "band", "booked"), exact: aucOf(freeRows, "exact", "booked"), exactNoFloor: aucOf(freeRows, "raw", "booked") },
    distinctAnswers: { bands: distinct("band"), exact: distinct("exact"), exactNoFloor: distinct("raw") },
    budget: { perAskerWeek: 10, weeksToProbeAWeek: Math.ceil(98 / 10), perMemberWeekFromAllAskers: 40 } };
})();
console.log("inference:", JSON.stringify(attack));

// ---- results, and a reliability plot (SVG) ----
const out = { at: new Date().toISOString(), members: N, seed: SEED, model: M.version(), weeks: { train: [0, TRAIN_W - 1], calibration: [TRAIN_W, TEST_W0 - 1], test: [TEST_W0, WEEKS - 1] }, heldOutMembers: heldOut.size,
  rows: { train: train.length, calibration: cal.length, test: test.length, trainUsed: tr.length, calibrationUsed: ca.length }, features: FEATURES, cuts: M.CUTS, bands: M.BANDS, offline, online, attack, seconds: +((Date.now() - t0) / 1000).toFixed(1) };
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
const W = 420, H = 420, P = 50, sx = (v) => P + v * (W - 2 * P), sy = (v) => H - P - v * (H - 2 * P);
const lines = [["shipped", "#2f6fdf", "shipped model (logistic, isotonic)"], ["lr_raw", "#9bb8ef", "logistic, before calibration"], ["gbdt", "#1b9e77", "boosted trees, isotonic"], ["asker", "#d95f02", "asking side's own counts, isotonic"]];
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W + 230} ${H}" font-family="sans-serif" font-size="12"><rect width="100%" height="100%" fill="#fff"/>
<line x1="${sx(0)}" y1="${sy(0)}" x2="${sx(1)}" y2="${sy(1)}" stroke="#bbb" stroke-dasharray="4 4"/><line x1="${sx(0)}" y1="${sy(0)}" x2="${sx(1)}" y2="${sy(0)}" stroke="#333"/><line x1="${sx(0)}" y1="${sy(0)}" x2="${sx(0)}" y2="${sy(1)}" stroke="#333"/>
${[0, 0.2, 0.4, 0.6, 0.8, 1].map((v) => `<text x="${sx(v)}" y="${sy(0) + 16}" text-anchor="middle">${v}</text><text x="${sx(0) - 8}" y="${sy(v) + 4}" text-anchor="end">${v}</text>`).join("")}
<text x="${sx(0.5)}" y="${H - 10}" text-anchor="middle">predicted chance of a yes</text><text x="14" y="${sy(0.5)}" transform="rotate(-90 14 ${sy(0.5)})" text-anchor="middle">share that said yes</text>
${lines.map(([k, c], li) => { const pts = offline.reliability[k].filter((b) => b.n >= 20); return `<polyline fill="none" stroke="${c}" stroke-width="2" points="${pts.map((b) => `${sx(b.meanP).toFixed(1)},${sy(b.observed).toFixed(1)}`).join(" ")}"/>${pts.map((b) => `<circle cx="${sx(b.meanP).toFixed(1)}" cy="${sy(b.observed).toFixed(1)}" r="3" fill="${c}"/>`).join("")}<rect x="${W - 20}" y="${60 + li * 22}" width="12" height="12" fill="${c}"/><text x="${W - 2}" y="${70 + li * 22}">${lines[li][2]}</text>`; }).join("\n")}
<text x="${P}" y="20" font-size="13">Reliability on the test weeks (simulated club, ${test.length} asks; bins with 20+ asks)</text></svg>`;
fs.writeFileSync(path.join(path.dirname(OUT), path.basename(OUT).replace(/^likely_sim/, "reliability").replace(/\.json$/, "") + ".svg"), svg);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nwrote ${OUT} and reliability.svg in ${out.seconds} s`);

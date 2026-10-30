// Agent matchmaking end to end, on the real code (docs/agent_matchmaking_plan.md, 7.2 and 12): simulated members only.
// 300 simulated members (population.js, seed 7) with eight weeks of history in their own records (src/match/world.js:
// asks answered, games, their own Match helper's suggestions, askers who dropped or cancelled). Then EVAL_N requests:
// a member wants a game at one of their usual times in the next week (EVAL_TODAY=1: later today). Arms, on the same
// requests and the same draws (EVAL_ARMS, comma-separated):
//   play.js    whom to ask in play.js's order (partnerScore), as before matchmaking
//   bands      the twelve candidates' agents give a band first (match/ask.js order), with the model in use
//   bands-alt  the same, with another model (EVAL_ALT_MODEL: src/match/model_reliability.json, the asker's reliability)
//   exact      every member shares the exact chance (rounded to 0.05, from 0.15 up)
//   two        bands, two talks at once: when both agree, the first in the order gets the game and the other member's
//              agent hears a polite release (a serve.hold release, "taken"); holds are on with EVAL_TODAY
// Each candidate in order (four at most, or four pairs) gets the real talk (a2a.js negotiate). When the agents agree,
// the member says yes or no as world.js says they would (the human's yes, which the band predicts); a flaky asker may
// then drop the game, which the member's agent records. A no goes on to the next.
//   node test/match_eval.mjs [out.json]      EVAL_N=40; EVAL_A2A=1 over A2A; A2A_ROUTE=off for Muse Glimmer in every talk
// Muse Glimmer: LLM_URL (the A100 test endpoint, http://127.0.0.1:11446/v1).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "serve_matchplan_eval_")), TODAY = process.env.EVAL_TODAY === "1";
for (const [k, v] of Object.entries({ A2A_LEASE: TODAY ? "on" : "off", SIM_ONLY: "1", SIM_MEMBERS: "300", A2A_TRANSPORT: process.env.EVAL_A2A === "1" ? "" : "local", BOOKINGS_FILE: `${tmp}/bookings.json`, A2A_FILE: `${tmp}/a2a.json`, NEGOTIATIONS_FILE: `${tmp}/neg.json`,
  TRACE_FILE: `${tmp}/traces.jsonl`, LEDGER_FILE: `${tmp}/ledger.jsonl`, MATCH_RECORDS_FILE: `${tmp}/records.json`, MATCH_AUDIT_FILE: `${tmp}/audit.json`, MATCH_STATE_FILE: `${tmp}/state.json`, MATCH_SETTINGS_FILE: `${tmp}/settings.json`, MATCH_MODELS_DIR: `${tmp}/models`, MATCH_DEMO_RECORDS: "0" })) process.env[k] ||= v;
const { serveA2A } = await import("./a2a_local.mjs");
const server = await serveA2A(`${tmp}/a2a-tasks`);
const { readClub } = await import("../src/club.js");
const { negotiate, forgetMemory, releaseHolds } = await import("../src/a2a.js");
const { helpers, partnerScore, release } = await import("../src/play.js");
const ledger = await import("../src/ledger.js");
const { makeWorld, seedHistory } = await import("../src/match/world.js");
const R = await import("../src/match/records.js");
const L = await import("../src/match/likely.js");
const A = await import("../src/match/ask.js");
const M = await import("../src/match/model.js");
const { rankMembers } = await import("../src/match/rank.js");
const { turnedAway } = await import("../src/match/flow.js");
const { gini } = await import("../src/match/fit.js");

// (each run to a file of its own: the time of the run in its name unless a path is given; never one a doc cites)
const OUT = process.argv[2] || `test/matchplan/results/match_eval_${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}.json`, N = +(process.env.EVAL_N || 40), K = 4, SEED = 7;
const club = readClub(), members = club.members, venues = helpers.readVenues();
// (for today's games the eval runs as at noon, so the evening is still ahead)
const now = TODAY ? (() => { const d = new Date(); d.setHours(12, 0, 0, 0); return d; })() : new Date();
const start = new Date(now); start.setDate(start.getDate() - 56);
const world = makeWorld(members, { seed: SEED, start, weeks: 12 }), u = world.u;
R.useStore(R.createStore(null));
const asked = await seedHistory(members, R.store(), { now, weeks: 8, seed: SEED });
const snapshot = structuredClone(R.store().raw().members);
const inUse = M.current(), v1 = process.env.EVAL_ALT_MODEL ? M.compile(JSON.parse(fs.readFileSync(process.env.EVAL_ALT_MODEL, "utf8"))) : null;
console.log(`${members.length} simulated members, ${asked} asks in their records, model ${inUse?.version}${v1 ? ` (and ${v1.version})` : ""}, Muse Glimmer at ${process.env.LLM_URL || "(default)"}, ${process.env.EVAL_A2A === "1" ? "over A2A" : "in process"}${TODAY ? ", games today" : ""}`);

// the requests: a member wants a game at one of their usual times (the same in every arm)
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const requests = [];
for (let k = 0; requests.length < N && k < N * 40; k++) {
  const a = members[Math.floor(u("eval-asker", k) * members.length)], x = world.X.get(a.id);
  if (!x.wins.length || a.prefers === "doubles") continue;
  let wins = x.wins;
  if (TODAY) { wins = x.wins.filter((w) => w.dow === now.getDay() && w.from >= 15 * 60); if (!wins.length) continue; }
  const z = wins.map((w) => Math.exp(x.h.winPref[x.wins.indexOf(w)])), tot = z.reduce((p, q) => p + q, 0); let r0 = u("eval-win", k) * tot, wi = 0; for (; wi < z.length - 1 && (r0 -= z[wi]) > 0; wi++);
  const w = wins[wi]; let d = new Date(now); if (!TODAY) { d.setDate(d.getDate() + 1); while (d.getDay() !== w.dow) d.setDate(d.getDate() + 1); }
  const st = w.from + (w.to - w.from >= 150 && u("eval-st", k) < 0.5 ? 60 : 0);
  requests.push({ k, a, date: ymd(d), day: helpers.DAYS[d.getDay()], start: helpers.hm(st), min: st, win: `${helpers.DAYS[d.getDay()]} ${String(w.from / 60).padStart(2, "0")}-${w.to / 60}` });
}
const freeAt = (m, q) => helpers.windows(m.free).some((w) => w.day === new Date(`${q.date}T12:00`).getDay() && w.from <= q.min && q.min + 90 <= w.to);
const gameOn = (id, date) => R.store().of(id).games.some((g) => g.date === date && !g.cancelled);

async function arm(name) {
  R.store().replace(structuredClone(snapshot)); L.useState(L.createState(null)); A.useLedger(A.createLedger(null)); forgetMemory();
  const par = name === "two" ? 2 : 1, exact = name === "exact";
  M.use(name === "bands-alt" ? v1 : inUse);
  for (const m of members) m.shares = { ...m.shares, exact }; // (the exact chance for every member, in its arm only)
  const t0 = Date.now(), rows = [], timesAsked = {}, eligible = {};
  for (const q of requests) {
    const s0 = Date.now(), me = { id: q.a.id, name: q.a.name, area: q.a.area, free: [q.win] };
    if (gameOn(q.a.id, q.date)) { rows.push({ k: q.k, skipped: "a game that day already" }); continue; }
    const cands = members.filter((m) => m.id !== q.a.id && (m.prefers === "any" || m.prefers === "singles") && freeAt(m, q) && !gameOn(m.id, q.date)).map((m) => {
      const mv = world.middle(world.X.get(q.a.id), world.X.get(m.id));
      return { m, v: mv.v, trip: mv.tb, prior: partnerScore(m, { intent: { with: [] }, opp: null, you: { weak: q.a.weak, level: q.a.level }, format: "singles", venue: mv.v }).s };
    }).filter((c) => !world.breaks(world.X.get(c.m.id), world.slotFor(q.date, q.start), c.trip));
    cands.forEach((c) => { eligible[c.m.id] = (eligible[c.m.id] || 0) + 1; });
    if (!cands.length) { rows.push({ k: q.k, skipped: "nobody free" }); continue; }
    let order;
    if (name !== "play.js") order = await rankMembers(cands.map((c) => c.m), { prior: (m) => cands.find((c) => c.m.id === m.id).prior, times: [{ date: q.date, start: q.start }], from: q.a.id, now: now.getTime() + (Date.now() - t0), seed: `eval|${q.k}` }).then((o) => o.map((x) => ({ ...cands.find((c) => c.m.id === x.m.id), band: x.band, p: x.p ?? null, probed: x.probed })));
    else order = [...cands].sort((p, q2) => q2.prior - p.prior);
    const est = (Date.now() - s0) / 1000;
    let talks = 0, agentsAgreed = 0, game = null, firstYes = null, away = 0, dropped = false;
    const detail = [];
    const talk = (c) => negotiate({ me, members: [c.m], venues, format: "singles", sport: "badminton", minutes: 90, prefer: { day: q.day, start: q.start }, exclude: Array.from({ length: 8 }, (_, i) => { const d = new Date(now); d.setDate(d.getDate() + i); return ymd(d); }).filter((d) => d !== q.date), now });
    for (let k = 0; k < Math.min(order.length, K * par) && !game && !dropped; k += par) {
      const group = order.slice(k, k + par);
      group.forEach((c) => { talks++; timesAsked[c.m.id] = (timesAsked[c.m.id] || 0) + 1; });
      const rs = await Promise.all(group.map(talk));
      const yes = [];
      group.forEach((c, i) => { detail.push({ band: c.band ?? null, p: c.p, agreed: !!rs[i].agreed, why: rs[i].agreed ? null : String(rs[i].reason || "").slice(0, 80), yes: null }); if (rs[i].agreed) yes.push([c, rs[i], detail.length - 1]); else A.ledger().outcome(c.m.id, c.band, false); });
      agentsAgreed += yes.length;
      // two at once, both agreed: the first in the order gets the game; the other is let go, politely, with no booking
      for (const [c, r] of yes.slice(1)) {
        if (process.env.A2A_LEASE !== "off") await releaseHolds(r.agreed, { why: "taken", say: turnedAway(c.m.name, r.agreed) });
        else R.store().released(c.m.id, r.agreed.talk, "taken");
        away++;
      }
      if (!yes.length) continue;
      const [c, r, di] = yes[0];
      // the member's own yes, as the simulated world says (the human's answer to the invite)
      const slot = world.slotFor(r.agreed.date, r.agreed.start), v = venues.venues.find((x) => x.id === r.agreed.venue.id) || c.v, p = world.pTrue(R.store(), c.m.id, q.a.id, slot, v, now.getTime());
      const ok = u("eval-yes", q.k, c.m.id) < p;
      Object.assign(detail[di], { yes: ok, p: +p.toFixed(3) });
      R.store().asked(c.m.id, { from: q.a.id, date: r.agreed.date, start: r.agreed.start, yes: ok, ref: r.agreed.talk, src: "invite" });
      A.ledger().outcome(c.m.id, c.band, ok);
      if (r.agreed.hold) release(r.agreed.hold); // (the eval does not book: the kept member's hold goes, unnoted)
      if (!ok) continue;
      // a flaky asker may drop the game after the yes: the member's agent records it, and this request ends
      if (u("eval-drop", q.k, c.m.id) < world.X.get(q.a.id).h.flake) { R.store().released(c.m.id, r.agreed.talk, "dropped"); dropped = true; break; }
      game = { with: c.m.id, date: r.agreed.date, start: r.agreed.start, band: c.band || null, p: +p.toFixed(3) }; firstYes = talks;
      R.store().game(q.a.id, { date: r.agreed.date, start: r.agreed.start, with: [c.m.id], ref: `${r.agreed.talk}:${q.a.id}` }); R.store().game(c.m.id, { date: r.agreed.date, start: r.agreed.start, with: [q.a.id], ref: `${r.agreed.talk}:${c.m.id}` });
    }
    rows.push({ k: q.k, asker: q.a.id, when: `${q.day} ${q.start}`, cands: cands.length, estimates: order.filter((c) => c.probed).length, talks, agentsAgreed, turnedAway: away, dropped, game, firstYes, detail, estSeconds: +est.toFixed(2), seconds: +((Date.now() - s0) / 1000).toFixed(1) });
    process.stdout.write(game ? "+" : dropped ? "x" : "-");
  }
  for (const m of members) m.shares = { ...m.shares, exact: false };
  const calls = ledger.calls(1e6).filter((c) => c.at >= t0), done = rows.filter((r) => !r.skipped), ok = done.filter((r) => r.game);
  const talksAll = done.reduce((a, r) => a + r.talks, 0), secs = done.map((r) => r.seconds).sort((p, q) => p - q), el = Object.keys(eligible).filter((id) => eligible[id] >= 2), agreedRows = ok.map((r) => r.seconds).sort((p, q) => p - q);
  const s = { arm: name, model: M.version(), requests: done.length, agreed: ok.length, successRate: +(ok.length / done.length).toFixed(3), success1: +(ok.filter((r) => r.firstYes === 1).length / done.length).toFixed(3), success3: +(ok.filter((r) => r.firstYes <= 3).length / done.length).toFixed(3),
    talks: talksAll, talksPerGame: +(talksAll / Math.max(1, ok.length)).toFixed(2), agentsAgreedButMemberSaidNo: done.reduce((a, r) => a + r.agentsAgreed - r.turnedAway, 0) - ok.length - done.filter((r) => r.dropped).length, yesesTurnedAway: done.reduce((a, r) => a + r.turnedAway, 0), askerDropped: done.filter((r) => r.dropped).length,
    secondsPerRequest: { mean: +(secs.reduce((a, b) => a + b, 0) / secs.length).toFixed(1), p50: secs[Math.floor(secs.length / 2)], p95: secs[Math.floor(secs.length * 0.95)] },
    secondsToAgreement: { mean: +(agreedRows.reduce((a, b) => a + b, 0) / Math.max(1, agreedRows.length)).toFixed(1), p50: agreedRows[Math.floor(agreedRows.length / 2)] ?? null }, estimateSeconds: +(done.reduce((a, r) => a + r.estSeconds, 0) / done.length).toFixed(2), estimatesPerRequest: +(done.reduce((a, r) => a + r.estimates, 0) / done.length).toFixed(1),
    modelCalls: calls.length, modelCallsPerGame: +(calls.length / Math.max(1, ok.length)).toFixed(2), modelSecondsPerCall: calls.length ? +(calls.reduce((a, c) => a + (c.seconds || 0), 0) / calls.length).toFixed(1) : null, tokens: ledger.totals(calls),
    fairness: { eligibleTwice: el.length, neverAsked: +(el.filter((id) => !timesAsked[id]).length / Math.max(1, el.length)).toFixed(3), giniAsks: gini(el.map((id) => timesAsked[id] || 0)) },
    bandsAtTalks: Object.fromEntries(["unlikely", "maybe", "likely", "very likely", null].map((b) => { const xs = done.flatMap((r) => r.detail).filter((e) => e.band === b), ag = xs.filter((e) => e.agreed && e.yes != null); return [String(b), { talks: xs.length, agentsAgreed: ag.length, memberSaidYes: ag.filter((e) => e.yes).length, yesRate: ag.length ? +(ag.filter((e) => e.yes).length / ag.length).toFixed(3) : null, meanTrueChance: ag.length ? +(ag.reduce((a, e) => a + e.p, 0) / ag.length).toFixed(3) : null }]; })),
    notAgreed: done.flatMap((r) => r.detail).filter((e) => !e.agreed).reduce((a, e) => { const k = e.why.replace(/\d+/g, "#").slice(0, 60); a[k] = (a[k] || 0) + 1; return a; }, {}),
    refused: L.state().audit((a) => a.refused).length, exactGiven: L.state().audit((a) => a.p != null).length, seconds: +((Date.now() - t0) / 1000).toFixed(1) };
  console.log(`\n${JSON.stringify(s)}`);
  return { summary: s, rows };
}
const out = { at: new Date().toISOString(), members: members.length, seed: SEED, requests: requests.length, today: TODAY, a2a: process.env.EVAL_A2A === "1", route: process.env.A2A_ROUTE || "on", model: process.env.LLM_URL || null, arms: {} };
for (const name of (process.env.EVAL_ARMS || "play.js,bands").split(",")) { out.arms[name] = await arm(name); fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(out, null, 1)); }
M.use(inUse);
server?.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`wrote ${OUT}`);
process.exit(0);

// How faithfully the members' agents keep their members' rules, on a club of simulated strangers (population.js) whose
// rules are known: no games on a day, home by a time, a longest trip, a longest game. This measures whether agents
// follow what their member stated, not how real people behave.
// The player is free all week. For each member with a hard rule that can come up, your agent asks for a time that
// breaks it: a day they don't play (when their calendar has it free), a game that ends after their latest, only venues
// beyond their longest trip, or a 90-minute game for someone who plays 60 at most. Then the two agents negotiate (the
// real code; Muse Glimmer on the server). A violation is an agreed game that breaks the member's rule. Two arms, on the
// same members and times:
//   model  the rule is in the words the member's agent reads, and the model keeps it (MEMBER_RULES=model)
//   code   the same words, and code takes the times that break a rule off the list first (the default)
//   node test/persona_eval.mjs [out.json]         PERSONA_N=60 members, PERSONA_PAR=4 talks at once
//   EVAL_A2A=1 the members' agents answer over A2A, on a local port (test/a2a_local.mjs)
import fs from "node:fs";

// (holds off, A2A_LEASE: this measures the agreement itself, and a time held in one talk would change the next)
// (and every answer from the model, A2A_ROUTE and A2A_STUDENT off: this measures what the model does)
for (const [k, v] of Object.entries({ A2A_ROUTE: "off", A2A_STUDENT: "off", A2A_LEASE: "off", BOOKINGS_FILE: "data/persona-bookings.json", NEGOTIATION_DETAIL: "1", SIM_ONLY: "1", SIM_MEMBERS: "300", A2A_TRANSPORT: process.env.EVAL_A2A === "1" ? "" : "local", A2A_FILE: "data/persona-a2a.json", NEGOTIATIONS_FILE: "data/persona-negotiations.json",
  TRACE_FILE: "data/persona-traces.jsonl", LEDGER_FILE: "data/persona-ledger.jsonl" })) process.env[k] ||= v;
const { serveA2A, a2aOn } = await import("./a2a_local.mjs");
const a2aServer = await serveA2A("data/persona-a2a-tasks");
const { population } = await import("../src/population.js");
const { negotiate, shared, court, breaks, forgetMemory } = await import("../src/a2a.js");
const { readClub } = await import("../src/club.js");
const { helpers } = await import("../src/play.js");
const ledger = await import("../src/ledger.js");
const { toMin, hm, travelMin } = helpers;
const OUT = process.argv[2] || "data/persona_eval.json", N = +(process.env.PERSONA_N || 60), PAR = +(process.env.PERSONA_PAR || 4), MIN = 90;
const club = readClub(), venues = helpers.readVenues(), now = new Date();
const me = { id: "you", name: "You", area: club.you.area, free: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => `${d} 08-22`) };
const wilson = (k, n) => { if (!n) return [0, 0]; const z = 1.96, p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)); return [+((c - h) / d).toFixed(3), +((c + h) / d).toFixed(3)]; };
const RULES = ["noDays", "endBy", "maxTrip", "maxMinutes"];

// the members, and a time that breaks one of their rules (the first rule that can come up)
const cases = [];
for (const m of population(300)) {
  if (cases.length >= N) break;
  if (!Object.keys(m.rules).length || m.prefers === "doubles" || !m.sports.includes("badminton")) continue;
  const times = shared([me, m], MIN, now), R = m.rules;
  let c = null;
  if (R.noDays) { const s = times.find((x) => R.noDays.includes(x.day)); if (s) c = { rule: "noDays", prefer: { day: s.day, start: hm(s.from) } }; }
  if (!c && R.endBy) { // a start whose game ends half an hour after their latest, inside a shared window
    for (const s of times) { const st = Math.max(s.from, Math.ceil((toMin(R.endBy) - MIN + 30) / 30) * 30); if (st + MIN <= s.to) { c = { rule: "endBy", prefer: { day: s.day, start: hm(st) } }; break; } }
  }
  if (!c && R.maxTrip != null && m.area) { // only venues farther than they travel
    const far = { ...venues, venues: venues.venues.filter((v) => travelMin(m.area, v) > R.maxTrip) };
    if (far.venues.length && times.length) c = { rule: "maxTrip", prefer: { day: times[0].day, start: hm(times[0].from) }, venues: far };
  }
  if (!c && R.maxMinutes && times.length) c = { rule: "maxMinutes", prefer: { day: times[0].day, start: hm(times[0].from) } };
  if (!c) continue;
  // is there a listed time that keeps to every rule (so a counter could land), or is "not this week" the only right answer?
  const vs = c.venues || venues;
  const offers = times.flatMap((s) => [s.from, ...(s.to - s.from >= MIN + 60 ? [s.from + 60] : [])].map((st) => { const k = court(s, st, MIN, [me, m], vs); return k && { slot: s, start: st, c: k }; })).filter(Boolean);
  cases.push({ m, ...c, keepable: offers.some((x) => !breaks(m, x, MIN)) });
}
console.log(`${cases.length} members, each asked for a time that breaks a rule: ${RULES.map((k) => `${k} ${cases.filter((c) => c.rule === k).length}`).join(", ")}; ${cases.filter((c) => c.keepable).length} could move to a time that keeps it`);

async function arm(mode) {
  process.env.MEMBER_RULES = mode; forgetMemory();
  const t0 = Date.now(), rows = [];
  let i = 0;
  await Promise.all(Array.from({ length: PAR }, async () => {
    while (i < cases.length) {
      const c = cases[i++];
      let r, err = null;
      try { r = await negotiate({ me, members: [c.m], venues: c.venues || venues, customVenues: !!c.venues, format: "singles", sport: "badminton", minutes: MIN, prefer: c.prefer, now }); } catch (e) { err = String(e.message || e); }
      const g = r?.agreed, x = g && { slot: { day: g.day }, start: toMin(g.start), trip: g.travel.find((t) => t.id === c.m.id)?.min ?? null };
      const broke = x ? breaks(c.m, x, MIN) : null;
      // the times that work for this member (T), what its agent's model said (R) and what was binding (F), over the times offered
      const off = r?.offered || [], T = off.filter((x) => !breaks(c.m, { slot: { day: x.day }, start: toMin(x.start), trip: x.trips[c.m.id] ?? null }, MIN)).map((x) => x.id);
      const R = r?.acceptableRaw?.[c.m.id] ?? null, F = r?.acceptable?.[c.m.id] ?? null;
      rows.push({ member: c.m.id, rules: c.m.rules, rule: c.rule, asked: `${c.prefer.day} ${c.prefer.start}`, keepable: c.keepable, agreed: g ? `${g.day} ${g.start} at ${g.venue.name}` : null, broke, rounds: r?.rounds ?? null,
        sets: off.length ? { offered: off.length, T, R, F } : null,
        reason: g ? null : r?.reason || err, said: (r?.log || []).filter((y) => y.from === c.m.id).map((y) => `${y.intent}:${y.tier}`) });
    }
  }));
  const calls = ledger.calls(100000).filter((c) => c.at >= t0), agreed = rows.filter((x) => x.agreed), broke = agreed.filter((x) => x.broke);
  const s = { mode, members: rows.length, agreed: agreed.length, broke: broke.length, brokeOfAll: +(broke.length / Math.max(1, rows.length)).toFixed(3), brokeOfAllCI95: wilson(broke.length, rows.length),
    movedToAKeptTime: rows.filter((x) => x.keepable && x.agreed && !x.broke).length, keepable: rows.filter((x) => x.keepable).length,
    meanRounds: +(rows.reduce((a, x) => a + (x.rounds || 0), 0) / Math.max(1, rows.length)).toFixed(2), seconds: +((Date.now() - t0) / 1000).toFixed(1), tokens: ledger.totals(calls), byRule: {} };
  for (const k of RULES) { const xs = rows.filter((x) => x.rule === k); s.byRule[k] = { asked: xs.length, agreed: xs.filter((x) => x.agreed).length, broke: xs.filter((x) => x.broke).length }; }
  // the acceptable sets, graded: precision (of the times an agent said work, how many do) and recall (of the times that
  // work, how many it said), summed over every talk; R is the model's own list, F the binding one after code
  const grade = (key) => { let tp = 0, fp = 0, fn = 0, exact = 0, n = 0;
    for (const x of rows) { const S = x.sets?.[key]; if (!x.sets || !Array.isArray(S)) continue; n++; const T = new Set(x.sets.T), P = new Set(S);
      tp += [...P].filter((i) => T.has(i)).length; fp += [...P].filter((i) => !T.has(i)).length; fn += [...T].filter((i) => !P.has(i)).length; if ([...P].every((i) => T.has(i)) && [...T].every((i) => P.has(i))) exact++; }
    return n ? { talks: n, precision: +(tp / Math.max(1, tp + fp)).toFixed(3), recall: +(tp / Math.max(1, tp + fn)).toFixed(3), exact, falseWorks: fp, missedWorks: fn, precisionCI95: wilson(tp, tp + fp), recallCI95: wilson(tp, tp + fn) } : null; };
  s.sets = { model: grade("R"), binding: grade("F") };
  console.log(JSON.stringify(s));
  return { summary: s, rows };
}
const out = { at: new Date().toISOString(), transport: a2aOn() ? "a2a" : "in-process", cases: cases.length, arms: {} };
// PERSONA_ARMS=code runs one arm (to compare a setting, such as LLM_BUDGETS, against an earlier run)
const ARMS = (process.env.PERSONA_ARMS || "model,code").split(",");
out.budgets = process.env.LLM_BUDGETS || null;
for (const mode of ARMS) { out.arms[mode] = await arm(mode); fs.writeFileSync(OUT, JSON.stringify(out, null, 1)); }
console.log("\n" + ARMS.map((k) => { const s = out.arms[k].summary; return `${k}: ${s.broke} of ${s.members} talks ended in a game that breaks the member's rule (${(s.brokeOfAll * 100).toFixed(0)}%, 95% CI ${s.brokeOfAllCI95.map((v) => (v * 100).toFixed(0)).join("-")}%); ${s.agreed} agreed; ${s.movedToAKeptTime} of ${s.keepable} moved to a time that keeps it; ${s.tokens.calls} model calls, ${s.seconds} s`; }).join("\n"));
if (a2aServer) { a2aServer.closeAllConnections(); a2aServer.close(); }

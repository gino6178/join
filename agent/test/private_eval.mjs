// Private calendars against a gateway that sees every calendar, on the same talks (simulated members, the real code,
// Muse Glimmer on the server).
//   shared   your agent lists only the times that fit every calendar (it knows them), as Serve does by default
//   private  your agent knows only your own week (A2A_PRIVATE=1): it lists times from it, each member's agent checks
//            them against its own calendar and rules in code, and a round with no time for everyone rules those out
//            and lists the next twelve (three rounds at most)
// For each: how many talks agreed, out of those where a time that works for everyone exists (with a court); how many
// rounds; model calls and tokens; time; whether any agreed game breaks a member's calendar or rules; and what your agent
// was told about the members' weeks (every free window, or one yes or no per listed time).
//   node test/private_eval.mjs [out.json]     PRIVATE_N=40 one-to-one talks, PRIVATE_D=10 doubles
import fs from "node:fs";

// (holds off, A2A_LEASE: this measures the agreement itself, and a time held in one talk would change the next)
// (and every answer from the model, A2A_ROUTE and A2A_STUDENT off: this measures what the model does)
for (const [k, v] of Object.entries({ A2A_ROUTE: "off", A2A_STUDENT: "off", A2A_LEASE: "off", BOOKINGS_FILE: "data/private-bookings.json", SIM_ONLY: "1", SIM_MEMBERS: "300", A2A_TRANSPORT: "local", A2A_FILE: "data/private-a2a.json", NEGOTIATIONS_FILE: "data/private-negotiations.json",
  TRACE_FILE: "data/private-traces.jsonl", LEDGER_FILE: "data/private-ledger.jsonl" })) process.env[k] ||= v;
const { population } = await import("../src/population.js");
const { negotiate, shared, court, breaks, forgetMemory, when } = await import("../src/a2a.js");
const { readClub } = await import("../src/club.js");
const { helpers } = await import("../src/play.js");
const ledger = await import("../src/ledger.js");
const OUT = process.argv[2] || "data/private_eval.json", N = +(process.env.PRIVATE_N || 40), ND = +(process.env.PRIVATE_D || 10), MIN = 90, PAR = 4, now = new Date();
const club = readClub(), venues = helpers.readVenues();
// a player with a usual week: four evenings or mornings free (fewer than twelve times to list, so one round lists them
// all); PRIVATE_WEEK=all, a player free every day 08-22, so a search over more than one round is needed
const me = { id: "you", name: "You", area: club.you.area, free: process.env.PRIVATE_WEEK === "all" ? ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => `${d} 08-22`) : ["Mon 19-22", "Wed 18-21", "Sat 09-13", "Sun 14-18"] };
const pop = population(300);
// "possible": a time that works for everyone, with a court, exists among the times the shared design lists (two
// starts per free stretch). It is the yardstick for both arms; private mode may also find one the listing skips.
const feasible = (ms) => shared([me, ...ms], MIN, now).some((s) => [s.from, ...(s.to - s.from >= MIN + 60 ? [s.from + 60] : [])].some((st) => { const c = court(s, st, MIN, [me, ...ms], venues); return c && ms.every((m) => !breaks(m, { slot: s, start: st, c }, MIN)); }));
const cases = [];
for (let i = 0; cases.length < N && i < pop.length; i += 7) cases.push({ members: [pop[i]], format: "singles" });
for (let i = 3; cases.length < N + ND && i + 2 < pop.length; i += 23) cases.push({ members: [pop[i], pop[i + 1], pop[i + 2]], format: "doubles" });
cases.forEach((c) => { c.possible = feasible(c.members); });
// Every time that works for everyone, found by trying them all (the exact answer a search can be held to, as in
// CalBench, Zou et al. 2026): each hour a game fits in everyone's free time, with a court, keeping every rule. The
// player's own order of them is the one your agent ranks by with private calendars: the usual playing hours first
// (weekday 18-20, weekend 9-14), then the earliest.
const usual = (s, st) => (["Sat", "Sun"].includes(s.day) ? st >= 9 * 60 && st <= 14 * 60 : st >= 18 * 60 && st <= 20 * 60) ? 3 : 0;
// (every hour from the start of each shared stretch, as the private search lists them; the shared listing's two starts
// are among them)
const everyTime = (ms) => shared([me, ...ms], MIN, now).flatMap((s) => { const out = []; for (let st = s.from; st + MIN <= s.to; st += 60) { const c = court(s, st, MIN, [me, ...ms], venues); if (c && ms.every((m) => !breaks(m, { slot: s, start: st, c }, MIN))) out.push({ date: s.date, start: helpers.hm(st), day: s.day, st, u: usual(s, st) }); } return out; })
  .sort((a, b) => b.u - a.u || a.date.localeCompare(b.date) || a.st - b.st);
cases.forEach((c) => { c.every = everyTime(c.members); });
const at = (t) => new Date(`${t.date}T${t.start}`).getTime();
// a member's free hours, to say how much of a week a talk let your agent learn
const freeHours = (m) => m.free.reduce((a, w) => { const [f, t] = w.split(" ")[1].split("-").map(Number); return a + (t - f); }, 0);
console.log(`${cases.length} talks (${N} one-to-one, ${ND} doubles); a time that works for everyone exists in ${cases.filter((c) => c.possible).length}`);

async function arm(mode) {
  process.env.A2A_PRIVATE = mode === "private" ? "1" : ""; forgetMemory();
  const t0 = Date.now(), rows = [];
  let i = 0;
  await Promise.all(Array.from({ length: PAR }, async () => {
    while (i < cases.length) {
      const c = cases[i++], s0 = Date.now();
      let r;
      try { r = await negotiate({ me, members: c.members, venues, format: c.format, sport: "badminton", minutes: MIN, now }); } catch (e) { r = { reason: e.message }; }
      const g = r.agreed, x = g && { slot: { day: g.day }, start: helpers.toMin(g.start), trip: null };
      const broke = g ? c.members.map((m) => breaks(m, { ...x, trip: g.travel.find((t) => t.id === m.id)?.min ?? null }, MIN)).filter(Boolean) : [];
      // what your agent was told about the members' weeks
      const toldWindows = mode === "shared" ? c.members.reduce((a, m) => a + m.free.length, 0) : 0;
      const toldAnswers = (r.log || []).filter((y) => y.from !== "you").length;
      // against the exact answer: how far from the earliest time that works for everyone, and where in the player's own
      // order of those times; who gave way (the player, from the time it opened with; a member, from the time it asked for)
      const best = c.every[0], earliest = c.every.reduce((a, t) => (!a || at(t) < at(a) ? t : a), null);
      const rank = g ? c.every.findIndex((t) => t.date === g.date && t.start === g.start) : null;
      const asks = (r.log || []).filter((y) => y.from !== "you" && y.intent === "counter" && y.when);
      const playerGaveWay = !!(g && r.opening && (r.opening.date !== g.date || r.opening.start !== g.start));
      const membersGaveWay = g ? asks.filter((y) => !y.when.startsWith(when(g.date, g.start))).length : 0;
      // what your agent learned of the members' weeks: their whole free time (shared only), and one yes or no per listed
      // time and member (both); two different things, kept apart
      const freeHoursSeen = mode === "shared" ? c.members.reduce((a, m) => a + freeHours(m), 0) : 0;
      rows.push({ members: c.members.map((m) => m.id), format: c.format, possible: c.possible, every: c.every.length, agreed: g ? `${g.day} ${g.start}` : null, rounds: r.rounds ?? 0, broke, reason: g ? null : r.reason, seconds: (Date.now() - s0) / 1000, toldWindows, toldAnswers,
        rank, best: best ? `${best.day} ${best.start}` : null, delayHours: g && earliest ? +((at(g) - at(earliest)) / 36e5).toFixed(1) : null, playerGaveWay, memberAsks: asks.length, membersGaveWay, answers: r.asked || 0, freeHoursSeen, freeHours: c.members.reduce((a, m) => a + freeHours(m), 0) });
    }
  }));
  const calls = ledger.calls(100000).filter((c) => c.at >= t0), possible = rows.filter((r) => r.possible);
  const s = { mode, talks: rows.length, possible: possible.length, agreedWhenPossible: possible.filter((r) => r.agreed).length, agreedWhenNot: rows.filter((r) => !r.possible && r.agreed).length,
    broke: rows.filter((r) => r.broke.length).length, meanRounds: +(rows.reduce((a, r) => a + r.rounds, 0) / rows.length).toFixed(2), meanRoundsWhenAgreed: +(rows.filter((r) => r.agreed).reduce((a, r) => a + r.rounds, 0) / Math.max(1, rows.filter((r) => r.agreed).length)).toFixed(2),
    seconds: +((Date.now() - t0) / 1000).toFixed(1), tokens: ledger.totals(calls), toldWindows: rows.reduce((a, r) => a + r.toldWindows, 0), toldAnswers: rows.reduce((a, r) => a + r.toldAnswers, 0),
    roundsWhenAgreed: rows.filter((r) => r.agreed).reduce((a, r) => ({ ...a, [r.rounds]: (a[r.rounds] || 0) + 1 }), {}),
    // against the exact answer, over the talks that agreed where a time existed
    // (a time agreed but not in the exact list, rank -1, is counted apart, not in the means)
    ...(() => { const ok = rows.filter((r) => r.agreed && r.possible && r.rank != null && r.rank >= 0), mean = (xs) => (xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) : null);
      return { exact: { talks: ok.length, playersBest: ok.filter((r) => r.rank === 0).length, meanRank: mean(ok.map((r) => r.rank)), notListed: rows.filter((r) => r.agreed && r.rank === -1).length, meanDelayHours: mean(ok.map((r) => r.delayHours)),
        playerGaveWay: ok.filter((r) => r.playerGaveWay).length, memberAsks: ok.reduce((a, r) => a + r.memberAsks, 0), membersGaveWay: ok.reduce((a, r) => a + r.membersGaveWay, 0),
        freeHoursSeenPerTalk: mean(rows.map((r) => r.freeHoursSeen)), answersPerTalk: mean(rows.map((r) => r.answers)), freeHoursPerTalk: mean(rows.map((r) => r.freeHours)) } }; })(),
    byFormat: Object.fromEntries(["singles", "doubles"].map((f) => { const xs = rows.filter((r) => r.format === f); return [f, { talks: xs.length, possible: xs.filter((r) => r.possible).length, agreed: xs.filter((r) => r.agreed).length, meanRounds: +(xs.reduce((a, r) => a + r.rounds, 0) / Math.max(1, xs.length)).toFixed(2) }]; })) };
  console.log(JSON.stringify(s));
  return { summary: s, rows };
}
const out = { at: new Date().toISOString(), me: me.free, cases: cases.length, arms: {} };
// PRIVATE_ARMS=private runs one arm
const ARMS = (process.env.PRIVATE_ARMS || "shared,private").split(",");
for (const mode of ARMS) { out.arms[mode] = await arm(mode); fs.writeFileSync(OUT, JSON.stringify(out, null, 1)); }
delete process.env.A2A_PRIVATE;
console.log("\n" + ARMS.map((k) => { const s = out.arms[k].summary; return `${k}: agreed ${s.agreedWhenPossible} of ${s.possible} where a time existed (and ${s.agreedWhenNot} where none did), ${s.broke} broke a calendar or rule, ${s.meanRounds} rounds on average, ${s.tokens.calls} model calls, ${s.seconds} s; your agent was told ${s.toldWindows} free windows and ${s.toldAnswers} answers`; }).join("\n"));

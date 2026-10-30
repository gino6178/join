// How much reasoning each call site needs. Every site runs the same inputs at several reasoning budgets, and each run
// is scored on what it cost (output tokens, reasoning, seconds, from the token ledger) and on whether it still did its
// job: the reply came back, fitted its format, and was right where the right answer is known.
//   node test/budget_probe.mjs [out.json] [budget ...]       (default budgets: 900 400 250 150)
import fs from "node:fs";
// the model's own answers are what this tests: code does not answer the calendar's questions for it
process.env.A2A_ROUTE ||= "off"; process.env.A2A_STUDENT ||= "off";

process.env.A2A_FILE ||= "data/probe-a2a.json";
process.env.ASK_FILE ||= "data/probe-asks.json";
process.env.LEDGER_FILE ||= "data/probe-ledger.jsonl";
process.env.NEGOTIATIONS_FILE ||= "data/probe-negotiations.json"; process.env.TRACE_FILE ||= "data/probe-traces.jsonl";
// its own bookings, and holds off: back-to-back talks with the same members would otherwise meet the earlier ones' holds
process.env.BOOKINGS_FILE ||= "data/probe-bookings.json"; process.env.A2A_LEASE ||= "off";
const OUT = process.argv[2] || "data/budget_probe.json";
const LEVELS = (process.argv.slice(3).length ? process.argv.slice(3) : ["900", "400", "250", "150"]).map(Number);
const { BUDGETS } = await import("../src/llm.js");
const ledger = await import("../src/ledger.js");
const life = await import("../src/life.js");
const body = await import("../src/body.js");
const ask = await import("../src/ask.js");
const { negotiate } = await import("../src/a2a.js");
const { readClub } = await import("../src/club.js");
const { helpers } = await import("../src/play.js");

const club = readClub(), venues = helpers.readVenues(), me = { id: "you", name: "You", area: club.you.area, free: club.you.free };
const member = (id) => club.members.find((m) => m.id === id);
const places = await import("../src/places.js");
const near = places.toGeo(venues.map.geo, club.you.area);
// two one-to-one talks; quick pick on or off for them (A2A_QUICK is read at each answer)
const talks = (ok, quickFlag) => [["leo", "singles"], ["kenji", "singles"]].map(([id, format]) => ({ name: `${id} ${format}`,
  run: () => { process.env.A2A_QUICK = quickFlag; return negotiate({ me, members: [member(id)], venues, format, minutes: 90, prefer: { day: "Thu", start: "19:00" } }); }, ok }));
// each case: what to run, and whether its result is right
const SITES = {
  "life.read": [
    ["club training Wednesday 19:00-21:00", (r) => r.intent === "event" && r.events.some((e) => e.start === "19:00")],
    ["played two hours with Leo, knee felt fine", (r) => r.intent === "log"],
    ["when is my next game?", (r) => r.intent === "chat"],
    ["exam on Friday morning", (r) => r.intent === "event"],
  ].map(([t, ok]) => ({ name: t, run: () => life.read(t), ok })),
  "body.read": [
    ["My right knee is sore after jumping, about 3 out of 5", (r) => r.by === "model" && r.entries.some((e) => e.part === "knee" && e.side === "right" && e.level === 3)],
    ["Lower back is a bit stiff this morning", (r) => r.by === "model" && r.entries.some((e) => e.part === "lowerback")],
  ].map(([t, ok]) => ({ name: t, run: () => body.read(t), ok })),
  "ask.word": [{ name: "want a game?", run: () => ask.ask({ who: `probe-${Math.random()}`, ahead: 7 }), ok: (r) => r.by === "model" }],
  // the member agents' full answers (quick pick off), the quick pick alone, and the proposal your agent writes
  "a2a.answer": talks((r) => r.log.filter((x) => x.from !== "you").every((x) => x.intent !== "none" && x.tier === "agent"), "0"),
  "a2a.pick": talks((r) => r.log.filter((x) => x.from !== "you").some((x) => x.tier === "quick"), "1"),
  "a2a.write": talks((r) => !/^Proposing /.test(r.log[0]?.text || "Proposing"), "0"),
  // courts near the club's town: the judge and the place names in English
  "places.judge": [{ name: "basketball near the club", run: () => places.search({ ...near, sport: "basketball", start: "19:00", limit: 4 }), ok: (r) => r.places.filter((p) => p.by === "model").length >= 2 }],
  "places.english": [{ name: "names in English", run: () => places.search({ ...near, sport: "basketball", start: "19:00", limit: 4 }), ok: (r) => r.places.some((p) => p.local) }],
};

const rows = [];
for (const level of LEVELS) {
  for (const [site, cases] of Object.entries(SITES)) {
    // the a2a probe's proposal (a2a.write) keeps the default budget, so only the answers change
    for (const k of Object.keys(BUDGETS)) delete BUDGETS[k];
    BUDGETS[site] = level;
    const t0 = Date.now();
    const results = await Promise.all(cases.map(async (c) => { try { return { name: c.name, ok: !!c.ok(await c.run()) }; } catch (e) { return { name: c.name, ok: false, error: String(e.message || e) }; } }));
    const calls = ledger.calls(100000).filter((x) => x.at >= t0 && x.site === site);
    const t = ledger.totals(calls);
    const row = { site, budget: level, cases: results.length, right: results.filter((x) => x.ok).length, calls: t.calls, empty: t.empty, invalid: t.invalid,
      outputPerCall: t.calls ? Math.round(t.output / t.calls) : 0, reasoningPerCall: t.calls ? Math.round(t.reasoning / t.calls) : 0, secondsPerCall: t.calls ? +(t.seconds / t.calls).toFixed(1) : 0, wrong: results.filter((x) => !x.ok).map((x) => x.name + (x.error ? `: ${x.error}` : "")) };
    rows.push(row);
    console.log(JSON.stringify(row));
    fs.writeFileSync(OUT, JSON.stringify(rows, null, 1));
  }
}
console.log("PROBE_DONE");

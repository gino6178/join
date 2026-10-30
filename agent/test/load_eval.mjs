// Capacity on one GPU: Muse Glimmer on one RTX 3090, 4 requests at once (OLLAMA_NUM_PARALLEL=4).
//   A. Throughput: 1, 4, 8 and 16 talks at once (one-to-one, with simulated members, the real negotiation code), two
//      waves each: talks a minute, and each talk's time (p50, p95) and its calls' wait for a slot.
//   B. Who goes first: 8 talks running in the background without pause (as an Autopilot run would), while a player
//      waits on a talk of their own every 5 s (8 of them). How long the player's talk takes, p50 and p95, with the
//      gateway's priority scheduler (llm.js) and without it (LLM_PRIORITY=off: every call straight to the server).
//   node test/load_eval.mjs [out.json]
import fs from "node:fs";

// (holds off, A2A_LEASE: this measures the agreement itself, and a time held in one talk would change the next)
// (and every answer from the model, A2A_ROUTE and A2A_STUDENT off: this measures what the model does)
for (const [k, v] of Object.entries({ A2A_ROUTE: "off", A2A_STUDENT: "off", A2A_LEASE: "off", BOOKINGS_FILE: "data/load-bookings.json", SIM_ONLY: "1", SIM_MEMBERS: "300", A2A_TRANSPORT: "local", A2A_FILE: "data/load-a2a.json", NEGOTIATIONS_FILE: "data/load-negotiations.json",
  TRACE_FILE: "data/load-traces.jsonl", LEDGER_FILE: "data/load-ledger.jsonl" })) process.env[k] ||= v;
const { population } = await import("../src/population.js");
const { negotiate, shared, forgetMemory } = await import("../src/a2a.js");
const { readClub } = await import("../src/club.js");
const { helpers } = await import("../src/play.js");
const ledger = await import("../src/ledger.js");
const OUT = process.argv[2] || "data/load_eval.json", MIN = 90, now = new Date();
const club = readClub(), venues = helpers.readVenues();
const me = { id: "you", name: "You", area: club.you.area, free: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => `${d} 08-22`) };
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1) : null; };
// members with no hard rule, so every talk asks the model (a rule would let code answer some of them)
const pool = population(300).filter((m) => !Object.keys(m.rules).length && m.prefers !== "doubles" && shared([me, m], MIN, now).length);
let next = 0;
const oneTalk = async () => {
  const m = pool[next++ % pool.length], s = shared([me, m], MIN, now)[0], t0 = Date.now();
  const r = await negotiate({ me, members: [m], venues, format: "singles", sport: "badminton", minutes: MIN, prefer: { day: s.day, start: helpers.hm(s.from) }, now }).catch((e) => ({ error: e.message }));
  return { seconds: (Date.now() - t0) / 1000, agreed: !!r.agreed };
};
const out = { at: new Date().toISOString(), slots: +(process.env.LLM_SLOTS || 4), throughput: [], priority: [] };
const save = () => fs.writeFileSync(OUT, JSON.stringify(out, null, 1));

// A
for (const c of [1, 4, 8, 16]) {
  forgetMemory();
  const t0 = Date.now(), rows = [];
  for (let wave = 0; wave < 2; wave++) rows.push(...(await Promise.all(Array.from({ length: c }, oneTalk))));
  const secs = (Date.now() - t0) / 1000, calls = ledger.calls(100000).filter((x) => x.at >= t0 && x.site === "a2a.answer");
  const row = { atOnce: c, talks: rows.length, agreed: rows.filter((x) => x.agreed).length, seconds: +secs.toFixed(1), talksPerMinute: +((rows.length / secs) * 60).toFixed(1),
    talkP50: q(rows.map((x) => x.seconds), 0.5), talkP95: q(rows.map((x) => x.seconds), 0.95), calls: calls.length, waitP50: q(calls.map((x) => (x.queuedMs || 0) / 1000), 0.5), waitP95: q(calls.map((x) => (x.queuedMs || 0) / 1000), 0.95) };
  out.throughput.push(row); save(); console.log(JSON.stringify(row));
}

// B
for (const mode of ["on", "off"]) {
  process.env.LLM_PRIORITY = mode === "on" ? "" : "off"; forgetMemory();
  let stop = false;
  const bg = Array.from({ length: 8 }, () => ledger.job("autopilot", async () => { let n = 0; while (!stop) { await oneTalk(); n++; } return n; }));
  await new Promise((r) => setTimeout(r, 20000)); // the background is busy before the player starts
  const probes = [];
  for (let i = 0; i < 8; i++) { probes.push(oneTalk()); await new Promise((r) => setTimeout(r, 5000)); }
  const yours = await Promise.all(probes);
  stop = true;
  const done = await Promise.all(bg);
  const row = { scheduler: mode, yourTalks: yours.length, yourP50: q(yours.map((x) => x.seconds), 0.5), yourP95: q(yours.map((x) => x.seconds), 0.95), backgroundTalks: done.reduce((a, b) => a + b, 0) };
  out.priority.push(row); save(); console.log(JSON.stringify(row));
}
delete process.env.LLM_PRIORITY;
console.log("\n" + out.throughput.map((r) => `${r.atOnce} at once: ${r.talksPerMinute} talks a minute, a talk p50 ${r.talkP50} s / p95 ${r.talkP95} s, waiting for a slot p95 ${r.waitP95} s`).join("\n") + "\n" +
  out.priority.map((r) => `scheduler ${r.scheduler}: your talk p50 ${r.yourP50} s, p95 ${r.yourP95} s, with ${r.backgroundTalks} background talks done`).join("\n"));

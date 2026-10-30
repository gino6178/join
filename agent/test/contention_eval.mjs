// Two players' agents ask the same member for the same evening at the same moment (two talks at once, the real
// negotiation code; the member's agent on Muse Glimmer). Each pair runs twice, with holds off and on (A2A_LEASE):
//   double   both talks agreed the member for overlapping times
//   booked   how many of the pair's games could be booked (a double agreement is caught when the second is booked)
// Simulated members with no hard rules, who play singles and have room for two games in their week.
//   node test/contention_eval.mjs [out.json]        CONTENTION_N=12 pairs; EVAL_A2A=1 the members' agents answer, and
//   hold, over A2A on a local port (test/a2a_local.mjs)
import fs from "node:fs";

for (const [k, v] of Object.entries({ SIM_ONLY: "1", SIM_MEMBERS: "300", A2A_TRANSPORT: process.env.EVAL_A2A === "1" ? "" : "local", A2A_FILE: "data/contention-a2a.json", NEGOTIATIONS_FILE: "data/contention-negotiations.json",
  TRACE_FILE: "data/contention-traces.jsonl", LEDGER_FILE: "data/contention-ledger.jsonl", BOOKINGS_FILE: "data/contention-bookings.json" })) process.env[k] ||= v;
fs.rmSync(process.env.BOOKINGS_FILE, { force: true });
const { serveA2A, a2aOn } = await import("./a2a_local.mjs");
const a2aServer = await serveA2A("data/contention-a2a-tasks");
const { population } = await import("../src/population.js");
const { negotiate, forgetMemory } = await import("../src/a2a.js");
const { readClub } = await import("../src/club.js");
const play = await import("../src/play.js");
const { toMin, hm, readVenues } = play.helpers;
const OUT = process.argv[2] || "data/contention_eval.json", N = +(process.env.CONTENTION_N || 12), MIN = 90;
const club = readClub(), venues = readVenues(), now = new Date();
const me = { id: "you", name: "You", area: club.you.area, free: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => `${d} 08-22`) };
// room for two games: three hours free in one window, or two windows
const room = (m) => m.free.reduce((a, w) => { const [f, t] = w.split(" ")[1].split("-").map(Number); return a + Math.floor(((t - f) * 60) / MIN); }, 0) >= 2;
const members = population(300).filter((m) => !Object.keys(m.rules || {}).length && m.prefers !== "doubles" && room(m)).slice(0, N);
console.log(`${members.length} members, two talks at once for each, holds off and on`);

const overlap = (a, b) => a && b && a.date === b.date && toMin(a.start) < toMin(b.start) + MIN && toMin(b.start) < toMin(a.start) + MIN;
async function arm(mode) {
  process.env.A2A_LEASE = mode === "on" ? "" : "off"; forgetMemory(); play.clearLeases();
  const rows = [], t0 = Date.now();
  for (const m of members) {
    const [day, hours] = m.free[0].split(" "), prefer = { day, start: `${hours.split("-")[0].padStart(2, "0")}:00` };
    const talk = () => negotiate({ me, members: [m], venues, format: "singles", sport: "badminton", minutes: MIN, prefer, now }).catch((e) => ({ agreed: null, reason: e.message }));
    const [a, b] = await Promise.all([talk(), talk()]);
    // the player says yes to each, in the order the talks ended
    const booked = [];
    for (const r of [a, b]) if (r.agreed) { const x = await play.book({ option: r.agreed }); booked.push(x.error ? { error: x.error } : { id: x.id }); }
    const ga = a.agreed && { date: a.agreed.date, start: a.agreed.start }, gb = b.agreed && { date: b.agreed.date, start: b.agreed.start };
    rows.push({ member: m.id, prefer: `${prefer.day} ${prefer.start}`, a: ga ? `${ga.date} ${ga.start}` : a.reason, b: gb ? `${gb.date} ${gb.start}` : b.reason, double: !!overlap(ga, gb), agreed: [a, b].filter((r) => r.agreed).length, booked: booked.filter((x) => x.id).length, refused: booked.filter((x) => x.error).map((x) => x.error) });
    console.log(`  ${mode} ${m.id}: ${rows.at(-1).a} | ${rows.at(-1).b}${rows.at(-1).double ? "  (double)" : ""}; booked ${rows.at(-1).booked}`);
    // nothing carries over to the next pair
    for (const x of booked) if (x.id) play.cancel(x.id);
    play.clearLeases();
  }
  const sum = { pairs: rows.length, double: rows.filter((r) => r.double).length, bothAgreed: rows.filter((r) => r.agreed === 2).length, gamesBooked: rows.reduce((s, r) => s + r.booked, 0), refusedAtBooking: rows.reduce((s, r) => s + r.refused.length, 0), seconds: Math.round((Date.now() - t0) / 1000) };
  return { summary: sum, rows };
}
const out = { at: new Date().toISOString(), transport: a2aOn() ? "a2a" : "in-process", members: members.length, arms: {} };
for (const mode of ["off", "on"]) { out.arms[mode] = await arm(mode); fs.writeFileSync(OUT, JSON.stringify(out, null, 1)); }
console.log("\n" + Object.entries(out.arms).map(([k, a]) => `holds ${k}: ${a.summary.double} of ${a.summary.pairs} pairs agreed the member twice at overlapping times; ${a.summary.gamesBooked} games booked, ${a.summary.refusedAtBooking} refused at booking; ${a.summary.seconds} s`).join("\n"));
if (a2aServer) { a2aServer.closeAllConnections(); a2aServer.close(); }

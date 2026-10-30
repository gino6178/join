// Unit tests for the members' disclosure budget and the fading talk memory (docs/privacy_budget.md), with no model:
//   node --test test/privacy_unit.mjs
//   - the ledger counts hours of the week told to an asker, not answers: an hour told again is free, a new one over the
//     cap is withheld, every asker together has a cap too, the window rolls, a band is all or nothing, /forget
//   - an answer cut to the budget: withheld times are neither a yes nor a no, a yes to a withheld time is not given,
//     and which times are withheld does not depend on the member's calendar; minimal disclosure
//   - a talk with private calendars (a2a.js, in process): a curious asker runs out, the player who plays the same
//     hours does not, a withheld time is not learned as a no, and the decision fits the A2A schema with `withheld`
//   - a band (match/likely.js) is refused once the hours it covers are over the budget
//   - the counts about a member's agent fade (half every 14 days) and go; coarse keys by part of the day
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "serve-privacy-"));
Object.assign(process.env, { BOOKINGS_FILE: `${tmp}/bookings.json`, A2A_FILE: `${tmp}/a2a.json`, NEGOTIATIONS_FILE: `${tmp}/neg.json`, LEDGER_FILE: `${tmp}/ledger.jsonl`, TRACE_FILE: `${tmp}/traces.jsonl`,
  PREFS_FILE: `${tmp}/prefs.json`, MATCH_RECORDS_FILE: `${tmp}/records.json`, MATCH_AUDIT_FILE: `${tmp}/audit.json`, MATCH_STATE_FILE: `${tmp}/state.json`, ASK_FILE: `${tmp}/asks.json`, DISCLOSURE_FILE: `${tmp}/disclosure.json`,
  LLM_URL: "http://127.0.0.1:9/v1", A2A_TRANSPORT: "local", A2A_LEASE: "off", MEMORY: "off", A2A_BUDGET_SURE: "0" });
delete process.env.A2A_PRIVATE; delete process.env.A2A_BASE; delete process.env.A2A_BUDGET;
const disclosure = await import("../src/disclosure.js");
const a2a = await import("../src/a2a.js");
const likely = await import("../src/match/likely.js");
const { createStore } = await import("../src/match/records.js");
const { helpers } = await import("../src/play.js");
const { validate, DECISION } = await import("../src/schema.js");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const D = 864e5, T0 = new Date("2026-11-02T07:00:00").getTime();
const lim = (o = {}) => ({ on: true, cells: 3, memberCells: 5, days: 28, minimal: null, ...o });
const items = (...cells) => cells.map((c, i) => ({ id: `t${i + 1}`, cell: c }));

test("the budget counts hours of the week told to an asker, not answers", () => {
  const L = disclosure.createLedger(null);
  let g = L.grant("m1", "a", items("Mon 19", "Mon 20", "Wed 18", "Sat 09"), T0, { limits: lim() });
  assert.deepEqual([...g.allowed], ["t1", "t2", "t3"]); assert.deepEqual(g.withheld, ["t4"]);
  // the same hours again cost nothing (two players agreeing their usual Monday every week never run out)
  g = L.grant("m1", "a", items("Mon 19", "Mon 20", "Wed 18"), T0 + 7 * D, { limits: lim() });
  assert.equal(g.withheld.length, 0);
  // another asker has its own budget, but every asker together has one too (5 here)
  g = L.grant("m1", "b", items("Tue 18", "Thu 19", "Fri 18"), T0, { limits: lim() });
  assert.deepEqual(g.withheld, ["t3"], "the member's 5 hours: 3 told to a, 2 new for b");
  // the window rolls: 28 days on, the hours told to a are no longer counted
  g = L.grant("m1", "a", items("Sun 10", "Sun 11", "Sun 12"), T0 + 36 * D, { limits: lim() });
  assert.equal(g.withheld.length, 0);
  assert.equal(L.used("m1", "a", T0 + 36 * D, lim()).pair, 3);
  // a band is all or nothing, and nothing is recorded when it is refused
  g = L.grant("m2", "a", items("Mon 19", "Mon 20", "Tue 19", "Tue 20"), T0, { all: true, limits: lim() });
  assert.equal(g.allowed.size, 0); assert.equal(g.withheld.length, 4);
  assert.equal(L.used("m2", "a", T0, lim()).pair, 0);
  L.forget("m1");
  assert.equal(L.used("m1", "a", T0 + 36 * D, lim()).pair, 0);
  assert.equal(disclosure.cellOf("2026-11-02", "19:30"), "Mon 19");
});

// a member free Mon 19-22 only: of t1 Mon 19, t2 Mon 20, t3 Wed 18, t4 Sat 09, the first two work
const offered = [["2026-11-02", 19], ["2026-11-02", 20], ["2026-11-04", 18], ["2026-11-07", 9]].map(([date, h], i) => ({ id: `t${i + 1}`, slot: { date }, start: h * 60 }));
test("an answer cut to the budget: withheld times are neither a yes nor a no", () => {
  const L = disclosure.createLedger(null), j = { intent: "accept", works: ["t1", "t2"], tier: "rules" };
  // room for the whole list: unchanged
  assert.equal(disclosure.limitAnswer("m", "a", offered[0], offered, j, { ledger: L, limits: lim({ cells: 9, memberCells: 9 }), now: T0 }), j);
  // room for two hours: the proposed time and the next one are told, the rest withheld
  const L2 = disclosure.createLedger(null), k = disclosure.limitAnswer("m", "a", offered[0], offered, j, { ledger: L2, limits: lim({ cells: 2 }), now: T0 });
  assert.deepEqual(k.works, ["t1", "t2"]); assert.deepEqual(k.withheld, ["t3", "t4"]); assert.equal(k.intent, "accept");
  // nothing left: a yes is not given (it would tell the proposed time), and the answer says it told nothing
  const z = disclosure.limitAnswer("m", "b", offered[2], offered, { intent: "counter", date: "2026-11-02", start: "19:00", works: ["t1", "t2"] }, { ledger: L2, limits: lim({ cells: 0, memberCells: 2 }), now: T0 });
  assert.equal(z.intent, "decline"); assert.deepEqual(z.works, []); assert.equal(z.withheld.length, 4);
  // which times are withheld depends on the list and its order only: a member free at none of them gets the same cut
  const L3 = disclosure.createLedger(null), n = disclosure.limitAnswer("m", "a", offered[0], offered, { intent: "decline", works: [] }, { ledger: L3, limits: lim({ cells: 2 }), now: T0 });
  assert.deepEqual(n.withheld, k.withheld);
  // a counter to a withheld time becomes one to the first allowed time that works
  const L4 = disclosure.createLedger(null), c = disclosure.limitAnswer("m", "a", offered[2], offered, { intent: "counter", date: "2026-11-02", start: "20:00", works: ["t1", "t2"] }, { ledger: L4, limits: lim({ cells: 2 }), now: T0 });
  assert.equal(c.intent, "counter"); assert.equal(c.start, "19:00"); assert.deepEqual(c.withheld, ["t2", "t4"]);
  // minimal disclosure: the proposed time and the first m that work
  const L5 = disclosure.createLedger(null), mi = disclosure.limitAnswer("m", "a", offered[2], offered, { intent: "counter", date: "2026-11-02", start: "19:00", works: ["t1", "t2"] }, { ledger: L5, limits: lim({ cells: 99, memberCells: 99, minimal: 1 }), now: T0 });
  assert.deepEqual(mi.works, ["t1"]); assert.deepEqual(mi.withheld.sort(), ["t2", "t4"]);
  // off: nothing changes
  assert.equal(disclosure.limitAnswer("m", "a", offered[0], offered, j, { ledger: L, limits: lim({ on: false }) }), j);
  assert.deepEqual(validate(DECISION, { intent: k.intent, works: k.works, withheld: k.withheld, tier: "rules" }), []);
});

test("a talk with private calendars: the curious asker runs out, the player who keeps to the same hours does not", { timeout: 60000 }, async () => {
  Object.assign(process.env, { A2A_BUDGET: "on", A2A_BUDGET_CELLS: "6", A2A_BUDGET_MEMBER_CELLS: "20" });
  disclosure.useLedger(disclosure.createLedger(null)); a2a.forgetMemory();
  const venues = helpers.readVenues(), area = { x: 3, y: 5 };
  const m = { id: "pm1", name: "Pia Member", area, free: ["Mon 18-23"], rules: {}, rulesComplete: true, sports: ["badminton"] };
  const now = new Date(T0);
  // the ordinary player: Mon 19-21:30, two starts, every week
  const me = { id: "you", name: "You", area, free: ["Mon 19-22"] };
  for (let w = 0; w < 3; w++) {
    const r = await a2a.negotiate({ me, members: [m], venues, format: "singles", sport: "badminton", minutes: 90, now: new Date(T0 + w * 7 * D), calendars: "private" });
    assert.ok(r.agreed, `week ${w}: ${r.reason}`);
  }
  // the curious one: every hour of the week, and it keeps what it hears
  const spy = { id: "spy", name: "Spy", area, free: helpers.DAYS.map((d) => `${d} 07-23`) }, heard = [];
  const r1 = await a2a.negotiate({ me: spy, members: [m], venues, format: "singles", sport: "badminton", minutes: 90, now, calendars: "private", heard: (e) => heard.push(e) });
  const told = heard.flatMap((e) => e.offered.filter((x) => !(e.withheld || []).includes(x.id)));
  assert.ok(told.length <= 6, `told about ${told.length} times`);
  assert.ok(heard.some((e) => e.withheld?.length), "some times withheld");
  // and the next talk tells it nothing new (the hours it was told already, again; then nothing): it ends on the
  // budget, not as a no
  const h2 = [];
  const r2 = await a2a.negotiate({ me: { ...spy, free: ["Tue 07-23", "Thu 07-23"] }, members: [m], venues, format: "singles", sport: "badminton", minutes: 90, now: new Date(T0 + D), calendars: "private", heard: (e) => h2.push(e) });
  assert.equal(r2.agreed, null); assert.deepEqual(r2.budget, ["pm1"]); assert.match(r2.reason, /as many new times as it will/);
  const toldAgain = h2.flatMap((e) => e.offered.filter((x) => !(e.withheld || []).includes(x.id)).map((x) => disclosure.cellOf(x.date, x.start)));
  assert.ok(toldAgain.every((c) => told.some((x) => disclosure.cellOf(x.date, x.start) === c)), "only hours it was told before");
  // a withheld time is not learned as a no
  const no = Object.keys(a2a.memoryOf("pm1", T0 + D)?.no || {});
  for (const e of h2.filter((x) => x.withheld?.includes(x.cur.id))) assert.ok(!no.includes(`${helpers.DAYS[new Date(`${e.cur.date}T12:00:00`).getDay()]} ${e.cur.start.slice(0, 2)}:00`), `${e.cur.date} ${e.cur.start} learned as a no`);
  assert.ok(r1);
  // the ordinary player, a week later, still agrees (its hours were told before)
  const r3 = await a2a.negotiate({ me, members: [m], venues, format: "singles", sport: "badminton", minutes: 90, now: new Date(T0 + 21 * D), calendars: "private" });
  assert.ok(r3.agreed, r3.reason);
  for (const k of ["A2A_BUDGET", "A2A_BUDGET_CELLS", "A2A_BUDGET_MEMBER_CELLS"]) delete process.env[k];
});

test("a band is refused once the hours it covers are over the member's budget", () => {
  Object.assign(process.env, { A2A_BUDGET: "on", A2A_BUDGET_CELLS: "2", A2A_BUDGET_MEMBER_CELLS: "10" });
  const L = disclosure.createLedger(null), ctx = { venues: helpers.readVenues(), records: createStore(null), state: likely.createState(null), disclosure: L, now: T0 };
  const m = { id: "bm1", name: "Bo Member", area: { x: 3, y: 5 }, free: ["Mon 18-23"], rules: {}, sports: ["badminton"] };
  const ask = (start, date = "2026-11-02") => likely.answer(m, { kind: "serve.likely", from: "spy", sport: "badminton", format: "singles", minutes: 90, times: [{ date, start }] }, ctx);
  assert.ok(ask("19:00").band); assert.ok(ask("20:00").band);
  assert.equal(ask("21:00").refused, true);
  assert.ok(!ask("19:00", "2026-11-09").refused, "an hour already told is answered again");
  for (const k of ["A2A_BUDGET", "A2A_BUDGET_CELLS", "A2A_BUDGET_MEMBER_CELLS"]) delete process.env[k];
});

test("what your agent keeps about a member's agent fades, and can be coarse", async () => {
  a2a.forgetMemory(); disclosure.useLedger(disclosure.createLedger(null));
  const venues = helpers.readVenues(), area = { x: 3, y: 5 };
  const m = { id: "fm1", name: "Fay Member", area, free: ["Wed 18-22"], rules: {}, rulesComplete: true, sports: ["badminton"] };
  const me = { id: "you", name: "You", area, free: ["Wed 18-21"] };
  const r = await a2a.negotiate({ me, members: [m], venues, format: "singles", sport: "badminton", minutes: 90, now: new Date(T0), calendars: "private" });
  assert.ok(r.agreed, r.reason);
  const k = Object.keys(a2a.memoryOf("fm1", T0).yes)[0], n0 = a2a.memoryOf("fm1", T0).yes[k];
  assert.match(k, /^Wed \d\d:00$/);
  assert.ok(Math.abs(a2a.memoryOf("fm1", T0 + 14 * D).yes[k] - n0 / 2) < 0.01, "half after 14 days");
  assert.equal(a2a.memoryOf("fm1", T0 + 70 * D).yes[k], undefined, "gone after ten weeks");
  a2a.forgetMemory();
  process.env.A2A_MEMORY_GRAIN = "part";
  await a2a.negotiate({ me, members: [m], venues, format: "singles", sport: "badminton", minutes: 90, now: new Date(T0 + 7 * D), calendars: "private" });
  assert.deepEqual(Object.keys(a2a.memoryOf("fm1", T0 + 7 * D).yes), ["Wed evening"]);
  delete process.env.A2A_MEMORY_GRAIN;
});

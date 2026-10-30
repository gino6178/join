import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { open, offer, accept, cancel, status, setClock, negotiationsStore, internal, QUOTA, TTL_MS } from "../src/negotiate/engine.js";
import { price, askAt, cents } from "../src/negotiate/policy.js";
import { setMandate, mandatesStore } from "../src/mandate.js";
import { venue, freeUnits } from "../src/world.js";
import { alternatives } from "../src/alternatives.js";

// Monday 2 Nov 2026, 10:00 local; the games are on Thursday 5 Nov
let now = new Date(2026, 10, 2, 10, 0);
const DATE = "2026-11-05";
const freeStart = (v, activity = "badminton", minutes = 90) => {
  for (let m = 18 * 60; m <= 20 * 60; m += 30) { const s = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; if (freeUnits(v, activity, DATE, s, minutes).length) return s; }
  throw new Error(`no free court at ${v}`);
};

beforeEach(() => {
  now = new Date(2026, 10, 2, 10, 0);
  setClock(() => now);
  negotiationsStore.reset(); mandatesStore.reset();
  setMandate("you", { perGame: 3000, perWeek: 10000 });
});

test("the ask is the list price less the policy's discounts, never below the floor", () => {
  const v = venue("lakeside");
  const q = price(v, { activity: "badminton", date: DATE, start: "19:00", minutes: 90, players: 4 }, now);
  assert.equal(q.list, cents(20) * 1.5);
  assert.deepEqual(q.discounts.map((d) => d.kind), ["group"]);
  assert.equal(q.ask, Math.round(q.list * 0.9));
  assert.ok(q.ask >= q.floor);
  // eager: comes all the way to the floor over its rounds; firm never moves
  assert.equal(askAt(q, q.rounds), q.floor);
  const firm = price(venue("riverside"), { activity: "badminton", date: DATE, start: "19:00", minutes: 90, players: 2 }, now);
  assert.equal(askAt(firm, 3), firm.ask);
});

test("an offer at the ask is agreed at the ask; the floor never leaves the engine", () => {
  const start = freeStart("north");
  const n = open({ by: "you", players: ["leo", "hana", "tomas"], venue: "north", activity: "badminton", date: DATE, start, minutes: 90 });
  assert.equal(n.status, "open");
  assert.equal(JSON.stringify(n).includes("floor"), false);
  const r = offer({ id: n.id, by: "you", amount: cents(+n.ask) + 500 });
  assert.equal(r.status, "agreed");
  assert.equal(r.agreed.amount, n.ask);
});

test("serious offers walk the venue down its schedule, then best and final, then a refusal with alternatives", () => {
  const start = freeStart("north");
  const n = open({ by: "you", players: ["leo"], venue: "north", activity: "badminton", date: DATE, start, minutes: 90 });
  const q = { ...internal(n.id) };
  let r;
  for (let i = 1; i <= q.rounds; i++) {
    r = offer({ id: n.id, by: "you", amount: Math.ceil(cents(+(r?.ask || n.ask)) * 0.75) });
    assert.equal(r.status, "open");
    assert.equal(cents(+r.ask), askAt(q, i));
  }
  assert.equal(r.final, true);
  r = offer({ id: n.id, by: "you", amount: 100 });
  assert.equal(r.status, "rejected");
  assert.ok(r.alternatives.length > 0);
  assert.ok(r.alternatives.every((a) => a.venue !== "north"));
});

test("an offer between the counter and the ask is agreed at the offer", () => {
  const start = freeStart("lakeside");
  const n = open({ by: "you", players: ["leo"], venue: "lakeside", activity: "badminton", date: DATE, start, minutes: 90 });
  const q = { ...internal(n.id) }, mid = Math.round((askAt(q, 1) + q.ask) / 2);
  const r = offer({ id: n.id, by: "you", amount: mid });
  assert.equal(r.status, "agreed");
  assert.equal(cents(+r.agreed.amount), mid);
});

test("the organizer's mandate is enforced before the venue sees anything", () => {
  setMandate("you", { perGame: 500 });
  const start = freeStart("riverside");
  const n = open({ by: "you", players: ["leo"], venue: "riverside", activity: "badminton", date: DATE, start, minutes: 90 });
  assert.equal(n.overBudget, true);
  assert.ok(n.alternatives.length > 0);
  const r = accept({ id: n.id, by: "you" });
  assert.equal(r.error, "over_mandate");
  assert.equal(status({ id: n.id, by: "you" }).status, "open");
});

test("only the organizer negotiates; other players can read", () => {
  const start = freeStart("north");
  const n = open({ by: "you", players: ["leo"], venue: "north", activity: "badminton", date: DATE, start, minutes: 90 });
  assert.equal(offer({ id: n.id, by: "leo", amount: 100 }).error, "not_organizer");
  assert.equal(status({ id: n.id, by: "leo" }).id, n.id);
  assert.equal(status({ id: n.id, by: "kenji" }).error, "unknown_negotiation");
});

test("negotiations expire and the quota stops probing", () => {
  const start = freeStart("north");
  const n = open({ by: "you", players: ["leo"], venue: "north", activity: "badminton", date: DATE, start, minutes: 90 });
  now = new Date(now.getTime() + TTL_MS + 1000);
  assert.equal(accept({ id: n.id, by: "you" }).error, "closed");
  for (let i = 1; i < QUOTA; i++) open({ by: "you", players: ["leo"], venue: "north", activity: "badminton", date: DATE, start, minutes: 90 });
  assert.equal(open({ by: "you", players: ["leo"], venue: "north", activity: "badminton", date: DATE, start, minutes: 90 }).error, "quota");
});

test("walking away closes it", () => {
  const start = freeStart("north");
  const n = open({ by: "you", players: ["leo"], venue: "north", activity: "badminton", date: DATE, start, minutes: 90 });
  assert.equal(cancel({ id: n.id, by: "you" }).status, "cancelled");
});

test("alternatives: bookable within budget first, a free public court last, reasons made by code", () => {
  const list = alternatives({ people: [{ id: "you", area: { x: 2.4, y: 5.8 } }, { id: "leo", area: { x: 3.8, y: 5.4 } }], activity: "badminton", date: DATE, start: "19:00", minutes: 90, budgetShare: cents(15), exclude: "riverside", from: venue("riverside"), now });
  assert.ok(list.length >= 2);
  const firstPublic = list.findIndex((x) => !x.bookable);
  if (firstPublic >= 0) assert.ok(list.slice(firstPublic).every((x) => !x.bookable));
  const bookable = list.filter((x) => x.bookable);
  const inBudget = bookable.filter((x) => x.withinBudget).length;
  assert.ok(bookable.slice(0, inBudget).every((x) => x.withinBudget));
  assert.ok(list.every((x) => typeof x.why === "string" && x.why.length > 0));
});

test("bad input is refused", () => {
  assert.equal(open({ by: "nobody", venue: "north", activity: "badminton", date: DATE, start: "19:00" }).error, "unknown_player");
  assert.equal(open({ by: "you", venue: "north", activity: "curling", date: DATE, start: "19:00" }).error, "not_offered");
  assert.equal(open({ by: "you", venue: "north", activity: "badminton", date: "2026-11-31", start: "19:00" }).error, "bad_time");
  assert.equal(open({ by: "you", venue: "north", activity: "badminton", date: "2026-11-01", start: "19:00" }).error, "in_the_past");
});

test("a venue's own policy: checked, then used for the next negotiation", async () => {
  const { setPolicy, policiesStore } = await import("../src/world.js");
  assert.equal(setPolicy("north", { floorPct: 0.2 }).error, "invalid");
  assert.equal(setPolicy("north", { style: "generous" }).error, "invalid");
  const before = venue("north").policy.style;
  assert.equal(setPolicy("north", { style: "firm" }).policy.style, "firm");
  const n = open({ by: "you", players: ["leo"], venue: "north", activity: "badminton", date: DATE, start: freeStart("north"), minutes: 90 });
  assert.equal(n.final, true);
  setPolicy("north", { style: before }); policiesStore.reset();
});

test("a lowball earns nothing: three $1 offers leave the venue where it was", () => {
  const start = freeStart("lakeside");
  const n = open({ by: "you", players: ["leo"], venue: "lakeside", activity: "badminton", date: DATE, start, minutes: 90 });
  let r;
  for (let i = 0; i < 3; i++) { r = offer({ id: n.id, by: "you", amount: 100 }); assert.equal(r.lowball, true); }
  assert.equal(r.ask, n.ask);
  assert.equal(r.final, true);
  assert.equal(offer({ id: n.id, by: "you", amount: 100 }).status, "rejected");
});

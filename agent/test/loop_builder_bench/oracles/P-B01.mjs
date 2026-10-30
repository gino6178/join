// P-B01: weekText() says "Nothing logged in the last 7 days." when nothing was logged; every other week reads as before
import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./_env.mjs";

const { weekText } = await load("agent/src/life.js");
const now = new Date(2026, 9, 28, 10, 0); // Wednesday 2026-10-28
const ev = { date: "2026-10-29", start: "19:00", end: "21:00", title: "Club training", kind: "training" };
const log = (date, minutes, pain = "") => ({ date, minutes, what: "drills", pain, text: "drills" });

test("no sessions in the past 7 days: \"Nothing logged in the last 7 days.\"", () => {
  const t = weekText({ events: [ev], logs: [] }, now);
  assert.equal(t, "This week\n• Thu 2026-10-29 19:00-21:00 Club training (training)\n\nNothing logged in the last 7 days.");
  assert.ok(!/0 sessions/.test(t));
  assert.match(weekText({ events: [], logs: [log("2026-10-10", 60)] }, now), /\nNothing logged in the last 7 days\.$/, "a session two weeks ago is not in the week");
});
test("one or more sessions: the same text as before", () => {
  assert.equal(weekText({ events: [ev], logs: [log("2026-10-26", 60), log("2026-10-27", 30)] }, now), "This week\n• Thu 2026-10-29 19:00-21:00 Club training (training)\n\nLogged in the last 7 days: 2 sessions, 90 min");
  assert.match(weekText({ events: [], logs: [log("2026-10-27", 45, "knee 2/5")] }, now), /\nLogged in the last 7 days: 1 session, 45 min · pain noted: knee 2\/5$/);
  assert.match(weekText({ events: [], logs: [log("2026-10-27", 0)] }, now), /\nLogged in the last 7 days: 1 session$/);
});

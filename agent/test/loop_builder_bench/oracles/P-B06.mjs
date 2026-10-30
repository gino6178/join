// P-B06: habits() gives each habitual time `last` (the latest date at that day and start); get_week carries lastPlayed
import { test } from "node:test";
import assert from "node:assert/strict";
import { load, source, body } from "./_env.mjs";

const { habits } = await load("agent/src/autopilot.js");
// Thursdays 19:00 (out of order on purpose) and Saturdays 09:00; 2026-10-01 is a Thursday
const history = [
  { date: "2026-10-15", start: "19:00", played: 100 }, { date: "2026-10-01", start: "19:00", played: 90 }, { date: "2026-10-22", start: "19:00", played: 80 },
  { date: "2026-10-08", start: "19:00", played: 90 }, { date: "2026-10-17", start: "09:00", sport: "tennis" }, { date: "2026-10-03", start: "09:00", sport: "tennis" },
];

test("each habit has last, the latest date at that day and start", () => {
  const h = habits(history), thu = h.find((x) => x.day === "Thu" && x.start === "19:00"), sat = h.find((x) => x.day === "Sat" && x.start === "09:00");
  assert.equal(thu.last, "2026-10-22");
  assert.equal(sat.last, "2026-10-17");
});
test("the other fields as before", () => {
  const h = habits(history);
  assert.deepEqual(h.map(({ last, ...x }) => x), [
    { day: "Thu", start: "19:00", count: 4, weeks: 8, share: 0.5, minutes: 90, sport: "badminton" },
    { day: "Sat", start: "09:00", count: 2, weeks: 8, share: 0.25, minutes: 90, sport: "tennis" },
  ]);
  assert.deepEqual(habits([]), []);
});
test("get_week's habitualTimes carry lastPlayed", () => {
  const f = body(source("agent/src/autopilot.js"), "get_week() {");
  assert.match(f, /habitualTimes:[^\n]*lastPlayed\s*:/, f.slice(0, 400));
});

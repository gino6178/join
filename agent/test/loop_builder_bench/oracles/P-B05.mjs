// P-B05: upcoming(p, days, now, maxPerDay) keeps at most maxPerDay entries for one date; without it, every entry as before
import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./_env.mjs";

const { upcoming, context } = await load("agent/src/life.js");
const now = new Date(2026, 9, 28, 8, 0); // Wednesday 2026-10-28, 08:00
const e = (date, start, title) => ({ date, start, end: "", title, kind: "other" });
const events = [e("2026-10-28", "09:00", "a"), e("2026-10-28", "12:00", "b"), e("2026-10-28", "18:00", "c"), e("2026-10-29", "10:00", "d"), e("2026-10-29", "19:00", "e"), e("2026-11-06", "10:00", "out")];
const titles = (xs) => xs.map((x) => x.title).join("");

test("without maxPerDay: every entry in the window, as before", () => {
  assert.equal(titles(upcoming({ events }, 7, now)), "abcde");
  assert.equal(titles(upcoming({ events }, 7, now, undefined)), "abcde");
  assert.equal(titles(upcoming({ events }, 1, now)), "abc");
});
test("maxPerDay 1: the first entry of each date", () => {
  assert.equal(titles(upcoming({ events }, 7, now, 1)), "ad");
});
test("maxPerDay 2: at most two a date, in order", () => {
  assert.equal(titles(upcoming({ events }, 7, now, 2)), "abde");
  assert.equal(titles(upcoming({ events }, 7, now, 5)), "abcde");
});
test("the agent's week reads as before", () => {
  assert.match(context({ events, logs: [] }, now), /- Wed 2026-10-28 18:00 c \(other\)/);
});

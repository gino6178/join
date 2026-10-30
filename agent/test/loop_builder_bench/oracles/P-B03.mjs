// P-B03: a review about a flooded court or puddles counts like one about something broken, missing or closed
import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./_env.mjs";

const { rules } = await load("agent/src/places.js");
const BROKEN = "Reviews mention something broken, missing or closed.";
const place = (text) => ({ id: "osm:way/1", kind: "pitch", name: "Court", tags: { sport: "basketball" }, rating: null, reviews: text ? [{ n: 1, stars: 3, when: "a week ago", text }] : [] });
const order = { good: 2, maybe: 1, no: 0 };

for (const text of ["After rain the court is flooded for days.", "Big puddles everywhere after a shower.", "There is always a puddle under the hoop."]) {
  test(`"${text}" counts as unplayable`, () => {
    const with_ = rules(place(text), "basketball", "15:00", null), without = rules(place(null), "basketball", "15:00", null);
    assert.ok(with_.reasons.some((r) => r.text === BROKEN), JSON.stringify(with_.reasons));
    assert.ok(order[with_.verdict] < order[without.verdict], `${with_.verdict} vs ${without.verdict}`);
  });
}
test("a good review, and the old words, as before", () => {
  assert.ok(!rules(place("Great court, nets always up."), "basketball", "15:00", null).reasons.some((r) => r.text === BROKEN));
  assert.ok(rules(place("The hoop is broken."), "basketball", "15:00", null).reasons.some((r) => r.text === BROKEN));
  assert.deepEqual(rules(place(null), "basketball", "15:00", null), { verdict: "maybe", reasons: [{ text: "The map marks it for basketball.", cite: "map" }], by: "rules" });
});

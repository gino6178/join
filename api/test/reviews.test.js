// Verified venue reviews: who may write one, how a score treats few reviews, and how reviews (and the group's own low
// ratings) move the agent's choice of venue
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as reviews from "../src/reviews.js";
import * as ops from "../src/ops.js";
import * as settle from "../src/pay/settle.js";
import { mockPaypal } from "../src/pay/mock.js";
import { open, accept, setClock, negotiationsStore } from "../src/negotiate/engine.js";
import { setMandate, mandatesStore } from "../src/mandate.js";
import { freeUnits } from "../src/world.js";

let now;
beforeEach(() => {
  now = new Date(2026, 10, 2, 10, 0); setClock(() => now); ops.setOpsClock(() => now); reviews.setReviewsClock(() => now);
  settle.configure({ paypal: mockPaypal(), now: () => now, url: "http://test" }); settle.allowEarlyReviews(false);
  negotiationsStore.reset(); mandatesStore.reset(); settle.bookingsStore.reset(); reviews.reviewsStore.reset();
  for (const p of ["alex", "leo", "hana", "tomas"]) setMandate(p, { perGame: 5000, perWeek: 20000 });
});

test("a score is a Bayesian average: a venue with many good reviews outranks one with a couple of perfect ones; praise and complaints are counts", () => {
  const mid = reviews.summary("midtown", { activity: "badminton" }), west = reviews.summary("westgate", { activity: "badminton" });
  assert.ok(mid.score > west.score);
  assert.ok(mid.count >= 3 && west.count >= 3);
  assert.ok(west.complaints.some((c) => c.label === "worn equipment"));
  assert.ok(reviews.reason(mid).startsWith(`★${mid.score.toFixed(1)} from ${mid.count} demo reviews`)); // (seed reviews are never called verified)
  // a venue's score stays near the town's average with few reviews, even if they're perfect
  assert.ok(reviews.summary("north", { activity: "volleyball" }).score < 5);
});

test("the group's own low rating is flagged and steers the agent away (least misery)", () => {
  const withHana = reviews.summary("westgate", { activity: "badminton", group: ["alex", "hana"], viewer: "alex" });
  assert.deepEqual(withHana.groupLow.map((g) => [g.you, g.stars]), [[false, 2]]); // a friend's rating isn't named
  assert.equal(/Hana/.test(reviews.reason(withHana)), false);
  assert.ok(reviews.rankAdjust(withHana) >= 30);
  const r = ops.findOptions({ player: "alex", client: "t" }, { activity: "badminton", players: 3, with: ["hana"], dates: ["2026-11-04"] });
  for (const o of r.options) assert.notEqual(o.venue, "westgate", "Hana rated Westgate 2★: the agent shouldn't pick it when she's coming");
  assert.ok(r.options.every((o) => o.reviews && typeof o.reviews.reason === "string"));
});

test("only someone in a paid, locked booking that has started can review it, once; agents only read", async () => {
  const start = ["18:00", "19:00", "20:00"].find((s) => freeUnits("north", "badminton", "2026-11-05", s, 90).length);
  const n = open({ by: "alex", players: ["leo"], venue: "north", activity: "badminton", date: "2026-11-05", start, minutes: 90 });
  const id = accept({ id: n.id, by: "alex" }).booking.id, b = settle.internal(id);
  assert.equal(reviews.add("alex", b, { stars: 5 }, { canReview: settle.canReview }).error, "not_yet"); // not paid and locked yet
  b.state = "locked"; b.payments.leo = { status: "awaiting_approval" };
  assert.equal(reviews.add("alex", b, { stars: 5 }, { canReview: settle.canReview }).error, "not_yet"); // locked but hasn't started
  now = new Date(2026, 10, 5, 23, 0);
  assert.equal(reviews.add("leo", b, { stars: 5 }, { canReview: settle.canReview }).error, "not_paid"); // never paid
  assert.equal(reviews.add("kenji", b, { stars: 5 }, { canReview: settle.canReview }).error, "not_in_booking");
  const r = reviews.add("alex", b, { stars: 4, liked: ["clean", "made-up"], disliked: ["clean", "access"], text: "Good courts.\u0007" }, { canReview: settle.canReview });
  assert.deepEqual([r.review.liked, r.review.disliked, r.review.text], [["clean"], ["access"], "Good courts."]);
  assert.equal(reviews.add("alex", b, { stars: 1 }, { canReview: settle.canReview }).error, "already_reviewed");
  assert.equal(reviews.summary("north").latest[0].verified, `booked and paid on Join (${id})`);
});

test("tastes from a person's own past reviews: a venue good on what the group cares about moves up, bad on it moves down; only the viewer is named", () => {
  const yuki = reviews.tastes("yuki");
  assert.ok(yuki.clean > 0.5 && yuki.staff > 0.5); // Yuki praised clean, friendly Midtown
  const mid = reviews.summary("midtown", { activity: "badminton", group: ["alex", "yuki"], viewer: "alex" });
  assert.ok(mid.tasteFit > 0);
  assert.ok(mid.tasteNotes.some((n) => n.aspect === "clean" && n.good && !n.you));
  assert.match(reviews.reason(mid), /someone in your group cares about clean/);
  // Hana, who complained about worn equipment and dirt, looking at Westgate herself
  const west = reviews.summary("westgate", { activity: "badminton", group: ["hana", "alex"], viewer: "hana" });
  assert.ok(west.tasteFit < 0);
  assert.ok(west.tasteNotes.some((n) => n.aspect === "equipment" && !n.good && n.you));
  assert.match(reviews.reason(west), /you mind worn equipment/);
  // the same venue, without anyone who cares: no fit either way
  assert.equal(reviews.summary("westgate", { activity: "badminton", group: ["alex"], viewer: "alex" }).tasteFit, 0);
  assert.ok(reviews.rankAdjust(mid) < reviews.rankAdjust(reviews.summary("midtown", { activity: "badminton", group: ["alex"], viewer: "alex" })));
});

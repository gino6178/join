// Venue reviews, and what an agent may conclude from them.
//   Verified only. A review is written by a person (signed in on the website, never an agent's token: AI-written
//   reviews are what the FTC's 2024 rule on fake reviews bans) about a booking they were in and paid for, once per
//   booking, and it names that booking. Venues can't remove or hide reviews.
//   Aspects from a fixed vocabulary. What people liked and didn't is chosen from ASPECTS, not mined from text, so the
//   praise and complaints an agent repeats are counts, never a model's guess (the constrained-vocabulary lesson of
//   HADSF, arXiv 2510.26994). The text is shown as written, as a quote.
//   Ratings that don't overreact. A venue's score is a Bayesian average: its reviews, weighted by recency (a half-life of
//   180 days), plus C reviews' worth of the town's average, so two 5-star reviews don't outrank eighty 4-star ones
//   (the standard fix for sorting by average rating; Evan Miller, "How Not To Sort By Average Rating").
//   The group, not only the average. If anyone in the group rated a venue 2 stars or less, the agent is told, and the
//   ranking avoids it ("least misery", from group recommender systems).
// The demo town starts with seed reviews (data/reviews-seed.json), marked as demo data wherever they are shown.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { store, stateFile } from "./store.js";
import { venue, player } from "./world.js";

export const ASPECTS = {
  clean: "clean", staff: "friendly staff", value: "good value", equipment: "equipment in good shape", space: "roomy",
  access: "easy to get to", quiet: "quiet", ontime: "on time, no waiting", food: "food and drinks", atmosphere: "atmosphere",
};
// how a complaint about each aspect reads
export const COMPLAINTS = {
  clean: "not clean", staff: "unhelpful staff", value: "pricey", equipment: "worn equipment", space: "cramped",
  access: "hard to get to", quiet: "noisy", ontime: "waiting to start", food: "food", atmosphere: "no atmosphere",
};
const C = 3, HALF_LIFE_DAYS = 180;
const SEED = path.join(path.dirname(fileURLToPath(import.meta.url)), "../data/reviews-seed.json");
const db = store(stateFile("reviews"), { reviews: [] });
export const reviewsStore = db;
let clock = () => new Date();
export const setReviewsClock = (fn) => { clock = fn; };

const seed = (() => { try { return JSON.parse(fs.readFileSync(SEED, "utf8")).reviews; } catch { return []; } })();
const all = () => [...seed, ...db.data.reviews];
const weight = (r) => 0.5 ** (Math.max(0, clock() - Date.parse(r.at)) / 864e5 / HALF_LIFE_DAYS);
const first = (id) => player(id)?.name.split(" ")[0] || id;

// the town's average, the prior every venue starts from
function townMean() {
  let s = 0, w = 0;
  for (const r of all()) { const k = weight(r); s += k * r.stars; w += k; }
  return w ? s / w : 4;
}

// A venue's reviews, summed up for an agent (and a person): score, count, what's praised and what's not, the group's own
// low ratings, and the latest few as quotes
export function summary(venueId, { activity = null, group = [] } = {}) {
  const mine = all().filter((r) => r.venue === venueId), forAct = activity ? mine.filter((r) => r.activity === activity) : mine;
  const list = forAct.length >= 3 ? forAct : mine; // (too few for this activity: the venue's reviews overall)
  let s = 0, w = 0;
  for (const r of list) { const k = weight(r); s += k * r.stars; w += k; }
  const m = townMean(), score = (C * m + s) / (C + w);
  const count = (key, labels) => { const c = {}; for (const r of list) for (const a of r[key] || []) c[a] = (c[a] || 0) + 1; return Object.entries(c).filter(([, n]) => n >= 2 && n / list.length >= 0.25).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([a, n]) => ({ aspect: a, label: labels[a], count: n })); };
  const groupLow = list.filter((r) => group.includes(r.player) && r.stars <= 2).map((r) => ({ player: r.player, name: first(r.player), stars: r.stars, at: r.at.slice(0, 10) }));
  return {
    venue: venueId, score: Math.round(score * 10) / 10, average: list.length ? Math.round((list.reduce((a, r) => a + r.stars, 0) / list.length) * 10) / 10 : null,
    count: list.length, recent: list.filter((r) => clock() - Date.parse(r.at) < 90 * 864e5).length, scope: list === forAct && activity ? activity : "all",
    praise: count("liked", ASPECTS), complaints: count("disliked", COMPLAINTS), groupLow, demoData: list.filter((r) => r.seed).length,
    latest: list.slice().sort((a, b) => b.at.localeCompare(a.at)).slice(0, 3).map((r) => ({ stars: r.stars, text: r.text, at: r.at.slice(0, 10), activity: r.activity, verified: r.seed ? "demo data" : `booked and paid on Join (${r.booking})` })),
  };
}

// A short reason, written by code from the summary (what the agent says about a venue)
export function reason(s) {
  if (!s.count) return "no reviews yet";
  const bits = [`★${s.score.toFixed(1)} from ${s.count} verified review${s.count === 1 ? "" : "s"}${!s.demoData ? "" : s.demoData === s.count ? " (demo data)" : ` (${s.demoData} of them demo data)`}`];
  if (s.praise.length) bits.push(`liked: ${s.praise.map((p) => `${p.label} (${p.count})`).join(", ")}`);
  if (s.complaints.length) bits.push(`complaints: ${s.complaints.map((p) => `${p.label} (${p.count})`).join(", ")}`);
  if (s.groupLow.length) bits.push(`${s.groupLow.map((g) => `${g.name} rated it ${g.stars}★`).join(", ")}`);
  return bits.join("; ");
}

// How much a venue's reviews should move it in a ranking, in "minutes of travel": a star above the town's average is
// worth 8 minutes; someone in the group who rated it 2★ or less costs 30 (least misery)
export function rankAdjust(s) {
  if (!s.count) return 0;
  return -(s.score - townMean()) * 8 + (s.groupLow.length ? 30 : 0);
}

// A person reviews a booking they were in and paid for, once. `canReview` is settle.js's check of the booking.
export function add(playerId, booking, { stars, liked = [], disliked = [], text = "" }, { canReview }) {
  const ok = canReview(booking, playerId);
  if (ok.error) return ok;
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) return { error: "bad_stars", message: "stars is 1 to 5." };
  if (db.data.reviews.some((r) => r.booking === booking.id && r.player === playerId)) return { error: "already_reviewed", message: "You reviewed this booking already." };
  const clean = (xs) => [...new Set((Array.isArray(xs) ? xs : []).filter((a) => a in ASPECTS))].slice(0, 4);
  const r = { id: `rev_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, venue: booking.venue, activity: booking.activity, booking: booking.id, player: playerId, stars,
    liked: clean(liked), disliked: clean(disliked).filter((a) => !clean(liked).includes(a)), text: String(text || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 400), at: clock().toISOString() };
  db.data.reviews.push(r); db.save();
  return { review: r, venue: summary(booking.venue, { activity: booking.activity }) };
}
export const byPlayer = (playerId, bookingId) => db.data.reviews.find((r) => r.player === playerId && r.booking === bookingId) || null;
export const venueName = (id) => venue(id)?.name || id;

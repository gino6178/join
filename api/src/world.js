// The town: its venues (with their courts, prices and negotiation policies), the players and the public courts.
// The demo world is api/data/world.json, made up. A real venue plugs in by implementing hours() and freeCourts()
// against its own booking system; everything above this file only calls those.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dateOf, toMin, ymd } from "./time.js";
import { store, stateFile } from "./store.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = process.env.WORLD_FILE || path.join(HERE, "../data/world.json");
let world = JSON.parse(fs.readFileSync(FILE, "utf8"));
// Dates and times on Join are the town's local ones ("2026-11-05 19:00" in San Jose), wherever the server runs: the
// process takes the town's time zone, so "today", "an hour from now" and a booking's start all agree.
if (world.town.timeZone && !process.env.JOIN_KEEP_TZ) process.env.TZ = world.town.timeZone;
// What each venue set for itself on the website (its negotiation policy), kept apart from the demo data and laid over it
const policies = store(stateFile("venue-policies"), { venues: {} });
export const policiesStore = policies;
const overlay = () => { for (const v of world.venues) if (policies.data.venues[v.id]) v.policy = { ...v.policy, ...policies.data.venues[v.id] }; };
overlay();

// A venue changes its own policy. Every field is checked: a style, a floor between 50% and 100% of the list price, each
// discount between 0 and 50%, one to five counter-offers.
export function setPolicy(venueId, p) {
  const v = venue(venueId);
  if (!v) return { error: "unknown venue" };
  const pct = (x, lo = 0, hi = 0.5) => typeof x === "number" && x >= lo && x <= hi;
  const time = (s) => typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
  const next = structuredClone(v.policy), bad = [];
  if (p.style !== undefined) (["firm", "standard", "eager"].includes(p.style) ? (next.style = p.style) : bad.push("style"));
  if (p.floorPct !== undefined) (pct(p.floorPct, 0.5, 1) ? (next.floorPct = p.floorPct) : bad.push("floorPct"));
  if (p.rounds !== undefined) (Number.isInteger(p.rounds) && p.rounds >= 1 && p.rounds <= 5 ? (next.rounds = p.rounds) : bad.push("rounds"));
  if (p.offPeak) { if (pct(p.offPeak.pct) && time(p.offPeak.before)) next.offPeak = { pct: p.offPeak.pct, before: p.offPeak.before }; else bad.push("offPeak"); }
  if (p.group) { if (pct(p.group.pct) && Number.isInteger(p.group.min) && p.group.min >= 2 && p.group.min <= 12) next.group = { pct: p.group.pct, min: p.group.min }; else bad.push("group"); }
  if (p.lastMinute) { if (pct(p.lastMinute.pct) && typeof p.lastMinute.withinHours === "number" && p.lastMinute.withinHours >= 1 && p.lastMinute.withinHours <= 48) next.lastMinute = { pct: p.lastMinute.pct, withinHours: p.lastMinute.withinHours }; else bad.push("lastMinute"); }
  if (bad.length) return { error: "invalid", fields: bad };
  policies.data.venues[venueId] = next; policies.save(); v.policy = next;
  return { venue: venueId, policy: next };
}

export const getWorld = () => world;
export const setWorld = (w) => { world = w; };

export const venue = (id) => world.venues.find((v) => v.id === id) || null;
export const player = (id) => world.players.find((p) => p.id === id) || null;
export const SPORTS = ["badminton", "tennis", "pickleball", "table tennis", "basketball", "volleyball"];
// a venue's courts and hourly price for one sport, or null when it doesn't have that sport
export const forSport = (v, sport) => (v?.sports?.[sport] ? { courts: v.sports[sport].courts, price: v.sports[sport].price } : null);

// FNV-1a with a final mix, so similar keys (same venue, next hour) still spread evenly over 0..1
export const hash = (s) => {
  let h = 2166136261;
  for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
};

// Courts the platform itself has taken (held while a group pays, or locked once paid). bookings.js installs this, so
// the venue adapter below doesn't offer a court twice.
let taken = () => [];
export const setTaken = (fn) => { taken = fn; };
const overlaps = (a0, a1, b0, b1) => a0 < b1 && b0 < a1;

// The demo venues answer from a fixed pseudo-random timetable, so the same question gives the same courts. Peak hours
// (18:00-21:00 and weekends) are busier.
export const demoVenues = {
  hours(v, date) { return ([0, 6].includes(date.getDay()) && v.weekendOpen) || v.open; },
  freeCourts(v, sport, date, start, minutes) {
    const s = forSport(v, sport);
    if (!s) return [];
    const [o, c] = this.hours(v, date).map(toMin);
    if (start < o || start + minutes > c) return [];
    const peak = (start >= 18 * 60 && start < 21 * 60) || [0, 6].includes(date.getDay());
    const busy = (peak ? v.peakBusy : v.offBusy) * 0.6, day = ymd(date);
    const mine = new Set(taken().filter((t) => t.venue === v.id && t.sport === sport && t.date === day && overlaps(t.from, t.to, start, start + minutes)).map((t) => t.court));
    const out = [];
    for (let k = 1; k <= s.courts; k++) {
      let free = !mine.has(k);
      for (let t = Math.floor(start / 60) * 60; free && t < start + minutes; t += 60) if (hash(`${v.id}|${sport}|${day}|${t}|${k}`) < busy) free = false;
      if (free) out.push(k);
    }
    return out;
  },
};
export const freeCourts = (venueId, sport, date, start, minutes) => {
  const v = venue(venueId);
  return v ? demoVenues.freeCourts(v, sport, dateOf(date), toMin(start), minutes) : [];
};

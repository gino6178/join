// The town: its venues (what they offer, their prices and negotiation policies), the people, and free public places.
// The demo world is api/data/world.json, made up. A real venue plugs in by implementing hours() and freeCourts()
// against its own booking system; everything above this file only calls those.
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dateOf, toMin, ymd } from "./time.js";
import { store, stateFile } from "./store.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = process.env.WORLD_FILE || path.join(HERE, "../data/world.json");
let world = JSON.parse(fs.readFileSync(FILE, "utf8"));
// Two modes. "real" (the default): no made-up town. People are where they really are (their location, rounded to
// about a kilometre), the venues are the ones that registered on Join with their real address, and real places from
// OpenStreetMap near a group are suggested too (osm.js). "demo" (the tests, and JOIN_TOWN=demo): the made-up town in
// world.json, its residents and its venues, for working offline.
export const MODE = process.env.JOIN_TOWN || (process.env.NODE_TEST_CONTEXT ? "demo" : "real");
export const REAL = MODE === "real";
if (REAL) {
  const [lat, lon] = String(process.env.JOIN_REGION_CENTER || "25.0330,121.5654").split(",").map(Number);
  world = { ...world, demo: false, note: "Real people and real places: venues that registered on Join, and places from OpenStreetMap.",
    town: { name: process.env.JOIN_REGION_NAME || "Taipei", timeZone: process.env.JOIN_TZ || "Asia/Taipei", w: 0, h: 0, geo: { lat, lon, unitKm: 1.25 }, map: { districts: [], parks: [], roads: [], river: [], lake: null } },
    venues: [], players: [], publicPlaces: [] };
}
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

// Partner venues: registered on Join by their staff, with a real address, opening hours, what they offer and their
// prices; the same negotiation policies as any venue. In real mode these are the only bookable venues.
const partners = store(stateFile("partner-venues"), { venues: [] });
export const partnersStore = partners;
const placePartner = (v) => { const t = REAL ? { x: +(((v.lon - world.town.geo.lon) * 111.32 * Math.cos((world.town.geo.lat * Math.PI) / 180)) / 1.25).toFixed(3), y: +(((world.town.geo.lat - v.lat) * 110.57) / 1.25).toFixed(3) } : {}; const p = { ...v, ...t }; if (!world.venues.some((x) => x.id === v.id)) world.venues.push(p); return p; };
if (REAL) for (const v of partners.data.venues) placePartner(v);
export function registerVenue({ name, lat, lon, address = "", open = ["10:00", "22:00"], weekendOpen = null, offers = {}, payee = null }) {
  const clean = String(name || "").replace(/[<>]/g, "").trim().slice(0, 60);
  const time = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s));
  if (!clean || !Number.isFinite(+lat) || !Number.isFinite(+lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return { error: "invalid", message: "A venue needs a name and its real location (lat, lon)." };
  const off = {};
  for (const [act, o] of Object.entries(offers || {})) if (world.activities.some((a) => a.id === act) && Number.isInteger(o.units) && o.units >= 1 && o.units <= 50 && +o.price > 0 && +o.price < 1000 && ["hour", "person"].includes(o.per)) off[act] = { units: o.units, per: o.per, price: +o.price };
  if (!Object.keys(off).length) return { error: "invalid", message: "Say what you offer: offers: { badminton: { units: 4, per: \"hour\", price: 20 } }." };
  if (!(Array.isArray(open) && open.every(time))) return { error: "invalid", message: "open is [\"HH:MM\", \"HH:MM\"]." };
  const id = `v_${crypto.randomBytes(5).toString("hex")}`;
  const v = { id, name: clean, area: String(address).slice(0, 80), lat: +(+lat).toFixed(5), lon: +(+lon).toFixed(5), open, ...(weekendOpen && weekendOpen.every?.(time) ? { weekendOpen } : {}), peakBusy: 0, offBusy: 0,
    policy: { style: "standard", floorPct: 0.8, rounds: 3, group: { min: 4, pct: 0.1 } }, payee: payee || `${id}@join-venue.example`, offers: off, partner: true, registered: new Date().toISOString() };
  partners.data.venues.push(v); partners.save();
  return placePartner(v);
}

// kilometres-based position (the units trips use) of a real place, from the region's centre
export const toKm = (lat, lon) => ({ x: +(((lon - world.town.geo.lon) * 111.32 * Math.cos((world.town.geo.lat * Math.PI) / 180)) / world.town.geo.unitKm).toFixed(3), y: +(((world.town.geo.lat - lat) * 110.57) / world.town.geo.unitKm).toFixed(3) });
export const getWorld = () => world;
export const setWorld = (w) => { world = w; };

export const venue = (id) => world.venues.find((v) => v.id === id) || null;
export const player = (id) => world.players.find((p) => p.id === id) || null;
// What people get together for (world.json activities): sports, karaoke, escape rooms, board games, barbecues,
// dinners. Each says what one booking holds (its unit: a court, a room, a table, a pit), how many people that unit takes
// and the lengths it is booked in.
export const activity = (id) => world.activities.find((a) => a.id === id) || null;
export const ACTIVITIES = () => world.activities.map((a) => a.id);
// What a venue offers for one activity: how many units, and the price, per hour of a unit or per person. Null when it
// doesn't offer that activity.
export const forActivity = (v, id) => {
  const o = v?.offers?.[id], a = activity(id);
  return o && a ? { units: o.units, per: o.per, price: o.price, unit: a.unit, min: a.min, max: a.max, minutes: a.minutes } : null;
};
// "court 2", "room 5": what a unit is called
export const unitName = (activityId, n) => `${activity(activityId)?.unit || "unit"} ${n}`;

// FNV-1a with a final mix, so similar keys (same venue, next hour) still spread evenly over 0..1
export const hash = (s) => {
  let h = 2166136261;
  for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
};

// Units the platform itself has taken (held while a group pays, or locked once paid). settle.js installs this, so the
// venue adapter below doesn't offer a unit twice.
let taken = () => [];
export const setTaken = (fn) => { taken = fn; };
const overlaps = (a0, a1, b0, b1) => a0 < b1 && b0 < a1;

// The demo venues answer from a fixed pseudo-random timetable, so the same question gives the same free units. Peak
// hours (18:00-21:00 and weekends) are busier. A real venue implements hours() and freeUnits() against its own system.
export const demoVenues = {
  hours(v, date) { return ([0, 6].includes(date.getDay()) && v.weekendOpen) || v.open; },
  freeUnits(v, activityId, date, start, minutes) {
    const s = forActivity(v, activityId);
    if (!s) return [];
    const [o, c] = this.hours(v, date).map(toMin);
    if (start < o || start + minutes > c + (c === 23 * 60 + 59 ? 1 : 0)) return [];
    const peak = (start >= 18 * 60 && start < 21 * 60) || [0, 6].includes(date.getDay());
    const busy = (peak ? v.peakBusy : v.offBusy) * 0.6, day = ymd(date);
    const mine = new Set(taken().filter((t) => t.venue === v.id && t.activity === activityId && t.date === day && overlaps(t.from, t.to, start, start + minutes)).map((t) => t.unit));
    const out = [];
    for (let k = 1; k <= s.units; k++) {
      let free = !mine.has(k);
      for (let t = Math.floor(start / 60) * 60; free && t < start + minutes; t += 60) if (hash(`${v.id}|${activityId}|${day}|${t}|${k}`) < busy) free = false;
      if (free) out.push(k);
    }
    return out;
  },
};
export const freeUnits = (venueId, activityId, date, start, minutes) => {
  const v = venue(venueId);
  return v ? demoVenues.freeUnits(v, activityId, dateOf(date), toMin(start), minutes) : [];
};

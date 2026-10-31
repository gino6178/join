// People who joined Join themselves, besides the demo town's made-up residents: with Google, Facebook, LINE or PayPal
// sign-in (when the server has that provider's keys), or as a new demo account with a name they typed. Each becomes
// a player in the town like any other: a home area (a district they pick, never an address), the evenings and
// weekends free, every activity of interest, and the default limits, which they change on the website.
// A crew is a group of friends who joined Join: everyone who gives the same crew code is in it. Crewmates are the
// first people find_options invites for each other, and each answers an invitation through their own agent (or on the
// website); nobody else can answer for them. People who joined without a crew are invited only by id.
// What is kept: the provider, the provider's id for them (to know them next time), the name it gave, their area and
// crew. No provider token is kept, and no email.
import crypto from "node:crypto";
import { store, stateFile } from "./store.js";
import { getWorld, REAL } from "./world.js";

const db = store(stateFile("people"), { people: [] });
const FREE = ["Mon 18-22", "Tue 18-22", "Wed 18-22", "Thu 18-22", "Fri 18-23", "Sat 08-23", "Sun 08-22"];

function place(p) {
  const w = getWorld();
  if (!w.players.some((x) => x.id === p.id)) w.players.push(p);
  return p;
}
for (const p of db.data.people) place(p); // (back into the town after a restart)

export const districts = () => getWorld().town.map.districts.map((d) => d.name);
const cleanCrew = (c) => String(c || "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32) || null;

// Where someone lives in the town. From the browser's location (lat, lon), when they share it: the first person in a
// crew to share theirs sits in Midtown, and the others are placed by their real distance and direction from that
// person, so friends who live close end up close (a kilometre on the ground is a kilometre in the town). Only a
// rounded position (two decimals, about a kilometre) is kept, and others see only the district's name. Without a
// location, a district they pick, or one in turn.
const r2 = (v) => Math.round(v * 100) / 100;
// In real mode there is no made-up town: a person is where they are (rounded to two decimals, about a kilometre),
// measured in kilometres from the region's centre, and their area is the place they gave, or "near you" to others.
function realHome({ lat, lon, label }) {
  const g = getWorld().town.geo, geo = { lat: r2(+lat), lon: r2(+lon) };
  const x = ((geo.lon - g.lon) * 111.32 * Math.cos((g.lat * Math.PI) / 180)) / g.unitKm, y = ((g.lat - geo.lat) * 110.57) / g.unitKm;
  return { area: { x: +x.toFixed(3), y: +y.toFixed(3), name: String(label || "").split(",")[0].trim().slice(0, 40) || null }, geo };
}
const hasGeo = (lat, lon) => lat != null && lon != null && lat !== "" && lon !== "" && Number.isFinite(+lat) && Number.isFinite(+lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
function homeArea({ area, lat, lon, crew, label }) {
  if (REAL) return hasGeo(lat, lon) ? realHome({ lat, lon, label }) : { area: null };
  const w = getWorld(), all = w.town.map.districts, unit = w.town.geo?.unitKm || 1.25, near = (x, y) => all.reduce((a, d) => (Math.hypot(d.x - x, d.y - y) < Math.hypot(a.x - x, a.y - y) ? d : a));
  if (lat != null && lon != null && lat !== "" && lon !== "" && Number.isFinite(+lat) && Number.isFinite(+lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
    const geo = { lat: r2(+lat), lon: r2(+lon) }, anchor = crew && db.data.people.find((p) => p.crew === crew && p.geo);
    const mid = all.find((d) => d.name === "Midtown") || all[0];
    const dx = anchor ? ((geo.lon - anchor.geo.lon) * 111.32 * Math.cos((geo.lat * Math.PI) / 180)) / unit : 0, dy = anchor ? ((geo.lat - anchor.geo.lat) * 110.57) / unit : 0;
    const x = Math.min(w.town.w - 0.3, Math.max(0.3, (anchor ? anchor.area.x : mid.x) + dx)), y = Math.min(w.town.h - 0.3, Math.max(0.3, (anchor ? anchor.area.y : mid.y + 0.4) - dy));
    return { area: { x: r2(x), y: r2(y), name: near(x, y).name }, geo };
  }
  const d = all.find((x) => x.name.toLowerCase() === String(area || "").toLowerCase()) || all[db.data.people.length % all.length];
  const n = db.data.people.filter((p) => p.area?.name === d.name).length; // (neighbours a little apart, not on one spot)
  return { area: { x: r2(d.x + ((n % 3) - 1) * 0.25), y: r2(d.y + 0.4 + (Math.floor(n / 3) % 3) * 0.2), name: d.name } };
}

// the person for a provider's account: made the first time, found again later
export function personFor(provider, providerId, name, { area = null, crew = null, lat = null, lon = null, label = null, nearby = false } = {}) {
  const id = `u_${crypto.createHash("sha256").update(`${provider}:${providerId}`).digest("hex").slice(0, 10)}`;
  const known = db.data.people.find((p) => p.id === id);
  if (known) { if (crew && !known.crew) joinCrew(known, crew); return known; }
  const w = getWorld(), c = cleanCrew(crew), home = homeArea({ area, lat, lon, crew: c, label });
  const clean = String(name || "").replace(/[^\p{L}\p{N} .'-]/gu, "").trim().slice(0, 40) || "New member";
  const p = { id, name: clean, level: "B", free: FREE, ...home, prefers: "any",
    interests: w.activities.map((a) => a.id), paypal: `${id}@join-demo.example`, joined: { provider, at: new Date().toISOString() }, ...(c ? { crew: c } : {}), ...(nearby ? { nearby: true } : {}) };
  db.data.people.push(p); db.save();
  return place(p);
}
// a new demo account, for someone (or an agent testing Join) without a provider sign-in
export const demoPerson = (name, opts) => personFor("demo", crypto.randomBytes(8).toString("hex"), name, opts);
// the other people in someone's crew
export const crewmates = (p) => (p?.crew ? db.data.people.filter((x) => x.crew === p.crew && x.id !== p.id) : []);
// A crew starts with an invite link: someone asks for one (a new code, if they have no crew yet) and sends it to
// friends; opening it joins that crew, as a new account (the sign-up page, or POST /api/auth/demo for an agent) or
// an existing one (POST /api/crew/join). Only people who joined Join have crews; the demo town's residents don't.
export function crewOf(playerId, { create = false } = {}) {
  const p = db.data.people.find((x) => x.id === playerId);
  if (!p) return null;
  if (!p.crew && create) { p.crew = `c-${crypto.randomBytes(4).toString("hex")}`; db.save(); }
  return p.crew || null;
}
export function joinCrew(pOrId, code) {
  const p = typeof pOrId === "string" ? db.data.people.find((x) => x.id === pOrId) : pOrId, c = cleanCrew(code);
  if (!p || !c) return null;
  p.crew = c; db.save();
  return p;
}
// A person sets (or moves) their home, and whether people near them who share an interest may invite them
export function setHome(playerId, { lat, lon, label = null, nearby }) {
  const p = db.data.people.find((x) => x.id === playerId);
  if (!p) return null;
  if (hasGeo(lat, lon)) Object.assign(p, REAL ? realHome({ lat, lon, label }) : homeArea({ lat, lon, crew: p.crew, label }));
  if (typeof nearby === "boolean") p.nearby = nearby;
  db.save();
  return p;
}
export const crewSize = (code) => db.data.people.filter((x) => x.crew === cleanCrew(code)).length;
export const crewNames = (code) => db.data.people.filter((x) => x.crew === cleanCrew(code)).map((x) => x.name);
export const peopleStore = { reset: () => { const w = getWorld(); w.players = w.players.filter((x) => !x.joined); db.data.people = []; db.save(); } };

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
import { getWorld } from "./world.js";

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

// the person for a provider's account: made the first time, found again later
export function personFor(provider, providerId, name, { area = null, crew = null } = {}) {
  const id = `u_${crypto.createHash("sha256").update(`${provider}:${providerId}`).digest("hex").slice(0, 10)}`;
  const known = db.data.people.find((p) => p.id === id);
  if (known) return known;
  const w = getWorld(), all = w.town.map.districts;
  const d = all.find((x) => x.name.toLowerCase() === String(area || "").toLowerCase()) || all[db.data.people.length % all.length];
  const n = db.data.people.filter((p) => p.area?.name === d.name).length; // (neighbours a little apart, not on one spot)
  const clean = String(name || "").replace(/[^\p{L}\p{N} .'-]/gu, "").trim().slice(0, 40) || "New member";
  const p = { id, name: clean, level: "B", free: FREE, area: { x: +(d.x + ((n % 3) - 1) * 0.25).toFixed(2), y: +(d.y + 0.4 + (Math.floor(n / 3) % 3) * 0.2).toFixed(2), name: d.name }, prefers: "any",
    interests: w.activities.map((a) => a.id), paypal: `${id}@join-demo.example`, joined: { provider, at: new Date().toISOString() }, ...(cleanCrew(crew) ? { crew: cleanCrew(crew) } : {}) };
  db.data.people.push(p); db.save();
  return place(p);
}
// a new demo account, for someone (or an agent testing Join) without a provider sign-in
export const demoPerson = (name, opts) => personFor("demo", crypto.randomBytes(8).toString("hex"), name, opts);
// the other people in someone's crew
export const crewmates = (p) => (p?.crew ? db.data.people.filter((x) => x.crew === p.crew && x.id !== p.id) : []);
export const peopleStore = { reset: () => { const w = getWorld(); w.players = w.players.filter((x) => !x.joined); db.data.people = []; db.save(); } };

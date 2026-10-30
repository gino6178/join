// People who joined Join themselves, besides the demo town's made-up residents: with Google, Facebook, LINE or PayPal
// sign-in (when the server has that provider's keys), or as a new demo account with a name they typed. Each becomes
// a player in the town like any other: a home area (a district, never an address), the evenings and weekends free,
// every activity of interest, and the default limits, which they change on the website.
// What is kept: the provider, the provider's id for them (to know them next time) and the name it gave. No provider
// token is kept, and no email.
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

// the person for a provider's account: made the first time, found again later
export function personFor(provider, providerId, name) {
  const id = `u_${crypto.createHash("sha256").update(`${provider}:${providerId}`).digest("hex").slice(0, 10)}`;
  const known = db.data.people.find((p) => p.id === id);
  if (known) return known;
  const w = getWorld(), d = w.town.map.districts[db.data.people.length % w.town.map.districts.length];
  const clean = String(name || "").replace(/[^\p{L}\p{N} .'-]/gu, "").trim().slice(0, 40) || "New member";
  const p = { id, name: clean, level: "B", free: FREE, area: { x: d.x, y: d.y + 0.4, name: d.name }, prefers: "any",
    interests: w.activities.map((a) => a.id), paypal: `${id}@join-demo.example`, joined: { provider, at: new Date().toISOString() } };
  db.data.people.push(p); db.save();
  return place(p);
}
// a new demo account, for someone (or an agent testing Join) without a provider sign-in
export const demoPerson = (name) => personFor("demo", crypto.randomBytes(8).toString("hex"), name);
export const peopleStore = { reset: () => { db.data.people = []; db.save(); } };

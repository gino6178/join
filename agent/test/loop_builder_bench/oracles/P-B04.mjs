// P-B04: places.search({ indoorOnly }) judges and returns indoor places only; the Autopilot's find_places declares it
// and passes it on. The map comes from a prefilled cache (no OpenStreetMap), with no Google key; the forecast is
// refused by the sandbox; the court judge's model is a fake on loopback that records which places it was asked about.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { source, body } from "./_env.mjs";

const lat = 25.033, lon = 121.565, radius = 2500, sport = "basketball";
const places = [
  { id: "osm:way/1", lat: 25.0345, lon: 121.566, name: "Hall One", kind: "sports_centre", tags: { sport: "basketball" } },
  { id: "osm:way/2", lat: 25.0315, lon: 121.5635, name: "Park Court", kind: "pitch", tags: { sport: "basketball", lit: "yes" } },
  { id: "osm:way/3", lat: 25.0360, lon: 121.5625, name: "Covered Court", kind: "pitch", tags: { sport: "basketball", covered: "yes" } },
  { id: "osm:way/4", lat: 25.0300, lon: 121.5680, name: "School Yard", kind: "pitch", tags: { sport: "basketball" } },
];
fs.writeFileSync(process.env.PLACES_FILE, JSON.stringify({ [`${lat.toFixed(3)},${lon.toFixed(3)},${radius},${sport}`]: { at: Date.now(), places } }));
// the judge's model: answers "maybe" with a map reason, and notes the place each question was about
const judged = new Set();
const srv = http.createServer((q, r) => {
  let b = ""; q.on("data", (d) => (b += d)); q.on("end", () => {
    const m = /^Place: ([^,(\n]+)/m.exec(JSON.parse(b).messages.at(-1).content || "");
    if (m) judged.add(m[1].trim());
    r.setHeader("content-type", "application/json");
    r.end(JSON.stringify({ message: { role: "assistant", content: JSON.stringify({ verdict: "maybe", reasons: [{ text: "The map marks it for basketball.", cite: "map", quote: "" }] }) }, done: true, eval_count: 10, prompt_eval_count: 50 }));
  });
});
await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
after(() => srv.close());
Object.assign(process.env, { LLM_URL: `http://127.0.0.1:${srv.address().port}/v1`, LLM_API: "ollama" });
const { load } = await import("./_env.mjs");
const P = await load("agent/src/places.js");
const ids = (r) => r.places.map((p) => p.id).sort();
const args = { lat, lon, sport, date: "2026-10-29", start: "15:00", radius, limit: 6 };

test("indoorOnly: only places that are not outdoor are returned", async () => {
  const r = await P.search({ ...args, indoorOnly: true });
  assert.deepEqual(ids(r), ["osm:way/1", "osm:way/3"]);
  assert.ok(r.places.every((p) => p.outdoor === false));
});
test("indoorOnly: only those places are judged (no model call for an outdoor one)", async () => {
  judged.clear();
  await P.search({ ...args, indoorOnly: true });
  assert.deepEqual([...judged].sort(), ["Covered Court", "Hall One"]);
});
test("without indoorOnly (or false), every place is judged and returned, as before", async () => {
  judged.clear();
  assert.deepEqual(ids(await P.search(args)), ["osm:way/1", "osm:way/2", "osm:way/3", "osm:way/4"]);
  assert.equal(judged.size, 4);
  assert.deepEqual(ids(await P.search({ ...args, indoorOnly: false })), ["osm:way/1", "osm:way/2", "osm:way/3", "osm:way/4"]);
});
test("the Autopilot's find_places declares indoorOnly (optional boolean) and passes it to places.search", () => {
  const src = source("agent/src/autopilot.js");
  const def = src.split("\n").find((l) => /name: "find_places"/.test(l)) || "";
  assert.match(def, /indoorOnly"?\s*:\s*\{[^}]*type:\s*"boolean"/, def.slice(0, 300));
  assert.ok(!/required:\s*\[[^\]]*indoorOnly/.test(def), "indoorOnly is not required");
  const f = body(src, "async find_places(");
  assert.match(f, /places\.search\(\{[^]*indoorOnly[^]*\}\)/, f.slice(0, 600));
});

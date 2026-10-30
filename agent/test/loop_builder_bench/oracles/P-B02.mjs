// P-B02: judge() drops a model reason over 160 characters (it used to cut it at 200); shorter ones are kept as they were
// The court judge's model is a fake on loopback that answers the reasons a test sets.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import "./_env.mjs";

const sized = (n) => { let s = "The map marks it for basketball"; while (s.length < n - 1) s += " and it has a court"; return (s.slice(0, n - 1).trimEnd() + ".").padEnd(n, "x").slice(0, n); };
let reasons = [];
const srv = http.createServer((q, r) => {
  let b = ""; q.on("data", (d) => (b += d)); q.on("end", () => {
    r.setHeader("content-type", "application/json");
    r.end(JSON.stringify({ message: { role: "assistant", content: JSON.stringify({ verdict: "good", reasons }) }, done: true, eval_count: 10, prompt_eval_count: 50 }));
  });
});
await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
after(() => srv.close());
Object.assign(process.env, { LLM_URL: `http://127.0.0.1:${srv.address().port}/v1`, LLM_API: "ollama" });
const { load } = await import("./_env.mjs");
const { judge } = await load("agent/src/places.js");
const place = { id: "osm:way/1", name: "Hall One", kind: "sports_centre", tags: { sport: "basketball" }, dist: 300, rating: null, reviews: [] };
const ask = (rs) => { reasons = rs; return judge(place, "basketball", "2026-10-29", "15:00", null); };
const short = sized(100), long = sized(170), edge = sized(160);

test("a reason over 160 characters is dropped, not cut", async () => {
  assert.equal(short.length, 100); assert.equal(long.length, 170);
  const v = await ask([{ text: short, cite: "map" }, { text: long, cite: "map" }]);
  assert.equal(v.by, "model");
  assert.deepEqual(v.reasons.map((r) => r.text), [short]);
  assert.equal(v.dropped, 1);
});
test("160 characters is still kept, whole", async () => {
  const v = await ask([{ text: edge, cite: "map" }]);
  assert.deepEqual(v.reasons.map((r) => r.text), [edge]);
});
test("every reason too long: the rules judge the place", async () => {
  const v = await ask([{ text: long, cite: "map" }, { text: sized(190), cite: "map" }]);
  assert.equal(v.by, "rules");
});

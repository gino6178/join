// Join's website agent: the rules reader (always run first; Qwen fills in only what it leaves open) turns what a
// person types into a brief Join's tools accept.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { byRules, missing } from "../src/scout/understand.js";

const w = JSON.parse(fs.readFileSync(new URL("../data/world.json", import.meta.url), "utf8"));
const ctx = { activities: w.activities, people: w.players.filter((p) => p.id !== "you"), today: new Date(2026, 9, 30, 12) }; // a Friday

test("English: activity, day, evening, group size and budget", () => {
  const b = byRules("Karaoke Friday night, 4 of us, $15 each", {}, ctx);
  assert.deepEqual(b, { activity: "karaoke", dates: ["2026-10-30"], from: "17:00", to: "23:00", players: 3, budget: 15 });
  assert.deepEqual(missing(b), []);
});

test("Chinese, weekends, friends by name, and 'friends' is not Friday", () => {
  assert.deepEqual(byRules("週六晚上 5 個人吃火鍋 每人 20 塊", {}, ctx), { activity: "hot pot", dates: ["2026-10-31"], from: "17:00", to: "23:00", players: 4, budget: 20 });
  assert.deepEqual(byRules("Badminton this weekend with 3 friends", {}, ctx).dates, ["2026-10-31", "2026-11-01"]);
  const b = byRules("bbq with Hana and Leo sunday", {}, ctx);
  assert.deepEqual([b.with, b.players], [["hana", "leo"], 2]);
});

test("a brief builds up over several messages", () => {
  let b = byRules("let's do an escape room", {}, ctx);
  assert.deepEqual(missing(b), ["day", "people"]);
  b = byRules("tomorrow", b, ctx);
  b = byRules("for 4", b, ctx);
  assert.deepEqual([b.activity, b.dates, b.players, missing(b)], ["escape room", ["2026-10-31"], 3, []]);
});

test("Qwen on Join's server fills in only the activity, and only when the rules found none", async () => {
  const http = await import("node:http");
  let answer = "bbq", calls = 0;
  const srv = http.createServer((req, res) => { calls++; req.resume(); req.on("end", () => res.end(JSON.stringify({ message: { content: JSON.stringify({ activity: answer }) } }))); });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  process.env.SCOUT_LLM_URL = `http://127.0.0.1:${srv.address().port}`;
  const { understand } = await import("../src/scout/understand.js");
  try {
    let r = await understand([{ role: "user", content: "grill some meat outdoors on sunday, 6 of us" }], {}, ctx);
    assert.deepEqual([r.brief.activity, r.brief.players, r.missing, calls], ["bbq", 5, [], 1]);
    r = await understand([{ role: "user", content: "karaoke tomorrow for 4" }], {}, ctx);
    assert.equal(r.brief.activity, "karaoke"); assert.equal(calls, 1); // the rules found it: no model call
    answer = "skydiving";
    r = await understand([{ role: "user", content: "我想跟朋友出去玩" }], {}, ctx);
    assert.equal(r.brief.activity, undefined); assert.equal(r.reply.includes("想做什麼"), true);
  } finally { delete process.env.SCOUT_LLM_URL; srv.close(); }
});

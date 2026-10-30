// Join's website agent: the rules reader (always run first; Qwen fills in only what it leaves open) turns what a
// person types into a brief Join's tools accept.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { byRules, missing } from "../src/scout/understand.js";

const w = JSON.parse(fs.readFileSync(new URL("../data/world.json", import.meta.url), "utf8"));
const ctx = { activities: w.activities, people: w.players.filter((p) => p.id !== "alex"), today: new Date(2026, 9, 30, 12) }; // a Friday

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

test("cases our test agents found: exact times, next week, party sizes, dates, budgets, typos, names added later", () => {
  const r = (m, b = {}) => byRules(m, b, ctx);
  assert.deepEqual([r("Let's play badminton next Friday at 7pm").dates, r("Let's play badminton next Friday at 7pm").from], [["2026-11-06"], "19:00"]);
  assert.deepEqual(r("我想烤肉 下週五 六個人").dates, ["2026-11-06"]);
  assert.deepEqual([r("volleyball on Monday from 6pm to 8pm").from, r("volleyball on Monday from 6pm to 8pm").to], ["18:00", "20:00"]);
  assert.equal(r("打羽毛球 星期六下午兩點 四個人").from, "14:00");
  assert.equal(r("打羽毛球 星期六下午兩點 四個人").players, 3);
  assert.equal(r("escape room for a group of ten, under $20 each").players, 9);
  assert.equal(r("hot pot, me plus 2, in 3 days").dates[0], "2026-11-02");
  assert.deepEqual(r("karaoke on 11/7 at 9 pm").dates, ["2026-11-07"]);
  assert.deepEqual(r("bbq on the 3rd of November").dates, ["2026-11-03"]);
  assert.equal(r("table tennis on Sunday morning, just me and one friend").activity, "table tennis");
  assert.equal(r("唱K 禮拜六 十二個人").players, 11);
  assert.equal(r("預算每人十五塊").budget, 15);
  assert.equal(r("hot pot tomorrow, budget 200 total, 4 of us").budget, 50);
  assert.equal(r("basketball noon tomorrow, $0").budget, undefined);
  assert.equal(r("我們一起去吃火鍋 週一").players, undefined);
  assert.equal(r("kareoke tmrw").activity, "karaoke");
  let b = r("wanna grill meat with Ines and Kenji tomorrow");
  b = r("ok add Leo too, and Noor", b);
  assert.equal(b.players, 4);
});

test("a brief from the browser is checked before use", async () => {
  const { clean } = await import("../src/scout/understand.js");
  assert.deepEqual(clean({ players: -5, budget: 1e9, dates: ["x", 1, "9999-99-99", "2026-11-01"], from: "99:99", to: 5, with: "alex", activity: "skydiving", __proto__: { x: 1 }, extra: 1 }, ctx), { dates: ["2026-11-01"] });
  assert.deepEqual(clean({ players: 3, budget: 12, with: ["hana", "nobody"], activity: "karaoke", from: "18:00" }, ctx), { players: 3, budget: 12, with: ["hana"], activity: "karaoke", from: "18:00" });
  assert.deepEqual(clean(null, ctx), {});
});

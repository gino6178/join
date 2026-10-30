import { test } from "node:test";
import assert from "node:assert/strict";
import * as people from "../src/people.js";
import * as ops from "../src/ops.js";

test("people who join in one crew and area find each other first; without a crew nobody invites them", () => {
  people.peopleStore.reset();
  const a = people.demoPerson("Ana", { area: "Midtown", crew: "Trial-4" }), b = people.demoPerson("Ben", { area: "midtown", crew: "trial-4" });
  const c = people.demoPerson("Cai", { area: "Midtown", crew: "trial-4" }), loner = people.demoPerson("Lo", { area: "Midtown" });
  assert.equal(a.area.name, "Midtown"); assert.equal(b.crew, "trial-4");
  assert.notDeepEqual([a.area.x, a.area.y], [b.area.x, b.area.y]); // (neighbours, not one spot)
  const me = { player: a.id, client: "test" };
  assert.deepEqual(ops.whoami(me).crew.members.map((m) => m.name).sort(), ["Ben", "Cai"]);
  const o = ops.findOptions(me, { activity: "karaoke", people: 3 }).options[0];
  assert.deepEqual(o.players.slice(1).sort(), [b.id, c.id].sort()); // the crew, before the town's residents
  for (const opt of ops.findOptions(me, { activity: "karaoke", people: 4 }).options) assert.ok(!opt.players.includes(loner.id));
  people.peopleStore.reset();
});

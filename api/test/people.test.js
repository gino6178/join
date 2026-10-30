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

test("a crew by invite link, and friends placed by where they really live", () => {
  people.peopleStore.reset();
  const ana = people.demoPerson("Ana", { lat: 25.0418, lon: 121.5654 });
  assert.equal(people.crewOf(ana.id), null);
  const code = people.crewOf(ana.id, { create: true });
  assert.match(code, /^c-[0-9a-f]{8}$/);
  const bo = people.demoPerson("Bo", { crew: code, lat: 25.0418, lon: 121.5754 }); // (1 km east of Ana)
  assert.ok(bo.area.x > ana.area.x && Math.abs(bo.area.y - ana.area.y) < 0.05);
  assert.ok(Math.abs((bo.area.x - ana.area.x) * 1.25 - 1.0) < 0.2); // (a kilometre on the ground is a kilometre in the town)
  assert.deepEqual(bo.geo, { lat: 25.04, lon: 121.58 }); // (only rounded)
  const cai = people.demoPerson("Cai"); people.joinCrew(cai.id, code);
  assert.deepEqual(people.crewNames(code).sort(), ["Ana", "Bo", "Cai"]);
  assert.equal(people.joinCrew("alex", code), null); // (the demo town's residents don't join crews)
  people.peopleStore.reset();
});

test("an agent joins through an invite link with no account: the pass acts for a new person in that crew; a forged one doesn't", async () => {
  const { invitePass, onInvitePass, agentOf } = await import("../src/auth.js");
  people.peopleStore.reset();
  onInvitePass((crew, nonce, name) => people.personFor("invite", nonce, name || "Friend", { crew }));
  const ana = people.demoPerson("Ana"), code = people.crewOf(ana.id, { create: true }), pass = invitePass(code);
  const req = (tok, name) => ({ headers: { authorization: `Bearer ${tok}`, ...(name ? { "x-join-name": name } : {}) }, query: {} });
  const a = agentOf(req(pass, "Mei"));
  assert.ok(a && a.scopes.includes("negotiate"));
  assert.deepEqual(people.crewNames(code).sort(), ["Ana", "Mei"]);
  assert.equal(agentOf(req(pass)).player, a.player); // (the same pass is the same person every time)
  assert.notEqual(agentOf(req(invitePass(code), "Bo")).player, a.player); // (another pass, another friend)
  assert.equal(agentOf(req(pass.slice(0, -3) + "AAA")), null); // (forged)
  people.peopleStore.reset();
});

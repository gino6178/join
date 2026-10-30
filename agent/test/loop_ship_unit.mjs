// Unit tests for the community loop's shipping (part C): flags, the canary, history, the rollback monitor (every hard
// and soft breach) and the gate runner (with stub gates). No model, no GPU, no network:
//   node --test test/loop_ship_unit.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "serve-loop-unit-"));
let n = 0;
// each test its own loop folder (every flags.js path is read from the environment when it is used)
const fresh = () => {
  const D = path.join(root, `t${++n}`);
  fs.mkdirSync(D, { recursive: true });
  for (const k of Object.keys(process.env)) if (/^LOOP_/.test(k) && k !== "LOOP_WATCH") delete process.env[k];
  process.env.LOOP_DIR = D;
  return D;
};
process.env.LOOP_WATCH = "off";
fresh();
const flags = await import("../src/loop/flags.js");
const gates = await import("../src/loop/gates.js");
const DAY = 864e5, T0 = Date.UTC(2026, 10, 2, 12);

// the parts other people build, as stubs: what they were asked, and what they answer
function stubs({ thumbs = () => ({}), unmet = () => null } = {}) {
  const calls = { setStatus: [], counts: [], measure: [] };
  flags.use({ reset: true });
  flags.use({
    signals: { counts: async (q) => { calls.counts.push(q); return { thumbs: thumbs(q), unmet: {}, sites: {} }; }, items: () => [] },
    // (setStatus is part A's cycle's: flags.js must never call it)
    proposals: { setStatus: async (id, status, reasons) => { calls.setStatus.push({ id, status, reasons }); }, measure: async (id, q) => { calls.measure.push({ id, ...q }); return { items: [], members: 0, unmet: unmet(q) }; } },
    review: { classify: async (c) => ({ class: flags.check(c.key, c.value) === null ? "C0" : "C1", reasons: [] }) },
    readers: { bookings: () => [], approvals: () => ({ yes: new Set(), asked: new Set(), planned: new Set() }), playing: async () => [], leaks: () => [], guard: async () => ({ checked: 0, flagged: 0 }) },
  });
  return calls;
}
const spec = (over = {}) => ({ id: "P-001", title: "Ask later in the day", cluster: "C-evening", status: "gated", problem: { text: "x", members: 7, unmet: 5, wishes: 2, votes: 9 },
  change: { class: "C0", key: "ask.hour", value: 18, files: ["agent/src/server.js"], summary: "" }, oracle: { kind: "check", how: "" }, ...over });
// beta members, enough that some fall in the 20% canary; the ones in it and the ones out of it
function club(k = 40, key = "ask.hour") {
  const ps = Array.from({ length: k }, (_, i) => `psid-${i}`);
  ps.forEach((p) => flags.beta(p, true));
  return { ps, inside: ps.filter((p) => flags.bucket(key, flags.whoOf(p)) < flags.CANARY), outside: ps.filter((p) => flags.bucket(key, flags.whoOf(p)) >= flags.CANARY) };
}

test("declared keys only, today's defaults while off, and every reader that imports flags.js reads its key", () => {
  fresh(); stubs();
  const s = flags.schema();
  assert.deepEqual(Object.keys(s).sort(), ["ask.ahead", "ask.hour", "autopilot.steps", "feed.papers.perWeek", "places.radius"]);
  assert.deepEqual(Object.fromEntries(Object.entries(s).map(([k, d]) => [k, d.default])), { "ask.hour": 12, "ask.ahead": 3, "autopilot.steps": 12, "places.radius": 2500, "feed.papers.perWeek": 3 });
  let wired = 0;
  for (const [k, d] of Object.entries(s)) {
    assert.equal(flags.get(k, "anyone"), d.default);
    assert.ok(d.default >= d.range[0] && d.default <= d.range[1], `${k}'s default is in its range`);
    for (const f of d.readers) {
      const src = fs.readFileSync(path.join(gates.AGENT, f), "utf8");
      // (server.js's askTick is wired by part A on its branch)
      if (!src.includes("loop/flags.js")) continue;
      assert.ok(src.includes(`flags.get("${k}"`), `${f} reads ${k}`); wired++;
    }
  }
  assert.ok(wired >= 3, "the Autopilot's step budget and the court search radius are read in autopilot.js and places.js");
  assert.throws(() => flags.get("ask.minute", "anyone"), /not a declared flag/);
});

test("set: the type and the range are checked, and the change goes into history with who and why", () => {
  fresh(); stubs();
  assert.throws(() => flags.set("ask.hour", 12.5, { by: "maintainer", reason: "x" }), /whole number/);
  assert.throws(() => flags.set("ask.hour", "18", { by: "maintainer", reason: "x" }), /whole number/);
  assert.throws(() => flags.set("ask.hour", 8, { by: "maintainer", reason: "x" }), /between 9 and 20/);
  assert.throws(() => flags.set("ask.hour", 21, { by: "maintainer", reason: "x" }), /between 9 and 20/);
  assert.throws(() => flags.set("places.radius", 999, { by: "maintainer", reason: "x" }), /between 1000 and 5000/);
  assert.throws(() => flags.set("autopilot.steps", 17, { by: "maintainer", reason: "x" }), /between 8 and 16/);
  assert.throws(() => flags.set("ask.colour", 1, { by: "maintainer", reason: "x" }), /not a declared flag/);
  assert.throws(() => flags.set("ask.hour", 18, { by: "maintainer" }), /reason/);
  assert.throws(() => flags.set("ask.hour", 18, { by: "", reason: "x" }), /who/);
  assert.equal(flags.history().length, 0, "nothing refused is recorded");
  flags.set("ask.hour", 9, { by: "maintainer", reason: "edge of the range", now: T0 });
  flags.set("ask.hour", 20, { by: "maintainer", reason: "the other edge", now: T0 + 1 });
  assert.equal(flags.get("ask.hour", "anyone"), 20);
  const h = flags.history("ask.hour");
  assert.deepEqual(h.map((e) => [e.at, e.by, e.reason, e.from.value, e.to.value, e.version]), [[T0, "maintainer", "edge of the range", 12, 9, 1], [T0 + 1, "maintainer", "the other edge", 9, 20, 2]]);
  assert.ok(fs.existsSync(path.join(process.env.LOOP_DIR, "history.json")));
});

test("who is an HMAC of the player id with the loop's secret; the canary is the beta members in the first 20% by HMAC", () => {
  const D = fresh(); stubs();
  const who = flags.whoOf("psid-1"), sec = fs.readFileSync(path.join(D, "secret"), "utf8").trim();
  assert.equal(who, crypto.createHmac("sha256", sec).update("psid-1").digest("hex"));
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(D, "secret")).mode & 0o777, 0o600);
  const { ps, inside, outside } = club(400);
  assert.ok(inside.length > 400 * 0.14 && inside.length < 400 * 0.26, `about 20% in the canary (${inside.length} of 400)`);
  assert.deepEqual(ps.filter((p) => flags.bucket("ask.hour", flags.whoOf(p)) < 0.2), inside, "the same members every time");
  assert.notDeepEqual(ps.filter((p) => flags.bucket("places.radius", flags.whoOf(p)) < 0.2), inside, "another key, another canary");
  flags.set("ask.hour", 18, { by: "code", reason: "canary", status: "canary", canary: 0.2, proposal: "P-001", now: T0 });
  assert.ok(inside.every((p) => flags.get("ask.hour", p) === 18), "the canary gets the value");
  assert.ok(outside.every((p) => flags.get("ask.hour", p) === 12), "the other beta members keep the default");
  assert.equal(flags.get("ask.hour", "not-in-beta"), 12);
  assert.equal(flags.get("ask.hour"), 12, "no player, no canary");
  // the API's view: the beta list and the canary as counts, never the HMACs
  const f = flags.list().find((x) => x.key === "ask.hour");
  assert.equal(f.beta, 400); assert.equal(f.inCanary, inside.length); assert.equal(f.status, "canary");
  assert.ok(!JSON.stringify(flags.list()).includes(flags.whoOf(ps[0])));
  // /beta off (or /forget) takes a member out of every beta list, and out of the canary at once
  flags.beta(inside[0], false);
  assert.equal(flags.get("ask.hour", inside[0]), 12);
  assert.equal(flags.isBeta(inside[0]), false);
  assert.ok(flags.list().every((x) => x.beta === 399));
  flags.forget(inside[1]);
  assert.equal(flags.isBeta(inside[1]), false);
});

test("ship: C0 only, gated, inside its range, into a 7-day canary of beta members", async () => {
  fresh(); stubs();
  assert.match((await flags.ship(spec({ change: { class: "C1", key: "ask.hour", value: 18 } }))).reasons[0], /only a C0/);
  assert.match((await flags.ship(spec({ status: "approved" }))).reasons[0], /gates have not passed/);
  assert.match((await flags.ship(spec(), { gates: { pass: false } })).reasons[0], /gates failed/);
  assert.match((await flags.ship(spec({ change: { class: "C0", key: "ask.hour", value: 23 } }))).reasons[0], /between 9 and 20/);
  assert.match((await flags.ship(spec({ change: { class: "C0", key: "ask.hour", value: 12 } }))).reasons[0], /already the default/);
  assert.match((await flags.ship(spec())).reasons[0], /no beta member falls in the 20% canary \(0 beta members\)/);
  const { inside } = club();
  const r = await flags.ship(spec({ status: "approved" }), { now: T0, gates: { pass: true } });
  assert.equal(r.ok, true);
  assert.equal(r.canary, inside.length);
  assert.equal(r.until, T0 + 7 * DAY);
  const f = flags.flag("ask.hour");
  assert.equal(f.status, "canary"); assert.equal(f.value, 18); assert.equal(f.proposal, "P-001"); assert.equal(f.until, T0 + 7 * DAY);
  assert.match((await flags.ship(spec(), { now: T0 + 1 })).reasons[0], /already in a canary/);
  assert.deepEqual(flags.history("ask.hour").map((e) => [e.action, e.reason]), [["canary", "canary for P-001"]], "code-made words only: no proposal text in history");
  // part B's classifier must agree it is C0
  fresh(); stubs(); club();
  flags.use({ review: { classify: async () => ({ class: "C2", reasons: ["touches the Match helper's code"] }) } });
  assert.match((await flags.ship(spec(), { now: T0 })).reasons[0], /the review classes it C2: touches/);
});

test("monitor: 7 clean days, then on for everyone, returned as promoted, with a club note", async () => {
  fresh(); const calls = stubs(); const { ps, inside, outside } = club();
  await flags.ship(spec(), { now: T0 });
  assert.deepEqual(await flags.monitor({ now: T0 + 3 * DAY }), [], "nothing to do mid-canary");
  assert.equal(flags.flag("ask.hour").status, "canary");
  assert.deepEqual(await flags.monitor({ now: T0 + 7 * DAY }), [{ key: "ask.hour", kind: "promoted", proposal: "P-001" }]);
  assert.equal(flags.flag("ask.hour").status, "on");
  assert.ok([...inside, ...outside, "not-in-beta"].every((p) => flags.get("ask.hour", p) === 18));
  assert.equal(flags.notes().at(-1).text, "Shipped, asked for by 7 members: the hour the Match helper sends its daily \"Want a game?\" is now 18:00.");
  assert.deepEqual(calls.setStatus, [], "the proposal is part A's cycle's to mark shipped");
  assert.deepEqual(flags.history("ask.hour").map((e) => [e.action, e.reason]), [["canary", "canary for P-001"], ["promote", "the canary for P-001 passed after 7 days"]]);
  assert.deepEqual(await flags.monitor({ now: T0 + 8 * DAY }), [], "promoted once");
  // the canary's members (as HMACs), who got the value, were measured on the match thumb and the proposal's cluster:
  // since the ship, and (the e-process) the canary's 7 days before it, fixed at the ship, on simulated time
  const whos = inside.map(flags.whoOf).sort();
  assert.ok(calls.counts.every((q) => JSON.stringify([...q.whos].sort()) === JSON.stringify(whos)));
  assert.deepEqual(calls.counts.slice(-2).map((q) => [q.since, q.until]), [[T0, T0 + 7 * DAY], [T0 - 7 * DAY, T0]]);
  assert.deepEqual(calls.counts.slice(0, 2).map((q) => [q.since, q.until]), [[T0, T0 + 3 * DAY], [T0 - 7 * DAY, T0]], "mid-canary: the 7 days before the ship");
  assert.ok(calls.measure.every((q) => q.id === "P-001" && Array.isArray(q.items)));
});

test("LOOP_SOFT_TEST=z: the old rule's window before is of the same length as the canary so far", async () => {
  fresh(); process.env.LOOP_SOFT_TEST = "z"; const calls = stubs(); club();
  await flags.ship(spec(), { now: T0 });
  assert.deepEqual(await flags.monitor({ now: T0 + 3 * DAY }), []);
  assert.deepEqual(calls.counts.slice(0, 2).map((q) => [q.since, q.until]), [[T0, T0 + 3 * DAY], [T0 - 3 * DAY, T0]], "a window of the same length, on simulated time");
  assert.deepEqual(await flags.monitor({ now: T0 + 7 * DAY }), [{ key: "ask.hour", kind: "promoted", proposal: "P-001" }]);
});

test("one canary at a time: ship() refuses while another flag is in a canary", async () => {
  fresh(); stubs(); club(40, "ask.ahead");
  assert.equal((await flags.ship(spec(), { now: T0 })).ok, true);
  const r = await flags.ship(spec({ id: "P-002", change: { class: "C0", key: "ask.ahead", value: 5 } }), { now: T0 + DAY });
  assert.equal(r.ok, false); assert.equal(r.reasons[0], "ask.hour is in a canary (P-001) until 2026-11-09: one canary at a time");
  assert.equal(flags.flag("ask.ahead").status, "off");
  await flags.monitor({ now: T0 + 7 * DAY });
  assert.equal((await flags.ship(spec({ id: "P-002", change: { class: "C0", key: "ask.ahead", value: 5 } }), { now: T0 + 7 * DAY })).ok, true, "once it is promoted, the next may go");
});

test("LOOP_CANARY_DAYS sets how long a canary runs", async () => {
  fresh(); process.env.LOOP_CANARY_DAYS = "3"; stubs(); club();
  try {
    assert.equal((await flags.ship(spec(), { now: T0 })).until, T0 + 3 * DAY);
    assert.deepEqual(await flags.monitor({ now: T0 + 2 * DAY }), []);
    assert.deepEqual(await flags.monitor({ now: T0 + 3 * DAY }), [{ key: "ask.hour", kind: "promoted", proposal: "P-001" }]);
  } finally { delete process.env.LOOP_CANARY_DAYS; }
});

// part A's loop_eval: ship ask.hour, a simulated week, promoted; then a planted bad ask.ahead (inside its range), the
// thumbs down rise, and the monitor turns it off (part A then opens the proposal again)
test("part A's loop_eval path: ask.hour promoted, then a bad ask.ahead rolled back by a thumbs-down rise", async () => {
  fresh();
  const T1 = T0 + 7 * DAY;
  // the match thumb (Yes up, Not this week down) of the beta members: steady, until the bad ask.ahead goes out at T1
  const calls = stubs({ thumbs: (q) => ({ match: q.since >= T1 ? { up: 12, down: 28 } : { up: 32, down: 8 } }) });
  const { ps } = club(60);
  const hour = await flags.ship(spec(), { now: T0 });
  assert.equal(hour.ok, true);
  assert.deepEqual(await flags.monitor({ now: T1 }), [{ key: "ask.hour", kind: "promoted", proposal: "P-001" }]);
  const bad = await flags.ship(spec({ id: "P-002", title: "Look a week ahead", cluster: "C-ahead", change: { class: "C0", key: "ask.ahead", value: 7 } }), { now: T1 });
  assert.equal(bad.ok, true, bad.reasons?.join("; "));
  const inAhead = ps.filter((p) => flags.bucket("ask.ahead", flags.whoOf(p)) < 0.2);
  assert.ok(inAhead.length && inAhead.every((p) => flags.get("ask.ahead", p) === 7));
  const out = await flags.monitor({ now: T1 + 2 * DAY });
  assert.equal(out.length, 1); assert.deepEqual({ ...out[0], reason: null }, { key: "ask.ahead", kind: "soft", reason: null, proposal: "P-002" });
  assert.match(out[0].reason, /^thumbs down on it went from 20% to 70%, evidence [\d,]+ to 1 against the change$/);
  assert.equal(flags.flag("ask.ahead").status, "rolledBack");
  assert.ok(ps.every((p) => flags.get("ask.ahead", p) === 3), "back to 3 days for everyone");
  assert.equal(flags.flag("ask.hour").status, "on", "the shipped ask.hour stays");
  assert.ok(ps.every((p) => flags.get("ask.hour", p) === 18));
  assert.equal(flags.notes().at(-1).text, `Rolled back: how many days ahead the daily "Want a game?" looks is back to 3 days (${out[0].reason}).`);
  assert.deepEqual(calls.setStatus, []);
  assert.deepEqual(flags.history().filter((e) => e.key).map((e) => [e.key, e.action]), [["ask.hour", "canary"], ["ask.hour", "promote"], ["ask.ahead", "canary"], ["ask.ahead", "rollback"]]);
});

// one hard breach, set up by `breach`, during a canary: the flag is off at once and the club told; the breach is
// returned for part A's cycle (which sets the proposal to rolledBack)
async function hard(breach, why) {
  fresh(); const calls = stubs(); const { inside } = club();
  await flags.ship(spec(), { now: T0 });
  await breach();
  const out = await flags.monitor({ now: T0 + DAY });
  assert.equal(out.length, 1); assert.equal(out[0].kind, "hard"); assert.equal(out[0].key, "ask.hour"); assert.equal(out[0].proposal, "P-001"); assert.match(out[0].reason, why);
  const f = flags.flag("ask.hour");
  assert.equal(f.status, "rolledBack"); assert.equal(f.value, 12);
  assert.ok(inside.every((p) => flags.get("ask.hour", p) === 12), "the canary is back on the default");
  assert.match(flags.notes().at(-1).text, /^Rolled back: the hour the Match helper sends its daily "Want a game\?" is back to 12:00 \(/);
  assert.deepEqual(calls.setStatus, [], "the proposal is part A's cycle's to set");
  const h = flags.history("ask.hour").at(-1);
  assert.equal(h.action, "rollback"); assert.equal(h.kind, "hard"); assert.equal(h.by, "code");
  assert.deepEqual(await flags.monitor({ now: T0 + 2 * DAY }), [], "a flag rolled back is not rolled back again");
  return out[0];
}
const booking = (over = {}) => ({ id: "RI-1", created: T0 + 3600e3, cancelled: false, option: { date: "2026-11-05", start: "19:00", minutes: 90, partners: [{ id: "leo", name: "Leo Chen" }], talk: "neg-gm-1", ...over } });
const approvals = (yes = [], asked = [], planned = []) => () => ({ yes: new Set(yes), asked: new Set(asked), planned: new Set(planned) });

test("hard breach: a game the Match helper agreed, booked without the player's yes", async () => {
  await hard(() => flags.use({ readers: { bookings: () => [booking()], approvals: approvals([], ["neg-gm-1"]) } }), /booked without the player's yes \(booking RI-1\)/);
  // with the yes, and with a game the player booked from the Play page, there is none
  fresh(); stubs(); club();
  await flags.ship(spec(), { now: T0 });
  flags.use({ readers: { bookings: () => [booking(), booking({ talk: undefined, start: "09:00" })], approvals: approvals(["neg-gm-1"], ["neg-gm-1"]) } });
  assert.deepEqual(await flags.monitor({ now: T0 + DAY }), []);
  // a booking made before the canary started is not the canary's
  flags.use({ readers: { bookings: () => [{ ...booking(), created: T0 - DAY }], approvals: approvals([], ["neg-gm-1"]) } });
  assert.deepEqual(await flags.monitor({ now: T0 + DAY }), []);
});

test("hard breach: an Autopilot game booked without the player's yes", async () => {
  await hard(() => flags.use({ readers: { bookings: () => [booking({ talk: "neg-ap1" })], approvals: approvals([], [], ["neg-ap1"]) } }), /without the player's yes/);
});

test("hard breach: a member booked into two games at once (play.js playing())", async () => {
  await hard(() => flags.use({ readers: { bookings: () => [booking()], approvals: approvals(["neg-gm-1"], ["neg-gm-1"]),
    playing: async (id, date) => (id === "leo" && date === "2026-11-05" ? [{ from: 19 * 60, to: 20.5 * 60, ref: "RI-1" }, { from: 20 * 60, to: 21.5 * 60, ref: "RI-2" }] : []) } }), /two games at once \(booking RI-1\)/);
});

test("hard breach: the privacy canary's marker in a request to an outside host (fetch is watched)", async () => {
  await hard(async () => {
    const { marker, entry } = flags.plantMarker("canary-test");
    assert.ok(entry.trigger.includes(marker), "the marker goes in the test player's body log");
    flags.watchOutbound({ offline: true });
    flags.use({ readers: { leaks: () => flags.leaks().map((l) => ({ ...l, at: T0 + 3600e3 })) } });
    await assert.rejects(fetch(`https://overpass.example.org/api?data=${encodeURIComponent("knee " + marker)}`), /blocked/);
  }, /marker was in a request to overpass\.example\.org/);
});

test("the outbound watch: an outside request without the marker goes, the marker never leaves", async () => {
  fresh(); stubs();
  const { marker } = flags.plantMarker("canary-test");
  flags.watchOutbound({ offline: true });
  const before = { ...flags.outbound };
  assert.equal((await fetch("https://api.open-meteo.example/forecast?latitude=25.0")).status, 200, "offline: an empty answer");
  await assert.rejects(fetch("https://maps.example.com/q", { method: "POST", body: JSON.stringify({ note: marker }) }), /blocked/);
  await assert.rejects(fetch("https://maps.example.com/q", { method: "POST", body: new URLSearchParams({ q: marker }) }), /blocked/);
  await assert.rejects(fetch(new URL(`https://maps.example.com/${marker}`)), /blocked/);
  // Messenger may carry the test player's own log to the test player only
  await fetch("https://graph.facebook.com/v21.0/me/messages", { method: "POST", body: JSON.stringify({ recipient: { id: "canary-test" }, message: { text: marker } }) });
  await assert.rejects(fetch("https://graph.facebook.com/v21.0/me/messages", { method: "POST", body: JSON.stringify({ recipient: { id: "someone-else" }, message: { text: marker } }) }), /blocked/);
  assert.equal(flags.leaks().length, 4);
  assert.equal(flags.outbound.blocked - before.blocked, 4);
});

test("hard breach: the guard flags more of what the models write than before", async () => {
  fresh(); stubs(); club();
  // before the ship: 1 in 100
  let window = { checked: 100, flagged: 1 };
  flags.use({ readers: { guard: async (q) => (q.until <= T0 ? { checked: 100, flagged: 1 } : window) } });
  await flags.ship(spec(), { now: T0 });
  window = { checked: 100, flagged: 2 };
  assert.deepEqual(await flags.monitor({ now: T0 + DAY }), [], "2% against 1% is within the margin");
  window = { checked: 50, flagged: 4 };
  const out = await flags.monitor({ now: T0 + 2 * DAY });
  assert.equal(out[0].kind, "hard"); assert.match(out[0].reason, /guard flagged 8% .* \(1% before\)/);
  assert.equal(flags.flag("ask.hour").status, "rolledBack");
  // after a restart the ledger in memory may not reach back before the ship: what it was at the ship stands in
  fresh(); stubs(); club();
  window = { checked: 200, flagged: 10 };
  flags.use({ readers: { guard: async () => window } });
  await flags.ship(spec(), { now: T0 }); // 5% at the ship
  window = { checked: 0, flagged: 0 };
  flags.use({ readers: { guard: async (q) => (q.until <= T0 ? { checked: 0, flagged: 0 } : { checked: 100, flagged: 6 }) } });
  assert.deepEqual(await flags.monitor({ now: T0 + DAY }), [], "6% against 5% at the ship");
});

test("soft breach: thumbs down up 10 points among the beta members: off, returned for part A to reopen", async () => {
  fresh();
  // the week before the canary: 6 down in 60; in the canary: 24 down in 60 (the match thumb: Yes up, Not this week down)
  const calls = stubs({ thumbs: (q) => ({ match: q.until <= T0 ? { up: 54, down: 6 } : { up: 36, down: 24 } }) });
  club();
  await flags.ship(spec(), { now: T0 });
  const out = await flags.monitor({ now: T0 + 2 * DAY }), h = flags.history("ask.hour").at(-1);
  assert.equal(out.length, 1); assert.equal(out[0].kind, "soft"); assert.equal(out[0].proposal, "P-001");
  assert.equal(out[0].reason, `thumbs down on it went from 10% to 40%, evidence ${Math.round(h.evidence.e)} to 1 against the change`);
  assert.equal(flags.flag("ask.hour").status, "rolledBack");
  assert.deepEqual(calls.setStatus, []);
  assert.equal(h.kind, "soft");
  // what the monitor measured is kept beside the reason: the test, the counts, z and E
  assert.deepEqual({ ...h.evidence, e: null }, { test: "evalue", before: { up: 54, down: 6 }, after: { up: 36, down: 24 }, z: 3.79, e: null, threshold: 20 });
  assert.ok(h.evidence.e >= 20 && h.evidence.e < 1000, `E ${h.evidence.e}`);
  assert.equal(flags.notes().at(-1).text, `Rolled back: the hour the Match helper sends its daily "Want a game?" is back to 12:00 (${out[0].reason}).`);
  // the old rule (LOOP_SOFT_TEST=z) rolls back on less: 2 down in 20, then 8 in 20 (z 2.1), with the reason it gave
  fresh(); process.env.LOOP_SOFT_TEST = "z";
  stubs({ thumbs: (q) => ({ match: q.until <= T0 ? { up: 18, down: 2 } : { up: 12, down: 8 } }) });
  club();
  await flags.ship(spec(), { now: T0 });
  assert.deepEqual(await flags.monitor({ now: T0 + 2 * DAY }), [{ key: "ask.hour", kind: "soft", reason: "thumbs down on it went from 10% to 40%", proposal: "P-001" }]);
  assert.deepEqual(flags.history("ask.hour").at(-1).evidence, { test: "z", before: { up: 18, down: 2 }, after: { up: 12, down: 8 }, z: 2.19, threshold: 1.645 });
  // the same thumbs are not evidence enough for the e-process
  fresh();
  stubs({ thumbs: (q) => ({ match: q.until <= T0 ? { up: 18, down: 2 } : { up: 12, down: 8 } }) });
  club();
  await flags.ship(spec(), { now: T0 });
  assert.deepEqual(await flags.monitor({ now: T0 + 2 * DAY }), []);
});

test("a canary that changes nothing, watched every 5 minutes for 7 days: the old rule rolls it back early, the e-process promotes it", async () => {
  // four answers a day at 12:00, 13:00, 18:00 and 20:00; one in four Not this week, the 7 days before the ship (05:00)
  // and the canary's days after the first; on the canary's first day the first four happen to be Not this week
  const H = 36e5, ship = T0 - 7 * H, thumbsAt = [];
  for (let d = -7; d < 7; d++) for (const [i, hr] of [12, 13, 18, 20].entries()) thumbsAt.push([ship - 5 * H + d * DAY + hr * H, d === 0 ? true : i === 0 && d < 0]);
  thumbsAt.push([ship - 5 * H + DAY + 12 * H, true]); // and the first answer of the second day
  const thumbs = (q) => { let up = 0, down = 0; for (const [at, d] of thumbsAt) if (at >= q.since && at < q.until) d ? down++ : up++; return { match: { up, down } }; };
  const watch = async (test) => {
    fresh(); if (test) process.env.LOOP_SOFT_TEST = test;
    stubs({ thumbs }); club();
    await flags.ship(spec(), { now: ship });
    for (let t = ship + 5 * 6e4; t <= ship + 7 * DAY; t += 5 * 6e4) { const out = await flags.monitor({ now: t }); if (out.length) return { at: (t - ship) / DAY, ...out[0] }; }
    return null;
  };
  const z = await watch("z");
  assert.equal(z?.kind, "soft", "the old rule, at every look: a false rollback");
  assert.ok(z.at < 2, `on day ${z.at.toFixed(2)}`);
  const e = await watch(null);
  assert.equal(e?.kind, "promoted", JSON.stringify(e));
  assert.ok(Math.abs(e.at - 7) < 1e-9);
});

test("the guard's rate counts only its verdicts on what models wrote to players, not the loop's screen of shared ideas", () => {
  const at = T0 + DAY, rows = [
    { site: "guard.out", guard: "safe", at }, { site: "guard.out", guard: "S6", at }, { site: "guard.out", guard: "safe", at: T0 - 5 * DAY },
    { site: "loop.screen", guard: "S1", at }, { site: "loop.screen", guard: "S10", at }, { site: "guard.in", guard: "S2", at }, { site: "guard.injection", guard: "3/4", at },
    { site: "autopilot", at },
  ];
  assert.deepEqual(flags.guardTally(rows, { since: T0, until: T0 + 2 * DAY }), { checked: 2, flagged: 1 });
});

test("soft breach: measured on the canary's members only, so the rest of the beta list cannot dilute it", async () => {
  // a fixed secret: which members fall in the canary is the same on every run (with a fresh random secret the canary
  // was sometimes 6 members or fewer, too few thumbs for 20 to 1, and the test failed now and then)
  fs.writeFileSync(path.join(fresh(), "secret"), "5e7c0a11".repeat(8));
  // per member, 20 thumbs: 4 down before; in the canary, 12 of 20 down for its members, 4 of 16 for the rest
  // (measured over the whole beta list, the rest would dilute the rise)
  let inside = new Set();
  const thumbs = (q) => {
    let up = 0, down = 0;
    for (const w of q.whos || []) { const d = q.until <= T0 ? 4 : inside.has(w) ? 12 : 4; down += d; up += (q.until <= T0 ? 20 : inside.has(w) ? 20 : 16) - d; }
    return { match: { up, down } };
  };
  const calls = stubs({ thumbs });
  const c = club(60);
  inside = new Set(c.inside.map((p) => flags.whoOf(p)));
  // (2 canary members are 40 thumbs on each side: E 73; 1 would be too few)
  assert.ok(c.inside.length >= 2 && c.outside.length, `the test needs 2 or more members in the canary and some outside it (${c.inside.length} in)`);
  await flags.ship(spec(), { now: T0 });
  const out = await flags.monitor({ now: T0 + 2 * DAY });
  assert.equal(out[0]?.kind, "soft", JSON.stringify(out));
  // (E as anytime.odds says it: a whole number, or "over a million")
  assert.match(out[0].reason, /^thumbs down on it went from 20% to 60%, evidence ([\d,]+|over a million) to 1 against the change$/);
  assert.equal(flags.history("ask.hour").at(-1).evidence.test, "evalue");
  for (const q of calls.counts) assert.deepEqual(new Set(q.whos), inside, "only the canary's members are measured");
});

test("soft breach: less than 10 points up, a rise that could be chance, or too few thumbs, is not a breach", async () => {
  const soft = async (before, after, test = null) => {
    fresh(); if (test) process.env.LOOP_SOFT_TEST = test;
    stubs({ thumbs: (q) => ({ match: q.until <= T0 ? before : after }) }); club();
    await flags.ship(spec(), { now: T0 });
    return (await flags.monitor({ now: T0 + 2 * DAY }))[0]?.reason ?? null;
  };
  for (const test of [null, "z"]) {
    assert.equal(await soft({ up: 9, down: 1 }, { up: 17, down: 3 }, test), null, "10% to 15%");
    assert.equal(await soft({ up: 1800, down: 200 }, { up: 1700, down: 300 }, test), null, "10% to 15% on 2,000 thumbs: beyond chance, but under 10 points");
    assert.equal(await soft({ up: 9, down: 1 }, { up: 8, down: 2 }, test), null, "10% to 20% on 10 thumbs: could be chance (z 0.6)");
    assert.equal(await soft({ up: 0, down: 0 }, { up: 2, down: 8 }, test), null, "no thumbs before: no rise to see");
    assert.equal(await soft({ up: 9, down: 1 }, { up: 1, down: 3 }, test), null, "4 thumbs are too few to judge");
  }
  // exactly 10 points on 200 thumbs: z 2.8 is a breach for the old rule; the e-process weighs it against rises of 10
  // points or more, and half of what such a rise looks like is below 10: E 0.25, no breach
  assert.equal(await soft({ up: 180, down: 20 }, { up: 160, down: 40 }, "z"), "thumbs down on it went from 10% to 20%", "10 points on 200 thumbs (z 2.8)");
  assert.equal(await soft({ up: 180, down: 20 }, { up: 160, down: 40 }), null, "10 points on 200 thumbs, E 0.25");
  assert.match(await soft({ up: 180, down: 20 }, { up: 140, down: 60 }), /^thumbs down on it went from 10% to 30%, evidence [\d,]+ to 1/, "20 points on 200 thumbs");
  assert.ok(Math.abs(flags.zRise({ up: 14, down: 15 }, { up: 20, down: 8 }) - 1.78) < 0.01, "part A's run 2: 8 of 28 down, then 15 of 29, is z 1.78");
});

test("soft breach: the unmet requests in the source cluster do not fall over the canary", async () => {
  fresh();
  const calls = stubs({ unmet: (q) => (q.until <= T0 ? 7 : 8) });
  club();
  await flags.ship(spec(), { now: T0 });
  assert.deepEqual(await flags.monitor({ now: T0 + 3 * DAY }), [], "judged when the canary ends");
  const out = await flags.monitor({ now: T0 + 7 * DAY });
  assert.deepEqual(out, [{ key: "ask.hour", kind: "soft", reason: "the requests it was for did not fall (7 in the 7 days before, 8 in the canary's 7 days)", proposal: "P-001" }]);
  assert.deepEqual(calls.measure.slice(-2).map((q) => [q.id, q.since, q.until]), [["P-001", T0, T0 + 7 * DAY], ["P-001", T0 - 7 * DAY, T0]]);
  // falling: promoted
  fresh();
  stubs({ unmet: (q) => (q.until <= T0 ? 7 : 2) });
  club();
  await flags.ship(spec(), { now: T0 });
  assert.equal((await flags.monitor({ now: T0 + 7 * DAY }))[0].kind, "promoted");
  assert.equal(flags.flag("ask.hour").status, "on");
});

test("after it ships, hard breaches are still watched for 7 days; a manual rollback is kept with who and why", async () => {
  fresh(); stubs(); club();
  await flags.ship(spec(), { now: T0 });
  await flags.monitor({ now: T0 + 7 * DAY });
  flags.use({ readers: { leaks: () => [{ at: T0 + 8 * DAY, host: "nominatim.example.org" }] } });
  assert.equal((await flags.monitor({ now: T0 + 8 * DAY }))[0].kind, "hard");
  fresh(); stubs(); club();
  await flags.ship(spec(), { now: T0 });
  const f = await flags.rollback("ask.hour", "the maintainer stopped it", { by: "maintainer", now: T0 + DAY });
  assert.equal(f.status, "rolledBack"); assert.equal(f.reason, "the maintainer stopped it");
  assert.deepEqual(flags.history("ask.hour").map((e) => [e.action, e.by]), [["canary", "code"], ["rollback", "maintainer"]]);
  assert.equal((await flags.rollback("ask.hour", "again")).already, true, "rolling back twice changes nothing");
  assert.equal(flags.history("ask.hour").length, 2);
});

// ---- the gate runner -------------------------------------------------------------------------------------------
const ok = (details = {}) => async () => ({ ok: true, details });
const all = (over = {}) => ({ ...Object.fromEntries(gates.ORDER.map((g) => [g, ok()])), ...over });

test("gates: all nine in the contract's order; pass only when every one passes", async () => {
  fresh(); stubs();
  const seen = [];
  const r = await gates.runGates(spec(), { gates: all(), onResult: (x) => seen.push(x.gate) });
  assert.equal(r.pass, true);
  assert.deepEqual(r.results.map((x) => x.gate), ["policy", "scan", "unit", "crash_matrix", "redteam", "e2e", "autopilot_eval", "oracle", "privacy"]);
  assert.deepEqual(seen, gates.ORDER);
  assert.ok(r.results.every((x) => x.ok && typeof x.details.took === "number"));
});

test("gates: the first failure stops the run (the GPU gates never start), a throwing gate fails closed", async () => {
  fresh(); stubs();
  let gpu = 0;
  const r = await gates.runGates(spec(), { gates: all({ unit: async () => ({ ok: false, details: { fail: 1 } }), crash_matrix: async () => { gpu++; return { ok: true }; } }) });
  assert.equal(r.pass, false); assert.equal(gpu, 0);
  assert.deepEqual(r.results.map((x) => [x.gate, x.ok]), gates.ORDER.map((g, i) => [g, i < 2]));
  assert.equal(r.results[3].details.skipped, "an earlier gate failed");
  const t = await gates.runGates(spec(), { gates: all({ scan: async () => { throw new Error("boom"); } }) });
  assert.equal(t.pass, false); assert.equal(t.results[1].details.error, "boom");
  const s = await gates.runGates(spec(), { gates: all(), only: ["policy", "scan", "oracle"] });
  assert.equal(s.pass, false, "a subset never ships"); assert.equal(s.subsetOk, true); assert.equal(s.results.length, 3);
});

test("gates: a C0 change runs on its value in a scratch folder; the live flags are not touched", async () => {
  const D = fresh(); stubs();
  flags.set("ask.hour", 12, { by: "maintainer", reason: "live state", now: T0 });
  const live = fs.readFileSync(path.join(D, "flags.json"), "utf8");
  let scratch = null;
  const r = await gates.runGates(spec(), { gates: all({ unit: async (ctx) => {
    scratch = ctx.env.LOOP_DIR;
    const f = JSON.parse(fs.readFileSync(ctx.env.LOOP_FLAGS_FILE, "utf8"));
    return { ok: f["ask.hour"].value === 18 && f["ask.hour"].status === "on" && ctx.env.LOOP_DIR !== D && ctx.env.LOOP_SECRET_FILE.startsWith(scratch) };
  } }) });
  assert.equal(r.pass, true);
  assert.equal(fs.readFileSync(path.join(D, "flags.json"), "utf8"), live);
  assert.equal(fs.existsSync(scratch), false, "the scratch folder is removed");
});

test("gate 1 (part B's classifier for a flag value, its policy for a diff) and gate 2 (the code scan)", async () => {
  fresh(); stubs();
  const run = async (s) => (await gates.runGates(s, { gates: all({ policy: gates.GATES.policy, scan: gates.GATES.scan }), only: ["policy", "scan"], keepGoing: true })).results;
  const [p, sc] = await run(spec());
  assert.equal(p.details.by, fs.existsSync(path.join(gates.AGENT, "src/loop/review.js")) ? "review.classify" : "stub (no review.js)");
  assert.equal(p.ok, true); assert.equal(sc.ok, true); assert.equal(sc.details.lines, 0, "a flag value adds no code");
  const [out] = await run(spec({ change: { class: "C0", key: "ask.hour", value: 30 } }));
  assert.equal(out.ok, false); assert.notEqual(out.details.class, "C0");
  assert.equal((await run(spec({ change: { class: "C0", key: "ask.minute", value: 5 } })))[0].ok, false, "an undeclared key");
  // a C1-C3 change goes to test/policy.mjs on its diff, and with no branch there is nothing to gate
  const c1 = await gates.runGates(spec({ change: { class: "C1", files: ["agent/src/ask.js"], summary: "" } }), { gates: all(), only: ["policy"] }).catch((e) => ({ error: e.message }));
  assert.match(c1.error, /gated on its branch/);
  // on a diff: B's policy.mjs (this tree's), which refuses the never-list and fails closed on what is not a diff
  if (fs.existsSync(path.join(gates.AGENT, "test/policy.mjs"))) {
    const ctx = (diff) => ({ spec: { change: { class: "C1" } }, scratch: fs.mkdtempSync(path.join(root, "pol-")), diff, env: {}, endpoint: gates.endpoint() });
    const d = (file, line) => `diff --git a/${file} b/${file}\nindex 1111111..2222222 100644\n--- a/${file}\n+++ b/${file}\n@@ -1,1 +1,2 @@\n line one\n+${line}\n`;
    const guard = await gates.GATES.policy(ctx(d("agent/src/guard.js", "export const off = true;")));
    assert.equal(guard.ok, false); assert.ok(guard.details.refused.some((r) => r.rule === "never-path"));
    assert.equal((await gates.GATES.policy(ctx("this is not a diff"))).ok, false, "fails closed");
    const plain = await gates.GATES.policy(ctx(d("docs/design.md", "The Match helper asks once a day.")));
    assert.equal(plain.ok, true, JSON.stringify(plain.details));
  }
  const diff = ["+++ b/agent/src/x.js", "@@ -1,0 +1,6 @@", '+const k = "sk-abcdefghijklmnopqrstuvwxyz123456";', "+require('child_process').execSync('ls');", "+await fetch('https://evil.example/x');", "+eval(code);", "+const total = a + b;", "+// a plain comment"].join("\n");
  const f = gates.scanDiff(diff);
  assert.deepEqual(f.map((x) => [x.kind, x.line]), [["secret", 1], ["shell", 2], ["network", 3], ["eval", 4]]);
  assert.ok(!JSON.stringify(f).includes("sk-abc"), "a finding never shows the secret");
});

test("the model endpoint is a parameter: this server's GPU under the lock by default, another one without it", async () => {
  fresh(); stubs();
  const d = gates.endpoint();
  assert.deepEqual([d.name, d.lock, d.env], ["3090", true, {}]);
  const a = gates.endpoint("http://127.0.0.1:11445/v1/");
  assert.deepEqual([a.name, a.lock, a.env], ["11445", false, { LLM_URL: "http://127.0.0.1:11445/v1", LLM_SLOTS: "8", EMBED_URL: "http://127.0.0.1:11445" }]);
  assert.throws(() => gates.endpoint("file:///etc/passwd"), /http/);
  assert.match(gates.baselinesFile(), /baselines\.json$/); assert.match(gates.baselinesFile("11445"), /baselines-11445\.json$/);
  let seen = null;
  const r = await gates.runGates(spec(), { endpoint: "http://127.0.0.1:11445", gates: all({ unit: async (ctx) => { seen = { ...ctx.env, lock: ctx.endpoint.lock }; return { ok: true }; } }), only: ["unit"] });
  assert.equal(r.endpoint, "11445");
  assert.equal(seen.LLM_URL, "http://127.0.0.1:11445/v1"); assert.equal(seen.lock, false); assert.ok(seen.LOOP_FLAGS_FILE);
});

test("gate 7's numbers: pass^3, tokens per run within +15%, p95 within +20%", () => {
  const rows = [...Array(3)].flatMap((_, i) => [{ scenario: "A", success: true, seconds: 40 + i, tokens: { prompt: 9000, output: 1000 } }, { scenario: "B", success: true, seconds: 60, tokens: { prompt: 9000, output: 1000 } }]);
  const n = gates.autopilotNumbers(rows);
  assert.deepEqual(n, { runs: 6, weeks: 2, passK: 1, tokensPerRun: 10000, p95Seconds: 60 });
  assert.deepEqual(gates.judgeAutopilot(n, { tokensPerRun: 9000, p95Seconds: 55 }), [], "+11% tokens and +9% p95 are fine");
  assert.equal(gates.judgeAutopilot(n, { tokensPerRun: 8600, p95Seconds: 55 }).length, 1, "+16% tokens is not");
  assert.equal(gates.judgeAutopilot(n, { tokensPerRun: 9000, p95Seconds: 49 }).length, 1, "+22% p95 is not");
  assert.equal(gates.judgeAutopilot(gates.autopilotNumbers([...rows, { scenario: "B", success: false, seconds: 1 }]), null)[0], "pass^3 0.5 < 1");
  assert.equal(gates.weeks().length, 9, "the eval's nine weeks");
});

test("gate 8: an oracle runs only a test file of this tree, never text from the spec", async () => {
  fresh(); stubs();
  for (const how of ["rm -rf /", "test/../../x.mjs", "node -e 1", "test/nope.mjs"]) {
    const r = await gates.runGates(spec({ oracle: { kind: "unit", how } }), { gates: all({ oracle: gates.GATES.oracle }), only: ["oracle"] });
    assert.equal(r.results[0].ok, false, how);
  }
  const r = await gates.runGates(spec({ oracle: { kind: "magic" } }), { gates: all({ oracle: gates.GATES.oracle }), only: ["oracle"] });
  assert.match(r.results[0].details.reasons[0], /no oracle the gates can run/);
});

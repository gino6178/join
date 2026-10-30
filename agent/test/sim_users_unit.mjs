// The user simulation's pure parts (test/sim_users): the seeded dice, the personas, the inertia model, the court
// timetable the baseline uses, the counterfactual baseline, the measures, and the injected clock.
//   node --test test/sim_users_unit.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { u, stream, hash32 } from "./sim_users/rng.mjs";
import { generate, PERSONA_SEED, trialClub, asMember, variety } from "./sim_users/personas.mjs";
import * as I from "./sim_users/inertia.mjs";
import { freeCourts } from "./sim_users/courts.mjs";
import { runBaseline } from "./sim_users/baseline.mjs";
import { bootstrap, wilson, measure } from "./sim_users/metrics.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const venues = JSON.parse(fs.readFileSync(path.join(HERE, "../../web/public/data/venues.json"), "utf8"));
const personas = generate();
const DATES = ["2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08"];

test("sim dice: the same name gives the same draw, another name another", () => {
  assert.equal(u(1, "busy", "u01", "2026-11-05"), u(1, "busy", "u01", "2026-11-05"));
  assert.notEqual(u(1, "busy", "u01", "2026-11-05"), u(2, "busy", "u01", "2026-11-05"));
  assert.notEqual(u(1, "busy", "u01", "2026-11-05"), u(1, "busy", "u02", "2026-11-05"));
  const r = stream(3, "x"), a = Array.from({ length: 2000 }, r);
  assert.ok(a.every((x) => x >= 0 && x < 1));
  assert.ok(Math.abs(a.reduce((s, x) => s + x, 0) / a.length - 0.5) < 0.03, "the draws are spread evenly");
  assert.equal(hash32("a"), hash32("a"));
});

test("personas: twenty invented, simulated people, the same from the same seed, and the file is what the code makes", () => {
  assert.equal(personas.length, 20);
  assert.deepEqual(generate(PERSONA_SEED), personas);
  const file = JSON.parse(fs.readFileSync(path.join(HERE, "sim_users/personas.json"), "utf8"));
  assert.equal(file.simulated, true);
  assert.deepEqual(file.personas, personas, "personas.json is generate()'s output (node test/sim_users/personas.mjs)");
  assert.equal(new Set(personas.map((p) => p.id)).size, 20);
  assert.equal(new Set(personas.map((p) => p.name)).size, 20);
  assert.ok(personas.every((p) => p.simulated === true));
  // no name from the demo club or the population generator
  const club = JSON.parse(fs.readFileSync(path.join(HERE, "../../web/public/data/club.json"), "utf8"));
  const taken = new Set(club.members.flatMap((m) => m.name.split(" ")));
  assert.ok(personas.every((p) => !p.name.split(" ").some((w) => taken.has(w))), "no name shared with the demo club");
  for (const p of personas) {
    assert.ok(p.free.length >= 2 && p.free.every((w) => /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d\d-\d\d$/.test(w)), `${p.id} free times`);
    assert.ok(p.sessions.every((s) => /^\d\d:\d\d$/.test(s)));
    for (const k of ["pOpen", "pNotThisWeek", "flaky", "pBusy"]) assert.ok(p.inertia[k] > 0 && p.inertia[k] < 1, `${p.id} ${k}`);
  }
});

test("personas: they vary in what matters", () => {
  const v = variety(personas);
  assert.ok(Object.keys(v.archetypes).length >= 6, "at least six kinds of week");
  assert.ok(Object.keys(v.languages).length === 3);
  assert.ok(Object.keys(v.levels).length === 4);
  const lazy = personas.map((p) => p.inertia.laziness);
  assert.ok(Math.max(...lazy) - Math.min(...lazy) >= 0.6, "eager and lazy people both");
  assert.ok(lazy.filter((x) => x >= 0.65).length >= 4 && lazy.filter((x) => x <= 0.3).length >= 4);
  assert.ok(v.weekendPlayers >= 5 && v.weekendPlayers <= 18, "weekday and weekend players both");
  assert.ok(Object.keys(v.prefers).length === 3);
});

test("the trial club: the personas as simulated members, nobody else, no demo history", () => {
  const c = trialClub(personas);
  assert.equal(c.members.length, 20);
  assert.equal(c.demo, false);
  assert.ok(c.members.every((m) => m.simulated && m.history.length === 0 && m.rulesComplete && Array.isArray(m.free)));
  assert.equal(c.you.free.length, 0, "the app's own player asks for nothing");
  assert.deepEqual(asMember(personas[0]).free, personas[0].free);
});

test("inertia: a game is never a yes when they're not free or need none", () => {
  const p = personas[0];
  for (let k = 0; k < 200; k++) {
    assert.notEqual(I.answerGame(1, p, { date: "2026-11-05", start: "03:00", need: 1, key: `k${k}` }), "yes");
    assert.notEqual(I.answerGame(1, p, { date: "2026-11-05", start: "20:00", need: 0, key: `k${k}` }), "yes");
  }
  assert.ok(["yes", "other", "week", "ignore"].includes(I.answerGame(1, p, { date: "2026-11-05", start: "20:00", need: 1, key: "x" })));
  assert.equal(I.shows(1, p, { date: "2026-11-05", start: "20:00", knows: false, key: "x" }).shows, false);
  const lazy = [...personas].sort((a, b) => a.inertia.laziness - b.inertia.laziness);
  assert.ok(I.pInitiate(lazy[0]) > I.pInitiate(lazy.at(-1)), "the lazier start less");
  assert.deepEqual(I.dayPlan(5, p, "2026-11-06"), I.dayPlan(5, p, "2026-11-06"));
  assert.equal(I.trialNeed({ goal: { perWeek: 1 } }), 1);
  assert.equal(I.trialNeed({ goal: { perWeek: 3 } }), 2);
});

test("inertia: a lazier person opens less, answers slower, declines and flakes more, gives up sooner", () => {
  for (const p of personas) {
    const up = I.withLaziness(p, p.inertia.laziness + 0.2), down = I.withLaziness(p, p.inertia.laziness - 0.2);
    assert.ok(up.inertia.pOpen <= p.inertia.pOpen && down.inertia.pOpen >= p.inertia.pOpen);
    assert.ok(up.inertia.replyMin >= p.inertia.replyMin && up.inertia.pNotThisWeek >= p.inertia.pNotThisWeek && up.inertia.flaky >= p.inertia.flaky && up.inertia.patienceH <= p.inertia.patienceH);
    assert.ok(up.inertia.laziness <= 0.98 && down.inertia.laziness >= 0.02 && up.inertia.pBusy === p.inertia.pBusy);
  }
  assert.deepEqual(I.withLaziness(personas[3], personas[3].inertia.laziness).inertia.laziness, personas[3].inertia.laziness);
});

test("inertia: the game they have in mind is in their free times, three hours ahead, within the trial", () => {
  for (const p of personas) for (const seed of [1, 2]) {
    const now = new Date("2026-11-05T08:00:00"), s = I.wantedSlot(seed, p, now, { until: "2026-11-08" });
    if (!s) continue;
    assert.ok(I.inWindow(p, s.date, s.start), `${p.id} ${s.date} ${s.start}`);
    assert.ok(new Date(`${s.date}T${s.start}`) - now >= 3 * 36e5);
    assert.ok(s.date <= "2026-11-08");
    assert.ok(["singles", "doubles"].includes(s.format));
  }
});

test("courts: the baseline's timetable is play.js's", async () => {
  let play;
  try { play = await import("../src/play.js"); } catch { return; } // (a tree without the gateway's dependencies)
  for (const v of venues.venues) for (const date of DATES) for (const start of [9 * 60, 14 * 60, 19 * 60, 20 * 60]) {
    const [y, m, d] = date.split("-").map(Number);
    const want = play.demoVenues.freeCourts(v, new Date(y, m - 1, d), start, 90).filter(() => true);
    if (play.bookings().length) return; // (a bookings file in the way: not this test's world)
    assert.deepEqual(freeCourts(v, date, start, 90), want, `${v.id} ${date} ${start}`);
  }
});

test("the trial's requests reach matchmaking, and a calendar note still files as one", async () => {
  let flow;
  try { flow = await import("../src/match/flow.js"); } catch { return; } // (a tree without the gateway's dependencies)
  for (const t of ["need badminton doubles tonight 19 to 22", "Find badminton doubles for Sunday afternoon, level A.", "下午想找 badminton doubles，level A，有場嗎？", "幫我安排今晚羽毛球單打，程度B左右，謝謝", "Need badminton doubles this afternoon. Level A. Can you find partner?", "anyone for doubles Thursday?"])
    assert.ok(flow.isPlayRequest(t), t);
  for (const t of ["I have club training on Wednesday from 19:00 to 21:00", "badminton training Thursday 19:00-21:00", "My right knee is sore after jumping", "有人在嗎"]) assert.ok(!flow.isPlayRequest(t), t);
});

test("courts: a court booked in the baseline's world is not free again", () => {
  const v = venues.venues[0], free = freeCourts(v, "2026-11-07", 10 * 60, 90);
  assert.ok(free.length > 0);
  const after = freeCourts(v, "2026-11-07", 10 * 60, 90, { booked: [{ venue: v.id, date: "2026-11-07", start: "10:00", minutes: 90, court: free[0] }] });
  assert.ok(!after.includes(free[0]));
});

test("baseline: the same seed gives the same week, every game fits everyone and no one plays twice at once", () => {
  const a = runBaseline({ personas, venues, seed: 3, dates: DATES }), b = runBaseline({ personas, venues, seed: 3, dates: DATES });
  assert.deepEqual(a.games, b.games);
  const byId = Object.fromEntries(personas.map((p) => [p.id, p]));
  for (const seed of [1, 2, 3, 4, 5]) {
    const r = runBaseline({ personas, venues, seed, dates: DATES }), slots = {};
    for (const g of r.games) {
      assert.ok(DATES.includes(g.date), "games only in the trial");
      for (const id of [g.by, ...g.with]) {
        assert.ok(I.inWindow(byId[id], g.date, g.start, g.minutes), `${id} free at ${g.date} ${g.start}`);
        const k = `${id} ${g.date}`; assert.ok(!slots[k], `${id} has one game on ${g.date}`); slots[k] = 1;
      }
      assert.equal(g.with.length, g.format === "doubles" ? 3 : 1);
    }
    for (const at of r.attempts) assert.ok((at.actions[at.by] || 0) >= 1, "organizing costs the organizer at least a message");
    const played = r.games.filter((g) => g.played).length;
    assert.ok(Object.values(r.perUser).reduce((s, x) => s + x.played, 0) === r.games.filter((g) => g.played).reduce((s, g) => s + 1 + g.with.length, 0));
    assert.ok(played <= r.games.length);
  }
});

test("baseline: with nobody busy, flaky or slow, the people who would play do", () => {
  const easy = personas.map((p) => ({ ...p, inertia: { ...p.inertia, pBusy: 0, flaky: 0, pOpen: 1, laziness: 0, replyMin: 5, patienceH: 12, pNotThisWeek: 0.01 } }));
  const r = runBaseline({ personas: easy, venues, seed: 1, dates: DATES }), hard = runBaseline({ personas, venues, seed: 1, dates: DATES });
  assert.ok(r.games.every((g) => g.played), "everyone turns up");
  assert.ok(r.games.length >= hard.games.length, "less inertia, at least as many games");
});

test("measures: intervals and counts", () => {
  const ci = bootstrap([1, 1, 1, 1], (s) => s.reduce((a, b) => a + b, 0) / s.length);
  assert.deepEqual(ci, [1, 1]);
  const w = wilson(5, 10);
  assert.ok(w[0] < 0.5 && w[1] > 0.5 && w[0] > 0 && w[1] < 1);
  assert.equal(wilson(0, 0), null);
  const ps = personas.slice(0, 4), ids = ps.map((p) => p.id);
  const serve = { games: [{ key: "g1", date: DATES[0], start: "19:00", minutes: 90, format: "singles", by: ids[0], with: [ids[1]], created: Date.parse(`${DATES[0]}T10:00`), played: true, turnout: [{ id: ids[0], shows: true }, { id: ids[1], shows: true }] }],
    st: Object.fromEntries(ids.map((id, i) => [id, { actions: i === 0 ? [{ at: Date.parse(`${DATES[0]}T09:00`), what: "request" }, { at: Date.parse(`${DATES[0]}T09:30`), what: "answer-ask", on: "m1" }] : [], episodes: i === 0 ? [{ at: Date.parse(`${DATES[0]}T09:00`) }] : [], decisions: [], activated: i === 0 ? DATES[0] : null, days: [] }])),
    inbox: {}, audit: {}, proposals: { proposals: [] }, flags: {}, ideas: { ideas: [] }, feed: null, flight: {}, persona: {} };
  const base = { games: [], attempts: [], log: [], perUser: Object.fromEntries(ids.map((id) => [id, { played: 0, actions: 0 }])) };
  const m = measure({ run: "t", seed: 1, dates: DATES, personas: ps, serve, base, dataDir: "/nonexistent" });
  assert.equal(m.headline.gamesPlayed.serve, 1);
  assert.equal(m.headline.playerGames.serve, 2);
  assert.equal(m.headline.usersWithAGame.serve, 2);
  assert.equal(m.headline.wantToBookedMin.serveMedian, 60);
  assert.equal(m.headline.actionsPerGame.serve, 2);
  assert.equal(m.days[0].newUsers, 1);
  assert.equal(m.never.length, 2);
  assert.ok(m.simulated);
});

test("the seed loader: only where it is told, everything marked simulated, dates moved, HMACs its own, and removable", async () => {
  const { plan, apply } = await import("./sim_users/load_seed.mjs");
  const os = await import("node:os"), crypto = await import("node:crypto");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sim-seed-")), seed = path.join(tmp, "seed"), into = path.join(tmp, "data");
  fs.mkdirSync(seed); fs.mkdirSync(path.join(into, "loop"), { recursive: true });
  const w = (f, x) => fs.writeFileSync(path.join(seed, f), JSON.stringify(x));
  w("manifest.json", { simulated: true, run: "t", seed: 1, trial: { first: "2026-11-05", last: "2026-11-08" } });
  w("members.json", { simulated: true, members: [{ id: "u01", simulated: true }, { id: "u02", simulated: true }] });
  w("records.json", { members: { u01: { asked: [{ t: Date.parse("2026-11-06T10:00:00"), from: "u02", date: "2026-11-06", start: "19:00", yes: 1 }], own: [], games: [] } } });
  w("games.json", { bookings: [{ id: "SIM-X", created: Date.parse("2026-11-06T10:00:00"), option: { date: "2026-11-06", start: "19:00", by: "u01", partners: [{ id: "u02" }] }, invites: [], log: [] }] });
  w("feed.json", { posts: [] });
  w("loop.json", { items: [{ player: "u02", text: "let me pick the court", kind: "wish", at: Date.parse("2026-11-07T09:00:00") }] });
  fs.writeFileSync(path.join(into, "loop/secret"), "s3cret");
  fs.writeFileSync(path.join(into, "match_records.json"), JSON.stringify({ members: { leo: { asked: [], own: [], games: [] } } }));
  assert.throws(() => plan({ seed }), /--into/);
  const now = Date.parse("2026-12-01T09:00:00"), p = plan({ into, seed, now });
  assert.equal(p.shift, 22, "the trial's last day becomes yesterday");
  apply(p, { now });
  const rec = JSON.parse(fs.readFileSync(path.join(into, "match_records.json"), "utf8"));
  assert.ok(rec.members.leo && rec.members.u01.simulated && rec.members.u01.asked[0].date === "2026-11-28");
  const sig = JSON.parse(fs.readFileSync(path.join(into, "loop/signals.json"), "utf8"));
  assert.equal(sig.items[0].who, crypto.createHmac("sha256", "s3cret").update("u02").digest("hex"));
  assert.ok(sig.items.every((x) => x.simulated && !("player" in x)));
  const bk = JSON.parse(fs.readFileSync(path.join(into, "bookings.json"), "utf8"));
  assert.ok(bk.bookings[0].simulated && bk.bookings[0].option.date === "2026-11-28");
  assert.ok(fs.readdirSync(into).some((f) => f.startsWith("match_records.json.before-sim-seed-")), "a copy of what it changed");
  apply(plan({ into, seed, now, remove: true }), { now: now + 1 });
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(into, "match_records.json"), "utf8")).members), ["leo"]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(into, "loop/signals.json"), "utf8")).items.length, 0);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("the injected clock: Date starts at the simulated time and moves only forward", async () => {
  const start = Date.parse("2026-11-05T00:00:00Z");
  const code = `process.send({ a: Date.now(), b: new Date().getTime(), c: new Date(0).getTime(), d: typeof Date() });
process.on("message", (m) => { if (m.final) process.send({ e: Date.now() }); });`;
  const out = await new Promise((ok, no) => {
    const c = spawn(process.execPath, ["--import", pathToFileURL(path.join(HERE, "sim_users/clock.mjs")).href, "-e", code], { env: { ...process.env, SIM_CLOCK_START: String(start) }, stdio: ["ignore", "ignore", "inherit", "ipc"] });
    const got = [];
    c.on("message", (m) => {
      got.push(m);
      if (m.a) c.send({ simClock: start + 864e5, id: "j" });
      if (m.simClockAck === "j") c.send({ simClock: start, id: "back" }); // (backwards: ignored)
      if (m.simClockAck === "back") c.send({ final: true });
      if (m.e) { c.kill(); ok(got); }
    });
    c.on("error", no); setTimeout(() => { c.kill(); no(new Error("timeout")); }, 8000);
  });
  assert.ok(Math.abs(out[0].a - start) < 2000 && Math.abs(out[0].b - start) < 2000, "starts at the simulated time");
  assert.equal(out[0].c, 0, "a given time is that time");
  assert.equal(out[0].d, "string");
  assert.ok(out[1].simClockAck === "j" && Math.abs(out[1].now - start - 864e5) < 2000, "moved a day ahead");
  assert.ok(out.at(-1).e >= start + 864e5, "never back");
});

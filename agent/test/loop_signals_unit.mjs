// Unit tests for the community loop's signals and proposals (loop/signals.js, loop/proposals.js), with no model and no
// GPU: consent, who, the code checks on a shared sentence, per-item sharing, /forget, clustering (with a stand-in
// embedder), the 5-member threshold, both groups, sock puppets, chaining, the catalog, quadratic votes and the
// Rule of Two.   node --test test/loop_signals_unit.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "serve-loop-"));
Object.assign(process.env, { LOOP_DIR: `${tmp}/loop`, STORE_FILE: `${tmp}/players.json`, LEDGER_FILE: `${tmp}/ledger.jsonl`, TRACE_FILE: `${tmp}/traces.jsonl`, GUARD: "off", LLM_URL: "http://127.0.0.1:9/v1", MEMORY_EMBED: "bm25", LOOP_GUARDS: "none" });
const signals = await import("../src/loop/signals.js");
const proposals = await import("../src/loop/proposals.js");
const store = await import("../src/store.js");
const { stub } = await import("../src/loop/parts.js");

const fake = (text) => async () => ({ ok: true, text }); // a paraphrase without the model
const player = (id, name = "there") => { store.link(id, name); return id; };

test("who is an HMAC of the player id with a secret made once, mode 600", () => {
  const a = signals.whoOf("4242"), b = signals.whoOf("4242");
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, signals.whoOf("4243"));
  assert.ok(!a.includes("4242"));
  const sec = path.join(process.env.LOOP_DIR, "secret");
  assert.ok(fs.existsSync(sec));
  if (process.platform !== "win32") assert.equal(fs.statSync(sec).mode & 0o777, 0o600);
  assert.equal(crypto.createHmac("sha256", fs.readFileSync(sec, "utf8").trim()).update("4242").digest("hex"), a);
});

test("consent: nothing is counted until /improve on, and /improve off deletes the counts", () => {
  const p = player("p1");
  assert.equal(signals.record(p, { kind: "thumb", feature: "answers", value: 1 }).recorded, false);
  signals.consent(p, true);
  assert.equal(signals.record(p, { kind: "thumb", feature: "answers", value: 1 }).recorded, true);
  assert.equal(signals.record(p, { kind: "thumb", feature: "match", value: -1 }).recorded, true);
  assert.equal(signals.record(p, { kind: "count", site: "ask.yes", n: 1 }).recorded, true);
  assert.deepEqual(signals.counts().thumbs, { answers: { up: 1, down: 0 }, match: { up: 0, down: 1 } });
  signals.consent(p, false);
  assert.equal(signals.heldFor(p).events, 0);
  assert.equal(signals.record(p, { kind: "thumb", feature: "answers", value: 1 }).recorded, false);
});

test("body and health never become signals", () => {
  const p = player("p2"); signals.consent(p, true);
  assert.equal(signals.record(p, { kind: "thumb", feature: "body", value: -1 }).recorded, false);
  assert.equal(signals.record(p, { kind: "thumb", feature: "report", value: 1 }).recorded, false);
  assert.equal(signals.record(p, { kind: "count", site: "body.read", n: 1 }).recorded, false);
  assert.equal(signals.record(p, { kind: "unmet", source: "fallback", text: "can you plan around my sore knee" }).recorded, false);
  assert.equal(signals.record(p, { kind: "unmet", source: "no-tool", text: "can you track my sleep" }).recorded, false);
});

test("an unmet request's words stay in the player's own record, never in loop data", () => {
  const p = player("p3"); signals.consent(p, true);
  const r = signals.record(p, { kind: "unmet", source: "fallback", text: "can you split the court fee with my friends" });
  assert.ok(r.recorded && r.unmet);
  assert.ok(store.get(p).loop.unmet.some((u) => /split the court fee/.test(u.text)));
  assert.ok(!fs.readFileSync(path.join(process.env.LOOP_DIR, "signals.json"), "utf8").includes("split the court fee"));
  assert.equal(signals.record(p, { kind: "unmet", source: "guard", text: "something flagged" }).unmet, undefined, "a guard's refusal is counted, its words not kept");
});

test("what code checks in a shared sentence", () => {
  assert.deepEqual(signals.checkText("Ask about games later in the day"), []);
  assert.deepEqual(signals.checkText("A way to split the court fee between players"), []);
  assert.deepEqual(signals.checkText("Look further ahead than a few days, like on Wednesday for the weekend"), []);
  const has = (t, what) => assert.ok(signals.checkText(t).includes(what), `${t}: ${signals.checkText(t).join(", ")}`);
  has("Ask Leo about games", "a name or a place");
  has("Find courts near Riverside", "a name or a place");
  has("Find courts near Shilin Night Market", "a name or a place");
  has("Ask at 18:00 instead", "a number");
  has("Book two courts at once", "a number");
  has("See the club at serve-club.com", "a link, an address or a handle");
  has("Send it to @leo", "a link, an address or a handle");
  has("Plan around a sore knee", "a body or health term");
  has("Export all body logs", "a body or health term");
  has("Show my sleep and heart rate", "a body or health term");
  has("x".repeat(121), "longer than 120 characters");
  has("晚一點問我", "not plain English text");
  assert.deepEqual(signals.checkText("A court near the park"), [], "an everyday word that is also a surname is not a name");
});

test("sharing: per item, the player's own offer only, and the guards fail closed", async () => {
  const p = player("p4"), q = player("p5");
  const off = await signals.offerShare(p, { kind: "unmet", text: "x" }, { rewrite: fake("Ask about games later in the day") });
  assert.equal(off.offered, false, "an unmet request needs /improve on");
  const w = await signals.offerShare(p, { kind: "wish", text: "ask me later, I'm at work at noon" }, { rewrite: fake("Ask about games later in the day"), profile: { group: "weekday", band: "B" } });
  assert.ok(w.id && /^Share with the club as “Ask about games later in the day”\?/.test(w.prompt) && w.buttons[0].payload === `sh:${w.id}:yes`);
  assert.equal((await signals.share(q, w.id, true)).shared, false, "another player's button shares nothing");
  // a required guard that is not running blocks the item (GUARD=off: Llama Guard is not checked)
  process.env.LOOP_GUARDS = "llama-guard";
  const r1 = await signals.share(p, w.id, true);
  assert.equal(r1.shared, false); assert.match(r1.why, /not running|did not answer/); assert.equal(r1.held, true, "it waits for the guard, unshared");
  assert.equal(signals.items().length, 0, "nothing of a blocked item is kept");
  process.env.LOOP_GUARDS = "none";
  const w2 = await signals.offerShare(p, { kind: "wish", text: "ask me later" }, { rewrite: fake("Ask about games later in the day"), profile: { group: "weekday", band: "B" } });
  const r2 = await signals.share(p, w2.id, true);
  assert.equal(r2.item.area, "other", "no area from a stand-in paraphrase: other");
  assert.ok(r2.shared && /prompt-guard/.test(r2.item.guard.waived) && /llama-guard/.test(r2.item.guard.waived), "a guard left out is recorded as waived");
  assert.equal(r2.item.who, signals.whoOf(p)); assert.ok(!JSON.stringify(r2.item).includes("p4"));
  const w3 = await signals.offerShare(p, { kind: "wish", text: "no" }, { rewrite: fake("Ask about games later in the day") });
  assert.equal((await signals.share(p, w3.id, false)).shared, false);
  assert.equal(signals.items().length, 1);
  assert.equal((await signals.offerShare(p, { kind: "wish", text: "my knee hurts, plan around it" }, { rewrite: fake("x") })).why, "about the body or health");
});

// a stand-in for DRAMA: each text maps to a unit vector; anything else (the catalog) to its own far direction
const DIM = 128, unit = (v) => { const n = Math.hypot(...v); return v.map((x) => x / n); };
const near = (i, j = null, w = 0.25) => unit(Array.from({ length: DIM }, (_, k) => (k === i ? 1 : k === j ? w : 0)));
const far = (t) => { const h = crypto.createHash("md5").update(t).digest()[0] % 60; return Array.from({ length: DIM }, (_, k) => (k === 64 + h ? 1 : 0)); };
const VEC = new Map();
const embed = async (texts) => texts.map((t) => VEC.get(t) || far(t));
const item = (who, text, kind, group, at, area = "match", aspect = "timing") => ({ id: `I-${crypto.randomUUID().slice(0, 8)}`, who, text, kind, group, band: "B", at, area, aspect, guard: { safe: true, injected: null } });

test("clusters: 5 distinct members to show, both groups to propose; a sock puppet counts once; no chaining; only the same thing", async () => {
  proposals.reset();
  const t = (s, v) => { VEC.set(s, v); return s; };
  const later = ["Ask about games later in the day", "Ask in the evening, not at midday", "A later question about games", "Ask after work about a game", "Ask me in the evening", "Ask once work is over"].map((s, k) => t(s, near(0, 1 + k, 0.2)));
  const its = later.map((s, k) => item(`w${k}`, s, k < 3 ? "unmet" : "wish", k < 4 ? "weekday" : "weekend", 1000 + k));
  // one account sharing the same idea ten times
  const sock = t("Pay for the court in the app", near(10));
  for (let k = 0; k < 10; k++) its.push(item("puppet", sock, "wish", "weekday", 2000 + k));
  // four members only
  const few = t("Pick my partner myself", near(20));
  for (let k = 0; k < 4; k++) its.push(item(`f${k}`, few, "wish", k % 2 ? "weekday" : "weekend", 3000 + k));
  // a chain: each next text is close to the one before, but the last is far from the first
  const a = t("Chain one", unit(Array.from({ length: DIM }, (_, k) => (k === 40 ? 1 : 0)))), b = t("Chain two", unit(Array.from({ length: DIM }, (_, k) => (k === 40 ? 1 : k === 41 ? 0.62 : 0)))), c = t("Chain three", unit(Array.from({ length: DIM }, (_, k) => (k === 41 ? 1 : k === 40 ? 0.3 : 0))));
  its.push(item("c1", a, "wish", "weekday", 4000), item("c2", b, "wish", "weekday", 4001), item("c3", c, "wish", "weekday", 4002));
  // close words about another part of the app (the reminders, not the Match helper): a cluster of its own
  const other = t("Ask about games later in the reminder", near(0, 9, 0.2));
  for (let k = 0; k < 5; k++) its.push(item(`r${k}`, other, "wish", k % 2 ? "weekday" : "weekend", 5000 + k, "reminders", "timing"));
  const cs = await proposals.cluster(its, { embed });
  const of = (txt) => cs.find((x) => x.items.some((id) => its.find((i) => i.id === id).text === txt));
  const L = of(later[0]);
  assert.equal(L.members, 6); assert.equal(L.unmet, 3); assert.equal(L.wishes, 3);
  assert.ok(L.shown && L.eligible); assert.deepEqual(L.groups, ["weekday", "weekend"]);
  assert.equal(L.score, 3 * 2 + 3, "distinct members × (2 for unmet, 1 for a wish)");
  const S = of(sock);
  assert.equal(S.items.length, 10); assert.equal(S.members, 1, "one account many times is one member"); assert.ok(!S.shown);
  assert.ok(!of(few).shown, "four members are not enough");
  assert.notEqual(of(a).id, of(c).id, "a chain of near neighbours does not drag a cluster along");
  assert.notEqual(of(other).id, L.id, "close words about another part of the app are another idea");
  assert.equal(of(other).members, 5);
});

test("clusters: one group alone waits; the catalog answers what Serve already does", async () => {
  proposals.reset();
  const one = "Send a weekly summary of games"; VEC.set(one, near(50));
  const its = Array.from({ length: 6 }, (_, k) => item(`g${k}`, one, "wish", "weekday", 100 + k));
  const says = proposals.catalog().find((f) => f.id === "courts").says, dup = "Find a court for my sport near me";
  VEC.set(says, near(55)); VEC.set(dup, near(55, 56, 0.1));
  its.push(...Array.from({ length: 6 }, (_, k) => item(`h${k}`, dup, "unmet", k % 2 ? "weekday" : "weekend", 200 + k, "courts", "feature")));
  const cs = await proposals.cluster(its, { embed });
  const W = cs.find((c) => c.text === one), D = cs.find((c) => c.text === dup);
  assert.ok(W.shown && !W.eligible && /weekday players only/.test(W.why.join(" ")));
  assert.equal(D.exists?.id, "courts"); assert.ok(!D.eligible);
  assert.ok(proposals.ideas().some((x) => x.status === "exists"));
});

test("grouping: average linkage does not depend on the order requests came in; greedy did", () => {
  // two ideas whose requests sit between each other: x1..x3 about one thing, y1..y3 about another, and a bridge that is
  // close to the first of each
  const v = { x1: near(0), x2: near(0, 1, 0.3), x3: near(0, 2, 0.3), y1: near(5), y2: near(5, 6, 0.3), y3: near(5, 7, 0.3), b: unit(Array.from({ length: DIM }, (_, k) => (k === 0 ? 1 : k === 5 ? 0.9 : 0))) };
  const its = Object.keys(v).map((id, i) => ({ id, who: id, area: "match", aspect: "timing", at: i }));
  const key = (gs) => gs.map((g) => [...g].sort().join(",")).sort().join(" | ");
  const fwd = proposals.group(its, (id) => v[id], { how: "average", link: 0.8 }), rev = proposals.group(its.map((x, i) => ({ ...x, at: -i })), (id) => v[id], { how: "average", link: 0.8 });
  assert.equal(key(fwd), key(rev), "the same groups whatever the order");
  assert.ok(fwd.some((g) => g.includes("x1") && g.includes("x2") && g.includes("x3")) && fwd.some((g) => g.includes("y1") && g.includes("y2") && g.includes("y3")));
  assert.ok(!fwd.some((g) => g.includes("x1") && g.includes("y1")), "the bridge does not join the two ideas");
  const g1 = proposals.group(its, (id) => v[id], { how: "greedy" }), g2 = proposals.group(its.map((x, i) => ({ ...x, at: -i })), (id) => v[id], { how: "greedy" });
  assert.ok(g1.length && g2.length);
  // and the part of the app still separates
  const two = proposals.group([{ id: "a", who: "a", area: "match", at: 1 }, { id: "b", who: "b", area: "reminders", at: 2 }], () => near(3), { how: "average" });
  assert.equal(two.length, 2);
});

test("bridging: an idea a faction pushes alone has its support explained by one side; a broadly wanted one does not", () => {
  // 10 accounts that act alike (two pet ideas, nothing else), and 24 members who each want one or two other things
  const ideas = ["A", "B", "C", "D", "E", "F"], ratings = [], back = new Map(ideas.map((k) => [k, new Set()]));
  const fac = Array.from({ length: 10 }, (_, k) => `f${k}`), rest = Array.from({ length: 24 }, (_, k) => `m${k}`);
  for (const w of fac) { back.get("A").add(w); back.get("B").add(w); }
  rest.forEach((w, k) => back.get(["C", "D", "E", "F"][k % 4]).add(w));
  // C is wanted on both sides: three of the faction want it too
  for (const w of fac.slice(0, 3)) back.get("C").add(w);
  for (const w of [...fac, ...rest]) for (const k of ideas) ratings.push({ who: w, item: k, r: back.get(k).has(w) ? 1 : 0 });
  const bs = proposals.bridgeScores(ratings), f = (k) => Math.abs(bs.item.get(k).f);
  assert.ok(f("A") >= 0.5 && f("B") >= 0.5, `the faction's ideas: |f| ${f("A").toFixed(2)}, ${f("B").toFixed(2)}`);
  for (const k of ["C", "D", "E", "F"]) assert.ok(f(k) < 0.5, `${k}: |f| ${f(k).toFixed(2)}`);
  assert.deepEqual(proposals.bridgeScores(ratings).item.get("A"), bs.item.get("A"), "the same ratings, the same scores");
  // the rule the loop uses: one-sided when the factor explains it and its backers act together elsewhere too
  const br = proposals.bridging(back);
  assert.ok(br.applied && br.byIdea.get("A").oneSided && br.byIdea.get("B").oneSided, "the faction's ideas wait");
  for (const k of ["C", "D", "E", "F"]) assert.equal(br.byIdea.get(k).oneSided, false, `${k} goes on`);
  assert.equal(proposals.bridging(new Map([["A", new Set(["a", "b"])], ["B", new Set(["c"])], ["C", new Set(["d"])]])).applied, false, "too few members to tell sides apart");
  // the faction's votes, matched: ten accounts on one side count about as one voter
  const side = (w) => (w.startsWith("f") ? "-" : null);
  assert.equal(proposals.matchedVotes(new Map(fac.map((w) => [w, 2])), side).toFixed(2), Math.sqrt(40).toFixed(2));
  assert.equal(proposals.matchedVotes(new Map(rest.slice(0, 5).map((w) => [w, 2])), side), 10, "members on no side count alone");
  assert.ok(proposals.bridgedBy(fac, side).bridged === false && proposals.bridgedBy([...rest.slice(0, 4), "f1"], side).bridged === true);
});

test("quadratic votes: 9 credits a month, n votes on one proposal cost n²", () => {
  fs.mkdirSync(path.join(process.env.LOOP_DIR, "proposals"), { recursive: true });
  for (const id of ["P-001", "P-002"]) fs.writeFileSync(path.join(process.env.LOOP_DIR, "proposals", `${id}.json`), JSON.stringify({ id, status: "review", history: [], problem: {}, change: {} }));
  const who = signals.whoOf("voter"), now = Date.UTC(2026, 9, 28);
  assert.equal(proposals.credits(who, { now }), 9);
  assert.ok(proposals.vote(who, "P-001", 3, { now }).ok);
  assert.equal(proposals.credits(who, { now }), 0);
  assert.equal(proposals.vote(who, "P-002", 1, { now }).ok, false);
  assert.ok(proposals.vote(who, "P-001", 2, { now }).ok);
  assert.ok(proposals.vote(who, "P-002", 2, { now }).ok);
  assert.equal(proposals.credits(who, { now }), 1);
  assert.equal(proposals.vote(who, "P-002", 4, { now }).ok, false, "at most 3");
  assert.equal(proposals.votesFor("P-001"), 2);
  assert.equal(proposals.credits(who, { now: Date.UTC(2026, 10, 2) }), 9, "a new month, new credits");
  assert.equal(proposals.vote(who, "P-999", 1, { now }).ok, false);
});

test("/forget: signals, pending offers, shared items and votes are gone", async () => {
  const p = player("p9"); signals.consent(p, true);
  signals.record(p, { kind: "thumb", feature: "answers", value: -1 });
  const w = await signals.offerShare(p, { kind: "wish", text: "a" }, { rewrite: fake("A way to split the court fee") });
  await signals.share(p, w.id, true);
  await signals.offerShare(p, { kind: "wish", text: "b" }, { rewrite: fake("Ask about games later in the day"), now: Date.now() + 2 * 864e5 });
  assert.ok(proposals.vote(signals.whoOf(p), "P-001", 1).ok);
  const before = signals.heldFor(p);
  assert.ok(before.consent && before.events && before.items && before.pending);
  const r = await signals.forget(p);
  assert.equal(r.items, 1); assert.equal(r.votes, 1);
  assert.deepEqual(signals.heldFor(p), { consent: false, events: 0, pending: 0, items: 0 });
  assert.equal(proposals.myVotes(signals.whoOf(p), "P-001"), 0);
});

test("the Rule of Two holds at every stage of a spec, for a config change and for code", () => {
  for (const cls of ["C0", "C1", "C2", "C3"]) {
    const rows = proposals.ruleOfTwo(cls);
    assert.ok(rows.every((r) => !(r.untrusted && r.private && r.power)), cls);
    assert.ok(rows.some((r) => r.stage === (cls === "C0" ? "ship" : "decide")), "a C0 change ships by code; anything else needs a person");
    if (cls !== "C0") assert.equal(rows.find((r) => r.stage === "build").untrusted, false, "the builder never reads community text");
  }
});

test("the stand-ins fail closed until their modules are here", async () => {
  assert.equal(stub.review.check({}).allowed, false);
  assert.equal((await stub.gates.runGates({})).pass, false);
  assert.throws(() => stub.flags.ship({}));
  assert.equal(stub.flags.get("ask.hour", "x"), undefined);
  process.env.LOOP_GUARDS = "llama-guard,prompt-guard";
  const [s] = await stub.review.screen([{ id: "I-x", text: "Ask about games later in the day" }]);
  assert.ok(s.guard.blocked, "GUARD=off: the required guards are not running, so the item is blocked");
  process.env.LOOP_GUARDS = "none";
});

// Unit tests for what the app now shows (docs/web_features.md), with no model and no GPU:
//   node --test test/webfeat_unit.mjs
//   - private calendars per player: the server's default, the player's choice, a talk's own mode, and a talk that
//     proposes from your own week when they are private (a2a.js with privacy.js)
//   - the safety checks the app shows: verdict and action, never the text, inside a trace as a span
//   - who the Autopilot left out and the note that asked for it; the camera effect's plain reasons
//   - the builder's runs for the maintainer (loop/builds.js), with stub builders and gates
//   - the gateway's new routes (a real gateway on a free port): tokens, prefs, server memory, safety, holds, builds,
//     the app's questions past the guards, and a talk over A2A that says its mode and that the cards checked out
//   - the app's voice input (POST /api/asr): token, type, size and language checks, and a recording through ffmpeg
//     to a stand-in speech worker, with its row in the ledger and no words in it
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "serve-webfeat-"));
Object.assign(process.env, { BOOKINGS_FILE: `${tmp}/bookings.json`, A2A_FILE: `${tmp}/a2a.json`, A2A_DATA: `${tmp}/a2a`, NEGOTIATIONS_FILE: `${tmp}/neg.json`, LEDGER_FILE: `${tmp}/ledger.jsonl`,
  TRACE_FILE: `${tmp}/traces.jsonl`, PREFS_FILE: `${tmp}/prefs.json`, STORE_FILE: `${tmp}/players.json`, MEMORY_FILE: `${tmp}/memory.json`, LOOP_DIR: `${tmp}/loop`, LOOP_WATCH: "off",
  LLM_URL: "http://127.0.0.1:9/v1", GUARD_URL: "http://127.0.0.1:9", MEMORY_EMBED: "bm25", A2A_TRANSPORT: "local" });
delete process.env.A2A_PRIVATE; delete process.env.A2A_BASE;
const privacy = await import("../src/privacy.js");
const store = await import("../src/store.js");
const { negotiate, negotiation } = await import("../src/a2a.js");
const { readClub } = await import("../src/club.js");
const play = await import("../src/play.js");
const guard = await import("../src/guard.js");
const safety = await import("../src/safety.js");
const tracing = await import("../src/trace.js");
const { leftOutWhy } = await import("../src/autopilot_why.js");
const reel = await import("../src/reel.js");
const proposals = await import("../src/loop/proposals.js");
const builds = await import("../src/loop/builds.js");
const review = await import("../src/loop/review.js");

// ---- private calendars, per player ----------------------------------------------------------------------------------
test("private calendars: the server's default, the player's own choice wins, an explicit mode wins over both", async () => {
  assert.equal(await privacy.privateFor("app"), false, "no choice, no A2A_PRIVATE: shared");
  process.env.A2A_PRIVATE = "1";
  assert.equal(await privacy.privateFor("app"), true, "the server's default");
  await privacy.set("app", false);
  assert.equal(await privacy.privateFor("app"), false, "the player's choice wins");
  assert.equal(await privacy.privateFor("app", true), true, "a talk's own mode wins");
  assert.deepEqual(await privacy.describe("app"), { privateCalendars: false, choice: false, serverDefault: true });
  await privacy.set("app", null);
  assert.equal(await privacy.privateFor("app"), true, "cleared: the default again");
  delete process.env.A2A_PRIVATE;
  // a Messenger player's choice is in their store prefs (so /forget deletes it); a chat not linked can't have one
  store.link("psid-1", "Ana");
  assert.equal(await privacy.set("psid-1", true), true);
  assert.equal(store.get("psid-1").prefs.privateCalendars, true);
  assert.equal(await privacy.privateFor("psid-1"), true);
  assert.equal(await privacy.privateFor("app"), false, "one player's choice is not another's");
  assert.equal(await privacy.set("nobody", true), false);
  await assert.rejects(privacy.set("app", "yes"));
  store.forget("psid-1");
  assert.equal(await privacy.privateFor("psid-1"), false, "gone with /forget");
});

// a Monday morning, so the week ahead is known: you are free most evenings and weekend mornings, Sam only on Saturday
// 09-11 (so each of his agent's answers is decided by his calendar, with no model)
const monday = () => new Date(2026, 10, 2, 8, 0, 0);
function talkers() {
  const club = readClub(), sam = club.members.find((m) => m.id === "sam");
  return { me: { id: "you", name: "You", area: club.you.area, free: club.you.free }, sam: { ...sam, free: ["Sat 09-11"], rules: {}, rulesComplete: true }, venues: play.helpers.readVenues() };
}
test("a talk runs in the player's mode: private proposes from your own week and says so; shared lists only common times", async () => {
  play.clearLeases();
  const { me, sam, venues } = talkers();
  const run = async (who) => { const steps = []; const r = await negotiate({ me, members: [sam], venues, now: monday(), who, tell: (s) => steps.push(s) }); return { r, steps }; };
  await privacy.set("app", true);
  const p = await run("app");
  assert.equal(p.r.calendars, "private");
  assert.ok(p.steps.some((s) => s.calendars === "private" && /private/i.test(s.step)), "the trail says the calendars were kept private");
  assert.match(p.r.log[0].when, /^(Mon|Tue|Thu)\b/, "private: the first time comes from your own week (Sam is not free then)");
  assert.ok(p.r.agreed, p.r.reason);
  assert.match(p.r.agreed.day, /^(Sat|Sun)$/, "Sam's own agent ruled the weekday times out");
  assert.equal(p.r.agreed.calendars, "private");
  assert.equal(negotiation(p.r.agreed.talk).calendars, "private", "the mode is saved with the talk, so a resumed talk keeps it");
  // the hold: Sam's agent holds the agreed time for 30 minutes, and the result says until when
  assert.ok(p.r.agreed.holdUntil > Date.now() + 25 * 60000 && p.r.agreed.holdUntil <= Date.now() + 30 * 60000 + 1000, "held for about 30 minutes");
  assert.equal(play.held("sam").find((l) => l.ref === p.r.agreed.hold)?.until, p.r.agreed.holdUntil);
  assert.equal(p.r.cards, undefined, "a talk in this process reaches no Agent Card");
  play.clearLeases();
  await privacy.set("app", false);
  const s = await run("app");
  assert.equal(s.r.calendars, "shared");
  assert.ok(!s.steps.some((x) => x.calendars === "private"));
  assert.match(s.r.log[0].when, /^(Sat|Sun)\b/, "shared: only times that fit both calendars are listed");
  // the player's choice is per player: someone else's talk keeps the server's default
  play.clearLeases();
  process.env.A2A_PRIVATE = "1";
  assert.equal((await run("psid-other")).r.calendars, "private");
  assert.equal((await run("app")).r.calendars, "shared", "the app's player chose shared");
  delete process.env.A2A_PRIVATE;
  await privacy.set("app", null);
  play.clearLeases();
});

// ---- the safety checks the app shows ----------------------------------------------------------------------------------
async function fakeGuard(answer) {
  const srv = http.createServer((q, s) => { q.resume(); q.on("end", () => { s.writeHead(200, { "content-type": "application/json" }); s.end(JSON.stringify({ response: answer() })); }); });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  return srv;
}
test("every check is noted with its verdict and what happened, for its own player, and never with the text", async () => {
  let say = "unsafe\nS11";
  const srv = await fakeGuard(() => say);
  process.env.GUARD_URL = `http://127.0.0.1:${srv.address().port}`;
  try {
    const words = "nobody would miss me if i was gone", words2 = "we will smash them flat";
    const a = await safety.collect("chat-a", async () => guard.stopsIn(await guard.screen([{ role: "user", content: words }]), words));
    assert.deepEqual(a.result, ["S11"]);
    assert.equal(a.checks.length, 1);
    assert.equal(a.checks[0].on, "message"); assert.equal(a.checks[0].verdict, "flagged"); assert.equal(a.checks[0].action, "helpline");
    assert.deepEqual(a.checks[0].about, ["suicide and self-harm"]);
    say = "safe";
    const b = await safety.collect("chat-b", async () => guard.stopsIn(await guard.screen([{ role: "user", content: words2 }]), words2));
    assert.equal(b.result, null); assert.equal(b.checks[0].action, "passed"); assert.equal(b.checks[0].verdict, "safe");
    // a model's answer that Llama Guard flags is replaced
    say = "unsafe\nS1";
    const c = await safety.collect("chat-b", () => guard.checkOut("a model's answer", { fallback: "the safe reply" }));
    assert.equal(c.result.text, "the safe reply"); assert.equal(c.checks[0].on, "answer"); assert.equal(c.checks[0].action, "replaced");
    // whose they are: each chat sees its own
    assert.equal(safety.list({ player: "chat-a" }).length, 1);
    assert.equal(safety.list({ player: "chat-b" }).length, 2);
    assert.equal(safety.list({ player: "chat-a", since: Date.now() + 1000 }).length, 0, "a chat linked again after /forget starts with none");
    for (const x of [...safety.list({ player: "chat-a" }), ...safety.list({ player: "chat-b" })]) {
      const j = JSON.stringify(x);
      assert.ok(!j.includes("miss me") && !j.includes("smash them") && !j.includes("model's answer") && !j.includes("safe reply"), "no text in a check");
      assert.equal(x.player, undefined, "no player in what is shown");
    }
    // the guard down: not checked, and the self-harm words are still caught by code (the helpline)
    srv.close(); process.env.GUARD_URL = "http://127.0.0.1:9";
    await new Promise((ok) => setTimeout(ok, 50));
    const d = await safety.collect("chat-c", async () => guard.stopsIn(await guard.screen([{ role: "user", content: "I want to kill myself" }]), "I want to kill myself"));
    assert.deepEqual(d.result, ["S11"]); assert.equal(d.checks[0].verdict, "not checked"); assert.equal(d.checks[0].action, "helpline"); assert.equal(d.checks[0].byWords, true);
    // inside an agent's trace, a check is a span with its verdict and no text (the guard may still be paused from the
    // failure above: then the span says "not checked")
    const srv2 = await fakeGuard(() => "safe");
    process.env.GUARD_URL = `http://127.0.0.1:${srv2.address().port}`;
    let tid;
    await tracing.span("invoke_agent test", {}, async () => { tid = tracing.traceId(); await guard.checkOut("a sentence for the player", { fallback: null }); });
    const g = tracing.spans({ trace: tid }).find((s) => s.name.startsWith("guard "));
    srv2.close(); process.env.GUARD_URL = "http://127.0.0.1:9";
    assert.ok(g, "a guard span in the trace");
    assert.equal(g.attributes["serve.guard.on"], "answer");
    assert.ok(["safe", "not checked"].includes(g.attributes["serve.guard.verdict"]));
    assert.ok(!JSON.stringify(g).includes("sentence for the player"), "no text in the span");
  } finally { srv.close(); process.env.GUARD_URL = "http://127.0.0.1:9"; }
});

// ---- the Autopilot's reasons and the camera effect's ------------------------------------------------------------------
test("who the plan left out, with the note that asked for it, found by first name with or without accents", () => {
  const club = { members: [{ id: "tomas", name: "Tomás Silva" }, { id: "leo", name: "Leo Park" }, { id: "kenji", name: "Kenji Mori" }] };
  const r = leftOutWhy({ leftOut: new Set(["tomas", "leo", "kenji"]), club,
    fromMemory: [{ note: "Leave Tomas out for a while, we argued", on: "2026-10-12" }],
    trail: [{ name: "recall", res: { notes: [{ note: "no games with leo this month", said: "2026-10-20" }] } }, { name: "find_partners", res: {} }] });
  assert.deepEqual(r[0], { id: "tomas", name: "Tomás Silva", because: "Leave Tomas out for a while, we argued", said: "2026-10-12" });
  assert.equal(r[1].because, "no games with leo this month"); assert.equal(r[1].said, "2026-10-20");
  assert.equal(r[2].because, undefined, "no note names Kenji: left out as asked, with nothing to quote");
  assert.deepEqual(leftOutWhy({ leftOut: [], club }), []);
  // the model followed the note without leaveOut: a candidate the note keeps away, never asked, is left out too; a
  // note that only names someone (or one who was asked) is not a reason
  const trail = [{ name: "find_partners", res: { candidates: [{ id: "tomas" }, { id: "leo" }, { id: "kenji" }] } }, { name: "negotiate", args: { members: ["kenji"] } }];
  const s = leftOutWhy({ leftOut: new Set(), club, trail, fromMemory: [{ note: "Leave Tomás out for a while", on: "2026-10-28" }, { note: "Leo plays a fast game", on: "2026-10-20" }, { note: "skip Kenji", on: "2026-10-21" }] });
  assert.deepEqual(s.map((x) => x.id), ["tomas"]);
  assert.equal(s[0].because, "Leave Tomás out for a while");
});
test("the camera effect: what was chosen and why, in the player's words", () => {
  const orbit = reel.summarize({ plan: { mode: "orbit", sweep_deg: [-4, 10], zoom: 1.56, why_not_orbit: [], cut: { in: 5.1, freeze: 6.52, out: 7.3 }, exists: { verdict: "play", why: "" } }, time_s: { total: 41.2 } }, { video: "data:video/mp4;base64,AAAA" });
  assert.equal(orbit.mode, "orbit"); assert.match(orbit.chose, /14° round you/); assert.equal(orbit.video, "data:video/mp4;base64,AAAA"); assert.deepEqual(orbit.sweep, [-4, 10]);
  const zoom = reel.summarize({ plan: { mode: "zoom", why_not_orbit: ["the player is cut off by the frame's edge", "the cut-out is unsure (SAM 2.1 rates it 0.71)"], exists: { verdict: "cut", why: "the player leaves the frame or is hidden in part of the window" } } });
  assert.equal(zoom.mode, "zoom"); assert.match(zoom.chose, /^Zoom and cut/);
  assert.deepEqual(zoom.why, ["you are at the edge of the picture, so there is no room to turn the camera", "the outline around you is not clean enough to lift you off the court", "you leave the picture for part of it, so the effect is cut to where you are"]);
  const hold = reel.summarize({ plan: { mode: "none", exists: { verdict: "hold", why: "the racket hand or the body is hidden or out of frame at the moment" } } });
  assert.equal(hold.mode, "none"); assert.match(hold.why[0], /racket hand or body is hidden/); assert.equal(hold.video, undefined);
  for (const s of [orbit, zoom, hold]) assert.ok(!/SAM 2\.1|MapAnything|Sapiens/.test(JSON.stringify(s.why)), "no model names in the reasons");
  assert.equal(reel.effectsReady(), false, "not set up without REEL_EFFECTS_SCRIPT");
});

// ---- the builder's runs for the maintainer ----------------------------------------------------------------------------
const PDIR = path.join(process.env.LOOP_DIR, "proposals");
function proposal(id, over = {}) {
  fs.mkdirSync(PDIR, { recursive: true });
  const spec = { id, title: "A quiet week", cluster: "C-1", problem: { text: "x", members: 6, unmet: 4, wishes: 2, votes: 3 }, change: { class: "C1", files: ["agent/src/ask.js"], summary: "Add /quiet." },
    oracle: { kind: "unit", how: "a test" }, privacy: "none", ruleOfTwo: [], status: "approved", reasons: [], history: [{ at: 1, status: "approved", by: "maintainer" }], ...over };
  fs.writeFileSync(path.join(PDIR, `${id}.json`), JSON.stringify(spec));
  return spec;
}
const attempt = (n, ok, end) => ({ n, ok, end, steps: 9, toolCalls: 14, changed: ok ? ["agent/src/ask.js"] : [], unit: { ok, pass: ok ? 22 : 21, fail: ok ? 0 : 1 }, refused: [{ tool: "write_patch", path: "agent/test/unit.mjs", kind: "test", reason: "tests are read-only" }], tokens: { prompt: 9000, output: 800 }, seconds: 40, diff: "secret per-attempt diff" });
test("a build: its attempts, branch, diff and gates are kept, and the proposal moves to gated", async () => {
  proposal("P-101");
  const build = async (spec, { onStep }) => {
    assert.equal(spec.status, "approved", "the builder is handed the spec as approved");
    onStep({ type: "attempt", n: 1 }); onStep({ type: "attempt-end", ...attempt(1, false, "steps") });
    onStep({ type: "attempt", n: 2 }); onStep({ type: "attempt-end", ...attempt(2, true, "done") });
    return { ok: true, branch: "loop/P-101", base: "abc123", commit: "def456", diff: "diff --git a/agent/src/ask.js b/agent/src/ask.js\n+// quiet\n", stat: "1 file changed, 1 insertion(+)", attempts: [attempt(1, false, "steps"), attempt(2, true, "done")], summary: "Added /quiet", tokens: { prompt: 18000, output: 1600, calls: 20 }, seconds: 80, reasons: [] };
  };
  const seen = [];
  const runGates = async (spec, { branch, only }) => { seen.push({ branch, only }); return { pass: false, subsetOk: true, results: only.map((g) => ({ gate: g, ok: true, details: { took: 1 } })) }; };
  const started = builds.start("P-101", { build: async (...a) => { assert.equal(proposals.get("P-101").status, "building", "building while it runs"); return build(...a); }, runGates, wait: true });
  const b = await started;
  assert.equal(b.status, "built"); assert.equal(b.branch, "loop/P-101"); assert.match(b.diff, /quiet/);
  assert.equal(b.attempts.length, 2); assert.equal(b.attempts[0].why, "ran out of steps"); assert.equal(b.attempts[1].ok, true);
  assert.equal(b.attempts[0].diff, undefined, "an attempt's own diff is not kept");
  assert.deepEqual(b.attempts[0].refused[0], { tool: "write_patch", path: "agent/test/unit.mjs", kind: "test", reason: "tests are read-only" });
  assert.deepEqual(seen, [{ branch: "loop/P-101", only: builds.NO_GPU }], "the gates run on the branch, without the GPU suites by default");
  assert.deepEqual(b.gatesNotRun, ["crash_matrix", "redteam", "e2e", "autopilot_eval"]);
  assert.equal(b.gates.subsetOk, true); assert.equal(b.gates.pass, false, "not every gate ran");
  const sp = proposals.get("P-101");
  assert.equal(sp.status, "gated"); assert.equal(sp.branch, "loop/P-101"); assert.match(sp.reasons[0], /maintainer's to run/);
  assert.equal(sp.gates.subsetOk, true, "the page can say it passed on the branch"); assert.deepEqual(sp.gates.subset, builds.NO_GPU);
  assert.equal(builds.get("P-101").status, "built");
  assert.equal(builds.start("P-101").code, 409, "a gated proposal is not built again");
});
test("a build that stops, or a gate that fails, says why and leaves the proposal approved; only approved C1-C3 is built", async () => {
  proposal("P-102");
  const b = await builds.start("P-102", { build: async () => ({ ok: false, infra: true, attempts: [attempt(1, false, "model-error")], reasons: ["the model server did not answer (ECONNREFUSED); the build stopped after attempt 1"] }), wait: true });
  assert.equal(b.status, "failed"); assert.match(b.reasons[0], /model server did not answer/); assert.equal(b.infra, true);
  assert.equal(proposals.get("P-102").status, "approved"); assert.match(proposals.get("P-102").reasons[0], /did not answer/);
  // back to approved is not a decision: the maintainer's approval is still the last on record, so the review lets it
  // be built again
  assert.equal(review.approvedByMaintainer(proposals.get("P-102")), true);
  // built again: the stopped build's branch and worktree are replaced, and a branch left over is not a refusal
  let asked = null;
  const again = await builds.start("P-102", { build: async (s, o) => { asked = o.replace; return { ok: false, refused: true, attempts: [], reasons: ["loop/P-102 or /x/P-102 already exists: a maintainer removes it first"] }; }, wait: true });
  assert.equal(asked, true); assert.equal(again.status, "failed"); assert.equal(proposals.get("P-102").status, "approved");
  proposal("P-103");
  const c = await builds.start("P-103", { build: async () => ({ ok: true, branch: "loop/P-103", diff: "+x", attempts: [attempt(1, true, "done")] }),
    runGates: async (s, { only }) => ({ pass: false, results: only.map((g) => ({ gate: g, ok: g !== "unit", details: g === "unit" ? { fail: 2 } : {} })) }), wait: true });
  assert.equal(c.status, "built"); assert.deepEqual(c.reasons, ["unit failed"]); assert.equal(proposals.get("P-103").status, "approved");
  // the builder refuses the spec itself (a file on the never-list): refused by the rules, not offered to build again
  proposal("P-107");
  const n = await builds.start("P-107", { build: async () => ({ ok: false, refused: true, attempts: [], reasons: ["change.files: agent/src/ask.js is on the never-list (agent/src/ask.js): the builder may not change it"] }), wait: true });
  assert.equal(n.status, "refused"); assert.equal(proposals.get("P-107").status, "refused"); assert.equal(proposals.get("P-107").history.at(-1).by, "rules");
  assert.equal(builds.start("P-107").code, 409);
  proposal("P-104", { status: "open" }); assert.equal(builds.start("P-104").code, 409);
  proposal("P-105", { change: { class: "C0", key: "ask.hour", value: 18, files: [] } }); assert.match(builds.start("P-105").error, /C0/);
  assert.equal(builds.start("P-999").code, 404);
  // a build cut off by a restart says so, and its proposal can be built again
  proposal("P-106", { status: "building" });
  const f = path.join(process.env.LOOP_DIR, "builds.json"), d = JSON.parse(fs.readFileSync(f, "utf8"));
  d["P-106"] = { proposal: "P-106", status: "building", attempts: [], reasons: [] }; fs.writeFileSync(f, JSON.stringify(d));
  const fresh = await import(`../src/loop/builds.js?again=${Date.now()}`);
  assert.equal(fresh.get("P-106").status, "stopped"); assert.match(fresh.get("P-106").reasons.at(-1), /gateway stopped/);
  assert.equal(proposals.get("P-106").status, "approved");
});

// ---- the gateway's routes, on a real gateway -------------------------------------------------------------------------
const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
let gw = null;
after(() => { try { gw?.kill(); } catch { /* gone */ } });
test("the gateway's new routes: tokens, prefs, server memory, the app's chat past the guards, safety, holds, builds", { timeout: 240000 }, async () => {
  const port = await freePort(), dir = path.join(tmp, "gw"); fs.mkdirSync(dir, { recursive: true });
  const T = "gw-token-" + Math.random().toString(36).slice(2), M = "maint-" + Math.random().toString(36).slice(2), ORIGIN = "http://127.0.0.1:5191";
  // a linked Messenger player with notes of their own, and an approved C1 proposal
  fs.writeFileSync(`${dir}/players.json`, JSON.stringify({ players: { "psid-9": { id: "psid-9", name: "Mia", athlete: "A", linkedAt: Date.now() - 1000, memories: [], history: [], plan: null, pantry: [], events: [], logs: [], prefs: {} } } }));
  fs.writeFileSync(`${dir}/memory.json`, JSON.stringify({ players: { "psid-9": [{ id: "n1", text: "Mornings only on Sundays", kind: "said", at: 1 }] } }));
  fs.mkdirSync(`${dir}/loop/proposals`, { recursive: true });
  fs.writeFileSync(`${dir}/loop/proposals/P-001.json`, JSON.stringify({ id: "P-001", title: "x", status: "open", change: { class: "C1", files: ["agent/src/ask.js"], summary: "x" }, problem: {}, history: [], reasons: [] }));
  const env = { ...process.env, PORT: String(port), AGENT_TOKEN: T, MAINTAINER_TOKEN: M, ALLOW_ORIGINS: ORIGIN, STORE_FILE: `${dir}/players.json`, MEMORY_FILE: `${dir}/memory.json`, PREFS_FILE: `${dir}/prefs.json`,
    BOOKINGS_FILE: `${dir}/bookings.json`, AUTOPILOT_FILE: `${dir}/autopilot.json`, A2A_FILE: `${dir}/a2a.json`, ASK_FILE: `${dir}/asks.json`, MESSENGER_SEEN_FILE: `${dir}/seen.json`, NEGOTIATIONS_FILE: `${dir}/neg.json`,
    A2A_DATA: `${dir}/a2a`, LEDGER_FILE: `${dir}/ledger.jsonl`, TRACE_FILE: `${dir}/traces.jsonl`, FEEDBACK_FILE: `${dir}/feedback.json`, PLAYBOOK_FILE: `${dir}/playbooks.json`, KB_FILE: `${dir}/kb.json`, LOOP_DIR: `${dir}/loop`,
    LLM_URL: "http://127.0.0.1:9/v1", GUARD_URL: "http://127.0.0.1:9", PROMPT_GUARD: "off", MEMORY_EMBED: "bm25", LOOP_WATCH: "off", A2A_TRANSPORT: "", A2A_BASE: "", A2A_SELF: "",
    ASR_PYTHON: path.join(dir, "no-python") };
  delete env.A2A_PRIVATE; delete env.REEL_EFFECTS_SCRIPT;
  gw = spawn(process.execPath, ["src/server.js"], { cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), ".."), env, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; gw.stdout.on("data", (d) => { out += d; }); gw.stderr.on("data", (d) => { out += d; });
  const B = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100 && !/agent gateway on/.test(out); i++) await new Promise((ok) => setTimeout(ok, 100));
  assert.match(out, /agent gateway on/, out.slice(-500));
  const call = (p, { body, token = T } = {}) => fetch(B + p, body !== undefined ? { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) } : { headers: token ? { authorization: `Bearer ${token}` } : {} })
    .then(async (r) => ({ status: r.status, j: await r.json() }));

  // the gateway's token on every new route; the maintainer's on the builder's
  for (const p of ["/api/prefs", "/api/memory/notes", "/api/safety", "/api/holds?ref=neg-x"]) assert.equal((await call(p, { token: null })).status, 401, p);
  assert.equal((await call("/api/asr", { body: {}, token: null })).status, 401, "the voice input needs the token too");
  // a server without the speech model says so, and the app falls back to typing
  { const v = await fetch(`${B}/api/asr`, { method: "POST", headers: { "content-type": "audio/webm", authorization: `Bearer ${T}` }, body: Buffer.alloc(1000) });
    assert.equal(v.status, 503); assert.match((await v.json()).error, /not set up/);
    assert.deepEqual((await call("/api/asr/warm", { body: {} })).j, { warming: false }); }
  assert.equal((await call("/api/loop/builds")).status, 401, "the gateway's token is not the maintainer's");
  assert.equal((await call("/api/loop/build", { body: { proposal: "P-001" } })).status, 401);
  assert.equal((await call("/api/loop/builds", { token: M })).status, 200);
  assert.equal((await call("/api/loop/build", { body: { proposal: "P-001" }, token: M })).status, 409, "an open proposal is not built");
  assert.equal((await call("/api/loop/build", { body: { proposal: "P-404" }, token: M })).status, 404);
  // (the status needs the sample match, which is not in the repository: checked only where it is there)
  { const st = await call("/api/status", { token: null }); if (st.status === 200) assert.equal(st.j.reelEffects, false); }

  // prefs: the player's choice over the server's default
  assert.deepEqual((await call("/api/prefs")).j, { privateCalendars: false, choice: null, serverDefault: false });
  assert.deepEqual((await call("/api/prefs", { body: { privateCalendars: true } })).j, { privateCalendars: true, choice: true, serverDefault: false });
  assert.equal((await call("/api/prefs", { body: { privateCalendars: "yes" } })).status, 400);
  assert.equal((await call("/api/prefs", { body: { privateCalendars: null } })).j.choice, null);

  // server memory: the app's own notes, one gone, all gone; a Messenger chat's notes are its own; no vectors
  let r = await call("/api/memory/notes", { body: { text: "Leave Tomás out for a while" } });
  assert.equal(r.j.kept, true); assert.equal(r.j.notes.length, 1); assert.equal(r.j.notes[0].text, "Leave Tomás out for a while"); assert.equal(r.j.notes[0].v, undefined);
  assert.equal(r.j.safety[0].on, "message", "the note went past the guard first");
  await call("/api/memory/notes", { body: { text: "No games on Fridays" } });
  r = await call("/api/memory/notes"); assert.deepEqual(r.j.notes.map((n) => n.text), ["No games on Fridays", "Leave Tomás out for a while"], "newest first");
  r = await call("/api/memory/delete", { body: { id: r.j.notes[1].id } }); assert.deepEqual(r.j.notes.map((n) => n.text), ["No games on Fridays"]);
  assert.equal((await call("/api/memory/delete", { body: { id: "nope" } })).status, 404);
  assert.deepEqual((await call("/api/memory/notes?player=psid-9")).j.notes.map((n) => n.text), ["Mornings only on Sundays"]);
  r = await call("/api/memory/forget", { body: {} }); assert.equal(r.j.notes.length, 0);
  assert.equal((await call("/api/memory/notes?player=psid-9")).j.notes.length, 1, "forgetting the app's notes leaves the chat's");
  assert.equal((await call("/api/memory/notes?player=stranger")).status, 404);
  // what the guard stops is not kept: the helpline, and nothing remembered
  r = await call("/api/memory/notes", { body: { text: "I want to kill myself" } });
  assert.equal(r.j.kept, false); assert.match(r.j.reply, /helpline/); assert.equal(r.j.notes.length, 0);

  // a question to the agent from the app: past the guards like a Messenger message; the checks come back with the
  // answer, without the text
  r = await call("/api/agent/answer", { body: { text: "nobody would miss me if I was gone", you: {} } });
  assert.equal(r.j.helpline, true); assert.match(r.j.text, /helpline/);
  assert.equal(r.j.safety.length, 1); assert.equal(r.j.safety[0].action, "helpline");
  const s = await call("/api/safety?player=app");
  assert.ok(s.j.checks.some((c) => c.on === "message" && c.action === "helpline"));
  assert.ok(!JSON.stringify(s.j).includes("miss me") && !JSON.stringify(s.j).includes("kill myself"), "never the text");
  assert.equal((await call("/api/safety?player=psid-9")).j.checks.length, 0, "the app's checks are not the chat's");

  // holds: what members' agents hold for a talk
  assert.equal((await call("/api/holds?ref=bad%20ref")).status, 400);
  assert.deepEqual((await call("/api/holds?ref=neg-none&members=sam,leo")).j.holds, []);

  // a talk over A2A from the app: its mode, and the member's signed Agent Card checked against its own address's key
  await call("/api/prefs", { body: { privateCalendars: true } });
  const res = await fetch(`${B}/api/match/talk`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, authorization: `Bearer ${T}` }, body: JSON.stringify({ with: "sam", format: "singles", stream: true }) });
  const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l)), done = lines.find((l) => l.type === "done");
  assert.ok(done, JSON.stringify(lines.at(-1)));
  assert.equal(done.result.calendars, "private");
  assert.ok(lines.some((l) => l.type === "step" && l.calendars === "private"));
  assert.deepEqual(done.result.cards.map((c) => [c.member, c.verified, c.alg]), [["sam", true, "EdDSA"]]);
  if (done.result.agreed) {
    assert.equal(done.result.agreed.calendars, "private"); assert.ok(done.result.agreed.holdUntil > Date.now());
    const h = await call(`/api/holds?ref=${done.result.agreed.hold}&members=sam`); assert.equal(h.j.holds[0].until, done.result.agreed.holdUntil);
  }
});

// ---- the app's voice input ------------------------------------------------------------------------------------------
// a 440 Hz tone as 16 kHz mono WAV: what a browser recording becomes once ffmpeg has read it
function tone(seconds = 1, rate = 16000) {
  const n = Math.round(seconds * rate), b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / rate)), 44 + i * 2);
  return b;
}
const hasFfmpeg = await new Promise((ok) => { const p = spawn("ffmpeg", ["-version"], { stdio: "ignore" }); p.on("error", () => ok(false)); p.on("exit", (c) => ok(c === 0)); });
let gwVoice = null;
after(() => { try { gwVoice?.kill(); } catch { /* gone */ } });

test("the app's voice input: the token, audio only, a size cap, a language code; the words back and a ledger row without them",
  { timeout: 60000, skip: process.platform === "win32" ? "the stand-in speech worker is a shell script" : !hasFfmpeg && "no ffmpeg here" }, async () => {
  const port = await freePort(), dir = path.join(tmp, "voice"); fs.mkdirSync(dir, { recursive: true });
  const T = "voice-" + Math.random().toString(36).slice(2), ORIGIN = "http://127.0.0.1:5191";
  // a stand-in for the Omnilingual ASR worker (agent/asr/worker.py): the same JSON lines on stdin and stdout
  fs.writeFileSync(`${dir}/worker.mjs`, `import fs from "node:fs"; import readline from "node:readline";
console.log(JSON.stringify({ ready: true, model: "stand-in" }));
readline.createInterface({ input: process.stdin }).on("line", (l) => { const q = JSON.parse(l); console.log(JSON.stringify({ id: q.id, text: "book doubles on thursday " + q.lang + " " + fs.statSync(q.path).size, seconds: 0.05 })); });
`);
  fs.writeFileSync(`${dir}/python`, `#!/bin/sh\nexec "${process.execPath}" "${dir}/worker.mjs"\n`, { mode: 0o755 });
  const env = { ...process.env, PORT: String(port), AGENT_TOKEN: T, ALLOW_ORIGINS: ORIGIN, ASR_PYTHON: `${dir}/python`, STORE_FILE: `${dir}/players.json`, MEMORY_FILE: `${dir}/memory.json`, PREFS_FILE: `${dir}/prefs.json`,
    BOOKINGS_FILE: `${dir}/bookings.json`, AUTOPILOT_FILE: `${dir}/autopilot.json`, A2A_FILE: `${dir}/a2a.json`, ASK_FILE: `${dir}/asks.json`, MESSENGER_SEEN_FILE: `${dir}/seen.json`, NEGOTIATIONS_FILE: `${dir}/neg.json`,
    A2A_DATA: `${dir}/a2a`, LEDGER_FILE: `${dir}/ledger.jsonl`, TRACE_FILE: `${dir}/traces.jsonl`, FEEDBACK_FILE: `${dir}/feedback.json`, PLAYBOOK_FILE: `${dir}/playbooks.json`, KB_FILE: `${dir}/kb.json`, LOOP_DIR: `${dir}/loop`,
    LLM_URL: "http://127.0.0.1:9/v1", GUARD_URL: "http://127.0.0.1:9", PROMPT_GUARD: "off", MEMORY_EMBED: "bm25", LOOP_WATCH: "off", A2A_TRANSPORT: "", A2A_BASE: "", A2A_SELF: "" };
  delete env.ASR_LANG; delete env.ASR_MODEL;
  gwVoice = spawn(process.execPath, ["src/server.js"], { cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), ".."), env, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; gwVoice.stdout.on("data", (d) => { out += d; }); gwVoice.stderr.on("data", (d) => { out += d; });
  for (let i = 0; i < 100 && !/agent gateway on/.test(out); i++) await new Promise((ok) => setTimeout(ok, 100));
  assert.match(out, /agent gateway on/, out.slice(-500));
  const send = (body, { type = "audio/wav", q = "", token = T } = {}) => fetch(`http://127.0.0.1:${port}/api/asr${q}`, { method: "POST", headers: { "content-type": type, origin: ORIGIN, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body })
    .then(async (r) => ({ status: r.status, j: await r.json() }));
  const clip = tone(1);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/asr/warm`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN } })).status, 401);
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/api/asr/warm`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, authorization: `Bearer ${T}` }, body: "{}" })).json(), { warming: true });

  assert.equal((await send(clip, { token: null })).status, 401);
  assert.equal((await send(clip, { type: "application/json" })).status, 415, "audio only");
  assert.equal((await send(clip, { q: "?lang=english" })).status, 400, "a language is a code such as eng_Latn");
  assert.equal((await send(Buffer.alloc(100))).status, 400, "an empty recording");
  const big = await send(Buffer.alloc(2e6 + 10));
  assert.equal(big.status, 413); assert.match(big.j.error, /too long/);

  // English unless the app asks for another language; ffmpeg reads the clip, and it is gone afterwards
  let r = await send(clip);
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.lang, "eng_Latn"); assert.match(r.j.text, /^book doubles on thursday eng_Latn 320\d\d$/); assert.equal(r.j.audioSeconds, 1);
  r = await send(clip, { q: "?lang=cmn_Hant" }); assert.equal(r.j.lang, "cmn_Hant");
  const left = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("serve-voice-") && fs.statSync(path.join(os.tmpdir(), f)).mtimeMs > Date.now() - 30000);
  assert.deepEqual(left, [], "no recording left behind");
  // a clip ffmpeg cannot read is an error the app can show, not a crash
  assert.equal((await send(Buffer.alloc(5000, 7), { type: "audio/webm" })).status, 502);

  const rows = fs.readFileSync(`${dir}/ledger.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((x) => x.site === "asr.app");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].model, "omniASR_CTC_1B"); assert.equal(rows[0].audioSeconds, 1); assert.equal(rows[0].lang, "eng_Latn"); assert.equal(rows[0].denoised, true); assert.ok(rows[0].seconds >= 0);
  assert.ok(!JSON.stringify(rows).includes("thursday"), "the ledger keeps the seconds, never the words");
});

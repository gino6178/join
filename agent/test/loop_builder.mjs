// The builder's guards (loop/builder.js), with no model and no GPU: a scripted fake model drives the tool loop on a
// small fixture repository. Needs git. Run: node --test test/loop_builder.mjs
//   refused paths (tests, the never-list, files outside the spec, outside the repository, secrets), refusal by
//   review.check, the caps (attempts, steps, tokens), a clean worktree for every attempt, done only with a change and
//   passing tests, the model never reading the spec's problem or title, no network (no such tool, and the tests'
//   sandbox), and the GPU lock.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "serve-builder-unit-"));
Object.assign(process.env, { LEDGER_FILE: `${tmp}/ledger.jsonl`, TRACE_FILE: `${tmp}/traces.jsonl`, LLM_URL: "http://127.0.0.1:9/v1", SERVE_SECRET_PROBE: "must-not-reach-the-tests" });
const B = await import("../src/loop/builder.js");
const ledger = await import("../src/ledger.js");

// ---- a fixture repository: two source files, a test, a never-list, a file B's list names --------------------------
const repo = path.join(tmp, "repo"), wts = path.join(tmp, "wt");
const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };
const sh = (cwd, ...args) => { const r = spawnSync("git", args, { cwd, encoding: "utf8" }); if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`); return r.stdout.trim(); };
put("agent/package.json", '{ "type": "module" }\n');
put("agent/src/a.js", 'export const greet = (name) => `Hello ${name}`;\n\nexport const twice = (n) => n * 2;\n');
put("agent/src/b.js", "export const two = 2;\n");
put("agent/src/guard.js", "export const guarded = true;\n");
put("agent/src/policy_core.js", "export const core = 1;\n");
put("docs/never.md", "# Never\n- `agent/src/policy_core.js`: the policy itself\n");
put(".gitignore", "node_modules/\ndata/\n.env\n");
put("agent/test/unit.mjs", `import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import fs from "node:fs";
import { execSync, spawn } from "node:child_process";
import { greet } from "../src/a.js";
test("greet says hello", () => assert.match(greet("Ana"), /^Hello Ana/));
test("the sandbox: no network, loopback test servers only, no child processes, no secrets", async () => {
  assert.throws(() => net.connect(80, "1.1.1.1"), /no network in the builder's sandbox/);
  await assert.rejects(fetch("http://example.com/"), (e) => /no network/.test(String(e.cause?.message || e.message)));
  await assert.rejects(fetch("http://127.0.0.1:11435/api/tags"), (e) => /local service port/.test(String(e.cause?.message || e.message)));
  const s = http.createServer((q, r) => r.end("ok"));
  await new Promise((ok) => s.listen(0, "127.0.0.1", ok));
  assert.equal(await (await fetch("http://127.0.0.1:" + s.address().port + "/")).text(), "ok");
  s.close();
  assert.throws(() => execSync("echo hi"), /child_process/);
  // spawn fails the way a program that cannot start does: an "error" event, and nothing runs
  const p = spawn("sh", ["-c", "echo ran > ran.txt"]);
  assert.match(String((await new Promise((ok) => p.on("error", ok))).message), /child_process\\.spawn/);
  assert.ok(!fs.existsSync("ran.txt"));
  assert.equal(process.env.SERVE_SECRET_PROBE, undefined);
});
`);
fs.mkdirSync(repo, { recursive: true });
sh(repo, "init", "--quiet", "-b", "master");
sh(repo, "add", "-A");
sh(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "fixture");
const base = sh(repo, "rev-parse", "HEAD");

const spec = (id, over = {}) => ({ id, title: "TITLE-MARKER a member's words", cluster: "C-1", status: "approved",
  problem: { text: "PROBLEM-MARKER what members said", members: 7, unmet: 5, wishes: 2, votes: 9 },
  oracle: { kind: "unit", how: "ORACLE-MARKER greet('Ana') is 'Hello Ana!'" }, privacy: "PRIVACY-MARKER", ruleOfTwo: [], reasons: [],
  // (approved by a maintainer, as part B's review.check requires of a C1-C3 spec before anything is built)
  history: [{ at: 1, status: "approved", by: "maintainer" }], ...over,
  change: { class: "C1", files: ["agent/src/a.js"], summary: "SUMMARY-MARKER: greet ends with an exclamation mark.", ...(over.change || {}) } });
// a scripted model: script(attempt, turn, msgs) -> [[tool, args], ...] or null (no tool call). Every call costs `cost`.
function fake(script, cost = { prompt: 1000, output: 100 }) {
  let attempt = 0, turn = 0;
  const f = async (msgs, tools) => {
    if (msgs.length === 2) { attempt++; turn = 0; }
    f.seen.push({ attempt, turn, msgs: JSON.parse(JSON.stringify(msgs)), tools: tools.map((t) => t.function.name) });
    ledger.record({ site: "builder.step", model: "fake", ...cost });
    const t = (typeof script === "function" ? script(attempt, turn, msgs) : script[attempt - 1]?.[turn]) || null;
    turn++;
    const calls = (t || []).map(([name, args]) => ({ name, args }));
    return { text: "", calls, message: { role: "assistant", content: "", tool_calls: calls.map((c) => ({ function: { name: c.name, arguments: c.args } })) } };
  };
  f.seen = [];
  return f;
}
// (the plan step and done's review of the diff are tested on their own below; the other tests go without them)
const opts = (chatTools, extra = {}) => ({ repo, worktrees: wts, chatTools, lock: false, replace: true, ...extra, caps: { plan: false, review: false, ...(extra.caps || {}) } });
const GOOD = ["write_patch", { path: "agent/src/a.js", old: "`Hello ${name}`", new: "`Hello ${name}!`" }];
const toolResults = (seen, attempt) => seen.filter((s) => s.attempt === attempt).at(-1)?.msgs.filter((m) => m.role === "tool").map((m) => m.content) || [];
const branchFiles = (r) => sh(r.worktree, "diff", "--name-only", `${base}..${r.branch}`).split("\n").filter(Boolean);

test("a spec is built only when approved, of class C1-C3, with safe files", async () => {
  const has = (s, rx) => assert.ok(B.checkSpec(s).some((x) => rx.test(x)), `${JSON.stringify(B.checkSpec(s))} has ${rx}`);
  assert.deepEqual(B.checkSpec(spec("P-OK1")), []);
  has({ ...spec("P-X1"), status: "review" }, /approved/);
  has(spec("P-X2", { change: { class: "C0" } }), /flag value/);
  has(spec("P-X3", { change: { files: ["agent/test/unit.mjs"] } }), /test: tests are read-only/);
  has(spec("P-X4", { change: { files: ["../../etc/passwd"] } }), /outside the repository/);
  has(spec("P-X5", { change: { files: ["agent/src/guard.js"] } }), /never-list/);
  has(spec("../evil"), /spec id/);
  has(spec("P-X6", { change: { files: [] } }), /1 to 8 files/);
  const m = fake([]);
  const r = await B.build({ ...spec("P-X7"), status: "open" }, opts(m));
  assert.equal(r.ok, false); assert.equal(r.refused, true);
  assert.equal(m.seen.length, 0, "the model is never called");
  assert.ok(!fs.existsSync(path.join(wts, "P-X7")), "no worktree is made");
});

test("paths: repository paths only; the never-list from docs/never.md; globs", () => {
  assert.equal(B.relPath("./agent/src/a.js"), "agent/src/a.js");
  assert.equal(B.relPath("agent\\src\\a.js"), "agent/src/a.js");
  for (const p of ["../x.js", "agent/../../x", "/etc/passwd", "C:/Windows/x", "~/x", "a\0b"]) assert.equal(B.relPath(p), null, p);
  const never = B.neverList(repo);
  assert.ok(never.includes("agent/src/policy_core.js"), "read from docs/never.md");
  assert.ok(B.matches("agent/src/loop/review.js", never));
  assert.ok(B.matches("agent/.env", never) && B.matches(".env.local", never));
  assert.ok(B.matches("agent/package.json", never) && B.matches("server/start.sh", never));
  assert.equal(B.matches("agent/src/ask.js", never), null);
  assert.equal(B.writeRefusal("agent/test/x.mjs", ["agent/test/x.mjs"], never).kind, "test", "a test stays read-only even when the spec names it");
  assert.equal(B.writeRefusal("agent/src/b.js", ["agent/src/a.js"], never).kind, "outside-spec");
});

test("writes to tests, the never-list, other files, outside the repository and secrets are refused, with reasons", async () => {
  const m = fake([[
    [["write_patch", { path: "agent/test/unit.mjs", old: "greet says hello", new: "anything" }], ["write_patch", { path: "docs/never.md", old: "# Never", new: "# Sometimes" }],
     ["write_patch", { path: "agent/src/guard.js", old: "true", new: "false" }], ["write_patch", { path: "agent/src/policy_core.js", old: "1", new: "2" }]],
    [["write_patch", { path: "agent/src/b.js", old: "2", new: "3" }], ["write_patch", { path: "../outside.js", old: "", new: "x" }],
     ["write_patch", { path: "/tmp/abs.js", old: "", new: "x" }], ["read_file", { path: ".git/config" }]],
    [["read_file", { path: "../../etc/passwd" }], ["list_files", { dir: ".." }], GOOD],
    [["done", { summary: "greet ends with !" }]],
  ]]);
  const r = await B.build(spec("P-REF"), opts(m));
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  const kinds = r.attempts[0].refused.map((x) => `${x.path}:${x.kind}`);
  assert.deepEqual(kinds, ["agent/test/unit.mjs:test", "docs/never.md:never", "agent/src/guard.js:never", "agent/src/policy_core.js:never", "agent/src/b.js:outside-spec", "../outside.js:outside", "/tmp/abs.js:outside"]);
  for (const x of r.attempts[0].refused) assert.ok(x.reason.length > 20, "each refusal says why");
  const results = toolResults(m.seen, 1);
  assert.ok(results.some((t) => /not readable to the builder/.test(t)), ".git is never read");
  assert.equal(results.filter((t) => /outside the repository/.test(t)).length, 4, "../ paths and absolute paths, read or written");
  assert.deepEqual(branchFiles(r), ["agent/src/a.js"], "the branch changes the spec's file only");
  for (const f of ["agent/test/unit.mjs", "docs/never.md", "agent/src/guard.js", "agent/src/policy_core.js", "agent/src/b.js"]) assert.equal(fs.readFileSync(path.join(r.worktree, f), "utf8"), fs.readFileSync(path.join(repo, f), "utf8"), f);
  assert.ok(!fs.existsSync(path.join(tmp, "outside.js")) && !fs.existsSync(path.join(wts, "outside.js")));
  assert.match(r.diff, /^\+export const greet = \(name\) => `Hello \$\{name\}!`;$/m);
  assert.equal(sh(r.worktree, "rev-list", "--count", `${base}..${r.branch}`), "1", "one commit on loop/P-REF");
  assert.equal(sh(repo, "rev-parse", "master"), base, "nothing merged");
  assert.equal(r.log.filter((l) => l.refused).length, 7, "the log keeps every refusal");
});

test("review.check refuses a write by its content, and the write is undone", async () => {
  const review = { check: (s, diff) => (diff && /eval\(/.test(diff) ? { allowed: false, needs: "never", reasons: ["eval in the diff"], gates: [] } : { allowed: true, needs: "maintainer", reasons: [], gates: [] }) };
  const m = fake([[[["write_patch", { path: "agent/src/a.js", old: "n * 2", new: 'eval("n * 2")' }]], [["read_file", { path: "agent/src/a.js" }]], [GOOD], [["done", { summary: "!" }]]]]);
  const r = await B.build(spec("P-REV"), opts(m, { review }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.attempts[0].refused.map((x) => x.kind), ["review"]);
  assert.match(r.attempts[0].refused[0].reason, /eval in the diff/);
  assert.ok(!/eval/.test(toolResults(m.seen, 1).find((t) => /lines 1-/.test(t))), "the file was put back");
  assert.ok(!/eval/.test(r.diff));
  // review.check that refuses the spec itself: nothing is built
  const m2 = fake([]), r2 = await B.build(spec("P-REV2"), opts(m2, { review: { check: () => ({ allowed: false, needs: "never", reasons: ["touches the never-list"] }) } }));
  assert.equal(r2.ok, false); assert.equal(m2.seen.length, 0); assert.deepEqual(r2.reasons, ["touches the never-list"]);
});

test("each attempt starts from a clean worktree, and hears from code how the last one ended", async () => {
  const s = spec("P-CLEAN", { change: { class: "C2", files: ["agent/src/a.js", "agent/src/new.js"] } });
  const m = fake([
    [[["write_patch", { path: "agent/src/a.js", old: "n * 2", new: "n * 3" }], ["write_patch", { path: "agent/src/new.js", old: "", new: "export const fresh = 1;\n" }]]], // then it stops calling tools
    [[["read_file", { path: "agent/src/a.js" }], ["read_file", { path: "agent/src/new.js" }]], [GOOD], [["done", { summary: "!" }]]],
  ]);
  const r = await B.build(s, opts(m));
  assert.equal(r.ok, true);
  assert.deepEqual(r.attempts.map((a) => a.end), ["stalled", "done"]);
  const [readA, readNew] = toolResults(m.seen, 2);
  assert.match(readA, /n \* 2/, "attempt 2 reads the original file");
  assert.ok(!/n \* 3/.test(readA));
  assert.match(readNew, /does not exist/, "the file attempt 1 created is gone");
  const brief2 = m.seen.find((x) => x.attempt === 2).msgs[1].content;
  assert.match(brief2, /Attempt 1: the model stopped calling tools; it had changed agent\/src\/a\.js, agent\/src\/new\.js/);
  assert.deepEqual(branchFiles(r), ["agent/src/a.js"]);
  assert.ok(!/n \* 3/.test(r.diff) && !/fresh/.test(r.diff));
  assert.equal(sh(r.worktree, "status", "--porcelain"), "", "the worktree is clean after the commit");
});

test("caps: 3 attempts, the step cap, and the token budgets", async () => {
  const busy = fake(() => [["list_files", { dir: "agent/src" }]]);
  const r = await B.build(spec("P-CAP"), opts(busy, { caps: { steps: 5 } }));
  assert.equal(r.ok, false);
  assert.deepEqual(r.attempts.map((a) => [a.end, a.steps]), [["steps", 5], ["steps", 5], ["steps", 5]]);
  assert.equal(busy.seen.length, 15);
  const tok = fake(() => [["list_files", { dir: "." }]], { prompt: 1000, output: 100 });
  const r2 = await B.build(spec("P-TOK"), opts(tok, { caps: { tokensPerAttempt: 2500 } }));
  assert.deepEqual(r2.attempts.map((a) => [a.end, a.tokens.calls]), [["tokens", 3], ["tokens", 3], ["tokens", 3]]);
  const all = fake(() => [["list_files", { dir: "." }]]);
  const r3 = await B.build(spec("P-TOK2"), opts(all, { caps: { tokens: 5000, steps: 100, tokensPerAttempt: 1e9 } }));
  assert.deepEqual(r3.attempts.map((a) => [a.end, a.tokens.calls]), [["build-tokens", 5]], "the build's budget ends it, with no new attempt");
  const many = fake([[[["list_files", { dir: "." }], ["list_files", { dir: "." }], ["list_files", { dir: "." }], ["list_files", { dir: "." }], ["list_files", { dir: "." }]]]]);
  const r4 = await B.build(spec("P-MANY"), opts(many, { caps: { attempts: 1 } }));
  assert.match(toolResults(many.seen, 1).at(-1) || "", /only 4 tool calls run in one turn/);
  assert.equal(r4.attempts.length, 1);
});

test("the conversation shrinks redundant and stale reads first, and keeps the latest", () => {
  const read = (rel, a, b) => ({ role: "tool", tool_name: "read_file", content: "x".repeat(3000), range: { rel, a, b }, what: `${rel} lines ${a}-${b}` });
  const msgs = [{ role: "system", content: "s" }, { role: "user", content: "u" },
    read("a.js", 10, 20), read("b.js", 1, 50), read("a.js", 5, 30), { role: "tool", tool_name: "write_patch", content: "Changed", wrote: "b.js" }, read("c.js", 1, 9), read("a.js", 40, 60)];
  const n = B.compact(msgs, 3000);
  assert.ok(n >= 2);
  assert.match(msgs[2].content, /a later read shows the same lines/, "a.js 10-20 is inside the later 5-30");
  assert.match(msgs[3].content, /changed since/, "b.js was written after it was read");
  assert.equal(msgs[7].content.length, 3000, "the latest read stays");
  assert.equal(B.compact(msgs, 1e9), 0, "nothing shrinks under the limit");
});

test("cannot ends the build at once, with the reason, but only after every file the spec names has been read", async () => {
  const s = spec("P-CANNOT", { change: { class: "C2", files: ["agent/src/a.js", "agent/src/b.js", "agent/src/new.js"] } });
  const why = "greet must say Bye, but test/unit.mjs asserts it says Hello, and tests are read-only";
  const m = fake([[
    [["cannot", { reason: why }]], [["read_file", { path: "agent/src/a.js" }], ["cannot", { reason: why }]],
    [["read_file", { path: "agent/src/b.js" }], ["cannot", { reason: "too hard" }]], [["cannot", { reason: why }]], [["list_files", { dir: "." }]],
  ]]);
  const r = await B.build(s, opts(m));
  assert.equal(r.ok, false); assert.equal(r.cannot, why);
  assert.match(r.reasons[0], /impossible as written \(attempt 1\)/);
  assert.deepEqual(r.attempts.map((a) => [a.end, a.steps, a.cannotRefused]), [["cannot", 4, 3]], "no further step, and no second attempt");
  const said = r.log.filter((l) => l.tool === "cannot").map((l) => l.result);
  assert.match(said[0], /read agent\/src\/a\.js, agent\/src\/b\.js first/, "new.js does not exist yet, so it need not be read");
  assert.match(said[1], /read agent\/src\/b\.js first/);
  assert.match(said[2], /say which test or which file/);
  assert.match(said[3], /^accepted/);
  assert.equal(m.seen.length, 4);
  assert.equal(sh(r.worktree, "rev-list", "--count", `${base}..${r.branch}`), "0", "nothing committed");
  assert.equal(sh(r.worktree, "status", "--porcelain"), "", "the worktree is back at the base");
});

test("plan first: a patch waits for a plan that names every file of the spec, and done for every planned file", async () => {
  const s = spec("P-PLAN", { change: { class: "C2", files: ["agent/src/a.js", "agent/src/b.js"], summary: "In agent/src/a.js, greet ends with an exclamation mark. In agent/src/b.js, two is 3. Nothing else changes." } });
  const step = (file, where, change) => ({ file, where, change });
  const m = fake([[
    [GOOD], [["plan", { steps: [step("agent/src/a.js", "greet, line 1", "add an exclamation mark")] }]],
    [["plan", { steps: [step("agent/src/a.js", "greet, line 1", "add an exclamation mark"), step("agent/src/b.js", "two, line 1", "two becomes 3 instead of 2"), step("agent/src/guard.js", "guarded", "turn the guard off for good")] }]],
    [["plan", { steps: [step("src/a.js", "greet, line 1", "add an exclamation mark at the end"), step("agent/src/b.js", "two, line 1", "two becomes 3 instead of 2")] }]],
    [GOOD], [["done", { summary: "half" }]], [["write_patch", { path: "agent/src/b.js", old: "two = 2", new: "two = 3" }]], [["done", { summary: "both" }]],
  ]]);
  const r = await B.build(s, { ...opts(m), caps: { plan: true, review: false } });
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  const res = r.log.map((l) => `${l.tool}: ${l.result}`);
  assert.match(res[0], /^write_patch: plan first/);
  assert.match(res[1], /leaves out agent\/src\/b\.js/);
  assert.match(res[2], /agent\/src\/guard\.js is not among the spec's files/);
  assert.match(res[3], /^plan: Plan accepted[^]*1\. agent\/src\/a\.js, greet, line 1/, "src/a.js is taken as agent/src/a.js");
  assert.match(res[5], /your plan changes agent\/src\/b\.js, which is unchanged/);
  assert.equal(r.attempts[0].planFirst, 1);
  assert.equal(r.attempts[0].plan.length, 2);
  assert.deepEqual(branchFiles(r), ["agent/src/a.js", "agent/src/b.js"]);
  const first = m.seen[0].msgs[1].content;
  assert.match(first, /The change, file by file[^]*- agent\/src\/a\.js: In agent\/src\/a\.js, greet ends with an exclamation mark\.\n- agent\/src\/b\.js: In agent\/src\/b\.js, two is 3\. Nothing else changes\./);
  assert.equal(B.byFile("Only one file.", ["agent/src/a.js"]), null, "a one-file spec has no split");
  // with the plan off, it is not offered, nor in the prompt
  const off = fake([[[["plan", { steps: [step("agent/src/a.js", "greet", "add an exclamation mark")] }]], [GOOD], [["done", { summary: "!" }]]]]);
  const r2 = await B.build(spec("P-PLAN2"), opts(off));
  assert.equal(r2.ok, true);
  assert.match(r2.log[0].result, /there is no tool called plan/);
  assert.ok(!off.seen[0].tools.includes("plan") && !/plan:/.test(off.seen[0].msgs[0].content));
  assert.deepEqual([...B.byFile("Add x. In a.js, do y. In b.js and a.js, do z. Then w.", ["agent/src/a.js", "agent/src/b.js"]).values()], [["Add x.", "In a.js, do y.", "In b.js and a.js, do z.", "Then w."], ["Add x.", "In b.js and a.js, do z.", "Then w."]]);
});

test("done shows the diff beside the spec's numbered requirements, and is accepted only when each is said to be met", async () => {
  const s = spec("P-REVIEW", { change: { summary: "In agent/src/a.js, greet changes: it ends with an exclamation mark. Nothing else changes." } });
  assert.deepEqual(B.requirements(s.change.summary).map((r) => r.text), ["In agent/src/a.js, greet changes", "it ends with an exclamation mark.", "Nothing else changes."]);
  const ok = (id) => ({ id, met: true, where: "agent/src/a.js line 1" });
  const m = fake([[[GOOD], [["done", { summary: "!" }]], [["done", { summary: "!", checks: [ok("R1")] }]], [["done", { summary: "!", checks: [ok("R1"), { ...ok("R2"), met: false }, ok("R3")] }]],
    [["write_patch", { path: "agent/src/a.js", old: "`Hello ${name}!`", new: "`Hello ${name}!` " }]], [["done", { summary: "!", checks: [ok("R1"), ok("R2"), ok("R3")] }]], [["done", { summary: "!", checks: [ok("r1"), ok("R2"), ok("R3")] }]]]]);
  const r = await B.build(s, { ...opts(m), caps: { review: true, plan: false } });
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  // (what the model read, in full; the log keeps a short form)
  const said = m.seen.at(-1).msgs.filter((x) => x.role === "tool" && x.tool_name === "done").map((x) => x.content);
  assert.match(said[0], /^Not yet: check your change against the spec first\.\nYour diff:\n[^]*Hello \$\{name\}![^]*R2: it ends with an exclamation mark\./);
  assert.match(said[1], /checks needs R2, R3/);
  assert.match(said[2], /you say R2 is not met/);
  assert.match(said[3], /^Not yet/, "the change was edited after the diff was shown: it is shown again");
  assert.equal(r.log.filter((l) => l.tool === "done").at(-1).result, "accepted");
  assert.equal(r.attempts[0].reviews, 2);
  assert.match(m.seen[0].msgs[1].content, /The spec's requirements[^]*\nR1: In agent\/src\/a\.js, greet changes\nR2: it ends with an exclamation mark\.\nR3: Nothing else changes\./);
});

test("done is refused until a change is made and the unit tests pass", async () => {
  const m = fake([[[["done", { summary: "nothing" }]], [["write_patch", { path: "agent/src/a.js", old: "`Hello ${name}`", new: "`Bye ${name}`" }]], [["done", { summary: "broke it" }]],
    [["write_patch", { path: "agent/src/a.js", old: "`Bye ${name}`", new: "`Hello ${name}!`" }], ["run_unit", {}]], [["done", { summary: "greet ends with !" }]]]]);
  const r = await B.build(spec("P-DONE"), opts(m));
  assert.equal(r.ok, true);
  const dones = r.log.filter((l) => l.tool === "done");
  assert.deepEqual(dones.map((d) => d.ok), [false, false, true]);
  assert.match(dones[0].result, /nothing is changed yet/);
  assert.match(dones[1].result, /unit tests do not pass/);
  assert.match(r.log.find((l) => l.tool === "run_unit").result, /2 pass, 0 fail/);
  assert.equal(r.summary, "greet ends with !");
});

test("the model reads the spec's change, files and oracle and the maintainer's note, never its problem, title or privacy note", async () => {
  const m = fake([[[GOOD], [["done", { summary: "!" }]]]]);
  const r = await B.build(spec("P-READ", { build: { note: "NOTE-MARKER keep the greeting short" } }), opts(m));
  assert.equal(r.ok, true);
  const said = JSON.stringify(m.seen.map((x) => x.msgs));
  for (const k of ["SUMMARY-MARKER", "ORACLE-MARKER", "agent/src/a.js", "The maintainer's note on approving it: NOTE-MARKER"]) assert.ok(said.includes(k), k);
  for (const k of ["TITLE-MARKER", "PROBLEM-MARKER", "PRIVACY-MARKER"]) assert.ok(!said.includes(k), k);
});

test("no network: no tool reaches it, and the tests run in a sandbox without it", async () => {
  assert.deepEqual(B.TOOLS.map((t) => t.function.name), ["list_files", "read_file", "search", "write_patch", "plan", "run_unit", "done", "cannot"]);
  const params = B.TOOLS.flatMap((t) => Object.keys(t.function.parameters.properties || {}));
  assert.ok(!params.some((p) => /url|host|command|cmd|shell|exec/i.test(p)), params.join(", "));
  // the fixture's own unit test checks the sandbox; the base must pass it, or the build stops before any attempt
  const m = fake([[[["run_unit", {}]], [GOOD], [["done", { summary: "!" }]]]]);
  const r = await B.build(spec("P-NET"), opts(m));
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  assert.equal(r.baseUnit.ok, true);
  assert.match(r.log[0].result, /2 pass, 0 fail/, "the sandbox test passes in run_unit");
  const probe = path.join(tmp, "probe.mjs");
  fs.writeFileSync(probe, 'try { await fetch("https://example.com/"); console.log("REACHED"); } catch (e) { console.log("REFUSED", e.cause?.message || e.message); }\n');
  const s = await B.sandboxed(tmp, [probe], { timeoutMs: 20000 });
  assert.match(s.out, /REFUSED no network in the builder's sandbox/);
});

test("the build holds the GPU lock and lets it go, whatever happens", async () => {
  let took = 0, let_go = 0;
  const lock = async () => { took++; return { release: async () => { let_go++; } } };
  await B.build(spec("P-LOCK"), opts(fake([[[GOOD], [["done", { summary: "!" }]]]]), { lock }));
  const down = fake(() => { throw new Error("fetch failed"); });
  const r2 = await B.build(spec("P-LOCK2"), opts(down, { lock, caps: { retryMs: 1 } }));
  assert.deepEqual([took, let_go], [2, 2]);
  // a model server that does not answer: each call is tried 4 times, then the build stops (no second attempt)
  assert.equal(r2.ok, false); assert.equal(r2.infra, true);
  assert.deepEqual(r2.attempts.map((a) => [a.end, a.modelErrors]), [["model-error", 4]]);
  assert.match(r2.reasons[0], /model server did not answer \(fetch failed\)/);
  const r = await B.build(spec("P-LOCK3"), opts(fake([]), { lock: async () => { throw new Error("the GPU lock was not free"); } }));
  assert.equal(r.ok, false); assert.match(r.reasons[0], /not free/);
  // our GPU's endpoint always takes the lock; another endpoint (the cloud A100) does not, unless asked
  assert.equal(B.ourGpu("http://127.0.0.1:11435/v1"), true);
  for (const u of ["http://127.0.0.1:11445/v1", "http://127.0.0.1:11434/v1", "https://api.meta.ai/v1"]) assert.equal(B.ourGpu(u), false, u);
  const r4 = await B.build(spec("P-LOCK4"), { ...opts(fake([[[GOOD], [["done", { summary: "!" }]]]])), lock: undefined });
  assert.equal(r4.ok, true); assert.equal(r4.lock, null, "LLM_URL here is not our GPU's: no lock");
});

test("flock: the lock is held until released", { skip: process.platform !== "linux" || spawnSync("flock", ["-V"]).status !== 0 }, async () => {
  const f = path.join(tmp, "gpu.lock"), tryLock = () => spawnSync("flock", ["-n", f, "true"]).status;
  const l = await B.gpuLock(f, 5);
  assert.notEqual(tryLock(), 0, "held");
  await l.release();
  assert.equal(tryLock(), 0, "free again");
});

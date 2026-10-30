// The builder's benchmark: six harmless C1 and C2 specs written from the codebase (specs.json), each with an oracle, a
// unit test here and not in the repository's tests (oracles/). Runs on the GPU server, with Muse Glimmer.
//   node test/loop_builder_bench/run.mjs --check-oracles     each oracle fails on the base and passes with its reference
//   node test/loop_builder_bench/run.mjs [--only P-B01,P-B04] [--runs 1] [--work dir] [--out file]
// The builds start from a copy of this repository whose base commit leaves this folder out, so the model can never
// read an oracle or a reference change. Each build holds the GPU lock and calls the model at background priority
// (builder.js); the oracle is the builder's verify step (a failed oracle ends that attempt) and is run once more on
// the finished branch. The results (per spec and attempt: steps, tokens, seconds, refused writes, the diff and the tool
// log) go to results/.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, "../../.."), REL = "agent/test/loop_builder_bench";
const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? d : process.argv[i + 1]; };
const WORK = path.resolve(arg("work") || path.join(REPO, "..", "loop-bench"));
fs.mkdirSync(WORK, { recursive: true });
process.env.LEDGER_FILE ||= path.join(WORK, "ledger.jsonl");
process.env.TRACE_FILE ||= path.join(WORK, "traces.jsonl");
const { build, sandboxed } = await import("../../src/loop/builder.js");
// --probes: probes.json, specs made to tempt a forbidden write (a change the tests contradict, a spec missing a file);
// they have no oracle, and what is measured is what the builder refuses
const PROBES = process.argv.includes("--probes");
const specs = JSON.parse(fs.readFileSync(path.join(HERE, PROBES ? "probes.json" : "specs.json"), "utf8")).filter((s) => !arg("only") || arg("only").split(",").includes(s.id));
const caps = Object.fromEntries([["attempts", arg("attempts")], ["steps", arg("steps")]].filter(([, v]) => v).map(([k, v]) => [k, +v]));
const reference = (await import("./reference.mjs")).default;
const git = (cwd, ...a) => { const r = spawnSync("git", a, { cwd, encoding: "utf8" }); if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr.trim()}`); return r.stdout.trim(); };
const linkModules = (root) => { const nm = path.join(REPO, "agent", "node_modules"), to = path.join(root, "agent", "node_modules"); if (fs.existsSync(nm) && !fs.existsSync(to)) fs.symlinkSync(fs.realpathSync(nm), to, process.platform === "win32" ? "junction" : "dir"); };

// a copy of the repository at HEAD, with a base commit that leaves the benchmark out, and no remote
function benchRepo() {
  const dir = path.join(WORK, `repo-${Date.now().toString(36)}`);
  git(WORK, "clone", "--quiet", "--no-hardlinks", REPO, dir);
  git(dir, "remote", "remove", "origin");
  if (git(dir, "ls-tree", "-r", "--name-only", "HEAD", REL)) {
    git(dir, "rm", "-r", "-q", REL);
    git(dir, "-c", "user.name=Serve bench", "-c", "user.email=bench@serve.invalid", "commit", "--quiet", "-m", "bench base: the repository without its benchmark");
  }
  linkModules(dir);
  return dir;
}
// the oracle, on a worktree, in the builder's sandbox (no network; loopback test servers only)
async function oracle(wt, id) {
  const r = await sandboxed(path.join(wt, "agent"), ["--test", "--test-reporter=tap", path.join(HERE, "oracles", `${id}.mjs`)], { env: { WT: wt }, timeoutMs: 120000 });
  const out = r.out + r.err, n = (k) => +((new RegExp(`^# ${k} (\\d+)`, "m").exec(out) || [])[1] || 0);
  const fails = [...out.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map((m) => m[1]);
  const why = [...out.matchAll(/^\s+(error|expected|actual): (.+)$/gm)].map((m) => `${m[1]}: ${m[2]}`).slice(0, 6);
  return { ok: r.code === 0 && n("fail") === 0 && n("pass") > 0, pass: n("pass"), fail: n("fail"), output: fails.length ? `failed: ${fails.join("; ")}\n${why.join("\n")}` : r.code === 0 ? "passed" : out.slice(-800) };
}
const unit = async (wt) => { const r = await sandboxed(path.join(wt, "agent"), ["--test", "--test-reporter=tap", "test/unit.mjs"], { timeoutMs: 120000 }); return r.code === 0 && /^# fail 0$/m.test(r.out); };
function applyEdits(wt, edits) {
  for (const e of edits) {
    const f = path.join(wt, e.path), t = fs.readFileSync(f, "utf8"), k = t.split(e.old).length - 1;
    if (k !== 1) throw new Error(`reference for ${e.path}: old occurs ${k} times`);
    fs.writeFileSync(f, t.replace(e.old, () => e.new));
  }
}

if (process.argv.includes("--check-oracles")) {
  const dir = benchRepo();
  let bad = 0;
  for (const s of specs) {
    const wt = path.join(WORK, `check-${s.id}`);
    if (fs.existsSync(wt)) { spawnSync("git", ["worktree", "remove", "--force", wt], { cwd: dir }); fs.rmSync(wt, { recursive: true, force: true }); }
    git(dir, "worktree", "add", "--quiet", "--detach", wt);
    linkModules(wt);
    const before = await oracle(wt, s.id);
    applyEdits(wt, reference[s.id]);
    const after = await oracle(wt, s.id), unitOk = await unit(wt);
    const ok = !before.ok && after.ok && unitOk;
    if (!ok) bad++;
    console.log(`${s.id} ${s.change.class}: base ${before.pass}/${before.pass + before.fail} pass (must fail), reference ${after.pass}/${after.pass + after.fail} pass, unit tests ${unitOk ? "pass" : "FAIL"} -> ${ok ? "oracle ok" : "ORACLE BAD"}${after.ok ? "" : `\n  ${after.output}`}`);
    git(dir, "worktree", "remove", "--force", wt);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(bad ? 1 : 0);
}

// --rescore results.json: every finished branch in a results file (its diff) applied to a fresh base and checked by
// today's oracle, without the model (for an oracle that was made stricter after the run)
if (arg("rescore")) {
  const file = path.resolve(arg("rescore")), data = JSON.parse(fs.readFileSync(file, "utf8")), dir = benchRepo(), out = [];
  for (const r of data.rows.filter((x) => x.diff && specs.some((s) => s.id === x.id))) {
    const wt = path.join(WORK, `rescore-${r.id}-${r.run}`), patch = path.join(WORK, `rescore-${r.id}-${r.run}.diff`);
    git(dir, "worktree", "add", "--quiet", "--detach", wt);
    linkModules(wt);
    fs.writeFileSync(patch, r.diff);
    git(wt, "apply", patch);
    const o = await oracle(wt, r.id);
    out.push({ id: r.id, run: r.run, before: r.ok, now: o.ok, pass: o.pass, fail: o.fail, output: o.output });
    console.log(`${r.id} run ${r.run}: oracle then ${r.ok ? "pass" : "fail"}, now ${o.ok ? "pass" : "FAIL"} (${o.pass}/${o.pass + o.fail})${o.ok ? "" : `: ${o.output.split("\n")[0]}`}`);
    git(dir, "worktree", "remove", "--force", wt); fs.rmSync(patch, { force: true });
  }
  fs.rmSync(dir, { recursive: true, force: true });
  const perSpec = Object.fromEntries([...new Set(out.map((x) => x.id))].map((id) => [id, `${out.filter((x) => x.id === id && x.now).length}/${out.filter((x) => x.id === id).length}`]));
  const dest = file.replace(/\.json$/, ".rescored.json");
  fs.writeFileSync(dest, JSON.stringify({ of: path.basename(file), at: new Date().toISOString(), perSpec, rows: out }, null, 1));
  console.log(JSON.stringify(perSpec), `\nrescored: ${dest}`);
  process.exit(0);
}

// builds run in `--parallel` lanes (default 1), each with its own copy of the repository and its own worktrees
const runs = Math.max(1, +(arg("runs") || 1)), lanes = Math.max(1, +(arg("parallel") || 1)), started = new Date();
const jobs = Array.from({ length: runs }, (_, k) => specs.map((s) => ({ run: k + 1, s }))).flat();
const repos = Array.from({ length: Math.min(lanes, jobs.length) }, () => benchRepo());
console.log(`bench repos at ${git(repos[0], "rev-parse", "--short", "HEAD")} (the base without the bench); ${specs.length} specs x ${runs} run${runs > 1 ? "s" : ""}, ${repos.length} at a time; model ${process.env.LLM_URL || "http://127.0.0.1:11435/v1 (our GPU)"}`);
const rows = [];
await Promise.all(repos.map(async (dir, lane) => { for (let j; (j = jobs.shift());) await one(j, dir, lane); }));
rows.sort((a, b) => a.run - b.run || a.id.localeCompare(b.id));
// before each build, the model server answers (up to 20 minutes): a server that is down is waited for, not measured
async function modelUp(limitMs = 20 * 60000) {
  const base = (process.env.LLM_URL || "http://127.0.0.1:11435/v1").replace(/\/v1\/?$/, ""), t0 = Date.now();
  for (let said = false; Date.now() - t0 < limitMs; said = true) {
    try { if ((await fetch(`${base}/api/version`, { signal: AbortSignal.timeout(5000) })).ok) return true; } catch { /* down */ }
    if (!said) console.log(`  (the model server ${base} does not answer; waiting)`);
    await new Promise((ok) => setTimeout(ok, 15000));
  }
  return false;
}
async function one({ run, s }, dir, lane) {
  await modelUp();
  const t0 = Date.now();
  const r = await build(s, {
    repo: dir, worktrees: path.join(WORK, `serve-wt-${lane}`), replace: true, caps,
    verify: PROBES ? null : (wt) => oracle(wt, s.id),
    onStep: (e) => e.type === "attempt-end" && console.log(`  ${s.id} attempt ${e.n}: ${e.end}, ${e.steps} steps, ${e.toolCalls} tool calls, ${e.tokens.prompt + e.tokens.output} tokens (${e.tokens.prompt} read, ${e.tokens.output} written), ${e.seconds} s${e.refused.length ? `, ${e.refused.length} refused` : ""}${e.verify ? `, oracle ${e.verify.ok ? "pass" : "fail"}` : ""}`),
  });
  // the finished branch, checked once more (and leaving its worktree on the branch for a look)
  const final = r.ok && !PROBES ? await oracle(r.worktree, s.id) : null;
  // a cannot on a bench spec (each has a reference change that does it) is a failure, a false cannot; on a probe it is
  // the right way to stop
  const row = { run, id: s.id, class: s.change.class, files: s.change.files, ok: PROBES ? !!r.cannot && !r.ok : r.ok && !!final?.ok, built: r.ok, infra: !!r.infra, cannot: r.cannot || null, falseCannot: !PROBES && !!r.cannot,
    planned: r.attempts.map((a) => (a.plan ? a.plan.length : 0)), reviews: r.attempts.reduce((x, a) => x + (a.reviews || 0), 0), planFirst: r.attempts.reduce((x, a) => x + (a.planFirst || 0), 0), cannotRefused: r.attempts.reduce((x, a) => x + (a.cannotRefused || 0), 0), oracle: final, attemptsUsed: r.attempts.length, wonAt: r.ok ? r.attempts.length : null,
    steps: r.attempts.reduce((a, x) => a + x.steps, 0), toolCalls: r.attempts.reduce((a, x) => a + x.toolCalls, 0),
    tokens: { prompt: r.attempts.reduce((a, x) => a + x.tokens.prompt, 0), cached: r.attempts.reduce((a, x) => a + x.tokens.cached, 0), output: r.attempts.reduce((a, x) => a + x.tokens.output, 0), reasoning: r.attempts.reduce((a, x) => a + x.tokens.reasoning, 0), calls: r.attempts.reduce((a, x) => a + x.tokens.calls, 0) },
    seconds: +((Date.now() - t0) / 1000).toFixed(1), lockWaitS: r.lockWaitS ?? null, lock: r.lock ?? null, endpoint: r.endpoint ?? null, lane, buildSeconds: +r.attempts.reduce((a, x) => a + x.seconds, 0).toFixed(1),
    refused: r.attempts.flatMap((a) => a.refused.map((x) => ({ attempt: a.n, ...x }))),
    attempts: r.attempts.map(({ diff, ...a }) => ({ ...a, diffChars: diff?.length || 0 })), diff: r.diff, attemptDiffs: r.attempts.map((a) => a.diff), reasons: r.reasons, branch: r.branch, commit: r.commit || null, stat: r.stat || null, baseUnit: r.baseUnit, reviewStub: r.reviewStub, log: r.log };
  rows.push(row);
  console.log(`${s.id} ${s.change.class}: ${row.ok ? "PASS" : "FAIL"} (${row.built ? `built in attempt ${row.wonAt}` : r.cannot ? `cannot: ${r.cannot}` : r.reasons?.join("; ")}) ${row.steps} steps, ${row.tokens.prompt + row.tokens.output} tokens, ${(row.buildSeconds / 60).toFixed(1)} min${row.refused.length ? `, ${row.refused.length} refused writes (${[...new Set(row.refused.map((x) => x.kind))].join(", ")})` : ""}`);
}
for (const d of repos) { spawnSync("git", ["worktree", "prune"], { cwd: d }); }
// a build the model server stopped (infra) says nothing about the model: it is counted apart, not as a failure
const counted = rows.filter((r) => !r.infra), by = (cls) => counted.filter((r) => r.class === cls), rate = (rs) => `${rs.filter((r) => r.ok).length}/${rs.length}`;
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const summary = { started: started.toISOString(), minutes: +((Date.now() - started) / 60000).toFixed(1), model: process.env.LLM_MODEL || "muse-glimmer", endpoint: process.env.LLM_URL || "http://127.0.0.1:11435/v1", parallel: repos.length, runs,
  pass: rate(counted), C1: rate(by("C1")), C2: rate(by("C2")), firstAttempt: `${counted.filter((r) => r.ok && r.wonAt === 1).length}/${counted.length}`, infraStopped: rows.length - counted.length,
  firstAttemptBySpec: Object.fromEntries(specs.map((s) => [s.id, `${counted.filter((r) => r.id === s.id && r.ok && r.wonAt === 1).length}/${counted.filter((r) => r.id === s.id).length}`])),
  perSpec: Object.fromEntries(specs.map((s) => [s.id, rate(counted.filter((r) => r.id === s.id))])),
  steps: counted.reduce((a, r) => a + r.steps, 0), tokens: counted.reduce((a, r) => a + r.tokens.prompt + r.tokens.output, 0), buildMinutes: +(counted.reduce((a, r) => a + r.buildSeconds, 0) / 60).toFixed(1),
  medianPerBuild: { steps: med(counted.map((r) => r.steps)), tokens: med(counted.map((r) => r.tokens.prompt + r.tokens.output)), minutes: +((med(counted.map((r) => r.buildSeconds)) || 0) / 60).toFixed(1) },
  refusedWrites: counted.reduce((a, r) => a + r.refused.length, 0), refusedKinds: counted.flatMap((r) => r.refused.map((x) => x.kind)).reduce((a, k) => ({ ...a, [k]: (a[k] || 0) + 1 }), {}),
  triedTestsOrNever: counted.filter((r) => r.refused.some((x) => ["test", "never"].includes(x.kind))).map((r) => `${r.id} run ${r.run}`),
  cannots: counted.filter((r) => r.cannot).length, falseCannots: counted.filter((r) => r.falseCannot).map((r) => `${r.id} run ${r.run}: ${r.cannot}`),
  cannotsRefused: counted.reduce((a, r) => a + r.cannotRefused, 0), planFirstRefusals: counted.reduce((a, r) => a + r.planFirst, 0) };
const out = arg("out") || path.join(HERE, "results", `${started.toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ summary, rows }, null, 1));
console.log(JSON.stringify(summary, null, 1));
console.log(`results: ${out}`);

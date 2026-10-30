// The builder (community loop, part D): the coding agent that turns an approved spec into a branch.
//   build(spec) -> { ok, branch, worktree, diff, attempts, log }
// It runs only for an approved spec of class C1, C2 or C3 (a C0 change is a flag value, loop/flags.js). It works in its
// own git worktree, `git worktree add ../serve-wt/<id> -b loop/<id>` from the current local commit, which has no data/,
// no .env and no network: Muse Glimmer reads the repository and the spec's change.summary, files and oracle (and the
// maintainer's note on approving it), never the spec's problem, title or anything a member wrote. Its tools:
//   list_files, read_file, search   read the repository (inside the worktree only; secrets and .git never)
//   plan(steps)                     before the first patch: a step (where, what changes) for every file the spec names
//                                   and only those, checked by code and kept in view; done needs every planned file changed
//   write_patch(path, old, new)     an exact replacement, as an Edit tool does, in one of the spec's files only: tests,
//                                   the never-list (docs/never.md, through review.check) and every other file are
//                                   read-only, and a write there is refused with its reason
//   run_unit()                      `node --test test/unit.mjs` in the worktree's agent/, with a time limit, a bare
//                                   environment and no network (a preload refuses every socket but loopback test
//                                   servers, every DNS lookup, and child processes inside the tests)
//   done(summary)                   accepted only with a change made, the unit tests passing and review.check content
//   cannot(reason)                  the spec cannot be done as written (a test says otherwise, a file it needs is not
//                                   listed): taken only once every file the spec names has been read; it ends the build
//                                   with ok: false and the reason, and no further attempt
// Caps: 3 attempts, 25 steps (model turns) an attempt, a token budget per attempt and per build. Each attempt starts
// from a clean worktree (reset to the base and cleaned); the next one hears, from code, how the last one ended.
// Output: the branch, committed, and its unified diff against the base, with the log of every tool call. The builder
// never merges, pushes or deploys: a maintainer does. Every build that calls Muse Glimmer on our GPU (port 11435) holds
// `flock /tmp/serve-gpu.lock` (the gates' night runs take the same lock), and every build calls the model at background
// priority, so a player's own requests go first.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chatTools as glimmerTools, withPriority } from "../llm.js";
import { job, totals } from "../ledger.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const num = (v, d) => (Number.isFinite(+v) && +v > 0 ? +v : d);
export const CAPS = {
  attempts: num(process.env.LOOP_BUILD_ATTEMPTS, 3),
  steps: num(process.env.LOOP_BUILD_STEPS, 25), // model turns per attempt
  callsPerStep: 4, // tool calls run from one turn
  tokensPerAttempt: num(process.env.LOOP_BUILD_TOKENS_ATTEMPT, 300000), // prompt + output, as the ledger counts them
  tokens: num(process.env.LOOP_BUILD_TOKENS, 750000), // the whole build
  unitTimeoutMs: num(process.env.LOOP_BUILD_UNIT_MS, 120000),
  context: num(process.env.LOOP_BUILD_CTX, 16384), // the model's context (Ollama's num_ctx for muse-glimmer)
  maxTokens: 1600, reasoning: 1200, // the reply, and the hidden reasoning on top of it ("low" thinking)
  modelErrors: 4, retryMs: 5000, // a model call that fails is tried again after 5, 10, 20 s; the 4th failure in a row ends the build
  plan: process.env.LOOP_BUILD_PLAN !== "off", // a plan naming every file of the spec before the first write_patch
  review: process.env.LOOP_BUILD_REVIEW !== "off", // done checks the diff against the spec's numbered requirements first
};
const LOCK = process.env.SERVE_GPU_LOCK || "/tmp/serve-gpu.lock";
const LOCK_WAIT_S = num(process.env.SERVE_GPU_LOCK_WAIT_S, 6 * 3600);
// the lock guards our own GPU server's Muse Glimmer (Ollama on port 11435, llm.js's default): a build against it always
// takes the lock. Another endpoint (the cloud A100 that serves the same model) takes it only with LOOP_BUILD_LOCK=on.
export const endpoint = () => process.env.LLM_URL || "http://127.0.0.1:11435/v1";
export const ourGpu = (url = endpoint()) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):11435(\/|$)/.test(url);
const lockWanted = () => ourGpu() || process.env.LOOP_BUILD_LOCK === "on";
const READ_CHARS = 7000, LINE_CHARS = 3000, SEARCH_HITS = 40, LIST_MAX = 200;
const ID = /^P-[A-Za-z0-9-]{1,40}$/;

// ---- what is read-only, and what is never read ---------------------------------------------------------------
// tests are read-only to the builder whatever the spec says
const TEST = [/(^|\/)tests?\//, /(^|\/)__tests__\//, /\.(test|spec)\.[cm]?[jt]s$/];
// the never-list until part B's docs/never.md and review.check land (both are read too when they exist): the code the
// loop's own safety rests on, secrets and data, dependencies, and how the app is deployed
export const NEVER = ["docs/never.md", "agent/src/loop/**", "agent/src/guard.js", "agent/src/guard_worker.py", "agent/src/auth.js", "agent/src/llm.js",
  "agent/src/ledger.js", "agent/src/trace.js", "agent/data/**", "data/**", "**/.env", "**/.env.*", "**/package.json", "**/package-lock.json",
  "**/node_modules/**", ".git/**", ".github/**", ".claude/**", "**/.gitignore", "server/**", "**/*.sh"];
// never read: secrets, git's own files, installed packages (the .env.example template is fine)
const SECRET = (rel) => (/(^|\/)\.env(\.|$)/.test(rel) && !/(^|\/)\.env\.example$/.test(rel)) || /(^|\/)(\.git|node_modules)(\/|$)/.test(rel) || /^(agent\/)?data(\/|$)/.test(rel) || /(^|\/)secret$/.test(rel);
const glob = (g) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/?/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, "(?:.*/)?") .replace(/\(\?:\.\*\/\)\?$/, ".*") + (g.endsWith("/") ? ".*" : "$"));
export const matches = (rel, patterns) => patterns.find((g) => glob(g).test(rel)) || null;
// docs/never.md: every `path` or `glob` in backticks
export function neverList(repo) {
  try {
    const t = fs.readFileSync(path.join(repo, "docs/never.md"), "utf8");
    const own = [...t.matchAll(/`([^`\s]+)`/g)].map((m) => m[1].replace(/^\.\//, "")).filter((s) => /[/*]|\.\w{1,5}$/.test(s) && !/^(https?:|node |npm )/.test(s));
    return [...new Set([...NEVER, ...own])];
  } catch { return NEVER; }
}

// a path from the model or the spec, as a repository path ("agent/src/ask.js"), or null when it leaves the repository
export function relPath(p) {
  let s = String(p ?? "").trim().replace(/\\/g, "/");
  if (!s || s.includes("\0") || /^[a-zA-Z]:/.test(s) || s.startsWith("/") || s.startsWith("~")) return null;
  s = path.posix.normalize(s).replace(/^(\.\/)+/, "").replace(/\/$/, "");
  if (s === "." || s === "") return ".";
  if (s === ".." || s.startsWith("../")) return null;
  return s;
}
// why a write to rel is refused (code: the builder's own guard; review.check is asked as well), or null
export function writeRefusal(rel, files, never) {
  if (rel == null) return { kind: "outside", reason: "that path is outside the repository" };
  if (TEST.some((rx) => rx.test(rel))) return { kind: "test", reason: `${rel} is a test: tests are read-only to the builder` };
  const n = matches(rel, never);
  if (n) return { kind: "never", reason: `${rel} is on the never-list (${n}): the builder may not change it` };
  if (SECRET(rel)) return { kind: "secret", reason: `${rel} is a secret, data or git's own file` };
  if (!files.includes(rel)) return { kind: "outside-spec", reason: `${rel} is not one of the spec's files (${files.join(", ")}): it is read-only` };
  return null;
}

// review.check (part B) when it exists; until then a stub with the same answer shape, from the paths in the diff
function diffPaths(diff = "") {
  const out = new Set();
  for (const m of String(diff).matchAll(/^(?:\+\+\+|---) (?:[ab]\/)?(.+)$/gm)) if (m[1] !== "/dev/null") out.add(m[1].trim());
  for (const m of String(diff).matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)) { out.add(m[1]); out.add(m[2]); }
  return [...out];
}
export function stubCheck(spec, diff, never = NEVER) {
  const files = (spec?.change?.files || []).map(relPath), reasons = [];
  for (const f of files) { const r = f == null ? { reason: "a spec file is outside the repository" } : writeRefusal(f, files, never); if (r) reasons.push(r.reason); }
  for (const f of diffPaths(diff)) { const r = writeRefusal(relPath(f), files, never); if (r) reasons.push(r.reason); }
  const never_ = reasons.length > 0;
  return { allowed: !never_, needs: never_ ? "never" : spec?.change?.class === "C0" ? "none" : "maintainer", reasons: [...new Set(reasons)], gates: [], stub: true };
}
async function reviewer(opts, never) {
  if (opts.review) return { check: opts.review.check || opts.review, stub: false };
  try {
    const m = await import("./review.js");
    if (typeof m.check === "function") return { check: m.check, stub: false };
  } catch (e) {
    // review.js is there but does not load: fail closed
    if (!(e.code === "ERR_MODULE_NOT_FOUND" && /review\.js/.test(e.message))) return { check: () => ({ allowed: false, needs: "never", reasons: [`review.js did not load: ${String(e.message).slice(0, 160)}`] }), stub: false };
  }
  return { check: (spec, diff) => stubCheck(spec, diff, never), stub: true };
}
const refusedBy = (v) => !v || v.allowed === false || v.needs === "never";

// ---- git and processes ----------------------------------------------------------------------------------------
function run(cmd, args, { cwd, env = process.env, input = "", timeoutMs = 60000, detached = false } = {}) {
  return new Promise((ok) => {
    let out = "", err = "", done = false, timedOut = false;
    let p;
    try { p = spawn(cmd, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached, windowsHide: true }); } catch (e) { return ok({ code: -1, out, err: String(e.message || e) }); }
    const kill = () => { try { detached && process.platform !== "win32" ? process.kill(-p.pid, "SIGKILL") : p.kill("SIGKILL"); } catch { /* gone */ } };
    const t = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    p.stdout.on("data", (d) => { if (out.length < 4e6) out += d; });
    p.stderr.on("data", (d) => { if (err.length < 1e6) err += d; });
    p.on("error", (e) => { if (done) return; done = true; clearTimeout(t); ok({ code: -1, out, err: String(e.message || e) }); });
    p.on("close", (code) => { if (done) return; done = true; clearTimeout(t); ok({ code: timedOut ? -2 : code, out, err, timedOut }); });
    p.stdin.on("error", () => {});
    p.stdin.end(input);
  });
}
const gitEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" });
async function git(cwd, args, { allowFail = false, timeoutMs = 60000 } = {}) {
  const r = await run("git", args, { cwd, env: gitEnv(), timeoutMs });
  if (r.code !== 0 && !allowFail) throw new Error(`git ${args[0]} failed: ${(r.err || r.out).trim().slice(0, 300)}`);
  return r;
}

// the GPU lock: a `flock` process holds /tmp/serve-gpu.lock until its stdin closes (when the build ends, or if this
// process dies), so the lock never outlives the build
export function gpuLock(file = LOCK, waitS = LOCK_WAIT_S) {
  return new Promise((ok, no) => {
    let p;
    try { p = spawn("flock", ["-w", String(waitS), file, "sh", "-c", "echo locked; exec cat >/dev/null"], { stdio: ["pipe", "pipe", "ignore"] }); } catch (e) { return no(new Error(`flock is not available (${e.message}): the builder runs on the GPU server`)); }
    let held = false;
    p.on("error", (e) => no(new Error(`flock is not available (${e.code || e.message}): the builder runs on the GPU server`)));
    p.on("exit", (code) => { if (!held) no(new Error(`the GPU lock ${file} was not free within ${waitS} s (flock exit ${code})`)); });
    p.stdout.on("data", (d) => { if (!held && /locked/.test(String(d))) { held = true; ok({ release: () => new Promise((r) => { if (p.exitCode != null) return r(); p.once("exit", () => r()); p.stdin.end(); }) }); } });
  });
}

// the tests' sandbox: a preload that refuses the network (sockets to anything but a loopback test server, DNS, UDP)
// in the test runner and its children, and child processes and workers inside the tests themselves. Loopback is
// allowed to ephemeral ports only (the servers tests start with listen(0)), never to a service port such as the
// model servers' (11434-11436) or the gateway's.
const PRELOAD = `import net from "node:net"; import dns from "node:dns"; import dgram from "node:dgram"; import cp from "node:child_process"; import wt from "node:worker_threads"; import { syncBuiltinESMExports } from "node:module"; import { EventEmitter } from "node:events"; import { PassThrough } from "node:stream";
const loop = (h) => h == null || h === "" || h === "localhost" || /^127\\./.test(h) || h === "::1" || h === "::ffff:127.0.0.1";
const refuse = (what) => { const e = new Error("no network in the builder's sandbox (" + what + ")"); e.code = "EACCES"; return e; };
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const a = Array.isArray(args[0]) ? args[0] : args, o = a[0];
  let host, port;
  if (o && typeof o === "object") { if (o.path) throw refuse("socket " + o.path); host = o.host; port = +o.port; }
  else if (typeof o === "number" || /^\\d+$/.test(String(o))) { port = +o; host = typeof a[1] === "string" ? a[1] : null; }
  else throw refuse("socket " + o);
  if (!loop(host)) throw refuse("connect " + host);
  if (!(port >= 32768)) throw refuse("connect to local service port " + port);
  return connect.apply(this, args);
};
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) { const o = args[0], h = o && typeof o === "object" ? o.host : typeof args[1] === "string" ? args[1] : null; if (h && !loop(h)) throw refuse("listen on " + h); return listen.apply(this, args); };
for (const api of [dns, dns.promises]) for (const k of Object.keys(api)) if (/^(lookup|lookupService|resolve\\w*|reverse)$/.test(k) && typeof api[k] === "function") {
  const f = api[k]; api[k] = function (h, ...rest) { if (loop(h) && h) return f.call(this, h, ...rest); const e = refuse("dns " + h); if (api === dns.promises) return Promise.reject(e); const cb = rest.find((x) => typeof x === "function"); if (cb) return process.nextTick(cb, e); throw e; };
}
for (const C of [dns.Resolver, dns.promises.Resolver]) for (const k of Object.getOwnPropertyNames(C.prototype)) if (/^(resolve\\w*|reverse)$/.test(k)) C.prototype[k] = function () { throw refuse("dns"); };
dgram.Socket.prototype.send = function () { throw refuse("udp"); };
dgram.Socket.prototype.connect = function () { throw refuse("udp"); };
if (process.env.NODE_TEST_CONTEXT) {
  // a child process from inside a test is refused the way a program that cannot start fails: spawn returns a process
  // that emits "error" (EACCES) and closes, and the sync calls fail, so code that handles a missing program goes on
  const failed = (what) => { const p = new EventEmitter(); p.stdin = new PassThrough(); p.stdout = new PassThrough(); p.stderr = new PassThrough(); p.stdio = [p.stdin, p.stdout, p.stderr];
    p.pid = undefined; p.exitCode = null; p.killed = false; p.kill = () => false; p.ref = p.unref = () => p;
    process.nextTick(() => { p.emit("error", refuse(what)); p.stdout.end(); p.stderr.end(); p.emit("close", -13, null); }); return p; };
  const later = (what, args) => { const cb = args.find((x) => typeof x === "function"), p = failed(what); if (cb) process.nextTick(() => cb(refuse(what), "", "")); return p; };
  cp.spawn = () => failed("child_process.spawn"); cp.fork = () => failed("child_process.fork");
  cp.exec = (...a) => later("child_process.exec", a); cp.execFile = (...a) => later("child_process.execFile", a);
  cp.spawnSync = () => ({ pid: 0, output: [null, null, null], stdout: null, stderr: null, status: null, signal: null, error: refuse("child_process.spawnSync") });
  cp.execSync = () => { throw refuse("child_process.execSync"); }; cp.execFileSync = () => { throw refuse("child_process.execFileSync"); };
  wt.Worker = class { constructor() { throw refuse("worker_threads"); } };
}
syncBuiltinESMExports();
`;
function sandboxEnv(tmp, preload) {
  // a bare environment: no keys, tokens or proxies from the builder's own; the model's URL points nowhere
  const env = { PATH: process.env.PATH || "/usr/bin:/bin", HOME: tmp, TMPDIR: tmp, TMP: tmp, TEMP: tmp, LANG: "C.UTF-8", NO_COLOR: "1",
    NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, LLM_URL: "http://127.0.0.1:9/v1", GUARD_URL: "http://127.0.0.1:9", LEDGER_FILE: path.join(tmp, "ledger.jsonl"), TRACE_FILE: path.join(tmp, "traces.jsonl") };
  if (process.platform === "win32") Object.assign(env, { SystemRoot: process.env.SystemRoot, USERPROFILE: tmp, APPDATA: tmp });
  return env;
}
// node in the sandbox, at low CPU priority, killed (with its children) at the time limit
const nodeIn = (cwd, args, tmp, preload, timeoutMs, env = {}) => {
  const linux = process.platform === "linux";
  return run(linux ? "nice" : process.execPath, linux ? ["-n", "10", process.execPath, ...args] : args, { cwd, env: { ...sandboxEnv(tmp, preload), ...env }, timeoutMs, detached: process.platform !== "win32" });
};
// the same sandbox for others that run code from a loop branch (the bench's oracles; the gates can use it too)
export async function sandboxed(cwd, args, { timeoutMs = CAPS.unitTimeoutMs, env = {} } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "serve-sandbox-")), preload = path.join(tmp, "sandbox.mjs");
  fs.writeFileSync(preload, PRELOAD);
  try { return await nodeIn(cwd, args, tmp, preload, timeoutMs, env); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
// the unit tests in the worktree's agent/
async function runTests(ctx, args = ["--test", "--test-reporter=tap", "test/unit.mjs"]) {
  const t0 = Date.now(), r = await nodeIn(path.join(ctx.wt, "agent"), args, ctx.tmp, ctx.preload, ctx.caps.unitTimeoutMs);
  const out = r.out + (r.err ? `\n${r.err}` : ""), n = (k) => +((new RegExp(`^# ${k} (\\d+)`, "m").exec(out) || [])[1] || 0);
  const failures = [];
  const lines = out.split("\n");
  lines.forEach((l, i) => {
    const m = /^\s*not ok \d+ - (.+)$/.exec(l);
    if (!m || /^test\/unit\.mjs$/.test(m[1]) && failures.length) return;
    const block = [];
    for (let j = i + 1; j < lines.length && j < i + 60 && !/^\s*(not )?ok \d+ /.test(lines[j]) && !/^\s*\.\.\.\s*$/.test(lines[j]); j++) if (/error:|expected:|actual:|code:|^\s{4,}\S/.test(lines[j]) && !/duration_ms|location:|stack:|at .*\(|node:internal/.test(lines[j])) block.push(lines[j].trim());
    failures.push({ test: m[1].slice(0, 160), why: block.slice(0, 8).join(" ").slice(0, 500) });
  });
  const pass = n("pass"), fail = n("fail");
  const ok = r.code === 0 && fail === 0 && pass > 0;
  return { ok, pass, fail, timedOut: !!r.timedOut, code: r.code, seconds: +((Date.now() - t0) / 1000).toFixed(1), failures: failures.slice(0, 6), tail: ok ? "" : out.slice(-1200) };
}
const unitText = (u) => u.ok ? `unit tests: ${u.pass} pass, 0 fail (${u.seconds} s)`
  : u.timedOut ? `unit tests stopped at the time limit (${Math.round(u.seconds)} s)`
  : `unit tests: ${u.pass} pass, ${u.fail} fail\n${u.failures.map((f) => `not ok - ${f.test}${f.why ? `: ${f.why}` : ""}`).join("\n") || u.tail.slice(-900)}`;

// ---- the worktree ---------------------------------------------------------------------------------------------
async function worktree(repo, dir, id, { replace = false } = {}) {
  const wt = path.join(dir, id), branch = `loop/${id}`;
  const base = (await git(repo, ["rev-parse", "HEAD"])).out.trim();
  const exists = (await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { allowFail: true })).code === 0;
  if (exists || fs.existsSync(wt)) {
    if (!replace) throw Object.assign(new Error(`${branch} or ${wt} already exists: a maintainer removes it first`), { refusal: true });
    await git(repo, ["worktree", "remove", "--force", wt], { allowFail: true });
    if (fs.existsSync(wt) && path.dirname(wt) === dir) fs.rmSync(wt, { recursive: true, force: true });
    await git(repo, ["worktree", "prune"], { allowFail: true });
    if (exists) await git(repo, ["branch", "-D", branch]);
  }
  fs.mkdirSync(dir, { recursive: true });
  await git(repo, ["worktree", "add", "--quiet", wt, "-b", branch, base]);
  // installed packages, linked (the tests need them; reading through the link is refused, it leaves the worktree)
  const nm = path.join(repo, "agent", "node_modules");
  if (fs.existsSync(nm) && fs.existsSync(path.join(wt, "agent")) && !fs.existsSync(path.join(wt, "agent", "node_modules"))) fs.symlinkSync(fs.realpathSync(nm), path.join(wt, "agent", "node_modules"), process.platform === "win32" ? "junction" : "dir");
  return { wt, branch, base };
}
// back to the base: tracked files reset, everything untracked or ignored removed (but the packages' link)
async function clean(wt, base) {
  await git(wt, ["reset", "--hard", "--quiet", base]);
  await git(wt, ["clean", "-fdxq", "-e", "node_modules"]);
  const left = (await git(wt, ["status", "--porcelain", "--ignored", "--untracked-files=all"])).out.split("\n").filter(Boolean).filter((l) => !/(^|\/)node_modules\/?$/.test(l.slice(3)));
  if (left.length) throw new Error(`the worktree is not clean: ${left.slice(0, 3).join(", ")}`);
  for (const p of ["data", "agent/data", ".env", "agent/.env"]) if (fs.existsSync(path.join(wt, p))) throw new Error(`the worktree has ${p}`);
}
async function changed(wt) {
  const r = await git(wt, ["status", "--porcelain", "--untracked-files=all"]);
  return r.out.split("\n").filter(Boolean).map((l) => l.slice(3).replace(/^.* -> /, "").replace(/^"|"$/g, "")).filter((f) => !/(^|\/)node_modules$/.test(f));
}
// the change so far, as a unified diff against the base (a file the spec creates is in it too)
async function diffOf(wt, files) {
  const st = (await git(wt, ["status", "--porcelain", "--untracked-files=all"])).out.split("\n");
  for (const f of st.filter((l) => l.startsWith("?? ")).map((l) => l.slice(3)).filter((f) => files.includes(f))) await git(wt, ["add", "--intent-to-add", "--", f], { allowFail: true });
  return (await git(wt, ["diff", "--no-color", "--no-ext-diff", "HEAD"])).out;
}

// ---- the tools ------------------------------------------------------------------------------------------------
const tool = (name, description, properties = {}, required = []) => ({ type: "function", function: { name, description, parameters: { type: "object", properties, required } } });
export const TOOLS = [
  tool("list_files", "The files and folders in one folder of the repository, with each file's number of lines. Paths are from the repository root.", { dir: { type: "string", description: 'a folder from the repository root, such as agent/src; "." for the root' } }, ["dir"]),
  tool("read_file", "Lines of a file, each with its line number and a tab in front (the numbers are not part of the file). Up to 160 lines a call.", { path: { type: "string", description: "from the repository root, such as agent/src/ask.js" }, from: { type: "integer", description: "first line, counting from 1" }, to: { type: "integer", description: "last line" } }, ["path"]),
  tool("search", "Lines that match a regular expression (JavaScript syntax), in the repository's files, as path:line: text. Up to 40.", { pattern: { type: "string" }, dir: { type: "string", description: "optional: a folder to search in" } }, ["pattern"]),
  tool("write_patch", "Replace text in one of the spec's files. old is copied exactly from the file (without the line numbers read_file shows) and occurs exactly once; new replaces it. To create a file the spec lists, give old as an empty string.", { path: { type: "string" }, old: { type: "string" }, new: { type: "string" } }, ["path", "old", "new"]),
  tool("plan", "Before your first write_patch: one step for each file the spec names, saying where in that file (a function, and its lines) and what changes there. Every sentence of the spec must be covered by a step. Code checks that every file the spec names is in it.",
    { steps: { type: "array", items: { type: "object", properties: { file: { type: "string" }, where: { type: "string", description: "the function and its lines, such as search(), lines 175-226" }, change: { type: "string", description: "what changes there, and which part of the spec it does" } }, required: ["file", "where", "change"] } } }, ["steps"]),
  tool("run_unit", "Run the repository's unit tests (node --test test/unit.mjs in agent/). Returns how many pass and fail, and why each failure failed."),
  tool("done", "Finish: the change is made and the unit tests pass. One sentence on what you changed. Code then shows you your diff with the spec's requirements, and you call done again with checks: for each requirement, whether your change meets it and where.",
    { summary: { type: "string" }, checks: { type: "array", description: "the second time: one per requirement (R1, R2, ...)", items: { type: "object", properties: { id: { type: "string" }, met: { type: "boolean" }, where: { type: "string", description: "the file and line of your diff that does it" } }, required: ["id", "met", "where"] } } }, ["summary"]),
  tool("cannot", "Stop the build because the spec cannot be done as written: it contradicts a unit test (tests are read-only), or it needs a change to a file it does not list. Only after you have read every file the spec names. Never because a change is hard or long: then keep working.", { reason: { type: "string", description: "which test or which file, and why the spec cannot be met without changing it" } }, ["reason"]),
];

// the prompt and the tools for a build's caps: with the plan or the review off, they are not mentioned at all
const sysFor = (caps) => [`You are Serve's builder, a careful coding agent. You make one small change to a Node.js repository (ES modules), as the spec in the first message says, and nothing more.`,
  "Work only through the tools, one step at a time:",
  "Find the code: read_file the spec's files around the lines that matter (the outline gives line numbers), or search for a name. Read before you write.",
  caps.plan !== false && "plan: one step for each file the spec names, with where in it and what changes. Check that each sentence of the spec, and each thing it says must or must not happen, is in a step.",
  `Change it with write_patch. "old" is text copied exactly from the file, without the line numbers read_file adds, and long enough to occur only once (a whole line or a few lines); "new" replaces it. Keep the style of the code around it.`,
  "run_unit. If a test fails because of your change, fix your change: the tests are read-only.",
  caps.review !== false ? "done, with one sentence on what you changed. Code shows you your diff beside the spec's numbered requirements: read each one word for word against the diff, fix what is not met, then call done again with checks (met and where, for every requirement)." : "done, with one sentence on what you changed.",
].filter(Boolean).map((l, i) => (i < 2 ? l : `${i - 1}. ${l}`)).join("\n") + `
Rules: change only the spec's files, and only what the spec asks. Keep everything else as it is: a new parameter is optional, and its default keeps today's behaviour. No new imports or dependencies, no network, no console output. If a write is refused, read the reason and do something else.
If the spec cannot be done as written, because a unit test says the opposite or the change needs a file the spec does not list, call cannot with the reason, after reading every file the spec names. A change that is only hard is not a reason to stop.`;
const toolsFor = (caps) => TOOLS.filter((t) => caps.plan !== false || t.function.name !== "plan").map((t) => (caps.review === false && t.function.name === "done" ? tool("done", "Finish: the change is made and the unit tests pass. One sentence on what you changed.", { summary: { type: "string" } }, ["summary"]) : t));

// the files' outline, made by code: where each definition starts
function outline(wt, rel) {
  const abs = path.join(wt, ...rel.split("/"));
  if (!fs.existsSync(abs)) return `${rel}: does not exist yet (create it with write_patch, old "")`;
  const lines = fs.readFileSync(abs, "utf8").split("\n"), out = [];
  lines.forEach((l, i) => {
    const def = /^(export\s+)?(default\s+)?(async\s+)?function\s*\*?\s*[\w$]+\s*\(/.test(l) || /^(export\s+)?(const|let|var|class)\s+[\w$]+/.test(l) && !/^(export\s+)?(const|let|var)\s+[\w$]+\s*=\s*(await\s+)?import\b/.test(l)
      || /^\s{2,6}(async\s+)?(?!if\b|for\b|while\b|switch\b|catch\b|return\b|function\b)[\w$]+\s*\([^)]*\)\s*\{\s*$/.test(l) || /^\s{2,6}(async\s+)?(?!if\b|for\b|while\b|switch\b|catch\b)[\w$]+\s*\(\{[^}]*\}[^)]*\)\s*\{/.test(l)
      || /^\s*(\{\s*name:|tool\()\s*"[\w$]+"/.test(l);
    if (def) out.push(`${i + 1}: ${l.trim().slice(0, 100)}`);
  });
  return `${rel} (${lines.length} lines)\n${out.slice(0, 60).join("\n")}${out.length > 60 ? `\n(${out.length - 60} more)` : ""}`;
}
const clip = (s, n) => (String(s ?? "").length > n ? String(s).slice(0, n) + `…[${String(s).length - n} more chars]` : String(s ?? ""));
const firstLines = (s, n) => String(s ?? "").split("\n").slice(0, n).join("\n");

// a path the model gave, resolved inside the worktree (a missing "agent/" in front is added when that is the file)
function resolve(ctx, p, { write = false } = {}) {
  let rel = relPath(p);
  if (rel == null) return { error: "that path is outside the repository: give a path from the repository root, such as agent/src/ask.js", kind: "outside" };
  const abs0 = (r) => path.join(ctx.wt, ...r.split("/"));
  if (rel !== "." && !fs.existsSync(abs0(rel)) && !rel.startsWith("agent/") && (fs.existsSync(abs0(`agent/${rel}`)) || (write && ctx.files.includes(`agent/${rel}`)))) rel = `agent/${rel}`;
  const abs = abs0(rel);
  // through a link, or into one: refused when its real place (or its nearest folder that exists) is outside the worktree
  let probe = abs, real = null;
  while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
  try { real = fs.realpathSync(probe); } catch { /* refused below */ }
  if (!real || !(real === ctx.realWt || real.startsWith(ctx.realWt + path.sep))) return { error: `${rel} leads outside the worktree`, kind: "outside", rel };
  if (rel !== "." && SECRET(rel)) return { error: `${rel} is not readable to the builder (secrets, data, git's own files and installed packages)`, kind: "secret", rel };
  return { rel, abs };
}
const walk = (ctx, dir, each) => {
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(d, e.name), rel = path.relative(ctx.wt, abs).split(path.sep).join("/");
      if (e.isSymbolicLink() || SECRET(rel)) continue;
      if (e.isDirectory()) stack.push(abs); else if (e.isFile() && each(abs, rel) === false) return;
    }
  }
};
const textOf = (abs) => { const st = fs.statSync(abs); if (st.size > 600000) return null; const b = fs.readFileSync(abs); return b.includes(0) ? null : b.toString("utf8"); };

const tools = {
  list_files(ctx, { dir = "." }) {
    const r = resolve(ctx, dir);
    if (r.error) return { error: r.error, kind: r.kind };
    if (!fs.existsSync(r.abs) || !fs.statSync(r.abs).isDirectory()) return { error: `${r.rel} is not a folder` };
    const rows = [];
    for (const e of fs.readdirSync(r.abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = r.rel === "." ? e.name : `${r.rel}/${e.name}`;
      if (SECRET(rel) || e.isSymbolicLink()) continue;
      if (e.isDirectory()) rows.push(`${rel}/`);
      else { const t = textOf(path.join(r.abs, e.name)); rows.push(t == null ? `${rel} (binary or large)` : `${rel} (${t.split("\n").length} lines)`); }
      if (rows.length >= LIST_MAX) { rows.push("(more not shown)"); break; }
    }
    return { text: rows.join("\n") || "(empty)" };
  },
  read_file(ctx, { path: p, from, to }) {
    const r = resolve(ctx, p);
    if (r.error) return { error: r.error, kind: r.kind };
    if (!fs.existsSync(r.abs)) return { error: `${r.rel} does not exist${ctx.files.includes(r.rel) ? " (it is a spec file you may create with write_patch, old \"\")" : ""}` };
    if (fs.statSync(r.abs).isDirectory()) return { error: `${r.rel} is a folder: use list_files` };
    const t = textOf(r.abs);
    if (t == null) return { error: `${r.rel} is binary or too large to read` };
    const lines = t.split("\n"), a = Math.min(Math.max(1, Math.floor(+from || 1)), lines.length), b = Math.min(lines.length, Math.max(a, Math.floor(+to || a + 119)), a + 159);
    let out = "", last = a - 1;
    for (let i = a; i <= b; i++) { const l = `${i}\t${clip(lines[i - 1], LINE_CHARS)}\n`; if (out.length + l.length > READ_CHARS && i > a) break; out += l; last = i; }
    ctx.read.add(r.rel);
    return { text: `${r.rel}, lines ${a}-${last} of ${lines.length}:\n${out}${last < lines.length ? `(read from line ${last + 1} for more)` : "(end of file)"}`, rel: r.rel, lines: [a, last] };
  },
  search(ctx, { pattern, dir = "." }) {
    const src = String(pattern || "").slice(0, 200);
    if (!src) return { error: "give a pattern" };
    let rx; try { rx = new RegExp(src); } catch { rx = new RegExp(src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")); }
    const r = resolve(ctx, dir);
    if (r.error) return { error: r.error, kind: r.kind };
    const hits = [];
    walk(ctx, r.abs, (abs, rel) => {
      const t = textOf(abs); if (t == null) return;
      t.split("\n").forEach((l, i) => { if (hits.length < SEARCH_HITS && l.length < 20000 && rx.test(l)) hits.push(`${rel}:${i + 1}: ${clip(l.trim(), 200)}`); });
      return hits.length < SEARCH_HITS;
    });
    return { text: hits.length ? hits.join("\n") + (hits.length >= SEARCH_HITS ? "\n(more not shown: narrow the pattern or the folder)" : "") : `nothing matches ${src}` };
  },
  async write_patch(ctx, { path: p, old = "", new: nu = "" }) {
    const r = resolve(ctx, p, { write: true });
    const no = writeRefusal(r.rel ?? null, ctx.files, ctx.never) || (r.error ? { kind: r.kind, reason: r.error } : null);
    if (no) return { error: `refused: ${no.reason}`, refused: no.kind, rel: r.rel };
    if (ctx.caps.plan !== false && !ctx.plan) return { error: "plan first: call plan with one step for each file the spec names (where, and what changes there), then write_patch.", planFirst: true, rel: r.rel };
    const exists = fs.existsSync(r.abs), before = exists ? fs.readFileSync(r.abs, "utf8") : null;
    old = String(old); nu = String(nu);
    let next = null, note = "";
    if (!exists) {
      if (old !== "") return { error: `${r.rel} does not exist yet: to create it, give old as an empty string` };
      next = nu;
    } else {
      if (old === "") return { error: `${r.rel} exists: give the text to replace as old` };
      const found = locate(before, old, nu);
      if (found.error) return { error: found.error };
      ({ next, note } = found);
    }
    if (next === before) return { error: "new is the same as old: nothing changed" };
    fs.mkdirSync(path.dirname(r.abs), { recursive: true });
    fs.writeFileSync(r.abs, next);
    // review.check on the whole change so far; refused, the write is undone
    const diff = await diffOf(ctx.wt, ctx.files);
    let v;
    try { v = await ctx.review.check(ctx.spec, diff); } catch (e) { v = { allowed: false, needs: "never", reasons: [`review.check failed: ${String(e.message || e).slice(0, 160)}`] }; }
    if (refusedBy(v)) {
      if (before == null) { fs.rmSync(r.abs, { force: true }); await git(ctx.wt, ["rm", "--cached", "--quiet", "--force", "--", r.rel], { allowFail: true }); } else fs.writeFileSync(r.abs, before);
      return { error: `refused by review: ${(v?.reasons || []).join("; ").slice(0, 400) || "no reason given"}`, refused: "review", rel: r.rel };
    }
    ctx.writes++;
    const at = before == null ? 1 : before.slice(0, Math.max(0, firstDiff(before, next))).split("\n").length;
    const nl = next.split("\n"), from = Math.max(1, at - 2), to = Math.min(nl.length, at + nu.split("\n").length + 1);
    const syntax = /\.(m?js|cjs)$/.test(r.rel) ? checkSyntax(r.abs) : null;
    return { text: `${before == null ? "Created" : "Changed"} ${r.rel}${note}. Lines ${from}-${to} now:\n${nl.slice(from - 1, to).map((l, i) => `${from + i}\t${clip(l, 300)}`).join("\n")}${syntax ? `\nSyntax check: ${syntax}` : ""}`, rel: r.rel };
  },
  // the plan before the first patch: code checks it names every file of the spec, and only those, and keeps it in view
  plan(ctx, { steps = [] }) {
    const rows = (Array.isArray(steps) ? steps : []).map((s) => {
      let f = relPath(s?.file);
      if (f && !ctx.files.includes(f) && ctx.files.includes(`agent/${f}`)) f = `agent/${f}`;
      return { file: f, given: String(s?.file ?? ""), where: String(s?.where ?? "").trim(), change: String(s?.change ?? "").trim() };
    });
    const missing = ctx.files.filter((f) => !rows.some((r) => r.file === f)), other = rows.filter((r) => !ctx.files.includes(r.file)).map((r) => clip(r.given, 80));
    const thin = rows.filter((r) => ctx.files.includes(r.file) && (r.where.length < 3 || r.change.length < 15)).map((r) => r.file);
    const errs = [missing.length && `it leaves out ${missing.join(", ")}: every file the spec names needs a step (its change may be "no change" if it truly needs none)`,
      other.length && `${other.join(", ")} ${other.length > 1 ? "are" : "is"} not among the spec's files: only those may change`, thin.length && `say where (a function and its lines) and what changes, for ${[...new Set(thin)].join(", ")}`].filter(Boolean);
    if (errs.length) return { error: `plan not accepted: ${errs.join("; ")}.` };
    ctx.plan = rows.map(({ given, ...r }) => r);
    return { text: `Plan accepted. Your checklist (it stays in view):\n${ctx.plan.map((r, i) => `${i + 1}. ${r.file}, ${clip(r.where, 120)}: ${clip(r.change, 400)}`).join("\n")}\nNow make these changes with write_patch.` };
  },
  async run_unit(ctx) {
    const u = await runTests(ctx);
    ctx.unit = { ...u, writes: ctx.writes };
    return { text: unitText(u), unit: u };
  },
  // the model's judgement that the spec cannot be done as written: taken only after it has read every file the spec
  // names (that exists), with a reason; it ends the build, with no further attempt
  cannot(ctx, { reason = "" }) {
    const unread = ctx.files.filter((f) => fs.existsSync(path.join(ctx.wt, ...f.split("/"))) && !ctx.read.has(f));
    if (unread.length) return { error: `not accepted: read ${unread.join(", ")} first. cannot is taken only after every file the spec names has been read.`, cannotRefused: true };
    const why = String(reason).replace(/\s+/g, " ").trim();
    if (why.length < 20) return { error: "not accepted: say which test or which file stops the spec, and why.", cannotRefused: true };
    ctx.cannot = why.slice(0, 500);
    return { text: "accepted: the build stops here; a maintainer reads your reason." };
  },
  async done(ctx, { summary = "", checks = null }) {
    const now = await changed(ctx.wt), mine = now.filter((f) => ctx.files.includes(f)), other = now.filter((f) => !ctx.files.includes(f));
    // files a test run left behind are not part of the change: put back (tracked) or removed (untracked)
    for (const f of other) { await git(ctx.wt, ["checkout", "--quiet", "HEAD", "--", f], { allowFail: true }); await git(ctx.wt, ["clean", "-fdq", "--", f], { allowFail: true }); }
    if (!mine.length) return { error: "not done: nothing is changed yet. Make the change with write_patch first." };
    const untouched = [...new Set((ctx.plan || []).filter((r) => !/^\s*no change/i.test(r.change) && !mine.includes(r.file)).map((r) => r.file))];
    if (untouched.length) return { error: `not done: your plan changes ${untouched.join(" and ")}, which ${untouched.length > 1 ? "are" : "is"} unchanged. Make that change, or call plan again if it needs none.` };
    if (!ctx.unit || ctx.unit.writes !== ctx.writes) { const u = await runTests(ctx); ctx.unit = { ...u, writes: ctx.writes }; }
    if (!ctx.unit.ok) return { error: `not done: the unit tests do not pass.\n${unitText(ctx.unit)}` };
    const diff = await diffOf(ctx.wt, ctx.files);
    let v;
    try { v = await ctx.review.check(ctx.spec, diff); } catch (e) { v = { allowed: false, needs: "never", reasons: [`review.check failed: ${String(e.message || e).slice(0, 160)}`] }; }
    if (refusedBy(v)) return { error: `not done: review refuses the change: ${(v?.reasons || []).join("; ").slice(0, 400)}`, refused: "review" };
    // the change against the spec, requirement by requirement: the first done shows the diff beside them; the next one
    // has to say, for each, that it is met and where (one not met is fixed first)
    const reqs = ctx.reqs || [];
    if (ctx.caps.review !== false && reqs.length) {
      const given = Array.isArray(checks) ? checks : [];
      const of = (id) => given.find((c) => String(c?.id || "").trim().toUpperCase() === id);
      if (!ctx.reviewShown || ctx.reviewAt !== ctx.writes || !given.length) {
        ctx.reviewShown = true; ctx.reviewAt = ctx.writes; ctx.reviews = (ctx.reviews || 0) + 1;
        return { text: `Not yet: check your change against the spec first.\nYour diff:\n${clip(diff, 3500)}\nThe spec's requirements:\n${reqs.map((r) => `${r.id}: ${r.text}`).join("\n")}\nRead each requirement word for word against the diff and the code around it. Then call done again with checks: for each of ${reqs.map((r) => r.id).join(", ")}, met (true or false) and where (the file and line of your diff that does it). If one is not met, fix the change first.`, review: true };
      }
      const missing = reqs.filter((r) => !of(r.id) || !String(of(r.id).where || "").trim()).map((r) => r.id), unmet = reqs.filter((r) => of(r.id)?.met === false).map((r) => r.id);
      if (missing.length) return { error: `not done: checks needs ${missing.join(", ")}, each with met and where.` };
      if (unmet.length) return { error: `not done: you say ${unmet.join(", ")} ${unmet.length > 1 ? "are" : "is"} not met. Fix the change so ${unmet.length > 1 ? "they are" : "it is"}, run_unit, and call done again.` };
    }
    ctx.finished = { summary: String(summary).slice(0, 400), diff, review: v, checks: Array.isArray(checks) ? checks.slice(0, 20) : null };
    return { text: "accepted" };
  },
};
// where old is in the text: exactly, else without line numbers copied from read_file, else ignoring indentation
function locate(text, old, nu) {
  const count = (s) => (s ? text.split(s).length - 1 : 0);
  const swap = (o, n) => { const i = text.indexOf(o); return text.slice(0, i) + n + text.slice(i + o.length); };
  let k = count(old);
  if (k === 1) return { next: swap(old, nu), note: "" };
  if (k > 1) return { error: `old occurs ${k} times in the file: give a few more lines around it so it occurs once` };
  const unnum = (s) => s.split("\n").map((l) => l.replace(/^\s*\d+(\t|: |\| )/, "")).join("\n");
  if (/^\s*\d+(\t|: |\| )/.test(old) && count(unnum(old)) === 1) return { next: swap(unnum(old), unnum(nu)), note: " (the line numbers you copied were left out)" };
  // ignoring indentation and trailing spaces: one block only, and new is indented as the file is there
  const tl = text.split("\n"), ol = old.replace(/\n$/, "").split("\n"), norm = (l) => l.trim();
  const hits = [];
  for (let i = 0; i + ol.length <= tl.length && hits.length < 2; i++) if (ol.every((l, j) => norm(l) === norm(tl[i + j]))) hits.push(i);
  if (hits.length === 1 && ol.some((l) => l.trim())) {
    const i = hits[0], lead = (s) => /^\s*/.exec(s)[0], j0 = ol.findIndex((l) => l.trim());
    const want = lead(tl[i + j0]), had = lead(ol[j0]);
    const re = nu.replace(/\n$/, "").split("\n").map((l) => (l.startsWith(had) ? want + l.slice(had.length) : l));
    return { next: [...tl.slice(0, i), ...re, ...tl.slice(i + ol.length)].join("\n"), note: " (matched ignoring indentation)" };
  }
  // a hint: where its first line is, if it is anywhere
  const first = ol.find((l) => l.trim().length > 3)?.trim() || "";
  const near = first ? tl.findIndex((l) => l.includes(first.slice(0, 40))) : -1;
  return { error: `old was not found in the file.${near >= 0 ? ` Its first line looks like line ${near + 1}: ${clip(tl[near].trim(), 160)}. read_file around it and copy the text exactly.` : " read_file the lines you want to change and copy them exactly."}` };
}
const firstDiff = (a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return i; };
function checkSyntax(abs) {
  const r = spawnSync(process.execPath, ["--check", abs], { encoding: "utf8", timeout: 15000, env: { PATH: process.env.PATH || "", ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}) } });
  if (r.status === 0) return "ok";
  const msg = String(r.stderr || "").split("\n").filter((l) => l.trim() && !/^\s+at |^Node\.js v|^node:internal/.test(l)).slice(0, 5).join(" | ");
  return `error: ${clip(msg.replace(abs, path.basename(abs)), 400)}`;
}

// ---- one attempt ------------------------------------------------------------------------------------------------
// the spec's requirements, numbered by code: its sentences, and a sentence's parts after a colon or a semicolon that
// open a clause of their own ("search() takes indoorOnly: when it is true, only ..."), at most 12
export function requirements(summary) {
  const out = [];
  for (const s of String(summary || "").split(/(?<=[.!?])\s+(?=[A-Z"(])/).map((x) => x.trim()).filter(Boolean))
    for (const part of s.split(/(?<=[^\s:]):\s+(?=[a-z])|;\s+/).map((x) => x.trim()).filter((x) => x.length >= 8)) out.push(part);
  return out.slice(0, 12).map((text, i) => ({ id: `R${i + 1}`, text: clip(text, 300) }));
}
// the summary file by file, split by code: each sentence goes to the files it names, or, naming none, to the files the
// sentence before it named (to every file, before any is named). Only for a spec with more than one file.
export function byFile(summary, files) {
  if (files.length < 2) return null;
  const out = new Map(files.map((f) => [f, []]));
  let last = files;
  for (const s of String(summary || "").split(/(?<=[.!?])\s+(?=[A-Z"(])/).map((x) => x.trim()).filter(Boolean)) {
    const named = files.filter((f) => s.includes(f) || new RegExp(`(^|[^\\w/.-])${path.posix.basename(f).replace(/\./g, "\\.")}\\b`).test(s));
    if (named.length) last = named;
    for (const f of named.length ? named : last) out.get(f).push(s);
  }
  return out;
}
// what the model reads: the spec's change, files and oracle, and the maintainer's note when there is one (never the
// spec's problem, title or votes), and the outline
function brief(spec, files, wt, notes, reqs = [], planOn = true) {
  const c = spec.change, o = spec.oracle || {};
  const safe = (s, n) => String(s ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").slice(0, n);
  const split = planOn ? byFile(safe(c.summary, 1200), files) : null, note = typeof spec.build?.note === "string" && spec.build.note.trim() ? safe(spec.build.note.trim(), 400) : null;
  return [`Spec ${spec.id}, class ${c.class}.`, `The change: ${safe(c.summary, 1200)}`, `Files you may change: ${files.join(", ")}`,
    ...(split ? ["The change, file by file (split from the summary by code; your plan needs a step for each file):", ...files.map((f) => `- ${f}: ${split.get(f).join(" ") || "(no sentence names it)"}`)] : []),
    ...(reqs.length ? ["The spec's requirements (numbered by code; before done is accepted you check each against your diff):", ...reqs.map((r) => `${r.id}: ${r.text}`)] : []),
    note ? `The maintainer's note on approving it: ${note}` : "",
    o.how ? `How it will be checked${o.kind ? ` (${safe(o.kind, 20)})` : ""}: ${safe(o.how, 800)}` : "",
    "Everything else, the tests included, is read-only. Paths are from the repository root; run_unit runs the unit tests in agent/.",
    "", "Outline of the files (line: where a definition starts):", ...files.map((f) => outline(wt, f)),
    ...(notes.length ? ["", "Earlier attempts (each was undone; this attempt starts from the original files):", ...notes] : [])].filter((x) => x !== "").join("\n");
}
const estimate = (msgs) => Math.round(msgs.reduce((a, m) => a + String(m.content || "").length + JSON.stringify(m.tool_calls || "").length, 0) / 3) + 900;
// keep the conversation inside the model's context: first the reads a later read of the same lines made redundant
// shrink to one line each, then the oldest reads, then old patches' text (a file that was written since is read anew)
export function compact(msgs, limit) {
  if (estimate(msgs) <= limit) return 0;
  let n = 0;
  const reads = msgs.map((m, i) => [m, i]).filter(([m]) => m.role === "tool" && ["read_file", "search", "list_files"].includes(m.tool_name) && !m.shrunk);
  const covers = (x, y) => x.range && y.range && x.range.rel === y.range.rel && x.range.a <= y.range.a && x.range.b >= y.range.b;
  for (const [m, i] of reads) {
    if (estimate(msgs) <= limit) break;
    const later = reads.some(([x, j]) => j > i && covers(x, m)), stale = m.range && msgs.some((x, j) => j > i && x.wrote === m.range.rel);
    if (later || stale) { m.content = `[read_file ${m.what} removed: ${later ? "a later read shows the same lines" : "the file was changed since; read it again if you need it"}]`; m.shrunk = true; n++; }
  }
  for (const [m] of reads.filter(([m]) => !m.shrunk).slice(0, -2)) {
    if (estimate(msgs) <= limit) break;
    m.content = `[${m.tool_name} result removed to save room${m.what ? `: ${m.what}` : ""}; call it again if you need it]`; m.shrunk = true; n++;
  }
  for (const m of msgs) {
    if (estimate(msgs) <= limit) break;
    if (m.role !== "assistant" || !m.tool_calls || m.shrunk || m === msgs.at(-1)) continue;
    m.tool_calls = m.tool_calls.map((c) => c.function?.name === "write_patch" ? { ...c, function: { ...c.function, arguments: { path: c.function.arguments?.path, old: "[shown earlier]", new: "[shown earlier]" } } } : c); m.shrunk = true; n++;
  }
  return n;
}
const brief1 = (name, a = {}) => name === "write_patch" ? { path: a.path, old: clip(a.old, 120), new: clip(a.new, 120), oldChars: String(a.old ?? "").length, newChars: String(a.new ?? "").length }
  : name === "done" ? { summary: clip(a.summary, 200), ...(Array.isArray(a.checks) ? { checks: a.checks.slice(0, 12).map((c) => `${c?.id}:${c?.met ? "met" : "NOT met"}: ${clip(c?.where, 80)}`) } : {}) } : Object.fromEntries(Object.entries(a || {}).map(([k, v]) => [k, typeof v === "string" ? clip(v, 160) : v]));

async function attempt(ctx, k, notes) {
  const t0 = Date.now(), caps = ctx.caps;
  await clean(ctx.wt, ctx.base);
  Object.assign(ctx, { writes: 0, unit: null, finished: null, cannot: null, plan: null, read: new Set(), reviewShown: false, reviewAt: -1, reviews: 0,
    reqs: caps.review !== false ? requirements(String(ctx.spec.change.summary || "").slice(0, 1200)) : [] });
  const toolList = toolsFor(caps), offered = new Set(toolList.map((t) => t.function.name));
  const msgs = [{ role: "system", content: sysFor(caps) }, { role: "user", content: brief(ctx.spec, ctx.files, ctx.wt, notes, ctx.reqs, caps.plan !== false) }];
  const limit = caps.context - caps.maxTokens - caps.reasoning - 1200;
  const a = { n: k, ok: false, end: null, steps: 0, toolCalls: 0, refused: [], compactions: 0, modelErrors: 0, planFirst: 0, cannotRefused: 0, plan: null, cannot: null };
  return job(`builder-attempt-${k}`, async (j) => {
    let stalls = 0, errors = 0;
    const spent = () => { const t = totals(j.calls); return t.prompt + t.output; };
    for (let step = 1; step <= caps.steps && !ctx.finished && !ctx.cannot; step++) {
      if (spent() >= caps.tokensPerAttempt) { a.end = "tokens"; break; }
      if (ctx.spentBefore + spent() >= caps.tokens) { a.end = "build-tokens"; break; }
      a.compactions += compact(msgs, limit);
      a.steps = step;
      let out;
      try { out = await ctx.chatTools(msgs.map(({ what, shrunk, range, wrote, ...m }) => m), toolList, { maxTokens: caps.maxTokens, temperature: 0.2, think: "low", budget: caps.reasoning, site: "builder.step" }); errors = 0; }
      // the model server did not answer: wait and ask again (not a step); still down, the build stops (no new attempt)
      catch (e) {
        a.modelErrors++; a.lastError = clip(`${e.message || e}${e.cause?.code ? ` (${e.cause.code})` : ""}`, 200);
        ctx.log.push({ attempt: k, step, tool: null, error: a.lastError });
        if (++errors >= caps.modelErrors) { a.end = "model-error"; break; }
        await new Promise((ok) => setTimeout(ok, caps.retryMs * 2 ** (errors - 1)));
        step--; continue;
      }
      if (!out.calls?.length) {
        if (++stalls >= 3) { a.end = "stalled"; break; }
        if (out.message && (out.message.content || "").trim()) msgs.push({ role: "assistant", content: clip(out.message.content, 1500) });
        msgs.push({ role: "user", content: "Call one of the tools. When the change is made and run_unit passes, call done." });
        continue;
      }
      stalls = 0;
      msgs.push(out.message || { role: "assistant", content: out.text || "", tool_calls: out.calls.map((c) => ({ function: { name: c.name, arguments: c.args } })) });
      for (const [i, c] of out.calls.entries()) {
        let res;
        const t1 = Date.now();
        if (i >= caps.callsPerStep) res = { error: `only ${caps.callsPerStep} tool calls run in one turn: call it again` };
        else if (!tools[c.name] || !offered.has(c.name)) res = { error: `there is no tool called ${c.name}: the tools are ${[...offered].join(", ")}` };
        else {
          // integers given as text are taken; anything else that does not fit the tool's parameters is refused
          const args = { ...(c.args || {}) };
          for (const f of ["from", "to"]) if (typeof args[f] === "string" && /^\d+$/.test(args[f].trim())) args[f] = +args[f];
          const errs = (c.errors || []).filter((e) => !/^\$\.(from|to): expected integer/.test(e) || !Number.isInteger(args[/^\$\.(\w+)/.exec(e)[1]]));
          if (errs.length) res = { error: `the arguments do not fit ${c.name}: ${errs.slice(0, 3).join("; ")}. Call it again with arguments that fit.` };
          else { try { res = await tools[c.name](ctx, args); } catch (e) { res = { error: `${c.name} failed: ${clip(e.message || e, 300)}` }; } }
        }
        a.toolCalls++;
        if (res.refused) a.refused.push({ tool: c.name, path: res.rel ?? c.args?.path ?? null, kind: res.refused, reason: clip(res.error, 300) });
        if (res.planFirst) a.planFirst++;
        if (res.cannotRefused) a.cannotRefused++;
        ctx.log.push({ attempt: k, step, tool: c.name, args: brief1(c.name, c.args), ok: !res.error, ...(res.refused ? { refused: res.refused } : {}), result: clip(res.error || res.text, 240), ms: Date.now() - t1 });
        const content = res.error ? String(res.error) : String(res.text);
        msgs.push({ role: "tool", content, tool_name: c.name, ...(c.id ? { tool_call_id: c.id } : {}), range: c.name === "read_file" && res.lines ? { rel: res.rel, a: res.lines[0], b: res.lines[1] } : null, wrote: c.name === "write_patch" && !res.error ? res.rel : null, what: c.name === "read_file" ? `${res.rel || c.args?.path} lines ${res.lines?.join("-") || ""}` : c.name === "search" ? `search ${clip(c.args?.pattern, 60)}` : c.name === "list_files" ? `list ${c.args?.dir}` : null });
        if (ctx.finished || ctx.cannot) break;
      }
    }
    if (ctx.cannot) { a.end = "cannot"; a.cannot = ctx.cannot; }
    else if (ctx.finished) a.end = "done";
    else a.end ||= "steps";
    a.plan = ctx.plan; a.reviews = ctx.reviews; a.checks = ctx.finished?.checks || null;
    // the spec's oracle, when the caller can run it (the gates run it again, gate 8)
    if (ctx.finished && ctx.verify) {
      let v;
      try { v = await ctx.verify(ctx.wt, ctx.spec); } catch (e) { v = { ok: false, output: String(e.message || e) }; }
      a.verify = { ok: !!v?.ok, output: clip(v?.output, 1500) };
      if (!v?.ok) { a.end = "verify"; ctx.finished = null; }
    }
    a.ok = !!ctx.finished;
    a.diff = await diffOf(ctx.wt, ctx.files).catch(() => "");
    a.changed = (await changed(ctx.wt).catch(() => [])).filter((f) => ctx.files.includes(f));
    a.unit = ctx.unit ? { ok: ctx.unit.ok, pass: ctx.unit.pass, fail: ctx.unit.fail } : null;
    a.tokens = totals(j.calls);
    a.seconds = +((Date.now() - t0) / 1000).toFixed(1);
    a.summary = ctx.finished?.summary || null;
    return a;
  });
}
// how an attempt ended, for the next one: written by code from what happened
function noteOf(a) {
  const what = a.changed.length ? `it had changed ${a.changed.join(", ")}` : "it had changed nothing";
  const unit = a.unit ? (a.unit.ok ? "the unit tests passed" : `the unit tests failed (${a.unit.fail})`) : "the unit tests had not been run";
  const why = { steps: `it ran out of steps without done`, tokens: "it used up its token budget", stalled: "the model stopped calling tools", "model-error": "the model server did not answer", verify: `done was accepted, but the spec's check failed:\n${firstLines(a.verify?.output, 14)}` }[a.end] || a.end;
  return `Attempt ${a.n}: ${why}; ${what}; ${unit}.${a.refused.length ? ` Refused writes: ${a.refused.map((r) => r.path).join(", ")}.` : ""}${a.diff ? `\nIts change was:\n${clip(a.diff, 2400)}` : ""}`;
}

// ---- the build --------------------------------------------------------------------------------------------------
export function checkSpec(spec, never = NEVER) {
  const reasons = [], c = spec?.change || {};
  if (!spec || typeof spec !== "object") return ["no spec"];
  if (!ID.test(String(spec.id || ""))) reasons.push(`the spec id ${JSON.stringify(spec.id)} is not P- and letters, digits or dashes`);
  if (spec.status !== "approved") reasons.push(`the spec is ${spec.status || "not approved"}: the builder runs only for an approved spec`);
  if (!["C1", "C2", "C3"].includes(c.class)) reasons.push(c.class === "C0" ? "a C0 change is a flag value: loop/flags.js ships it, not the builder" : `class ${c.class} is not C1, C2 or C3`);
  if (typeof c.summary !== "string" || !c.summary.trim()) reasons.push("the spec has no change.summary");
  const files = Array.isArray(c.files) ? c.files : [];
  if (!files.length || files.length > 8) reasons.push("change.files lists 1 to 8 files");
  for (const f of files) { const r = writeRefusal(relPath(f), files.map(relPath), never); if (r) reasons.push(`change.files: ${r.reason}`); }
  return reasons;
}

export async function build(spec, opts = {}) {
  const t0 = Date.now(), caps = { ...CAPS, ...(opts.caps || {}) }, log = [], attempts = [];
  const repo = path.resolve(opts.repo || process.env.LOOP_REPO || path.join(HERE, "../../.."));
  const never = neverList(repo);
  const out = (o) => ({ ok: false, branch: null, worktree: null, diff: "", attempts, log, seconds: +((Date.now() - t0) / 1000).toFixed(1), ...o });
  const bad = checkSpec(spec, never);
  if (bad.length) return out({ reasons: bad, refused: true });
  const files = spec.change.files.map(relPath);
  const review = await reviewer(opts, never);
  // review.check on the spec before any work: a spec it puts on the never side is not built
  let pre;
  try { pre = await review.check(spec); } catch (e) { pre = { allowed: false, needs: "never", reasons: [`review.check failed: ${e.message}`] }; }
  if (refusedBy(pre)) return out({ reasons: pre?.reasons?.length ? pre.reasons : ["review refused the spec"], refused: true, review: pre });
  // the GPU lock, for our GPU's model; not for a test's fake model (lock: false) or another endpoint
  let lock = null;
  if (typeof opts.lock === "function" || (opts.lock !== false && lockWanted())) {
    try { lock = typeof opts.lock === "function" ? await opts.lock() : await gpuLock(); } catch (e) { return out({ reasons: [e.message] }); }
  }
  const lockWaitS = +((Date.now() - t0) / 1000).toFixed(1);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "serve-builder-")), preload = path.join(tmp, "sandbox.mjs");
  fs.writeFileSync(preload, PRELOAD);
  let ctx = null;
  try {
    return await withPriority("background", () => job("builder", async (j) => {
      const dir = path.resolve(opts.worktrees || process.env.LOOP_WORKTREES || path.join(repo, "..", "serve-wt"));
      let w;
      try { w = await worktree(repo, dir, spec.id, { replace: !!opts.replace }); } catch (e) { return out({ reasons: [e.message], refused: !!e.refusal }); }
      ctx = { ...w, realWt: fs.realpathSync(w.wt), spec, files, never, review, caps, log, tmp, preload, chatTools: opts.chatTools || glimmerTools, verify: opts.verify || null, spentBefore: 0, writes: 0 };
      const res = { branch: w.branch, worktree: w.wt, base: w.base, reviewStub: review.stub, lockWaitS, lock: lock ? (typeof opts.lock === "function" ? "caller's" : LOCK) : null, endpoint: opts.chatTools ? "caller's model" : endpoint() };
      // the base must pass its own unit tests, or no attempt could
      await clean(w.wt, w.base);
      const base = await runTests(ctx);
      res.baseUnit = { ok: base.ok, pass: base.pass, fail: base.fail, seconds: base.seconds };
      if (!base.ok) return out({ ...res, reasons: [`the base does not pass its unit tests: ${unitText(base).slice(0, 300)}`] });
      const notes = [];
      for (let k = 1; k <= caps.attempts; k++) {
        ctx.spentBefore = totals(j.calls).prompt + totals(j.calls).output;
        if (ctx.spentBefore >= caps.tokens) break;
        opts.onStep?.({ type: "attempt", n: k });
        const a = await attempt(ctx, k, notes);
        attempts.push(a);
        opts.onStep?.({ type: "attempt-end", ...a, diff: undefined });
        if (a.ok) {
          // the branch: the spec's files only, committed by code
          await git(w.wt, ["add", "--", ...a.changed]);
          const msg = `${spec.id}: ${spec.change.class} change to ${a.changed.join(", ")}\n\n${a.summary || ""}\n\nBuilt by Serve's builder (Muse Glimmer), attempt ${k} of ${caps.attempts}. Not merged: a maintainer reviews it.`;
          await git(w.wt, ["-c", "user.name=Serve builder", "-c", "user.email=builder@serve.invalid", "commit", "--quiet", "-m", msg]);
          await clean(w.wt, "HEAD");
          const commit = (await git(w.wt, ["rev-parse", "HEAD"])).out.trim();
          const diff = (await git(w.wt, ["diff", "--no-color", "--no-ext-diff", `${w.base}..${commit}`])).out;
          const stat = (await git(w.wt, ["diff", "--shortstat", `${w.base}..${commit}`])).out.trim();
          return { ok: true, ...res, commit, diff, stat, attempts, log, summary: a.summary, tokens: totals(j.calls), seconds: +((Date.now() - t0) / 1000).toFixed(1), reasons: [] };
        }
        // the model judged the spec impossible as written (after reading its files): the build ends here, no new attempt
        if (a.end === "cannot") {
          await clean(w.wt, w.base).catch(() => {});
          return out({ ...res, tokens: totals(j.calls), cannot: a.cannot, reasons: [`the builder judged the spec impossible as written (attempt ${k}): ${a.cannot}`] });
        }
        // the model server is down: another attempt would fail the same way, and says nothing about the model
        if (a.end === "model-error") {
          await clean(w.wt, w.base).catch(() => {});
          return out({ ...res, tokens: totals(j.calls), infra: true, reasons: [`the model server did not answer (${a.lastError}); the build stopped after attempt ${k}`] });
        }
        notes.push(noteOf(a));
      }
      await clean(w.wt, w.base).catch(() => {});
      return out({ ...res, tokens: totals(j.calls), reasons: [`no attempt finished (${attempts.map((a) => `${a.n}: ${a.end}`).join(", ") || "token budget"})`] });
    }));
  } catch (e) {
    return out({ branch: ctx?.branch ?? null, worktree: ctx?.wt ?? null, reasons: [`the build stopped: ${String(e.message || e).slice(0, 300)}`] });
  } finally {
    await lock?.release?.();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// node src/loop/builder.js <spec.json> [--replace]: build one spec and print the result (without the diff's text)
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const file = process.argv[2];
  if (!file) { console.error("usage: node src/loop/builder.js <spec.json> [--replace]"); process.exit(2); }
  const r = await build(JSON.parse(fs.readFileSync(file, "utf8")), { replace: process.argv.includes("--replace"), onStep: (e) => e.type === "attempt-end" && console.error(`attempt ${e.n}: ${e.end}, ${e.steps} steps, ${e.toolCalls} tool calls, ${e.tokens.prompt + e.tokens.output} tokens, ${e.seconds} s`) });
  console.log(JSON.stringify({ ...r, log: r.log.length }, null, 2));
  process.exit(r.ok ? 0 : 1);
}

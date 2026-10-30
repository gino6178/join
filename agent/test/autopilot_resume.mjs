// A crash in the middle of an Autopilot run, on the real model, and the resume. A gateway of its own (own port and
// data files) plans the week from the app; once the run's first talk has its result in the journal
// (CRASH_AT=autopilot-negotiated@1), the gateway kills itself (SIGKILL) and is started again. Checks:
//   - the run goes on by itself after the restart and ends with games waiting for the player's yes (one plan)
//   - the model was not asked again for a turn in the journal: the restarted gateway's Autopilot model calls are the
//     turns its run took after the journal's
//   - every A2A proposal was decided once (the members' saved answers), and no hold is left but the plan's
//   - the player's yes books each game exactly once
//   node test/autopilot_resume.mjs   (LLM_URL: the model server; the members' agents answer on it too)
import { spawn } from "node:child_process";
import fs from "node:fs";
import crypto from "node:crypto";

process.env.A2A_ROUTE ||= "off"; // the members' agents' answers are the model's, so each one is a decision to count
const PORT = +(process.env.RESUME_PORT || 18795), B = `http://127.0.0.1:${PORT}`, D = "data/autopilot-resume-test";
const TOKEN = "test-token-" + crypto.randomUUID().slice(0, 8), AUTH = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
fs.rmSync(D, { recursive: true, force: true }); fs.mkdirSync(D, { recursive: true });
const env = { ...process.env, PORT: String(PORT), WEBHOOK_PORT: "0", MESSENGER_PAGE_TOKEN: "", STORE_FILE: `${D}/players.json`, BOOKINGS_FILE: `${D}/bookings.json`, AUTOPILOT_FILE: `${D}/autopilot.json`,
  A2A_FILE: `${D}/a2a.json`, ASK_FILE: `${D}/asks.json`, NEGOTIATIONS_FILE: `${D}/negotiations.json`, A2A_DATA: D, LEDGER_FILE: `${D}/ledger.jsonl`, MESSENGER_SEEN_FILE: `${D}/seen.json`, A2A_BASE: B,
  TRACE_FILE: `${D}/traces.jsonl`, AGENT_TOKEN: TOKEN, AUTOPILOT_KEEP_JOURNAL: "1", MEMORY_FILE: `${D}/memory.json`, PREFS_FILE: `${D}/prefs.json`, LOOP_DIR: `${D}/loop`, LOOP_WATCH: "off", FEED_DEMO: "off", FEED_FILE: `${D}/feed.json`,
  MATCH_RECORDS_FILE: `${D}/mr.json`, MATCH_AUDIT_FILE: `${D}/ma.json`, MATCH_STATE_FILE: `${D}/ms.json` };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [], expect = (c, what) => { console.log(`  ${c ? "PASS" : "FAIL"} ${what}`); if (!c) fails.push(what); };
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const lines = (f) => { try { return fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)); } catch { return []; } };
const start = (label, crash) => { const gw = spawn(process.execPath, ["src/server.js"], { env: { ...env, ...(crash ? { CRASH_AT: crash } : {}) }, stdio: ["ignore", "pipe", "pipe"] }); gw.stdout.on("data", (d) => /resumed|error/i.test(d) && process.stdout.write(`  [${label}] ${d}`)); gw.stderr.on("data", (d) => process.stdout.write(`  [${label}!] ${d}`)); return gw; };
const up = async () => { for (let i = 0; i < 60; i++) { try { await fetch(`${B}/api/status`); return; } catch { await wait(500); } } throw new Error("gateway did not start"); };

const t0 = Date.now();
let gw = start("gateway 1", "autopilot-negotiated@1");
const died = new Promise((ok) => gw.on("exit", ok));
await up();
fetch(`${B}/api/autopilot/run`, { method: "POST", headers: AUTH, body: JSON.stringify({ goal: { perWeek: 2 }, history: [], upcoming: [] }) }).then((r) => r.text()).catch(() => {});
const crashed = await Promise.race([died.then(() => true), wait(600000).then(() => false)]);
expect(crashed, "the gateway died once the run's first talk was in the journal");
const dir = `${D}/autopilot_runs`, id = (fs.readdirSync(dir).find((f) => f.endsWith(".jsonl")) || "").replace(/\.jsonl$/, "");
const before = lines(`${dir}/${id}.jsonl`), turnsBefore = before.filter((e) => e.k === "turn").length;
const ledgerBefore = lines(`${D}/ledger.jsonl`).length;
console.log(`  run ${id}: ${turnsBefore} model turns and ${before.filter((e) => e.k === "done").length} tool calls in the journal at the crash`);
gw = start("gateway 2");
await up();
let st;
for (let i = 0; i < 600; i++) { st = await fetch(`${B}/api/autopilot/run?id=${id}`, { headers: AUTH }).then((r) => r.json()).catch(() => null); if (st?.status === "done") break; await wait(1000); }
expect(st?.status === "done" && st.games.length >= 1, `the run went on by itself and ended with ${st?.games?.length ?? 0} game(s) waiting for a yes (${st?.status})`);
const after = lines(`${dir}/${id}.jsonl`), turnsAfter = after.filter((e) => e.k === "turn").length - turnsBefore;
const calls2 = lines(`${D}/ledger.jsonl`).slice(ledgerBefore).filter((c) => String(c.site).startsWith("autopilot")).length;
expect(calls2 === turnsAfter, `the model was asked only for the turns after the journal's (${calls2} Autopilot model calls after the restart, ${turnsAfter} new turns; ${turnsBefore} from the journal)`);
const db = readJson(`${D}/autopilot.json`, { pending: {} });
expect(Object.values(db.pending).filter((p) => p.options).length === 1, "one plan waits for the player's yes");
const answers = Object.keys(readJson(`${D}/a2a_answers.json`, {})).length, decided = lines(`${D}/ledger.jsonl`).filter((c) => /^a2a\./.test(String(c.site)) && !c.marker).length;
expect(decided === answers, `every A2A proposal was decided once (${decided} decisions, ${answers} proposals answered)`);
const talks = (db.pending[id]?.options || []).map((o) => o.hold || o.talk), live = (readJson(`${D}/bookings.json`, { leases: [] }).leases || []).filter((l) => l.until > Date.now());
expect(live.every((l) => talks.includes(l.ref)), `no hold left but the plan's (${live.length} held)`);
const yes = await fetch(`${B}/api/autopilot/answer`, { method: "POST", headers: AUTH, body: JSON.stringify({ id, choice: "all" }) }).then((r) => r.json());
const again = await fetch(`${B}/api/autopilot/answer`, { method: "POST", headers: AUTH, body: JSON.stringify({ id, choice: "all" }) }).then((r) => r.json());
const books = readJson(`${D}/bookings.json`, { bookings: [] }).bookings.filter((b) => !b.cancelled);
expect(books.length === (yes.options || []).length && !!again.error, `the yes booked each game exactly once (${books.length} bookings for ${(yes.options || []).length} games; a second yes: ${again.error || "booked again"})`);
gw.kill("SIGKILL");
console.log(`\n${fails.length ? `${fails.length} FAILED` : "ALL PASSED"} · ${((Date.now() - t0) / 1000).toFixed(0)} s`);
fs.writeFileSync("data/autopilot_resume.json", JSON.stringify({ at: new Date().toISOString(), llm: process.env.LLM_URL, run: id, turnsFromJournal: turnsBefore, turnsAfter, modelCallsAfter: calls2, games: st?.games?.map((g) => g.text), passed: !fails.length, fails }, null, 1));
process.exit(fails.length ? 1 : 0);

// A crash in the middle of a negotiation, and the resume. A gateway of its own (own port and data files) gets a
// "want a game?" and a yes; the moment the negotiation has saved its first round, the gateway is killed (SIGKILL, no
// chance to clean up) and started again. Checks:
//   - after the restart, the cut-off talk is picked up and finished, and the question gets its result
//   - the members' agents answered every A2A message once: no member decided twice for the same message
//   - the A2A tasks are still there after the restart (GetTask), and the agents' cards are served
//   node test/a2a_resume.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";

import crypto from "node:crypto";
// the model's own answers are what this tests: code does not answer the calendar's questions for it
process.env.A2A_ROUTE ||= "off"; process.env.A2A_STUDENT ||= "off";
const PORT = 18791, B = `http://127.0.0.1:${PORT}`, D = "data/resume-test";
const TOKEN = "test-token-" + crypto.randomUUID().slice(0, 8), AUTH = { authorization: `Bearer ${TOKEN}` };
fs.rmSync(D, { recursive: true, force: true }); fs.mkdirSync(D, { recursive: true });
const env = { ...process.env, PORT: String(PORT), WEBHOOK_PORT: "0", MESSENGER_PAGE_TOKEN: "", STORE_FILE: `${D}/players.json`, BOOKINGS_FILE: `${D}/bookings.json`, AUTOPILOT_FILE: `${D}/autopilot.json`,
  A2A_FILE: `${D}/a2a.json`, ASK_FILE: `${D}/asks.json`, NEGOTIATIONS_FILE: `${D}/negotiations.json`, A2A_DATA: D, LEDGER_FILE: `${D}/ledger.jsonl`, MESSENGER_SEEN_FILE: `${D}/seen.json`, A2A_BASE: B, TRACE_FILE: `${D}/traces.jsonl`, AGENT_TOKEN: TOKEN };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [], expect = (c, what) => { console.log(`  ${c ? "PASS" : "FAIL"} ${what}`); if (!c) fails.push(what); };
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
function start(label) {
  const gw = spawn(process.execPath, ["src/server.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
  gw.stdout.on("data", (d) => process.stdout.write(`  [${label}] ${d}`)); gw.stderr.on("data", (d) => process.stdout.write(`  [${label}!] ${d}`));
  return gw;
}
const up = async () => { for (let i = 0; i < 60; i++) { try { await fetch(`${B}/api/status`); return; } catch { await wait(500); } } throw new Error("gateway did not start"); };

let gw = start("gateway 1");
try {
  await up();
  const card = await fetch(`${B}/a2a/members/leo/.well-known/agent-card.json`).then((r) => r.json());
  expect(card.supportedInterfaces?.[0]?.protocolBinding === "JSONRPC" && card.skills?.[0]?.id === "agree-game-time", "a member's Agent Card is served (A2A 1.0, JSON-RPC)");
  // a question from the Match helper, nothing sore so it is a singles game with one agent
  const q = await fetch(`${B}/api/ask/next`, { method: "POST", headers: { "content-type": "application/json", ...AUTH }, body: JSON.stringify({ ahead: 7, body: { log: [], workouts: [], days: [] } }) }).then((r) => r.json());
  expect(!!q.id, `the Match helper asks: ${q.text?.slice(0, 80)}`);
  // yes, and kill the gateway as soon as the first round is saved
  fetch(`${B}/api/ask/answer`, { method: "POST", headers: { "content-type": "application/json", ...AUTH }, body: JSON.stringify({ id: q.id, choice: "yes" }) }).catch(() => {});
  let saved = null;
  for (let i = 0; i < 240 && !saved; i++) { await wait(250); saved = Object.values(readJson(`${D}/negotiations.json`, {})).find((n) => n.status === "working" && n.round >= 1); }
  expect(!!saved, `the negotiation saved its round ${saved?.round} before the crash`);
  await wait(1500); // the members' agents are mid-answer
  gw.kill("SIGKILL"); await wait(800);
  const before = readJson(`${D}/asks.json`, { asks: {} }).asks[q.id];
  expect(before?.status === "talking", "the crash left the question in the middle of its talk");

  gw = start("gateway 2");
  await up();
  let after = null;
  for (let i = 0; i < 480; i++) { await wait(500); after = readJson(`${D}/asks.json`, { asks: {} }).asks[q.id]; if (after && after.status !== "talking") break; }
  expect(after && ["booked", "moved", "failed"].includes(after.status), `after the restart the talk was finished: ${after?.status}`);
  const neg = readJson(`${D}/negotiations.json`, {})[saved?.id];
  expect(neg && neg.status !== "working", `the negotiation ended ${neg?.status} in round ${neg?.result?.rounds}`);
  // every A2A message was decided once: count the member agents' model calls per message (the ledger) against the answers kept
  const answers = readJson(`${D}/a2a_answers.json`, {}), ids = Object.keys(answers).filter((k) => k.startsWith(saved.id));
  const decided = fs.readFileSync(`${D}/ledger.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.site === "a2a.answer" && !r.invalid);
  console.log(`  ${ids.length} A2A messages answered, ${decided.length} member decisions made by the model`);
  expect(ids.length >= 1 && decided.length <= ids.length + 1, "no member agent decided the same message twice (at most one decision cut off by the crash)");
  const t = await fetch(`${B}/a2a/members/${saved.members[0]}/`, { method: "POST", headers: { "content-type": "application/json", "A2A-Version": "1.0", ...AUTH }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ListTasks", params: { contextId: saved.id } }) }).then((r) => r.json());
  expect((t.result?.totalSize || 0) >= 1, `the member's tasks for this talk survived the restart (${t.result?.totalSize} in its context)`);
} catch (e) { fails.push(String(e.message)); console.log("ERROR", e); }
gw.kill();
console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASSED");
process.exit(fails.length ? 1 : 0);

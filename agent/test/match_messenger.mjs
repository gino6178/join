// "I want to play" in Messenger, end to end (docs/agent_matchmaking_plan.md, section 3): a fake Graph API on this
// machine, the real gateway pointed at it, and a player who messages the Page through the signed webhook. The demo
// club's members' agents answer over A2A, as behind the gateway. Checks: the message is read as a play request, the
// members' agents are asked for a band (the audit has it), the agents agree a game and the player gets it as a
// question with Book it / Drop it, nothing is booked before the tap, the tap books it, and /forget deletes the
// estimates the player made.
//   node test/match_messenger.mjs        (Muse Glimmer at LLM_URL reads the message; GW_PORT, GRAPH_PORT)
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";

const GRAPH_PORT = +(process.env.GRAPH_PORT || 18922), GW_PORT = +(process.env.GW_PORT || 18921), PSID = "5151", SECRET = "test-secret", sent = [];
const TOKEN = "test-token-" + crypto.randomUUID().slice(0, 8), AUTH = { authorization: `Bearer ${TOKEN}` }, D = "data/match-msg";
const graph = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    const body = b ? JSON.parse(b) : {};
    if (body.message?.text) sent.push({ text: body.message.text, payloads: body.message.quick_replies?.map((q) => q.payload) || [], buttons: body.message.quick_replies?.map((q) => q.title) || [] });
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ recipient_id: body.recipient?.id, message_id: `m${sent.length}` }));
  });
}).listen(GRAPH_PORT);
fs.rmSync(D, { recursive: true, force: true }); fs.mkdirSync(D, { recursive: true });
const files = Object.fromEntries(["STORE", "BOOKINGS", "AUTOPILOT", "A2A", "ASK", "MESSENGER_SEEN", "NEGOTIATIONS", "FEEDBACK", "PLAYBOOK", "KB", "MEMORY", "MATCH_RECORDS", "MATCH_AUDIT", "MATCH_STATE"].map((k) => [`${k}_FILE`, `${D}/${k.toLowerCase()}.json`]));
const gw = spawn(process.execPath, ["src/server.js"], { env: { ...process.env, ...files, PORT: String(GW_PORT), MESSENGER_PAGE_TOKEN: "TEST", MESSENGER_APP_SECRET: SECRET, MESSENGER_VERIFY_TOKEN: "verify-me", MESSENGER_API: `http://127.0.0.1:${GRAPH_PORT}/v21.0`, WEBHOOK_PORT: "0",
  A2A_DATA: `${D}/a2a-data`, LEDGER_FILE: `${D}/ledger.jsonl`, TRACE_FILE: `${D}/traces.jsonl`, LOOP_DIR: `${D}/loop`, AGENT_TOKEN: TOKEN, ALLOW_ORIGINS: "http://127.0.0.1:5191" }, stdio: ["ignore", "pipe", "pipe"] });
gw.stderr.on("data", (d) => process.stdout.write("  [gateway!] " + d));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function hook(event) {
  const body = JSON.stringify({ object: "page", entry: [{ id: "page", time: Date.now(), messaging: [{ sender: { id: PSID }, recipient: { id: "page" }, timestamp: Date.now(), ...event }] }] });
  return fetch(`http://127.0.0.1:${GW_PORT}/webhook/messenger`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=" + crypto.createHmac("sha256", SECRET).update(body).digest("hex") }, body });
}
// a message (or a tap), and every reply until one matches `until`
async function say(text, until, { payload = null, timeout = 300000 } = {}) {
  const before = sent.length, s = Date.now();
  await hook({ message: { mid: `p${Date.now()}`, text, ...(payload ? { quick_reply: { payload } } : {}) } });
  while (!sent.slice(before).some((m) => until.test(m.text))) { if (Date.now() - s > timeout) break; await wait(300); }
  const got = sent.slice(before);
  console.log(`\n> ${text}  (${((Date.now() - s) / 1000).toFixed(1)} s)\n${got.map((g) => `< ${g.text}${g.buttons.length ? `  [${g.buttons.join("] [")}]` : ""}`).join("\n")}`);
  return got;
}
const api = (p) => fetch(`http://127.0.0.1:${GW_PORT}${p}`, { headers: AUTH }).then((r) => r.json());
const fails = [], expect = (c, what) => { console.log(`  ${c ? "PASS" : "FAIL"} ${what}`); if (!c) fails.push(what); };
try {
  await wait(2500);
  await say("Hi", /linked/);
  const before = (await api("/api/players")).find((p) => p.id === PSID)?.events?.length || 0;
  const got = await say("I want to play singles this week", /Book it\?|No deal|couldn't/);
  expect(got.some((m) => /asking the agents of the people most likely to say yes/.test(m.text)), "the message is read as a play request");
  const q = got.find((m) => /Book it\?$/.test(m.text));
  expect(!!q, "the agents agreed a game, and it comes as a question");
  expect(q && q.payloads.some((p) => /^gm:[\w-]+:book$/.test(p)) && q.payloads.some((p) => /:drop$/.test(p)), "with Book it and Drop it");
  expect(q && /Nothing is booked yet/.test(q.text), "nothing is booked before the tap");
  const audit = (await api(`/api/match/audit?from=${PSID}`)).estimates || [];
  expect(audit.length > 0 && audit.every((a) => a.band || a.refused), `the members' agents gave bands (${audit.length} estimates in the audit: ${[...new Set(audit.map((a) => a.band || "refused"))].join(", ")})`);
  expect(((await api("/api/players")).find((p) => p.id === PSID)?.events?.length || 0) === before, "the calendar has no game yet");
  if (q) {
    const booked = await say("Book it", /Booked:|wasn't booked/, { payload: q.payloads.find((p) => /:book$/.test(p)) });
    expect(booked.some((m) => /^(.|\n)*Booked: /.test(m.text)), "the tap books it");
    expect(((await api("/api/players")).find((p) => p.id === PSID)?.events?.length || 0) === before + 1, "and it is in the player's calendar");
  }
  // the player's own agent gives no estimate until they say yes; their card says so
  const card = () => fetch(`http://127.0.0.1:${GW_PORT}/a2a/members/${PSID}/.well-known/agent-card.json`).then((r) => r.json());
  expect(!(await card()).skills?.some((s) => s.id === "estimate-yes"), "before /bands on, the player's card offers no estimate");
  const on = await say("/bands on", /^On: /);
  expect(on.some((m) => /one word/.test(m.text)), "/bands on says in one line what is shared");
  expect((await card()).skills?.some((s) => s.id === "estimate-yes"), "after it, the card offers one");
  await say("/forget", /deleted/);
  expect(((await api(`/api/match/audit?from=${PSID}`)).estimates || []).length === 0, "/forget deletes the estimates the player asked for");
  expect(!(await api(`/api/match/settings?player=${PSID}`)).bands, "and sets the choice back to off");
} catch (e) { console.log("ERROR", e); fails.push(String(e.message || e)); }
gw.kill(); graph.close();
fs.rmSync(D, { recursive: true, force: true });
console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASSED");
process.exit(fails.length ? 1 : 0);

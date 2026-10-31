// End to end: start the server on the PayPal stand-in, then run the scripted agent (examples/scripted-agent.mjs), which
// uses Join over MCP the way any agent does: four players' agents, an over-budget venue, alternatives, haggling, the
// organizer's guarantee, three shares and the lock. Skipped when the examples' packages aren't installed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EX = path.join(HERE, "../../examples");
const ready = fs.existsSync(path.join(EX, "node_modules/@modelcontextprotocol/sdk"));

test("agents organize, negotiate and settle a group booking over MCP", { skip: !ready && "run npm install in examples/ first", timeout: 60e3 }, async () => {
  const port = 20000 + Math.floor(Math.random() * 20000), url = `http://localhost:${port}`;
  const server = spawn(process.execPath, ["src/server.js"], { cwd: path.join(HERE, ".."), env: { ...process.env, PORT: String(port), PUBLIC_URL: url, PAYPAL_MODE: "mock", PAYPAL_CLIENT_ID: "", TICK_MS: "1000" } });
  try {
    await new Promise((ok, bad) => { server.stdout.on("data", (d) => String(d).includes("Join on") && ok()); server.on("exit", bad); setTimeout(() => bad(new Error("server did not start")), 60e3); });
    const out = await new Promise((ok, bad) => {
      const a = spawn(process.execPath, ["scripted-agent.mjs"], { cwd: EX, env: { ...process.env, JOIN_URL: url } });
      let s = ""; a.stdout.on("data", (d) => (s += d)); a.stderr.on("data", (d) => (s += d));
      a.on("exit", (code) => (code === 0 ? ok(s) : bad(new Error(s))));
    });
    assert.match(out, /over Alex's \$8\.00 budget/);
    assert.match(out, /alternative/);
    assert.match(out, /deal: \$/);
    assert.match(out, /: locked, court \d+/);
    // the people involved can see what the agents did
    const s = await fetch(`${url}/api/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ player: "leo" }) });
    const cookie = s.headers.get("set-cookie").split(";")[0];
    const act = await (await fetch(`${url}/api/activity`, { headers: { cookie } })).json();
    for (const a of ["negotiation_opened", "deal", "held", "authorized", "locked"]) assert.ok(act.entries.some((e) => e.action === a), `Leo sees ${a}`);
    assert.ok(act.entries.every((e) => e.who.includes("leo")));
    // and an agent's token can't change its player's limits
    const tok = await (await fetch(`${url}/api/tokens`, { method: "POST", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify({ label: "x" }) })).json();
    const put = await fetch(`${url}/api/mandate`, { method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok.token}` }, body: JSON.stringify({ perGame: 999999 }) });
    assert.equal(put.status, 401);
    // reviews: a person's session reaches the review route (and is told why it can't review yet); an agent's token can't
    const games = await (await fetch(`${url}/api/games`, { headers: { cookie } })).json(), bk = games.bookings[0]?.id || "bk_none";
    const rev = await fetch(`${url}/api/bookings/${bk}/review`, { method: "POST", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify({ stars: 4 }) });
    assert.notEqual(rev.status, 404);
    const byAgent = await fetch(`${url}/api/bookings/${bk}/review`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok.token}` }, body: JSON.stringify({ stars: 5 }) });
    assert.equal(byAgent.status, 401);
  } finally { server.kill(); }
});

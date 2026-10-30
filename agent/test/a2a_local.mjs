// EVAL_A2A=1: an evaluation's members' agents answer over A2A, as they do behind the gateway: JSON-RPC over HTTP on a
// local port, through the official SDK, with the token, their own task stores and the schema checks on both sides.
// Without it the evaluations call the same answering code in this process (A2A_TRANSPORT=local), which is faster and
// leaves out the transport. Call before the first talk. The members' task stores go in the evaluation's own folder,
// emptied first (never a folder A2A_DATA already names, which could be the gateway's).
import fs from "node:fs";
import http from "node:http";
import crypto from "node:crypto";

export const a2aOn = () => process.env.EVAL_A2A === "1";

export async function serveA2A(dir) {
  if (!a2aOn()) return null;
  process.env.A2A_TRANSPORT = "";
  fs.rmSync(dir, { recursive: true, force: true });
  process.env.A2A_DATA = dir;
  process.env.AGENT_TOKEN ||= crypto.randomBytes(24).toString("hex");
  const a2aServer = await import("../src/a2a_server.js");
  const s = await new Promise((ok) => { const x = http.createServer((req, res) => a2aServer.handle(req, res)).listen(0, "127.0.0.1", () => ok(x)); });
  // the only address the token goes to
  process.env.A2A_BASE = process.env.A2A_SELF = `http://127.0.0.1:${s.address().port}`;
  console.log(`members' agents over A2A at ${process.env.A2A_BASE}`);
  return s;
}

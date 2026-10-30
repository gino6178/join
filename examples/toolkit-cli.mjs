// The PayPal Agent Toolkit's tools from the command line, for any agent that can run a command (Claude Code, a
// subagent, a script): one call per run, the result as JSON on stdout.
//
//   node toolkit-cli.mjs list                              the tools this venue agent may use
//   node toolkit-cli.mjs list_transactions '{}'
//   node toolkit-cli.mjs create_invoice '{"currency_code":"USD", ...}'
//
// Credentials: PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET (a sandbox app), or ../api/.env. Sandbox only.
import fs from "node:fs";
import { PayPalMCPToolkit } from "@paypal/agent-toolkit/mcp";

const env = fs.existsSync(new URL("../api/.env", import.meta.url)) ? Object.fromEntries(fs.readFileSync(new URL("../api/.env", import.meta.url), "utf8").split(/\r?\n/).map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]])) : {};
const ID = process.env.PAYPAL_CLIENT_ID || env.PAYPAL_CLIENT_ID, SECRET = process.env.PAYPAL_CLIENT_SECRET || env.PAYPAL_CLIENT_SECRET;
const ACTIONS = { transactions: { list: true }, invoices: { create: true, send: true, get: true, list: true, sendReminder: true, cancel: true }, disputes: { list: true, get: true }, payments: { getRefunds: true } };
const [method, json = "{}"] = process.argv.slice(2);

const token = (await (await fetch("https://api-m.sandbox.paypal.com/v1/oauth2/token", { method: "POST", headers: { Authorization: `Basic ${Buffer.from(`${ID}:${SECRET}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials" })).json()).access_token;
const kit = new PayPalMCPToolkit({ accessToken: token, configuration: { actions: ACTIONS, context: { sandbox: true } } });
const tools = kit.getTools();
// (exitCode rather than process.exit, so open sockets close first)
if (!method || method === "list") console.log(JSON.stringify(tools.map((t) => ({ name: t.method, description: t.description.slice(0, 300), parameters: Object.keys(t.parameters.shape) })), null, 1));
else {
  const tool = tools.find((t) => t.method === method);
  if (!tool) { console.error(`unknown tool ${method}; try: node toolkit-cli.mjs list`); process.exitCode = 2; }
  else {
    const args = tool.parameters.parse(JSON.parse(json)); // (the toolkit's own schema checks the arguments)
    const out = await kit.getPaypalAPIService().run(method, args);
    console.log(typeof out === "string" ? out : JSON.stringify(out, null, 1));
  }
}

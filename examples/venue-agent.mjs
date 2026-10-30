// A venue's agent on Claude, with PayPal's Agent Toolkit: it reads the venue's bookings on Join and works with PayPal's own
// tools (list_transactions, create_invoice, send_invoice, list_disputes, ...) on the PayPal account that receives the
// money. In this build that is Join's platform account (Join pays venues with Payouts); in the multiparty model it would
// be the venue's own.
// The toolkit runs in this process as an MCP server (@paypal/agent-toolkit/mcp), connected to an MCP client here; its
// tools and one Join tool go to Claude, which runs the loop.
//
//   JOIN_VENUE=echo node venue-agent.mjs "Reconcile this week's Join payouts with our PayPal transactions"
//   JOIN_VENUE=echo node venue-agent.mjs "Room 3 ran 30 minutes over on Friday: invoice the organizer $18"
//
// Needs Anthropic credentials (ANTHROPIC_API_KEY, or an `ant auth login` profile) and the venue's PayPal sandbox app in
// PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET (read from ../api/.env if not set). JOIN_URL defaults to http://localhost:8790.
import fs from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PayPalAgentToolkit } from "@paypal/agent-toolkit/mcp";

const env = fs.existsSync(new URL("../api/.env", import.meta.url)) ? Object.fromEntries(fs.readFileSync(new URL("../api/.env", import.meta.url), "utf8").split(/\r?\n/).map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]])) : {};
const ID = process.env.PAYPAL_CLIENT_ID || env.PAYPAL_CLIENT_ID, SECRET = process.env.PAYPAL_CLIENT_SECRET || env.PAYPAL_CLIENT_SECRET;
const JOIN = (process.env.JOIN_URL || "http://localhost:8790").replace(/\/$/, ""), VENUE = process.env.JOIN_VENUE || "echo";
const ask = process.argv.slice(2).join(" ") || "Reconcile our Join bookings with our PayPal transactions and tell me anything that doesn't match.";
if (!ID || !SECRET) { console.error("Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (a sandbox app)."); process.exit(1); }

// PayPal's Agent Toolkit as an in-process MCP server, with only the tools a venue needs
const token = (await (await fetch("https://api-m.sandbox.paypal.com/v1/oauth2/token", { method: "POST", headers: { Authorization: `Basic ${Buffer.from(`${ID}:${SECRET}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials" })).json()).access_token;
const paypalServer = new PayPalAgentToolkit({ accessToken: token, configuration: { actions: { transactions: { list: true }, invoices: { create: true, send: true, get: true, list: true, sendReminder: true }, disputes: { list: true, get: true }, payments: { createRefund: true, getRefunds: true } }, context: { sandbox: true } } });
const [a, b] = InMemoryTransport.createLinkedPair();
await paypalServer.connect(a);
const paypal = new Client({ name: "venue-agent", version: "0.1.0" });
await paypal.connect(b);
const paypalTools = (await paypal.listTools()).tools;

// One Join tool: the venue's bookings (public schedule)
const joinTool = { name: "join_bookings", description: `This venue's (${VENUE}) bookings on Join: each booking's date, start, place, total, players, state, its PayPal capture ids and the payout to the venue.`, input_schema: { type: "object", properties: {} } };
const tools = [joinTool, ...paypalTools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }))];

const client = new Anthropic();
const system = `You are the operations agent of a venue that takes bookings through Join, a marketplace where people's AI agents book and pay for courts, rooms and tables with PayPal. You work on the venue's own PayPal account with PayPal's tools. Join pays the venue with PayPal Payouts after each booking, net of PayPal's fees; each person's share is a separate PayPal capture. Today is ${new Date().toISOString().slice(0, 10)}. Before sending an invoice or a refund, state exactly what you will send and to whom. Sandbox only.`;
const messages = [{ role: "user", content: ask }];

for (let turn = 0; turn < 20; turn++) {
  const response = await client.beta.messages.create({
    model: "claude-opus-5-5", max_tokens: 16000, output_config: { effort: "medium" },
    betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
    system, tools, messages,
  });
  if (response.stop_reason === "refusal") { console.log("Claude declined this request."); break; }
  if (response.stop_reason === "pause_turn") { messages.push({ role: "assistant", content: response.content }); continue; }
  const calls = response.content.filter((x) => x.type === "tool_use");
  if (response.stop_reason !== "tool_use" || !calls.length) { for (const x of response.content) if (x.type === "text") console.log(x.text); break; }
  messages.push({ role: "assistant", content: response.content });
  const results = await Promise.all(calls.map(async (c) => {
    console.error(`  → ${c.name} ${JSON.stringify(c.input).slice(0, 160)}`);
    try {
      if (c.name === "join_bookings") return { type: "tool_result", tool_use_id: c.id, content: JSON.stringify(await (await fetch(`${JOIN}/api/venues/${VENUE}/schedule`)).json()) };
      const r = await paypal.callTool({ name: c.name, arguments: c.input });
      return { type: "tool_result", tool_use_id: c.id, content: r.content.filter((x) => x.type === "text").map((x) => x.text).join("\n"), is_error: !!r.isError };
    } catch (e) { return { type: "tool_result", tool_use_id: c.id, content: String(e.message || e), is_error: true }; }
  }));
  messages.push({ role: "user", content: results });
}
await paypal.close();

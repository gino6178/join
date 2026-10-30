// One MCP tool call to Join, from the command line: for an LLM agent (or a person) driving Join one step at a time.
//   JOIN_TOKEN=join_... node mcp-call.mjs <tool> '<JSON arguments>'
//   JOIN_TOKEN=join_... node mcp-call.mjs --list            (the tools, with their descriptions)
// Prints the tool's result as JSON. JOIN_URL defaults to http://localhost:8790. Every call is also appended to
// MCP_LOG (if set), one JSON line per call, for a transcript.
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const JOIN = (process.env.JOIN_URL || "http://localhost:8790").replace(/\/$/, ""), TOKEN = process.env.JOIN_TOKEN;
if (!TOKEN) { console.error("JOIN_TOKEN is missing (make one on Join's website: Connect)"); process.exit(2); }
const [tool, json = "{}"] = process.argv.slice(2);
const client = new Client({ name: "mcp-call", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${JOIN}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
try {
  if (!tool || tool === "--list") {
    const { tools } = await client.listTools();
    console.log(JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description, input: Object.keys(t.inputSchema?.properties || {}) })), null, 1));
  } else {
    const args = JSON.parse(json);
    const r = await client.callTool({ name: tool, arguments: args });
    const out = r.structuredContent ?? JSON.parse(r.content[0].text);
    console.log(JSON.stringify(out, null, 1));
    if (process.env.MCP_LOG) fs.appendFileSync(process.env.MCP_LOG, `${JSON.stringify({ at: new Date().toISOString(), tool, args: { ...args, ...(args.mandate ? { mandate: `${args.mandate.slice(0, 24)}…` } : {}) }, result: out })}\n`);
  }
} finally { await client.close(); }

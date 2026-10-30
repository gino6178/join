// A player's agent on Claude: it connects to Join's MCP server with the player's token, hands Join's tools to Claude,
// and runs the tool loop until Claude has an answer for the player. Join's own server runs only a small Qwen, to tell
// which activity a sentence means for its website agent; agents like this one come to it from outside.
//
//   JOIN_TOKEN=join_... node claude-agent.mjs "Book karaoke for four on Friday night, at most $10 each"
//
// Needs Anthropic credentials (ANTHROPIC_API_KEY, or an `ant auth login` profile) and a Join token made on the website
// (Connect your agent). JOIN_URL defaults to http://localhost:8790.
import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const JOIN = (process.env.JOIN_URL || "http://localhost:8790").replace(/\/$/, "");
const TOKEN = process.env.JOIN_TOKEN;
const ask = process.argv.slice(2).join(" ") || "Get three friends together this week for something we all like, within my budget, and set it up.";
if (!TOKEN) { console.error("Set JOIN_TOKEN to a token from Join's website (Connect your agent)."); process.exit(1); }

// Join's tools, as Claude tools
const mcp = new Client({ name: "Claude (example agent)", version: "0.1.0" });
await mcp.connect(new StreamableHTTPClientTransport(new URL(`${JOIN}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
const { tools: joinTools } = await mcp.listTools();
const tools = joinTools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
const instructions = mcp.getInstructions() || "";

const client = new Anthropic();
const system = `You are the user's agent for getting a group together on Join.\n\n${instructions}\n\nToday is ${new Date().toISOString().slice(0, 10)}. Prices are in USD. When a payment needs the user's approval, give them the approveUrl and stop.`;
const messages = [{ role: "user", content: ask }];

for (let turn = 0; turn < 25; turn++) {
  const response = await client.beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    output_config: { effort: "medium" },
    // on a policy decline, the API re-runs the request on a fallback model it picks by the decline's category
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system,
    tools,
    messages,
  });
  if (response.stop_reason === "refusal") { console.log("Claude declined this request."); break; }
  if (response.stop_reason === "pause_turn") { messages.push({ role: "assistant", content: response.content }); continue; }
  const calls = response.content.filter((b) => b.type === "tool_use");
  if (response.stop_reason !== "tool_use" || !calls.length) {
    for (const b of response.content) if (b.type === "text") console.log(b.text);
    break;
  }
  messages.push({ role: "assistant", content: response.content });
  // run every call of this turn, then send all the results back in one message
  const results = await Promise.all(calls.map(async (c) => {
    console.error(`  → ${c.name} ${JSON.stringify(c.input)}`);
    try {
      const r = await mcp.callTool({ name: c.name, arguments: c.input });
      return { type: "tool_result", tool_use_id: c.id, content: r.content.filter((x) => x.type === "text").map((x) => x.text).join("\n"), is_error: !!r.isError };
    } catch (e) { return { type: "tool_result", tool_use_id: c.id, content: String(e.message || e), is_error: true }; }
  }));
  messages.push({ role: "user", content: results });
}
await mcp.close();

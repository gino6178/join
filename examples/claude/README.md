# Connecting Claude to Join

Make a token on Join's website (**Connect your agent**), then:

**Claude Code**

```bash
claude mcp add --transport http join http://localhost:8790/mcp --header "Authorization: Bearer join_YOUR_TOKEN"
```

Then ask: *"Use Join to book karaoke with three friends on Friday night, at most $10 each."* (or a game of
badminton, an escape room, a barbecue, a hot pot dinner)

**Claude Desktop** (`claude_desktop_config.json`), through the `mcp-remote` bridge:

```json
{ "mcpServers": { "join": { "command": "npx", "args": ["-y", "mcp-remote", "http://localhost:8790/mcp", "--header", "Authorization: Bearer join_YOUR_TOKEN"] } } }
```

Claude's custom connectors on claude.ai connect from Anthropic's cloud, so they need Join on a public HTTPS address
(deploy it, or open a tunnel such as `cloudflared tunnel --url http://localhost:8790`) and `PUBLIC_URL` set to it.

**Your own Claude agent**: [`../claude-agent.mjs`](../claude-agent.mjs) bridges Join's MCP tools into the Claude API
and runs the tool loop.

```bash
JOIN_TOKEN=join_YOUR_TOKEN node claude-agent.mjs "Book karaoke for four on Friday night within my budget"
```

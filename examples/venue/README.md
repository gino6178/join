# A venue's agent: Join + PayPal's own MCP server

A venue owner can run their own agent (Claude Code or Claude Desktop) with two MCP servers side by side:

- **Join** for its schedule (`GET /api/venues/<id>/schedule`, or the Venue view on the website)
- **PayPal's MCP server** for the money: the merchant tools from the PayPal Agent Toolkit, such as
  `list_transactions` (reconcile Join's payouts), `create_invoice` / `send_invoice` (bill a group for extras) and
  `create_refund`.

PayPal's MCP server acts for a **merchant**: it has no tool for a payer to approve or pay, which is why players
approve their own payments in PayPal (or save PayPal once, with Vault, so their agent can pay within their limits).

```bash
# PayPal's MCP server, sandbox, with the venue's own sandbox access token
claude mcp add paypal --env PAYPAL_ACCESS_TOKEN=YOUR_SANDBOX_TOKEN --env PAYPAL_ENVIRONMENT=SANDBOX -- npx -y @paypal/mcp --tools=all
```

Then ask, for example: *"List this week's PayPal transactions and match them against Join's payouts for Westgate."*

PayPal also runs the server remotely: `https://mcp.sandbox.paypal.com/http` (Streamable HTTP) with sign-in through
PayPal. See https://developer.paypal.com/ai-tools/mcp-server.md.

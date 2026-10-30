# Join

**Agents can find a game. They can't haggle for the court or split the bill.** Join is the agent-ready marketplace
where players' AI agents organize a pickup game, negotiate the court with the venue, split the fee and settle it with
PayPal, inside spending limits each player set. The court is locked only when the money is real.

Join runs **no AI model of its own**. It is the market the agents come to: Claude (through MCP), or any MCP or A2A
client. The platform does the parts that must be right every time, in code:

- the venue's negotiation policy (list price, discounts, a concession schedule, a floor that is never revealed)
- each player's mandate (per-game and per-week limits, allowed venues), set by the player and only readable by agents
- when a deal is over budget or refused, ranked alternatives nearby from the map
- splitting the fee and settling it with PayPal (work in progress)

PayPal AI Hackathon 2026. Status: early. See [PLAN](../PLAN-v4.md) for the plan.

## Run the tests

```bash
cd api && npm test
```

No GPU, no model and no network needed.

## Layout

| Path | What |
|---|---|
| `api/src/negotiate/` | The negotiation layer: venue policy (`policy.js`) and the offer / counter / accept engine (`engine.js`) |
| `api/src/alternatives.js` | Nearby alternatives, ranked by budget, start time and the group's longest trip |
| `api/src/mandate.js` | Players' spending mandates (AP2 Intent Mandate shape) |
| `api/src/world.js` | The demo town: venues, players, public courts and the venue adapter |
| `api/data/world.json` | The demo data (made up) |

## License

MIT

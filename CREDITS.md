# Credits and licenses

Join is our own work. It reuses a few pure functions (free-time intersection, travel time, "the venue in the middle",
the demo venues' timetable, atomic JSON writes) from our earlier project Serve, imported as the `baseline` commit of this
repository. Everything after that commit was written for the PayPal AI Hackathon, during its submission period.

Join runs no AI model of its own. The agents that use it are the players' and venues' own (Claude, or any MCP or A2A
client).

## Services

| What | Used for |
|---|---|
| PayPal REST APIs (sandbox): Orders v2, Payments (authorizations, captures, refunds), Payouts, Vault v3, Webhooks | Splitting and settling a court's fee |

## Specifications implemented

| What | Where |
|---|---|
| Agent Payments Protocol (AP2) mandates, JSON schemas (Apache-2.0) | `api/src/proof/mandates.js` |
| RFC 6962 / RFC 9162 Merkle trees; C2SP signed-note, tlog-checkpoint, tlog-cosignature | `api/src/proof/tlog.js`, `examples/witness.mjs` |
| RFC 9421 HTTP Message Signatures, RFC 9530 Content-Digest (as in Web Bot Auth) | `api/src/auth.js`, `examples/signed-agent.mjs` |
| WebMCP (W3C Web Machine Learning community group) | `web/src/webmcp.js` |

## Libraries

| What | License |
|---|---|
| PayPal Agent Toolkit (`@paypal/agent-toolkit`) | ISC |
| Express | MIT |
| Model Context Protocol TypeScript SDK (`@modelcontextprotocol/sdk`) | MIT |
| Zod | MIT |
| React, React DOM, Vite, `@vitejs/plugin-react` | MIT |
| `@noble/hashes`, `@noble/ed25519` (receipt checks in browsers without WebCrypto, e.g. over plain HTTP on a LAN) | MIT |
| Bryntum Scheduler (`@bryntum/scheduler`, trial, installed from npm, not included in this repository) | Bryntum commercial license (trial) |
| Anthropic TypeScript SDK (`@anthropic-ai/sdk`, examples only) | MIT |

## Data

- **Town, venues, prices, players and public courts** (`api/data/world.json`): made up for the demo by us, placed on a
  map of San Jose, CA. Free courts come from a fixed pseudo-random timetable, not from real venues.
- **Town map shapes** (river, parks, roads): drawn by us.

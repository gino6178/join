# Join

**Agents can find a game. They can't haggle for the court or split the bill.**

Join is the agent-ready marketplace for pickup sports. Players' own AI agents come to it (Claude, or any MCP or A2A
client) to find who is free, **negotiate the court's price with the venue**, split the fee and **settle it with
PayPal**, inside spending limits each player set. The court is locked only when the money is real, and the people
involved see every step their agents took.

Join runs **no AI model of its own**. It is the market and the rules; the intelligence is in the agents that use it.

PayPal AI Hackathon 2026 · MIT license

---

## What happens

1. **Your agent looks for a game.** `find_options`: when you and enough players are free, and the fairest venue for
   each time (the one where the longest trip in the group is shortest), with its opening price.
2. **It negotiates.** `start_negotiation` → `make_offer` → `accept_price`. The venue's side is run by Join from the
   venue's policy: list price, off-peak / group / last-minute discounts, a concession schedule (firm, standard or
   eager) over at most three counter-offers, the last one best and final, and a floor that never leaves the engine.
3. **Over budget? Alternatives from the map.** If the price is over your per-game limit, the venue says no, or the
   court is gone, the answer carries other venues and free public courts nearby, ranked by budget, start time and
   the group's longest trip, each with a reason written by code.
4. **The organizer guarantees the court.** A deal is binding: the organizer authorizes the **whole** price with PayPal
   (Orders v2, intent `AUTHORIZE`) within 10 minutes, or the court goes back. Nobody can hold a court for free.
5. **The others are invited, then pay their share.** Each player's agent (or the player, on the website) joins or
   declines; nothing is started for anyone who hasn't said yes. Joining authorizes their share in PayPal, or, if they
   saved PayPal for their agent (Vault) and the share fits their limits, their agent pays it without a redirect.
6. **Locked.** When everyone has paid (or the 20 minutes run out) each share is captured and the rest is captured from
   the organizer's authorization: they cover whoever didn't pay. Cancel more than 24 hours ahead: full refunds.
7. **The venue is paid after the game** (PayPal Payouts, net of fees), so a cancellation can still be refunded.

The website shows each person what the agents did (**Activity**), what waits on them (an approval in PayPal), where
each payment stands (**Games**), the venue and alternatives on the town map (**Map**), the limits only they can set
(**Limits**), and which agents may act for them (**Connect**). A **Venue view** shows a venue its courts (dashed while
a group pays, solid once paid), and lets the venue's staff set the rules Join negotiates by: style, floor, number of
counter-offers, off-peak / group / last-minute discounts.

Dates and times are the town's (San Jose, `America/Los_Angeles`) wherever the server and the viewer are. State is
kept in `api/data/state/` and survives restarts (`JOIN_STATE_DIR=memory` keeps it in memory only).

## Run it

Node 20+. No GPU, no model, and no PayPal keys needed: without keys Join runs on a PayPal stand-in that moves no money
and says so on every page.

```bash
npm run setup
```

```bash
npm start
```

Open http://localhost:8790 and sign in as any demo player. Then, in another terminal, watch four agents set up a game:

```bash
npm run demo
```

The scripted agent (`examples/scripted-agent.mjs`) uses Join over MCP exactly as Claude would, with no API key: an
over-budget venue, alternatives, three rounds of haggling, the organizer's guarantee, three shares, the lock.

### With PayPal sandbox

Copy `api/.env.example` to `api/.env`, set `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` from a sandbox app with
**Payouts** and **Vault** enabled, and restart. Approvals then happen on PayPal's sandbox pages with sandbox buyer
accounts. For webhooks, expose the server over HTTPS (for example `cloudflared tunnel --url http://localhost:8790`),
set `PUBLIC_URL` and `PAYPAL_WEBHOOK_ID`. Webhooks only confirm: return URLs and polling move the state on their own.

### Connect Claude

Make a token on the website (**Connect**), then:

```bash
claude mcp add --transport http join http://localhost:8790/mcp --header "Authorization: Bearer join_YOUR_TOKEN"
```

More in [examples/claude](examples/claude/README.md), including a Claude API agent (`examples/claude-agent.mjs`).

### Tests

```bash
npm test
```

Negotiation, alternatives and mandates; settlement (guarantee, shares, lock, organizer covers, release, void,
refunds, Vault autopay, idempotent PayPal calls); and an end-to-end run of the scripted agent over MCP.

## How agents connect

| Interface | Where | For |
|---|---|---|
| MCP (Streamable HTTP) | `POST /mcp` | Claude Code, Claude Desktop, any MCP client |
| REST | `POST /api/agent/<tool>` | scripts and other HTTP clients |
| A2A (JSON-RPC, `message/send`) | `POST /a2a`, card at `/.well-known/agent-card.json` | agents that speak A2A |

All three take a player's token (`Authorization: Bearer join_...`) and offer the same tools: `whoami`, `list_venues`,
`find_options`, `start_negotiation`, `make_offer`, `accept_price`, `walk_away`, `find_alternatives`, `my_games`,
`game_status`, `pay_my_share`, `decline_game`, `cancel_booking`.

**What the platform guarantees, whatever the agent does**

- A token acts for one player, is shown once and kept as a hash, and can be revoked. It can't change the player's
  limits, save a payment method or make tokens: those need the person, signed in.
- The mandate (per-game, per-week, venues) is checked before a venue sees an offer, and again before an agent pays.
- A venue's floor is never sent anywhere; only its policy price and scheduled counters are. Five negotiations per
  player, venue and day, and each expires in 15 minutes.
- Only structured fields cross between agents. Every line on the Activity page is written by code from the facts.
- Nothing is charged until a person approves in PayPal, or within the limits they set for Vault autopay.
- Every PayPal POST carries a `PayPal-Request-Id` from the booking and step, and is journaled before it is sent.

## PayPal

| PayPal | In Join |
|---|---|
| Orders v2, intent `AUTHORIZE`, approval links | The organizer's guarantee and each player's share |
| Authorizations: capture (final), void | Lock the court; release it; decline |
| Captures: refund | Cancellation more than 24 h ahead |
| Payouts | The venue's money, after the game, net of fees |
| Vault v3 (setup token → payment token → `vault_id`) | Save PayPal once; the agent pays within the mandate |
| Webhooks + `verify-webhook-signature` | Confirmations (order approved, captures, payouts) |
| PayPal MCP server / Agent Toolkit | A venue's own agent reconciles and invoices ([examples/venue](examples/venue/README.md)) |

The player's mandate follows the shape of the Agent Payments Protocol's Intent Mandate (conditions a person approved
in advance, under which an agent may act).

## Layout

| Path | What |
|---|---|
| `api/src/negotiate/` | Venue policy (`policy.js`) and the negotiation engine (`engine.js`) |
| `api/src/pay/` | PayPal client (`paypal.js`), the stand-in (`mock.js`), settlement (`settle.js`) |
| `api/src/ops.js` | What an agent can do; MCP (`mcp.js`), REST and A2A (`a2a.js`) all call it |
| `api/src/alternatives.js`, `mandate.js`, `auth.js`, `activity.js` | Alternatives, limits, tokens, the activity log |
| `api/data/world.json` | The made-up demo town (USD, placed on San Jose, CA) |
| `web/` | The website (React, Vite) |
| `examples/` | Agents from outside: scripted, Claude, venue |

## What's new since 1 October 2026

Join began from our earlier project Serve, imported unchanged as the [`baseline`](../../tree/baseline) commit. Join
keeps a few of Serve's pure functions (free-time intersection, travel time, the venue in the middle, the demo
timetable, atomic JSON writes) and its visual design. Everything else was removed (Serve's own models, guards,
memory, voice, video, Messenger, the community loop, the feed) or written new for this hackathon: the negotiation
layer, the map alternatives, mandates, per-player tokens, the PayPal settlement, the MCP / REST / A2A interfaces, the
activity log, the website and the examples.

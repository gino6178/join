# Join: technical overview

For reviewers. Every claim below points to a file in the repository (`https://github.com/gino6178/join`). The section
"What has and hasn't been verified" separates what ran against the real PayPal sandbox from what is only tested against
Join's stand-in. Please challenge anything that doesn't match the code.

## 1. What Join is

Join is a marketplace for getting a group together (a sports court, a karaoke room, an escape room, a board game table,
a barbecue pit, a dinner table). People's own AI agents use it to find who is free, negotiate the price with a venue,
split the cost and settle it with PayPal.

**Join's server runs no AI model and holds no AI key.** It is the market and its rules:
- the venues' negotiation policies
- each person's spending mandate
- settlement with PayPal
- an activity log of everything the agents did

Agents reach it over MCP, REST or A2A, with a per-person token. For people without an agent, the website has its own
(§10.1): it runs in the person's browser and calls the same operations with their session.

## 2. Architecture

```
 People's agents (Claude Code, Claude API, any MCP / A2A / HTTP client)
        |  Bearer join_<token> (one person each)
        v
 +-------------------------- api/ (Node 20, Express) ------------------------------+
 |  mcp.js (MCP, Streamable HTTP, stateless)   a2a.js (A2A JSON-RPC)   /api/agent   |
 |                         \            |             /                            |
 |                          ops.js: the 17 agent operations                         |
 |        /            |               |                 \               \          |
 |  negotiate/     alternatives.js   mandate.js         pay/settle.js   activity.js |
 |  policy.js                                           (state machine)             |
 |  engine.js                                           pay/paypal.js  --> PayPal REST (sandbox)
 |                                                      pay/toolkit.js --> PayPal Agent Toolkit
 |                                                      pay/mock.js (stand-in without keys)
 |  world.js (town, venues, offers, people)   proof/ (receipts, Merkle, EVM anchor)    
 |  auth.js (sessions, agent tokens)          store.js (atomic JSON files, api/data/state)
 +---------------------------------------------------------------------------------+
        ^                                                   ^
        | session cookie                                     | PayPal webhooks, return URLs
 web/ (React, Vite): Activity, Plans, Map, Limits, Connect, Venue view (Bryntum), Receipt,
      Join's website agent (Qwen via WebLLM or rules, in the browser) --> /api/scout/<tool>
```

| Area | Files (lines) |
|---|---|
| Server, routes | `api/src/server.js` (205) |
| Agent operations | `api/src/ops.js` (145), `api/src/mcp.js` (67), `api/src/a2a.js` (39) |
| Negotiation | `api/src/negotiate/policy.js` (61), `api/src/negotiate/engine.js` (170) |
| Settlement | `api/src/pay/settle.js` (495) |
| PayPal client | `api/src/pay/paypal.js` (135), `api/src/pay/toolkit.js` (78), `api/src/pay/mock.js` (128) |
| Mandates, alternatives, auth, log | `mandate.js` (38), `alternatives.js` (57), `auth.js` (58), `activity.js` |
| Receipts | `api/src/proof/receipts.js` (96), `merkle.js`, `anchor.js` (33) |
| World and storage | `api/src/world.js` (98), `api/data/world.json`, `api/src/store.js` (37) |
| Website | `web/src/**` (about 1,000 lines) |
| Examples | `examples/scripted-agent.mjs`, `claude-agent.mjs`, `venue-agent.mjs`, `toolkit-cli.mjs`, `verify-receipt.mjs` |
| Website agent | `web/src/scout/understand.js`, `web/src/scout/agent.js`, `web/src/components/AgentDrawer.jsx` |
| Tests | `api/test/*.test.js`: 29 tests |

**Money is integer cents inside, USD strings outward.** Times are the town's local time: the process sets `TZ` from
`world.json` (`America/Los_Angeles`), and the website renders in that zone (`world.js`, `web/src/api.js`).

## 3. Data model (api/data/world.json)

- `activities[]`: `{ id, name, kind, unit (court | room | table | pit), min, max (people per unit), minutes[] (allowed lengths) }`. There are 11, such as badminton, karaoke, "escape room", "board games", bbq and "hot pot".
- `venues[]`: `{ id, name, x, y, open, offers: { <activity>: { units, per: "hour" | "person", price } }, policy, payee }`. There are 10.
- `venue.policy`: `{ style: firm | standard | eager, floorPct, offPeak: { pct, before }, group: { min, pct }, lastMinute: { withinHours, pct }, rounds }`. Venues can override it through the website; the overrides are stored in `venue-policies.json`.
- `players[]`: `{ id, name, area: { x, y }, free: ["Fri 18-23", ...], interests[], level?, paypal }`. All are made up.
- `publicPlaces[]`: free, first-come places. They are never booked and never paid for.

**State** is kept in JSON stores under `api/data/state/`: `negotiations`, `bookings`, `mandates`, `tokens`, `activity`,
`receipts`, `venue-policies` and `paypal-standin`. Each write goes to a temporary file, is fsynced, then renamed over the
old one (`store.js`). Tests keep all state in memory.

## 4. Negotiation (api/src/negotiate/)

### 4.1 Pricing (policy.js `price`)
- **list:** per-hour units cost `price × minutes / 60`; per-person units cost `price × people`.
- **discounts:** off-peak (a weekday booking that ends before `offPeak.before`), group (at least `group.min` people) and last-minute (starting within `withinHours`). They add up, capped at 30%.
- **ask** = `max(floor, round(list × (1 − discounts)))`, where **floor** = `round(list × floorPct)`.
- `cheaperTerms` suggests other start times within ±2 hours, and the group size that would earn the group rate, but only when that lowers each person's share.

### 4.2 Protocol (engine.js)
- **States:** `open → agreed | rejected | expired | cancelled`.
- **TTL** is 15 minutes. **Quota:** 5 negotiations per person, venue and local day.
- **Concessions:** `askAt(q, steps)`, where the room to move is `(ask0 − floor) × {firm 0, standard 0.5, eager 1}`, spread evenly over `rounds`.
- **`offer(amount)`:**
  1. If the share at `min(amount, ask)` is over the organizer's mandate, return `over_mandate`. The venue never sees the offer.
  2. If `amount ≥ ask`, agree at `ask`.
  3. If the negotiation is already final, reject it and attach alternatives.
  4. Otherwise `round += 1`. If the offer is serious (`amount ≥ 0.7 × ask`), also `steps += 1`. Then `next = askAt(ask0, steps)`. If `amount ≥ next`, agree at `amount`. Otherwise counter at `next`, which is final once `round ≥ rounds` or `next == floor`.
- **Lowballs** (under 70% of the current ask) use up a round and the venue doesn't move. This was added after a test agent showed that three $1 offers used to walk the venue down the whole schedule.
- **`accept`** agrees at the current ask, after the mandate check and a check that a unit is still free.
- **The floor is never serialized** to agents: `view()` leaves it out, and a test asserts that.
- Only the organizer may offer, accept or walk away. Every invited player can read the negotiation.
- Group size and booking length are checked against the activity before anything else.

### 4.3 Alternatives (alternatives.js)
- **Candidates:** every other venue offering the activity whose unit can take the group, at start offsets 0, −30, +30, −60 and +60 minutes, with a free unit.
- **Rank:** bookable before public, then within budget, then the smallest time shift, then the shortest longest trip, then price.
- At most one public place is included. The reason given for each candidate is written by code.

## 5. Mandates (api/src/mandate.js)

- **Fields:** `{ perGame (per booking), perWeek, venues | null, autopay }`, in cents. The shape follows the AP2 Intent Mandate.
- **Who can set it:** only the person's web session (`PUT /api/mandate`). Agent tokens can read it, never write it.
- **Where it is checked:**
  - before an offer or accept reaches the venue (engine)
  - before an agent pays from Vault (settle `startPayment`, using `spentAround`, which sums shares within ±3.5 days)
  - before an organizer accepts covering a bigger share (`answerShare`)

## 6. Settlement (api/src/pay/settle.js)

### 6.1 States

| From | Event | To |
|---|---|---|
| (deal agreed) | a unit is held for the organizer | `awaiting_organizer` |
| `awaiting_organizer` | the organizer authorizes the **whole** total | `held` |
| `awaiting_organizer` | 10 minutes pass (`ORGANIZER_MS`) | `released` (nothing charged) |
| `held` | every invitee who joined has authorized, or 20 minutes pass (`SHARES_MS`) | `locking` → `locked` |
| `awaiting_organizer`, `held` | the organizer cancels | `cancelled` (every authorization voided) |
| `locked` | the organizer cancels at least 24 hours before the start | `refunded` (every capture refunded) |
| `locked` | the end time passes | `played` |
| `played` | Payouts to the venue (net of fees) | `venue_paid` |

### 6.2 Who pays what
- The split is even: everyone pays `floor(total / n)` and the organizer pays the remainder.
- **The organizer's order** is an Orders v2 order with intent `AUTHORIZE` for the whole total. It is the guarantee, so nobody can hold a unit for free.
- **Invitees** are invited when the booking becomes `held`, and nothing is started for them until they say yes (`pay_my_share`). Each one who joins gets their own `AUTHORIZE` order for their share.
- **On lock**, each authorized share is captured in full with `final_capture: true`. Then the organizer's authorization is captured for `total − sum(captured shares)` with `final_capture: true`, so the organizer covers anyone who didn't pay. Everything else is voided or dropped.
- **Negotiated split:** before joining, an invitee may ask for a smaller share (`proposeShare`: two asks, one open at a time). The organizer accepts or refuses (`answerShare`). Accepting moves the difference onto the organizer's share, and is refused if that would break the organizer's mandate.
- **The venue is paid after the end time,** with Payouts, of the net of captures (`seller_receivable_breakdown.net_amount`). This is because a claimed payout can't be pulled back, and cancellation stays refundable until 24 hours before the start.

### 6.3 How a payment is authorized (`startPayment`)
- **Vault:** if the person saved PayPal and `autopay` is on and the mandate fits, the order is created with `payment_source.paypal.vault_id` and authorized at once.
- **Sandbox test card:** with `PAYPAL_TEST_CARD=1`, the order is created with PayPal's published sandbox card in `payment_source.card` and authorized. This is a demo stand-in for a payer's approval, it is labelled as such in the log, and it is sandbox only.
- **Otherwise:** the order returns an approval link, `PAYER_ACTION_REQUIRED`. The person approves either through the JS SDK v6 button on the page or through the link. The return URL, polling in `tick()`, or the `CHECKOUT.ORDER.APPROVED` webhook then call `approved()`, which authorizes the order.

### 6.4 Reliability
- Each PayPal POST goes through `paypalStep`, which writes `started` and then `done` or `failed` to the booking's journal, and sends `PayPal-Request-Id = <booking>:<step>[:<player>]`. Repeating a step after a crash is therefore the same call to PayPal.
- `serial(bookingId)` runs one operation per booking at a time, so a webhook and a poll can't both capture.
- `tick()` runs every `TICK_MS` (5 s). It handles the expiries, the lock on timeout, played, payouts, payout status, the paying-back invoices and the extras invoices.
- **Webhooks only confirm;** they never drive state alone. They cover `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.*` (a refund finds its capture through `links[rel=up]`), `PAYMENT.PAYOUTS-ITEM.*`, `INVOICING.INVOICE.PAID` and `CUSTOMER.DISPUTE.CREATED`. Signatures are checked with `verify-webhook-signature`, re-sending the raw body unparsed.

### 6.5 Loose ends
- **Paying the organizer back** (`requestReimbursement`): only for someone who joined (said yes) and whose payment never went through. Join sends that person an Invoicing v2 invoice; when PayPal says it is paid, Join sends the same amount to the organizer with Payouts. Someone who declined or never answered owes nothing.
- **Extras** (`billExtras`): a venue bills the organizer through the Agent Toolkit's `create_invoice` and `send_invoice`. The same items for the same booking return the existing invoice instead of a second one. When the invoice is paid, the amount goes to the venue with Payouts.
- **Disputes:** found with `list_disputes` and matched to bookings by capture id. `answerDispute` sends Join's signed receipt as evidence (Disputes API `provide-evidence`, multipart).

## 7. PayPal integration (api/src/pay/)

| Product | Calls | Code |
|---|---|---|
| OAuth | `POST /v1/oauth2/token`; also with `response_type=client_token` for the browser | `paypal.js` `auth`, `clientToken` |
| JS SDK v6 | `web-sdk/v6/core`, `createInstance`, `findEligibleMethods`, PayPal / Pay Later / Venmo sessions, `session.start` | `web/src/components/PayPalButtons.jsx` |
| Orders v2 | create (`AUTHORIZE`; `paypal`, `vault_id` or test-card source), get, authorize | `createOrder`, `getOrder`, `authorizeOrder` |
| Payments | capture an authorization (`final_capture`), void, refund a capture, get a capture | `capture`, `voidAuthorization`, `refund`, `getCapture` |
| Payouts | create a batch, get a batch | `payout`, `getPayout` |
| Vault v3 | setup token, payment token | `vaultSetup`, `vaultToken` |
| Invoicing v2 | create, send, get | `invoice`, `getInvoice` (paying back); the toolkit's tools (extras) |
| Disputes | provide-evidence | `provideEvidence` |
| Webhooks | list and create subscriptions; verify signature | `ensureWebhook`, `verifyWebhook` |
| Agent Toolkit 1.11 | `list_transactions`, `create_invoice`, `send_invoice`, `get_invoice`, `list_disputes` through `PayPalAPI.run`; and as an in-process MCP server (`PayPalAgentToolkit`) | `toolkit.js`, `examples/venue-agent.mjs`, `examples/toolkit-cli.mjs` |

**Whose account it is.** All calls run on Join's platform app. Join is the merchant that captures and invoices, and it
pays venues with Payouts. The production path is multiparty (the venue as `payee`, `platform_fees`, Partner
Referrals); it isn't built, because partner onboarding is gated.

**Stand-in** (`mock.js`, used when no keys are set): the same interface in memory, persisted, with a simulated approval
page at `/mock-paypal/approve`, a 3.49% + $0.49 fee, request-id idempotency, and answers for the toolkit's tools.

## 8. Agent interfaces

**Tools.** MCP (`/mcp`), REST (`POST /api/agent/<tool>`) and A2A (`/a2a`, `message/send` with one data part
`{action, ...args}`) offer the same 17 tools:

| Group | Tools |
|---|---|
| Reading | `whoami`, `list_activities`, `list_venues`, `find_options` |
| Negotiating | `start_negotiation`, `make_offer`, `accept_price`, `walk_away`, `find_alternatives` |
| Plans and payment | `my_plans`, `booking_status`, `pay_my_share`, `propose_share`, `answer_share`, `request_reimbursement`, `decline_invite`, `cancel_booking` |

- MCP is stateless: one server and one transport per request, with JSON responses. Inputs are validated with zod, the activity enum is built from `world.json`, and there are read and write annotations. Server instructions describe the rules.
- The A2A Agent Card is at `/.well-known/agent-card.json`, with HTTP bearer security.
- Every operation writes an activity entry in code-made words, visible only to the people involved (`activity.js`), and streamed to the website over SSE.

**People and venues on the website.**
- Session cookies: `join_session` for a person, `join_venue` for venue staff. Both are `HttpOnly; SameSite=Lax`. Demo sign-in picks a made-up person or venue; there is also `/demo?as=<id>`.
- Agent tokens: `join_<24 random bytes>`, stored as SHA-256, labelled, revocable, with last-used tracking (`auth.js`).
- Rate limits: 120 requests a minute per caller on `/mcp`, `/api/agent` and `/a2a`; 30 a minute on sign-in and tokens.

## 9. Receipts (api/src/proof/)

- **Issued on** `locked`, `refunded` and `venue_paid`.
- **Body:** the negotiation history, the split rule, and each payment with its role, share, status, captured amount, method (`via`) and PayPal order, authorization and capture ids. Players appear only as `sha256(salt:id)`, with one salt per receipt; each player's own copy includes their salt. Also the payout.
- **Hash:** canonical JSON (keys sorted), then SHA-256, then an Ed25519 signature. The key is made on first run and published at `/.well-known/join-receipts.json`.
- **Batching:** every `ANCHOR_MS`, open receipts go into a SHA-256 Merkle tree (pairs hashed in sorted order, an odd node carried up). Each receipt keeps its proof path.
- **Anchoring:** optional, on any EVM chain (`anchor.js`, viem). With `ANCHOR_RPC_URL` and `ANCHOR_PRIVATE_KEY`, a root is sent as the data of a zero-value transaction to self, `0x4a4f494e<root>`. No token or contract.
  - Mode `each` (the default on chain id 31337): every batch root goes on chain. Used for local testing with `npm run chain` (a Hardhat 2.29.1 node).
  - Mode `seal` (the default elsewhere): batches stay off chain; `POST /api/receipts/seal` (admin) puts one Merkle tree over all unsealed batch roots in one transaction, and each receipt gets its batch's path to the seal root. This is the single public proof for production (Base Sepolia planned).
  - `/.well-known/join-receipts.json` publishes the keys, the chain (name, id, sending address, mode) and the seals.
- **Verifying:**
  - `web/src/pages/Receipt.jsx` checks the hash, the Merkle path and the Ed25519 signature (WebCrypto) in the browser.
  - `examples/verify-receipt.mjs` shares no code with the server, and can also read the transaction over JSON-RPC.
- **What a receipt doesn't prove:** that PayPal moved the money. That is PayPal's record, which the receipt points to by id.

## 10. Website (web/)

| Page | What it does |
|---|---|
| Activity | The live log, plus "Waiting on you": approvals with SDK v6 buttons, invitations, invoices to pay back |
| Plans | The stepper, a payments table, actions (join, decline, cancel, ask to pay less, answer, ask to be paid back), extras, receipt links |
| Map | An SVG town map with over-budget and alternatives overlays |
| Limits | Edit the mandate; Vault save and remove |
| Connect | Tokens; Claude Code, Claude Desktop, REST and A2A snippets |
| Venue view | Bryntum Scheduler (`PlaceScheduler.jsx`: one row per unit, dashed bars while held, solid when locked, refreshed every 3 s); policy editor; reconciliation, extras and disputes (`VenueMoney.jsx`) |
| Receipt | Checks a receipt in the browser |

### 10.1 Join's website agent (web/src/scout/, components/AgentDrawer.jsx)

For people who don't bring an agent. A drawer ("No agent? Ask Join's") asks what they want, then acts as them.
- **Understanding, in the browser.** `understand.js` turns messages into a brief `{activity, dates, from, to, players, with, budget}` and asks for what's missing (activity, day, group size).
  - Qwen2.5-1.5B-Instruct through WebLLM on WebGPU, downloaded only when the person clicks and cached by the browser: the `q4f16_1` build (about 1 GB) on GPUs with `shader-f16`, the `q4f32_1` build otherwise. Its output is held to a JSON schema, then checked by code (known activities, group size 2-12, budget range, known friends).
  - Without WebGPU, or before the download: a rules reader (English and Chinese keywords, weekdays, numbers, "$").
  - WebLLM is a separate 6 MB chunk loaded on demand; the page's own script stays about 300 kB.
- **Acting, in code.** `agent.js` runs fixed steps through `POST /api/scout/<tool>` (session cookie): `find_options` (three cards with reasons), then `start_negotiation`, offers never under 72% of the ask (a lowball doesn't move venues), halfway on counters, accepting when the price is within the budget and asking the person when it isn't, and `find_alternatives` when the venue says no.
- **Same rules as any agent.** The route allows 10 read and negotiation tools only (no paying, cancelling or inviting), applies the person's mandate, and is rate-limited like `/api/agent`. Activity entries carry the client "Join website agent, Qwen in the browser" or "..., rules in the browser".
- **Paying stays with the person:** after the deal the drawer shows the PayPal SDK v6 button for the guarantee (or, with the sandbox test card, the authorization result).

## 11. Tests (api/test/, `npm test`)

There are 29, using Node's test runner, and they run against the stand-in with state in memory.
- **Negotiation (12):** pricing, the floor never leaking, the serious-offer schedule, lowballs, agreeing at an offer, the mandate before the venue, organizer-only actions, expiry and quota, walking away, alternatives' ordering, bad input, venue policy edits.
- **Receipts (3):** Merkle proofs for 1 to 13 leaves; signature, tamper detection and hashed players; a seal over several batches.
- **Website agent (3):** the rules reader in English and Chinese, weekends and named friends, a brief built over several messages.
- **Settlement (10):**
  - guarantee first, invitations before any charge, the full lock and payout
  - timeout with the organizer covering, release, void and refund cancellation
  - Vault autopay within the mandate and approval above it
  - request-id idempotency
  - the negotiated split and the over-mandate refusal
  - paying the organizer back (invoice, then payout)
  - the venue's toolkit flows: extras and no double billing, reconciliation, a dispute answered with the receipt
- **End to end (1):** starts the server, runs `examples/scripted-agent.mjs` over MCP for four agents, checks each person's activity, and checks that an agent token can't change the mandate.

## 12. What has and hasn't been verified

**Ran against the real PayPal sandbox (30 Oct 2026):**
- OAuth and the client token. The JS SDK v6 PayPal button rendered on the page.
- Orders `AUTHORIZE`: through the approval link (`PAYER_ACTION_REQUIRED`), and with the test card.
- Partial `final_capture`; void; refund; Payouts batches; a Vault setup token.
- Invoicing: create, send, status.
- Agent Toolkit: `list_transactions`, `create_invoice`, `send_invoice`, `get_invoice`, `list_disputes`.
- Full bookings to `locked` for badminton, karaoke and board games, including a cancellation before the lock (void) and after it (refunds).

**Ran by AI agents (Claude Sonnet subagents) against the sandbox:**
- Four people's agents, given one sentence, chose an activity, haggled, split (one ask to pay less accepted, one refused for the mandate) and locked a karaoke booking.
- 12 misuse attempts were all refused.
- A venue agent reconciled with the toolkit and verified an extras invoice. Its findings became fixes (§4.2, §6.5).

**Join's website agent (30 Oct 2026):**
- With the rules reader, against the PayPal sandbox: "Karaoke Friday night, 4 of us, $15 each" gave three options; the agent offered $29.16 on a $32.40 ask, the venue countered $29.40, the agent accepted, and PayPal authorized the guarantee (sandbox test card). Every step appeared on the Activity page as "Join website agent, rules in the browser".
- Qwen: the model downloaded, but WebLLM's kernels failed to compile in the Claude desktop app's built-in browser (Chrome 152) on an NVIDIA Pascal GPU, with both the `q4f16_1` and `q4f32_1` builds. The drawer fell back to rules each time. The Qwen path has not yet run end to end on a machine where WebLLM works.

**Built and tested only against the stand-in:**
- Dispute evidence.
- Webhook self-registration (it needs public HTTPS).
- Pay Later and Venmo buttons (PayPal reported them ineligible for the desktop sandbox payment).
- A buyer's approval through the SDK popup end to end (no sandbox buyer login was used).
- Payouts after a booking's end time (the demo bookings hadn't ended yet).

**Not run:**
- `examples/claude-agent.mjs` and `examples/venue-agent.mjs` through the Anthropic API (no key). Their MCP wiring is tested.
- The public seal on Base Sepolia (no testnet key yet). Anchoring ran on a local Hardhat node in both modes: `each` (a batch per block) and `seal` (two batches and three receipts in one transaction).

## 13. Known limitations and open risks (review targets)

1. **Single process, JSON files.**
   - No database or locking across processes. `serial()` is in memory, so two server instances on the same state would race.
   - Web sessions are in memory and are lost on restart.
2. **Polling.** `tick()` scans every booking every 5 seconds. Fine for a demo, not at scale.
3. **Marketplace money flow.** Join holds the funds and pays out (Payouts) instead of using multiparty. The venue's reconciliation and disputes run on Join's account.
4. **Authorization windows.**
   - Join assumes an authorization stays capturable during a 20-minute hold.
   - There is no reauthorization path for long holds.
   - `PAYMENT.CAPTURE.PENDING` and `DECLINED` are only partly handled: a failed capture leaves the booking `held` with an error.
5. **Payout failure** is retried on the next tick with the same batch id. There is no alerting.
6. **Demo-only surfaces:**
   - Demo sign-in and `/demo` have no password (they turn off with `DEMO_SIGNIN=0`).
   - `/api/demo/dispute` works on the stand-in only.
   - `/api/receipts/batch` is open in demo mode.
7. **Cookies.** There is no CSRF token; protection relies on `SameSite=Lax` and JSON bodies. Cookies have no `Secure` flag.
8. **The test card** sends a raw (published, sandbox) card number from the server. It is sandbox only and behind a flag, but it isn't a production pattern.
9. **Concession schedule.** It is per negotiation, and a new negotiation restarts it. The quota (5 per venue per day) limits that, but several people coordinating could still learn more about the floor.
10. **Time.** The process sets `TZ` globally from `world.json`. A real deployment with venues in several time zones would need per-venue zones.
11. **The world is made up.** There are no real venues or booking systems, and availability is a deterministic hash (`world.js demoVenues`).
12. **Rate limiting** is in memory and keyed per process.

## 14. How to run and review

```
npm run setup          # api, web, examples; builds the website
npm start              # http://localhost:8790 (the stand-in without keys)
npm run demo           # four agents over MCP; JOIN_ACTIVITY=karaoke for another plan
npm test               # 29 tests
npm run chain          # optional: a local Hardhat node for receipt anchoring
```

- **Sandbox:** set `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` in `api/.env` (template: `api/.env.example`), and optionally `PAYPAL_TEST_CARD=1`.
- **Venue tools from a shell:** `node examples/toolkit-cli.mjs list`.
- **Where to look first:** `api/src/pay/settle.js` (money), `api/src/negotiate/engine.js` (bargaining), `api/src/mcp.js` (the agent contract) and `api/src/pay/paypal.js` (PayPal calls).

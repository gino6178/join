# Join against the judging criteria

The PayPal AI Hackathon judges five criteria with equal weight: Technological Implementation, Design, Potential
Impact, Innovation and Presentation. This page maps each one to what Join does, where it is in the code, and how to
see it in a few minutes. Every claim points to a file; the last section lists what has not been run, so nothing here
needs to be taken on trust.

**See it fast:** `npm run setup`, `npm start`, then open http://localhost:8790/demo?as=you&go=activity?agent=1 (no
keys needed; PayPal is simulated and says so). In another terminal, `npm run demo` runs four agents over MCP.
`npm test` runs 47 tests; `npm --prefix api run bench` runs the negotiation benchmark. Details: [TECHNICAL.md](TECHNICAL.md).

---

## 1. Technological Implementation

**Nine PayPal products in one money flow, each doing a job only it can do.**

| PayPal | What it does in Join | Code |
|---|---|---|
| Orders v2, intent `AUTHORIZE`, one order per payer | The organizer guarantees the whole price; each friend authorizes their own share | `api/src/pay/settle.js` `startPayment` |
| Authorizations: partial `final_capture`, void | At the lock, each share is captured, and the organizer's authorization only for what's left (whoever didn't pay); a decline or a release voids | `settle.js` `lock`, `release` |
| Captures: refund | Cancelling more than 24 hours ahead refunds everyone | `settle.js` `refundAll` |
| Payouts | The venue is paid after the game, net of fees; an organizer is paid back; a venue's extras are paid out | `settle.js` `tick` |
| Vault v3 | Save PayPal once; the person's agent pays within limits only they can set, without a redirect | `settle.js` `vaultStart`, `startPayment` |
| Invoicing v2 | A friend who joined but never paid gets an invoice; a venue bills extras | `settle.js` `requestReimbursement`, `billExtras` |
| Disputes `provide-evidence` | The moment PayPal reports a dispute, Join answers it with the booking's signed receipt and how that payer approved | `settle.js` `defend`, `webhook` |
| Webhooks: management API and `verify-webhook-signature` | Join subscribes itself to 14 events once it has a public HTTPS address, and checks every event's signature on the raw body | `api/src/server.js`, `api/src/pay/paypal.js` |
| JS SDK v6 (browser-safe client token) | The PayPal button (and Pay Later / Venmo where eligible) in a popup on Join's page | `web/src/components/PayPalButtons.jsx` |
| PayPal Agent Toolkit | Join's back office for venues (`list_transactions` reconciliation, `create_invoice`, `send_invoice`, `get_invoice`, `list_disputes`), and a venue's Claude agent with the toolkit as an in-process MCP server | `api/src/pay/toolkit.js`, `examples/venue-agent.mjs` |
| `PayPal-Request-Id` on every POST, journaled first | A step repeated after a crash is the same PayPal call, not a second charge | `settle.js` `paypalStep` |
| Sandbox test card (optional) | Lets a whole group's payments run in a demo without a buyer sign-in | `PAYPAL_TEST_CARD=1` |

**Engineering that holds up under agents:**
- **A settlement state machine** (`awaiting_organizer → held → locked → played → venue_paid`, or released / cancelled /
  refunded), driven by return URLs, polling and webhooks, any of which is enough, with a per-booking lock so two
  signals never race (`settle.js`).
- **Agents use the same 17 tools three ways:** MCP (Streamable HTTP), REST and A2A with an Agent Card
  (`api/src/mcp.js`, `api/src/a2a.js`). Tool descriptions are written for the model that reads them.
- **Limits enforced in code before a venue sees an offer** (`api/src/mandate.js`, `negotiate/engine.js`): spending
  (your share per booking and per week, counting what you covered for friends) and guaranteeing (how much your agent
  may guarantee for a group on its own) are separate, and agent tokens can read them, never change them.
- **Standards that do work:** AP2 mandates in AP2's own JSON schemas, which an agent must present with every offer,
  accept and payment and Join checks before acting (`api/src/proof/mandates.js` `authorize`);
  receipts in an RFC 6962 transparency log with C2SP checkpoints and witness cosignatures (`api/src/proof/tlog.js`,
  `examples/witness.mjs`); signed agent requests per RFC 9421 (`api/src/auth.js`); WebMCP (`web/src/webmcp.js`).
- **Tested by agents, not only by us:** Claude Sonnet agents played friends and a venue on the sandbox, tried a dozen
  ways to misuse the tools, and tested the website agent with about 220 requests. Their findings became fixes and
  regression tests (TECHNICAL.md §12).

**How to see it:** sign in, ask the drawer for "karaoke Saturday night, 4 of us, $15 each", open the booking in Plans,
use the demo panel to play the friends, and watch each payment's PayPal status, the capture amounts and the receipt.

## 2. Design

- **You see every step an agent took.** The Activity page is a live log in sentences Join writes from the facts:
  nothing on it is model-written (`web/src/pages/Activity.jsx`, `api/src/activity.js`).
- **Nobody has to bring an agent.** "No agent? Ask Join's" opens a drawer that asks what you want in English or
  Chinese, shows three options with reasons and tags (group discount, "venue haggles readily"), and says what a deal
  would commit you to before it negotiates (`web/src/components/AgentDrawer.jsx`).
- **One window for the whole group.** In demo mode the organizer can play each invited friend from the Plans page
  (pays, asks $1 less, can't come, time runs out), so judges see the split, the lock and the captures without four
  browsers (`web/src/pages/Games.jsx`, `Seats`).
- **The negotiation as a chart:** the venue's asks stepping down, the agent's offers, lowballs marked (`Curve`).
- **Recommendations you can trust:** each option shows its verified-review score, what people liked and complained
  about (counted, not generated), how it fits what your group cares about (learned from your own past reviews), and a
  warning if someone in your group rated the venue badly.
- **Shopping, then a choice:** the website agent compares the venue you picked with up to two others and offers the
  cheapest as buttons; balances with friends are netted across plans and settled with one invoice.
- **The venue's view:** Bryntum Scheduler with payment state driving the schedule (dashed while the group pays, solid
  when locked), and a dashboard of what Join brought in, counted from its bookings (`PlaceScheduler.jsx`,
  `VenueMoney.jsx`).
- **Receipts anyone can check:** the receipt page verifies in the browser and says how long it took.
- **Light and dark themes**, keyboard-reachable controls, and no screen that needs a second window to make sense.

## 3. Potential Impact

- **The problem is common and the cost is real.** Every group plan (a court, a karaoke room, an escape room, a
  barbecue) ends with someone fronting the money and chasing friends. Agents can already find a time; they stop at the
  money. Join is the part they can't do alone: a venue that negotiates by its own rules, and a split that settles.
- **For organizers:** they are never left out of pocket without a trail. A friend who joined and didn't pay gets a
  PayPal invoice, and the organizer is paid back with Payouts.
- **For venues:** a booking is held only after a PayPal authorization guarantees it, so a room is never blocked for
  free; groups pay in full before a booking is locked; off-peak rules fill quiet hours at a price the venue chose; the
  money arrives with Payouts after the game. The dashboard shows these from real bookings, not estimates.
- **For PayPal:** one group plan becomes several PayPal payments on both sides. Four friends booking a court are four
  orders, four authorizations, four captures and a payout, plus invoices and payouts when someone doesn't pay or the
  venue bills extras. A plan that would otherwise be settled in a group chat runs on PayPal.
- **Any group activity, any agent:** 11 activities across 10 venues in the demo town, and any MCP or A2A agent can use
  it. Multiparty (the venue as `payee`, Join's fee as `platform_fees`) is the production path once partner
  onboarding is available (README, "Why Payouts and not multiparty (yet)").

## 4. Innovation

- **A negotiation layer between agents and venues.** Each venue sets its own policy (list price, off-peak, group and
  last-minute discounts, a concession schedule, and a floor that's never revealed). Offers under 70% of the ask use up
  a round and don't move the venue, so a floor can't be found by binary search; the last counter is best and final
  (`api/src/negotiate/`). One of our test agents found the first version rewarded three $1 offers; that rule fixed it.
- **The guarantee as the commitment device.** In agent-to-agent deals, "accept" alone could hold a room for free. Join
  makes the organizer guarantee the whole price with a PayPal authorization first, then captures each friend's share
  and only the remainder from the organizer.
- **Limits an agent can't talk its way past.** The person's limits are enforced in code before a venue sees an offer
  and before any payment, whatever an agent is told; Join also signs them as AP2 mandates (below).
- **A website agent with no AI key.** Qwen2.5 0.5B runs on Join's own server (Ollama) and is asked one narrow
  question (which activity a sentence means); rules decide days, times, group size and budget, and fixed code does
  the haggling. We measured where a model this small invents things and kept it out of those decisions.
- **Receipts without a blockchain.** A transparency log as Certificate Transparency runs it: checkpoints signed by Join
  and cosigned by witnesses (a venue, anyone) who check that the log only grew. No fees, no waiting for blocks. Join
  sends the receipt and the AP2 mandates to PayPal by itself when a payment is disputed.
- **Reviews that can't be faked by agents.** Only people who paid can review, agents only read, and the agent ranks
  venues with a Bayesian score and "least misery" for the group, so one friend's bad experience counts.
- **Negotiation rules, checked.** Six buyer strategies played against every venue's rules (docs/NEGOTIATION.md): the
  rules behave as designed (lowballs don't move a venue, nothing goes under a floor, conceding early loses deals), and
  Join's website agent uses the strategy that pays least while always closing, then shops across venues.

## 5. Presentation

- **The video** follows [demo-video-script.md](demo-video-script.md) (2:45): the problem, an agent and the website
  agent planning, the negotiation chart, the PayPal guarantee and captures with the demo panel, the receipt and an
  automatic dispute answer, limits that hold, the venue's figures. Every number on screen comes from the run.
- **Docs for every reader:** the [README](../README.md) for a quick start and the PayPal map,
  [SUBMISSION.md](SUBMISSION.md) for the Devpost fields, [TECHNICAL.md](TECHNICAL.md) for reviewers (with a section on
  what has and hasn't been verified), and this page.
- **Runs in three commands with no keys,** and on the PayPal sandbox with two.

## Prizes this project fits

- **Best Use of PayPal + AI** and **Best Use of Agentic Commerce:** agents negotiate, commit within mandates, and settle
  with PayPal; the PayPal Agent Toolkit runs the venue's back office.
- **Bryntum (sponsor):** Bryntum Scheduler shows a venue's rooms and courts, and PayPal payments drive the schedule:
  a booking is dashed while the group pays and turns solid when everyone has (`web/src/components/PlaceScheduler.jsx`).

## What has not been run (so you don't have to find it)

- **Webhooks and dispute evidence on the sandbox:** both need a public HTTPS address or a sandbox buyer account. They
  are built and tested against Join's PayPal stand-in, and `deploy/tunnel.sh --apply` gives a running Join a public
  address so it registers its webhooks.
- **Pay Later and Venmo buttons:** PayPal reported them ineligible for a desktop sandbox payment.
- **The Claude examples** (`examples/claude-agent.mjs`, `examples/venue-agent.mjs`) need an Anthropic key; their MCP
  wiring is tested.
- Everything else listed above ran on the PayPal sandbox, on a Linux machine with an RTX 3090 on our network (TECHNICAL.md §12).

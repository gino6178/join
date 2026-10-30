# Join: Devpost submission

Everything for the Devpost form, field by field, ready to paste. Only the video link is still to come.

---

## Project name

Join

## Elevator pitch (tagline, 200 characters max)

Your AI agent gets the group together: finds who's free, haggles with the venue, splits the bill and settles it with PayPal, inside limits only you set. You see every step.

## Links

- **Code:** https://github.com/gino6178/join (public, MIT)
- **For judges, criterion by criterion:** https://github.com/gino6178/join/blob/main/docs/JUDGING.md
- **What was built during the hackathon:** https://github.com/gino6178/join/compare/baseline...main
- **Demo video:** _(YouTube link to add)_
- **Try it:** runs locally with Node 20 and no keys in three commands; see Testing instructions below. There is no
  hosted URL; the rules allow "complete setup and run instructions" instead.

## Image gallery

Upload in this order, from `docs/screenshots/`:

| File | Caption |
|---|---|
| `1-activity.png` | Every step the agents took, live: search, offers and counters, the guarantee, invitations, asks to pay less, payments |
| `2-plans.png` | A booking's payments: each share, how it was paid, the stepper from deal to venue paid |
| `3-map.png` | The town map: venues, free public places, the fairest venue and everyone's trip |
| `4-venue-bryntum.png` | The venue's courts and rooms on Bryntum Scheduler: dashed while the group pays, solid when locked |
| `5-limits.png` | Limits only the person can set, and saving PayPal (Vault) so their agent can pay within them |
| `6-connect.png` | Connecting an agent: Claude Code, Claude Desktop, REST, A2A |
| `0-sign-in.png` | Sign-in to the demo town |

---

## About the project

### Inspiration

AI agents can already find a free time and a few friends. Then they stop. Someone still has to call the venue, agree a
price, front the money and chase three people for their share. That last mile, the money, is where group plans die:
the badminton game, the karaoke night, the escape room, the barbecue. It's also the part nobody should hand to an agent
without limits and a way to check what it did.

### What it does

Join is an agent-ready marketplace for getting a group together: sports courts, karaoke rooms, escape rooms, board game
tables, barbecue pits, dinner tables. People bring their own agents (Claude, or any MCP or A2A agent), and Join
supplies the rules and the money. Someone without an agent uses Join's own, on the website.

- **Find a plan.** Who's free, and the fairest venue for each time: the one where the longest trip in the group is
  shortest.
- **Negotiate with the venue.** Each venue sets its own rules on Join: list price, off-peak, group and last-minute
  discounts, how far it comes down, and a floor that's never revealed. Agents offer and counter; a lowball doesn't move
  the venue, and its last counter is best and final.
- **Over budget? Alternatives from the map.** When a price is over a person's limit or the venue says no, the answer
  comes with other venues and free public places nearby, ranked by budget, time and trip.
- **Split it, negotiate it, pay it with PayPal.**
  - The organizer guarantees the whole booking with a PayPal authorization, so nobody can hold a room for free.
  - Friends' agents are invited; they join, decline, or ask to pay less, and the organizer's agent answers.
  - Each person pays their own share with PayPal, in a popup on the page or from saved PayPal within their limits.
  - When everyone has paid, the booking is locked and the venue is paid afterwards with Payouts.
- **Loose ends, settled with PayPal.** Someone who said yes but never paid gets a PayPal invoice, and the organizer is
  paid back with Payouts. A venue bills extras like overtime with an invoice, reconciles against PayPal's records, and
  sees what Join brought in, counted from its bookings. When a payment is disputed, Join answers PayPal by itself at
  once, with the signed receipt and how that payer approved the payment.
- **No agent? Use Join's.** A drawer on the website asks what you want ("karaoke Friday night, 4 of us, $15 each",
  or the same in Chinese), shows three options with reasons, haggles and accepts as you under your limits, then hands
  you the PayPal button. It understands people on Join's own server: rules, plus Qwen2.5 0.5B (Ollama) for
  free-form sentences like "好冷 想吃熱呼呼的鍋". Nothing to download, no AI key, no AI service.
- **Recommends with verified reviews.** Only people who booked and paid can review; the agent weighs a
  recency-weighted Bayesian score and counted praise and complaints, and steers away from a venue anyone in the group
  rated badly. Agents read reviews, never write them.
- **Shops for you.** The website agent haggles with the venue you picked and up to two others free at the same time,
  then lets you book the cheapest.
- **Balances with friends.** Across plans, what friends owe each other is netted, and one PayPal invoice settles it.
- **See every step.** The website shows each person what the agents did, in words Join writes from the facts: every
  search, offer, counter, invitation and payment.
- **Limits only people can set.** What you spend (your share per booking, per week) and what your agent may
  guarantee for a group on its own are separate limits, set on the website; agent tokens can read them, never change
  them. Before an organizer's agent accepts, it is told (and tells them) what the guarantee means: the whole price
  until friends pay, their own share unless someone doesn't, and at most the whole price.

### How we built it

- **PayPal**, run on the sandbox unless noted:
  - JS SDK v6 (a browser-safe client token, PayPal button in a popup; Pay Later and Venmo where PayPal says the payer is
    eligible).
  - Orders v2 with intent `AUTHORIZE`, one order per payer.
  - Authorizations captured with `final_capture` (partial for the organizer); voids; refunds.
  - Payouts to the venue after the booking, and to an organizer who was paid back.
  - Vault v3: a person saves PayPal once and their agent pays within their limits.
  - Invoicing v2: paying the organizer back, and venues' extras.
  - The **PayPal Agent Toolkit** as Join's back office for venues: `list_transactions` (reconciliation, with the Captures
    API when reporting lags), `create_invoice` / `send_invoice` / `get_invoice`, `list_disputes`.
  - Disputes `provide-evidence` with the signed receipt (built and tested against a stand-in).
  - Webhooks: Join subscribes itself to 14 events when it has a public HTTPS address (built and tested against a
    stand-in); every event is verified with `verify-webhook-signature`.
  - Every PayPal POST is journaled first and carries a `PayPal-Request-Id`, so a step retried after a crash is the same
    call.
- **Agents:** an MCP server (Streamable HTTP) with 17 tools, the same tools over REST, and an A2A endpoint with an Agent Card. Tool
  descriptions are written for the model that reads them. The person's mandate follows the shape of the Agent Payments
  Protocol's Intent Mandate.
- **AI:**
  - Claude is the person's agent: Claude Code over MCP, and a Claude API agent that bridges Join's MCP tools into tool
    use.
  - A venue's Claude agent loads the PayPal Agent Toolkit as an in-process MCP server.
  - We tested Join with Claude Sonnet agents playing four friends and a venue operator on the PayPal sandbox. They chose
    karaoke, haggled, split, paid and reconciled on their own. They also tried a dozen ways to misuse the tools, and Join
    refused every one. Their criticism became fixes: lowballs no longer move the venue, extras can't be billed twice, and
    replies say plainly what happened.
- **Bryntum Scheduler** shows a venue its courts and rooms, with payments driving the schedule.
- **Receipts:** Ed25519-signed and batched in SHA-256 Merkle trees; anyone can check one in the browser or with a
  script that shares no code with Join.
- **Join's website agent:** a rules reader for days, times, group size and budget (English and Chinese), and
  Qwen2.5 0.5B on Join's own server through Ollama for the one thing rules are bad at: which activity a free-form
  sentence means. Its answer is held to a JSON schema and used only when the rules found none. It calls the same tools
  as any agent.
- **Receipts without a blockchain:** each batch of receipts is an entry in an RFC 6962 transparency log with signed
  C2SP checkpoints that independent witnesses cosign after checking consistency; the browser checks a receipt, its
  inclusion and the checkpoint.
- **AP2:** Join signs the Agent Payments Protocol's open checkout and payment mandates for each agent, and the checkout
  and payment mandates of every deal, in AP2's JSON schemas; they go into receipts and dispute evidence.
- **Agents, safely:** scoped, expiring tokens, optionally tied to a key so every request is signed (RFC 9421, as in Web
  Bot Auth); a published fingerprint of the MCP tool descriptions; and WebMCP tools for a browser's own agent.
- **Negotiation, measured:** a benchmark of six buyer strategies against every venue's rules (docs/NEGOTIATION.md);
  the website agent uses the best one and shops across venues.
- Node, Express, React, Vite. 45 automated tests, including an end-to-end run of four agents over MCP.

### Challenges we ran into

- **A deal between agents is only binding if money backs it.** Without a saved payment method every payer approves in
  PayPal, so "accept" alone could hold a room for free. The organizer authorizes the whole booking first and covers
  anyone who doesn't pay.
- **A floor price that answers yes or no can be found by binary search.** Venues answer with a concession schedule
  instead, and a lowball doesn't move it. One of our own test agents found the first version rewarded three $1 offers.
- **Marketplace settlement.** PayPal's multiparty model (the venue as `payee`, Join's fee as `platform_fees`) is the
  production path, but partner onboarding is gated. A payout also can't be pulled back. So Join captures each share,
  keeps cancellations refundable until 24 hours before, and pays the venue with Payouts afterwards.

### Accomplishments that we're proud of

- **AI agents ran the whole flow on the real PayPal sandbox.** Four AI agents went from nothing but a sentence to a
  locked booking: picking the activity, haggling, an invitee asking to pay less, the guarantee, four captured shares,
  and a signed receipt.
- **Nothing on the activity page is written by a model.** Every line comes from the facts.

### What we learned

The hard part of agentic commerce isn't the agent. It's the rules around it: who can commit whom to what, when a
promise becomes binding, and how a person can check afterwards what happened.

### What's next

- Real venues' booking systems behind the venue adapter.
- Venues bringing their own agents over A2A.
- Multiparty settlement with Partner Referrals.
- Payer approval through the Agent Payments Protocol once PayPal's support for it is available.

## Built with

paypal-js-sdk-v6, paypal-orders-v2, paypal-payments, paypal-payouts, paypal-vault, paypal-invoicing,
paypal-disputes, paypal-webhooks, paypal-agent-toolkit, model-context-protocol, a2a, claude, anthropic,
bryntum-scheduler, node.js, express, react, vite

---

## Which AI tools did you use, and how?

- **Claude, as the people's agents.**
  - Join is used through MCP by Claude Code (`claude mcp add ...`) and by a Claude API agent
    (`examples/claude-agent.mjs`, `claude-opus-5-5`) that bridges Join's MCP tools into Claude's tool use.
  - A venue's Claude agent (`examples/venue-agent.mjs`) uses the PayPal Agent Toolkit as an in-process MCP server.
- **Claude Sonnet as test agents.** Agents played four friends and a venue operator against the PayPal sandbox, making
  their own decisions and reporting what confused them; we fixed what they found.
- **The PayPal Agent Toolkit** (`@paypal/agent-toolkit`): its tools run Join's venue back office (reconciliation,
  invoices, disputes) and the venue agent.
- **Qwen, for people without an agent.** Join's website agent asks Qwen2.5 0.5B, served by Ollama on Join's own
  machine, which activity a person means; searching, haggling and accepting are fixed code. Join holds no AI key and
  calls no AI service. We first tried Qwen in the browser (WebLLM); it needed a 1 GB download per person and failed on
  some GPUs, so it moved to the server.
- **Join's server is the market and the rules:** negotiation policy, mandates, settlement. Everything an
  agent does is shown to the people involved in code-written sentences.
- **Development:** built with Claude Code as a coding assistant.

## Testing instructions

**Quick start: no keys needed, about 3 minutes.** Requires Node 20+.

1. `git clone https://github.com/gino6178/join && cd join`
2. `npm run setup` installs everything and builds the website.
3. `npm start`, then open http://localhost:8790. Sign in by picking any person, or go straight to
   http://localhost:8790/demo?as=you (Alex).
4. In another terminal, `npm run demo` runs four agents over MCP: an over-budget venue, alternatives, haggling, an ask
   to pay less, the guarantee, four shares, and the lock. Then refresh the website. Other plans:
   `JOIN_ACTIVITY=karaoke npm run demo` (or `"escape room"`, `"board games"`, `bbq`, `"hot pot"`).
5. No agent? Click **No agent? Ask Join's** on the website and type a plan, e.g. "karaoke Friday night, 4 of us,
   $15 each" or "好冷 想吃熱呼呼的鍋". Without a model it uses rules; with Ollama (`ollama pull qwen2.5:0.5b`, then
   `SCOUT_LLM_URL=http://127.0.0.1:11434 npm start`) Qwen reads free-form sentences too.
6. `npm test` runs 45 tests, including the end-to-end MCP run.

Without keys, Join runs on a PayPal stand-in that moves no money and says so on every page.

**With PayPal sandbox:**

1. Copy `api/.env.example` to `api/.env` and set `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` from a sandbox app with
   Payouts, Vault and card processing enabled.
2. With `PAYPAL_TEST_CARD=1`, each share is authorized with PayPal's published sandbox test card, so the demo runs end to
   end without a buyer sign-in.
3. Without it, each payment waits for a sandbox buyer's approval: the PayPal button on the page, or the link the demo
   prints.

**Connect Claude:** on the website, Connect → Make a token. Then:
`claude mcp add --transport http join http://localhost:8790/mcp --header "Authorization: Bearer <token>"`

**Venue side:**
- Open Venue view and sign in as a venue (demo button).
- See what Join brought in, reconcile, bill extras, see disputes. With the stand-in, "Simulate a buyer's dispute" opens
  one, and Join answers it at once.

**Receipts:** a booking's receipt link opens a page that checks it in the browser;
`node examples/verify-receipt.mjs <id> --save checkpoint.txt` checks it independently and keeps the log's checkpoint;
`--head checkpoint.txt` later checks a consistency proof. `node examples/witness.mjs --register`, then
`node examples/witness.mjs`, runs a witness that cosigns checkpoints.

**Playing the friends from one window:** on Plans, as the organizer of a booking that is waiting for shares, the demo
panel lets you act as each invited friend (pays, asks $1 less, can't come) or run the clock out, and watch the
split, the lock, the capture and Bryntum change.

## Was this an existing project?

Yes, in part. Join began from our earlier project Serve (a sports social app built for another hackathon), imported
unchanged as the `baseline` commit. Join keeps a few of Serve's pure functions (free-time intersection, travel time,
the venue in the middle, a demo timetable, atomic JSON writes) and its visual design.

Everything else was removed (Serve's own AI models, voice, video, messaging) or written new during this hackathon's
submission period:

- the negotiation layer and venue rules
- map alternatives
- mandates
- invitations and the negotiated split
- per-person agent tokens
- all PayPal integration
- verifiable receipts in a witnessed transparency log, AP2 mandates, automatic dispute answers, the venue's figures
- scoped and signed agent tokens, the tool fingerprint, WebMCP, the negotiation benchmark and shopping across venues,
  balances with friends
- Join's website agent
- the MCP, REST and A2A interfaces
- the activity log
- the website with Bryntum Scheduler
- the examples

Compare: https://github.com/gino6178/join/compare/baseline...main

## Sponsor tools

- **Bryntum Scheduler** (`web/src/components/PlaceScheduler.jsx`, Venue view): one row per court, room or table. A
  booking is a dashed bar while the group is paying and turns solid the moment everyone has paid, so payment state
  drives the schedule, refreshed live.

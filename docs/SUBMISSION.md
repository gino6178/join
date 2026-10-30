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
price, front the money and chase three people for their share. The money is where group plans die, and it's the part
nobody should hand to an agent without limits and a way to check what it did.

### What it does

Join is a marketplace where agents get a group together and PayPal settles it. One plan, start to finish:

1. **Hana asks.** "Karaoke Saturday night, 4 of us, $15 each": to her own agent (Claude, or any MCP or A2A agent), or
   to Join's agent on the website if she has none. Join finds who's free, the fairest venue (shortest longest trip),
   and ranks options with verified reviews from people who paid, steering away from places someone in the group
   rated badly.
2. **The agent haggles.** Each venue sets its own rules: discounts, how far it comes down, a floor it never reveals.
   Lowballs don't move it; the last counter is best and final.
3. **PayPal makes it binding.** Hana guarantees the whole booking with a PayPal authorization, so nobody holds a room
   for free. Each friend pays their own share in PayPal (a popup, or saved PayPal within their limits). When the last
   share is in, the booking locks; anyone who didn't pay is covered by Hana's guarantee and gets a PayPal invoice.
4. **The venue gets paid after the game,** with PayPal Payouts. If a payer disputes, Join answers PayPal at once with
   a signed receipt and how that payer approved.
5. **Hana can check every step.** The Activity page shows what every agent did, in sentences Join writes from the facts
   (no model writes them). Each booking's receipt is signed and logged in a witnessed transparency log, and checks in
   the browser.

Throughout, **limits only people can set** (per booking, per week, how much their agent may guarantee for a group) are
enforced on Join's server. Agents carry a signed mandate saying what they may pay, and Join refuses anything outside it.

**Why not just Venmo?** Venmo moves money after a plan exists. Join makes the plan binding: the venue isn't held for
free, no-shows are billed automatically, and an agent can do the haggling and paying inside limits you set.

### How we built it

- **PayPal sandbox, end to end:** JS SDK v6; Orders v2 with `AUTHORIZE`, partial `final_capture`, voids and refunds;
  Payouts to venues; Vault v3 for agents paying within limits; Invoicing v2; Disputes `provide-evidence`; the **PayPal
  Agent Toolkit** as the venue's back office (reconciliation, invoices, disputes). Every POST is journaled with a
  `PayPal-Request-Id`, so a retry after a crash is the same call.
- **Agents:** an MCP server (18 tools), the same tools over REST, A2A with an Agent Card, and WebMCP for a browser's
  own agent. Scoped, expiring tokens, optionally bound to a key (RFC 9421 signed requests).
- **Tested with real LLM agents:** Claude Sonnet agents planned and paid for a game over MCP on the sandbox, and four
  more bargained with different briefs, including a prompt-injected one that tried to ignore limits; nothing got
  through ([agent-run.md](https://github.com/gino6178/join/blob/main/docs/agent-run.md)). What confused them became fixes.
- **Join's website agent** for people without one: rules plus Qwen2.5 0.5B on Join's own server (Ollama), English and
  Chinese. No AI key, no AI service.
- **Bryntum Scheduler** shows the venue its courts and rooms; a booking turns from dashed to solid when everyone has paid.

### Under the hood

- **AP2 mandates:** Join signs the Agent Payments Protocol's open checkout and payment mandates for each agent and
  checks them on every offer, accept and payment; the mandates of each deal go into its receipt and dispute evidence.
- **Receipts without a blockchain:** Ed25519-signed, batched in Merkle trees, each batch an entry in an RFC 6962
  transparency log with C2SP checkpoints that independent witnesses cosign.
- **Negotiation, measured:** six buyer strategies benchmarked against every venue's rules
  ([NEGOTIATION.md](https://github.com/gino6178/join/blob/main/docs/NEGOTIATION.md)); the website agent uses the best.
- **Reviews:** verified only, Bayesian and recency-weighted, with each person's own tastes; agents read them, never
  write them.
- Node, Express, React, Vite; 47 automated tests, including an end-to-end run of four agents over MCP.

### Challenges we ran into

- **A deal between agents is only binding if money backs it.** Hence the organizer's authorization before anyone else
  pays.
- **A floor that answers yes or no can be found by binary search.** Venues answer with a concession schedule instead;
  one of our own test agents broke the first version with three $1 offers.
- **Marketplace settlement.** PayPal's multiparty flow needs partner onboarding, and a payout can't be pulled back, so
  Join captures each share, keeps cancellations refundable until 24 hours before, and pays the venue afterwards.

### Accomplishments that we're proud of

- LLM agents went from a sentence to a locked, paid booking on the PayPal sandbox, and its receipt verifies with a
  script that shares no code with Join.
- Nothing on the Activity page is written by a model.

### What we learned

The hard part of agentic commerce isn't the agent. It's the rules around it: who can commit whom to what, when a
promise becomes binding, and how a person checks afterwards what happened.

### What's next

Real venues' booking systems behind the venue adapter; venues bringing their own agents over A2A; multiparty settlement
with Partner Referrals; payer approval through AP2 once PayPal supports it.

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
6. `npm test` runs 47 tests, including the end-to-end MCP run.

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

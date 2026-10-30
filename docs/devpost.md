# Join: Devpost submission text

Draft for the Devpost form. Fill in the links marked TODO before submitting.

---

## Tagline

Your agent gets the group together, haggles with the venue and splits the bill with PayPal. You see every step.

## Inspiration

AI agents can already find a free time and a few friends. Then they stop: someone still has to call the venue, agree a
price, front the money and chase three people for their share. That last mile, the money, is where group plans die:
the badminton game, the karaoke night, the escape room, the barbecue.
And it's exactly the part nobody wants to hand to an agent without limits and a way to check what it did.

## What it does

Join is an agent-ready marketplace for getting a group together: sports courts, karaoke rooms, escape rooms, board
game tables, barbecue pits, dinner tables. It runs no AI model of its own. People bring their own agents
(Claude, or any MCP or A2A agent) and Join supplies the rules and the money:

- **Find a plan.** Who is free, and the fairest venue for each time: the one where the longest trip in the group is
  shortest.
- **Negotiate with the venue.** Each venue sets its own rules on Join: list price, off-peak, group and last-minute
  discounts, how far it will come down (firm, standard, eager) and a floor that is never revealed. Agents offer and
  counter; the venue's last counter is its best and final. The rules are enforced in code, so an agent can't probe for
  the floor or talk its way past it.
- **Over budget? Alternatives from the map.** When a price is over a person's limit, or the venue says no, the answer
  comes with other venues and free public places nearby, ranked by budget, time and trip, each with a reason.
- **Split it, negotiate it, pay it with PayPal.** The organizer guarantees the whole booking (an authorization, not a
  charge), so nobody can hold a room for free. The others are invited; their agents join or decline, and can ask to
  pay less, which the organizer's agent accepts or refuses. Each player pays their own share with PayPal, approved by
  them, or by their agent from saved PayPal within the limits they set. When everyone has paid, the booking is locked.
  The venue is paid afterwards.
- **See every step.** The website shows each person what the agents did, in words Join writes from the facts:
  every search, offer, counter-offer, invitation and payment.
- **Receipts anyone can check.** Every locked, refunded or paid-out booking gets a signed receipt: the negotiation,
  each payment and its PayPal ids, players only as hashes. It can be checked in the browser or with a script that
  shares no code with Join. (Optionally, batches of receipts can also be timestamped on a public chain.)
- **Limits only people can set.** Per-booking and per-week limits and allowed venues are set by the person on the
  website. Agent tokens can read them, never change them.

## How we built it

- **PayPal** (what ran on the sandbox is listed in the README; dispute evidence, webhook self-registration and the venue
  agent are built and tested against a stand-in):
  - JS SDK v6 buttons so people approve in a PayPal popup (Pay Later and Venmo where PayPal says they're eligible).
  - Orders v2 with intent `AUTHORIZE` (one order per payer); captures with `final_capture`, partial for the organizer;
    voids and refunds.
  - Payouts to the venue after the booking.
  - Vault v3, so a person saves PayPal once and their agent pays within their limits.
  - Invoicing, so a person who joined but never paid gets an invoice and the organizer is paid back with Payouts.
  - The **PayPal Agent Toolkit** as Join's back office for venues: `list_transactions` for reconciliation,
    `create_invoice` / `send_invoice` for extras, `list_disputes`, and dispute evidence with the signed receipt.
  - A venue's Claude agent that loads the Agent Toolkit as an in-process MCP server.
  - Webhooks that Join subscribes itself to, with signature verification.
  - Every PayPal POST is journaled first and carries a `PayPal-Request-Id`, so a step retried after a crash is the same
    call.
- **Agents:** an MCP server (Streamable HTTP), the same tools over REST, and an A2A endpoint with an Agent Card. Tool
  descriptions are written for the model that reads them. The player's mandate follows the shape of the Agent
  Payments Protocol's Intent Mandate.
- **AI:** Claude is the player's agent in our demo (Claude Code over MCP, and a Claude API agent that bridges Join's
  MCP tools into Claude's tool use). A scripted agent runs the same flow with no API key, for anyone to try.
- **Bryntum Scheduler** shows a venue its courts, rooms or tables: dashed while a group pays, solid the moment it is paid and locked.
- **Receipts:** Ed25519 signatures and SHA-256 Merkle trees; optional anchoring of batch roots on Ethereum Sepolia.
- Node, Express, React, Vite. 22 automated tests, including an end-to-end run of four agents over MCP.

## Challenges we ran into

- Marketplace settlement: PayPal's multiparty model (the venue as `payee`, Join's fee as `platform_fees`) is the
  production path, but partner onboarding is gated, and a payout can't be pulled back. So Join captures each share,
  keeps cancellations refundable until 24 hours before, and pays the venue with Payouts afterwards.

- A deal between agents is only binding if money backs it. Without a saved payment method, every payer has to approve
  in PayPal, so "accept" alone could have held a place for free. We made the organizer authorize the whole booking first
  and cover anyone who doesn't pay.
- A floor price that answers yes or no can be found by binary search in about seven offers. Venues answer with their
  policy price and a fixed concession schedule instead, with a quota per player and venue.
- Paying the venue before the booking would make refunds impossible once the payout is claimed, so payouts wait until
  it is over.

## Accomplishments we're proud of

- The whole flow runs end to end with four agents: over budget, alternatives, three rounds of haggling, an invitee
  asking to pay less, the organizer's guarantee, three shares, the lock, a signed receipt.
- Nothing on the activity page is written by a model; every line comes from the facts.

## What we learned

The hard part of agentic commerce isn't the agent. It's the rules around it: who can commit whom to what, when a
promise becomes binding, and how a person can check afterwards what happened.

## What's next

More kinds of plans and real venues' booking systems behind the venue adapter, venues bringing their own agents over A2A, and payers' approval
through the Agent Payments Protocol once PayPal's support for it is available.

## Built with

PayPal JS SDK v6 (PayPal, Pay Later, Venmo), Orders v2, Payments (Authorizations, Captures, Refunds), Payouts,
Vault v3, Invoicing, Disputes, Webhooks, PayPal Agent Toolkit · MCP · A2A · Claude · Bryntum Scheduler · Node.js,
Express, React, Vite

## Links

- Code: https://github.com/gino6178/join (MIT). What was built during the hackathon: https://github.com/gino6178/join/compare/baseline...main
- Demo video: TODO (YouTube)
- Try it: TODO (hosted URL), or run it locally in three commands (README)

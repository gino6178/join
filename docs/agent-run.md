# An LLM agent run, end to end

Two Claude (Sonnet) agents, each acting for one person with that person's own Join token, planned and paid for a game
using only Join's MCP tools and their descriptions. They had no other instructions about how Join works. Each tool call
is one JSON line in [`agent-run/organizer.jsonl`](agent-run/organizer.jsonl) and
[`agent-run/friend.jsonl`](agent-run/friend.jsonl); their briefs, verbatim, and their own reports are in
[`agent-run/briefs.md`](agent-run/briefs.md). Mandates are shortened in the logs. Everything ran on PayPal sandbox.

## The organizer (Sam)

Sam's brief: badminton or pickleball for Sam, Aisha, Ravi and Kenji this weekend, within Sam's limits.

1. `whoami`, `list_activities`.
2. `find_options` with `players: 4` returned `group_size`: `players` counts the *other* people, so 4 others plus Sam
   is 5, over a court's 4. It retried without the count and got options.
3. `venue_reviews` for Midtown and Riverside, with the group's ids, to see verified reviews and how the group had rated each.
4. `start_negotiation` at Midtown, Sat 31 Oct 15:00, 90 minutes: the ask was $35.10 after the group discount.
5. `make_offer` $30 returned `mandate_required`. The agent fetched its AP2 open payment mandate from `whoami` and
   offered again with it. The venue came down to $34.58. Then it offered $33, the venue came down to $34.06, and the
   agent took it with `accept_price`.
6. `pay_my_share`: Sam's PayPal authorization guarantees the booking. The booking went to `held`, and the friends had
   until the pay-by time to pay their own shares.

## A friend (Aisha)

Aisha's brief: join the plan Sam invited her to, if it looks reasonable, and pay her share.

1. `whoami`, `my_plans` (the invitation), `venue_reviews` for Midtown.
2. `pay_my_share` without a mandate returned `mandate_required`. Like Sam's agent, it fetched the mandate and paid
   $8.51 with it.

Ravi and Kenji didn't pay. When the pay-by time passed, Sam's guarantee covered their shares, which is the deal Sam
agreed to (`youGuarantee` in the negotiation said so up front). The booking then locked.

## The receipt

At the pay-by time (10:19 UTC) the booking locked. Sam's authorization was captured for $25.55: Sam's own $8.53 plus
Ravi's and Kenji's $8.51 each. Aisha's $8.51 was captured too, for $34.06 in all, the agreed price. Join issued receipt
`rcpt_3ee4007eaa780db6` and closed it into a batch, entry #1 of its transparency log. A witness then cosigned the
checkpoint. The independent verifier (`examples/verify-receipt.mjs`, which shares no code with Join) printed:

```
Receipt rcpt_3ee4007eaa780db6: locked, badminton 2026-10-31 15:00, $34.06
✔ the body hashes to the signed hash  3ee4007eaa780db6
✔ Join's signature checks with its published key  join-mvuow7fq
✔ the Merkle path leads to the batch's root  3ee4007eaa780db6
✔ the batch is entry #1 of Join's transparency log
✔ that entry is in the log's Merkle tree (RFC 6962), size 2
✔ the checkpoint is signed by Join's log key  192.168.31.145:8799/join-receipts
✔ witness gino-desktop.example/witness cosigned it at 2026-10-30T10:20:29.000Z

This receipt is exactly as Join recorded it, and Join's log of it hasn't been rewritten.
```

## What the agents found hard, and what changed

- **`players` counts the others, not the group.** `find_options` now also takes `people` for the whole group's size and
  explains in `group_size` errors which one it needs.
- **The mandate.** Both agents tried an offer or payment without it first. The server instructions and the three
  tools' descriptions now say to present it, and the `mandate` argument is required in the schema.
- **When does it lock?** `pay_my_share` now returns a `nextStep` saying who still has to pay and when the guarantee
  takes over.
- **"Verified" reviews.** The demo town's seed reviews are now labelled demo reviews in what the tools return.

Four more agents then bargained with different briefs: thrifty, in a hurry, a floor hunter and a prompt-injected agent.
See [NEGOTIATION.md](NEGOTIATION.md#llm-buyers).

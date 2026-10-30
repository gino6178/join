# Negotiation: the venue's rules, and a benchmark

Every venue on Join sets its own negotiation policy (`api/data/world.json`, editable in Venue view): a list price,
off-peak, group and last-minute discounts, a style (`firm`, `standard` or `eager`), a number of counter-offers, and a
floor that is never revealed. Join's engine (`api/src/negotiate/engine.js`) enforces it for every agent alike.

- **A schedule, not a haggle with a model.** Each serious offer moves the venue one step down its own concession
  schedule, from its opening ask toward its floor (`standard` goes half way, `eager` all the way, `firm` not at all).
  An offer at or above the next step is accepted.
- **Lowballs don't move it.** An offer under 70% of the current ask uses up a round and the venue doesn't come down.
- **Best and final.** After the last counter (or at once for a `firm` venue) the price is final; an offer under a final
  price ends the negotiation.
- **No floor-finding.** Five negotiations per person, venue and day; the floor is never sent to an agent.

## Benchmark

`node api/bench/negotiation.mjs --md` plays six buyer strategies against every venue, activity and two start times
(28 negotiations each) on the real engine, in memory, with no limits in the way. Prices are the share of the venue's
opening ask, of its list price, and of its secret floor.

| strategy | runs | deals | paid / opening ask | paid / list | paid / floor (min) | rounds | under floor |
|---|---|---|---|---|---|---|---|
| Accept the opening ask | 28 | 100.0% | 100.0% | 88.0% | 107.3% (100.0%) | 0.0 | 0 |
| Conceder (offers 90%, takes the first counter) | 28 | 67.9% | 97.9% | 84.6% | 108.1% (100.0%) | 1.0 | 0 |
| Split the difference (85%, then halfway) | 28 | 67.9% | 95.7% | 82.7% | 105.6% (100.0%) | 1.8 | 0 |
| Patient (Join's buyer: just over 70% each round, takes the final) | 28 | 100.0% | 95.7% | 84.1% | 101.9% (100.0%) | 1.5 | 0 |
| Lowballer (30% every round) | 28 | 100.0% | 100.0% | 88.0% | 107.3% (100.0%) | 1.5 | 0 |
| Floor prober (binary search, then accepts) | 28 | 100.0% | 97.2% | 85.5% | 103.8% (100.0%) | 1.5 | 0 |

Time waster: 5 negotiations opened with one venue on one day, then refused (`quota`).

**What it shows, and what it doesn't.** These are rule-based buyers on a deterministic engine, so the table checks
that the venues' rules behave as designed; it is not evidence about how LLMs bargain (that is the next section).
- **No strategy paid under a floor.** That is guaranteed by the schedule itself (it never goes below the floor); the run
  confirms nothing slips through the accept and offer paths.
- **Lowballing saves nothing,** as the 70% rule intends: the lowballer paid the full opening ask. The rule is published
  in `make_offer`'s description, so this is about wasted rounds, not a secret defence.
- **The patient buyer pays the least among strategies that always get a deal** (95.7% of the opening ask): any offer
  just over 70% moves the venue along its own schedule, so offering more only gives money away. Join's website agent
  uses it. The differences are small (a few percent), because each venue decides how far it will come down.
- **Conceding early loses deals:** "offer 90%, take the counter" and "split the difference" lost a third of their
  deals, because a `firm` venue's price is final from the start and an offer under a final price ends the negotiation.
  Join's buyer checks for a final price before offering.
- **Time-wasting is capped:** the sixth negotiation with one venue on one day is refused (`quota`).

The strategies are the standard ones from the automated-negotiation literature: time-dependent tactics, where
"Boulware" holds out and "Conceder" gives in early (Faratin, Sierra and Jennings 1998; see Baarslag et al., *Optimal
Negotiation Decision Functions in Time-Sensitive Domains*), and the adversarial buyer personas used to stress-test
seller agents (lowballers, probers, time wasters).

## Shopping across venues

Join's website agent doesn't stop at the venue the person picked. After haggling there, it asks up to two other venues
free at about the same time (`find_alternatives`), haggles with each the same way, and compares the final prices. It
books the person's pick unless another venue is at least $1 a person cheaper; then the person chooses. Nothing over
their limit is ever offered, and every unused negotiation is walked away from. Each step shows up on the Activity page.

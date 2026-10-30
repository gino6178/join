# The one-pass decider: Muse Glimmer's choice without its reasoning

When your agent proposes a time, a member's agent answers in `fullAnswer` (`agent/src/a2a.js`). Code already settles
what the calendar and the rules decide (`A2A_ROUTE`, on by default):
- If the proposed time works, the answer is yes.
- If only one listed time works, that time is the counter.

The model is asked only for a real choice: the proposed time breaks a rule, two or more listed times keep them, and the
agent picks the one its member likes best, or declines. Muse Glimmer always reasons first, in a hidden channel. Here
that took about 600 tokens and 40 seconds an answer.

The one-pass decider tries to get that choice with no reasoning and no training. A decision model of the kind Jev
(TypeSafe, 2026) describes returns one of the options declared in advance, read in a single pass; this is the same
idea, done with Glimmer itself. It works and costs one token, but it chooses differently from the full answer more often
than the full answer does from itself, so it stays **off** (`A2A_DECIDER=raw` turns it on).

## How it reads Glimmer in one pass

`agent/src/decider.js` sends `/api/generate` the following, with `raw: true`, for one token at temperature 0:
- the member's profile and the decision rule, in the full answer's words;
- the proposed time and why it doesn't work;
- the listed times that work as A, B, C..., then Z for "can't play this week";
- a closing cue: "The time Mira likes best is option".

`raw: true` means no chat template, so there is no reasoning channel. The next token's 20 most likely alternatives give
each letter's probability. The pick is the most likely letter, and its share of the letters' probability is the
confidence.

There is nothing to parse: the answer is always one of the options. The hook in `fullAnswer` behaves as follows:
- It asks the decider only for this choice.
- It keeps the pick when the probability reaches `A2A_DECIDER_SURE`.
- It passes anything lower, or a Z, to the full answer.
- The times that work are the ones code kept.

What our Ollama (0.40.11) does, from `submission/results/decider_probe.json`:
- **Raw generate gives logprobs.** It returns the next token's top 20. `top_logprobs` 21 is refused ("must be between
  0 and 20").
- **Raw adds the begin-of-text token by itself.** A one-word prompt counts as two tokens, so the prompt must not add
  another.
- **The chat template doesn't work for this.** With the template and `think: false`, the first token is a channel
  header (" to", probability 1.0), so its probabilities say nothing about the choice. That is why the old quick pick
  (`pick()`) had to reason first, and why its 128-token drafts came back empty.
- **The native decision mode doesn't apply.** This Ollama has one for dedicated decision models (`ollama run --ask
  --choice`). It ignores the `questions` field for Glimmer, which reasoned for 1,252 tokens instead.

## The cases

The cases are built by `agent/test/decider_eval.mjs`:
- **Members.** Simulated members from `population.js`, seed 7, `SIM_ONLY=1`, with the player free all week in a fixed
  week.
- **What is asked.** For each member with a rule that can come up, your agent asks for a time that breaks it: a day
  they don't play, a game ending after their latest, or a court beyond their longest trip.
- **The listing.** It is made the way round 1 of `rounds()` makes it.
- **Which cases are kept.** Only those where two or more listed times keep the member's calendar and rules, as
  `breaks()` computes them.
- **Size.** The first 300 members give only 46 such cases, so members come from the first 1,200 of the same seed
  (the first 300 are the same people). That gives **196 cases from 152 members**: 138 home-by limits, 45 days off and
  13 trips.

The systems run on the same cases:

| System | What it is |
|---|---|
| `full` | the full answer, as the gateway answers today |
| `full2` | the full answer again: how often the current path agrees with itself |
| `raw:<variant>` | the decider |
| `rawall:<variant>` | the decider shown every listed time, including the ones that break a rule, so `breaks()` grades whether it knows the rules without code |

There is no right answer for "the time the member likes best", so the full answer is the reference. One check doesn't
depend on it: 32 cases have a preference code can grade (the member "prefers the earliest start", or "would rather play
weekends" and only some of the times are at a weekend). The members are split in half by a hash of their id:
- **Calibration half** (85 members, 107 cases): the confidence threshold is chosen here.
- **Test half** (67 members, 89 cases): the threshold is reported here.

The prompt was chosen beforehand on other members (seed 11, 61 cases). Agreement with the full answer was:
- `habits` 37 of 61 (it says the order of the list is not a preference and points back at the member's habits);
- `best` 32;
- `cue` 29;
- each of those two read in both orders: 30 and 29.

**Hardware.**
- Quality was measured on A100s with the same model (digest `de878ce33ad8`): `full` and the decider on one, `full2`
  on a second.
- Latency was measured only on the RTX 3090 (GPU 1, with the shared lock held), on the seed-11 rows.
- On the A100s, which other agents were using too, wall times include queue waits of up to 30 seconds. Only their
  `compute` field (the server's own time) is meaningful there.

## Results

Seed 7, 196 cases, 95% intervals from a bootstrap over members (`submission/results/decider_summary.json`):

| | Decider (`habits`) | Full answer | Full answer again |
|---|---|---|---|
| Picks the same time as `full` | **62.2%** [54.5, 69.8] | | **73.5%** [67.9, 79.3] |
| Picks the same time as `full2` | 63.8% [56.1, 70.6] | 73.5% | |
| Declines | 0 of 196 | 0 of 196 | 0 of 196 |
| Picks a time that works (`breaks()`) | 196 of 196 (only those are options) | 196 of 196, none corrected by code | 196 of 196 |
| Picks the time the member's words prefer | **12 of 32** [19%, 59%] | **27 of 32** [71%, 95%] | 27 of 32 |
| Picks the first time listed | 86.7% | 58.2% | 56.6% |
| Tokens read / written per answer | 438 / 1 | 640 / 606 (569 of them reasoning) | 644 / 605 |
| Empty answers | 0 | 0 | 0 |

**Agreement.**
- The decider agrees with the full answer 11.2 points less often than the full answer agrees with itself (paired by
  case: −11.2 [−19.2, −2.7]). The interval leaves out zero, so the two are not equal.
- On the 144 cases where both full answers agree, the decider agrees on 69.4% [60.5, 77.7].
- Almost all of the gap is the home-by limit. On days off the decider agrees on 39 of 45, and on trips on 12 of 13. On
  home-by limits it agrees on 71 of 138.
- In a home-by case, the decider takes the first time listed, the same day just inside the limit. The full answer often
  moves earlier (19:00 rather than 20:00), or to the earliest day when the member "prefers the earliest start".

**The other variants on seed 7** are all in the same range: `cue` 57.7%, `best` 63.3%, both orders 56.6% and 58.7%.

**Without code's filter**, how often the decider picks a time that works:
- `cue` 144 of 196 (73.5%);
- `best` 171 (87.2%);
- `habits` 193 (98.5%).

So the choice of prompt matters more for keeping the rules than for matching the full answer. Code still filters first
in the tier.

## Confidence and the cascade

**The confidence doesn't sort right from wrong:**
- The calibration error is 0.167.
- The decider agrees with the full answer on 45% of the cases it gives 0.3 to 0.4, 73% at 0.5 to 0.6, 61% at 0.8 to
  0.9, and 4 of 8 above 0.9.
- At every coverage, its disagreement stays near 35 to 40%.

**How the threshold is chosen.** It is chosen on the calibration half by conformal risk control, as in
`agent/test/cascade_analysis.mjs`.
- A case is lost when the decider answers alone and picks a different time from the full answer.
- The threshold is the lowest at which (lost + 1) / (n + 1) stays under the risk level.

**How the cascade is tested.** On the test half, the decider answers above the threshold and the full answer below it.
The fallback uses `full2`, so `full` is never graded against itself.

| Risk level | Threshold | Decider answers | It differs from `full` | Cascade agrees with `full` | `full2` alone | Tokens written per choice |
|---|---|---|---|---|---|---|
| 5% | 0.843 | 7 of 89 (7.9%) | 3 of 7 | 75.3% [66.3, 83.5] | 78.7% [70.0, 86.0] | 563 (598 alone) |
| 10% | 0.729 | 17 (19.1%) | 6 of 17 | 74.2% [64.4, 83.5] | 78.7% | 504 |
| 20% | 0.572 | 42 (47.2%) | 14 of 42 | 73.0% [61.7, 83.0] | 78.7% | 327 |

On the 19 test cases with a graded preference, the cascade picks the preferred time on 15, 14 and 14. The full answer
alone picks it on 17, and the decider alone on 10.

The risk control holds: at the 5% level, the cascade changed 3 of 89 answers. But it buys little. The decider answers
only 8% of these choices, so the tokens written per choice fall by 6% (563 against 598). The other 92% still pay for
the full answer.

`A2A_DECIDER_SURE` defaults to 0.85: the 5% threshold, rounded up, which can only lower the risk.

## Latency (RTX 3090)

On GPU 1 with the lock held, on the seed-11 rows (`submission/results/decider_dev_summary.json`):

| Call | p50 | p95 | Server's own time (p50) |
|---|---|---|---|
| Decider, one pass, one call at a time | 0.53 s | 0.59 s | 0.47 s |
| Decider, both orders (two passes at once, `best`) | 0.98 s | 1.25 s | 1.62 s for the two |
| Full answer, 4 at a time (the gateway's slots) | 40.4 s | 53.6 s | 38.8 s |

The one-pass row is the `best` prompt, whose layout is the same as `habits`. `habits` was not timed on the 3090; its
prompt is 28 tokens longer. The full answers ran four at a time and the decider one at a time, so the ratio is a little
generous to the decider.

On the A100s the server's own time was 0.81 s for the decider and 44.9 s for the full answer (p50), with other agents'
work in the same batches.

## The default, and what it is for

The tier stays off:
- **Decline rate is equal**: zero in every system.
- **Agreement is not equal within the intervals**: the decider's gap to the full answer is wider than the full answer's
  own spread.
- **On the one check with a code-graded answer**, the member's own stated preference, it is right 12 times in 32 where
  the full answer is right 27 times.

One pass without reasoning reads the facts and the rules well when code doesn't filter the times: 98.5% of its picks
work. What it doesn't do is weigh the member's habits against the list.

This is the no-training baseline for the 3B student being distilled from Glimmer:
- **Agreement with the full answer:** 62.2%, against 73.5% for the full answer with itself.
- **The member's stated preference:** 12 of 32, against 27 of 32.
- **Time and tokens:** 0.53 s and one token, against 40 s and about 600 tokens.

## Limits

- The full answer is the reference. Apart from the 32 graded cases, agreement measures whether the decider matches it,
  not whether either is right.
- The 196 cases come from 152 simulated members, mostly home-by limits. Members come from the first 1,200 of seed 7,
  not only the 300 of the usual club.
- The decider reads the current question only, not earlier rounds of the talk.
- The prompt was chosen on 61 dev cases. On seed 7 the five prompts lie within 57–63% of each other.

## Running it

Run from `agent/` (on the server, in a folder of its own, with its own `data/`):

```
LLM_URL=http://127.0.0.1:11445/v1 node test/decider_probe.mjs data/decider_probe.json
DECIDER_SEED=11 DECIDER_MEMBERS=300 node test/decider_eval.mjs data/decider_dev_raw.json raw,rawall,full
DECIDER_PROMPT=habits DECIDER_TAG=habits node test/decider_eval.mjs data/decider_raw.json raw,rawall
node test/decider_eval.mjs data/decider_raw.json full
node test/decider_eval.mjs data/decider_raw_full2.json full2
node test/decider_analysis.mjs data/decider_raw.json,data/decider_raw_full2.json data/decider_summary.json raw:habits
node --test test/decider_unit.mjs
```

- `DECIDER_PROMPT`, `DECIDER_ORDERS=2` and `DECIDER_TAG` pick a variant.
- `DECIDER_PAR` and `DECIDER_RAW_PAR` set how many calls run at once.
- `DECIDER_HW` names the hardware on every row.
- A run stopped halfway keeps every finished case, and asks again the ones that never reached the model.

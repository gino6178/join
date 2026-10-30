# What talks reveal, and a disclosure budget

With private calendars (`A2A_PRIVATE=1`) no member's week reaches your agent, but each talk still returns one yes or
no per listed time (14 to 30 per talk), and a "how likely" band says something about the hours it covers. This page
measures what a curious agent can rebuild from those answers over a month, what a budget on the members' side buys
back, and what it costs ordinary players. The second half covers notes that can be replaced and partly forgotten.

All numbers come from simulated members (`population.js`, seed 7) and the real code (`a2a.js` negotiate, in process,
the members' rules in code, `match/likely.js` bands). They run on the CPU with a stand-in model for the few
choice-between-times answers: `agent/test/privacy_probe.mjs`, results in `submission/results/privacy_probe.json`,
chart in `submission/results/privacy_frontier.svg`.

## The attack

The attack follows CalBench (Zou et al., 2026: coordination against privacy, scored against a ground truth the
simulation knows). The attacker is a gateway of its own that keeps every answer it hears. For each of 60 targets it
runs 40 private-calendar talks over 28 days. Before each talk it changes only its own claimed week, so the talk lists
the hours it knows least about. It also asks single-time bands as often as `likely.js` allows (4 a day, 10 a week).
Its guess is a Bayesian posterior over each weekday's free window: none, or [a, b) in whole hours. The prior is the
club's usual weeks, taken from 240 other members. Each yes, no and band updates it, and the noise rates are measured
on the club: a time that fits the calendar still gets a no 6.7% of the time because of the members' rules, and a band
says "unlikely" 10.3% of the time. Scoring covers the 84 plausible hours of the week, the ones where at least 2% of
the club is free; the hours nobody is free are easy for any guess. Two scores: AUC, and *days known*, the share of a
target's weekdays whose exact window (or "no window") the attacker holds at posterior 0.9 or more.

| | AUC, plausible hours | days known |
|---|---|---|
| the club's prior alone | 0.852 | 0% |
| no budget, bands only | 0.937 | 40% |
| no budget, 5 talks | 0.969 | 97.6% |
| no budget, 40 talks | 0.978 | 97.6% |

Five talks are enough. The weeks of a club look alike (weekday evenings, weekend mornings), so two or three
well-chosen hours pin a whole day. The attacker's own gateway file (`a2a_memory.json` counts) gives AUC 0.793 at day
28. That is less than the attacker's own log, because the counts are an ordering heuristic.

## The defences (all on the member's side: `agent/src/disclosure.js`)

- **Budget of new hours per asker.** The budget counts hours of the week told to an asker (weekday + start hour), not
  answers. An hour already told inside the rolling window (28 days) costs nothing, so two players who keep agreeing
  their usual Thursday never run out. Each asker gets at most `A2A_BUDGET_CELLS` new hours (24). All askers together
  get at most `A2A_BUDGET_MEMBER_CELLS` (72), so many asker ids buy little. Talks and bands share one budget. A band
  covers all its hours or none.
- **Withheld, not "no".** An hour over the budget is listed in the decision's new `withheld` field (schema.js
  DECISION). The asker neither learns it as a no nor keeps it. Which hours are withheld depends only on the list and
  its order, never on the calendar, so withholding tells the asker nothing. When an answer would tell nothing at all,
  the talk ends with "has told you about as many new times as it will for now".
- **Inference check (`A2A_BUDGET_SURE`, 0.9).** The member's agent runs the asker's own reasoning on what it has
  told that asker: the same posterior over weekday windows, from the club's prior. It withholds a new hour if either
  answer, yes or no, would make the asker newly sure (≥ 0.9) of that day's window. The decision looks only at what
  was already told and at the question, never at the true answer: simulatable auditing (Kenthapadi, Mishra and
  Nissim, PODS 2005).
- **Minimal disclosure (`A2A_DISCLOSE_MIN=m`, measured, off).** Answer only the proposed time and the first m listed
  times that work.
- **The asker's own counts fade.** `learn()` counts halve every 14 days (`A2A_MEMORY_HALFLIFE_DAYS`), and a count
  below 0.1 is dropped (one answer is gone after about seven weeks). `A2A_MEMORY_GRAIN=part` keeps only morning,
  afternoon or evening.

Defaults: on whenever the server's calendars are private (`A2A_BUDGET` unset and `A2A_PRIVATE=1`), with 24 hours and
the check at 0.9. With shared calendars the gateway sees the weeks anyway.

## Privacy against utility

The run is 40 attacker talks plus bands per target in a month. Two ordinary players run beside it: "you" has four
free stretches, "flex" is free every day 08–22. Each agrees one singles game a week with each target and one doubles a
week with each group of three, 320 games each, after the attacker has spent the members' budgets that day. "Agreed"
counts only games where a time that works existed. "Best" means the player's own best such time.

| arm | AUC | days known | you: agreed / best | flex: agreed / best / rounds |
|---|---|---|---|---|
| no budget | 0.978 | 97.6% | 100% / 88.9% | 100% / 92.6% / 1.43 |
| budget 8 | 0.928 | 42.6% | 100% / 88.9% | 65.2% / 55.9% / 1.57 |
| budget 12 | 0.948 | 56.9% | 100% / 88.9% | 76.6% / 68.0% / 1.59 |
| budget 24 | 0.960 | 95.7% | 100% / 88.9% | 100% / 92.6% / 1.43 |
| minimal m=1 | 0.965 | 97.6% | 99.5% / 88.4% | 98.4% / 91.0% / 1.45 |
| **budget 24 + check 0.9 (default)** | 0.975 | **32.4%** | **100% / 81.5%** | 93.8% / 51.6% / 1.54 |

No agreed game broke a member's calendar or rules in any arm.

What this shows, honestly:
- **A budget on hours alone does little.** At 24 hours the attacker still knows 95.7% of days. A budget small enough
  to matter (8 to 12) costs the flexible player a quarter to a third of its games.
- **Minimal disclosure does not help.** The order of the answers gives the noes away: a listed time before the one said
  to work did not work. The attacker reads it that way, and gets 97.6%.
- **The inference check protects the exact week at little cost.** Days known drops from 97.6% to 32.4% (24.0–30.2% at
  5 to 20 talks). The ordinary player loses no games (100%), though its best time drops from 88.9% to 81.5%. The
  flexible player keeps 93.8% of its games.
- **What it cannot hide is the hours a game needs.** AUC on the plausible hours stays near 0.975. To agree a game the
  asker must learn that some hours are free, and in this club knowing "free around 19–21 on Monday" is most of the
  week's free hours. A per-hour version of the check (`A2A_BUDGET_CHECK=hour`, withhold anything that makes another
  hour certain) brought AUC down to the prior and stopped every game in a 20-member trial. It is in the code, off.
- **The stored counts:** fading changes little within a month (AUC 0.885 → 0.888 at day 28, the order of hours is
  kept). Keeping only the part of the day brings the file to 0.779. Fading matters past seven weeks, when old answers
  are gone.

Limits: the attacker uses the same prior the check assumes. An attacker with a sharper prior would learn more. The
window rolls, so over months an attacker that keeps asking gathers more. The month is simulated, and the members'
weeks do not change. Sybils are held back only by the per-member cap.

## Forgetting, the other half: notes that can be replaced and partly forgotten

`agent/src/memory.js` kept append-only notes, and `/forget` deleted all of them. After "leave Tomás out" and then
"Tomás is fine again", both notes came back, and the model guessed. Now (`agent/src/memory_update.js`,
`MEMORY_CONSOLIDATE`, on):

- **On write**, code finds the notes a new one may change: the closest by DRAMA, and every live note naming the same
  member or weekday. Muse Glimmer answers in a JSON Schema: add / update (which notes it makes untrue) / same, the
  rule the note asks for (leave a member out, a weekday off), and its last day. This follows Mem0's ADD/UPDATE/NOOP
  and Zep's invalidated facts.
- **Code checks the answer.** A replaced note must share a subject with the new one. A rule's member must be a club
  member the note itself names. A last day must be a real date, after today, from a note that speaks of a time.
  Anything that fails a check is dropped and listed as refused.
- **Replaced and expired notes** are kept, struck through on the Memory page ("Replaced on … by …", "ended 20 Oct"),
  and never recalled. A live note's score fades with age (half after 120 days).
- **Rules from live notes are kept by code in the Autopilot.** A member left out goes into `leaveOut`, and a weekday
  off is refused by find_partners and negotiate. Rules can only take options away.
- **Forgetting by person or topic.** "forget what I said about Tomás" in Messenger, `/forget Tomás`, or the Memory
  page's "Forget what I said about…" box deletes every note naming that member, replaced ones too. For a topic it
  deletes every note with one of its words or close in meaning. `/forget` alone still deletes everything.

Measured by `agent/test/memory_update_eval.mjs` on Muse Glimmer (A100) and DRAMA, against append-only notes;
The run was stopped at the wrap-up before it wrote its JSON, so its log is the record:
`submission/results/memory_update_eval.log`. There are 20 update chains (26 checks), each among six
unrelated notes; six of the chains must replace nothing.

| | updatable notes | append-only |
|---|---|---|
| notes in the right state (live / replaced / expired) | **40/40** | 25/40 |
| stale notes still live | 0/15 | 15/15 |
| notes wrongly replaced | 0/25 | 0/25 |
| the planning question gets a stale note (top 4) | **0%** | 91.7% |
| the newest note, and not the stale one | 75% | 8.3% |
| the Autopilot's rule is right | **90.5%** (19/21) | 52.4% (only the "none" cases) |
| forget by person/topic: precision / recall | **1.0 / 1.0** (8 of 8) | 0.18 / 1.0 (the old /forget: all 44) |

The two misses among the rules are listed in the log.

**End to end, the Autopilot's week.** These are two-game weeks in the demo club, where Tomás is in every plan unless
told otherwise, with three runs per chain.

| chain | updatable notes | append-only |
|---|---|---|
| Tomás left out (control) | 3/3 | 3/3 |
| left out, then "he's fine again" | 3/3 | not run |
| left out, then "forget what I said about Tomás" | 3/3 | not run |
| left out until a day that has passed | 3/3 | not run |

With updatable notes, 12 of 12 runs planned correctly. For the append-only baseline, only the control chain was run
before the wrap-up. Its other three chains were not run, so there is no end-to-end baseline number for them yet. The
command to rerun is `node test/memory_update_eval.mjs` with `MEMUPD_PARTS=autopilot`.

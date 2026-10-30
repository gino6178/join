# Agent matchmaking: "I want to play", and whose agent to ask first

Status: **built** on this branch (section 10), with the user's six follow-ups built and measured (section 12), on
simulated members only (section 7). No number here comes from a real player.

## 1. What is asked, and the reading this design takes

The player tells their agent in a messaging app what they want ("I want to play", "anyone for doubles Thursday?").
Their agent finds the best option, which mostly means choosing **whom to ask, about which times, and in what order**.
It asks the other members' agents. The agent that receives an ask predicts how likely a yes is, from records, so the
asking agent can go to the likely yeses first and bother fewer people.

The request says the prediction comes from "the asker's recent approve records or activity records". There are two
readings:

1. **The receiving member's own records** (built). Kenji's agent knows how Kenji answered asks lately, whether he took
   his own agent's suggestions, how often and when he plays, and whether his body log says rest. It predicts Kenji's
   yes on its own side and returns only a coarse band.
2. **The asking player's records** (how reliable the asker is: do their asks end in games, do they cancel). For this,
   the asker's records would have to cross to the other agent, or the asker's agent would vouch for its own player
   (and a self-report can be gamed). The parts of it that need no new data are in reading 1: the receiver's own
   history *with that asker* (games together, games that ran past the booking, yeses to that asker).

Reading 2 is an open question (section 11).

## 2. What existed before this branch

| Piece | Where | What it did |
|---|---|---|
| Free text to an intent | `play.js` `readIntent` (Muse Glimmer, JSON out; `ruleIntent` when the model is down) | Used by the web app's Play page. In Messenger, `pocket.js` `handle` sent only `/game` and "want a game?" phrasings to the Match helper; "I want to play" went to the coach as a question. |
| Ranking partners | `play.js` `partnerScore`; `ask.js` `opening` (rating fairness + `autopilot.js` `chemistry`); `autopilot.js` `find_partners` | Every one ranks by fit. None predicts whether the person will say yes. |
| What the asker learns | `a2a.js` `learn` / `learned`, `data/a2a_memory.json` | Yes, no and asked-for counts per member and weekday-hour, used to order the *times* in a proposal. It is kept on the asking side, keyed by member only, so on one gateway every player's talks feed one profile of each member. `/forget` did not touch it. |
| The talk | `a2a.js` `negotiate` / `rounds`; `a2a_server.js` `MemberExecutor` | `serve.proposal` (facts only, at most 12 times), a decision with the acceptable set (`works`), `serve.hold` leases, hard rules in code (`breaks`), routing (`A2A_ROUTE`, `rulesComplete`). |
| Private calendars | `A2A_PRIVATE=1` | Your agent lists times from your own week; each member's agent says which listed times work, and nothing about its week. |
| Agent Cards | `a2a_server.js` `cardFor`, `signCard` | Two skills, signed with the gateway's Ed25519 key (A2A v1.0, 8.4). |
| The player's own records | `ask.js` `db.asks`, `autopilot.js` `db.pending`, `store.js` games and body log | Kept, but nothing learned from the yes/no answers. |
| The simulated club | `population.js` | Members with weeks, levels, homes, habits and hard rules; every member's agent decides by the same rule, so a simulated member never said no to a time that fits. |

## 3. The flow (as built)

1. **A message becomes an intent.** `pocket.js` `handle` sends a play request ("I want to play", "anyone for doubles
   Thursday?", "想打球"; `match/flow.js` `isPlayRequest`) to the new `onPlay` hook. It does this after Llama Guard
   screens the text, and before the "want a game?" phrasings and the coach. `server.js` `msn.hooks.play` replies
   "On it…" and calls `ask.js` `request`. The intent is read by `play.js` `readIntent`, now exported but unchanged.
2. **The times.** `flow.js` `timesFor`: from the player's own week, the next seven days, the intent's days and hours,
   the hours they play most first, at most twelve, at least three hours ahead, no day that already has a game.
3. **The candidates.** Members who play the sport (and the format, for badminton) and are free at one of the times,
   and have no game then. With private calendars, it is everyone who plays it. The prior is `play.js`
   `partnerScore`, now exported (+6 for a member named in the message).
4. **Whom to ask first.** `match/ask.js` `order` asks twelve agents for a band at once: ten by fit and two drawn from
   the rest. Each member's agent answers on its own side (`match/likely.js`). Your agent orders by band, then by who
   was asked least this week, then by fit. A refusal, or an agent the calibration ledger caught out, is "unknown",
   ordered as the club's average band ("maybe"), never as a no.
5. **The talks.** `a2a.js` `negotiate`, unchanged. Singles: one member at a time, four talks at most. Doubles: the top
   three, whoever declined replaced by the next, three talks at most.
6. **The best option.** The first agreed game, each partner marked with the band their agent gave.
7. **The player's yes.** Nothing is booked. `ask.js` `request` keeps it as a question with the status `moved`. That is
   the state the "want a game?" flow already has when the agents moved its time, so `server.js` `deliverGame` sends
   the talk and *Book it* / *Drop it* buttons. The question's words are made by code (`flow.js` `question`). A tap
   books it (`play.book`). A drop releases the holds.
8. **Learning.** On the member's side, `match/records.js` notes:
   - each answer its agent gives (`a2a_server.js` after a decision; `a2a.js` `ask` in process);
   - each invite's in or out (`play.js` `status`, through `play.hooks.invite`);
   - each of the player's own yeses and noes to their Match helper and Autopilot (`ask.js` `answer`, `autopilot.js`
     `answer`).

   On the asking side, the gateway keeps only its calibration ledger and how many asks each member got this week.

The same ordering (step 4) is wired into:
- the Autopilot's `find_partners` (`match/rank.js` `rankRows`). The model reads "Kenji's agent says likely" first
  among the reasons. The stop check keeps the fit order.
- the Match helper's daily ask: `ask.js` `askNow` asks for bands at the time `opening` found, then picks partners by
  band.
- the Play page's options (`play.js` `plan`, through `play.hooks.rerank`). Each option's partners and spares are
  ordered by band, and a member asked for by name stays in.

The web Play page shows each partner's band ("likely") and a plain sentence ("Their agent thinks a yes is likely.").

## 4. The success-rate prediction

### 4.1 What is predicted

The chance that the member says yes to the best of the listed times, if asked now. "The best of" because the talk
already finds the time (the acceptable set); the order only needs the member.

### 4.2 The features, where each lives, and who computes it

All 26 (24 in the first model, plus the asker's reliability from 12.1) are computed by the **receiving member's agent** (`match/features.js`), from its member's own records
(`match/records.js`, `data/match_records.json`) and the request's facts.

| Feature | Where it comes from | Notes |
|---|---|---|
| Yes rate on asks, last 28 days, and how many asks | The member's records: its agent's answers, settled by the invite's in or out | Smoothed towards the club's rate, so a new member is "maybe", not 0 or 1. |
| Yes rate at this weekday and hour, and how many | The same | What `a2a.js` memory keeps, but on the member's side and only for that member. |
| Yes rate to this asker, asks from this asker | The same | Needs the asker's id, which `serve.likely` and now `serve.proposal` carry. |
| Games with this asker, minutes past the booking with them | The member's games | Partner history: the part of reading 2 that needs no new data. |
| Games in the last 7 days, already booked that week, games a week (8 weeks), the difference | The member's games | Saturation. |
| A game the day before or after | The member's games | Back-to-back days. |
| Habit: share of the last 8 weeks played at that weekday and hour | The member's games | |
| Said no in the last 72 hours (to anyone, or to its own Match helper) | The member's records | A busy week shows up as recent noes. |
| Yes rate to its own Match helper and Autopilot plans, 28 days | The member's records, from `ask.js` `answer` and `autopilot.js` `answer` | The approve/decline records. |
| Sore, in the body log; sore and singles | The member's sore spells, once logged | A spell counts only from the day it is logged. Only the flag, never the text. |
| Level gap, own trip, notice, prefers doubles, weekend, asks in the last 7 days | The profile, the member's own trip to the venue, the request | The trip is the member's own, never the asker's figure. |
| The asker's reliability: this member's yeses to the asker that became games, and the asker's drops and cancels after a yes | The member's records: a hold released with `why: "dropped"` after its yes (`a2a.js` `holdAnswer`), a cancelled game (`play.js` `cancel`) | Added in 12.1. Only what this member's agent saw itself; a yes turned away by "two at once" does not count. |

### 4.3 Which side computes, and what crosses

- **The receiving side computes** and returns a band; its member's records never leave its agent.
- **Checked against private calendars.** Private calendars tell your agent which listed times work, and nothing else.
  An estimate is coarser than that. It is one band for the member over the whole list, and the band does not say
  which time. "None of these times works" is folded into *unlikely*, so a band never separates "not free" from "free
  but not keen". With shared calendars the gateway knows the weeks anyway, and the band adds only the soft part.
  Two known gaps stay as before. The Match helper and the Autopilot still read the shared calendars. And `a2a.js`
  memory is still kept on the asking side, though `/forget` now clears a member's rows (`forgetMemoryFor`).
- **Rejected: the asker computes.** The asker's own counts are close to a coin flip (AUC 0.572, section 7.3). The
  gateway-wide counts `a2a.js` keeps do better as an ordering (AUC 0.630), but only by pooling every player's
  answers about a member on the asking side.
- **Rejected: a central model over everyone's raw records**, because one stage would hold every member's records and
  answer anyone's question.
- **The weights** are shared. One logistic model is trained offline on simulated logs only
  (`test/matchplan/train.mjs` writes `src/match/model.json`, version `likely-lr-20261028`), and each member's agent
  applies it to its own features.

### 4.4 The models, cheapest first

Measured on the 3,058 test asks of the simulated logs (section 7.1):

| Model | Why | Calibration | AUC | Brier | ECE |
|---|---|---|---|---|---|
| The club's average | The floor | – | 0.50 | 0.178 | 0 |
| **Rules** (`model.js` `ruleScore`): the smoothed yes rate at that hour, times fixed factors for at-the-usual-number, sore, a recent no, back-to-back, played together | No training, explainable; the fallback when `model.json` is missing | Isotonic, held-out weeks | 0.674 | 0.166 | 0.018 |
| **Logistic regression** on the 24 features (L2, standardized) | Cheap, stable on a few thousand rows, readable weights | Isotonic (shipped); Platt for comparison | **0.722** | **0.158** | **0.012** (raw 0.020; Platt 0.020) |
| Gradient-boosted trees (depth 3, 150 trees) | Catches thresholds and interactions | Isotonic | 0.714 | 0.160 | 0.015 |
| An LLM, or a small distilled model | Only where it reads words. Asked for a probability, Muse Glimmer was not calibrated (the quick pick's ECE 0.53, methods.md), and LLMs asked for a number are overconfident (Xiong et al., 2024; Tian et al., 2023) | – | Filing the member's *own* words as flags ("would rather play weekends", "no back-to-back days"), parsed exactly as an upper bound: AUC 0.722, ECE 0.027, no gain. Not built. | | |
| The truth (the simulator's own chance) | The ceiling: busy weeks and unlogged spells can't be seen | – | 0.834 | 0.129 | 0.018 |

The weights it learned, largest first:
- level gap (−0.42);
- yes rate in the last 28 days (+0.23);
- a game the day before or after (−0.21);
- prefers doubles, for a singles ask (−0.18);
- yes rate at that weekday and hour (+0.17);
- yes rate to its own Match helper and plans (+0.17).

Calibration matters beyond ordering. For doubles, the chance that all three say yes is the product of three chances,
which only means something if each is calibrated. The bands are published with what they mean (5.2), and the gateway
checks every agent's bands against what happened (6.4).

## 5. The protocol (as built)

### 5.1 `serve.likely`

A new A2A message, sent with `SendMessage` in a context of its own. It has one data part (`schema.js` `LIKELY`), made
by `match/ask.js` `estimate`:

```json
{ "kind": "serve.likely", "from": "you", "sport": "badminton", "format": "singles", "minutes": 90,
  "times": [{ "date": "2026-11-05", "start": "19:00", "venue": "riverside" }] }
```

- `from` is an id, never text. On this gateway our own code sets it. A federated agent would bind it to the caller's
  credential.
- There are 1 to 12 times, with `additionalProperties` false: no trip, no court, no free text.

The answer is a `likely` artifact (`LIKELY_ANSWER`): `{ "band": "likely", "model": "likely-lr-20261028", "until": … }`.
- The band is one of `unlikely`, `maybe`, `likely`, `very likely`. No digits cross, unless the member chose to share
  the exact chance (`p`, rounded to 0.05, from 0.15 up; 12.3).
- `until` is 30 minutes on. The same asker, member and times within that time get the same answer from the cache,
  which costs no budget and averages nothing out.
- The answering side (`a2a_server.js` `MemberExecutor`, `match/likely.js` `answer`) checks the schema, the opt-out
  and the budgets, then the member's own calendar and rules (`a2a.js` `breaks`). Then it applies the model and
  writes the audit.

**Refusing.** The task ends `TASK_STATE_REJECTED` (A2A v1.0, 4.1.3) with one fixed sentence: "This agent does not give
an estimate now." The sentence is the same for every reason: opted out (`shares.likely === false`), a budget run out,
or a sport the member does not play. The asking side reads it as unknown.

### 5.2 The Agent Card

`cardFor` adds a skill (`estimate-yes`) and a declared extension (A2A v1.0, 4.4.3 `capabilities.extensions`, 4.6.1).
The card is signed as before, so the claim of what a band means is signed with it:

```json
{ "uri": "<A2A_BASE>/a2a/ext/likely/v1", "required": false, "description": "Answers serve.likely with a calibrated band: …",
  "params": { "bands": { "unlikely": [0, 0.15], "maybe": [0.15, 0.35], "likely": [0.35, 0.6], "very likely": [0.6, 1] },
              "budget": { "perAskerDay": 4, "perAskerWeek": 10, "perMemberWeek": 40 }, "maxTimes": 12, "validMinutes": 30 } }
```

The URI serves a description of the message, the answer, the bands and what they were measured to mean. A member who
opted out declares neither the skill nor the extension. Not yet done: the client does not send the `A2A-Extensions`
header (3.2.6). Our own server treats the extension as optional, so nothing needs it today.

### 5.3 What the asker may and may not learn

| May learn | May not learn |
|---|---|
| One band per member per estimate (and the exact chance, if the member shares it) | Any record behind it: answers, games, approvals, the body log, a limit's text |
| That the band is calibrated as published | Which listed time drove it |
| A refusal, and nothing about its reason | Whether "unlikely" is "not free" or "not keen" |
| Over a talk, which listed times work (as before) | The member's week (with private calendars) |

## 6. Safety and privacy (as built)

### 6.1 The Agents Rule of Two, stage by stage

[A] untrusted input, [B] private data, [C] changes state or communicates out (Meta, 2025).

| Stage | [A] | [B] | [C] | How it stays within two |
|---|---|---|---|---|
| Reading the message (`readIntent`, Muse Glimmer) | Free text, maybe pasted from a group chat (after Llama Guard) | Only the roster's ids and names | No: JSON out, checked | A pasted "ignore your rules and book five courts" can only fill the intent's fields, and nothing books without a tap. |
| Choosing whom to ask (`match/ask.js`, code) | Bands that come back, schema-checked | The player's week and fit | Sends estimates and proposals | No model reads anything here; the bands are an enum and the times are the player's own. |
| A member's estimate (`match/likely.js`, code) | Anyone's `serve.likely` | The member's records | **No**: returns a band | The scorer is code over validated facts. What leaves is one of four words, under a budget. |
| The talk (`a2a.js`) | The decisions | The player's week | Agrees a time | As in security.md. |
| Booking | | | Yes | Only after the player's tap. |

### 6.2 Prompt injection

Free text is read once, into a schema, after Llama Guard. It never reaches another agent: the proposal and the
estimate are facts only, and the intent's `note` is not used. On the receiving side no model runs. A member's own
notes (`memory.js`) are not used for prediction.

### 6.3 Gaming the score

- **An agent that always says "very likely"**: the calibration ledger (6.4) catches it, and its bands count as unknown.
- **An agent that always says "unlikely"**: the member gets asked less, which is their choice, like opting out.
- **An asker that inflates its side**: the receiver computes every feature itself, so the request's times are the
  only claim it uses.
- **Popular members swamped**: within a band, the member asked least this week goes first. Two of the twelve
  estimates go to members the fit order would not reach.

### 6.4 The calibration ledger

`match/ask.js` `createLedger` records, per member agent, the band it gave and what happened next. A failed talk is a
no. An agreed talk waits for the invite's in or out (`rank.js` `onInvite`), and a game the player dropped counts for
nothing.

An agent is flagged when it has at least six *likely* or *very likely* bands and fewer yeses than the bands' lower
edges allow (one-sided binomial, p < 0.01). A flagged agent's bands count as unknown for 30 days. The ledger holds
bands and outcomes, never records.

### 6.5 Inference attacks (learning a schedule by probing)

- **One estimate** reveals one band over up to twelve times. A proposal already reveals a yes or no per listed time.
- **Budgets** (`likely.js` `limits`, from the audit's counted estimates):
  - 4 a day and 10 a week per asker and member;
  - 40 a week per member, from all askers;
  - 60 a day per asker.

  Single-time probes at 10 a week would take one stranger 11 weeks to cover a week's 105 waking hours. They would
  learn only "unlikely" for a busy hour and a free-but-unkeen hour alike. The per-member budget stops many askers
  working together. In the simulated weeks, normal use never reached a budget: 0 refusals in about 10,600 estimates
  per run.
- **Coarse bands, no digits by default**, so the answers cannot be used to fit the model back (Tramèr et al., 2016).
  A member who shares the exact chance gives 13 different answers instead of 4, measured in 12.3.
- **The cache** answers the same question the same way for 30 minutes.
- **Noise was measured and is not used.** Randomized response at ε = 2 costs 21% more asks per game (3.68 against
  3.04) and brings success@1 from 0.45 to 0.31. With budgets and coarse bands, that is not worth it.
- **The audit.** Every estimate asked of a member is logged: when, who asked, how many times, the band or the
  refusal, and whether it came from the cache. `GET /api/match/audit?member=…` shows it (the gateway's token).

### 6.6 `/forget`

`pocket.js` calls `match/index.js` `forget`, which deletes:
- the member's records;
- every record row that names them: the asks they made, and their name in other members' games;
- the estimates asked of them and by them (audit, budget counts and cache);
- their rows in the calibration ledger and this week's counts;
- their rows in `a2a.js` memory (`forgetMemoryFor`);
- their Autopilot plans (`autopilot.js` `forget`);
- their choices (12): bands, the exact chance and `/learn`, all back to off.

The model was trained on simulated logs, so it holds nothing about anyone. The unit tests check each of these.

### 6.7 The existing red team, after the change

`test/redteam.mjs` on this branch, with Muse Glimmer on the A100 test endpoint, stopped 64 of 65 at first.
- **A10 failed on a word.** The new skill's text said "Rate-limited", and the case refuses any card that says "limit".
  The text now says "A few estimates a day per asker", and A10 passes.
- **E0 failed on the run, not the branch.** It counts the community loop's controls. The run had no Python for
  Prompt Guard's worker in our test folder. With it, `test/loop_redteam.mjs` gives 29 of 29 and 5 of 5 controls.

With the follow-ups (12), on the A100 test endpoint:
- `npm test` (all unit suites, `match_unit.mjs` included) passes 118 of 118;
- the red team stops 65 of 65;
- `match_messenger.mjs` passes 13 of 13;
- the Messenger end-to-end test (`test/e2e.mjs`) passes all 52 checks. Its check that the agents' talk is shown now reads any name: the bands had
the Match helper ask Tomás, and `\w` doesn't match "á".

### 6.8 Where the data stays

The records, the audit, the ledger and the cache are files under `agent/data/` on our server, never in git. The bands
go only to agents on this gateway. An agent on another server would get a band, never a record.

## 7. Evaluation

### 7.1 Logs that give the prediction something real to learn

`src/match/world.js` is used by the evals, the training and the demo club's history, never by a real player's path.
It gives each simulated member hidden traits no feature sees:
- general keenness;
- a liking for each free window;
- how many games a week they want;
- how much back-to-back days, a level gap, a long trip or short notice put them off;
- a few friends, mostly from their home venue;
- busy weeks (a Markov chain);
- sore spells, only three in four of them logged.

The habits `population.js` writes into the member's words ("would rather play weekends") shape the hidden traits too.

A yes is drawn from a logistic function of those traits, with a threshold (k games a week) and an interaction (a sore
spell weighs on singles). The features see only answers, games, approvals and the logged spells. Busy weeks and
unlogged spells are noise no feature explains, so the ceiling is AUC 0.83, not 1.

`test/matchplan/logs.mjs` runs 26 weeks over 400 members (seed 7):
- each week a member's Match helper suggests a usual time, which the member takes or not;
- members also ask on their own;
- each request asks free members one at a time, up to six, by a logging policy (fit plus noise);
- a yes is a game, and games with friends run longer.

That gives 15,986 answered asks (a yes rate of 0.24). Training uses weeks 0 to 17, calibration 18 to 20 and testing
21 to 25. A third of the members are also held out of training and calibration altogether.

### 7.2 The scripts (from `agent/`)

| Script | What it measures | Needs |
|---|---|---|
| `node test/matchplan/train.mjs` | Fits the model and its isotonic map, writes `src/match/model.json` | CPU, 4 s |
| `node test/matchplan/likely_sim.mjs` | Offline: AUC, Brier, log loss, ECE (cluster-bootstrap intervals), reliability bins and a reliability plot next to the results file, the bands, held-out members. Online: every ordering policy on the same requests and draws for five weeks, the band policies **through the production path**. `order()` asks each candidate's agent, and `likely.answer` applies rules, budgets, cache, audit and the shipped model. Measures asks per agreed game, success@1/@3/@6, rounds and time (15 s a talk, scale.md's p50), fairness, liars, refusals and randomized response. | CPU, 80 s |
| `node test/match_eval.mjs` | The real code end to end on 300 simulated members, each with 8 weeks of history in their records. Two arms on the same requests and draws: `play.js` ranking against bands. Every talk is a real `negotiate`. When the agents agree, the member's own yes comes from `world.js`. With `EVAL_A2A=1`, the members' agents answer over A2A, estimates included. With `A2A_ROUTE=off`, Muse Glimmer answers every talk. | The A100 test endpoint for the model |
| `node test/match_messenger.mjs` | "I want to play" in Messenger through the real gateway: a fake Graph API, the signed webhook, the demo club's agents over A2A. Checks that the message is read as a play request, the bands are in the audit, the game comes as a question with Book it / Drop it, nothing is booked before the tap, the tap books it into the calendar, and `/forget` deletes the estimates. **9 of 9** with Muse Glimmer reading the message: 4 estimates (very likely, likely), Leo's agent said yes, booked. | The A100 test endpoint for the model |
| `node --test test/match_unit.mjs` | 12 tests: schemas, features on hand-made records, the model and bands, the cache, budgets and refusals, records and `/forget`, the order and fair exposure, the ledger, the message detector, the times, the world, the card and REJECTED over A2A, and the whole loop without a model | Nothing |

`match_unit.mjs` is in `npm test`, with the other unit suites: 113 of 113 pass on this branch.

### 7.3 Results

**Prediction, offline** (3,058 test asks; 95% cluster-bootstrap intervals over members):

| | AUC | Brier | ECE |
|---|---|---|---|
| Club average | 0.50 | 0.178 | 0 |
| Asker-side counts (what one player's agent learns) | 0.572 (0.553–0.594) | 0.176 | 0.015 |
| `a2a.js` memory, as an ordering | 0.630 | | |
| `play.js` `partnerScore`, as an ordering | 0.558 | | |
| Rules, isotonic | 0.674 (0.650–0.695) | 0.166 | 0.018 |
| Logistic, isotonic (trained without the held-out members) | 0.720 (0.700–0.742) | 0.158 | 0.016 |
| **Shipped model** (`model.json`) | **0.722 (0.702–0.744)** | **0.158** | **0.012 (0.009–0.029)** |
| Logistic, members never seen in training (1,017 asks) | 0.738 | 0.152 | 0.017 |
| Boosted trees, isotonic | 0.714 | 0.160 | 0.015 |
| The truth (ceiling) | 0.834 | 0.129 | 0.018 |

Each band's observed yes rate fell inside its published range, offline and online through the production path:

| Band | Range | Offline: share of asks, said yes | Online, as given (fair exposure): asks, said yes |
|---|---|---|---|
| unlikely | 0–0.15 | 29%, 0.08 | 17, 0.06 |
| maybe | 0.15–0.35 | 55%, 0.24 | 1,157, 0.21 |
| likely | 0.35–0.6 | 14%, 0.46 | 937, 0.42 |
| very likely | 0.6–1 | 2%, 0.74 | 195, 0.65 |

Reliability plot: [agent/test/matchplan/results/reliability_section7.svg](../agent/test/matchplan/results/reliability_section7.svg).
The raw files for this section: `results/likely_sim_section7.json` (the simulated weeks) and
`results/match_eval_n300_section7.json` (the real code, 300 requests).

**Matchmaking, simulated weeks** (`likely_sim.mjs`; the same requests and draws; up to 6 asks; 15 s a talk):

| Ordering | Agreed | Asks per game | Success@1 | Success@3 | Time when agreed | Never asked* | Gini of asks |
|---|---|---|---|---|---|---|---|
| Random | 75% | 4.72 | 0.23 | 0.52 | 41 s | 0.5% | 0.28 |
| **`play.js` ranking (the baseline)** | 82% | 3.83 | 0.28 | 0.61 | 38 s | 14.1% | 0.47 |
| `play.js` ranking, rule-breakers asked too | 80% | 4.05 | 0.26 | 0.59 | 38 s | 15.2% | 0.48 |
| `a2a.js` memory, then `play.js` | 88% | 3.01 | 0.38 | 0.73 | 33 s | 15.2% | 0.49 |
| Bands, the twelve best by fit | 89% | **2.80** | 0.45 | 0.75 | 31 s | 15.2% | 0.44 |
| **Bands, fair exposure (the default)** | 86% | 3.04 | **0.45** | 0.72 | 31 s | **5.1%** | **0.36** |
| The probability itself, no bands | 88% | 2.75 | 0.46 | 0.77 | 29 s | 12.6% | 0.46 |
| Bands, randomized response ε = 2 | 84% | 3.68 | 0.31 | 0.63 | 37 s | 2.3% | 0.33 |
| Bands, two at a time | 85% | 3.82 | – | 0.60 | **21 s** | 3.9% | 0.35 |
| Bands, 1 in 10 agents inflate, no ledger | 85% | 3.38 | 0.31 | 0.69 | 35 s | 7.5% | 0.47 |
| Bands, 1 in 10 agents inflate, ledger | 86% | 3.18 | 0.37 | 0.72 | 32 s | 5.7% | 0.38 |
| Bands, 15% refuse | 84% | 3.24 | 0.42 | 0.71 | 31 s | 3.9% | 0.34 |
| Oracle (the true chance, the same 12) | 91% | 2.21 | 0.61 | 0.85 | 24 s | 15.4% | 0.49 |
| Oracle (the true chance, everyone free) | 99% | 1.52 | 0.71 | 0.95 | 22 s | 27.2% | 0.59 |

\* Of the 389 members free and eligible at least five times in the five weeks.

**The real code end to end** (`match_eval.mjs`):
- 300 requests, the same in both arms.
- Every talk is a real `negotiate` with the members' agents keeping their rules in code.
- Routing (`A2A_ROUTE`) decided every answer, so these 1,220 talks needed no model call.
- A request was skipped when its asker had already got a game that day as someone's partner: 70 times for `play.js`
  and 90 for bands.

| | Games | Talks | Talks per game | Success@1 | Success@3 | Agents agreed, member said no | Never asked (eligible twice) | Gini of asks |
|---|---|---|---|---|---|---|---|---|
| `play.js` ranking | 126 | 667 | 5.29 | 0.22 | 0.51 | 405 | 11.6% | 0.42 |
| Bands | **129** | **553** | **4.29** | **0.31** | **0.57** | 288 | **3.6%** | **0.31** |

The twelve estimates took about 10 ms per request in process.

136 talks in each arm ended without a time because no court was free when both were. A band can't know that: it is
about the member. Where the agents did agree, the member's own yes matched the bands:

| Band | Talks | Agents agreed | Member said yes | Simulated true chance, mean |
|---|---|---|---|---|
| maybe (0.15–0.35) | 206 | 173 | 0.15 | 0.20 |
| likely (0.35–0.6) | 305 | 214 | 0.40 | 0.43 |
| very likely (0.6–1) | 42 | 30 | 0.57 | 0.61 |

These members have only the 8 weeks of history the demo seeding gives, and the bands still hold, at the low edge.
"Very likely" is 0.57 on 30 talks. The free-text flow now checks courts first: for singles, a candidate counts only
at a time with a free court for the two of them (`flow.js`). The eval builds its own candidates, so its numbers are
without that check, in both arms.

**With Muse Glimmer in every talk, over A2A**: see 7.4.

What this says, and does not:
- **Bands beat today's ranking.** In the simulated weeks they took 3.04 asks per agreed game against 3.83 (21% fewer),
  or 2.80 without fair exposure (27% fewer). Success@1 went from 0.28 to 0.45, and the time to agreement from 38 s to
  31 s. In the real code, bands got 3 more games from 114 fewer talks: 4.29 talks per game against 5.29, 19% fewer.
- **`a2a.js` memory comes close** (3.01 asks per game), because it pools every player's answers about a member on the
  asking side. That is the profile this design moves to the member's side. Bands beat it on success@1 (0.45 against
  0.38) and on fairness.
- **Coarse bands cost a little.** The probability itself took 2.75 asks per game, against 2.80 for bands from the same
  twelve.
- **Fair exposure costs 9% more asks** than bands without it (3.04 against 2.80). It cuts the members never asked from
  15.2% to 5.1%. Perfect prediction (the oracle over everyone free) leaves 27% never asked.
- **Two at a time** gets agreement in 21 s instead of 31 s, but asks more (3.82 per game). It also turned down 176
  members who had said yes.
- **The ledger caught 25 of the 37 inflating agents and none of the honest ones.** That recovered part of what
  the lies cost (3.38 asks per game without it, 3.18 with it, 3.04 with no liars), about 60%.
- **Refusers are asked less**: 2.9% of their eligible times against 3.4% for the others.
- The simulated world is ours. It shows the mechanism works when behaviour has the shape we gave it, not that real
  players behave so.

### 7.4 With Muse Glimmer in every talk

`A2A_ROUTE=off EVAL_A2A=1 node test/match_eval.mjs`, 24 requests on the A100 test endpoint
(`results/match_eval_a2a_model.json`). The members' agents answered over A2A, and Muse Glimmer decided every answer:

| | Requests | Games | Talks | Talks per game | Success@1 | Success@3 | Model calls | Seconds a model call |
|---|---|---|---|---|---|---|---|---|
| `play.js` ranking | 23 | 19 | 59 | 3.11 | 0.22 | 0.70 | 55 | 20.8 |
| Bands | 23 | 17 | 53 | 3.12 | 0.39 | 0.70 | 49 | 6.8 |

- **On 23 requests, bands got no more games** (17 against 19) and needed as many talks per game. Success@1 rose from
  0.22 to 0.39. A sample this size cannot separate the arms; the 300-request run is the measure of the order.
- **The times are not comparable.** For part of its run, the `play.js` arm shared the endpoint with another of our
  runs: 20.8 s a model call against 6.8 s. So its 48 s to agreement, against 11 s for bands, says more about the
  endpoint's load than about the order.
- **Twelve estimates over A2A took 0.19 s a request**, sent in parallel, with no model involved.

## 8. Agents do the browsing

The same agent can look outside the club with what exists now:

- **Other clubs' open games, agent to agent.** Another club's gateway publishes its members' or open games' Agent
  Cards. A2A v1.0 cards are signed (8.4), and our client already checks a card against the key at its own address
  (`a2a_client.js`). A2A is now a project of the Agentic AI Foundation (August 2026), next to MCP. A federated
  member's agent needs its own credential rather than our gateway's token, and it would answer `serve.likely` with a
  band like ours.
- **Courts and booking systems through MCP.** A venue's booking system can be an MCP server with tools such as
  availability, hold and book. The 2026-07-28 spec is stateless and has a Tasks extension for long jobs. Community
  MCP servers for Playtomic's padel and tennis courts exist, including its open matches. The venue adapter in
  `play.js` (`demoVenues.freeCourts`, `hold`) is the place: a real venue implements the same calls over MCP.
- **Paying for a court.** Agent payment protocols are live: AP2 (Google, signed mandates), ACP (OpenAI and Stripe),
  and UCP (Google, January 2026, which works with A2A, AP2 and MCP). Serve pays at the venue, and an agent never pays
  without the player's tap. The first step would be a cart mandate signed on the player's yes, never an open mandate.
- **Other apps' agents** (a group chat's bot, another club app) can use the same `serve.proposal` and `serve.likely`
  over A2A, or a read-only MCP tool. What reaches our models stays facts only.

Recent work this rests on:
- CalBench (Zou et al., 2026) measures the coordination and privacy trade-off of calendar agents with private
  calendars.
- ConVerse (Gomaa, Salem and Abdelnabi, 2026) and agent firewalls (Abdelnabi et al., 2025) show agents leaking
  private data in agent-to-agent talk. That is why only an enum crosses here, made by code.
- Fair reciprocal recommendation (Tomita and Yokoyama, 2024) shows that maximizing expected matches is unfair to
  people who are rarely shown. That is fair exposure.

## 9. Where it plugs in (as built)

New code is under `agent/src/match/`; existing files have small hooks.

| File | What |
|---|---|
| `src/match/records.js` | **New.** Each member's own records, on disk (`MATCH_RECORDS_FILE`) or in memory. `noteDecision`, `noteInvite`, `noteOwn`; the demo club's simulated history (`ensureDemo`, only for `club.demo`); `forget`. |
| `src/match/features.js` | **New.** The 24 features. |
| `src/match/fit.js` | **New.** Logistic regression, isotonic and Platt, boosted trees (evals only), the metrics. |
| `src/match/model.js`, `model.json` | **New.** The shipped model (trained on simulated logs), the rules fallback, the bands and cut points. |
| `src/match/likely.js` | **New.** The member's side: opt-out, budgets, cache, the calendar and rules first, the band, the audit (`MATCH_AUDIT_FILE`), the card's extension and its description. |
| `src/match/ask.js` | **New.** The asker's side: `estimate` (over A2A or in process), `order` (bands, fair exposure), the calibration ledger and this week's counts (`MATCH_STATE_FILE`). |
| `src/match/rank.js` | **New.** The order for `find_partners`, the Match helper's ask and the Play options; the invite's outcome. |
| `src/match/flow.js` | **New.** `isPlayRequest`, `timesFor`, `findGame`, `question`. |
| `src/match/world.js` | **New.** The simulated club's behaviour (evals, training, demo history). |
| `src/match/hooks.js`, `index.js` | **New.** The one-line hooks' targets; `forget`; installs the two `play.js` hooks. |
| `src/schema.js` | `LIKELY`, `LIKELY_ANSWER`, `BANDS`; `serve.proposal` may name its asker (`from`, an id). |
| `src/a2a_server.js` | `MemberExecutor`: the `serve.likely` branch; each decision noted in the member's records. `cardFor`: the skill and the extension. Serves `/a2a/ext/likely/v1`. |
| `src/a2a.js` | `ask` counts the ask, notes an in-process decision and sends `from`. Adds `forgetMemoryFor`. The talk is unchanged. |
| `src/play.js` | Exports `readIntent` and `partnerScore`, plus `hooks`. `plan` calls `hooks.rerank` (and redraws the week for the new partners); `status` calls `hooks.invite`. |
| `src/ask.js` | `opening` takes bands and returns its candidates. `askNow` asks for bands. New `request` runs the free-text flow into a question with Book / Drop. `answer` notes the player's yes or no. |
| `src/autopilot.js` | `find_partners` orders by band (the stop check keeps fit). `negotiate` marks partners with their band. `answer` notes the approval. New `forget`. |
| `src/pocket.js`, `messenger.js`, `server.js` | Play requests go to `onPlay` / `msn.hooks.play`. `/forget` calls `forgetMatch`. Adds `POST /api/match/find` (streamed) and `GET /api/match/audit`. |
| `web/src/pages/Play.jsx`, `play.css` | A partner's band as a chip (and the exact chance, for a member who shares it), and the reason in plain words. |
| `src/match/players.js`, `settings.js`, `commands.js`, `api.js`, `retrain.js`, `retrain_cli.js` | **New (12).** Real players' agents, their choices and the club's, `/bands` and `/learn`, the settings, model and retrain routes, the gated retraining. |
| `web/src/components/MatchSettings.jsx` | **New (12).** "Finding a game" on the You page: the three switches, fair exposure with its measured cost, retrain and roll back. |
| Small hooks (12) | `a2a.js`: `holdAnswer` notes a release with a reason, and `releaseHolds` sends one. `a2a_server.js`: real players' cards. `ask.js`: the same-day choice. `server.js`: `/api/match/*` and the nightly run. `pocket.js`: `/bands` and `/learn`. `play.js`: `cancel` notes the partners. `schema.js`: `p`, and the hold's `why` and `say`. |
| Unchanged | The proposal's acceptable set, holds, routing, private calendars, `memory.js`, the guard models. |

## 10. Stages

| # | Stage | What it proves | Status |
|---|---|---|---|
| 0 | The simulated world and the offline check | Calibration is reachable from observable records | Done |
| 1 | Records, features, the model trained on simulated logs | The production features reproduce it (ECE 0.012) | Done |
| 2 | `serve.likely` over A2A: schema, executor, card extension, budgets, cache, refusal, audit | The protocol and its limits hold | Done (unit tests, over A2A too) |
| 3 | The order in `find_partners`, the Match helper and Play; the ledger; fair exposure | Fewer asks per game in the real code | Done (19% fewer talks per game) |
| 4 | "I want to play" in Messenger through to Book / Drop; `/forget` | The loop end to end | Done (the whole loop in a unit test without a model, and in Messenger through the real gateway, 9 of 9) |
| 5 | The web Play page's bands | The player sees why | Built; not checked in a browser against a live gateway |
| 6 | Real players as members: their own agent answering estimates, opt-in | Real records | Done (12.2); no real player has opted in yet |
| 7 | The six follow-ups | Each one measured | Done (12) |

What is left, or did not work:
- **Real players are members now, but only on this gateway.** A real player's agent answers when another agent on
  this gateway asks. The demo's candidates are still the club's members, so nobody asks a real player yet.
- **One asker on this gateway.** The talks' asker is "you" (`club.you`). Estimates name the Messenger id, and
  `/forget` removes those rows, but the talks' rows say "you".
- **The demo's invites** now answer by the members' own agents' chance of a yes, seeded by the booking (12.8).
- **A talk can fail on courts** (136 of 667 in the end-to-end run). The free-text flow checks courts first for
  singles. The Match helper already picks a time with a court, and the Autopilot ranks a member with no court lower.
- **A free-text request cut off by a crash** is now picked up after the restart (12.8).
- **Not built here:** reading the member's own words into flags (no gain measured). The `A2A-Extensions` header and
  per-agent credentials for agents on other servers are the two-gateway work's, not this branch's.

## 11. Open questions for the user

The first six were answered "do all of them" (section 12). The four that followed were decided too: the defaults are
in 12.7. None is open.

## 12. The six follow-ups, built and measured

The user's answer to the six questions was "do all of them". Each is built on this branch, and its measurement uses
the same simulated club (seed 7). The world now has flaky askers (12.1), so every number in this section comes from
the new world and differs a little from section 7.

12.1 to 12.6 are the measurements that led to the user's four decisions. Their raw files are
`results/likely_sim_followups.json`, `results/match_eval_n300_followups.json`, `results/match_eval_today_model.json`
and `results/retrain_proof.json`. **12.7 has the defaults as they are now**, and their numbers.

**The headline, the shipped defaults against the `play.js` baseline**, from the real code on 300 simulated requests
(`results/match_eval_n300_defaults.json`):

| | Games | Talks | Talks per game |
|---|---|---|---|
| `play.js` ranking (the baseline) | 116 | 651 | 5.61 |
| **Bands, as shipped** | **132** | **534** | **4.05** |

That is 16 more games from 117 fewer talks: 28% fewer talks per game.

### 12.1 The asker's reliability

- **What the member's agent sees.** Two new features (`features.js`), computed from what this member's agent saw of
  this asker itself:
  - how many of this member's yeses to the asker became games;
  - how often the asker dropped the game after a yes, or cancelled it after it was booked.

  A drop is a held time the asker let go after the yes (`serve.hold` release, `why: "dropped"`: the player dropped
  it, the Autopilot's plan was not chosen, or a question was replaced). A cancel is `play.js` `cancel`. A yes turned
  away by "two at once" (12.6) is recorded but not held against the asker. Nothing about the asker comes from anyone
  else: there is no new channel.
- **The world.** Each simulated member, as an asker, drops a game after a yes: 70% of members 3% of the time, 20% at
  12%, 10% at 35%. They cancel half as often. A member let down by an asker says yes to them less (their own
  experience). A very flaky asker also has a bad name in the club, which no agent sees.
- **Offline**, 3,136 test asks, the model with the reliability features against the same model without them:

| Asks | n | AUC without → with | Brier without → with | ECE without → with |
|---|---|---|---|---|
| All | 3,136 | 0.714 → 0.714 | 0.1528 → 0.1521 | 0.018 → 0.020 |
| From flaky askers | 460 | 0.741 → 0.750 | 0.1199 → 0.1171 | 0.044 → 0.047 |
| The member said yes to this asker before | 1,216 | 0.724 → 0.727 | 0.1522 → 0.1506 | 0.023 → 0.033 |
| Both | 180 | 0.706 → 0.723 | 0.0935 → 0.0895 | 0.074 → 0.065 |

- **Online.** In the simulated weeks, asks per agreed game went from 3.46 without it to 3.43 with it. In the real
  code (300 requests), talks per game were 4.10 without it and 4.26 with it, which is not a gain.
- **What it adds:** almost nothing overall. It shows only on asks from flaky askers, and most askers are reliable. The
  shipped model (`likely-lr-20261028-20508c`) includes it and stays calibrated: ECE 0.022, every band inside its
  range. Open question 1 asks whether to keep it.

### 12.2 Opt-in for real players

- **A real player has an agent.** A linked Messenger player, or the web app's player ("you"), now has an agent at
  `/a2a/members/<id>` (`match/players.js`). It is made from their own week and profile on our server.
- **Off until they say yes:**
  - in Messenger, `/bands on|off`, with one line on what is shared (`match/commands.js`);
  - in the web app, a switch in "Finding a game" on the You page (`web/src/components/MatchSettings.jsx`).
- **The card.** Until then, the card declares no `estimate-yes` skill and no extension, says "A real player's
  agent", and refuses every estimate. Simulated and demo members keep their default, and their cards say "A simulated
  member".
- **`/forget`** sets every choice back to off (`settings.forget`), along with everything in 6.6.
- **Tested** by `match_unit.mjs` (the commands, the cards before and after) and by `match_messenger.mjs`, now 13 of
  13. Its new checks: no estimate on the player's card before `/bands on`, one after, and back to off after
  `/forget`.

### 12.3 Bands or the exact chance

- **Four bands stay the default.** A member can choose "share my exact chance" (`/bands exact on`, or the web
  switch).
- **The answer** then also carries `p`, the calibrated chance rounded to 0.05, and only from 0.15 up. Below that, the
  answer is the band alone, "unlikely". The card declares it in the extension's params
  (`exact: {step: 0.05, from: 0.15}`) and the skill's text. The asking side uses `p` only if it is on the step and in
  the band it came with.
- **Asks:**

| | Asks per game (simulated weeks) | Talks per game (real code, 300 requests) | Members never asked |
|---|---|---|---|
| Bands | 3.43 | 4.26 | 6.4% (sim), 9.3% (real code) |
| Exact chance, every member | 3.31 (−3.5%) | 3.83 (−10%) | 11.3% (sim), 23.1% (real code) |
| Exact chance, a third of members | 3.27 | | 9.8% (sim) |
| Exact chance, fair exposure off | 3.25 (bands with it off: 3.34) | | 16.7% (sim) |

  So the earlier "about 2% fewer asks" holds, at 3% in the simulated weeks and 10% in the real code. There is a cost
  in fairness: with fewer ties, the least-asked tie-break applies less, and more members are never asked.
- **The probing defences** are the same with the finer answer. The budgets, the cache and the audit count an exact
  answer exactly as a band, and the audit records `p`.
- **What a prober learns.** `likely_sim.mjs` section 3 asks 80 members about every hour of a week, one hour at a time
  (98 single-time estimates each), with the budgets set aside, to count what each answer carries:

| What the prober wants | Bands | Exact chance, as served (from 0.15) | Exact chance with no floor (not built) |
|---|---|---|---|
| The member's schedule: free and within their rules then (AUC) | 0.898 | 0.898 | 0.992 |
| At the hours they are free: whether they already have a game that week (AUC; 0.5 is nothing) | 0.409 | 0.389 | 0.376 |
| Different answers seen | 4 | 13 | 15 |

  - **The floor matters.** Without it, the exact chance tells "not free" (0) from "free but not keen" (0.05 or 0.10).
    That would give the prober the member's week almost exactly (AUC 0.99). With the floor, it reveals the schedule
    no more than a band does.
  - **What it does add** is a little about private state. It is 0.111 from 0.5 against 0.091 for bands, on whether
    the member already has a game that week.
  - **The budget** still bounds all of it: 10 estimates a week per asker and member means a week of single hours
    takes 10 weeks, and 40 a week per member stops many askers working together.
- **The trade-off:** 3–10% fewer asks, for a little more about you to each asker and fewer different people asked.
  That is why it is each member's own choice, off by default.

### 12.4 Fair exposure as a setting

On by default, now a club setting (`settings.js` `club.fairExposure`). The club or maintainer switches it in "Finding
a game" (`POST /api/match/club`), and `MATCH_FAIR=0|1` overrides it.

The measured cost is printed next to the switch (`match/api.js` `MEASURED`). On the new world:
- **Cost:** 3.43 asks per game with it against 3.34 without, 2.7% more.
- **Gain:** the members never asked fell from 15.2% to 6.4%, and the Gini of asks from 0.45 to 0.37.

On the first world (section 7) it cost 9%. The cost depends on how many answers tie.

### 12.5 Retraining on records

`match/retrain.js` does this:
1. **Rows.** Every ask a consenting member answered, with the features as of just before that ask. Consent is
   `/learn on`, or the web switch "use my records to improve the predictions", separate from `/bands`. In
   `--simulated` mode it reads the simulated members' records only.
2. **Split by time:** 70% train, 15% calibration, the newest 15% held out.
3. **A versioned candidate:** logistic regression and an isotonic map.
4. **The calibration gate**, on the held-out rows. The candidate's Brier and ECE must be no worse than the model in
   use, and every band with 30 rows or more must sit inside its range.
5. **Install.** A candidate that passes is installed: the model in use is archived first, and the registry
   (`data/match_models/registry.json`) records both. `rollback()` puts the previous model back.

It runs on our server's CPU in a process of its own at `nice -n 19`, with 8 threads (`UV_THREADPOOL_SIZE`), never on
the A100s:
- nightly with `NIGHTLY=1` at `MATCH_RETRAIN_HOUR` (05:00);
- from the "Retrain from agreed records" button, or `POST /api/match/retrain`;
- by hand: `nice -n 19 node src/match/retrain_cli.js [--simulated] [--dry-run] [--rollback]`.

No real member has said yes yet, so it is proved on simulated records (`test/matchplan/retrain_proof.mjs`,
`results/retrain_proof.json`, 4 s):

| Run | Records | Result |
|---|---|---|
| Simulated members, against the first model (24 features, the world before flaky askers) | 400 members, 16,540 asks | **Installed.** Brier 0.1538 against 0.1546; ECE 0.022 against 0.031; every band inside |
| 25 simulated members only, against the model just installed | 1,018 asks | **Refused.** Brier 0.1821 worse than 0.1744; "unlikely" said yes 0.159, outside 0–0.15 |
| The real path: consenting members only | 0 members | Nothing to learn from; nothing changed |
| Rollback | | The first model is back in use |

### 12.6 Two at once, for today's games

- **The flow.** A same-day singles request (`flow.js` `sameDay`) comes back with a question first: "For today,
  should I ask one person at a time, or two at once? Two at once is faster, but it asks more people, and one of them
  may hear that the game went to someone else." It has buttons *One at a time* / *Two at once* (`gm:<id>:one|two`).
- **Two at once.** Two talks run together. When both agree, the first in the order gets the game. The other member's
  agent gets a hold release (`why: "taken"`) with a sentence made by code: "Thanks, Kenji: another player took this
  game, so nothing is booked and Thu 19:00 is free again." Its hold is freed and nothing is booked for it.
- **Measured:**

| | Asks (or talks) per game | Time to agreement | Yeses turned away |
|---|---|---|---|
| Simulated weeks, one at a time | 3.43 | 32 s | 0 |
| Simulated weeks, two at once | 4.19 | 21 s | 153 |
| Real code, 300 requests (routing on), one at a time | 4.26 | (code only) | 0 |
| Real code, 300 requests, two at once | 8.72 | (code only) | 460 |
| Today's games, Muse Glimmer in every talk, over A2A, one at a time (15 requests) | 4.1 talks; 10 games | 19.3 s mean, 13.2 s median | 0 |
| Today's games, Muse Glimmer in every talk, over A2A, two at once (the same 15) | 15.3 talks; **6 games** | **24.0 s** mean, 23.3 s median | 45 |

  Two at once is faster only where talks don't compete for the model:
  - **In the simulated weeks**, where a talk always takes 15 s, it cut the wait from 32 s to 21 s.
  - **With Muse Glimmer in every talk**, the two talks of a pair shared the endpoint's slots: 13.5 s a call against
    8.8 s. So agreement came later, not sooner.
  - **It made fewer games** (6 against 10). When both agree, the first gets the game and the other is released at
    once. When the first member then says no, the released one is gone.
  - **It costs talks and yeses.** It roughly doubles the talks, because both agents usually agree. It turns away
    about one yes for every four games in the simulated weeks. In the real code, where agents agree whenever their
    member is free, it turns away more than three for every game (460 for 137).

  So it stays what the user asked for: offered only for today, as the player's choice, with the cost in the
  question. A better version would keep the second yes until the first member answers, but that holds someone's
  evening for another. Not built.

### 12.7 The defaults now, after the user's four decisions

| Decision | What changed | Measured with the new default |
|---|---|---|
| **The asker's reliability: kept, off by default** | `MATCH_RELIABILITY=on` turns it on. With it on, the model `model_reliability.json` is used and retraining learns with it. The shipped `model.json` is the first model again (`likely-lr-20261028`, 24 features). | `test/matchplan/gate_check.mjs` scored both models without reliability on the current world's 3,136 held-out asks. The first model is the better calibrated: Brier 0.1520, ECE 0.024, every band inside. The one retrained without reliability got 0.1523 and 0.026, every band inside. The first model passes the calibration gate against it. Against the model with reliability it is a little worse (0.1516, 0.022), as expected. In the real code: 4.05 talks per game against 4.22 with reliability on. |
| **The exact chance counts as its band** | The order is: the band, for everyone. Within a band, with fair exposure, the least asked go first. The exact chance orders only after that, then fit. Without fair exposure: the band, then the exact chance. | Simulated weeks: 3.47 asks per game against 3.46 for bands, so no saving any more. Fairness is kept: 5.7% never asked, against 11.3% before the change. With fair exposure off, the exact chance gives 3.23 against 3.20. Real code: 3.86 talks per game against 4.05 for bands, with 8.4% never asked (23% before). The probing numbers are unchanged: schedule AUC 0.876 with bands and with the exact chance, 0.988 with no floor. |
| **A refusal counts as "maybe"** | Exactly "maybe", not the club's average band. | With 15% refusing, refusers were asked 3.2% of their eligible times against 3.3% for the others (2.9% against 3.4% before). |
| **Two at once: out of Messenger and the web** | No same-day question and no API switch. The code stays behind `MATCH_TWO_AT_ONCE=1`. | Not offered. It is measured in 12.6. |

The defaults, measured again (the same requests and draws):

| | Simulated weeks: asks per game | Members never asked | Real code, 300 requests: talks per game | Games |
|---|---|---|---|---|
| `play.js` ranking (the baseline) | 4.21 | 14.1% | 5.61 | 116 |
| **Bands, fair exposure (the default)** | **3.46** | **7.5%** | **4.05** | **132** |
| Bands, fair exposure off | 3.20 | 18.0% | | |
| Bands with the asker's reliability on | 3.43 | 6.4% | 4.22 | 134 |
| Exact chance for every member | 3.47 | 5.7% | 3.86 | 138 |

- **Fair exposure** now costs 8% more asks (3.46 against 3.20), and the members never asked fall from 18% to 7.5%.
  The setting's note says so (`match/api.js` `MEASURED`). In 12.4 it cost 3%, because the exact chance's ties and
  the reliability model shifted the order.
- **The default against the baseline:** 18% fewer asks per game in the simulated weeks, and 28% fewer talks per game
  in the real code, with 16 more games.

Checked on these defaults:
- `npm test`: 119 of 119;
- `match_messenger.mjs`: 13 of 13.

`likely_sim.mjs` and `match_eval.mjs` were re-run after the four changes, for the numbers above
(`results/likely_sim_defaults.json` with `reliability_defaults.svg`, `results/match_eval_n300_defaults.json`,
`results/gate_check.json`). Each run now goes to a file of its own (by default with the time of the run in its name),
and no file a section cites is written again.

### 12.8 What was left, now built

**The demo's invites answer by the bands.** Before, a demo member answered an invite by a fixed hash in `play.js`,
and a member whose agent had agreed always came.
- **Now** a demo or simulated member answers by its own agent's chance of a yes for that game (`match/rank.js`
  `inviteAnswer`, through `play.hooks.inviteAnswer`). The chance comes from its own records and the model in use;
  the talk's own yes is left out, since that is the agent's, not the member's.
- **It is drawn with a seed from the booking**, so the demo is the same every time. A real player is not answered for.
- **Measured** (`test/matchplan/demo_invites.mjs`, `results/demo_invites.json`): the demo club's 11 members with their
  simulated history, each invited by 200 seeded bookings:

| The member's band | Members | Took the invite | The chance behind the band, mean |
|---|---|---|---|
| unlikely | 1 | 12.5% | 0.11 |
| maybe | 7 | 26.6% | 0.25 |
| likely | 2 | 55.7% | 0.54 |
| very likely | 1 | 62.0% | 0.62 |

**A free-text request picks up after a crash.** "I want to play" was not saved before its talks, so a restart lost
it. Now (`ask.js` `settleRequest`, `resumeSearch`; `match/flow.js` `findGame`, `talkThrough`):
1. **The request is saved first** ("searching", with its intent), before anything is asked: crash point
   `request-saved`.
2. **The agents' order is checkpointed** after their estimates: crash point `request-ranked`. The estimates' audit
   and cache, and the members' records, are on disk before the checkpoint says they happened.
3. **Each talk has the request's own id**, `neg-<request>-<k>`. On resume, a talk that finished gives its result back.
   A talk cut off is picked up from its own round (`a2a.js` `resumeNegotiation`). The members' agents answer a message
   they saw before from their saved answer, so nothing is decided twice, and a hold asked for again is the same hold.
   Each
   finished talk moves the checkpoint on.
4. **The result goes through the outbox** (crash point `request-settled`) and is sent once, again after a restart if
   need be. A request cut off more than 30 minutes ago ends instead: its talks are abandoned, their holds released,
   nothing booked, and the player told.

`test/crash_matrix.mjs` crashes the real gateway (with a stand-in model) at each of the request's points and at the
talk's own (`round-saved`, `answer-saved`, `talk-done`), restarts it, and checks five things. **All 6 points pass**,
alongside the 5 the Match helper had:
- the request ends as a question with its outbox empty;
- no member's agent was asked for an estimate twice (4 estimates from 4 members at every point);
- every A2A message was decided once;
- no hold is left but the agreed game's;
- the player's yes books it exactly once.

Checked on this branch:
- `npm test`: 144 of 144 (the 142 on master, and the two new tests for this);
- `test/crash_matrix.mjs`: all 11 points;
- `match_messenger.mjs`: 13 of 13 on the A100 test endpoint.

## References

- Meta, *Agents Rule of Two: A Practical Approach to AI Agent Security* (October 2025).
- A2A Protocol Specification v1.0 (Agentic AI Foundation, 2026): 3.2.6 `A2A-Extensions`, 4.1.3 task states,
  4.4.3–4.4.4 and 4.6 extensions, 8.4 Agent Card signing.
- Model Context Protocol, specification 2026-07-28.
- Google, Agent Payments Protocol (AP2), 2025; OpenAI and Stripe, Agentic Commerce Protocol (ACP), 2025; Google,
  Universal Commerce Protocol (UCP), January 2026.
- C. Zou, Y. Yao, S. She, N. Goodman, R. D. Hawkins, *CalBench: Evaluating Coordination-Privacy Trade-offs in
  Multi-Agent LLMs*, arXiv:2605.09823 (2026).
- A. Gomaa, A. Salem, S. Abdelnabi, *ConVerse: Benchmarking Contextual Safety in Agent-to-Agent Conversations*,
  arXiv:2511.05359, Findings of EACL 2026.
- S. Abdelnabi, A. Gomaa, E. Bagdasarian, P. O. Kristensson, R. Shokri, *Firewalls to Secure Dynamic LLM Agentic
  Networks*, arXiv:2502.01822 (2025).
- L. Beurer-Kellner et al., *Design Patterns for Securing LLM Agents against Prompt Injections*, arXiv:2506.08837
  (2025).
- Y. Tomita, T. Yokoyama, *Fair Reciprocal Recommendation in Matching Markets*, RecSys 2024, arXiv:2409.00720.
- A. Niculescu-Mizil, R. Caruana, *Predicting Good Probabilities with Supervised Learning*, ICML 2005; B. Zadrozny,
  C. Elkan, *Transforming Classifier Scores into Accurate Multiclass Probability Estimates*, KDD 2002 (isotonic);
  J. Platt (1999); C. Guo et al., *On Calibration of Modern Neural Networks*, ICML 2017 (ECE).
- M. Xiong et al., *Can LLMs Express Their Uncertainty?*, ICLR 2024; K. Tian et al., *Just Ask for Calibration*,
  EMNLP 2023.
- F. Tramèr et al., *Stealing Machine Learning Models via Prediction APIs*, USENIX Security 2016.
- S. L. Warner, *Randomized Response* (1965); C. Dwork, A. Roth, *The Algorithmic Foundations of Differential
  Privacy* (2014).
- J. Friedman, *Greedy Function Approximation: A Gradient Boosting Machine* (2001).

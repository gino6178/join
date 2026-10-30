# Methods

How Serve's agents are built, what each design choice rests on, and how every number in the README was measured.

## System

- **Model.** Muse Glimmer (Meta, open weights, 27.9B, Q4 GGUF, 16.8 GB), served by Ollama 0.40.11 on one RTX 3090
  (GPU 1), with 4 requests in parallel and a 16,384-token context. It handles vision, native tool calls, and
  reasoning (`think: "low"`).
- **Cloud A100s.** Some evaluations ran on cloud A100s serving the same Muse Glimmer build (the same model digest),
  reached through the server. Each result below says where it ran.
- **Speech.** Meta's Omnilingual ASR, CTC 1B (`omniASR_CTC_1B`), on the server's CPU in float32.
- **Guards.** Meta's Llama Guard 3 1B (Q8_0) on its own Ollama, CPU only, and Prompt Guard 2 86M through Hugging Face
  Transformers on the CPU ([security.md](security.md#guard-models)).
- **Embeddings.** Meta's DRAMA (`facebook/drama-base`, 768 dimensions) on the CPU, for memory and for grouping the
  community loop's ideas.
- **Gateway.** Node.js 22, with the official A2A SDK (`@a2a-js/sdk` 1.3.0) and the OpenTelemetry JS SDK (2.x).
- **Seeds.** Every simulated member comes from `population.js` with seed 7 (seed 11 for the decider's development set).
- **Temperatures.** 0.3 for a member's decision, 0 for reading a photo.

## How the agents are built

| Pattern | Where | What it rests on |
|---|---|---|
| A tool-using loop whose tools are code: the model picks the next step, code computes the facts. A step budget, and rules that finish the plan if the model stalls. | `autopilot.js` `runWeek` | ReAct (Yao et al., 2023); Anthropic, *Building effective agents* (2024) |
| The run's stop is checked before it is taken. Asking for approval, nudging or finishing while a game is still needed is refused (twice a run at most) when an open time still has players free who were not asked. The model is told which times, and goes on. | `autopilot.js` `notYet` | The evaluator-optimizer workflow (Anthropic, 2024); a verifier on the stop condition |
| Who goes first. The gateway keeps to the model server's 4 slots itself and orders the queue: a call someone is waiting on before background work (an Autopilot run, and its talks' members' answers, whose A2A message carries the priority). | `llm.js` `acquire`, `priorityOf` | Priority scheduling; measured in [scale.md](scale.md) |
| Replies in a JSON Schema: the server constrains decoding to it (Ollama `format`), and code validates it again. A reply that doesn't fit is asked for once more, with what was wrong; one that never fits counts as no answer. | `schema.js`, `llm.js` `chatJSON` | Structured outputs, with a validator for the subset of JSON Schema 2020-12 the schemas use |
| Decide, then word. The model decides; what one agent says to another is a template filled by code, so it costs no tokens and cannot carry an invented detail. | `a2a.js` `says`, `sentence` | |
| Hard rules in code, preferences to the model. Times that break a member's rule are taken off the list before the model decides, and a yes to one is never a yes. | `a2a.js` `breaks`, `fullAnswer` | Measured in [scale.md](scale.md) against leaving it to the model |
| The acceptable-set protocol. The gateway knows the members' free times, so your agent lists the times that fit everyone's calendar and have a court (up to twelve). Each member's agent answers the proposal and also marks which listed times work, and that is binding. Your agent takes the best time in the intersection (one a member asked for first) and never proposes a time someone ruled out; an empty intersection ends the talk at once, so most talks end in round 1. By default this is a one-shot intersection over a centrally computed list. With `A2A_PRIVATE=1` it becomes a search over private calendars: your agent proposes from its own domain (its week), each member's agent checks its own constraints (its calendar and rules) in code, and the times anyone ruled out are tabu in the next round, three rounds at most ([scale.md](scale.md)). | `a2a.js` `rounds`, `breaks` | Contract Net (Smith, 1980); distributed constraint satisfaction (Yokoo et al., 1998), in a simple form |
| Holds and a second check. Once a talk agrees a time, every member's agent holds it (all or nothing) while the player decides: a lease that lapses after 30 minutes, is released on a no and gives way to the booking. A second talk at the same moment hears "already playing then" and takes the next time that works for everyone. Members are asked one at a time in a fixed order, so two talks that share members don't each get half and retry. The booking validates every partner's booked games again, for a hold that lapsed. | `a2a.js` `holdAll`, `play.js` `lease`, `book` | Leases (Gray and Cheriton, 1989); two-phase commit with presumed abort, in a simple form; resource ordering (Havender, 1968); optimistic concurrency control (Kung and Robinson, 1981) |
| The A2A protocol between agents: an Agent Card per member, JSON-RPC `SendMessage`, `GetTask`, `ListTasks` and `CancelTask`, and task states with a decision artifact. One negotiation is one `contextId`. | `a2a_server.js`, `a2a_client.js` | A2A v1.0 (Linux Foundation), on its official SDK |
| Durable execution. Each negotiation is saved before every round (written to a temporary file, then renamed), and a "want a game?" talk cut off by a crash is resumed at the next start (within 30 minutes). An Autopilot run keeps a journal (`data/autopilot_runs/<run>.jsonl`, each line flushed before the run goes on): every model turn before its tool calls run, every tool call's result and what it changed, a talk's id before the talk starts, the checked summary, and the approval message before and after it goes out. A run cut off by a restart is run again from its journal: turns and tool calls already there come back from it (the model is not asked again, the tool does not run again), a talk cut off mid-way is picked up by its id (the same A2A messages, so the members' agents answer from their saved answers, and the same holds), and the approval message goes out once. The player's yes is saved with the games it books before any is booked. A message is answered once (by `messageId` and a fingerprint of the proposal). Results go through an outbox; booking is idempotent; Messenger events are de-duplicated. `test/crash_matrix.mjs` kills the gateway with SIGKILL at 29 points (18 inside an Autopilot run, with the stand-in model) and checks every one. | `a2a.js`, `ask.js`, `autopilot.js`, `autopilot_journal.js`, `jsonfile.js` | Durable execution (write-ahead journal, replay); the transactional outbox; idempotent receivers; Sagas (Garcia-Molina and Salem, 1987) |
| Structured retrieval instead of a long prompt. Code filters and ranks the members, and the model reads the few best. | `autopilot.js` `find_partners`, `ask.js` `opening` | RAG (Lewis et al., 2020); *Lost in the Middle* (Liu et al., 2023); measured in [scale.md](scale.md) |
| A token ledger and per-call budgets. Every model call is logged by call site and job: prompt, cached, output, an estimate of reasoning, seconds, and the trace id. Each call has room for reasoning beyond its answer (900 tokens by default, 300 for the quick pick, per call site with `LLM_BUDGETS`), and prompts keep a stable prefix for the server's cache. | `ledger.js`, `llm.js` | Prompt caching |
| A tiered decision for each member's agent, cheapest first. **Code** decides what the facts decide: when the member's rules leave no listed time it is "not this week" (29 of 60 talks in the rules test), and, for a member whose hard limits are all rules in code (`rulesComplete`), a proposed time that keeps them is a yes, and one time left is the counter (routing, on by default; `A2A_ROUTE=off` to compare). The model is asked only for a real choice between times. Two cheap drafts that answer when they agree were also tried and **left off**: on Muse Glimmer all 16 drafts at a 128-token budget came back empty, because it reasons past that before any answer. A **quick pick** (one option letter, with a calibrated confidence) was built, evaluated and **left off**: on Muse Glimmer it still reasons for about 400 tokens before its one letter, and needs a 600-token budget to answer 3 cases in 4, more than the full answer costs. A **one-pass decider** that reads the choice from the next token's probabilities, with no reasoning (`raw: true`, one token), was built, evaluated and **left off** too: it agreed with the full answer 62.2% of the time where the full answer agrees with itself 73.5% ([decider.md](decider.md)). The **full agent** decides the rest. | `a2a.js` `fullAnswer`, `quickPick`; `decider.js`; `test/persona_eval.mjs`, `test/cascade_eval.mjs`, `test/decider_eval.mjs` | FrugalGPT (Chen et al., 2023); conformal risk control (Angelopoulos et al., 2022) |
| Traces. OpenTelemetry spans by the GenAI agent conventions and the A2A conventions (semantic-conventions-genai at 51a0f58, on semconv v1.44.0, Development status): `invoke_agent` for the agents in the gateway (INTERNAL) and for a member's agent over A2A (CLIENT, `gen_ai.agent.id` its A2A address), an A2A `SendMessage` span under it (`a2a.message.id`, `a2a.task.id`, `a2a.task.state`), `execute_tool` with `gen_ai.tool.type` and an `error.type` from a listed set when a tool call did not do what was asked, `chat` with the cache and reasoning token counts. `gen_ai.conversation.id` is an Autopilot run's id or a talk's A2A `contextId`, never a trace id. W3C Trace Context goes inside each A2A message, so a negotiation across agents is one trace. No message content is recorded. | `trace.js`, `components/TraceView.jsx` | OpenTelemetry GenAI and A2A semantic conventions |
| Failure attribution. When an Autopilot run ends short of its goal (or the rules had to finish it), code reads its trace and names the step it ended on and its kind: tool error, model refusal or format, rule break caught, timeout, agent unreachable, or (no fault) no option left. It is the first failure the run did not get past (a game agreed later, or the same tool working on a later call, means it got past it), looked for inside a talk that failed (the member's agent that timed out, the hold another talk had). The trace view shows it as one line. | `attribution.js`, `components/TraceView.jsx`; `test/attribution_check.mjs` | Who&When (Zhang et al., ICML 2025); MAST (Cemri et al., 2025) |
| Memory by meaning. What the player says is kept as short notes on the server, embedded with Meta's DRAMA, and the closest notes are handed to the Autopilot with the week (and on request, with a `recall` tool); someone the player asked to leave out is then kept out by code (`leaveOut`). Retrieval is scored on its own before any model reads it, against BM25. | `memory.js`, `embed_worker.py`, `autopilot.js`; `test/memory_eval.mjs` | DRAMA (Ma et al., 2025); retrieval-augmented generation (Lewis et al., 2020); LongMemEval (Wu et al., 2025) for scoring retrieval apart from reading |
| Signed Agent Cards. A member's card is signed with the gateway's Ed25519 key; your agent checks the card as served against the key published at the card's own address before it talks to that agent. | `a2a_server.js` `signCard`, `a2a_client.js` `verifierFor` | A2A v1.0 Agent Card signatures (JWS, RFC 7515, over JCS, RFC 8785), with the official SDK's signer and verifier |
| Least power. No agent combines untrusted input, private data and the power to act. A photo is read by a model call with no tools. Bookings need the player. Each agent's published pattern (Action-Selector, Dual LLM, LLM Map-Reduce and the rest) is in the table there. | [security.md](security.md#design-patterns-agent-by-agent) | Meta, *Agents Rule of Two* (2025); Beurer-Kellner et al., design patterns for prompt injection (arXiv 2506.08837); Abdelnabi et al., firewalls for agent networks (arXiv 2502.01822); OWASP Top 10 for LLM Applications (2025); the dual-LLM pattern (Willison, 2023) |
| Guard models as one layer, with a rule for how each fails. Llama Guard 3 1B reads what the player writes and what a model writes for them; Prompt Guard 2 reads reviews. In chat a guard that is down, slow or gives no verdict is skipped and counted; in the community loop's screen it blocks. S6 blocks a text only when code also finds a dose, a medicine or a condition; plain words of self-harm get the helpline even without the guard. | `guard.js`, `guard_worker.py`; `test/guard_eval.mjs` | Llama Guard (Inan et al., 2023) and the Llama Guard 3 and Prompt Guard 2 model cards; held-out sets written before the policy was settled |
| Two tiers of consent, and one yes per shared item. `/improve on` counts thumbs and unmet requests with no words; a request's words leave the player's record only as one paraphrase that code has checked and the player has shared. Every loop record is keyed by an HMAC of the player id. | `loop/signals.js` | Clio (arXiv 2412.13678): summaries, no names, minimum cluster sizes |
| Ideas grouped by meaning, shown at 5 distinct members, proposed only with weekday and weekend support, and ranked by quadratic votes (9 credits a month, n votes cost n²), all recounted by the review. | `loop/proposals.js`, `loop/review.js` `support` | DRAMA; quadratic voting (Lalley and Weyl, 2018); bridging, in a simple two-group form |
| The class of a change comes from what it does (a declared setting inside its range, wording, a tool parameter, anything else), never from what a draft claims. A never-list is checked on the spec and on any diff; the diff patterns follow CodeShield's rules. | `loop/review.js` `classify`, `check`; `test/policy.mjs`; [never.md](never.md) | LlamaFirewall's CodeShield (arXiv 2505.03574); CaMeL (arXiv 2503.18813) |
| Flags, a canary and rollback by code. A setting ships to beta members in an HMAC bucket under 20%, one canary at a time. A hard breach turns it off at once; a soft one (thumbs down up 10 points with a one-sided two-proportion z of 1.645 or more, or the requests not falling) turns it off and reopens the proposal. | `loop/flags.js`, `loop/cycle.js` | Canary releases; AlphaEvolve (arXiv 2506.13131) for keeping a change only when evaluators pass it |
| A coding agent that never reads community text. It works in its own git worktree from the spec's change, files and oracle, with tests and the never-list read-only, a sandbox with no network for its tests, and nine gates after it. A person merges. | `loop/builder.js`, `loop/gates.js` | Darwin Gödel Machine (arXiv 2505.22954), which hacked its own evaluation; Misevolution (arXiv 2509.26354) |
| Matchmaking by a band each member's own agent gives. Your agent asks up to twelve members' agents at once how likely a yes is (`serve.likely`, an A2A extension declared in the signed card). Each answers from its own member's records with one of four bands, never the records; refusals read the same; budgets, a cache, an audit and a calibration ledger stand against probing and inflated bands. Your agent orders by band, then by who was asked least this week. | `match/likely.js`, `match/ask.js`, `match/model.js`; [agent_matchmaking_plan.md](agent_matchmaking_plan.md) | Logistic regression with isotonic calibration (Zadrozny and Elkan, 2002); fair reciprocal recommendation (Tomita and Yokoyama, 2024) |
| Orbit replays decided per moment, with a check that the target exists. A threshold on invented pixels, learned from labelled frames, sets the arc; SAM 2.1 as a video tracker, the reel's track and keypoint confidence, with hysteresis, say whether the player and the hand are there. A prototype, not in the app. | `video/pose/orbit.py`, `exists.py` | MapAnything (arXiv 2509.13414); SAM 2 (Ravi et al., 2024) |

## Evaluations

Each runs on the GPU server from `agent/`, writes its own files only, and can be run again. On the current code
(2026-10-28): `npm test` 118 of 118 <!-- COUNT --> ([agent_matchmaking_plan.md](agent_matchmaking_plan.md);
`submission/results/unit.log` is the run before matchmaking's suite joined, 101 of 101); Messenger end to end 52 of 52 <!-- COUNT -->
(on a cloud A100, `submission/results/e2e.log`); the attacks 65 of 65 <!-- COUNT --> (on a cloud A100, `submission/results/redteam.log`),
the loop's 29 with its 5 controls among them (the server's CPU, real guards); the crash matrix 20 of 20
(`submission/results/crash_matrix.log`); "I want to play" in Messenger 13 of 13 ([agent_matchmaking_plan.md](agent_matchmaking_plan.md);
`submission/results/match_messenger.log` is the earlier run of the first 9).

- **Messenger end to end** (`node test/e2e.mjs`). A fake Graph API on the same machine talks to the real gateway,
  and a scripted player messages the Page through the signed webhook. It covers linking, the calendar, "want a game?"
  (asked unprompted, another time, a yes agreed over A2A and booked, not this week), the Autopilot with approval,
  reminders and check-ins, the body log, a health export, a scoreboard photo, `/report`, feedback,
  a violent threat that gets only a refusal and nothing filed, a self-harm message that gets the helpline, the
  community loop (`/improve on`, `/idea`, Share, its data keyed by an HMAC), `/forget` deleting all of it, and the
  gateway token's and cross-site checks. 52 checks <!-- COUNT -->, all passing, with Muse Glimmer on a cloud A100.
- **Crash and resume at every durable step** (`node test/crash_matrix.mjs`, no GPU needed). The real gateway runs
  against a stand-in model (`test/fake_model.mjs`), so every run is the same, and kills itself (SIGKILL) at one of five
  steps (`src/crash.js`): a round checkpointed, a member's answer saved, the talk's result saved, the question marked
  booked, the booking made. It is then started again. At all five, the question ends booked with an empty outbox, the
  game is booked exactly once, and no message is decided twice. After the crash at "a member's answer saved", the
  resumed talk sends the same message again and gets the saved answer, with no second model call. On the real model,
  `node test/a2a_resume.mjs` kills the gateway once mid-talk and checks that the talk finishes, with no message decided
  again beyond the one the crash cut off.
- **Offline unit tests** (`npm test`, no model or GPU): seven suites, 118 tests <!-- COUNT -->. `test/unit.mjs` (22) covers the
  schemas, keeping the acceptable set consistent, the members' rules, shared free time, the badminton scoring rules,
  the simulated club's determinism, the token, file fetching, the crash-safe stores, the ledger, routing, holds,
  signed cards and the guards' parsing and failure handling. `test/decider_unit.mjs` (5) covers the one-pass decider;
  `loop_unit.mjs` (23), `loop_ship_unit.mjs` (27), `loop_signals_unit.mjs` (12) and `loop_builder.mjs` (12) cover the
  community loop's review, shipping, signals and builder; `match_unit.mjs` (17) covers matchmaking. The builder's lock
  test needs `flock`, so it runs on Linux only.
- **Adversarial** (`node test/redteam.mjs`). 65 attacks <!-- COUNT -->:
  - from another agent;
  - from hostile agents answering yours;
  - against the API and shared files;
  - ten poisoned reviews in front of the court judge;
  - 29 against the community loop, the same cases `test/loop_redteam.mjs` runs, and its five controls as one case.

  65 stopped <!-- COUNT -->, on a cloud A100 ([security.md](security.md)). Most cases test a layer (a schema, the token, a file check,
  the loop's policy), so they pass by construction once the layer is there. The poisoned reviews test the model
  itself, and three of the loop's cases pass through the guard models.
- **Guard models** (`node test/guard_eval.mjs`, the server's CPU): labelled benign and unsafe messages, held-out sets
  included ([security.md](security.md#what-we-measured)).
- **Memory** (`node test/memory_eval.mjs`): retrieval alone, DRAMA against BM25, and a week that needs what the player
  said ([scale.md](scale.md#memory-what-the-player-said-found-by-meaning)).
- **The community loop** (`node test/loop_eval.mjs`): a simulated club, members and requests generated by code (seed
  7), through every stage, with a planted bad change ([community_loop.md](community_loop.md)). The builder's bench
  (`test/loop_builder_bench/run.mjs`): six specs with oracles the builder cannot read
  ([community_loop_builder.md](community_loop_builder.md)).
- **The one-pass decider** (`node test/decider_eval.mjs`): 196 cases against the full answer and the full answer again
  ([decider.md](decider.md)).
- **Orbits and the exists check** (`video/pose/orbit_fit.py`, `exists_eval.py`): hand-labelled frames
  ([orbit_highlights.md](orbit_highlights.md)).
- **Photos** (`node test/vision_check.mjs`). Seven synthetic score sheets and scoreboards (`test/sim/scoreboards.py`),
  including an impossible score and one with an instruction written on it. Its run's output is not in
  `submission/results/`; the Messenger end-to-end test reads one board and checks it against the rules
  (`submission/results/e2e.log`).
- **Matchmaking** (`node test/matchplan/likely_sim.mjs`, `test/match_eval.mjs`, `test/match_messenger.mjs`): the
  prediction offline, simulated weeks, the real negotiation code on 300 simulated requests, and Messenger end to end
  ([agent_matchmaking_plan.md](agent_matchmaking_plan.md)).
- **Scale, the members' rules, routing, private calendars and two talks at once** (`node test/scale_eval.mjs`,
  `persona_eval.mjs`, `autopilot_eval.mjs` with `A2A_ROUTE=off`, `private_eval.mjs`, `contention_eval.mjs`):
  [scale.md](scale.md).
- **The Autopilot** (`node test/autopilot_eval.mjs`). Eight weeks that differ in goal, sport, health limit and what is
  already booked, each run three times, on the final code, with the members' agents answering over A2A (JSON-RPC with the token, `EVAL_A2A=1`) and holds on. All 24 runs passed the every-week checks and each week's own oracle, so every week passed every time (pass^3 = 1.0). A run took 108 s on average, with 13.8 Muse Glimmer calls and 9.3 tool calls. The model finished 23 runs itself; in 1, rules finished the plan after the model stopped calling tools (`submission/agent_eval.md`). An earlier run passed 7 of 8; the stop check it led to refused early stops in these runs.

## Muse Glimmer in practice

Over the evaluations' 2,755 model calls (`test/glimmer_report.mjs`, over their token ledgers):
- **Reasoning.** 84% of the tokens Muse Glimmer writes are reasoning, from about a third when the
  Autopilot picks a tool to almost all of it for a short decision.
- **Empty replies.** 9% of calls came back empty, nearly all of them the quick pick reasoning past
  its budget. That is why every call has room to reason beyond its answer, and why the quick pick is off.
- **Thinking switched off.** With `think: false` (or `reasoning_effort: "none"`), it still reasoned in a hidden channel
  and returned nothing, so Serve calls Ollama's `/api/chat` with `think: "low"`.

| Call site | Calls | Prompt (cached) | Written (reasoning) | Empty | Not fitting its schema | Bad tool arguments | Seconds, p50 / p95 |
|---|---|---|---|---|---|---|---|
| a member's agent deciding a proposal (`a2a.answer`) | 1223 | 533 (37%) | 406 (92%) | 22 | 25 of 1169 | – | 24 / 49.7 |
| the Autopilot choosing its next tool (`autopilot.runWeek`) | 785 | 2631 (90%) | 132 (31%) | 0 | – | 0 | 4.5 / 13.3 |
| the quick pick (off by default) (`a2a.pick`) | 366 | 268 (64%) | 284 (100%) | 222 | 0 of 366 | – | 16.7 / 36.6 |
| judging a court (`places.judge`) | 96 | 242 (25%) | 333 (76%) | 0 | 0 of 88 | – | 19.6 / 25 |
| reading the calendar from a message (`life.read`) | 51 | 374 (0%) | 205 (77%) | 0 | 0 of 51 | – | 9.7 / 14.7 |
| writing an agent's message (before templates) (`a2a.write`) | 44 | 161 (26%) | 469 (90%) | 2 | – | – | 20.5 / 41.7 |
| wording "want a game?" (`ask.word`) | 43 | 238 (68%) | 548 (95%) | 1 | – | – | 19.6 / 24.4 |
| filing what hurts (`body.read`) | 41 | 672 (22%) | 252 (78%) | 0 | – | – | 9.1 / 17.1 |
| a place's name in English (`places.english`) | 25 | 104 (0%) | 359 (92%) | 0 | 0 of 23 | – | 13.5 / 14.3 |
| reading a scoreboard photo (`vision.score`) | 20 | 898 (10%) | 187 (71%) | 0 | 0 of 20 | – | 8.4 / 27.2 |
| the body report's summary (`body.summary`) | 14 | 275 (15%) | 788 (89%) | 1 | – | – | 27.5 / 37.8 |

The 2,755 also count 13 calls from a feature since taken out of the app. Tokens are per call. "Not fitting its schema" counts replies asked for once more because they did not fit; constrained
decoding makes it rare.

## The quick pick, measured

On 120 labeled decisions from 33 simulated members (`agent/test/sim/decisions.json`; the right answer is known from
each member's stated constraints), the quick pick was right:
- 4% of the time at a 150-token reasoning budget (95% cluster-bootstrap interval 1–8%);
- 34% at 300 (26–42%);
- 76% at 600 (67–85%).

Almost every miss was an empty reply: the model was still reasoning when the budget ran out (115, 79 and 26 of 120).
When it did answer at 600, it was right 91 times in 94. Its confidence (the option letter's probability) is not
calibrated (expected calibration error 0.53), so a threshold adds little. At 600 tokens it reasons about 400 tokens and
takes 24 s, about what the full agent costs. So it is off. The analysis, with the non-inferiority test across budgets
and the conformal thresholds, is `test/cascade_analysis.mjs`; its output is in `submission/results/`.

## Cost against accuracy, tier by tier

The tiered decision above puts each member's decision in the cheapest tier that is still right. Its numbers come from
four evaluations; this section puts them side by side, as a cost-against-accuracy plot in the manner of Kapoor et al.
(*AI Agents That Matter*, arXiv 2407.01502; the Holistic Agent Leaderboard, arXiv 2510.11977). Cost is the tokens
Glimmer writes per decision, reasoning included.

![One member's decision: what each tier costs, and how often it is right](decision_tiers.svg)

| Tier | Tokens written per decision | Seconds, p50 (RTX 3090) | How often it is right | Cases | Status | Source |
|---|---|---|---|---|---|---|
| Code and routing | 0 | none (no model call) | The member's rule kept in 60 of 60 talks, by construction (Glimmer alone: 59 of 60) | 60 rule talks | On | `submission/results/persona_eval.json` |
| One-pass decider | 1 | 0.53 | The same time as the full answer 62.2% [54.5, 69.8]; the member's stated preference 12 of 32 | 196 cases, 152 members | Off | `decider_summary.json`; seconds from `decider_dev_summary.json` (`raw:best`, the same layout) |
| Quick pick, 150-token budget | 161 | | Right 4.2% [0.9, 8.0] (115 empty) | 120 labelled decisions, 33 members | Off | `cascade_summary.json` |
| Quick pick, 300 | 285 | | Right 34.2% [26.3, 42.1] (79 empty) | the same 120 | Off | `cascade_summary.json` |
| Quick pick, 600 | 402 | 24.1 (mean) | Right 75.8% [66.7, 84.5] (26 empty) | the same 120 | Off | `cascade_summary.json` |
| Distilled student | *placeholder* | | *placeholder* | | Not merged | its results file, when it is in `submission/results/` <!-- STUDENT --> |
| Full answer | 606 (569 of them reasoning) | 40.4 | The same time as itself 73.5% [67.9, 79.3]; the member's stated preference 27 of 32 | 196 cases, 152 members | On | `decider_summary.json`; seconds from `decider_dev_summary.json` |

How to read it:
- **Two kinds of "right".** The decider and the full answer are compared with the full answer on the same 196 cases,
  and on the 32 whose member stated a preference code can grade. The quick pick was graded on a different set: 120
  decisions whose right answer code knows from the member's stated constraints. The two kinds share the y-axis, not
  the cases.
- **Routing in the Autopilot.** Over the eight weeks, two pairs of runs, routing cut the members' model answers from 43
  and 43 to 10 and 11, with 8 of 8 weeks reaching the goal in every run (`autopilot_eval_route_off.json`,
  `autopilot_eval_route2.json`, `autopilot_eval_route3_off.json`, `autopilot_eval_route3_on.json`; the ninth week,
  the memory week, left out as in [scale.md](scale.md)).
- **Hardware.** Tokens and agreement for the decider and the full answer are from A100s with the same model digest;
  their seconds are from the RTX 3090 ([decider.md](decider.md#latency-rtx-3090)).
- **Intervals** are 95%, from a bootstrap over members.

## What these numbers do not show

- **The members are simulated.** Their rules are known because code wrote them; the evaluations measure whether the
  agents keep what was stated, not how real people would answer. The community loop's club, its messages and how its
  members react are simulated too; its pipeline, gates and rollback are real.
- **The samples are small.** 60 talks per arm and 8 Autopilot weeks. Intervals are Wilson 95%, and a difference of a
  few talks is not a finding.
- **One model, one server, and dates relative to the run.** Free times are weekly, so the same week falls on
  different dates on different days.
- **The test cases were written by the developer.** The adversarial cases and the photos are ours. They test the
  layers we built, not every attack there is.

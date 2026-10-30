# The student: a decision model for the members' agents

When a member's agent answers a proposal, code first does everything the facts decide (`a2a.js`: the member's calendar
and hard rules, then routing). A proposed time that works is a yes, one listed time left is the counter, none is a no.
What reaches a model is the one real judgment: the proposed time does not work, two or more listed times do, and the
agent picks the one its member would like best, or says they can't play this week. Muse Glimmer answers it by reasoning
first: about 490 tokens read and 450 written per answer, 420 of them reasoning, 24 to 40 s on the RTX 3090.

The student answers that question without writing anything. It is Llama 3.2 Instruct (Meta), distilled from Muse
Glimmer's own answers, quantized to int4 and run on the GPU server's CPU: the 1B by default, and the 3B for closer
agreement when the CPU is free. It reads the facts once and returns a probability for each declared option, the way
TypeSafe's Jev does (a "decision" model: options declared in advance, scored in parallel, instead of text generated token
by token). In `a2a.js` `fullAnswer` it is a tier in front of Glimmer, **on by default** (`A2A_STUDENT=off` to compare):

- It answers when its pick's probability reaches `A2A_STUDENT_SURE` (0.6) and its own reading of which times work
  matches code's. Otherwise Muse Glimmer answers. Glimmer also answers when the worker is down, busy with another
  decision for more than 8 s, or slower than 20 s, so a talk never stops on it.
- Code keeps every hard rule (`breaks()`): its options are only the times that keep them. It can choose a time the
  member likes less than Glimmer would, but never one that breaks the member's calendar or rules.
- It is used only for members whose hard limits are all in code (`rulesComplete`, as for routing). A limit written only
  in a member's words is Glimmer's to keep.

In short:
- **Fewer Glimmer calls.** In talks with the simulated club it cut Muse Glimmer's member answers by 54 to 67%, with no
  rule broken.
- **Close to Glimmer's own spread.** On held-out members it agrees with Glimmer about as often as Glimmer agrees with
  itself (89.5% against 88.8%). On the hardest cases it is 5 points under Glimmer's spread at the served threshold.
- **Stated preferences kept.** It keeps the member's stated preference in 29 of 32 cases (Glimmer 27).
- **No change in the Autopilot.** The Autopilot weeks barely reach it (see the end-to-end results).

## The question, and its options

For one member in one talk, the student reads:
- the member's profile, as their agent reads it (`a2a.js` `profile`);
- the game and the proposed time;
- the times listed: the proposed one, and those that keep the member's calendar and rules (what Glimmer is shown too),
  each in the words the member's own agent uses over A2A, with the member's own trip.

The declared options are `B`, `C`, ... (ask for one of the times that work, in time order: `B` is the soonest) and `Z`
(can't play this week). One forward pass over that prompt (`jev/prompt.py`, about 240 tokens) gives, at once:
- at the last position, a probability for each option: its letter's logit, softmaxed over the valid letters only;
- for every time shown, P(works): at the `works?` marker ending its line, ` yes` against ` no`. The times that work by
  code are stated only after every marker, so this is the student's own reading of the calendar and rules, made before
  it sees code's. It is the check that it read the facts.

Over A2A its answer is an ordinary `DECISION` (tier `student`, with its confidence). Every call is in the token ledger
(site `a2a.student`). `agent/src/student.js` has the tier, `agent/test/student_unit.mjs` its tests.

## Teacher data

Every case is built by the talks' own code from the simulated club (`jev/cases.mjs`). `shared()` and `court()` list
the times the way `rounds()` does, ids and order included. Each time is written as the member's own agent writes it
over A2A. `breaks()` labels exactly which listed times work. Only these judge cases are kept.

Muse Glimmer labels the choice through the real `fullAnswer`: the same prompt, JSON Schema, `think: "low"`, 900-token
reasoning budget and temperature 0.3. It ran on `serve-jev-a100` (GCP, one A100 40 GB, spot) on Ollama 0.40.11, with
`muse-glimmer:30b-q4_K_M`, the same model blob as our server (digest `de878ce33ad8`), 96 requests at once.

| Set | Cases | Members | Glimmer answers | What it is |
|---|---|---|---|---|
| train | 3,000 | 1,526 | 2,997 | seed 11; 97% private calendars, 41% doubles, half the members' soft habits reworded |
| trainshared | 596 | 180 | 593 | seed 13, shared calendars only (Serve's default) |
| asked | 1,378 | 1,099 | 1,278 | seed 11 generator: the player asks for a time that breaks a member's hard rule (as persona_eval and the decider eval do), shared calendars |
| test | 500 | 238 | 1,500 (3 each) | seed 7, the club the end-to-end evals use |
| shared | 228 | 40 | 386 (2 each) | seed 7, shared calendars only |
| val | 300 | | 600 (2 each) | seed 19, sets the threshold |
| demo | 150 | 10 | 450 (3 each) | the demo club's own members, in their own words |
| varied | 300 | | 600 (2 each) | seed 23, every member's habits reworded |
| decider | 196 | 152 | full and full2 from `docs/decider.md` | the one-pass decider's seed-7 cases, rebuilt exactly |

Reworded habits come from a wider list (a favourite day, a part of the day, a venue, "prefers evenings", "likes short
trips"), because the simulated club has only a few habits and the demo club's members say things like these. Hard
rules stay as they were. Some answers never came: a call queued past 300 s while training shared the GPU timed out in
fetch. They were left out, not counted as answers.

## The student

Llama 3.2 3B Instruct (Meta, `meta-llama/Llama-3.2-3B-Instruct`; Built with Llama, under the Llama 3.2 Community
License). Its weights were first fetched from the ungated copy `unsloth/Llama-3.2-3B-Instruct` while the license request
was pending. Its safetensors are byte-identical to Meta's (the same SHA-256 as the official repository), and the config,
tokenizer and index files are Meta's own. The tokenizer gives the same ids on every prompt. Llama 3.2 1B Instruct was
trained the same way, as a faster student.

Training (`jev/train.py`): LoRA (rank 16, alpha 32, every attention and MLP projection), bf16 on the A100, 3 epochs over
the three training sets (4,868 cases), effective batch 16, AdamW at 2e-4 with a cosine schedule. It took 44 minutes for
the 3B and 20 for the 1B. No text is generated, in training or in use. The losses sit at positions code knows:
- choice: cross-entropy at the answer position over the valid letters only, against Glimmer's answer;
- works: two-way cross-entropy (` yes` against ` no`) at every marker, against the code-computed truth.

Half the training prompts list every offered time, and half only the ones Glimmer is shown.

Three rounds, each measured before the next:
1. **Private-calendar data only** (`3b_sft`): 89.7% agreement with Glimmer on the test set, but 58.7% on the decider's
   cases (asked times, shared calendars, mostly home-by limits), where Glimmer agrees with itself 73.5%. The training
   data had almost no such cases.
2. **With the asked-time cases** (`3b_v2`): 69.4% on the decider's cases. But the member's stated preference (the
   earliest start, weekends) was right in only 18 of 32. It read "the earliest start" as the earliest hour (Saturday
   08:00) rather than the soonest time.
3. **Letters in time order** (`3b_v3`, the one shipped): `B` is always the soonest time that works. The prompt's lines
   keep the proposer's order and ids. Stated preference: 26 of 32 (Glimmer 27).

LLM-JEPA (Huang, LeCun and Balestriero, ICLR 2026, arXiv 2509.14252) is implemented as an option (`--jepa`). It adds a
term that predicts, in embedding space, a second view of the same case (the member's calendar, hard rules, habits, the
times that work and the answer, as JSON) from the prompt, by cosine distance. It was smoke-tested but not trained at
full scale: the goal became saving tokens, not matching Glimmer more closely, so no further training round was run.

## int4, and serving on the CPU

The adapter is merged into the base and converted to GGUF with llama.cpp (`convert_hf_to_gguf.py`), then quantized to
Q4_K_M and Q4_0 (`llama-quantize`; `jev/export.sh`). The served files are `serve-jev-1b-v3-Q4_K_M.gguf` (0.8 GB) and
`serve-jev-3b-v3-Q4_K_M.gguf` (2.0 GB). The worker (`jev/worker.py`, llama-cpp-python) runs on the GPU server's CPU at 8
threads and `nice -n 19`, because the CPU is shared with the 3090's offloaded Glimmer layers and the CPU guards. It
works as follows:
- It computes the vocabulary logits only at the positions it reads (the markers and the answer).
- It keeps the cache of the prefix it shares with the previous request.
- It answers one decision at a time. A request that would wait more than 8 s for the one before it is turned away at
  once, and one whose caller has stopped waiting is not computed.

`jev/serve.sh` starts it on port 11447.

## Results

### Against Glimmer, on held-out members

bf16, the short prompt. "Each answer" is the share of Glimmer's answers to a case that the student matches (Glimmer
answered each case 2 or 3 times at its temperature, 0.3). "Glimmer itself" is how often two of its answers to the same
case agree, which is the ceiling for a model that copies it one answer at a time. "First listed" is the rule "ask for
the first listed time that works".

| Set | Cases | Glimmer itself | First listed | 3B (shipped option) | 1B (served) |
|---|---|---|---|---|---|
| test (seed 7) | 500 | 88.8% [87.1, 90.3] | 82.7% | 88.6% | 89.5% |
| shared calendars (seed 7) | 209 | 89.8% | 82.1% | 91.2% | 89.1% |
| val (seed 19) | 300 | 88.0% | 69.7% | 88.5% | 87.0% |
| demo club, own words | 150 | 93.1% | 70.2% | 86.9% | 88.2% |
| every habit reworded (seed 23) | 300 | 91.3% | 55.3% | 86.2% | 84.2% |

The one-pass decider's 196 cases (`docs/decider.md`: asked times that break a rule, shared calendars, mostly home-by
limits), graded against its two full answers, with 95% intervals from a bootstrap over members:

| | Picks the same time as `full` | Minus `full2`'s agreement with `full` (paired) | The member's stated preference | Picks the first time listed |
|---|---|---|---|---|
| `full2` (Glimmer again) | 73.5% [67.5, 79.4] | | 27 of 32 | 58.2% (`full`) |
| 3B student | 68.9% [62.4, 75.5] | −4.6 [−11.7, +2.2] | 26 of 32 | 54.1% |
| 1B student | 63.3% [56.7, 69.5] | −10.2 [−17.8, −3.1] | 32 of 32 | 48.0% |
| one-pass decider (`docs/decider.md`) | 62.2% [54.5, 69.8] | −11.2 [−19.2, −2.7] | 12 of 32 | 86.7% |

The 3B student's gap to Glimmer's own spread holds zero, so on these cases it is not shown to differ from asking
Glimmer again. The 1B is about 10 points below Glimmer's own spread, about where the one-pass decider is, but it keeps
the member's stated preference in all 32 cases where the decider kept it in 12.

**Which times work.** The student's own reading at the markers, graded against `breaks()`: precision 100% and recall
100% on the test set's 500 cases for the 3B (99.9% recall for the 1B). Over every listed time (the long prompt, which
also lists times that break a rule), precision 99.7% and recall 99.9%. Glimmer's own list of times that work, over the
times it is shown: precision 100%, recall 99.9%.

**Earlier rounds** on the same sets (3B): 89.7% on test but 58.7% on the decider's cases with private-calendar data
only; 87.9% and 69.4% with the asked-time cases, with the stated preference at 18 of 32; then 88.6% and 68.9%, with 26 of
32, once the letters were in time order.

### int4

On the VM's CPU (Xeon at 2.2 GHz, 8 threads), the GGUF as the worker runs it:

| | Picks the same as bf16 (test / decider) | Test, each answer | Decider, vs `full` | ms per decision, p50 (test) |
|---|---|---|---|---|
| 3B Q4_K_M | 495 of 500 / 189 of 196 | 89.1% | 69.4% (26 of 32) | 2,568 |
| 3B Q4_0 | 492 / 189 | 89.1% | 68.4% (27 of 32) | 2,809 |
| 1B Q4_K_M (served) | 492 / 183 | 88.5% | 60.7% (30 of 32) | 910 |

### The threshold

At each `A2A_STUDENT_SURE`, the share of the real choices the student answers (each one a Muse Glimmer call saved), and
how the cascade agrees with Glimmer. The cascade is the student where it is sure and Glimmer elsewhere. On the
decider's cases the fallback is `full2`, graded against `full`; on the test set it is Glimmer's first answer, graded
against its other two. These are the int4 files as served:

| Sure at | 1B: decider answered / agreement / preference | 1B: test answered / agreement | 3B: decider answered / agreement / preference | 3B: test answered / agreement |
|---|---|---|---|---|
| 0 | 100% / 60.7% / 30 of 32 | 100% / 89.4% | 100% / 69.4% / 26 | 100% / 90.2% |
| 0.5 | 96.9% / 61.2% / 30 | 99.0% / 89.6% | 98.0% / 70.4% / 26 | 100% / 90.2% |
| **0.6** | **73.0% / 68.4% / 29** | **96.0% / 89.9%** | 80.6% / 70.4% / 25 | 97.6% / 90.6% |
| 0.7 | 50.0% / 75.5% / 30 | 92.6% / 90.7% | 61.7% / 73.0% / 27 | 95.8% / 90.3% |
| 0.8 | 34.2% / 75.0% / 28 | 87.4% / 90.9% | 43.4% / 75.0% / 27 | 92.6% / 90.4% |
| 0.9 | 27.6% / 75.5% / 28 | 78.4% / 90.0% | 30.6% / 75.0% / 27 | 86.4% / 89.3% |
| Glimmer alone | 73.5% / 27 of 32 | 88.3% | | |

The served point is the 1B at 0.6. On the decider's cases it answers 73% of the choices with agreement 5 points under
Glimmer's own, and the stated preference at 29 of 32. On the test set it answers 96%, above Glimmer's agreement with
itself. The 3B does better at every threshold (0.5: 98% of the decider's choices, 3 points under Glimmer), but takes
about three times as long on the CPU. On a busy server that means more decisions turned away to Glimmer
(`A2A_STUDENT_SURE=0.5` with `serve.sh serve-jev-3b-v3-Q4_K_M.gguf` serves it).

### End to end

The merged code, over A2A (`EVAL_A2A=1`), with routing on. Muse Glimmer ran on a cloud A100 test endpoint (the same
model, shared with other agents). The student was the 1B worker on the GPU server's CPU, at 8 threads and nice 19,
while another job held about 34 of its 64 threads (load 90 to 105). Each arm ran once
(`submission/results/decision_model/e2e.json`).

| Eval | Student | Goal / rules | Glimmer member answers | Their tokens (read + written) | Student answered |
|---|---|---|---|---|---|
| Autopilot, 9 weeks | off | 9 of 9 weeks, 0 rules broken | 4 | 2,819 | |
| | on | 9 of 9, 0 broken | 6 | 4,778 | 0 asked |
| persona_eval, 60 talks | off | 0 broken, 31 of 31 moved | 30 | 34,490 | |
| | on | 0 broken, 29 of 29 moved | 10 | 10,996 | 19 of 29 |
| private_eval, 50 talks | off | 29 of 29 agreed, 0 broken | 13 | 11,494 | |
| | on | 29 of 29 agreed, 0 broken | 6 | 5,338 | 7 of 13 |

- **The Autopilot saves nothing.** In its weeks, routing already decides every member answer except Hana's. Her limit
  ("singles on Thursdays") is written only in her words, so the student leaves her to Glimmer. Glimmer calls per week
  are 7.7 on and off (69 in all). The difference in member answers is Hana's talks going differently between runs.
- **In talks with the simulated club, Glimmer's member answers fell by 67% (persona) and 54% (private calendars)**, and
  their tokens by 68% and 54%.
- Of 42 times the student was asked, it answered 26. 15 were turned away busy, while it was computing another member's
  decision. 1 was below the threshold.
- **Latency.** Its decision took 6.8 to 8.8 s at p50 and 19 s at p95 on the loaded CPU (wall p50 10.4 s). Glimmer's
  member answer took 40 s at p50 on the A100 endpoint (24 s with private calendars) and 24 to 40 s on the 3090. On an
  idle 8-thread Xeon the 1B takes 0.9 s, and on our server at low load about 2 s.
- The persona arms ran 30 minutes apart, so a few talks differ (31 and 29 movable). The counts are per arm.

## What these numbers do not show

- **The members are simulated.** The student matches what Muse Glimmer chose for simulated members, not what real
  people want. On the 32 cases where the member's words name a preference code can grade, it is right 26 times.
- **Glimmer is the reference, and it varies.** At temperature 0.3, two Glimmer answers to the same question agree 88.8%
  of the time on the test set and 73.5% on the decider's cases. Agreement measures whether the student chooses like
  Glimmer, not whether either is right.
- **Latency depends on a shared CPU.** The worker runs at the lowest priority on a 2017 32-core EPYC that also serves
  part of Glimmer and the guards, so its time per decision varies with their load. The A100 endpoint times are from a
  shared server too.
- **The Autopilot weeks barely reach it.** Routing decides almost every member answer in those weeks. The ones left are
  for the one demo member whose limit is written only in her words, and the student leaves those to Glimmer.

## Reproduce

On the VM (A100), from the repository root (`jev/run_teacher.sh`, `run_teacher2.sh`, `run_train3.sh` in order):

```bash
node jev/teacher.mjs jev/data/test 7 500 7 3 96 300              # Glimmer as teacher, resumable
JEV_ASKED=1 JEV_VARIETY=0.5 node jev/teacher.mjs jev/data/asked 31 1500 11 1 96 10000
TZ=Asia/Taipei node jev/decider_cases.mjs jev/data/decider decider_raw.json decider_raw_full2.json
python3 jev/train.py --train jev/data/train,jev/data/trainshared,jev/data/asked --out jev/runs/3b_v3 --order time --bs 4 --accum 4
python3 jev/train.py --eval jev/runs/3b_v3 --test jev/data/test --pred jev/preds/3b_v3_test.jsonl
bash jev/export.sh jev/runs/3b_v3 ~/models/meta-3b serve-jev-3b-v3   # GGUF f16, Q4_K_M, Q4_0
bash jev/final_report.sh 3b_v3 1b_v3 3b_v2 1b_v2 3b_sft 1b_sft      # submission/results/decision_model/
```

On the GPU server:

```bash
~/shuttlecoach-meta/jev/code/serve.sh serve-jev-3b-v3-Q4_K_M.gguf 8 time        # the worker, CPU, nice 19
bash jev/run_e2e.sh off off autopilot persona private; bash jev/run_e2e.sh on on autopilot persona private
python3 jev/e2e_report.py agent/data e2e.json off on
```

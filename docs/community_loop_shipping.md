# Community loop: shipping and rollback

This is part C of the community loop (`docs/community_loop_contract.md`): how a change the club asked for reaches
players, and how it comes back by itself when it does harm. Part A merges this section into `docs/community_loop.md`.

## Shipping and rollback

Only a **C0** change ships without the maintainer: a config value inside its declared range. Code ships it, behind a
flag, to a canary of beta members, and code rolls it back. No model decides any of it.

### Flags

The keys a C0 change may set are declared in `agent/src/loop/flags.schema.json`, which is committed and reviewed. Each
has a type, a range, today's default, the feature its thumbs count under, and the files that read it:

| Key | Range | Default | Read in | What it changes |
|---|---|---|---|---|
| `ask.hour` | 9 to 20 | 12 | `server.js` (`askTick`, wired by part A) | the hour the Match helper sends its daily "Want a game?" |
| `ask.ahead` | 2 to 7 days | 3 | `server.js` (`askTick`, wired by part A) | how many days ahead that ask looks |
| `autopilot.steps` | 8 to 16 | 12 | `autopilot.js` | the Autopilot's step budget before rules finish the plan |
| `places.radius` | 1,000 to 5,000 m | 2,500 | `autopilot.js`, `places.js` | how far the court search looks |

All four are harmless at either end of their range: fewer Autopilot steps means rules finish the plan sooner (they
keep every limit the model keeps), a wider radius means more courts to judge, and the ask's hour and reach only move
when the player is asked. Code reads a flag with `flags.get(key, player)`, one line at each site. While a flag is off,
every reader gets the default, so nothing changes until something ships.

What a flag is now (its value, status, canary and beta list) lives in `agent/data/loop/flags.json`, and every change
in `agent/data/loop/history.json`, with who made it and why. Neither is committed. `set(key, value, { by, reason })`
refuses a key that is not declared, a value of the wrong type or outside the range, and a change without who or why;
nothing it refuses reaches the history. The version of each key only rises, as in `evolve.js`, so every state can be
traced.

### The canary

`ship(spec, { now })` takes a C0 proposal whose gates passed (its status is `gated`, or the gate result says pass). It
checks again that the key is declared and the value in range, asks part B's `review.classify` that the change is C0,
and refuses a key that is already shipped. **One canary at a time**: it refuses while any other flag is in a canary,
because `ask.hour` and `ask.ahead` act on the same Match helper and the same members, and a breach during two canaries
could not be pinned on one.

The canary is the beta members (Messenger `/beta on`) whose bucket is in the first 20%. The bucket is an HMAC of the
key and the member's `who` with the loop's secret, so members cannot choose it, the same member is in or out every
time, and each key has a different canary. A member who leaves the beta, or sends `/forget`, is out of every canary at
once. The canary lasts `LOOP_CANARY_DAYS` days (7). `get()` gives the new value to the canary's members only;
everyone else keeps the default.

### The monitor

`monitor({ now })` runs from part A's cycle, every 5 minutes (`server.js`); `now` may be simulated. For each flag in a
canary, or shipped less than 7 days ago, it compares the window since the change with a window just before it, for the
same members: those in the canary, who got the value (the rest of the beta list would only dilute a real change). The
thumbs are compared with the canary's 7 days before the ship, fixed when it starts; the guard and the unmet requests
with a window of the same length as the canary so far:

| Breach | How it is seen | What happens |
|---|---|---|
| **Hard**: a game booked without the player's yes | a booking made since the flag changed whose talk came from the Match helper or the Autopilot, with no recorded yes (an ask booked after its yes, an Autopilot plan answered "all" or "first") | the flag is off at once |
| **Hard**: a double booking | `play.playing()` for every partner of every new booking: another game at an overlapping time | off at once |
| **Hard**: the privacy canary's marker leaves | a marker planted in a test player's body log; `fetch` is watched, and a request to any host but this machine, the model and the guard that carries it is stopped and kept | off at once |
| **Hard**: guard flags up | the guard's verdicts on what the models wrote to players (`guard.out`; not what players wrote, nor the loop's screen of shared ideas, where hostile items are flagged on purpose): more than 2 points above the window before (or above the rate at ship time, if the ledger in memory does not reach back) | off at once |
| **Soft**: 👎 up 10 points, beyond chance | the canary members' thumbs on the flag's feature (`signals.counts`; for the Match helper, its Yes is up and Not this week is down), 5 thumbs at least, and evidence of 20 to 1 or more that the share of thumbs down rose, from a test that stays valid however often the monitor looks (below). `LOOP_SOFT_TEST=z` brings back the old fixed-sample z ≥ 1.645, for comparison only | off, and the proposal is open again |
| **Soft**: the requests do not fall | the unmet requests in the proposal's cluster (`proposals.measure`), judged when the canary ends | off, and the proposal is open again |

A rollback puts the default back for everyone and keeps the reason in the history. The monitor returns what it did to
part A's cycle as `{ key, kind: "hard" | "soft" | "promoted", reason, proposal }`: the cycle sets the proposal to
rolled back, opens it again after a soft breach, and marks it shipped when the canary's days pass clean and the flag is
promoted to everyone. Flags never set a proposal's status themselves.

The club hears both in a note made by code, never by a model:
- "Shipped, asked for by 7 members: the hour the Match helper sends its daily "Want a game?" is now 18:00."
- "Rolled back: the hour the Match helper sends its daily "Want a game?" is back to 12:00 (thumbs down on it went
  from 10% to 40%, evidence 74 to 1 against the change)."

The history and the notes carry no proposal text, only code-made words, and the API shows a flag's beta list and
canary as counts, never the HMACs. A soft rollback's history entry also keeps what the monitor measured:
`evidence: { test, before: { up, down }, after: { up, down }, z, e, threshold }`.

### The soft-breach test: valid at every look

Until 28 October the soft breach was a one-sided two-proportion z ≥ 1.645, the right test for one look at a canary's
end. But the monitor looks every 5 minutes, and recomputed the z on the thumbs so far at each look: 2,016 chances
over a canary for noise to cross the line. So the 5% it was built for was not the 5% it had.

The test now (`agent/src/loop/anytime.js`, `LOOP_SOFT_TEST=evalue`, the default) is an e-process. With d₀ of n₀
thumbs down in the 7 days before the ship and d₁ of n₁ since:

- Each thumb is a yes/no, down with chance p₀ before and p₁ after. The null is p₁ ≤ p₀: the change made nothing worse.
- E = N / D. N is the likelihood of both windows averaged over a prior on the alternative: (p₀, p₁) uniform over the
  pairs with p₁ ≥ p₀ + 0.10, the rise of 10 points that matters, on a 1,000 × 1,000 grid. D is the largest
  likelihood any null pair gives the same thumbs (each window at its own share, or both at the pooled share).
- For the true pair, if it is null, D is at least its likelihood, so E is at most a nonnegative martingale with mean 1
  (the likelihood ratio of a mixture). By Ville's inequality, the chance that E ever reaches 1/α = 20, over the
  whole canary and at any looks, is at most α = 5%. This is the mixture-over-the-null's-maximum construction of
  universal inference (Wasserman, Ramdas and Balakrishnan, 2020), used sequentially.
- E depends only on the four counts, which the monitor already reads. With no thumbs since the ship, or none before
  it, E ≤ 1.
- A breach still needs 5 thumbs since the ship and a rise of 10 points in the share. Each extra condition can only
  stop a rollback, so the bound holds. The window before is fixed at the ship (the canary's 7 days before it), so the
  evidence grows only with the canary's own thumbs. The z is still computed, and kept in the history.

**The simulation** (`node test/loop_canary_sim.mjs`, CPU only, 17 s on the GPU server;
`submission/results/canary_sequential.json`). Each canary member is asked "Want a game?" at 12:00 every day, for the
7 days before the ship and the 7 after. The answer is Not this week (👎) with chance p, another time (no thumb) 15%,
otherwise Yes (👍). This is part A's model in `loop_eval.mjs`. 60% of answers come soon after the ask (an exponential
wait, 30 minutes on average) and 40% between 17:00 and 23:00. The canary ships at 05:00 and the monitor looks every
5 minutes for 7 days. The three rules see the same thumbs, through the code `flags.js` runs (`anytime.softRise`):

| Canary members | Rule | No change: rolled back | No change, members differ: rolled back | Bad change (25% → 60%): caught | Median days to catch |
|---|---|---|---|---|---|
| 3 | z, once at the end | 5.5% | 3.7% | 81.7% | 7 |
| 3 | z, every look (the old monitor) | **18.9%** | 14.4% | 90.8% | 2.3 |
| 3 | e-process, every look (now) | 0.5% | 0.2% | 37.8% | 3.3 |
| 5 | z, once at the end | 5.1% | 3.7% | 94.8% | 7 |
| 5 | z, every look | **21.7%** | 16.9% | 97.8% | 1.3 |
| 5 | e-process, every look | 0.6% | 0.1% | 61.4% | 2.5 |
| 10 | z, once at the end | 5.0% | 3.3% | 99.9% | 7 |
| 10 | z, every look | **26.0%** | 20.9% | 100% | 0.7 |
| 10 | e-process, every look | 0.5% | 0.1% | 92.9% | 1.6 |
| 20 | z, once at the end | 4.4% | 2.6% | 100% | 7 |
| 20 | z, every look | **29.0%** | 23.3% | 100% | 0.4 |
| 20 | e-process, every look | 0.4% | 0.1% | 99.9% | 0.7 |

20,000 canaries per cell. The 95% intervals are ±0.3 to ±0.7 points (in the JSON). "Members differ": each member has
their own rate, from Beta(1, 3) with a mean of 25%, so one member's thumbs are not independent.

What it shows:
- **The old monitor was wrong.** Checked every 5 minutes, the z-test rolled back a change that does nothing 19% to
  29% of the time, 4 to 7 times its 5%, and more on bigger canaries (more thumbs, more chances to cross). Most of
  these come in the first two days, when the windows are short. The "1 in 20" in part A's simulation (reproduced
  here: 5.1% at 5 members) was for a single look at the end, which the monitor never took.
- **The e-process holds at every look:** 0.4% to 0.6% with no change, under its 5% bound. It is conservative: the
  counts are whole numbers, and the mixture pays for not knowing p₀.
- **The price is on small canaries.** A bad change on 5 members is caught 61% of the time, against 95% for one look
  at the end (which nobody took) and 98% for the invalid every-look rule. On 10 members, 93%; on 20, 99.9%, in a
  median 0.7 days. A bad change that is missed is promoted, and the hard breaches still watch it for 7 days after.
  Below 10 canary members the soft rule now says little, and is honest about it.
- Members who differ make every rule more cautious, not less: the same members are on both sides, so their own rates
  cancel.

Not measured: thumbs that come in bursts (one member, many thumbs in a minute). The Match helper's thumb is one
answer to one ask a day, so it cannot burst; a feature with many thumbs per member per day would need them merged per
member and day first.

### The gates

`runGates(spec, { branch })` (`agent/src/loop/gates.js`; `node test/loop_gates.mjs`) runs the contract's nine gates in
order and stops at the first that fails, so the GPU gates never start for a change the cheap ones refuse.

| # | Gate | Where | Passes when |
|---|---|---|---|
| 1 | policy | CPU | a C1 to C3 change: part B's `test/policy.mjs` exits 0 on its diff (it fails closed). A C0 change has no diff, and part B's policy refuses any diff that touches a flag's value: instead part B's `review.classify` must find it C0, a declared key inside its range |
| 2 | code scan | CPU | no added line has a secret, a shell call, a network call or an eval (a finding names the file and line, never the text); a C0 change adds no lines |
| 3 | unit | CPU | `unit.mjs` (`npm test`), `loop_unit.mjs` (part B's) and `loop_ship_unit.mjs` (these) pass, with no fewer tests than the baseline |
| 4 | crash_matrix | under the lock | every crash point resumes, no fewer checks than its baseline |
| 5 | redteam | under the lock | every attack is stopped, no fewer than its baseline |
| 6 | e2e | under the lock | every check passes, no fewer than its baseline |
| 7 | autopilot_eval | under the lock, one lock per week of the eval | pass^3 = 1.0 over the nine weeks; tokens per run at most 15% and p95 seconds at most 20% above the baseline |
| 8 | oracle | CPU | the spec's own check: for a C0 change, every reader reads the key with `flags.get`, and every player gets the value |
| 9 | privacy canary | CPU | a test player with the marker in their body log is asked "Want a game?" and has an Autopilot week that searches public courts; no outside request carries the marker, and one made to carry it on purpose is stopped |

"Under the lock" is `flock /tmp/serve-gpu.lock`, at background priority (`nice -n 19`, idle I/O), cut off before 20
minutes; the Autopilot eval takes the lock once per week of the eval. That is the default, and where the reported
numbers come from: Muse Glimmer on this server's GPU. `runGates(spec, { endpoint })` (`--endpoint` on the command
line) runs the suites against another server with the same model instead, without the lock, still at `nice -n 19`.
Each endpoint has its own baselines, since tokens and latency depend on the hardware.

A C0 change is gated on its value: the gates write it into a scratch data folder that every suite reads, so the live
gateway's flags are never touched. A C1 to C3 change is gated on its branch in a worktree of its own, with this tree's
tests copied in (never the branch's). An oracle can only name a test file of this tree: no text from a spec is ever
run.

The baselines are the suites measured on the tree as it is (`node test/loop_gates.mjs --baseline`), kept in
`agent/data/loop/baselines.json` (`baselines-<port>.json` for another endpoint).

### A real run

A C0 change, `places.radius` from 2,500 to 3,000 m (`node test/loop_gates.mjs --example places.radius=3000`), on the GPU
server, 28 October 2026. Measured so far:

| Run | Gate | Result | Time |
|---|---|---|---|
| CPU gates (1-3, 8, 9) | policy, scan | pass (no diff: a flag value) | 0 s |
| | unit | 22 of 22 (before part B's tests were added) | 3.5 s |
| | oracle | both readers (`autopilot.js`, `places.js`) read the key; every player gets 3,000 | 0.1 s |
| | privacy canary | 2 outside requests in the run (Overpass, Open-Meteo), none carried the marker; the planted one was stopped | 0.5 s |
| 3090 baseline, under the lock | unit (`unit.mjs`, `loop_unit.mjs`, `loop_ship_unit.mjs`) | 70 of 70 | 3.5 s |
| | crash_matrix | 20 of 20 | 7.9 s, after 233 s waiting for the lock |
| A100 baseline (`--endpoint http://127.0.0.1:11445`, no lock) | unit | 70 of 70 | 3.5 s |
| | redteam (with part B's section 5) | 65 of 65 | 198.3 s |
| | e2e | 45 of 47: 2 checks fail on the tree as it is, before any flag changes | 972.4 s |

(Earlier, on the tree before part B's merge, the A100 redteam was 35 of 35 in 148.8 s. An A100 e2e that ran while the
endpoint was down, from about 10:15, was stopped and run again: the 45 of 47 is from after it came back.)

Because e2e fails 2 checks on the A100 with no change at all, the nine-gate run there stops at gate 6, as it should:
a change ships only when every suite passes. The two failing checks are to be found on the 3090.

Still running when this was written: the 3090 redteam baseline (65 cases) and then the gated run on the 3090 (gates 1,
2, 8 and 9 on the CPU; unit, crash_matrix and redteam under the lock); on the A100, the Autopilot baseline and then
the nine gates.

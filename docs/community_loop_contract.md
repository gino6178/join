# Community loop: the contract between its parts

The community loop turns what the club says into proposals, reviews them for safety, builds the safe ones and ships
them behind flags that roll back by themselves. It is built by several people (agents) at once, each on its own
branch; this file is what each part may rely on from the others. Change it only by agreement.

Decisions already made:
- A change of class C0 (a config value inside its declared range) ships without a maintainer, behind a flag, to a
  canary of beta members, with automatic rollback. Everything else needs the maintainer.
- Consent has two tiers: one opt-in (`/improve on`) for count-only signals; a separate yes for each shared text item.
- `evolve.js` is retired as a loop; its version history and rollback ideas are reused in `loop/flags.js`.
- The Agents Rule of Two holds at every stage: no stage holds untrusted community text, private data and the power to
  change the system at once. The coding agent never reads community text. Code, not a model, deploys.

All new code lives under `agent/src/loop/`, data under `agent/data/loop/` (each path overridable by env), tests under
`agent/test/`. The app UI stays English, with no paper names.

## Modules and who owns them

| Module | Owner | What it exports |
|---|---|---|
| `loop/signals.js` | A (signals and proposals) | `whoOf(player)` (the HMAC), `consent(player, on)`, `consented(player)`, `record(player, signal)`, `offerShare(player, item)` → pending item, `share(player, itemId, yes)`, `items()` (shared items), `counts({ since, until, whos })` → thumbs per feature (up, down), unmet counts by source, ledger sites, `forget(player)` |
| `loop/proposals.js` | A | `cluster(items)` → clusters, `vote(who, proposalId, votes)`, `credits(who)`, `rank()`, `draft(cluster)` → spec, `specs()`, `get(id)`, `setStatus(id, status, reasons)`, `measure(id, { since, until, whos, items })` → the cluster's items, members and unmet requests in a window |
| `loop/review.js` | B (safety review) | `screen(items)` → items with guard verdicts (fails closed for the required guards), `classify(change)` → `{ class, reasons }`, `check(spec, diff?)` → `{ allowed, needs: "none" \| "maintainer" \| "never", reasons, gates }` |
| `docs/never.md`, `test/policy.mjs` | B | the never-list; `node test/policy.mjs <diff file>` exits 0 (allowed) or 1 (refused, reasons on stdout as JSON) |
| `loop/flags.js` | C (shipping) | `get(key, player)`, `set(key, value, { by, reason })` (validates type and range), `beta(player, on)` (adds or removes `whoOf(player)` in every flag's beta list), `list()` (every flag, its beta list as a count only), `ship(spec, { now })` (C0 only), `rollback(key, reason)`, `monitor({ now })` → `[{ key, kind: "hard" \| "soft", reason, proposal }]`, `history(key)` |
| `loop/anytime.js` | C | the soft-breach test, pure code: `eRise(after, before)` → E, `evidence(before)` → after => E (one per canary), `softRise(after, before, { test })` → `{ breach, rise, z, e }`, `zRise` (the old z) |
| `loop/gates.js`, `test/loop_gates.mjs` | C | `runGates(spec, { branch })` → `{ pass, results: [{ gate, ok, details }] }` |
| `loop/builder.js` | D (builder) | `build(spec, opts)` → `{ ok, branch, worktree, diff, attempts, log }`, and `infra: true` when the model server or the worktree failed rather than the build, or `cannot: reason` when the model judged the spec impossible as written |
| server routes, Messenger commands | A | listed below |
| web: Club "Ideas" tab, `#/maintain` | E (web) | the pages below |
| `test/loop_eval.mjs`, `docs/community_loop.md` | A (integration) | the end-to-end run on the simulated club, and the write-up |

Until a module exists on `main`, its users import it behind a try/catch or a stub with the same exports.

## Data

Committed definitions vs runtime state: `agent/data/` is not in the repository, so what must be reviewed lives in code:
the feature catalog for deduplication in `agent/src/loop/features.json` (`LOOP_FEATURES` overrides it), and the
declared flag keys with types and ranges in `agent/src/loop/flags.schema.json`. Values, canaries and history live in
`agent/data/loop/`.

Required guards: `LOOP_GUARDS`, a maintainer setting, lists the guards an item must pass (default
`llama-guard,prompt-guard`). A required guard that is down or not installed blocks the item. A guard left out is
recorded as waived: `guard: { safe, injected: null, waived: "prompt-guard not installed" }`. `flags.get(key, player)`
matches the beta list with `signals.whoOf(player)`.

A player is never stored by id in loop data: `who` is HMAC-SHA256(player id) with a secret in
`agent/data/loop/secret` (made once, mode 600, never committed). `/forget` calls `signals.forget(player)`, which
deletes the player's signals, shared items, votes and pending items (by recomputing their `who`).

A signal (`record`):
- `{ kind: "thumb", feature, value: 1 | -1 }`: no text.
- `{ kind: "unmet", source: "guard" | "fallback" | "no-tool", text }`: `text` stays in the player's own record only
  (the store), never in loop data, until shared.
- `{ kind: "count", site, n }`.
Body and health data never become signals.

A shared item (`items()`):
```json
{ "id": "I-…", "who": "<hmac>", "text": "A court every Tuesday", "kind": "unmet" | "wish", "at": 1793…,
  "group": "weekday" | "weekend", "band": "A" | "B" | "C" | "D", "guard": { "injected": false, "safe": true } }
```
`text` is Muse Glimmer's paraphrase, accepted only if code finds it is 120 characters at most, with no names, places,
numbers, links or body or health terms. The player saw it and said yes.

A cluster: `{ id, items: [itemId], members: <distinct who>, unmet, wishes, groups: ["weekday", …], score }`. It is shown
only with 5 or more distinct members, and becomes a proposal only with support from both groups (a stand-in for
bridging). Score = distinct members × (2 per unmet, 1 per wish) + quadratic votes.

Quadratic voting: each member has 9 credits a month; `votes` votes on one proposal cost `votes²` credits.

A spec, `agent/data/loop/proposals/P-xxx.json`:
```json
{ "id": "P-001", "title": "…", "cluster": "C-…",
  "problem": { "text": "…", "members": 7, "unmet": 5, "wishes": 2, "votes": 9 },
  "change": { "class": "C0" | "C1" | "C2" | "C3", "key": "ask.hour", "value": 18, "files": ["agent/src/ask.js"], "summary": "…" },
  "oracle": { "kind": "check" | "unit" | "eval", "how": "…" },
  "privacy": "…",
  "ruleOfTwo": [{ "stage": "summarize", "untrusted": true, "private": false, "power": false }, …],
  "status": "open" | "review" | "approved" | "building" | "gated" | "shipped" | "rolledBack" | "refused",
  "reasons": [], "history": [{ "at": 1793…, "status": "…", "by": "code" | "maintainer" | "rules" }] }
```
The spec drafter (Muse Glimmer) reads cluster summaries only, never raw text.

A flag, `agent/data/loop/flags.json`:
```json
{ "ask.hour": { "type": "int", "range": [9, 20], "default": 12, "value": 12, "beta": ["<hmac>"], "canary": 0.2, /* type, range, default from flags.schema.json */
  "status": "off" | "canary" | "on" | "rolledBack", "since": 1793…, "proposal": "P-001" } }
```
`get(key, player)` returns the canary value for a beta member in the canary, the shipped value when `on`, else the
default. Only keys declared in `flags.json` exist; a C0 change may only set a declared key inside its range.

Rollback (`monitor({ now })`; `now` lets the evaluation run on simulated time; after a breach part A's cycle sets the
proposal to rolledBack, and after a soft one reopens it). The monitor reads part A's `signals.counts` and
`proposals.measure` for the canary's members (`whos` = the beta members in the canary, who got the value). The "match" thumb is the Match helper's Yes (up)
or Not this week (down).
- **Hard breach**: a booking without the player's yes, a double booking, the body-log canary marker in an outbound
  request, or guard flags up. Turns the flag off at once.
- **Soft breach**: 👎 up 10 points (5 thumbs at least) and beyond chance, or unmet requests in the cluster not
  falling. Turns the flag off and reopens the proposal. "Beyond chance" is an anytime-valid e-process,
  `loop/anytime.js`: evidence E ≥ 1/α = 20 (α = 0.05) that the share of 👎 rose, which keeps a change that does
  nothing below a 5% chance of rollback however often the monitor looks (every 5 minutes). `LOOP_SOFT_TEST=z` brings
  back the old one-sided two-proportion z ≥ 1.645 (pooled), for comparison only: it is valid for one look, and at
  every look it rolled back 19% to 29% of changes that did nothing (`test/loop_canary_sim.mjs`).
- **One canary at a time.** `ship()` refuses, with a reason, while another flag is in canary. Two canaries on the same
  members would make a breach impossible to pin on one flag.
- **Promotion.** `monitor({ now })` promotes a canary to "on" after `LOOP_CANARY_DAYS` (7) with no breach, and returns
  it as `{ key, kind: "promoted", proposal }`. Part A's cycle acts on "hard", "soft" and "promoted" and ignores any other
  kind.
- **The soft-breach baseline.** The canary members' thumbs since the ship are compared with those same members'
  thumbs in the canary's length of days (7) before it, a window fixed at the ship. The unmet requests (at the canary's
  end) and the guard's rate are compared with a window of the same length as the canary so far, as is the thumbs'
  window under `LOOP_SOFT_TEST=z`. `now` may be simulated.
- **What a soft rollback keeps.** Its history entry has `evidence: { test, before: { up, down }, after: { up, down },
  z, e, threshold }`; the reason (and the club's note) reads "thumbs down on it went from 10% to 40%, evidence 74 to 1
  against the change". The monitor's return value is unchanged.
- Every change and rollback is kept in `agent/data/loop/history.json`.

## API (server.js, owner A; maintainer routes need `MAINTAINER_TOKEN` as `Authorization: Bearer`)

| Route | Body | Returns |
|---|---|---|
| `GET /api/loop/ideas` | | clusters shown (≥ 5 members), with status and votes |
| `POST /api/loop/vote` | `{ proposal, votes }` | `{ ok, credits }` |
| `GET /api/loop/proposals` | | specs, with gate results |
| `POST /api/loop/decide` | `{ proposal, decision: "approve" \| "refuse", note }` (maintainer) | the spec |
| `GET /api/loop/flags` | | flags, with canary and history |
| `POST /api/loop/rollback` | `{ key, reason }` (maintainer) | the flag |

Messenger: `/improve on` and `/improve off`; `/beta on` and `/beta off` (`flags.beta`); `/idea <text>` (a wish); share buttons with the payload `sh:<itemId>:yes|no`; `/ideas` lists the
top ideas with a vote button `qv:<proposal>:1`.

## The builder (owner D)

`build(spec)` runs only for approved C1–C3 specs. It works in `git worktree add ../serve-wt/<id> -b loop/<id>`:
- no `data/`, `.env` or network;
- Muse Glimmer in a tool loop:
  - `list_files`, `read_file` and `search` read the repository;
  - `plan` comes before the first `write_patch`: a step for every file the spec names, and only those, checked by code
    and kept in view;
  - `write_patch` makes the change;
  - `run_unit` runs the unit tests in a sandbox with no network;
  - `done` is accepted only with every planned file changed and the unit tests passing;
  - `cannot(reason)` is for a spec that cannot be done as written, because a test says otherwise or a file it needs is
    not listed. Code takes it only after every file the spec names has been read, and it ends the build with
    `ok: false` and `cannot: reason`, with no further attempt.
- 3 attempts, step and token caps.

It reads the spec's `change` and `oracle`, the maintainer's note on approving it (`build.note`) and the repository,
never community text. Tests and the never-list files are read-only to it (`review.check` refuses a diff that touches
them).

On our own GPU (port 11435) a build holds `flock /tmp/serve-gpu.lock`; on a test endpoint it takes no lock. It never
merges or deploys: a maintainer does.

## Gates (owner C), in order

1. `test/policy.mjs` on the diff.
2. A code scan of the diff (CodeShield-style patterns: secrets, shell, network, eval).
3. `npm test` (unit).
4. `crash_matrix.mjs`.
5. `redteam.mjs`.
6. `e2e.mjs`.
7. `autopilot_eval.mjs` at pass^3 = 1.0.
8. The spec's oracle.
9. The privacy canary.

Gates 4–7 need Muse Glimmer: on our own GPU (port 11435) run them under `flock /tmp/serve-gpu.lock`, at background
priority, at night; on a test endpoint (the cloud A100s) no lock is taken. The builder follows the same rule. Each
suite may not drop below its baseline. Autopilot tokens may rise at most 15% and p95 latency at most 20%.

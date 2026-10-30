# Twenty simulated users try Serve for three days

A real trial would ask a group of friends to use Serve for three or four days. That is not possible during a
hackathon, so twenty **simulated users** tried it instead: people made up by code, each one driven by a model, who use
Serve the way a person would. They go through the real product: Messenger, through the signed webhook, and the web
API with the token. Everything they made can also be loaded as a seed, so the demo starts with a club that already
has people in it (the cold start).

**Simulated users are not real users.** Nothing here shows how real people behave. It shows what Serve's real code does
for twenty plausible, varied and lazy people whose behaviour we wrote down, and it compares that with the same people
organizing games without Serve. Every number below comes from these runs, and every file they made is marked simulated.

## Results: one finished run (seed 2), so no spread over seeds

What was run, and what was not:
- **Finished:** `d2`, 20 users, 3 days (Thu 5 to Sat 7 Nov, simulated), seed 2, Muse Glimmer on the A100 test
  endpoints, 41 minutes, 58 model calls from the gateway, no model errors. Its file is
  `submission/results/sim_users_d2.json`.
- **Not finished:** the seed 1 run (`d1`) was stopped part-way when the work was wrapped up, so there is no second seed
  and no run-to-run spread.
- **Not counted:** earlier runs ran without DRAMA's model cache, so the loop could not cluster anything. They are left
  out (kept on the server under `simusers/runs/nodrama_*` and `aborted_*`).
- **Not run:** the informed arm (`--informed`), the Serve runs with laziness shifted (`--lazy-shift`), the blinded
  judge (`judge.mjs`, built but not run) and a second persona model.

| | With Serve | Without Serve (baseline) |
|---|---|---|
| Games played (everyone turned up) | 0 | 1 |
| Player-games per user | 0 (95% CI 0 to 0) | 0.10 (0 to 0.25) |
| Users with a game | 0 of 20 (Wilson 0 to 0.16) | 2 of 20 (0.03 to 0.30) |
| Games booked | 1 | 1 |
| Messages or taps, all users | 74 (10 about getting a game) | 12 |
| Want to booked | 0 minutes (n = 1) | 60 minutes (n = 1) |

The per-user difference is -0.10 (95% CI -0.25 to 0). On these numbers, **Serve did not beat the baseline**. With one
seed and one game in each world, the run cannot show a difference either way. What it does show is where Serve lost
its games.

### Where the games were lost (seed 2)

- **Most requests never reached matchmaking.** 9 requests were sent:
  - 1 was read as a request for a game;
  - 2 were filed as calendar entries ("need badminton doubles tonight 19 to 22" became a training session in the calendar);
  - the rest were answered in words.

  Free text reaches matchmaking only if it matches a narrow set of phrasings (`match/flow.js isPlayRequest`). Natural
  Chinese ("想找…雙打", "有場嗎") and English ("need a singles game Friday") miss it. The agent's answer sometimes offers
  "Want me to start a /game search?", and a "yes" to that goes nowhere.
- **The Match helper never asked anyone.** Its noon ask needs a habit: two games at the same weekday and time in eight
  weeks. New users have none, so it made 0 asks. `/game` answered "No game to suggest right now".
- **The one booked game fell through.** Serve's agent for the partner (u18) agreed the time from u18's free windows,
  without asking u18. Told afterwards, u18 would not have said yes, and did not go. There is no way to back out
  through the agent, so the organizer was stood up. In an earlier run, Serve then booked the same partner again.
- **Activation:**
  - 16 of the 20 users opened the chat on day 1, 18 by day 2, 19 by day 3, and 1 never did;
  - 16, 9 and 12 were active on days 1 to 3.

  Of the 20, 14 opened the chat but never asked for a game, 3 asked without getting one they took up, 1 never opened
  it, and 2 had their one game fall through.
- **Bands:** 2 estimates ("maybe"), and 3 refusals from members who had not said `/bands on`. There are too few to say
  anything about calibration.
- **Community loop:**
  - 7 users turned on `/improve on` and 3 `/beta on`;
  - 5 ideas were sent, and 4 were shared: "A way to cancel a confirmed match", "Arrange doubles games with players of
    similar skill level", "Reduce how often the agent sends messages" and "Add a reminder the day before a game";
  - no proposal formed: the largest idea had 1 member, and 5 are needed;
  - no C0 change shipped.

  Across runs, "cancel a game my agent agreed" came up again and again. That is the gap above, found by the users
  themselves, but its phrasings did not cluster together.
- **Club feed:** on (the run found `/api/feed`), but nobody posted, liked or commented. The users post only after a game
  they played, and there was none.
- **Guard refusals:** none in this run. In an earlier run, Llama Guard refused a benign check-in reply
  ("沒打成，對手沒來😅 沒練到，沒酸痛"), a false positive.

### The fixes, after the run (not measured again)

The three problems above were fixed after the seed 2 run, and the run was **not repeated**. The numbers above are from
before the fixes:
- **Requests reach matchmaking.** `match/flow.js isPlayRequest` now reads the trial's phrasings ("need badminton doubles
  tonight", "Find badminton doubles for Sunday", "想找…單打", "有場嗎", "can you find a partner") before anything
  files them as a calendar entry. A calendar note ("I have training Wednesday 19:00") still files as one. The unit test
  checks both.
- **New players get asked.** With no habit yet, the Match helper's noon ask (`ask.js opening`) uses the free times the
  player gave, in their sport and format, and the members' bands still order who is asked. The Autopilot already fell
  back to free times.
- **The partner is asked, and may back out.** With `CLUB_PLAYERS=1`, a partner who keeps `/confirm` on (the default) is
  not booked by their agent's yes in the talk:
  - their agent holds the time and asks them: "I'm in" or "Can't make it";
  - once everyone is in, the game is booked;
  - backing out lets the hold go, tells the asker, and the asker's agent looks for someone else, leaving them out.

  The simulated members keep their own rules.

One check, not a measurement: a rerun with the fixes was started and then stopped part-way, on the user's call. Up to
then (Thursday to early Saturday, simulated):
- 3 of 7 requests were read as requests for a game, against 1 of 9 before, and 1 was filed as a calendar entry;
- the noon ask asked 15 times, against 0 before;
- partners were asked 9 times;
- 3 games were booked and 2 played.

For example, u14's "need badminton doubles tonight level c" reached three members' agents. They agreed Thursday
20:00, and Serve asked the one partner who keeps `/confirm` on before booking. These partial numbers are not comparable
to the table above, and they have no results file.

`npm test` on the merged tree: 239 of 240 pass and 1 is skipped (it needs LlamaFirewall's own Python environment),
none fail (`submission/results/unit.log`).

### Without Serve

5 attempts to organize, 1 game booked, and it was played:
- 1 failed because too few people said they were in before the organizer gave up;
- 1 because counter-offers didn't agree on a time;
- 1 because nobody answered in time;
- 1 because the organizer saw the replies too late.

## How it works

| Part | File | What it does |
|---|---|---|
| The people | `agent/test/sim_users/personas.mjs`, `personas.json` | Twenty personas, made once from seed 20261105 and checked for variety |
| Their inertia | `agent/test/sim_users/inertia.mjs` | Whether a person does something: open the chat, ask, answer, turn up |
| Their words | `agent/test/sim_users/persona_llm.mjs` | What a person says, written by Muse Glimmer in their own voice |
| The run | `agent/test/sim_users/run.mjs` | A gateway of the run's own, a fake Graph API, the clock, the days |
| The clock | `agent/test/sim_users/clock.mjs` | The gateway's `Date`, moved forward between events |
| Without Serve | `agent/test/sim_users/baseline.mjs`, `courts.mjs` | The same people and days, organizing by hand |
| The measures | `agent/test/sim_users/metrics.mjs`, `report.mjs` | Games, effort, waits, activation, turnout, bands, loop, feed, guard |
| The seed | `agent/test/sim_users/export_seed.mjs`, `load_seed.mjs`, `seed/` | What they made, for the demo |
| Tests | `agent/test/sim_users_unit.mjs` | The pure parts (in `npm test`) |

### What runs for real

Each run starts its own gateway (`src/server.js`) in a folder of its own, on ports of its own, with its own data. It
never touches the live gateway or its `agent/data`. Everything in it runs as it would for real people:
- each user's agent;
- the members' agents over A2A, with the token and signed Agent Cards;
- the matchmaking bands and the holds;
- the Autopilot and the Match helper's noon ask;
- the reminders and the evening check-in;
- Llama Guard on what people write and on what models write;
- the community loop, with its nightly run at 05:00 (`LOOP_NIGHTLY=1`), its gates and its canary;
- the Club feed, when the branch has it (`agent/src/feed`; the run checks `/api/feed` at the start and skips the feed
  otherwise).

Muse Glimmer for the gateway's agents runs on an A100 test endpoint (`127.0.0.1:11446`). The persona model runs on a
second one (`127.0.0.1:11448`). The live model server is never used.

The users reach the gateway only as people would:
- **Messenger.** Every message and every button tap is a webhook call signed with the app secret. The gateway's
  replies go to a fake Graph API, as in `agent/test/e2e.mjs`.
- **The web API**, with the gateway's token, for the Club feed: posts, likes and comments.

What the run reads directly is for measuring only: the gateway's bookings file, its loop folder and its matchmaking
records, all in the run's own data folder.

### One change to Serve the simulation needed: `CLUB_PLAYERS=1`

Until now every Messenger player on a gateway was the demo's "you", with the demo's free times, home and eight weeks of
games. Twenty people on one gateway would all have been the same person. With `CLUB_PLAYERS=1` (off by default, so
nothing changes for the live gateway or the tests), a Messenger player who is a member of the club is themselves:
- **Their own profile.** While the gateway works for a player (their message, their noon ask, their Autopilot), their
  agent plans from their own member profile: free times, home, level, sports and weekly goal. Their games come from
  their own record (`club.js asPlayer`, an AsyncLocalStorage around each Messenger event and each tick).
- **Their own games block them.** A game their own agent booked counts as them playing then, so another player's agent
  can't book them into a second game at the same time (`play.js playing`, `option.by`).
- **The other players hear about it.** A partner who is one of the gateway's players is told when their agent said yes
  for them, and the game goes in their calendar, with the reminder before it and the check-in after it.
- **Bands need consent.** A member who is one of the gateway's players gives a band only after their own `/bands on`,
  as a real player's agent does (`match/players.js`).

`SIM_USERS=<folder>` adds a seed's members to the club, each marked simulated. That is the demo's switch for the seed.

### The clock

Three days pass in about an hour. The gateway runs with `node --import test/sim_users/clock.mjs`, which replaces `Date`
with one that runs at the real rate from a simulated start. The runner moves it forward over IPC, and only when
nothing is in flight:
- no model or guard call (the runner proxies both, so it counts them);
- no webhook call;
- no message to anyone for 8 seconds;
- nobody acting.

Timers stay real, so the gateway's minute ticks fire as they always do, against the simulated hour. The runner holds
the clock in the hours those ticks act on:
- 05:00, the loop's night run (only once something has been shared with the club);
- 07:00, the morning reminder, and 21:00, the check-in (only on a day with a game);
- 12:00, the Match helper's ask;
- an hour before each game, its reminder.

Nothing in the gateway is changed for the clock.

## The people

Twenty personas, made by `personas.mjs` from a fixed seed (20261105). The names are invented. They are new to Serve:
no games on record, no history, no demo data. They are a friend group from one badminton club, the people a real trial
would have asked, and they can join only each other (the demo club's members are left out, so no game is ever with an
agent that always says yes).

| What | How it varies |
|---|---|
| Week | Nine kinds, for example office hours (5), students (3), shift nurses (2), parents of small children (2), retail (2), freelancers (2), engineers with long days (2), a retiree, a PE teacher. Each kind has its own free windows, two to four a week, at most one a day |
| Sports | Badminton for all; some also tennis or table tennis |
| Level | A to D, five each, with a rating that goes with it |
| Format | Singles (7), doubles (6), either (7) |
| Home | Near one of the five sample venues |
| When they look at their phone | Three or four moments a day, by the kind of week (a commute, lunch, late evening) |
| Language | English (9), Traditional Chinese (6), a mix (5), each with a way of texting |
| Weekly goal | 1 to 3 games |
| Social | How often they post, like and comment in the feed (0.13 to 0.84) |
| Civic | How likely they are to turn on `/improve on`, `/bands on` and `/beta on`, share an idea and vote (0.05 to 0.83) |
| Asides | Five sometimes trash-talk before a game; two have a niggle (a knee, a shoulder) |

### The inertia model

Whether someone does something is decided by code (`inertia.mjs`), from their persona's numbers and seeded dice. The
persona model only writes what they say. All of a person's numbers follow one **laziness** (0.15 to 0.88; six people
below 0.33, six above 0.65), each with some noise of its own:

| Number | Means | Range |
|---|---|---|
| `pOpen` | the chance they open Serve's chat at all on a day | 0.43 to 0.88 |
| sessions | how many of their usual phone moments they use that day | fewer when lazy |
| `pInitiate` | the chance they bother to ask for a game, once in a day they open the chat and still want one: 0.75 - 0.65 x laziness | 0.18 to 0.65 |
| `replyMin` | their median minutes to answer once a message is in (a lognormal) | 13 to 379 |
| `pNotThisWeek` | the chance they turn down a game that fits anyway | 0.12 to 0.47 |
| `flaky` | the chance they don't turn up to a booked game | 0.03 to 0.17 |
| `pBusy` | the chance one of their free windows is taken that day (work ran late, a sick child) | 0.12 to 0.34 |
| `patienceH` | hours they wait on replies before giving up on organizing a game | 2 to 12 |

What they want: games for the trial from their weekly goal (one game for a goal of 1, two for 2 or 3), at a time in
their free windows at least three hours ahead.

A game put to them (an agent's ask, a plan, a group chat message) gets "yes" only when they are free then, not held up
that day, still want a game, and the "not this week" dice say yes. Someone they were stood up by before gets half the
yeses.

A game their **agent** agreed for them, without asking them, is treated the same way: when they read the notice, they
keep the game only if they would have said yes to it. Otherwise they don't go, and may tell their agent. This is the
strictest choice for Serve, and it is deliberate.

Whether they turn up: they must know about the game (their own booking, a notice they read, or a push they saw), not be
held up that day, and not be flaky.

## Without Serve: the baseline

The same twenty people, over the same days, with the same dice (common random numbers). A person who is held up on
Thursday evening is held up in both worlds. Nobody's agent does the hassle: a person who wants a game must find the
people and the court themselves (`baseline.mjs`). The steps, and the assumptions, each chosen to lean towards the
baseline:

1. **Starting.** They bother to organize with the same chance as asking Serve (`pInitiate`). Organizing by hand is
   harder to start than typing one line, but the baseline is not charged for that.
2. **People.** One message to the club's group chat reaches all nineteen others: everyone knows everyone in this group,
   more reach than most people have.
   - Each sees it the same day if they look at their phone that day (the same chance as opening Serve), and 30% of the
     time even if they don't.
   - They answer after their usual delay.
   - They say they're in by the same rule as a yes to Serve. A lazy person who would play answers a group poll a little
     less often (1 - 0.4 x laziness): someone else will.
   - Someone who can't make that time but would play offers another time the two of them are free. The organizer takes
     the time most of them offered, if enough did.
3. **Waiting.** The organizer takes the first who are in (one for singles, three for doubles). They wait until their
   patience runs out, or until two hours before the game.
4. **A court.** The organizer tries the venues nearest them first. They find exactly the free courts Serve's agents
   would (`courts.mjs` is play.js's timetable; the unit test checks they agree), less the ones taken in that world.
   - Each try costs two taps and five minutes.
   - After each failed try they give up with a chance of 0.25 + 0.4 x laziness.
   - Booking costs two taps, telling the group one.
5. **The game.** Everyone turns up by the same rule as with Serve, and they all knew about it, since they said they
   were in.

What the baseline leaves out, also in its favour:
- the cost of starting;
- people who are not in the group chat;
- the back and forth of a real group chat beyond one counter-offer;
- forgetting.

What it leaves out against it: nothing that we know of.

## Measures

- **Games played:** games in which everyone turned up, and games per user (each player in a game counts it).
- **Messages or taps per game:** everything the users sent, per game played. For Serve, also only what was about
  getting a game (a request, an answer to an ask or a plan, a message backing out).
- **Want to booked:** from the person's request (Serve) or their group-chat message (baseline) to the booking.
- **Activation and retention:** who sent their first message on each day, and who was active each day.
- **Asks declined and no-shows,** with why.
- **Bands:** each estimate the members' agents gave, against what that member's agent then said in a talk, and whether
  a game came of it.
- **The community loop:** `/improve on`, `/idea`, the offers to share, what was shared, votes, the clusters, any
  proposal, and whether a C0 change shipped to the beta canary, or why not.
- **The Club feed:** posts, likes, comments, and what the checks held or refused.
- **Guard refusals:** every refusal is a false positive here, since every message the users wrote was benign.
- **Intervals:** a 95% bootstrap over the twenty users, paired (each resample takes the same users in both worlds),
  and Wilson intervals for proportions. Over seeds, the spread of each number.

## Validity

LLM-simulated users are known to be unreliable stand-ins for people: changing the model that plays the user moved
agents' success by up to 9 points (Seshadri et al., *Lost in Simulation*, arXiv 2601.17087), and users who don't
cooperate make agents fail in ways cooperative ones never show (Shim et al., ICLR 2026, arXiv 2509.23124). Four
checks, in `agent/test/sim_users/validity.mjs` and `judge.mjs`, with their output in
`submission/results/sim_users_validity.json` and `sim_users_judge.json`:

On the seed 2 run, in `submission/results/sim_users_validity_d2.json`. The judge's results file (`sim_users_judge.json`)
does not exist, since the judge was not run.

- **Plausibility, against published figures** (`validity.mjs SOURCES` lists the sources):
  - *No-shows.* The model's chance that a person misses a booked game is 0.28 for the median persona (0.15 to 0.45).
    That is the median no-show rate for free events, about 28% (PheedLoop Event Data Lab #05; vendor data).
  - *Replies.* 86% of the users' answers to their agent came within five minutes, n = 7. Most were answers in a chat
    they were already in. WhatsApp's figure is about 70% (arXiv 2605.03687). The model's own medians, 13 to 172
    minutes, are slower than that for answers to a push.
  - *"Not this week."* Only 1 tap, so the rate can't be checked. The model's 0.12 to 0.47 is an assumption, with no
    published figure found.
  - *Play frequency.* The baseline gives 0.23 games per user per week. Recreational badminton players play about twice
    a week (Taipei venues, 2005; Malacca, 2009), and Taiwan's survey reports 3.64 exercise sessions a week (運動現況調查
    2023, as reported in the press). The model is far below real play: it counts only new games organized on the spot,
    not standing weekly games, and the personas want fewer (median goal 1 a week). The absolute numbers are a lower
    bound on play, not a forecast.
- **Variety.**
  - The personas: nine kinds of week, three languages, four levels, three formats, laziness from 0.15 to 0.88.
  - What they wrote: 36 messages from 8 users, 30 of them distinct. About half are mostly Chinese. The median length is
    17 characters (2 to 46 from the 10th to the 90th percentile).
  - Character-trigram similarity between two people's messages averages 0.03 (at most 0.17): not 20 copies of one
    voice. That is a code check on wording, not on behaviour.
- **Sensitivity of the baseline,** over 20 seeds, as player-games per user over the trial. As run, the mean is 0.16
  (5th to 95th percentile 0.1 to 0.4).

  | Assumption changed | Mean player-games per user |
  |---|---|
  | Everyone 0.2 less lazy | 0.22 |
  | Everyone 0.2 lazier | 0.09 |
  | Life gets in the way half as often | 0.20 |
  | Answers four times slower | 0.13 |
  | No bystander effect | 0.18 |
  | Group chat reaches everyone | 0.17 |
  | Everyone wants two games or more | 0.16 |

  No single assumption moves the baseline outside 0.09 to 0.22. Serve's one booked game was scored again under each
  change, and under "partners always keep a game their agent agreed". It was played in none, so the result is not an
  artefact of the turnout dice. Serve runs with shifted laziness were not run, so how much the Serve arm itself moves
  is not measured.
- **Blinded judge:** built (`judge.mjs`, with a held-out set in `judge_heldout.json`) and **not run**. Its limits if it is
  run:
  - the held-out set was written by an AI assistant, not by real users;
  - the judge is the persona model itself;
  - the sets are small.
- **A second persona model:** not run. The A100 test endpoints serve only Muse Glimmer.

## Reproduce

On the GPU server, from a tree with `agent/node_modules` and `asr/` beside `agent/` (the run copies `agent/src`,
`agent/test` and `web/src` into a folder of its own):

```
cd agent
node test/sim_users/personas.mjs --check          # the variety check (without --check it writes personas.json again)
node --test test/sim_users_unit.mjs               # the pure parts
TZ=Asia/Taipei LLM_TARGET=http://127.0.0.1:11446 PERSONA_LLM_URL=http://127.0.0.1:11448 \
  node test/sim_users/run.mjs --seed 1 --run s1 --users 20 --days 3 --start 2026-11-05
#   (--informed: the second arm, users told how to ask; --eager: a quick flow check, never for results)
node test/sim_users/remeasure.mjs <runs>/s1        # the measures again from what the run saved
node test/sim_users/report.mjs <runs>/s1/sim_users_s1.json <runs>/s2/sim_users_s2.json
node test/sim_users/export_seed.mjs <runs>/s1      # writes test/sim_users/seed/
```

Options:
- `SIM_DIR`: where the runs go (by default `~/shuttlecoach-meta/simusers`);
- `--port` and `--graph`: the gateway's and the fake Graph API's ports (24789 and 24796; the proxies take the next
  three);
- `SIM_CONCURRENCY`: users acting at once (5);
- `SIM_LLM_SLOTS`: the gateway's model slots (8);
- `PERSONA_LLM_SLOTS`: the persona model's (3).

A run never overwrites another: pick a new `--run`. Logs go to `/tmp/serve_simusers_<run>_gateway.log`.

## The seed

`agent/test/sim_users/seed/` holds what the simulated users made in the seed 2 run (`d2`). That run had little in it:
1 booked game, 4 shared ideas, no feed posts. `validity.mjs`, `remeasure.mjs` and `judge.mjs` are beside the runner.
The seed holds:

| File | What it holds |
|---|---|
| `members.json` | The twenty as club members |
| `records.json` | Their own matchmaking records, so their agents' bands start from something |
| `games.json` | Their games, and the bookings |
| `feed.json` | Their posts, likes and comments |
| `loop.json` | The ideas they shared and their votes, by player id (never an HMAC) |
| `manifest.json` | The run, the seed, the counts, how to load it |

Everything in it is marked `simulated: true`. Loading it is a separate, explicit step, into a data folder you name:

```
node test/sim_users/load_seed.mjs --into <the demo gateway's data folder>          # shows what it would write
node test/sim_users/load_seed.mjs --into <the demo gateway's data folder> --yes    # writes, keeping a copy of each file
SIM_USERS=test/sim_users/seed LOOP_SIMULATED=1 SIM_SEED=<seed> node src/server.js  # the demo switch
node test/sim_users/load_seed.mjs --into <folder> --remove --yes                   # takes it out again
```

The loader moves the dates so that the trial's last day is yesterday. It makes the shared items' HMACs with that
folder's own loop secret. It never touches `players.json`, so nobody is linked on Messenger. The Club feed marks
simulated posts as such, the Ideas tab says "Simulated club" with `LOOP_SIMULATED=1`, and each member's Agent Card says
it is a simulated member's agent.

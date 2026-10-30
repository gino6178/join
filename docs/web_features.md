# What the app now shows

Six things the gateway already did, which the web app did not show, and the app's voice input moved onto the server
(section 7). Each is in the app now, with its own route where it needed one, and checked at phone (375), tablet (768)
and desktop (1440) widths in the light and the dark theme. The screenshots are in `submission/shots/web_features/`
(`video/web_features_shots.mjs` takes them from a running site).

## 1. Private calendars, per player

**Before.** `A2A_PRIVATE=1` switched every talk on the server to private calendars, or none.

**Now.** It is the server's default, and each player's own choice wins.
- **You → Settings → Private calendars** is a switch with one sentence: "Members' agents check their own calendars, so
  the talk takes a little longer." Under it, whether this is your choice or the server's default, and a link back to
  the default.
- Every talk says which mode it ran in, next to the agents' messages: the Autopilot's threads, a talk on Club →
  Challenges, the Match helper's "want a game?" card on the agent home. Private shows a lock ("Private calendars:
  each agent checked its own"), shared a calendar ("Shared calendars"). In private mode the trail has a step of its
  own: "Kept everyone's calendar private".

How: `agent/src/privacy.js` resolves the mode for a player (the app's own player in `data/prefs.json`, `PREFS_FILE`; a
Messenger player in their store prefs, so `/forget` deletes it). `a2a.js` `rounds()` takes `who` and asks
`privacy.privateFor(who)`; the talk saves its mode (`calendars`), so a talk resumed after a restart keeps it. The
callers pass the player: `ask.js` (`a.who`), `autopilot.js` (the player or the Messenger chat), `match.js` ("app").

| Route | |
|---|---|
| `GET /api/prefs` | `{ privateCalendars, choice, serverDefault }` |
| `POST /api/prefs` | `{ privateCalendars: true \| false \| null }` (null goes back to the server's default) |

## 2. The safety checks

**Before.** Llama Guard 3 and Prompt Guard 2 (`guard.js`) worked in Messenger, and nothing in the app showed them.

**Now.** Every check is noted, for its own player, with its verdict and what happened, and never its text: not what
the player wrote, not what a model wrote, not a review.
- **Messages**: each chat has "Safety checks": "Checked your message: safe · Your agent acted on it", "Your agent did
  not act on a message · It was flagged as violent crimes…", "Your message got the helpline reply, not an answer",
  "Checked an answer before it was sent: safe". A flagged message is not in the chat's history either (it never was).
- **The agent home**: a question to the agent (`POST /api/agent/answer`) goes past the same guards as a Messenger
  message, both ways (`webapi.answer`), and its card's steps say so ("Checked your message: safe", "Checked an answer
  before it was sent").
  A message the guard stops keeps no words on its card either: "A message your agent did not act on", with the reply
  and the check. A side card lists the app's latest checks.
- **The Autopilot's trace** (TraceView): a check inside an agent's run is a span, "Safety check · an answer · safe".
  The Autopilot's last sentence for the player now goes past Llama Guard too, so every run's trace has one; court
  reviews (Prompt Guard 2) appear when the run looks for public courts.

How: `agent/src/safety.js` keeps the latest 600 checks in memory (nothing about a check is written to disk but the
span, which has no player and no text). `guard.js` notes each check from `screen`, `checkOut` and `injected`, and adds
a `guard <kind>` span when it runs inside a trace. `messenger.js` runs each webhook event as that chat's
(`safety.as(id)`), and every `/api/` request is the app's own player's. A chat linked again after `/forget` starts
with no checks.

| Route | |
|---|---|
| `GET /api/safety?player=&n=` | the checks for "app" (default) or a linked chat: `{ at, on, model, verdict, categories, about, action, count, flagged, why, seconds }` |

`on` is message, answer, reviews or idea; `verdict` safe, flagged or not checked; `action` passed, refused, helpline,
replaced, left out or held.

## 3. What the player told their agent

**Before.** `memory.js` kept short notes from Messenger, found by meaning, and the Autopilot used them; the app could
not see them.

**Now.**
- **Your memory** has a new first section, "On your server: what your agent remembers", above the notes on this device.
  It lists the notes newest first with the day each was said, a delete button on each, and "Forget all". A switch
  picks "This app" or a linked Messenger chat. "Tell your agent" adds a note for the app's own player; it goes past
  Llama Guard first, like a Messenger message, and what it stops is not kept.
- **Autopilot**: `recall` has its label in the trail, and a run that left someone out because of a note says so:
  "Left out because of what you told your agent: Tomás · you said “Leave Tomás out of my games for a while” (28 Oct)".

How: `memory.list` and `memory.drop` (no vectors ever leave the server). Forgetting all calls `memory.forget`, the same
as `/forget` does for the notes (in-flight notes are dropped too); `/forget` itself is unchanged. `autopilot_why.js`
matches each member the plan left out (`find_partners` `leaveOut`) to the note that names them, from `get_week`'s
`fromMemory` and what `recall` found.

| Route | |
|---|---|
| `GET /api/memory/notes?player=` | `{ player, notes: [{ id, text, kind, at }], on, finds: "meaning" \| "words" \| "off" }` |
| `POST /api/memory/notes` | `{ text }`: the app's player tells their agent (past Llama Guard) |
| `POST /api/memory/delete` | `{ player, id }` |
| `POST /api/memory/forget` | `{ player }` |

`player` is "app" or a chat linked on Messenger; any other id is not found.

## 4. Holds and signed Agent Cards

**Now.** On a card that waits for the player's yes (the Autopilot's approval, a talk on Club → Challenges, a game the
agents moved), a quiet line under the game: the calendars mode, "Held for you 27:41" counting down (amber in the last
five minutes, "The hold lapsed" after), and "Sam's agent card checked" (or "3 agent cards checked"; a card that did
not check out is named in red). The countdown asks the gateway once whether the hold is still there.

How: when a talk ends, `talk_meta.js` adds to its result `calendars`, `cards` (from `a2a_client.js`, which now records
each agent's card check: verified, when, the signature's algorithm, or why not) and, on the agreed game, `holdUntil`
(the earliest of the members' holds, `play.js` leases).

| Route | |
|---|---|
| `GET /api/holds?ref=&members=` | what each member's agent holds for that talk now: `{ member, until, date, from, to }` |

## 5. Highlights: zoom, cut and orbit

**Now.** **Film a highlight** (`#/highlights`, in More, and where the agent sends "make my highlight reel") takes your
own video or one of the sample clips (`web/public/media/samples/`, trimmed from CC BY 3.0 videos, their credit on the
page, on the reel's frames and in the caption). "Add a camera effect" is an option there (on by default, shown only
when the server has it; `web/src/components/Effect.jsx`). After the reel, the server decides the effect for your moment and
renders it: a zoom and cut by default, a short orbit (time stops and the camera turns round you) only when the
footage allows it, and none when you are not in the picture at the moment. The card says which and why, in plain
words ("A short orbit: time stops and the camera turns 14° round you · you stay in the picture, and the footage has
room to turn the camera"; "Zoom and cut · you are at the edge of the picture, so there is no room to turn the camera";
"No camera effect · your racket hand or body is hidden at the moment"), and how often you were found in the picture
around the moment. The reel plays the server's clip as its replay, in the 9:16 and the 16:9 picture; with no effect
it skips the replay, so nothing aims at you where you aren't. When the reel finds no smash, the moment is the one the
effect was built on (your fastest swing). The video is recorded in the browser and shared only when you pick an app.

How: `reel.js` runs `video/pose/orbit.py` after `reel.py`, on the uploaded clip and the reel's own reading, with the
exists check (`exists.py`: SAM 2.1 tracking you, its presence head and mask area, Sapiens2's racket hand, with
hysteresis) and the decision as the prototype measured them (`docs/orbit_highlights.md`). It runs on `REEL_GPU` (GPU 0),
under `nice -n 19` with 8 CPU threads at most, and its clip comes back with the reel as a data URL; the working files are
deleted with the upload. Set `REEL_EFFECTS_SCRIPT` (orbit.py) and `REEL_EFFECTS_PYTHON` (the reel's own environment
with MapAnything added; on our server `~/shuttlecoach-meta/orbit/venv`, a venv over the reel's `isaac` environment), and
optionally `ORBIT_MAPANYTHING` (a local copy of the weights); `server/start.sh` sets all three to the prototype's folder
on the server (`orbit/`). `/api/status` says `reelEffects`. A failure is not the
reel's: the reel comes back with "No camera effect this time" and the reason.

The full pipeline is wired: zoom and cut, the orbit and the hold. On the singles sample ("Singles, a winning rally",
24 s, 720p) the server finds the smash at 5.9 s, checks the player is in 31 of 31 looks with the racket hand in 31,
and chooses a 20° orbit (41 s on GPU 0); on a 13 s cut of the singles final filmed from behind the baseline it holds
("your racket hand or body is hidden"), so the reel plays without a replay.

## 6. The builder's work, on the maintainer page

**Now.** For an approved C1–C3 proposal, `#/maintain` has a **Build** section above the gates and the decision:
"Build it" (on its own branch, `loop/P-…`), then, while it runs, the attempt it is on; once done, the branch and its
commits, what changed, the base's unit tests, tokens and time, every attempt (how it ended, steps and tool calls, the
files it changed, its unit tests, any write refused and why, the spec's own check), the diff, and which gates ran on
the branch and which are still the maintainer's to run on the GPU. A build that stopped says why ("the model server
did not answer…"), and can be built again. The page reads the builds again every five seconds while one runs.

How: `agent/src/loop/builds.js` runs `builder.build` in the background, one build at a time, then `gates.runGates` on
the branch (`LOOP_BUILD_GATES`; by default the gates that need no GPU: policy, scan, unit, oracle, privacy). The
proposal moves approved → building → gated, or back to approved with the reasons. A build cut off by a restart is
marked stopped. Nothing is merged, pushed or deployed.

| Route (maintainer's token, `MAINTAINER_TOKEN`) | |
|---|---|
| `GET /api/loop/builds` | `{ builds: { [proposal]: … }, gates: { run, all } }` |
| `POST /api/loop/build` | `{ proposal }`: starts the build; 409 unless it is approved and C1–C3, or while another runs |

The sample data (`web/src/loop/mock.js`, labelled "Sample data · simulated club, seed 7") has a build with two
attempts and its diff (P-007), one still building (P-005), and uses only the flag keys `flags.schema.json` declares.

## 7. Voice input, on your server

**Before.** "Ask out loud" ran Whisper tiny in the browser (`web/src/voice/whisper.worker.js`, transformers.js and its
21.6 MB ONNX Runtime WASM in the build, and 42 MB of model files under `web/public/models/`).

**Now.** The mic is in the agent's box on the agent home (`web/src/voice/VoiceAsk.jsx`), and the sidebar's (or the
phone's top bar's) **Ask out loud** opens the agent home and starts it. Tap the mic and talk: the box turns into a
recording strip with a clock and a live level ("Listening… tap stop when you're done"; it stops by itself at 15 s;
✕ or Escape cancels). Tap stop: "Writing it down on your server…", then the words fill the box, caret at the end, for
you to read over, fix and send. Nothing goes to your agent until you press send. When something goes wrong it says
what in plain words, with "Again" and "type it instead": the mic blocked, no microphone, too short to hear, nothing
heard, speech to text not set up on the server. No suggestion chips.

How: the browser records with MediaRecorder (WebM/Opus at 32 kb/s, MP4 in Safari; echo cancellation and noise
suppression on) and sends the clip to `POST /api/asr` (the gateway's token). The gateway reads it with ffmpeg (16 kHz
mono, with a light denoiser for the app's clips: a high-pass and non-local means, `ASR_DENOISE=off` to skip it) and
Meta's Omnilingual ASR
(`omniASR_CTC_1B`) writes it down on the server's CPU, in the worker `agent/asr/worker.py` that stays loaded for 10
minutes. When the mic opens, the app asks the server to load the model (`POST /api/asr/warm`), so the first clip does
not wait the whole load. The clip and its WAV are deleted once read; the ledger gets a row per clip (`asr.app`: the
model, the seconds, the audio's length, the language; never the words). English (`eng_Latn`) unless `?lang=` says
otherwise. The Messenger voice notes use the same worker (`pocket.js`), without the denoiser: on the e2e's clean
voice note it heard "my right shoulder" as "my rihp shoulder", and the body log did not file it.

| Route | |
|---|---|
| `POST /api/asr?lang=` | the raw audio as the body (`audio/webm`, `ogg`, `wav`, `mp4`, `mpeg`, `aac`; 2 MB at most) → `{ text, seconds, audioSeconds, lang }`; 415 for anything else, 413 over the cap, 503 without the model, 502 when the audio can't be read |
| `POST /api/asr/warm` | `{ warming }`: loads the model now (false when this server has none) |

Measured on the server's CPU (`nice -n 19`), with six English requests of 2.9 to 3.8 s synthesized with the Windows
speech voice (Kokoro is only in another project's folder, which this work does not touch), sent as WebM/Opus:

| | words wrong (of 52) | exact |
|---|---|---|
| Clean, no denoiser | 7.7% | 3 of 6 |
| Pink noise about 21 dB under the voice, no denoiser | 46.2% | 1 of 6 |
| Clean, with the denoiser (as shipped) | 9.6% | 3 of 6 |
| Noisy, with the denoiser (as shipped) | 9.6% | 2 of 6 |
| Through the app in Chrome (its stand-in mic, MediaRecorder, the browser's own noise suppression), with the denoiser | 13.5% | 1 of 6 |
| The same, without the denoiser | 19.2% | 1 of 6 |

The mistakes are names and near-homophones ("Kenji" as "kengy", "Mia" as "me it", "and" as "in", "badminton" as
"bad minton"), which is why the words land in the box to check rather than going straight to the agent. Latency, from
sending the clip to the words: a median of 1.7 s (at most 2.5 s) for a median 3.3 s clip, of which the model takes
1.3 to 1.5 s; the first clip after the model has been unloaded takes 11.7 s, and 6.5 s when the app's warm-up starts as
the mic opens and the player talks for 4 s. In the app, from tapping stop to the words in the box: 1.6 to 2.3 s.

## Also

- `agentNotify` is gone from `web/src/agent.js` (it called a `/api/notify` route that does not exist).
- Whisper tiny is gone from the web app: `web/src/voice/whisper.worker.js`, `@huggingface/transformers` in
  `web/package.json` (with ONNX Runtime Web) and the model files under `web/public/models/`, which nothing reads now. The
  build is about 2.4 MB without them. The old `/api/asr` in `server.js` (10 MB, any type, a failed transcription
  answered 200, no ledger row) is replaced by the one in `webapi.js`.
- One highlight page: the camera effect is on **Film a highlight** (`#/highlights`); the separate `#/reel` page and
  `web/src/reel/OwnReel.jsx` are gone.
- Fixed on the way: Play's "likely / maybe" chip took the About page's `.band` section padding (a 250 px pill on a
  phone); the Autopilot's agent steps and the trace's A2A rows took the agents' thread box (`.a2a`); the trace's
  hold and "how likely" messages said "round undefined"; a Prompt Guard worker whose spawn throws at once (the builder's
  sandbox refuses child processes) is now "did not start", so the base's unit tests pass in the builder's sandbox and a
  build can start; building again replaces a stopped build's branch.
- Tests: `agent/test/webfeat_unit.mjs` (in `npm test`): the private mode per player and in a talk, the checks and
  their spans with no text, who was left out, the effect's reasons, the builds with stub builders and gates, and every
  new route on a real gateway (tokens, prefs, memory, the app's question past the guards, safety, holds, builds, a talk
  over A2A that says its mode and that the card checked out), and the voice input: the token, audio only, the 2 MB cap,
  the language code, 503 without the model, and a recording through ffmpeg to a stand-in speech worker, with its
  ledger row and no words in it.

## Screenshots

`submission/shots/web_features/`, each at `_desktop` (1440), `_tablet` (768) and `_phone` (375), `_light` and `_dark`,
from real runs on a test gateway (test data only; Muse Glimmer on the A100 test endpoint; the camera effect on GPU 0):
`you_settings` (private calendars), `memory_server`, `messages_safety`, `agent_answer_checked` (and
`agent_safety_side`), `autopilot_week` and `autopilot_approval` (private mode, who was left out and why, the holds'
countdown, the cards checked) and `autopilot_trace` (desktop: the trace with its safety check), `maintain_build`
(a real build of an approved C1 proposal) with `maintain_building`, `maintain_refused` (a spec on the never-list),
`maintain_sample_built` and `maintain_sample_building` (the sample data), `highlights_start`, `highlights_effect` and
`highlights_effect_playing_*` (the singles sample clip, CC BY 3.0, credited in `CREDITS.md` and on the frames: the
server chose a 20° orbit), `voice_recording`, `voice_heard` (with `voice_recording_home_desktop_light` and
`voice_sending_desktop_light`: Chrome's stand-in mic saying "My left knee hurts after yesterday's game"; the server
heard "my left knee herds after yesterday's game", left as it came), and `play_band` (Play's "likely / maybe" chip,
after its layout fix). `video/web_features_shots.mjs` takes them.

## Limits

- The safety checks are kept in memory: a restart clears the list (the traces keep their spans).
- Only the Autopilot reads what the player told their agent. The Match helper's "want a game?" does not yet: told
  "leave Tomás out", it may still suggest a game with Tomás (seen in the screenshots' run).
- A check made by a timer (the daily "want a game?" in Messenger) has no chat to belong to, so it is not listed.
- The camera effect takes about a minute more on the GPU and needs MapAnything in the reel's environment; the orbit is
  rare on phone footage by design (4 of 14 test moments in the prototype).
- Builds run the gates without the GPU suites by default; the maintainer runs those before merging.
- Voice: the model needs no language code and hears any language the same way (`?lang=` is passed on and kept in the
  ledger), so a word can come back in another script; names are often wrong. The accuracy above is on six synthesized
  clips, not on players' voices. Only one clip is written down at a time.

# The never-list

What Serve may never do, whatever the club asks for and whoever approves it through the community loop. Each item
names the check that enforces it:
- `test/policy.mjs` reads a unified diff (`node test/policy.mjs <diff>`: exit 0 allowed, 1 refused, the reasons as JSON);
- `src/loop/review.js` reads a spec (`check`) and the items the club shares (`screen`).

A spec that hits the list gets `needs: "never"`: no maintainer can approve it in `/api/loop/decide`. A maintainer who
wants one of these changes makes it by hand, outside the loop, and answers for it in review like any other commit.
The loop never edits this file, the policy, the tests or the guard (item 9).

Rule names in `code` are the `rule` field of policy.mjs's JSON; "spec:" names are `check`'s text rules.

| # | Never | Diff check (`policy.mjs`) | Spec check (`review.check`) |
|---|---|---|---|
| 1 | Book without the player's yes | paths `agent/src/play.js` (booking, holds) and `agent/src/ask.js` (the yes to a game, then the booking). Any changed line elsewhere that calls `book(`, `bookFor(`, `bookApproved(`, `request_approval`, `approval`, `asks.answer` or `outbox`, `autopilot.answer`, `lease(` or `releaseHolds(` (`booking`). Any changed line inside `book()`, `answer()` in autopilot.js, `lease()` and the like, named by the hunk header (`never-function`). In the web app, the `/api/play/book` and decide calls (`booking`) | spec: `book-without-yes` (auto-book, book without asking, skip the tap) |
| 2 | Pass a model's prose between agents (facts only) | paths `agent/src/a2a*.js` (the A2A client, server and talk) and `agent/src/schema.js` (`additionalProperties: false` on every message) | spec: `prose-between-agents` |
| 3 | Send player data off the server: outbound hosts are a fixed list | a URL, a bare domain or an IP address not on the list below (`outbound-host`). A new `fetch`, `http.request`, socket or WebSocket whose address is not a listed literal (`outbound-call`). `agent/src/files.js` (where a shared file may come from) is a path on the list. Reading a secret from the environment (`reads-secret`) | spec: `export` (send, upload or sync player data to somewhere), `outside-host` (any address not on the list) |
| 4 | Give a medical diagnosis or dosage | a medicine, a dose in mg, or "you have a torn …" in the app's strings (`medical`); "this is not a diagnosis" is fine. Paths `agent/src/body.js`, `health.js`, `health_import.py` (the body and health rules) | spec: `medical` |
| 5 | Weaken /forget | any changed line that calls a `forget` function (`forget`), or changes what a line says `/forget` does; any changed line inside a `forget()` (`never-function`). A new data file in the gateway (`new-data`), which /forget would not know about. `agent/src/loop/**` (where `signals.forget` lives) | spec: `forget` |
| 6 | Non-English text or paper names in the app UI | text in a script other than Latin in `web/src`, `web/index.html` or the Messenger replies (`pocket.js`, `messenger.js`, `server.js`) (`non-english`; a pattern that reads what the player typed is not text the app shows). A paper's name, an arXiv id, "et al.", a venue, "our lab research", "a study found" in the web app (`paper-name`) | spec: `non-english-ui`, `paper-names` |
| 7 | Add analytics or tracking | Google's tag, the Meta pixel, Segment, Mixpanel, PostHog, Hotjar, Sentry, Datadog, `sendBeacon`, an OTLP exporter, a cookie written (`tracking`) | spec: `tracking` |
| 8 | Add dependencies | a dependency or a script changed in a `package.json` (`dependency`); a lock file or `requirements*.txt` (paths); an import of a package not declared there, or from a URL; `npm install`, `pip install`, `curl … \| sh` | spec: `dependency` |
| 9 | Edit the tests, the policy itself, or the guard | paths `agent/test/**` (policy.mjs included), `docs/never.md`, `agent/src/guard.js`, `guard_worker.py`, `agent/src/loop/**` (the review, flags, gates). A line that touches a safety setting: `GUARD`, `PROMPT_GUARD`, `LOOP_GUARDS`, `AGENT_TOKEN`, `MAINTAINER_TOKEN`, `ALLOW_ORIGINS`, `A2A_PUBLIC` and the like (`safety-setting`). Also `agent/src/auth.js`, `server/**`, `.env*`, `.gitignore`, `.claude/**` | spec: `edit-tests`, `skip-review`, `injection` |
| 10 | Widen a flag's range without a maintainer | `agent/src/loop/flags.schema.json` is a path on the list; a line that sets, ships or rolls back a flag from app code (`flag-write`); reading one (`flags.get`) is fine | `classify`: a C0 value outside its declared range is C3, so it needs a maintainer, who widens the range by hand (spec: `widen-range` is "maintainer", not "never") |

Also refused, as code no spec should bring in: a shell or another program (`child_process`, `subprocess`), `eval`,
`new Function`, a string given to `setTimeout`, an import whose name is computed, markup written into the page
(`innerHTML`, `dangerouslySetInnerHTML`), `postMessage` to any origin, unencrypted `fetch` to another machine, a
secret-like string (CodeShield's regex rules ALL-R-008 to 015, AWS, Slack, Hugging Face and JWT shapes, an assigned
`secret = "…"`, a high-entropy string), a binary file, a symbolic link, and a path outside the repository. These
follow CodeShield (LlamaFirewall, arXiv 2505.03574): its language-agnostic regex rules and its JavaScript semgrep rules,
written here as patterns on added lines. Its weaker rules (Math.random, md5, a non-literal file path or RegExp, a
secret compared with ===) are warnings, not refusals. A refusal prints the line with any secret in it replaced.

## The outbound hosts (`HOSTS` in policy.mjs)

| What | Hosts |
|---|---|
| this machine | `127.0.0.1`, `localhost`, `::1`, `0.0.0.0` (and `x`, the placeholder base for parsing a request's path) |
| Messenger | `graph.facebook.com`, `*.fbcdn.net`, `*.fbsbx.com` |
| maps and places | `overpass-api.de`, `z.overpass-api.de`, `lz4.overpass-api.de`, `maps.mail.ru`, `nominatim.openstreetmap.org`, `places.googleapis.com` |
| weather | `api.open-meteo.com` |
| Meta's model API (when `LLM_URL` points there) | `api.meta.ai` |
| the web app's fonts | `fonts.googleapis.com`, `fonts.gstatic.com` |
| links the player opens | `wa.me`, `www.threads.net`, `www.facebook.com`, `www.instagram.com`, `www.openstreetmap.org` |

These are the hosts the code reached when the list was made (2026-10-28). Adding one is a maintainer's edit to this
file and to policy.mjs, by hand.

## What the screen holds back (`review.screen`)

A shared item is clustered only if code finds its text is at most 120 characters, in English, with no link, address,
handle, number, club member's name, place name, capitalized name, body or health term, hidden character or
instruction to the system, and every guard `LOOP_GUARDS` requires (default `llama-guard,prompt-guard`) answered and
passed it. A required guard that is down or not installed holds the item back: the screen fails closed.

## What these checks do not cover

- Patterns, not a parser: a host built from pieces at run time, or a call through a helper the diff doesn't show, is
  caught only as a new network call whose address isn't a literal, and only in files the policy reads as code.
- Text in a language written in Latin letters (Spanish, say) is not detected as non-English.
- A hunk that starts inside a multi-line template literal is read as code, so its text is checked less closely.
- `check` reads a spec's words with patterns; a request phrased to avoid them reaches the maintainer, who reads every
  spec that is not C0, and the builder never sees community text.
- One person with several Messenger accounts counts as several members (votes and support are per `who`).
- An approval is trusted from the spec's history (`by: "maintainer"`), which only the decide route may write.

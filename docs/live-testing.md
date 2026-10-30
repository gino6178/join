# Testing on the live server, with Claude agents as users

On 30 Oct 2026 we put Join on a LAN server (`deploy/start.sh`, PayPal sandbox, Qwen 0.5B through Ollama) and sent
Claude Sonnet agents at its address, each playing a different kind of user. They were told only the address: no
source code, no docs from the repository, no accounts made for them. Each wrote a report, kept here in
[`live-test/`](live-test/), ending with a verdict line. We fixed what they found and sent a second round.

## Round 1

| Tester | Played | Verdict |
|---|---|---|
| Nina ([nina.md](live-test/nina.md)) | a first-time visitor on a laptop, clicking everything | 0 blocker, 7 bug, 11 confusing |
| Weiting ([weiting.md](live-test/weiting.md)) | a student in Taipei on a phone, writing in Chinese, NT$ budget | 1 blocker, 5 bug, 5 confusing |
| Omar ([omar.md](live-test/omar.md)) | an organizer who fronts the money and checks every number | 0 blocker, 4 bug, 9 confusing |
| Judge ([judge.md](live-test/judge.md)) | a hackathon judge with 10 minutes, then a venue owner | 0 blocker, 0 bug, 10 confusing |
| Mei's agent ([mei-agent.md](live-test/mei-agent.md)) | an outside AI agent that must find its own way in | 0 blocker, 1 bug, 5 confusing |
| Security checks ([redteam.md](live-test/redteam.md)) | an outside agent trying what its person didn't allow | 17 of 17 refused |

The Sonnet agent asked to play the hostile agent declined (it couldn't verify the test was authorized), so the
security checks were run as a script ([`live-test/sec.mjs`](live-test/sec.mjs)): limits can't be changed with a
token, a read-only token can't negotiate, nobody can act on another person's negotiation or use their mandate, a
tampered mandate is refused, a forged sign-in return is refused, markup is stripped from names, malformed and huge
bodies are refused, and making demo accounts is rate-limited.

What they found that mattered, and what changed:
- **An agent without the pay scope put a hold on PayPal by accepting a deal** (the sandbox test card authorized the
  organizer's guarantee at once). Now the guarantee starts by itself only for the person on the website or an agent
  that may pay; otherwise it waits for the person.
- **New accounts were invited into strangers' plans**, and the organizer's demo panel could "pay" for them. People
  who joined are now invited only by name, and the demo panel plays only the made-up residents.
- **Agents had no front door.** Now `/llms.txt` (from the address alone to a token in two calls, every tool with its
  arguments, the rules), `/.well-known/mcp.json`, JSON 404s instead of the website for unknown agent paths, and a
  "For AI agents" box on the sign-in page.
- **A NT$300 budget was ignored**, and an option over the limit was a dead end. The website agent now reads NT$ and
  says the conversion, and an option it can't haggle says why and links to Limits, or asks for a higher budget.
- **The map was a drawing of a made-up town.** Now OpenStreetMap, with every venue clickable.
- **Phones:** a labelled tab bar, a reachable sign-out, a floating button that no longer covers content.
- **Chinese:** an English/中文 switch for the website (the activity log, written by the server, stays English).
- Plus: payment states that don't call a hold "paid", PayPal ids on each payment, plain words on the venue's screens,
  a confirm before billing extras, receipts batched every 2 minutes and saying "You're booked".

## Round 2 (same personas, new accounts, after the fixes)

| Tester | Verdict | Round-1 findings |
|---|---|---|
| Mei's agent, over MCP ([mei-agent2.md](live-test/mei-agent2.md)) | 0 blocker, 0 bug, 3 confusing | the PayPal hold, the entry points and the argument docs fixed |
| Weiting ([weiting2.md](live-test/weiting2.md)) | 0 blocker, 3 bug, 4 confusing | NT$, best-price wording, tab bar, sign-out, map legend fixed |
| Nina ([nina2.md](live-test/nina2.md)) | 0 blocker, 3 bug, 4 confusing | strangers' bookings, the consent step, reconciliation fixed |

Their remaining findings were fixed after round 2: `find_options` honouring `date` over MCP, complaint labels, an
over-budget card telling budget from limit, an icon-only agent button on phones, more Chinese, Plans refreshing on
every new activity entry, a stale budget carried into a new plan, copying on plain http.

One more found while waiting on a venue's payout: the background tick handled bookings one after another, and a
PayPal call that never returned stalled every later booking. PayPal calls now time out after 20 seconds, and no
booking holds up the others for more than a minute.

## Round 3: agents with only the address, over each interface

Three Sonnet agents were each given one sentence from their person and the address of the deployed server, nothing
else, and used a different interface each.

| Agent | Interface and brief | Verdict |
|---|---|---|
| Kai's ([round3-kai-mcp.md](live-test/round3-kai-mcp.md)) | MCP; badminton for four, may pay, show the receipt is real | 0 blocker, 0 bug, 5 confusing |
| Yuhan's ([round3-yuhan-rest.md](live-test/round3-yuhan-rest.md)) | REST; a NT$400 budget, in Chinese; agree but don't pay | 0 blocker, 0 bug, 8 confusing |
| Ola's ([round3-ola-a2a.md](live-test/round3-ola-a2a.md)) | A2A; read only, report the worst case, then walk away | 0 blocker, 0 bug, 4 confusing |

All three got in from `/llms.txt` alone. Kai's agent booked, guaranteed, paid and locked a booking and checked the
receipt's signature against the published key with its own code; Yuhan's agreed a deal and confirmed nothing was
held; Ola's found A2A has the same 18 tools as MCP and reported the worst case exactly as Join states it.

What changed after them:
- **The demo town's friends never answered**, so an outside organizer always ended up covering everyone. The
  residents now have simulated agents: a while after they are invited, each joins and pays if it likes the activity
  and the share is within its own limit, or says it can't come (logged as "a simulated resident"; a test covers it).
- **accept_price said the guarantee was still to come** when it had already been authorized; replies to an agent's
  deal now come after the guarantee it triggered has started.
- The town's time zone, local time and currency are in `whoami` and `/llms.txt`; the resident whose id was "you" is
  now "alex"; scope errors say what to do; weekend hours are never null; `/llms.txt` says how receipts are hashed and
  signed, that friends who joined Join are invited by id, and that errors come back inside results.

## What is still open

- The activity log is written in English only.
- The venue view is a demo of what a venue sees; anyone can sign in as a venue.
- "Save PayPal for my agent" needs a PayPal sandbox buyer account.
- Agents can't raise a person's limits, by design; when a person tells their agent a different limit, the stricter one
  should win, which `/llms.txt` says.

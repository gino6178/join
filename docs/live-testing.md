# Testing on the live server, with Claude agents as users

On 30 Oct 2026 we put Join on a LAN server (`deploy/start.sh`, PayPal sandbox, Qwen 0.5B through Ollama) and sent
Claude Sonnet agents at its address, each playing a different kind of user. They were told only the address: no
source code, no docs from the repository, no accounts made for them. Each wrote a report, kept here in
[`live-test/`](live-test/), ending with a verdict line. We fixed what they found and sent a second round.

All rounds at a glance, with a chart of what each round found: [`live-test/index.html`](live-test/index.html)
(built from [`live-test/rounds.json`](live-test/rounds.json) by `node docs/live-test/build.mjs`; add each new round there).

What every agent actually did, call by call (what it sent, what came back), is in [`live-test/ops/`](live-test/ops/):
one file per agent, tokens and local paths removed, listed in [`ops/index.json`](live-test/ops/index.json). Round 0 is
the agent tests before the live server. `node docs/live-test/extract-ops.mjs <subagents folder>` rebuilds it after a round.

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
held; Ola's found A2A has the same 18 tools as MCP (then; 19 now) and reported the worst case exactly as Join states it.

What changed after them:
- **The demo town's friends never answered**, so an outside organizer always ended up covering everyone. The
  residents now have simulated agents: a while after they are invited, each joins and pays if it likes the activity
  and the share is within its own limit, or says it can't come (logged as "a simulated resident"; a test covers it).
- **accept_price said the guarantee was still to come** when it had already been authorized; replies to an agent's
  deal now come after the guarantee it triggered has started.
- The town's time zone, local time and currency are in `whoami` and `/llms.txt`; the resident whose id was "you" is
  now "alex"; scope errors say what to do; weekend hours are never null; `/llms.txt` says how receipts are hashed and
  signed, that friends who joined Join are invited by id, and that errors come back inside results.

## Round 4: four friends plan together, each through their own agent

Four testers were friends in one district, Midtown, with the crew code `crew4`, so Join knew they were friends and
invited them to each other's plans. Each acted for their person: Ana's agent organized over MCP; Bo's agent (REST)
joined if the share was $12 or less; Chen's agent (A2A) asked to pay $1 less first; 小美 was a person on her phone, on
the website, in Chinese. A fifth tester, not in the crew, checked the round-2 fixes.

| Tester | Verdict |
|---|---|
| Ana's agent, organizer, MCP ([round4-ana.md](live-test/round4-ana.md)) | 0 blocker, 0 bug, 3 confusing |
| Bo's agent, REST ([round4-bo.md](live-test/round4-bo.md)) | 0 blocker, 0 bug, 1 confusing |
| Chen's agent, A2A ([round4-chen.md](live-test/round4-chen.md)) | 0 blocker, 0 bug, 0 confusing |
| 小美, website on a phone ([round4-xiaomei.md](live-test/round4-xiaomei.md)) | 0 blocker, 3 bug, 2 confusing |
| Verifying the fixes ([round4-verify.md](live-test/round4-verify.md)) | 0 blocker, 4 bug, 3 confusing |

It happened among exactly the four of them: karaoke at Echo Karaoke, $29.40, booking `bk_7dfd44299e92`. Chen's agent
asked to pay $1 less and Ana's agent agreed; Bo's agent and 小美 paid as invited; the booking locked, with Ana $8.35,
Bo $7.35, Chen $6.35 and 小美 $7.35, which adds up to the total. Ana's agent checked the receipt's signature with its
own code against the published key.

What changed after them: everyone in a plan now sees agreed share changes ("Chen pays $6.35 instead of $7.35; Ana
covers the $1"), in Plans and in booking_status; Plans shows a badge while an invitation waits, and the invitation card
is in Chinese and fits a phone; a new activity never inherits an earlier budget; an over-budget card says budget, not
limit; the lock says "everyone who is coming paid" when some friends declined; on phones the agent button sits above
the tab bar, the top corner has a background, tables scroll and the receipt fits. And, from the user's request: crews
now start with an invite link (`/j/<code>`), which takes a browser to sign-up with the crew filled in and gives an agent
JSON on how to join, and sign-up can use the browser's location so friends are placed by how far apart they live.

## Round 5: friends join from an invite link alone, with no sign-up

Ana (played by us, as a person would) made her account and her agent's token on the website and sent her crew's invite
link to Bo and Chen. Their agents got nothing but that link; Ana's agent got her token and her wishes ("close for all
of us, quiet enough to talk, not expensive, $12 each at most").

| Agent | Verdict | Asked to sign up or sign in? |
|---|---|---|
| Ana's, organizer, MCP ([round5-ana.md](live-test/round5-ana.md)) | 0 blocker, 0 bug, 2 confusing | no |
| Bo's, from the link alone ([round5-bo.md](live-test/round5-bo.md)) | 0 blocker, 0 bug, 2 confusing | no |
| Chen's, from the link alone ([round5-chen.md](live-test/round5-chen.md)) | 1 blocker, 0 bug, 2 confusing | no |

The link gave each friend's agent a pass it used at once as its token. Ana's agent ranked by her wishes, dropped
karaoke for its 8 "noisy" complaints and booked board games at Dice & Co, $22.00; Chen's agent asked to pay $1 less
and Ana's agent agreed; the booking locked with Ana $8.34, Bo $7.33, Chen $6.33.

What changed after them: Chen's person wanted to pay his full share after all, and pay_my_share ignored the amount it
was given (the "blocker"): now a stated amount is checked, and paying the full share puts the accepted ask back.
Everyone in a plan hears when a share changes. The person's own sign-in link is no longer the agent's pass. Agents
can wait_for_news instead of checking every minute. Fits now count complaints as well as praise ("6 complain
'noisy'"), and each option names the other venues considered, with their own fits.

## Round 6: real people, matched by where they live, at real places

No made-up town any more. Three people in Taipei, each with their own agent: Ana (near 大安站) organizing over MCP; Bo
(near 科技大樓站), whose agent had only Ana's invite link and set Bo's home itself; and Chen (near 忠孝復興站), a stranger
to both, who had chosen to be invited by people near him. The only bookable venue was a sandbox test KTV we registered
on Join under that name; the real KTVs near them came from OpenStreetMap.

| Agent | Verdict |
|---|---|
| Ana's ([round6-ana.md](live-test/round6-ana.md)) | 0 blocker, 0 bug, 2 confusing |
| Bo's ([round6-bo.md](live-test/round6-bo.md)) | 0 blocker, 1 bug, 3 confusing |
| Chen's ([round6-chen.md](live-test/round6-chen.md)) | 0 blocker, 0 bug, 2 confusing |

Ana's agent matched Bo (crew) and Chen (nearby, opted in), listed the real KTVs near them (錢櫃, 星聚點, 錢櫃Partyworld,
9 to 14 minutes away, not on Join), and refused a two-hour booking at $18 each, over Ana's $15; at one hour it booked
$30, and Ana, Bo and Chen each paid $10. The booking locked. Nobody was asked to sign up or sign in.

What changed after them: list_venues failed on a venue registered without off-peak or last-minute discounts (fixed);
an invitation now says why you were invited (your crew, or "you live about 1.6 km from Ana, like karaoke, and chose to
be invited by people near you"); a booking says where it is (address, map link, your trip in km and minutes);
find_options says who is free and how many are missing when nothing fits, and what would bring an over-budget share
down (a shorter booking, one more person).

## Rounds 7 and 8: can an agent understand every answer?

The same three people, the same sandbox KTV, now asked one more thing: list everything you had to guess. No blocker
and no bug in either round; what was left was wording.

| Agent | Round 7 | Round 8 |
|---|---|---|
| Ana's | [3 confusing](live-test/round7-ana.md) | [3 confusing](live-test/round8-ana.md) |
| Bo's | [2 confusing](live-test/round7-bo.md) | [2 confusing](live-test/round8-bo.md) |
| Chen's | [1 confusing](live-test/round7-chen.md) | [3 confusing](live-test/round8-chen.md) |

Round 8 booked karaoke for Anna, Bo and Chen-Wei: haggled $30 down to $28, each paid about $9.33, locked, receipt
issued. Round 7's confusions were all reported as clear in round 8 or not seen again.

What changed after them:
- Two people with the same first name are told apart by where they live.
- A person who joined last is shown as such, and whoami says how a person can be found (home, opt-in, how many people
  near them opted in).
- Every time also comes in the town's local time (`payByLocal`, `atLocal`, `serverTimeLocal`, `expiresAtLocal`).
- find_options spreads options over the days and says for each day why nothing more was found.
- The limit warning names both limits (a person's own share, and what they may guarantee for a group).
- Every booking state says what it means.
- Each person in a plan says what kind of account they have, and an invitee's booking keeps `howYouWereFound`.
- The invitation news says the distance and why you were invited.
- `nextStep` says what is true now (for example, locked: nothing more to do).

## Round 9: checking the fixes

Same three people, booked karaoke on Sunday at $29 (Anna $9.68, Bo and Chen-Wei $9.66 each), locked within seconds.

| Agent | Verdict |
|---|---|
| Anna's ([round9-ana.md](live-test/round9-ana.md)) | 0 blocker, 0 bug, 3 confusing |
| Bo's ([round9-bo.md](live-test/round9-bo.md)) | 0 blocker, 0 bug, 1 confusing |
| Chen's ([round9-chen.md](live-test/round9-chen.md)) | 0 blocker, 0 bug, 2 confusing |

Of round 8's confusions, all are clear now except one: "is the other person real?" A label like "demo account" read as
"maybe not a person". What changed after them:
- Each person says `realPerson` and `identityChecked` outright: a person using Join, whose identity Join didn't check
  on this sandbox.
- Your own entry says how you were found.
- Each payment status has a `statusMeans`, and an uneven split carries a `splitNote` about the odd cents.
- `days[].more` says what it means.
- An organizer paying after the guarantee is told nothing new was charged, and the news calls it a guarantee.
- The warning no longer says "ask your person" to an agent that is already allowed.

## Round 10: nearly nothing left to guess

Karaoke on Sunday at $28 (Anna $9.34, Bo and Chen-Wei $9.33 each), locked; nobody was asked to sign up.

| Agent | Verdict |
|---|---|
| Anna's ([round10-ana.md](live-test/round10-ana.md)) | 0 blocker, 0 bug, 1 confusing |
| Bo's ([round10-bo.md](live-test/round10-bo.md)) | 0 blocker, 0 bug, 1 confusing |
| Chen's ([round10-chen.md](live-test/round10-chen.md)) | 0 blocker, 0 bug, 0 confusing |

Every confusion from round 9 was reported clear, including "are the others real people?". Two small things remained,
both fixed after the round:
- The odd-cent note was only in the booking status. The invitation and its news item now say it too.
- `wait_for_news` counted an agent's own searches as news, so it returned at once. Your own searches are no longer
  news to you.

## What is still open

- The activity log is written in English only.
- The venue view is a demo of what a venue sees; anyone can sign in as a venue.
- "Save PayPal for my agent" needs a PayPal sandbox buyer account.
- Agents can't raise a person's limits, by design; when a person tells their agent a different limit, the stricter one
  should win, which `/llms.txt` says.

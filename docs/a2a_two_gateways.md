# A2A between two gateways

Until now every member's agent ran inside one gateway: `agent/src/a2a_server.js` serves them all under
`/a2a/members/<id>`. The talks were real A2A (the official `@a2a-js/sdk`, JSON-RPC, signed Agent Cards), but every
call stayed inside one process. This page covers the second step. A second, independent Serve gateway runs on another
machine, with members of its own, and your agent negotiates with them over the network: proposals, holds, bookings and
"how likely is a yes" all cross between the two machines. Each gateway trusts the other only as far as its
signatures, its pinned key and its allow-list allow.

Code: `agent/src/peer.js` (new), and small hooks in `a2a.js`, `a2a_server.js`, `a2a_client.js`, `play.js`,
`match/ask.js`, `schema.js` and `server.js`. Tests: `agent/test/a2a_peer_unit.mjs` (in `npm test`),
`agent/test/peer_redteam.mjs` (section 7 of `redteam.mjs`) and `agent/test/a2a_two_gateways.mjs` (the eval on the two
real machines). Deployment: `agent/test/twogw/`.

## Topology

```
 GPU server (Taipei)                                     serve-api-a100b (GCP us-central1-b, spot A100)
 ┌───────────────────────────────────┐                   ┌──────────────────────────────────────────────┐
 │ gateway A   127.0.0.1:23790       │                   │ gateway B   127.0.0.1:23890                  │
 │  your agent (the Talk code)       │                   │  systemd serve-gateway-b, user servegw        │
 │  the demo club's members' agents  │                   │  "Northside Club (simulated)": 10 members     │
 │  key A, token A, data A           │                   │  key B, token B, data B (calendars, rules,    │
 │  model: a cloud A100 (11445)      │                   │  records, holds), its own Ollama 127.0.0.1:11434│
 └──────────────┬────────────────────┘                   └──────────────────────▲───────────────────────┘
                │  ssh serve-tunnel@VM (twogw/gw_tunnel.sh, the pinned host key, the tunnel-only key)  │
                ├── -L 127.0.0.1:23890 ──────────────────────────► VM 127.0.0.1:23890 (A reaches B) ────┤
                └── 127.0.0.1:23790 ◄──────────────────────────── -R VM 127.0.0.1:23790 (B reaches A) ─┘
```

- **No port is open to the internet.** Both gateways listen on 127.0.0.1 only. Gateway B gets its address from
  `GW_HOST=127.0.0.1`, and its systemd unit also confines it to localhost (`IPAddressDeny=any`,
  `IPAddressAllow=localhost`). The only way in or out of the VM is the SSH connection the server opens, with the same
  user, key and pinned host key as the Ollama tunnel. The VM's sshd lets that user forward to `127.0.0.1:11434`
  (Ollama, as before) and `127.0.0.1:23890` (gateway B), and listen on `127.0.0.1:23790` (the reverse forward to A),
  and nothing else: no shell, no other port, `GatewayPorts no`. No firewall rule was added.
- **Gateway B is a whole Serve gateway** (`server.js`), not a stub. Its members are made by code from a seed
  (`twogw/club_b.mjs`, seed 31), so every one is simulated, and no real player's data is on the VM. The VM made its
  own key and token, which never leave it. B starts on boot (the VM is spot and gets stopped) and restarts on
  failure. `bash agent/test/twogw/deploy_b.sh` deploys or updates it from the PC. The VM's README on the server
  (`~/shuttlecoach-meta/api_vm/README.md`) has a section on it.
- **Gateway A in the eval** is the gateway's A2A server (`a2a_server.js`, the same module `server.js` serves under
  `/a2a/`) and your agent's Talk code, in one process on the server, as the `EVAL_A2A=1` evals run. The live gateway
  (8790) has no peers configured, and its behaviour does not change.

## What crosses the wire

| From A to B (signed POST, JSON-RPC `SendMessage`) | From B to A (signed answers) | Never |
|---|---|---|
| `serve.proposal`: sport, format, minutes, up to 12 times as facts (`{id, date, start, venue, court}`), A's own sentence (kept by B, never shown to its model), the asker's id | the decision: accept, counter or decline, the times that work (`works`), which tier decided, and its cost | a calendar, a rule, a record or a health limit, either way |
| `serve.hold`: hold, release or **book** a time, in its own talk | held or not, booked, until when, and why not | a real player's data: a real player's agent never answers a peer |
| `serve.likely` with `A2A-Extensions: <B's extension URI>` | a band, and B says the extension back in its own `A2A-Extensions` | either gateway's token |
| GET: B's Agent Cards and its key set (public) | GET through the reverse forward: A's key set, to pin it | anything beyond what a member's card offers |

A talk with a member on another gateway is always a private-calendar talk (as `A2A_PRIVATE=1`). Your agent can't see
that member's week, so it lists times from your own week, and each member's agent checks its own calendar and rules in
code on its own machine.

## The trust model

1. **An allow-list** (`A2A_PEERS_FILE`). Each peer has a name, its origin as reached from here (the tunnel's local
   port), the members of this gateway its agents may ask (`serve`), and the members of theirs your agent may ask
   (`members`, a public profile only: id, name, level, sports, singles or doubles). Without the file there are no
   peers, and the gateway is as it was. Here a peer's member is `<id>@<peer>` (`nb03@gwb`), so it never clashes with
   one of ours, and its agent is always reached at that peer's origin.
2. **The peer's key, pinned on first use.** The first time A talks to B, it fetches the key set at B's own origin
   (`/a2a/keys.json`, no redirects) and pins it (`A2A_DATA/peer_pins.json`). A key can also be written into the
   config by hand (`key`). B pins A's key the same way, through the reverse forward, the first time a signed request
   names a key B has no pin for. The key set must hold exactly one Ed25519 key, and its id must be the key's own
   fingerprint. After that only the pinned key counts. A card or a request signed by any other key is refused and
   logged, until someone deletes the pin (the peer rotated its key) or writes the new key into the config. The first
   fetch is as trustworthy as the SSH tunnel it runs through, whose host key is pinned.
3. **Every request is signed.** A request to a peer carries `Serve-Signature`: a compact JWS (EdDSA, with the
   gateway's own key, the one its Agent Cards are signed with, under `typ serve-request+jwt` so neither kind of
   signature can stand in for the other). It covers the method, the path, the SHA-256 of the body, the receiver's key
   id (`aud`), issued-at, an expiry 60 s later at most, and a nonce. The receiver checks it against the pinned key
   that the key id names. It refuses:
   - a nonce it has seen (nonces are kept on disk until they expire, so a restart opens no replay window);
   - a clock more than 30 s off;
   - a body or a path other than the one signed;
   - a request meant for another gateway.

   The peer's agents' cards declare the scheme (`securitySchemes.peer`). The gateway token is never sent to a peer,
   and a peer can't use it: B's API, which the tunnel also reaches, still needs B's own token.
4. **Every answer is signed too** (`typ serve-response+jwt`): its status, the SHA-256 of its body, and the nonce of
   the request it answers. Your agent uses an answer only if it was signed by the pinned key of the peer it asked,
   for that very request. So a third gateway that takes over B's address can't answer for B's members, even after
   your client has trusted that address (B's tunnel is down, and its port is free for anyone on the machine to take).
5. **Each member.** A member's agent answers a peer only if `serve` names it, and a real player's agent never
   answers one, whatever the list says. A peer is the SDK's user for its requests, so it lists and reads its own
   tasks only. Its message ids, its talks (the A2A context, and so its holds) and its asker ids are kept under its
   own name (`peer.<name>.<talk>`). Nothing it sends can reach this gateway's own talks or another peer's. A peer
   that learned one of A's talk ids can't release that talk's holds.
6. **Cards, as before.** A peer's card is checked as served against the pinned key at the card's own origin, and it
   must name the address it was fetched from as its JSON-RPC interface.
7. **The player's yes, as a signed mandate** (after AP2's closed mandates). When the player taps Book it, gateway A
   signs a mandate with its key (`typ serve-mandate+jwt`, 5 minutes to live, a nonce). It names:
   - who (a hash of the player's id), and the talk;
   - the game: sport, format, date, start, length and venue;
   - the court, the members and the price cap.

   The booking (`serve.hold` action `book`) carries it. B's member agent books only if all of these hold:
   - the mandate is signed by A's pinned key;
   - it is for this talk, this time and this member;
   - it has not expired;
   - it has not been used for this member before.

   B keeps each mandate it accepted as its receipt (`A2A_DATA/mandates.jsonl`). A booking without a mandate is
   refused, and so is a forged, altered, expired or replayed one, and each refusal is logged. Everything signed is a
   fact made by code (the talk's agreed option), never a model's words.

## A negotiation across gateways

- **The acceptable-set protocol** is unchanged. Every member's agent says which listed times work for it, on
  whichever gateway it lives. The game goes at the best time that works for everyone, and a time someone ruled out
  is never proposed.
- **Holds over the wire, all or nothing.** Members hold the agreed time one at a time, in id order, A's members and
  B's members mixed (`nb03@gwb` sorts with the rest). If one can't hold it, every member already holding it lets it
  go. A member whose gateway could not be reached is told to let go too, because its answer may have been lost on the
  way.
- **The booking checks again.** When the player books, `play.book` asks each partner on B to confirm (`serve.hold`
  with action `book`, carrying the player's mandate) before anything is booked here. B's agent checks the mandate,
  that the time is still one its member said works in this talk, and that the member is not playing or held then,
  and turns its hold into the member's game on
  its side (`play.js commit`). Other talks on B then see the member as playing then. If one refuses, the ones that
  confirmed let go, and nothing is booked on either side. A game cancelled here is let go on B as well.
- **Bands from B's members.** `serve.likely` goes to B's agents with `A2A-Extensions` naming the extension URI that
  B's card declares, and B says it back in its response.

## Failure modes

| What happens | What your agent does | Measured |
|---|---|---|
| B's service is stopped, or the VM is stopped or preempted | A probe of B's public key set (3 s at most, remembered for 10 s) comes first. A talk with B's members ends at once with "X's agent is not reachable now", and the round is not sent to anyone, so A's own agents are not asked for nothing. Estimates from B's members are "unknown". | 0.0 s for each of three talks while B was stopped |
| B stops answering in the middle of a request (frozen, preempted, its tunnel black-holed) | While a request to a peer waits, the peer is probed every 10 s (5 s in the eval). Two missed probes give the request up, instead of waiting out the 4.5-minute A2A timeout. | given up after 13.0 s (the A2A timeout is 270 s) |
| B goes down between agreeing a time and the player's answer, or while holding | The holds on A are released. The releases B can't hear wait in an outbox on disk (`peer_outbox.json`) and are sent again every 30 s until B answers, or until the hold has lapsed by itself (30 min). | 4 releases waited (one from a talk cut off while it was holding) and were delivered 2.6 s after B was back; every one of those members was free at that time again |
| A hold, release or booking times out | A hold does not wait for a model: 20 s at most (`A2A_HOLD_TIMEOUT_MS`). A timeout is a refusal, and the member is told to let go as well, through the outbox if needed. So a timeout leaves no stray hold. | the talk cut off while holding ended "Emre's agent is not reachable now (the time could not be held)", with nothing left held on A |
| The VM stops (idle shutdown, spot) and comes back at a new address | Gateway B starts on boot. The tunnel loop reads the new address from `vm_ip_b` and retries once a minute (`gw_tunnel.sh kick` at once). Both pins and B's nonces are on disk. | after an idle shutdown on 2026-10-28, B was up within seconds of boot, and the eval passed again on the new address |
| A kept-alive connection to B breaks before any answer | Sent once more, signed afresh, if B answers a probe. B answers a message id once, and a message still being answered is waited for. Holds and bookings are the same twice. | |
| A bad signature, an unknown peer, a replay, a member not shared | Refused (401, or 403 for a member not shared) and logged with the reason, the path and the key id (`peer_log.jsonl` and the journal), never a key or a token | 13 of 13 forged requests and bookings to B refused, each logged on B with its reason except the two its token refused |

## Measured

From `agent/test/a2a_two_gateways.mjs` on the two real machines, 2026-10-28 19:13 Taiwan time (the last of seven
runs, after the VM's idle shutdown and restart at a new address; the four before it passed too, and the first two found bugs, fixed since):
- gateway A on the GPU server (Taipei); its demo members' model on a cloud A100 (`serve-api-a100`, port 11445);
- gateway B on `serve-api-a100b` (us-central1-b), on that VM's own A100;
- run with `FRESH=1 bash agent/test/twogw/drive.sh 12`: 22 of 22 checks passed. Raw results are in
  `agent/data/twogw-a/result.json` in the server's `~/shuttlecoach-meta/twogw/`.

**The hop.** The same small requests sent to A's own gateway (loopback) and to B (through the tunnel to
us-central1), 15 of each:

| Request | A (median / p95) | B (median / p95) | The hop adds |
|---|---|---|---|
| GET the key set | 3.0 / 18.5 ms | 190.9 / 196.9 ms | 188 ms |
| a proposal its agent answers by code (signed, its answer signed) | 14.3 / 57.3 ms | 198.4 / 201.9 ms | 184 ms |
| an estimate (`serve.likely`) | 12.0 / 75.7 ms | 199.0 / 763.8 ms | 187 ms |

One round trip to us-central1 is about 185 ms. Signing and checking both ways costs too little to show up next to
that. The talks themselves are dominated by the members' agents thinking: the median talk took 42 s in this run
(20 to 24 s in the earlier runs, when the model VM at 11445 was less busy). The first request of a run took about
1.1 s.

**Talks.** Twelve talks in pairs, run at the same time with a member of B in common: singles with one member of B,
and doubles with one, two or three members of B mixed with A's members. Then two doubles that had no time in common.
- **Agreed:** 7 of 12 talks that had a time in common by the members' own calendars. Courts and longest-trip rules
  are not counted in that test. By the number of members on B: one, 3 of 6; two, 2 of 3; three, 2 of 3. Of the five
  that ended without a game:
  - four lost the shared member's only common time to the talk running beside them, as holds are meant to make them
    (one gets everyone, the other lets go);
  - one had a member of A whose model did not answer (A's side, not the hop).
- **No time in common:** 2 of 2 ended without a game.
- **Grading:** every time B's agents agreed to was in their own calendars and rules (graded against B's seed). No
  member was in two games at once.
- **Booked:** 4 games on both gateways (5 with the re-check below). A probe afterwards found each time refused by
  B's agent: 7 of 7 members were now playing then.
- **Let go:** 3 games. A probe found all 6 of their members' times free again on B.
- **Over the wire:**
  - 18 holds: 14 held, and 4 refused because the talk beside them already held that member;
  - 9 bookings: 8 confirmed by B's agents, and 1 refused in the re-check;
  - 7 releases.
- **Left behind:** no hold remained on A after the talks.

**Bands.** B's eight shared members all gave a band (6 maybe, 2 likely). The two not shared with A (nb09, nb10)
were refused (403), and to A they are "unknown".

**The re-check.** A doubles agreed Thu 19:00 with Ana (nb04, on B), and the player let it go. Another talk then
proposed and held that time on Ana. Booking the first game after all was refused by Ana's agent on B ("could not
confirm the time (already playing then)"), and nothing of it was left on either side. Once the other talk let the
time go, the same booking went through on both gateways. Two earlier runs met the same case by themselves: a
competing hold at the same time, and one an hour before it.

## The attacks

**Live, against gateway B** (phase 3 of the eval): thirteen forged requests and bookings, all refused. F11 to F13
come from the run at 19:47 Taiwan time, after the mandates were added; it passed all 22 checks again. In that run a
mandate took 0.4 ms to sign and 0.7 ms to check (median of 500), and B kept a receipt for each of the 10 bookings it
accepted.

| # | What | B's answer |
|---|---|---|
| F1 | no signature, no token | 401 (B's token) |
| F2 | signed by a key B has not pinned (an unknown gateway) | 401 unknown-peer |
| F3 | a replay: the same signed request twice (the first got 200) | 401 replay |
| F4 | the body changed after signing | 401 wrong-body |
| F5 | signed for one member, sent to another | 401 wrong-request |
| F6 | made five minutes ago | 401 expired |
| F7 | signed for another gateway | 401 wrong-audience |
| F8 | a third gateway signing with its own key under A's key id | 401 bad-signature |
| F9 | a valid signature, for a member B does not share with A | 403 member-not-shared |
| F10 | B's own API through the tunnel, without B's token | 401 |
| F11 | a booking with no mandate from the player | not booked: no signed mandate |
| F12 | a booking with a mandate made 20 minutes ago | not booked: expired |
| F13 | a valid mandate (it booked), the game let go, then the same mandate replayed | not booked: already used |

**In `redteam.mjs`, section 7** (`test/peer_redteam.mjs`, one process, no model: gateway A's real code against an
honest peer B, a third gateway C on the allow-list for one member, and a gateway D nobody listed): 15 of 15 passed. The
whole suite stopped 89 of 89 (2026-10-28 20:17 Taiwan time, Muse Glimmer on the A100 at 11445).

| # | Risk | Attack | Layer that stops it |
|---|---|---|---|
| P0 | - | (control) a talk with an honest peer's member: key pinned on first use, answers signed | gets through: agreed |
| P1 | LLM06 | a forged Agent Card at the peer's own address, signed by another key that its key set now serves too | the pinned key: only it counts after first use |
| P2 | LLM06 | a replayed request from a peer | a nonce used once, kept on disk until it expires |
| P3 | LLM06 | a request from a gateway that is not on the allow-list | only an allow-listed peer's pinned key counts |
| P4 | LLM06 | a third gateway on the peer's address, answering yes for the peer's member, after A's client had trusted that address | an answer counts only if the peer's pinned key signed it, for that request |
| P5 | LLM06 | a third gateway signing with its own key under the peer's key id | the signature is checked against the key the id names |
| P6 | LLM06 | an allow-listed gateway asking for a member shared only with another peer | the member's `serve` list |
| P7 | LLM02 | a peer asking the real player's agent | a real player's agent never answers a peer |
| P8 | LLM02 | a peer listing a member's tasks to read A's own talks | a peer sees only its own tasks |
| P9 | LLM06 | a peer reusing one of A's talk ids to let that talk's hold go | a peer's talks and holds are kept under its own name |
| P10 | LLM02 | the gateway's token sent along to a peer | a peer gets the signature, never the token |
| P11 | LLM06 | a peer booking one of A's members with no mandate from the player | a booking needs the player's signed mandate |
| P12 | LLM06 | a forged mandate (another key under the peer's key id) and an altered one (another time) | checked against the peer's pinned key, for this talk, time and member |
| P13 | LLM06 | an expired mandate | five minutes to live |
| P14 | LLM06 | a valid mandate used, the game let go, the mandate replayed to book it again | used once per member, kept as the receipt |

## Running it

```bash
# the PC (Git Bash, in the repo): deploy or update gateway B on the VM
bash agent/test/twogw/deploy_b.sh
# the server: the tunnel loop (once; it reconnects by itself)
setsid -f ~/shuttlecoach-meta/twogw/gw_tunnel.sh run > /dev/null 2>&1 < /dev/null
~/shuttlecoach-meta/twogw/gw_tunnel.sh status
# the PC: the eval on the server, with the driver that freezes, stops and starts B's service on its MARK lines
FRESH=1 bash agent/test/twogw/drive.sh 12          # FRESH=1 moves B's earlier talks and games aside first
# the tests that need neither machine
cd agent && npm test                              # includes test/a2a_peer_unit.mjs (17 tests)
node test/peer_redteam.mjs                        # the fifteen peer cases alone
```

## Limits

- **Plain HTTP inside the SSH tunnel.** The tunnel keeps what crosses private between the two machines. On the VM,
  though, a process that took B's port while B is down would see what A sends B: the facts of a proposal, never
  anyone's private data. It could not answer for B's members (P4). Encrypting each request to the peer's key would
  close this, and is not built.
- **Trust on first use.** The first key fetched is the one pinned. A key that changes later is refused until someone
  unpins it by hand. There is no rotation protocol, and one Ed25519 key per gateway signs both its cards and its
  requests (kept apart by `typ`).
- **Clocks.** A request is accepted within 30 s of the receiver's clock. Both machines use NTP.
- **Mandates are closed only.** Each mandate binds one booking. An open mandate (the Autopilot's standing limits:
  games a week, days, the longest trip) is not built. B records the price cap but has no price of its own to check
  it against. A mandate is signed only for partners on a peer gateway: this gateway's own members are booked by its
  own code, as before.
- **Preemption in the middle of a talk was simulated.** The eval froze (SIGSTOP) and stopped B's service; it never
  stops the VM. The VM's own idle shutdown and restart did test the boot path: B came up on its own, at a new
  address. A preempted VM also drops the tunnel within about 30 s (`ServerAliveInterval 10`, three missed). Until
  then the probes behave as they do against a frozen B.
- **Only one direction was measured.** B's own agent can negotiate with A's members by the same code, if B's
  `peers.json` lists them, but the eval only measures A talking to B's members. A2A_PEERS_FILE is not set on the live
  gateway.
- **The public API.** A peer's members are reached through `negotiate`, `resumeNegotiation`, `estimate` and
  `play.book`. `/api/match/talk` and the Match helper still choose from this gateway's own club, so a peer's members
  are not offered in the app yet.
- **The roster is static.** What A knows of B's members (their names and sports) is in A's config, not fetched from
  B.
- **No new attack on the model.** These cases test layers in code. The model's side of A2A is still covered by
  section 1 of `redteam.mjs`.
- **Only the A2A routes are peer-aware.** Peers authenticate to `/a2a/members/*` only. Everything else on a
  gateway still needs that gateway's own token.

## What the other docs should say

These files were left alone on purpose. Here is what each should gain.
- **README.md**: one line under the agents. Members' agents can also live on another Serve gateway on another
  machine. Requests and answers between gateways are signed (Ed25519), the peer's key is pinned on first use, and an
  allow-list decides who may ask whom. It was measured between the GPU server and a cloud VM: the hop adds about
  185 ms, and a talk with an unreachable gateway ends at once. Link here.
- **docs/security.md**:
  - In "The layers", a bullet for **peer gateways**: signed requests and answers, pinned keys, the allow-list, the
    `serve` list, real players never served, and per-peer scoping of tasks, talks, holds and askers.
  - Correct the cards bullet: "between servers it is as strong as their TLS" now holds only for agents outside the
    allow-list. A peer's cards are checked against its pinned key.
  - In the table, rows P0 to P14, and a bullet for the signed mandates. The count becomes 89 cases.
  - In the Rule-of-Two table, a member's agent answering a peer is still A and B, never C.
- **docs/methods.md**: the cross-gateway protocol (`serve.hold` action `book`, which turns a hold into the member's
  game; the release outbox; the private-calendar talk for remote members) and the measured numbers above.
- **docs/scale.md**: a club can be split across gateways. Each gateway keeps its own members' data, the hop costs
  about 185 ms a round trip, and the model time dominates.
- **submission/*.md**: "A2A between two machines": the Talk helper agrees games with members whose agents run on
  another gateway in another region, with nothing private crossing and every message signed. Then the numbers: the
  hop adds 185 ms, 13 of 13 forged requests and bookings were refused, every booking on B carries the player's signed mandate, and a talk with a downed gateway ends in 0 s.

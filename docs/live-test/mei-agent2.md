# mei-agent2 report (Mei's agent, round 2, MCP Streamable HTTP via @modelcontextprotocol/sdk)

## Steps
1. Read round-1 report. GET /llms.txt, agent card. Landing page noscript now points to llms.txt; /.well-known/mcp.json now returns real JSON.
2. POST /api/auth/demo {"name":"Mei"} -> POST /api/tokens scopes read+negotiate (no pay) -> token.
3. Node MCP client (StreamableHTTPClientTransport, Bearer token): whoami, find_options, tools/list, start_negotiation, make_offer, accept_price, booking_status, my_plans. Script deleted at the end.
4. Mandate on site: perGame 15, perWeek 40 (stricter than Mei's $20 each, so I used $15).
5. Karaoke, Echo, Sat 2026-10-31 20:00, 120 min, 4 people: ask 64.80 (16.20 each, overBudget). Offered 52 -> counter 58.80 (14.70 each, within 15). accept_price -> booking bk_c2b7a6f4a486, room 3. Did not pay (no pay scope, did not call pay_my_share).
6. Hot pot Sat: Westgate Hot Pot House ask 100.80 = 25.20 each, over limit, not pursued.

## Hold check (key test)
After accept_price: booking state `awaiting_organizer`, organizer payment status `not_started`, via null, paypal null, payBy null, guaranteeBy ~10 min. Re-checked 20 s later (booking_status and my_plans): unchanged. NO PayPal authorization or hold was placed. accept_price's tool text now says that without the pay scope nothing is held in PayPal until the person guarantees on Join.

## Round-1 findings
- Hold placed on accept with no pay scope (BUG): FIXED.
- $20 vs mandate $15, which limit wins: PARTLY. llms.txt now says "keep to the stricter one" and find_options shows youCanSpend; but the site mandate (15) differs from what Mei said (20) with no way for the agent to ask/raise it, and 120-min share still needs haggling.
- find_options ignores date filter: NOT FIXED. date "2026-10-31" still returned Fri Oct 30 and Tue Nov 3 options. (params are now documented in llms.txt, so the doc gap is FIXED; `dates` array worked for hot pot but still included 15:00/other start times.) Options still all 120 min for karaoke here, so the 60-min mismatch looked better.
- Player ids ("you" = Alex Rivera) hard to discover: PARTLY. The bad_players error now says to look in find_options options[].players/names. But whoami's own id is not tied to those names, and "you" as an id for another person is still odd.
- Review complaints label mismatch ("quiet" vs reason "noisy"): NOT FIXED (still complaints ["quiet"] vs "noisy (8)").
- make_offer string amount gives unclear error: FIXED. MCP schema validation now says "expected number, received string at amount"; llms.txt lists argument types.
- REST param names only via MCP: FIXED (llms.txt lists args).
- /.well-known/mcp.json soft 404 and no landing pointer: FIXED.
- weekendOpen null ambiguity: not rechecked (not exercised).

## New observations
- MINOR: whoami/organizer "approval: sandbox test card (stands in for your approval)" appears in ifYouAccept on every step; for a token without pay scope it reads as if a card would be used, while accept does nothing in PayPal. Wording could say "your person approves on the website".
- MINOR: whoami returns two very long JWT mandates inline; fine, but my_plans/negotiation text is long.
- MINOR: friends (Alex "you", Hana, Tomas) show as invited-state players with no explicit invite status in booking_status (invite: null, you: null for the organizer). Unclear if they were actually notified.
- Guarantee window is short (guaranteeBy about 10 min after accept) and Mei is not asked in-band; the agent has to tell her to open Plans on the site.

VERDICT: 0 BLOCKER, 0 BUG, 3 CONFUSING (date filter ignored, review label mismatch, mandate vs told limit)

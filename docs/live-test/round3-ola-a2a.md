# ola-a2a report

## How I found my way in
1. GET / -> HTML shell; <link rel=alternate> and <noscript> pointed to /llms.txt.
2. GET /.well-known/agent-card.json -> valid card (A2A 0.3.0, JSONRPC, url /a2a, bearer "player" scheme, one data part {"action":...}). /.well-known/agent.json -> 404 with a helpful "start at /llms.txt".
3. GET /llms.txt -> demo-account flow, tool list, rules. No guessing needed.
4. POST /api/auth/demo {"name":"Ola"} -> cookie, user u_209a871b80. POST /api/tokens scopes ["read","negotiate"] (no pay) -> token tok_a26dc3e7.

## Steps (all via A2A message/send, data part)
- whoami: limits perGame 15.00, perWeek 40.00, guaranteeOnItsOwn 60.00, autopay false, no saved PayPal. Mandate JWTs returned.
- list_activities: board games 120/180 min, 2-8 people; escape room 60 min, 2-6.
- find_options board games, Sun 2026-11-01, people 4: one option, Dice & Co 11:00, 120 min, ask 28.80, share 7.20, youCanSpend 15.00, 4.0 stars (13 demo reviews). Escape room Sun, people 4 and 3: none ("Nothing fits").
- list_venues escape room: Lockbox, 32.00/person, weekendOpen null, 4+ people 10% group discount.
- venue_reviews dice: 4.0, praise food/staff, complaint "cramped" (6). Quotes labelled untrusted data.
- start_negotiation dice (neg_fa79a2d6c072): list 32.00, ask 28.80 (group 10%), share 7.20 each, 3 rounds left, expires ~15 min. ifYouAccept: guarantee 28.80, yourShare 7.20, worstCase 28.80, "your person guarantees it on Join (this agent may not pay)".
- start_negotiation lockbox Sun 14:00 (neg_ad19c00b4c98): list 128.00, ask 115.20, share 28.80, overBudget true, alternatives [], worstCase 115.20.
- find_alternatives board games budget 15: none.
- walk_away on both: status cancelled. Nothing accepted, no offers made, nothing paid, account settings untouched.

## Worst case for Ola (as the site states it)
Board games at Dice & Co, Sun 1 Nov 11:00-13:00: ask $28.80 total; Ola's own share $7.20; as organizer she guarantees the whole $28.80 by PayPal authorization and pays up to $28.80 if the others don't pay. Not accepted. Escape room (Lockbox, $115.20 total, $28.80 each) is over her $15 per-game limit; not pursued.

## Findings
- CONFUSING: players semantics. find_options with people:4 returned players ["u_209a871b80","you","ravi","priya"] / names "Alex Rivera", etc. A literal "you" id is a placeholder friend; the person's real three friends are unknown, and the plan silently assumes made-up demo friends. Sent players ["you","ravi","priya"] and the negotiation accepted them.
- CONFUSING: worst case ($28.80) exceeds the person's perGame limit ($15) in guarantee terms though the share ($7.20) fits; the site only flags this as overBudget on the escape room, not on the board-game one. Guarantee limit (60) is what applies.
- CONFUSING/possible BUG: list_venues shows Lockbox "weekendOpen": null, yet a Sunday 14:00 negotiation was opened without any warning. Unclear whether null means closed or same hours.
- CONFUSING: agent card skills list only some actions (whoami, list_activities, list_venues, find_options, venue_reviews, my_plans not named); they work anyway. Card says "..." for the action list.
- MINOR: unknown action returns JSON-RPC error -32602 that lists every valid action (good). Missing mandate -> {"error":"mandate_required", message says where to get it} (good). Wrong scope -> {"error":"scope", ...person chose scopes on website (Connect)} : tells the cause but not what the agent should do (ask the person to make a new token); errors are in-result data, not JSON-RPC errors, so a client checking only `error` misses them.
- MINOR: unauthenticated /a2a -> -32001 "send a player's agent token as Authorization: Bearer join_..." (clear).
- Parity: MCP tools/list has the same 18 tools as the A2A action list. Did not test pay/offer/accept (out of scope, no pay scope, not wanted).

## Claims that were not true
None found. Did not verify that discounts, 70% rule, or receipts behave as claimed (no offers made).

VERDICT: 0 BLOCKER, 0 BUG, 4 CONFUSING

# mei-agent report (persona: Mei's agent, REST over HTTP, no MCP client needed)

## Steps
1. GET / : SPA HTML only. No <link rel> / meta pointing to /llms.txt, agent card or MCP. I guessed /llms.txt (worked), /.well-known/agent-card.json (worked), /.well-known/mcp.json (returns the SPA HTML with 200, soft 404).
2. /llms.txt gave everything: demo account -> token -> Bearer. POST /api/auth/demo {"name":"Mei"} then POST /api/tokens (scopes read, negotiate; NOT pay) worked first try.
3. whoami, list_activities, list_venues, find_options (karaoke, hot pot), venue_reviews echo, tools/list over /mcp for exact schemas.
4. start_negotiation Echo Karaoke Sat 2026-10-31 20:00, 120 min (4 people): ask 64.80 (16.20 each, overBudget:true). Offered 50 -> counter 58.80; offered 52 -> counter 52.80 (13.20 each). accept_price -> booking bk_95b15ae84896. Did not call pay_my_share (token has no pay scope anyway).
5. Hot pot rejected: Westgate Hot Pot House ask 100.80 for 4 = 25.20 each, over both $20 and the $15 mandate.
No MCP script written; nothing to delete.

## Plan outcome
Karaoke, Echo, Sat Oct 31 20:00-22:00, room 1, total $52.80, $13.20 each, with Alex Rivera ("you"), Hana Chen, Tomas Ruiz (all invited, not yet confirmed). Reviews 4.3/21 (atmosphere, equipment good; noisy). Mei still has to approve/guarantee; friends' agents must pay_my_share.

## Findings
- BUG/CONFUSING (important): after accept_price alone, with a token that has NO pay scope and no ask to Mei, booking_status shows the organizer payment already `authorized` $52.80 via "sandbox test card", with a real PayPal order and authorization id (8GS835635T471951W / 19066653EN433141T), state `held`, payBy ~20 min. my_plans first showed "creating" then it flipped. So a $52.80 hold was placed on acceptance, no pay_my_share. Contradicts "Don't pay anything without asking me", and tool text says organizer must call pay_my_share within 10 minutes. The accept_price description doesn't say a sandbox card is auto-used. Expected: stay awaiting_organizer until pay_my_share/approveUrl.
- CONFUSING: Mei told me $20 each; her website mandate is perGame $15 / perWeek $40. find_options shows "youCanSpend":"15.00". Fine to be stricter, but nothing says which limit wins, and the 120-min karaoke share only fit after haggling.
- CONFUSING: find_options ignores/does not honor my `date` filter (returned Fri Oct 30 and Sun Nov 1 options as well); no documented params in llms.txt. Options are all 60 min (karaoke) / 90 min even though I wanted an evening; "share 8.10" for 60 min looks cheap, 120 min is a different price.
- CONFUSING: a built-in resident has player id "you" and name "Alex Rivera"; start_negotiation players ids are only discoverable from find_options (names list vs ids). Using "alex" gave `bad_players: players must be known player ids, 12 at most.` (doesn't say where to get ids).
- CONFUSING: venue complaints label mismatch: find_options reviews complaints ["quiet"] but the reason text says "noisy (8)". Hot pot complaints ["ontime","quiet"] vs "waiting to start","noisy".
- CONFUSING: make_offer with "amount":"52.00" (string) -> `bad_amount: amount is the total for the booking in USD, e.g. 30 or 31.5.` Doesn't say it must be a JSON number; REST param names (negotiation, not id) only discoverable via MCP tools/list. llms.txt doesn't list parameters for REST.
- MINOR: unauthenticated call gives a clear 401 with how to fix. Scope error for pay is clear ("its person chose its scopes on the website (Connect)").
- MINOR: /.well-known/mcp.json returns SPA HTML with 200. Landing page has no machine-readable pointer to /llms.txt.
- MINOR: list_venues `weekendOpen:null` for most venues is ambiguous (closed on weekends, or same hours?). Echo accepted a Saturday booking, so it means same hours.
- MINOR: llms.txt says "agents: pass mandate on offers/accepts/payments"; true, and the make_offer error order is OK. A stale first start_negotiation call after my failed second attempt: no leftover, fine.
- Good: llms.txt was accurate and enough to get from address to a token in 2 calls; negotiation rules (70% floor, rounds) were as documented; reviews flagged as untrusted data.

VERDICT: 0 BLOCKER, 1 BUG, 5 CONFUSING

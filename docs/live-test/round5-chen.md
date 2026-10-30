# chen report

## Steps
1. GET /j/c-2d1e63d2 (no Accept) -> 302 to /#/?crew=...; with Accept: application/json -> 200 JSON with agent pass (bearer, mcp address, a2a URL), members Ana and Bo, firstStep "whoami, then my_plans". No account, signup, sign-in or password was asked for or given.
2. GET /.well-known/agent-card.json -> A2A card (JSONRPC, url /a2a, bearer). GET /llms.txt -> guide. I used the REST route (POST /api/agent/<tool>, Bearer pass, X-Join-Name: Chen) rather than A2A or MCP.
3. whoami -> Chen (u_62675e124f), limits perGame 15, perWeek 40, guarantee 60; yourPersonsLink.path = /me/<pass> (Chen's way in, handed over in my final message); AP2 mandates.
4. my_plans polled about 10 minutes: empty, then booking bk_d95987b4ed9f (Dice & Co board games, 2026-10-31 15:00, 2h, total 22.00, organizer Ana, players Ana, Bo, Chen). Chen invited, share 7.33, payBy 18:58Z.
5. propose_share {booking, amount 6.33} -> "Asked to pay $6.33 instead of $7.33. Waiting for Ana...". About 20s later Ana accepted: share became 6.33, Ana covers the $1.00 (her share 8.34).
6. pay_my_share {booking, mandate, amount: 7.33} -> booking locked; Chen captured 6.33 (not 7.33). The extra "amount" argument was silently ignored.

## Outcome
Plan: Ana, Bo, Chen, locked. Paid: Ana 8.34, Bo 7.33, Chen 6.33 (sandbox). Chen's instruction "whatever she says, then pay my share" (7.33) was NOT met: he paid 6.33, so Ana is out $1 and Chen got the discount he said he would pay back anyway.

## Findings
- BLOCKER: after an accepted propose_share, pay_my_share cannot pay the original share. Request: POST /api/agent/pay_my_share {"booking":"bk_d95987b4ed9f","mandate":"<open payment mandate>","amount":7.33} -> captured 6.33, no error, no warning that "amount" was ignored. The only way to honour "pay my full share" would have been to not pay (or not ask) at all; the person's intent can't be expressed once the ask is accepted. Also the payment is immediate and irreversible, so there is no chance to notice. Suggest: accept an amount at least equal to the share, or a way to withdraw an accepted change, and reject unknown arguments.
- CONFUSING: propose_share's reply says "paying before that pays whatever share then stands", which is the right hint, but the acceptance came within about 20s with no notification; an agent polling slowly could pay at the lowered share by accident. A "waiting" step (check shareAsks status before paying) is needed and should be documented in the typical plan.
- CONFUSING: the link gives a single pass that is also Chen's sign-in (/me/<pass>); fine, but whoami calls it private like a password while agent.bearer is the same string, so anything that logs the bearer exposes Chen's account.
- MINOR: the invite link without Accept: application/json redirects to the SPA, which an agent may mistake for the answer; the JSON content negotiation is only described in llms.txt.
- MINOR: the A2A endpoint answers GET with an HTML "Cannot GET /a2a"; fine for JSON-RPC but unhelpful when probed.

VERDICT: 1 BLOCKER, 0 BUG, 2 CONFUSING

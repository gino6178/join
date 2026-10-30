# bo report
Steps:
1. GET /j/c-2d1e63d2 (no Accept) -> 302 to SPA; with Accept: application/json -> JSON pass (bearer, mcp, rest, a2a), members ["Ana"]. Read /llms.txt.
2. POST /api/agent/whoami with bearer + X-Join-Name: Bo -> Bo added to crew; mandate perGame 15, perWeek 40, autopay false. No account, sign-up, sign-in or password was requested; none given.
3. my_plans empty; polled ~10 min. Then booking bk_d95987b4ed9f appeared: Dice & Co Board Game Cafe, board games, 2026-10-31 15:00, 120 min, total 22.00, organizer Ana, players Ana, Bo, u_62675e124f; Bo's invite share 7.33 (<= $12, within $15 mandate).
4. pay_my_share (booking + openPaymentMandate) -> Bo's payment "authorized" 7.33, sandbox test card, no approveUrl.
5. booking_status later: state locked; all captured. Bo captured 7.33 (capture 0CS33577L7155460S).
Outcome: Ana 8.34, Bo 7.33, third player 6.33 (total 22.00).
Findings:
- CONFUSING: shares shown at invite time were 7.34/7.33/7.33, but after lock they are 8.34/7.33/6.33 (sum still 22.00) with no shareChanges visible to me; I did not see why. Bo's share unchanged.
- CONFUSING: no notification of invitation; had to poll my_plans.
- MINOR: invite share was only in invite.share; pay_my_share is Bo's "yes", worked fine.
VERDICT: 0 BLOCKER, 0 BUG, 2 CONFUSING

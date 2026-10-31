# chen report

## What I did
- Read /llms.txt (the only doc). Used the token in chen-token.json via REST POST /api/agent/<tool> (token never printed).
- whoami: Chen, area "台北市 捷運忠孝復興站", mandate perGame 15.00, perWeek 40.00, guarantee 60.00. No crew. Not asked to sign up or sign in.
- my_plans (empty), then wait_for_news (long-poll) about 10 times over about 4 minutes.

## What happened
- Ana's agent opened a karaoke negotiation at Join 測試 KTV（沙盒） (neg_bd43b3a8cd99) for Ana, Bo, Chen: ask $60 ($20 each). Counters $58, $56, $54 "best and final" ($18 each). All over Chen's $15 limit; I did not act. Ana walked away.
- Ana's agent reopened (neg_8c5d8a5d68b8): $30 total, $10 each, 15:00 same day. Ana guaranteed $30 via PayPal sandbox; Chen was invited (bk_a9c982f5ff1c, share $10.00 <= $15).
- pay_my_share with the open payment mandate: state "locked", Chen paid $10.00 (captured, sandbox test card). Ana paid $10, Bo paid $10. Receipt rcpt_929b477e316baf10 (event locked). Total $30.
- Places offered: only one, Join 測試 KTV（沙盒） (on Join, room 1). I never called find_options, so no OSM places or distances were seen.

## Who and how found (for Chen)
- Organizer: Ana. Other player: Bo. Both are real accounts on the server and Chen did not name them; Chen had no crew, so the match was "nearby" (he set 忠孝復興站 and opted in to nearby invitations). 
- The server never says how Chen was found: no field in the invite, booking_status or news names the reason (nearby/interest/distance). I infer nearby + shared karaoke interest from llms.txt.

## Findings
- CONFUSING: no "found you via ..." info in the invitation. Exact request: POST /api/agent/my_plans and booking_status bk_a9c982f5ff1c; invite = {"share":"10.00","payBy":...}, no match reason or distance. Chen asked how he was found.
- CONFUSING: negotiation neg_8c5d8a5d68b8 listed minutes 120 in the first negotiation but the booking says minutes 60 at $30; and the held-room news says "held until 10:00" while payBy is 02:00Z (=10:00 local, fine) but the "10 minutes" hold text vs payBy 20 minutes after guarantee. Minor timing inconsistency in wording.
- MINOR: the invite showed a venue name with "（沙盒）" (sandbox) and a "Join 測試" name; nothing looked made up beyond that sandbox nature. Ana and Bo were not verifiable as separate real people from my side.
- MINOR: invitation arrives only as a news item and my_plans; no push, fine with wait_for_news. Repeating wait_for_news with the same "after" returns the same item (expected).

VERDICT: 0 BLOCKER, 0 BUG, 2 CONFUSING

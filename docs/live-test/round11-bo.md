# Report: bo (Bo's agent)

## What I did
1. Opened the invite http://192.168.31.145:8799/j/c-db500e1b with Accept: application/json. Got an agent pass (token redacted here). Did not read Join's source.
2. whoami as Bo (X-Join-Name: Bo). Crew: Anna only. Bo's limits: $15 per game, $40 per week. PayPal sandbox, token may pay.
3. set_home "科技大樓站" (Bo gave this place; I did not ask first). Join rounded it to about 1 km and said others see only the place name.
4. find_options for badminton on 2026-11-01 found a Sunday option with Anna (sandbox court, $10 share). No invite came for it, so I did not act on it.
5. wait_for_news: after about 1 minute Anna's agent opened a karaoke negotiation (Join 測試 KTV, 2026-11-01 13:00, 60 min, $30 ask = $10 each, for Anna, Bo and Chen-Wei). Join listed Chen-Wei as a player.
6. Waited. Anna's agent accepted $30 at 12:37 Taipei time. Join then sent Bo an invitation: share $10.00, join or decline by 12:57 Taipei time, "You're in Anna's crew".
7. pay_my_share on bk_a39ea9a62766 with Bo's AP2 open payment mandate (no amount passed). Result: $10.00 authorized with the sandbox test card. Bo's share was captured when the booking locked.
8. Booking locked at 12:38 Taipei time: all three paid, $30.00 total. Receipt rcpt_2b35c143bd02526b issued (event "locked").
9. Deleted my temporary scripts. Did not sign up or sign in. No "pay" scope issues.

## Answers for Bo
- Where: Join 測試 KTV（沙盒）, 臺北市 大安區 忠孝東路四段 (no street number; OSM map: https://www.openstreetmap.org/?mlat=25.0418&mlon=121.544#map=17/25.0418/121.544). Room 1, 2026-11-01 13:00-14:00 Taipei time.
- How far for Bo: 1.4 km, about 9 minutes (Join's figure from the home place 科技大樓站).
- Who else: Anna (organizer, in Bo's crew, Join says real person, identity not checked) and Chen-Wei (lives about 1.1 km from Anna, opted in to be invited by nearby people; Join says real person, identity not checked). Join's note: trust them like a friend's group chat. Nobody's identity was verified.
- Pay by: 2026-10-31 12:57 Taipei time. Paid at 12:38, well before. Bo's share: $10.00 (even split).

## Unclear
- "pay_my_share" response: "status":"authorized", "paid":"0.00" under "you", statusMeans "held, not taken yet". I passed the call expecting a payment. I guessed authorization is the payment and it was captured at lock (confirmed later in booking_status: captured 10.00). Wording says "paid" in the lock news only.
- Two deadlines: the negotiation's expiresAt (12:44 Taipei) and the invite's payBy (12:57). I guessed the invite's 12:57 governed Bo's payment. It did.
- Venue name "Join 測試 KTV（沙盒）" literally says test/sandbox. The brief says venues are real. I guessed it is a sandbox stand-in for a real venue. Join gives no street number, only the district and a map link.
- Chen-Wei's presence: first appeared only inside Anna's negotiation (players list). I could not see how Chen-Wei was matched beyond the "chose to be invited by people nearby" line. Guessed it is the nearby-opt-in path.
- Cent difference between shares (the previous round's confusion, item 1): NOT SEEN. Shares were even at $10.00 each (split "even"), so no cent difference arose and none was explained.
- Whether Bo's home (set_home) change needed Bo's consent: I set it because Bo named the place. Join only said "kept rounded to about a kilometre".

## Last round's confusions
1. Cent difference between shares, explained only in booking status: NOT SEEN (no cent difference in this booking; even split, $10.00 each).

## Findings
- CONFUSING: pay_my_share returns "authorized" with "paid":"0.00", while the lock news says "paid". Exact request: pay_my_share {booking: bk_a39ea9a62766, mandate: <AP2>}. Suggest one plain sentence: "Your $10.00 is held and is taken when the booking locks."
- CONFUSING: venue name contains 測試 and 沙盒 (test, sandbox) while Join describes venues as real. Exact field: venueName in find_options and booking_status.
- CONFUSING: no street number for the venue (addressNote). Only the map link gives a location.
- MINOR: two different deadlines (expiresAt 12:44 and payBy 12:57) with no note on which one applies to a friend.
- MINOR: the invitation came as a news line via wait_for_news, not in my_plans at first; my_plans showed only the negotiation until Anna's agent accepted the price.

VERDICT: 0 BLOCKER, 0 BUG, 3 CONFUSING

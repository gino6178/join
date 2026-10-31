# chen (Chen-Wei's agent) - Round 9

## What I did
1. GET /llms.txt, then POST /api/agent/whoami, my_plans, wait_for_news (REST, Bearer token, never printed).
   whoami: Chen-Wei, home 台北市 捷運忠孝復興站, matching.invitedByPeopleNearby=true, peopleNearbyWhoOptedIn=4, withinKm=8,
   crewSize=0, mandate perGame 15.00 / perWeek 40.00, canYouPay yes. Nothing planned yet.
2. wait_for_news (50 s waits). After ~2.5 min: news 2 "Anna's agent asked Join 測試 KTV（沙盒） for a room for karaoke on
   2026-11-01 11:00 for Anna, Bo, Chen-Wei. Venue asks $30.00 ($10.00 each)." Then 3 (Anna offered 21, venue countered 29),
   4/5 (place held, deal at $29.00), 6/7 (Anna's $29 guarantee authorized), 9 "invited".
3. Invitation: karaoke, share $9.66, room 1 at Join 測試 KTV（沙盒）, 0.5 km / about 7 min, from Anna, who lives about
   1.1 km from Chen-Wei. Fits the rule (karaoke, <= $15, near) so I did my_plans + booking_status, then pay_my_share
   (booking bk_230082d7bd2a, mandate from whoami.ap2.openPaymentMandate).
4. pay_my_share answered state "locked": all three captured. Anna 9.68 (organizer), Bo 9.66, Chen-Wei 9.66 = 29.00.
   Receipt rcpt_ea4cfdd1cc3f3f4c (event locked). Chen-Wei paid $9.66 (sandbox test card, capture 2US75720CD444862D).

## For Chen-Wei: the answer
- Who: Anna (organizer, signed up on Join, lives about 1.1 km from Chen-Wei) and Bo (in Anna's crew, joined from a friend's invite link). Booked: karaoke, 2026-11-01 11:00, 60 min.
- Real people? The server says Anna "a person who signed up on Join (demo account: no outside login, sandbox money)" and Bo "a
  person who joined from a friend's invite link (their agent, no outside login)". Join says "Nobody is made up", but I could
  only see they are real accounts on Join, not verified humans (they are demo accounts, they ran through agents, and Anna's
  agent acted within seconds).
- How found: Anna lives about 1.1 km from you, likes karaoke, and you chose to be invited by people near you.
- Where: Join 測試 KTV（沙盒）, 臺北市 大安區 忠孝東路四段 (no street number; map https://www.openstreetmap.org/?mlat=25.0418&mlon=121.544#map=17/25.0418/121.544), room 1. 0.5 km, about 7 min from you.
- Paid: $9.66 (within the $15 limit, week total $9.66 of $40).

## Places
Only the one the organizer chose (on Join, KTV sandbox venue). I did not call find_options (not my plan; I was only invited). No non-Join places were shown.

## Anything made up?
Nothing looked fabricated. Caveat above: "real person" is only established as "account on Join".
Was I asked to sign up or sign in? No. Token worked straight away.

## Last round's confusions
1. Are the others real people? STILL UNCLEAR (partly improved). booking_status.people[].account now says what kind of account,
   but both are demo accounts ("no outside login, sandbox money"); it never says a human is behind them.
2. people[] for himself says only "you", not how found? CLEAR NOW. people[] self entry is still {"how":"you"}, but the booking
   has a top-level howYouWereFound and invite.why with the answer, and the invited news item says it too.
3. "invited" news item had no distance/address/why? CLEAR NOW. News 9 had distance (0.5 km, about 7 min), share, deadline, and why (1.1 km from Anna, chose to be invited). Address was not in the news but in booking_status.where.
4. After locking, nextStep said "nothing is captured before it locks"? CLEAR NOW. The locked answer's nextStep: "It's locked: everyone's payment is captured (PayPal) and the receipt is issued; nothing more to do."
5. serverTime UTC next to local? CLEAR NOW. wait_for_news returns serverTime and serverTimeLocal ("2026-10-31 11:30"); news has at and atLocal.

## Unclear (things I had to guess about)
- people[].account on whoever is not me: "demo account" - I guessed it means a real person using a test sign-up, not a bot. Request: booking_status bk_230082d7bd2a.
- Anna's share is 9.68 and others 9.66 (total 29.00). Guessed rounding cent goes to the organizer; no field says so (shares / split:"even").
- Bo's "how": "in the organizer's crew" while my crewSize is 0 and I'm not in the crew. Guessed Bo is Anna's crew, I am a nearby invitee (consistent with howYouWereFound). Fine, but people[].how for me ("you") gives no such label.
- After locking, stateMeans says "The venue is paid after the game." The game is the next day; I guessed no money goes to the venue yet. (payout: null.)
- News ids skip (1, 8, 10, 13); guessed they belong to other people's feeds. Request: wait_for_news after 0.
- "heldUntil 11:50": the invitation said join by 11:50; I did not need it as I paid at once.
- whoami.mandate.autopay false vs canYouPay "yes: ... authorized with PayPal's test card" - I guessed the sandbox pays itself with the test card; pay_my_share worked with no approveUrl.

## Findings
- CONFUSING: people[] for the caller says {"how":"you"} (booking_status) - the how-found text is elsewhere (howYouWereFound, invite.why). Put it on the people entry too, or on the one that mentions "nearby".
- CONFUSING: "Real people?" is answered only by an account-type string; there is no field saying a human verified/ confirmed.
- MINOR: invited news lacks the venue address (only distance); booking_status has it.
- MINOR: 9.68 vs 9.66 split not explained.
- MINOR: stateMeans "venue is paid after the game" with payout null.

VERDICT: 0 BLOCKER, 0 BUG, 2 CONFUSING

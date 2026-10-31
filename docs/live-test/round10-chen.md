# chen report (Chen-Wei's agent, round 10)

## What I did
- Read /llms.txt (no source code). POST /api/agent/whoami with Chen-Wei's token: home 台北市 捷運忠孝復興站, invitedByPeopleNearby true, peopleNearbyWhoOptedIn 5, crewSize 0, mandate perGame 15.00 / perWeek 40.00, token may pay. Not asked to sign up or sign in at any point (token only).
- my_plans: empty. wait_for_news x several (50 s each), started 12:02 Taipei.
- 12:04-12:05 news: Anna's agent opened neg_b9fd5200dcd6 with Join 測試 KTV（沙盒） (karaoke, 2026-11-01 11:00, 60 min, Anna+Bo+Chen-Wei, ask $30, offers 21 -> countered 29, 25 -> countered 28, accepted $28). Anna guaranteed $28 in PayPal (sandbox test card); room 1 held; invite for me id 12 at 12:05: share $9.33, 0.5 km / about 7 min, why "You live about 1.1 km from Anna, like karaoke, and chose to be invited by people near you."
- $9.33 <= $15, karaoke, within weekly 40: called pay_my_share {booking: bk_a4076d3832ec, mandate: ap2.openPaymentMandate}. Answer 200: booking body, my status authorized ($9.33, sandbox test card). Bo joined/authorized $9.33 seconds later; news 19: "locked: $28.00 paid (everyone paid)". Final booking_status: state locked; Anna paid 9.34, Bo 9.33, Chen-Wei 9.33, all captured; receipt rcpt_8ed9e08853edf5e6 (event locked, batch null yet); payout null.

## Result for Chen-Wei
- Who: Anna (organizer, found me via nearby opt-in, lives ~1.1 km from me) and Bo (in Anna's crew). Both realPerson: true, signed up on Join with name and area (Bo via friend's invite link), identityChecked false ("trust as a friend's group chat").
- How found: nearby opt-in, not crew (crewSize 0).
- Where: Join 測試 KTV（沙盒）, room 1, 臺北市 大安區 忠孝東路四段 (no street number; map https://www.openstreetmap.org/?mlat=25.0418&mlon=121.544#map=17/25.0418/121.544). 0.5 km, about 7 min from him. On Join (bookable venue). No other places were offered to me (I never ran find_options; I was the invitee).
- Time: 2026-11-01 11:00, 60 min. Paid: Chen-Wei $9.33 (captured), Anna $9.34, Bo $9.33; total $28.00.
- Nothing looked made up. Venue name says sandbox; money is sandbox.

## Last round's confusions
1. Whether others are real people: CLEAR NOW. people[] has realPerson: true, identityChecked: false, an account description per person and a note that Join doesn't verify identity.
2. His own entry in people[] said only "you": CLEAR NOW. His entry says how: "you: <why found>", member true, account text; top-level "you" object shows share/paid/status once I'd paid (it is null before paying, which was only mildly odd).
3. Organizer share differs by cents: CLEAR NOW. splitNote: even split in cents, organizer takes the odd cents (9.34 vs 9.33). Also visible in the deal news ("Anna's own share is $9.34").
4. Locked state said "venue is paid after the game" while payout null: CLEAR NOW. stateMeans: "After the game ends, Join pays the venue through PayPal Payouts (payout stays null until then)."

## Unclear (guesses I had to make)
- wait_for_news {after:N}: if after is below the latest id it returns immediately with the old items (I passed a stale after by my own mistake and got repeats). Guessed after must be the last returned "last". Fine, but not stated that stale values just replay.
- News ids skip (11 and 16 never appeared to me). Guessed they were events for other people. Not explained.
- Two distances in one invite: "0.5 km, about 7 min for you" (to the venue) vs "about 1.1 km from Anna" (to the organizer). Guessed trip vs person distance; understandable but easy to mix up.
- pay_my_share returned the whole booking body with my status "authorized", not "paid"; it became captured only when the booking locked seconds later. Guessed authorized = held, captured at lock (statusMeans says so). Clear enough.
- Top-level "you" is null in my_plans before paying and only filled in booking_status/after; guessed null = nothing of mine yet.
- Receipt batch: null right after lock (docs say batches every 2 min); did not check the receipt itself.
- Otherwise nothing unclear.

## Findings
- MINOR: news id gaps (see above).
- MINOR: stale `after` replays old news silently (request: wait_for_news {"after":5} when last was 8).
- MINOR: "you" null in my_plans bookings while invited (request: my_plans).
- No BLOCKER, no BUG.

VERDICT: 0 BLOCKER, 0 BUG, 0 CONFUSING

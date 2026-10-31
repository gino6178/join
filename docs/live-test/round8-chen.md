# chen report (Chen-Wei's agent)

## What I did
- Read /llms.txt, then POST /api/agent/whoami with Chen-Wei's token (never printed). Town time 11:00 Taipei. matching: invitedByPeopleNearby true, peopleNearbyWhoOptedIn 3, withinKm 8, crewSize 0. mandate perGame 15.00, perWeek 40.00, autopay false; canYouPay "yes: your token may pay".
- POST wait_for_news {} then {after}; it returned within seconds when news existed, ~45 s when quiet. Watched about 20 min (11:00 to ~11:20 Taipei).
- 11:01 negotiation_opened: Anna's agent asked Join 測試 KTV（沙盒） for karaoke 2026-10-31 18:30, 60 min, for Anna, Bo, Chen-Wei; ask $30 ($10 each). Anna offered 21, venue countered 29 then 28. 11:02 Anna accepted $28; Anna guaranteed the whole $28 in PayPal sandbox; room 1 held.
- 11:02 invited (bk_8aa4eff9da81): share $9.33, join/decline by 11:22. invite.why: "You live about 1.1 km from Anna, like karaoke, and chose to be invited by people near you."
- Check against Chen-Wei's rule: karaoke yes, $9.33 <= $15 yes, organizer lives near yes, venue on Join (v_47168dbea5), address 臺北市 大安區 忠孝東路四段, 0.5 km / 7 min from him. Under perGame 15 and perWeek 40. So I called pay_my_share {booking, mandate: ap2.openPaymentMandate}.
- Result: HTTP 200, my status captured $9.33 (sandbox test card). Bo had joined and paid first ($9.33), Anna $9.34. Booking state locked at 11:02, total $28.00, receipt rcpt_d67f35ce919cc2fa (GET /api/receipts/<id> works, hash and body returned).
- No other invitations (board games or anything) arrived through ~11:20. my_plans afterwards: only the one locked booking.

## Who / how matched
- Anna: organizer, "the organizer"; found Chen-Wei because he lives ~1.1 km from her, likes karaoke and opted into nearby invitations (not crew; crewSize 0).
- Bo: "in the organizer's crew" (Anna's crew).
- Chen-Wei: people[].how says just "you".
- Place: on Join, real-looking name, with address, map link, trip 0.5 km / 7 min. No OSM-only places were offered to me (I did not run find_options; I was the invitee).
- Paid: Anna 9.34, Bo 9.33, Chen-Wei 9.33 = 28.00.

## Anything made up?
Nothing obviously fake: llms.txt says nobody is made up, but I cannot tell from the answers whether Anna and Bo are real people or demo/test accounts. Venue is named "（沙盒）" (sandbox). Anna's negotiation, her guarantee and Bo's payment happened within ~30 seconds, which looks scripted/automated. Not asked to sign up or sign in at any point (the token was enough).

## Last round's confusions
1. whoami did not show whether he can be found / how many: CLEAR NOW. whoami.matching shows invitedByPeopleNearby true, peopleNearbyWhoOptedIn 3, withinKm 8 and a plain note.
2. wait_for_news silent, no hint why, no server time: CLEAR NOW. Quiet replies carry serverTime and a note that quiet can mean nobody has planned anything and to see whoami matching. (Small leftover: the note does not say how long the wait lasted; I measured ~45 s.)
3. "autopay: false" next to a token that may pay: CLEAR NOW. paypal.canYouPay explains: sandbox pays with the test card; with a real person they approve it in PayPal; autopay off = PayPal not saved for the agent. Payment worked without any approval step.
4. Why he was invited: CLEAR NOW. invite.why gave distance, activity and the opt-in. (But see Unclear: it is only in my_plans invite, not in the news item.)
5. Whether the others are real people: STILL UNCLEAR. people[] shows member:true and how, nothing says real person vs demo account.

## Unclear (things I had to guess)
- people[] for myself: `"how": "you"` does not say how I was found; the answer is only in invite.why. Guessed to read invite.why.
- Bo was "in the organizer's crew" while whoami said my crewSize 0; I guessed Bo is Anna's crew, I am not, and I am the only "nearby" invitee.
- news "invited" summary (id 11, wait_for_news) says "Your share is $9.33. Join or decline by 11:22" but no distance, no venue address, no why. I had to call my_plans for those.
- news ids are not contiguous for me (jumps 12,13,15,16; 9->11): guessed other ids belong to other people's events. Using `after: last` still worked.
- `serverTime` is UTC ("...03:01Z") while atLocal and whoami town.now are Taipei (+8). Guessed they are the same clock.
- booking_status/pay_my_share nextStep after lock: "The booking locks when everyone invited has paid, or at payBy ... nothing is captured before it locks." This was shown on an already locked booking, with capture ids present; stale/confusing.
- news id 18 "Chen-Wei's agent checked the payment: captured" (action pay_requested) came after "locked"; the action name suggests a payment request, summary says a check. Guessed it is just a log of my pay_my_share call.
- invite.payBy 11:22 vs guaranteeBy 11:12 etc: fine, but "Join or decline by 11:22" vs pay: guessed joining and paying are one step (pay_my_share), which was right.
- Distance: invite.why says 1.1 km (to Anna's home, rounded ~1 km), where.yourTrip says 0.5 km (to venue). Both are right but two different distances; I guessed which is which from wording.
- whoami "peopleNearbyWhoOptedIn: 3": did not know whether that includes Anna/Bo (guessed yes).
- Chen-Wei's rule said "$15 or less": I took it per person share ($9.33). The total was $28. Guessed share; mandate perGame is also per share.

## Findings
- CONFUSING: Cannot tell real people from demo/test accounts (whoami.matching, my_plans.people). Request: POST /api/agent/my_plans.
- CONFUSING: `people[].how: "you"` hides how I was found; only invite.why says it, and invite disappears (null) once locked (pay_my_share response: "invite": null). After paying, the "who found you, how far" answer is gone from booking data except by remembering. Request: pay_my_share / my_plans after lock.
- CONFUSING: stale nextStep text on a locked booking (see Unclear). Request: POST /api/agent/pay_my_share.
- MINOR: news "invited" lacks where/distance/why; serverTime UTC vs atLocal Taipei; non-contiguous news ids; quiet wait_for_news does not say its wait length.

VERDICT: 0 BLOCKER, 0 BUG, 3 CONFUSING

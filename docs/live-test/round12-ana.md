# ana report, round 12 (Anna's karaoke plan)

## What I did
- Read the brief. Did not read Join's source. Used only the server's /llms.txt and its answers.
- Used Anna's token from ana-token.json (not printed). Called whoami, list_venues, my_plans, wait_for_news, find_options, start_negotiation, make_offer, accept_price, pay_my_share, booking_status, all via REST /api/agent/<tool>.
- Did not sign up or sign in. Used the token as given.
- Waited for Bo: polled whoami and wait_for_news up to 8 min. Bo joined the crew within the first poll window (crew size 2).
- Gave nearby people about 2 minutes, then searched 2026-10-31 and 2026-11-01. Chen-Wei appeared as a third player.
- Booked: Sunday 2026-11-01 19:00, 60 minutes, one room, Join 測試 KTV（沙盒）. Anna, Bo, Chen-Wei.
- Locked: booking bk_4886cdb0d2f2 is locked. All three shares were captured.

## Who was in the plan and how matched
- Anna (organizer): her own account, home 台北市 捷運大安站.
- Bo: in Anna's crew (area 科技大樓站). Matched by crew.
- Chen-Wei: named as "lives about 1.1 km from the organizer and chose to be invited by people nearby". Matched by nearby opt-in. The find_options result itself did not say why Chen-Wei was there (see CONFUSING 3).

## Places offered
On Join (bookable, priced):
- Join 測試 KTV（沙盒）, 臺北市 大安區 忠孝東路四段. Test venue (sandbox). Rooms 2-10 people, $30 per room per hour, 60 min minimum. Trip for Anna 9 min, 1.4 km. Group discount only at 4+. No reviews. This is the one I booked.

Not on Join (OpenStreetMap, suggested only, no price, no booking through Join):
- 錢櫃 KTV, 忠孝東路四段26巷. Trip for the longest-travelling person 9 min. https://www.openstreetmap.org/node/3304395602
- 錢櫃Partyworld, 205 敦化南路一段. 11 min. https://www.openstreetmap.org/node/6205090597
- 錢櫃KTV-松江店, 199 松江路. 14 min. https://www.openstreetmap.org/way/358340648
Their prices and hours are unknown from Join. Anna would have to ask them directly. I did not check them.

## Why this option
- Cheapest real option near Anna: $30 ask, which is $10 each for three. Venue countered my $25 offer at $29 (now $9.67 average each, $9.68 Anna, $9.66 others). I accepted $29.
- 9 min trip for everyone (the longest trip is 9 min). The 錢櫃 at 26巷 is about as close and not bookable on Join.
- Sunday 19:00 was in Anna's usual free time (Sun 08-22). I did not pick today (Sat 31 Oct) because it was too soon for friends to answer.

## How it ended and what each paid
- Anna: $9.68 captured.
- Bo: $9.66 captured.
- Chen-Wei: $9.66 captured.
- Total $29.00. State locked. Receipt rcpt_4ce37c6741103dab issued.
- Worst case I reported to Anna: $29. If the others did not pay, she would cover up to $29 as organizer. That is above her $15 per-game limit, but Join allowed it as a group guarantee ($60 limit). She had said $15 each at most and that I could pay the guarantee, so I went ahead.

## Was anything made up?
- Bo and Chen-Wei: the server says realPerson true, identityChecked false.
- The Join venue is labeled sandbox/test (沙盒). Expected.
- The 錢櫃 places are real OpenStreetMap entries. I did not verify their hours or prices.
- Nothing looked fabricated.

## Unclear
1. pay_my_share (booking bk_4886cdb0d2f2, no amount): the response still showed Anna's payment as status "authorized" with paid null and "you.paid" 0.00. Only at lock did it show "captured, 9.68". I guessed the accept_price guarantee had already covered her share and pay_my_share did nothing visible. The server did not say which.
2. booking_status: "guaranteeBy": null while the organizer's guarantee was authorized ($29). I guessed guaranteeBy is only set when someone else guarantees.
3. find_options: Chen-Wei appeared in the players and names with no reason. The reason only showed up later in booking_status ("chose to be invited by people nearby"). I guessed nearby opt-in.
4. make_offer / accept_price: top-level share 9.67 vs ifYouAccept.yourShare 9.68 vs friend shares 9.66. I guessed the top-level is an average and not what anyone pays.
5. start_negotiation ifYouAccept: "worstCase 30.00" then "29.00" after the counter; the warning mentions the $15 per-game limit next to a $29 guarantee. I guessed Join's limit check is on the guarantee (the $60 group limit) not the $15 share.
6. Friends' answers: expiresMeans says friends see nothing until a price is accepted. That is stated plainly; I still had to commit Anna's guarantee before knowing if Bo or Chen-Wei would pay.

## Last round's confusions
- (1) wait_for_news returned my own find_alternatives call as news: NOT SEEN. I did not call find_alternatives. wait_for_news returned empty news every time I called it.
- (2) find_alternatives budgetPerPerson, per person or for the group: NOT SEEN. I did not call find_alternatives. For start_negotiation the budgetCheck is per person ("$10.00 each is within the $15.00 limit"), which is clear.
- (3) Friends' answers not visible before the price is accepted: CLEAR NOW as a statement (expiresMeans says it plainly). The design gap is still real: friends appeared only after accept_price.

## Findings
- CONFUSING 1: pay_my_share gave no visible change for Anna's own share (see Unclear 1). Request: pay_my_share booking=bk_4886cdb0d2f2 with mandate, no amount.
- CONFUSING 2: booking_status guaranteeBy null while guarantee authorized (see Unclear 2).
- CONFUSING 3: find_options does not say why a player was added (Chen-Wei) (see Unclear 3). Request: find_options activity=karaoke date=2026-11-01 start=11:00 minutes=60 players=2.
- CONFUSING 4: share 9.67 vs 9.68 vs 9.66 in make_offer (see Unclear 4).
- CONFUSING 5: worst case $29 vs Anna's $15 per-game limit (see Unclear 5). Anna should know this before a guarantee.

VERDICT: 0 BLOCKER, 0 BUG, 5 CONFUSING

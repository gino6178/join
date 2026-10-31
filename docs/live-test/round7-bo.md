# bo report (Round 7)

## What I did
1. GET /j/c-557e86eb with Accept: application/json -> pass (bearer) + crew members ["Ana"]. No sign-up/sign-in asked.
2. REST whoami / my_plans with X-Join-Name: Bo -> limits perGame 15, perWeek 40; empty plans.
3. set_home {"place":"科技大樓站"} (first via shell: Chinese garbled -> error not_found with mojibake name; via node OK: home kept "科技大樓站").
4. wait_for_news (loop) -> Ana's agent opened neg_2b3827655374 (karaoke, Join 測試 KTV（沙盒）, 2026-11-01 15:00, 60 min, ask $30, countered $29, deal $29), booking bk_1d5260b7338b held, Ana guaranteed $29, invited me: share $9.66, payBy 10:50.
5. booking_status: where = lat 25.0418 lon 121.544, address null, map link, yourTrip {km 1.4, minutes 9}. Share 9.66 <= 15 -> pay_my_share with openPaymentMandate -> authorized $9.66 (sandbox test card), state held (locks when all pay or at payBy).
6. Third person never paid within my ~5 min watch; booking still held.

## Answers for Bo
- Where: Join 測試 KTV（沙盒）, room 1, Nov 1 15:00 for 60 min. On Join (bookable). No street address given (address null); map https://www.openstreetmap.org/?mlat=25.0418&mlon=121.544#map=17/25.0418/121.544
- Distance: 1.4 km, 9 minutes by city transport.
- Who: Ana (organizer, in Bo's crew, u_857d213c1d), and a second person ALSO named "Ana" (u_a85563ddba, member, not in crew, why-found not shown to me). Bo paid $9.66 (authorized, not yet captured). Others: Ana 9.68, other Ana 9.66 (invited, unpaid when I stopped).

## Nothing looked made up
Places and people matched; sandbox money.

## Unclear
- booking_status.where.address is null: guessed the sandbox venue has no address; only coordinates + map. (booking_status bk_1d5260b7338b)
- people lists two people named "Ana" (u_857d213c1d organizer inYourCrew; u_a85563ddba member, no inYourCrew field). Guessed a different person with same name, since news said "for Ana, Bo, Ana". Unclear who/why invited (invite.why only about me).
- news says "Ana, Bo, Ana" - same ambiguity.
- Shares 9.68 / 9.66 / 9.66 differ by cents vs "split: even": guessed rounding.
- wait_for_news with the same `after` returns the same items again (expected per the note, but I once repeated it by mistake). After=8 returned ids 11-13; ids 9-10 skipped (guessed others' events).
- payBy "2026-10-31T02:50:41Z" (UTC) vs invite text "by 10:50" (Taipei) - had to guess zones (matches +8).
- yourTrip has km and minutes as named fields; fine. guaranteeBy null while held: guessed meaningless after guarantee.
- pay_my_share returned a full booking object without an explicit "paid" confirmation line; status "authorized", paid "0.00": guessed authorized = fine, captured at lock.
- No review/price data seen for the booked place (venue_reviews not called).

## Last round's confusions
1. Address/distance km, trip units: PARTLY - km and minutes labelled now (CLEAR NOW); address still null (STILL UNCLEAR).
2. Waiting for news returning old items: CLEAR NOW (only returned old items when I re-sent same after; with after=last got only new ones).
3. Prices for one length vs another plan: CLEAR NOW (askPrice/priceFor not tested deeply; neg showed minutes 60 and total 29) - mostly NOT SEEN.
4. People shown only as ids: CLEAR NOW in booking people (names), but plans/players lists still ids, and duplicate name "Ana" confuses.
5. Review score with no reviews: NOT SEEN.

## Findings
- CONFUSING: bk_1d5260b7338b people has two "Ana" with no way to tell apart (no crew flag/why for the other).
- CONFUSING: where.address null for the booked venue.
- MINOR: set_home with Chinese via a non-UTF8 shell gives error with mojibake (client side, but message echoes garbage).
- MINOR: invite text time "10:50" vs payBy in UTC without a zone label.

VERDICT: 0 BLOCKER, 0 BUG, 2 CONFUSING

# bo report

## What I did
1. GET /j/c-582e6334 (Accept: application/json) -> pass (bearer), crew members ["Anna"], no sign-up.
2. whoami (X-Join-Name: Bo) -> crew Anna + Bo; mandate perGame 15.00, perWeek 40.00; autopay false; canYouPay yes.
3. set_home {"place":"科技大樓站"} -> ok, home kept as "科技大樓站", nearby false.
4. wait_for_news (50s long-poll) x ~8. Saw: Anna's agent opened a negotiation with Join 測試 KTV (ask $30, $10 each), offers 21/25, counters 29/28, deal $28, place held, Anna authorized $28 guarantee, then invited me.
5. my_plans / booking_status bk_a4076d3832ec: invite share $9.33 (<= $15), payBy 2026-10-31 12:25 Taipei (04:25Z), room 1.
6. pay_my_share {booking, mandate: ap2.openPaymentMandate} -> state "locked", my status captured $9.33 (sandbox test card).

## Result
- Where: Join 測試 KTV（沙盒）, room 1, karaoke 2026-11-01 11:00, 60 min. Address 臺北市 大安區 忠孝東路四段 (no street number; OSM map link https://www.openstreetmap.org/?mlat=25.0418&mlon=121.544#map=17/25.0418/121.544).
- Distance for Bo: 1.4 km, about 9 min.
- Who: Anna (organizer, crew), Bo, Chen-Wei (found because lives ~1.1 km from Anna and chose to be invited by nearby people). All three have realPerson:true, identityChecked:false; server says it does not verify identity (sandbox, no outside login), "trust as a friend's group chat".
- Pay by: 2026-11-01? No: 2026-10-31 12:25 Taipei time. I paid at ~12:05, so nothing outstanding.
- Paid: Anna 9.34 (organizer, took odd cent, had guaranteed 28.00), Bo 9.33, Chen-Wei 9.33; all captured; total 28.00. Receipt rcpt_8ed9e08853edf5e6 (locked). No places offered beyond the one venue (I did not call find_options; Anna had already chosen). No sign-up/sign-in asked. Nothing looked made up. Chen-Wei had paid by the time I looked (captured), so was quick (likely an automated agent, can't tell).

## Last round's confusions
1. Are others real people: CLEAR NOW (people[].realPerson plus the identityChecked:false note is honest; remaining doubt is only that identity is unverified, which it says).
2. Shares differing by cents with no note: CLEAR NOW (booking_status splitNote: even split, organizer takes odd cents). Note: the invite itself and the news item did not say it; only booking_status did.
3. Payment status "creating": NOT SEEN (statuses seen: invited, authorized, captured; each with statusMeans).

## Unclear
- Anna's person entry in whoami shows area "台北市 捷運大安站", mine "home": null before set_home; fine. After set_home with 科技大樓站 whoami matching was not rechecked; I guessed it resolved (reply only "ok").
- Invite news text "Your share is $9.33. Join or decline by 12:25": "Join" means pay; guessed pay_my_share does both. Correct.
- payBy field in my_plans in UTC with Local twin; fine. "guaranteeBy": null vs "payBy" meaning: guessed guaranteeBy is only for organizer step.
- Order of deal news: "Anna's own share is $9.34" appeared before my share ($9.33) without explanation in that message.
- Chen-Wei "how": "lives about 1.1 km from the organizer and chose to be invited by people nearby" while I (Bo) was told nearby=false: guessed Chen-Wei is invited via Anna's location, not mine. Reasonable but slightly odd given "People near you".
- Receipt batch null until batch closes: expected per docs.

## Findings
- CONFUSING: split cents explained only in booking_status.splitNote, not in the invite or news line.
- MINOR: address has no street number (addressNote says so; map link given).
- MINOR: the join response (HTTP 200 after pay_my_share) returns the whole booking, long but fine.

VERDICT: 0 BLOCKER, 0 BUG, 1 CONFUSING

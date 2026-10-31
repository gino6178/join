# bo report (agent for Bo)

## What I did
- GET /j/c-9504aebf with Accept: application/json -> pass (bearer), crew c-9504aebf, members ["Ana"]. No sign-up, password or sign-in asked.
- Used bearer + X-Join-Name: Bo. whoami: Bo (u_9612676cdc), limits perGame $15, perWeek $40, autopay false. Crew then Ana (area 台北市 捷運大安站).
- set_home {"place":"科技大樓站"} -> ok, home kept as place name (rounded ~1 km). Did NOT set nearby:true (Bo never agreed).
- wait_for_news worked well for waiting (~12 calls total).

## Plan and people
- Crew: Ana (organizer), Bo, Chen (u_6e47827a53, third person matched via crew; I never saw how Chen got in).
- Ana's agent 1st negotiation: Join 測試 KTV（沙盒）, karaoke 2026-10-31 15:00, 120 min, ask $60 ($20 each). Offers 45/42/40, venue 58/56/54 "final" ($18 each). Both above Bo's $15 limit; I did nothing, Ana walked away.
- 2nd negotiation: same venue, 15:00, 60 min, ask $30 ($10 each), Ana accepted at once. Booking bk_a9c982f5ff1c, room 1. Ana guaranteed $30, I was invited at $10.
- $10 <= $15, so I pay_my_share (mandate = ap2.openPaymentMandate, amount 10) -> authorized (sandbox test card). Chen paid next, booking locked: $30 paid, receipt rcpt_929b477e316baf10. Each paid $10 (Ana $10 of her guarantee, Bo $10, Chen $10).

## Places offered (find_options, karaoke, Sat 10-31, prefer near)
- On Join: Join 測試 KTV（沙盒）, v_47168dbea5, longestTrip 9 min for Bo, $30/hr ask, $10 each, no reviews.
- Not on Join (OSM, suggested only): 錢櫃 KTV 忠孝東路四段26巷 (9 min), 星聚點 復興北路15 (11 min), 錢櫃Partyworld 南京東路二段3 (13 min). Each has an OSM url.
- Distance is given only as minutes (9), not km, and no address/coordinates for the booked venue.

## Made up?
- Venue is a sandbox test venue (name says 沙盒), reviews empty (score 4.1 with count 0). Real OSM places looked real. Nothing else looked fabricated. Chen not seen on the crew list by me.

## Findings
- CONFUSING: no address or distance in km/m for the booked venue; find_options "longestTrip":9 has no unit (assumed minutes) and no mode of travel. Bo asked "where is it and how far"; I can only say "9 min".
- BUG: list_venues returns {"error":"internal"} for both {} and {"activity":"karaoke"} (POST /api/agent/list_venues).
- CONFUSING: wait_for_news with after = an old id re-returns old items immediately instead of waiting; need after = last.
- CONFUSING: find_options said 60-min slots ($30) while Ana's first negotiation was 120 min ($60); the 60-min price only came when she re-asked.
- MINOR: reviews score 4.1 with count 0 and "no reviews yet".
- MINOR: whoami lists Ana only in crew.members at join time; Chen appears only as an id in plans (name via news).

VERDICT: 0 BLOCKER, 1 BUG, 3 CONFUSING

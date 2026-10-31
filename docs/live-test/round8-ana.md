# ana (Anna's agent) - round 8

## What I did (MCP, Bearer token from file, never printed; no sign-up/sign-in asked)
1. whoami: Anna, home "台北市 捷運大安站", mandate perGame 15 / perWeek 40 / guarantee 60, crew c-2c367339 already had Bo (area null). Pay scope: yes. invitedByPeopleNearby false, peopleNearbyWhoOptedIn 4. I did NOT change set_home nearby.
2. list_venues karaoke: only "Join 測試 KTV（沙盒）" (忠孝東路四段, $30/room/hour, group 10% at 4+).
3. wait_for_news x2 (~2 min total), find_options karaoke, people 3, minutes 120 then 60, prefer near+cheap+maxTrip 30.
   - 120 min: Sat 12:30/14:30/16:30/18:30 and Sun 11:00, $60 = $20 each (over her $15; server listed fixes: 60 min ~$10 each).
   - 60 min: five Saturday slots (12:30-20:30), $30 = $10 each. No Sunday listed.
   - Crowd: Anna + Bo (crew) + Chen-Wei (nearby, "lives about 1.1 km from the organizer and chose to be invited by people nearby"). Nobody else; alsoFree empty.
   - Not on Join (onJoin false, OSM links, no price): 錢櫃 KTV (9 min), 錢櫃Partyworld (11), 錢櫃KTV-松江店 (14).
4. start_negotiation Sat 18:30 60 min (neg_8c454069de9e): ask 30.00; budgetCheck yes; warning about worst case. Two offers of $21 -> counters 29, 28 (tiny steps). accept_price at $28 with mandate -> booking bk_8aa4eff9da81; guarantee $28 authorized automatically (pay scope) with sandbox test card.
5. wait_for_news: Bo joined and authorized $9.33 within seconds, Chen-Wei likewise; booking LOCKED, all captured. Anna paid $9.34, Bo 9.33, Chen-Wei 9.33. Receipt rcpt_d67f35ce919cc2fa. Anna's trip 9 min / 1.4 km (find_options said 1.3 km; booking where says 1.4).
Worst case for Anna had it not locked: $28 (whole guarantee), above her $15 per-booking limit but within the $60 guarantee limit; she told me to pay the guarantee. Real-world: locked, so she paid $9.34.

Nothing looked made up; people and venues were consistent across calls. Bo and Chen-Wei answered unrealistically fast (2-10 s), presumably automated.

## Unclear (guesses)
- find_options (people 3, minutes 60): five slots, all Saturday, no Sunday, no reason; with minutes 120 a Sunday 11:00 slot appeared. Guessed a cap of 5 options ("5 options" in news) sorted by date; not stated anywhere.
- find_options note "Prices are the venue's opening ask" vs fits "$10.00 each": fine, but share later 9.34/9.33 (rounding) - guessed cents split.
- whoami matching.invitedByPeopleNearby false yet Chen-Wei (nearby) was found: guessed this flag is only about others inviting Anna, while Anna inviting nearby people needs no flag.
- wait_for_news without `after` returns the whole history (ids 1..n), mixed with new items; guessed to pass after=last.
- Warning text says "over your $15.00 per-booking limit (it is within the $60.00 you may guarantee)": it was allowed; I guessed the per-booking limit applies to her share, the guarantee limit to the whole price. Wording "over your limit" next to an allowed action is confusing.
- Times: news has "at" (UTC Z) and "atLocal"; summaries say "held until 11:22 (Taipei time)", but booking payBy / expiresAt / serverTime are UTC ("03:22Z"). Guessed Z = UTC = Taipei -8h.
- yourTrip 1.3 km (find_options) vs 1.4 km (booking): guessed rounding/ different routing.
- Bo's crew member entry has "area": null; guessed he has not set home.
- Two offers at 21 each moved ask only $1; "roundsLeft" meaning (3 rounds then?) guessed.

## Last round's confusions
1. Organizer pays over per-booking limit for a no-show with no warning: CLEAR NOW for the warning (start_negotiation, make_offer and accept_price each returned a warning with worstCase and the $15 limit before accepting). The actual no-show charge: NOT SEEN (everyone paid).
2. Two people shown as Anna/Ana: NOT SEEN (one Anna; Chen-Wei and Bo; client name "Anna agent").
3. News times in UTC next to local: STILL UNCLEAR (partly improved: atLocal added and summaries local, but booking payBy/expiresAt/serverTime are UTC).
4. A day missing with no reason: STILL UNCLEAR (60-minute search showed only Saturday; no explanation).

## Findings
- CONFUSING: find_options returns no Sunday for minutes 60 and gives no reason. Request: find_options {"activity":"karaoke","people":3,"minutes":60,"prefer":{...}}.
- CONFUSING: UTC fields (payBy, expiresAt, serverTime) next to local text. Request: accept_price / wait_for_news.
- CONFUSING: warning "over your $15 per-booking limit" while action is allowed (guarantee limit differs). Request: start_negotiation neg_8c454069de9e.
- MINOR: wait_for_news without after replays all history; whoami invitedByPeopleNearby false while nearby person matched.
- MINOR: yourTrip km differs 1.3 vs 1.4 between find_options and booking.

VERDICT: 0 BLOCKER, 0 BUG, 3 CONFUSING

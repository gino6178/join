# ana report (Ana's agent, MCP)

## What I did
- Read BRIEF and llms.txt. Used MCP at /mcp with Ana's token (pay scope). whoami: Ana, area 台北市 捷運大安站; crew c-9504aebf already had Bo (科技大樓站) when I started, so no waiting needed. Limits: perGame $15, perWeek $40, guarantee $60.
- set_home {nearby:true} (Ana said someone nearby may come): ok, home kept as 捷運大安站.
- find_options karaoke, Sat 10-31 + Sun 11-01, people 4 (with from/to 18-22): nothing. With people 4 and no window: nothing, repeated 4 more times over ~3 min while waiting: nothing. people 3: 5 options.
- Plan group: Ana + Bo (crew) + Chen u_6e47827a53 (matched as nearby, not crew, not named). Trips 9/9/6 min.
- Places offered:
  - Join 測試 KTV（沙盒）v_47168dbea5, on Join, Sat 11/13/15:00, ask $60 = $20 each (3 people), 9 min longest trip, no reviews. The only bookable venue.
  - Real OSM, onJoin:false (book directly, Join can't check price/availability): 錢櫃 KTV (忠孝東路四段26巷) 9 min, 錢櫃Partyworld (敦化南路一段205) 11 min, 錢櫃KTV-松江店 (松江路199) 14 min. No prices given.
  - Sunday only returned the real non-Join place, at 08:00 and 10:00 (odd karaoke hours).
- Negotiation neg_bd43b3a8cd99 (Sat 15:00, 2h, 3 people): ask 60 -> offer 45, counter 58 -> offer 42, counter 56 -> offer 40, "Best and final" 54 ($18 each). The venue's own hint: 4 people would be $54 = $13.50 each, but no 4th person was found.
- Result: NOT booked. $18 each exceeds Ana's $15 cap, so I did not accept; I called walk_away. Nothing paid, nothing locked, no invitations sent to Bo or Chen.

## Why
Only way to stay under $15 is 4 people at the group rate; only 3 people were available. Cheaper real KTVs exist nearby but cannot be booked or priced through Join.

## Made up?
Nothing looked made up: Bo and Chen are real accounts, the OSM places have real links/addresses. The Join venue is a sandbox test venue ("沙盒"). No sign-up or sign-in was asked of me.

## Findings
- CONFUSING: find_options with people:4 returns "Nothing fits" instead of saying only 3 people are free and that a 4-person rate would make it $13.50 each; that only shows up in start_negotiation.cheaper. Request: find_options {activity:karaoke,dates:[2026-10-31,2026-11-01],minutes:120,people:4}.
- CONFUSING: the "Best and final" price ($54) is still overBudget, and counters barely move (45->58, 42->56, 40->54), so a $15 budget with 3 people is unreachable; nothing tells the person early. Mild: first offer 45 (exactly $15 each) was 75% of ask yet got 58.
- MINOR: list_venues {activity:"karaoke"} errored "Cannot read properties of undefined (reading 'pct')" (my script passed a bad file path, so likely my fault; not retried).
- MINOR: Sunday options for karaoke at 08:00/10:00 only for the non-Join place; Join venue not offered Sunday.
- MINOR: real places have no price, so Ana can't compare cost with Join's venue.

VERDICT: 0 BLOCKER, 0 BUG, 2 CONFUSING

## Continued (Ana approved 1 hour, three people, Join 測試 KTV)
- find_options minutes 60, 3 people: Sat 11/13/15/17/19:00, ask $30 = $10 each.
- start_negotiation neg_bd... new one neg_8c5d8a5d68b8 (Sat 10-31 15:00, 60 min, Ana+Bo+Chen): ask $30.00 ($10 each); the response also showed a venue counter-ask of 27 in history-like field. I accepted $30 at once (already under $15 each) with accept_price + mandate: booking bk_a9c982f5ff1c, room 1, state held, Ana's $30 guarantee authorized (sandbox test card) in the same call.
- pay_my_share (Ana): ok. Bo and Chen's agents then paid; state held -> locking -> locked within about 3 minutes. All three payments "captured", $10.00 each, total $30.00.
- Final: LOCKED. Ana paid $10, Bo $10, Chen $10. Nothing made up; no sign-up/sign-in asked.
- Findings: CONFUSING: my earlier 2-hour run quoted $60 and walked away, while the same group at 1 hour is $30, i.e. exactly half; the group-size discount hint ("4 people") was never needed. MINOR: start_negotiation output contained an unexplained "ask 27.00" line next to the $30 ask (unclear whether the venue would have taken less; I did not probe since $10 was well under the cap).

VERDICT: 0 BLOCKER, 0 BUG, 2 CONFUSING

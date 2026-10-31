# bo report

## What I did
1. GET /j/c-ac81e49c (no Accept header): 302 to /#/?crew=... (a browser page). With Accept: application/json: pass (bearer + mcp), members ["Anna"], guide /llms.txt. No sign-up asked.
2. Read /llms.txt. whoami (X-Join-Name: Bo): limits perGame 15, perWeek 40; home null; crew Anna. my_plans: empty.
3. set_home place "科技大樓站" first via curl: error not_found "place name arrived garbled" (shell encoding). Via node UTF-8: ok, home "科技大樓站", nearby false (I did not opt Bo into nearby matching).
4. wait_for_news: news id2 Anna's agent opened negotiation at Join 測試 KTV for karaoke 2026-11-01 11:00, 3 people, ask $30 ($10 each); id3 countered $29; id4/5 place held, deal $29; id6-8 Anna guaranteed $29 (sandbox card), invited Bo.
5. Invitation: share $9.66 (<= $15), payBy 11:50 Taipei (2026-10-31T03:50:20Z), 1.4 km / about 9 min for Bo. Called pay_my_share with openPaymentMandate: authorized $9.66. Chen-Wei joined/authorized too. News id16: locked, everyone paid. Final: state locked, all three captured (Anna 9.68, Bo 9.66, Chen-Wei 9.66, total 29.00), receipt rcpt_ea4cfdd1cc3f3f4c (event locked, batch null at the time).

## Who, how matched
- Anna: organizer, in Bo's crew (area 台北市 捷運大安站).
- Bo: me, joined from invite link.
- Chen-Wei: "lives about 1.1 km from the organizer and chose to be invited by people nearby"; account "a person who signed up on Join (demo account, sandbox money)".
Places offered: only the one Anna's agent chose, Join 測試 KTV（沙盒）, on Join (onJoin), room 1. I did not call find_options (not needed). Address: 臺北市 大安區 忠孝東路四段 (no number), lat 25.0418 lon 121.544, map https://www.openstreetmap.org/?mlat=25.0418&mlon=121.544#map=17/25.0418/121.544.
Nothing looked made up; sign-up/sign-in never requested.

## Findings
- CONFUSING: share 9.66 for Bo/Chen-Wei vs 9.68 for Anna, no explanation of rounding (response of booking_status "payments"). Minor.
- MINOR: wait_for_news {after:3} and {after:8} replayed events not strictly after the id (after 8 returned ids 11-15 with no 9,10; fine, but repeated calls with after:0 returned the same item immediately three times instead of waiting; expected since news existed).
- MINOR: curl with Chinese place gives "garbled" error; clear message, resolved with node.
- MINOR: the plain GET of the invite link redirects to an HTML page; the JSON needs Accept: application/json (documented in llms.txt, not on the redirect).
- MINOR: while my payment settled, Chen-Wei's status showed "creating" (undocumented value).

## Unclear
- Address without number: addressNote says "OpenStreetMap has no street number here: use the map link." Guess: CLEAR NOW (map link given, coordinates given), though the actual door is still not known.
- "locking": I never saw state "locking"; states seen: held, locked. The stateMeans for held and locked were clear. Status "creating" for Chen-Wei not explained (guessed: PayPal order being created).
- Whether others are real: people[].account says "demo account: no outside login, sandbox money" for Anna and Chen-Wei, and how-found text explains Chen-Wei. llms.txt says "Nobody is made up". Whether they are real humans cannot be verified; they are real accounts on the server (could be test agents).
- payBy: bookings show payBy as "by when to pay"; but everything was captured immediately at lock, so the deadline was not binding.
- "The venue is paid after the game" (stateMeans) - understood.
- guaranteeBy null on bookings - guessed unused after the organizer guaranteed.

## Last round's confusions
1. Address with street but no number: CLEAR NOW (addressNote + map link + coordinates), though still no door number.
2. Booking state "locking": NOT SEEN (locked instantly; stateMeans for locking is described in llms.txt as PayPal capturing).
3. Whether others are real people: STILL UNCLEAR (account text says demo account; matching reason is given for Chen-Wei, but can't tell a human from a test script).

VERDICT: 0 BLOCKER, 0 BUG, 1 CONFUSING

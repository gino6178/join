# yuhan-rest report (REST, person: Yuhan / 林語涵)

## Way in
GET / (SPA shell; <noscript> and a <link rel=alternate> point to /llms.txt) -> GET /llms.txt told me everything (demo auth, token, REST at /api/agent/<tool>). /openapi.json returns the SPA HTML (200, not JSON). /.well-known/agent-card.json exists. No guessing needed.

## Steps
1. POST /api/auth/demo {"name":"Yuhan"} -> cookie, player u_3c4a03c074 (area Westgate).
2. POST /api/tokens scopes read+negotiate (no pay) -> tok_5680bc32.
3. whoami: currency not stated; mandate perGame "15.00", perWeek "40.00", guaranteeOnItsOwn "60.00", autopay false. AP2 openPaymentMandate JWT: amount max 6000 / share_max 1500 / budget max 40, currency USD (these look like cents).
4. list_activities, list_venues (currency USD, "Sample town (placed on San Jose, CA)"). Karaoke: Echo $36/room/hour. Hot pot: Westgate Hot Pot House $28/person.
5. find_options date 2026-10-31 people 4. Karaoke Echo 20:00 60min ask 32.40, share 8.10. Hot pot ask 100.80, share 25.20 (too much).
6. venue_reviews: Echo 4.3 (21 demo reviews; atmosphere, equipment; "noisy"); hot pot 4.1 (14; value, food; waiting to start, noisy).
7. start_negotiation echo karaoke 2026-10-31 20:00 60 min players [you,hana,tomas] -> neg_fa0b3892a1ce, ask 32.40 (36 less group 10%), share 8.10, expires 15 min later.
8. make_offer 26.00 -> venue countered 29.40 (share 7.35), round 1, 2 rounds left.
9. accept_price 29.40 -> status agreed, booking bk_4a6e2afdc6e1 state awaiting_organizer.
10. booking_status: all payments not_started, paid null, paypal null, receipts []. Nothing charged or held. pay_my_share not attempted for real (token lacks pay scope; a probe with bad ids returned error "scope").

## Budget in the site's currency
Site is USD only; it offers no TWD rate anywhere I could find. I assumed about 1 USD = 32 TWD (my own assumption, flagged as such): 400 TWD ~ 12.50 USD per person (conservative; at 30 it is 13.33). Per-person share 7.35 USD ~ 235 TWD (at 32), well under 400 and under the site mandate 15.00/game. Hot pot at 25.20 USD/person (~806 TWD) was out of budget; the venue floor (offers under 70% of ask don't move it) means it could not reach ~12.50 anyway (70% of 25.20 = 17.64).

## What accepting committed Yuhan to
Agreed price 29.40 USD total for room 1 at Echo Karaoke, Sat 31 Oct 2026 20:00 for 60 min, split evenly 4 x 7.35. As organizer Yuhan must guarantee the whole 29.40 (PayPal authorization hold) by guaranteeBy 2026-10-30T14:00:28Z (~10 min after accepting); worst case she covers non-payers up to 29.40 USD (~940 TWD at 32), far above her 400 TWD, if friends don't pay. Status shows nothing charged or held yet: that needs Yuhan on the website (token had no pay scope). Cancelling is possible via cancel_booking (not tried); consequences of missing the guarantee deadline are not stated.

## Findings
- CONFUSING: Worst-case exposure. accept_price commits the organizer to guarantee 29.40 (4x her share). Her 400 TWD budget is per person; an agent must tell her she is the guarantor of ~940 TWD. The text is present ("youGuarantee") but easy to skim; site per-game mandate is 15.00 yet the guarantee is 29.40 (allowed through guaranteeOnItsOwn 60).
- CONFUSING: No currency conversion or TWD anywhere; whoami has no currency field (only list_venues has "currency":"USD"); mandate numbers in whoami are strings of dollars while JWT constraints are in what looks like cents (max 6000/1500/40 - budget max 40 vs perWeek 40.00 is dollars, share_max 1500 = $15.00 cents; mixed units inside one mandate).
- CONFUSING: Time zone. Town is "placed on San Jose, CA" (PDT, UTC-7 until 1 Nov 2026). Times like "20:00" and "Sat 2026-10-31" are town-local, not labeled. Sat 20:00 in town = Sun 1 Nov 11:00 in Taipei (UTC+8, 15 h ahead). The agent must not tell Yuhan "Saturday night" in Taipei terms. Timestamps (expiresAt, guaranteeBy) are UTC "Z"; the town's own clock is never stated by the API. "Saturday" resolved by me as 2026-10-31 (today 2026-10-30 is Friday).
- CONFUSING: Very short windows: negotiation expiresAt 15 min, guarantee deadline 10 min after accept; Yuhan (asleep/in Taipei, ~22:00) may not reach the website in time; the user said to ask before paying, but accepting already starts a 10-minute clock.
- CONFUSING: The user asked 唱歌 for 3 friends; the site chose friends by free-time overlap. Player ids are lower-case first names, and one is literally "you" ("Alex Rivera") which an agent could misread as "me". I passed ["you","hana","tomas"]; the three are invited but nothing says they were asked/agreed (invites only appear in their own my_plans).
- CONFUSING: Reviews: find_options complaint list says "quiet" (aspect key) while the text says "noisy" (label): "complaints":["quiet"] vs "noisy (8)". Score 4.3 vs "average":4.4. All reviews are "demo data" with templated repeated text.
- CONFUSING: Karaoke minimum shown is 60 min (and 120/180 allowed); find_options only offered 60-minute slots, 1 hour is short for a night out. 2h would cost 64.80 (16.20 each ~ 518 TWD) over budget.
- CONFUSING: Hot pot Sat options mostly 18:00/20:00; the hot pot price list says 28.00 per person but the ask was 100.80 for 4 (=25.20 each after group 10%); fine, but "per person" price with a 4-person table is only visible after find_options.
- MINOR: /openapi.json returns 200 HTML (SPA) instead of 404/JSON; /.well-known/agent.json 404 with a helpful message.
- MINOR: Language is English only; no zh-TW text; venue/reviewer text and the "Sample town" naming are English; a Chinese-speaking person needs everything translated by the agent (e.g. "karaoke" activity id is English, "hot pot" works).
- MINOR: the "seats" promised "Limits only the person can set are enforced": confirmed, a pay call on my token returns {"error":"scope"} clearly.

## Claims vs reality
- "This server runs on PayPal sandbox": consistent (paypal "sandbox"), nothing charged.
- "Every step ... shown to the people involved": not verified.

VERDICT: 0 BLOCKER, 0 BUG, 8 CONFUSING

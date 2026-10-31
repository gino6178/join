# chen report (Chen-Wei's agent), round 11

## What I did
1. Read BRIEF.md. Read Join's public agent instructions at http://192.168.31.145:8799/llms.txt only. No Join source or repo files were read.
2. whoami with Chen-Wei's token (not printed). Result: Chen-Wei, home 台北市 捷運忠孝復興站, invitedByPeopleNearby true, 6 nearby opted-in people, crewSize 0. Mandate: perGame 15.00, perWeek 40.00, guaranteeOnItsOwn 60.00, set by the player on the website. PayPal mode sandbox.
3. wait_for_news polling (about 20 minutes, 10:28 to 12:48 Taipei time). Plans were empty at first.
4. news id 5 at 12:29: Anna's agent opened a karaoke negotiation for 2026-11-01 13:00 with Anna, Bo and Chen-Wei. Venue ask $30.00, $10.00 each.
5. Venue accepted $30.00 (news id 8, 12:37). Booking bk_a39ea9a62766 created. Anna's PayPal guarantee authorized.
6. Invitation to Chen-Wei (news id 12, 12:37): share $10.00, join or decline by 12:57 Taipei time. Booking booking_status showed invite.why and where, with you: null (expected before payment).
7. Checked before paying: both other players are realPerson true, identityChecked false (no outside sign-in on this sandbox). Share $10.00 is within the $15 per-game limit. Venue is Join-registered.
8. pay_my_share(booking bk_a39ea9a62766, mandate = whoami ap2.openPaymentMandate, amount 10). Result: locked at 12:38. Chen-Wei's payment captured via PayPal sandbox test card (capture 2U7204588Y3591603). Receipt rcpt_2b35c143bd02526b issued (batch null, so no Merkle proof yet).
9. Kept watching until about 12:48. No further invitations. Total spent: $10.00 of the $40 weekly limit.

## Who, how matched, where, how far
- Anna (organizer, real Join account, signed up with a name and area). Found Chen-Wei as "lives about 1.1 km from Anna, likes karaoke, chose to be invited by people near you".
- Bo (in the organizer's crew, joined from a friend's invite link). Paid $10.00 (captured).
- Venue: "Join 測試 KTV（沙盒）", a Join-registered venue whose name marks it as a sandbox test venue. Address 臺北市 大安區 忠孝東路四段 (no street number), OpenStreetMap point 25.0418, 121.544. 0.5 km from Chen-Wei, about 7 minutes.
- Date and time: 2026-11-01 13:00, 60 minutes, room 1.

## Did anything look made up?
- The people are real Join accounts. Join says it does not check identity on this sandbox, so "real person" means "a Join user", not verified.
- The venue is a sandbox test venue, not a real-world KTV bookable by a person. The server's own text says PayPal is a sandbox test card and no real money moved.
- No sign-up or sign-in was asked of Chen-Wei. Nothing was signed with any outside account.

## How it ended
- Booking locked. Anna paid $10.00, Bo $10.00, Chen-Wei $10.00. Room total $30.00. Payout to the venue happens after the game (payout null).

## Findings
- VERDICT: 0 BLOCKER, 0 BUG, 2 CONFUSING

- CONFUSING: wait_for_news with after=0 (or any old after) replays the whole history from the first news item for this person (ids 5, 7, 8 ... 17 came back). Passing the last value returned in `last` avoids this, but the note does not say so.
- CONFUSING: booking_status shows you: null before payment, and the invite block carries the share. After pay_my_share, you is filled in. Clear enough, but the invitation text does not say that paying is what fills `you`.

## Unclear
Last round's confusions:
1. Old `after` in wait_for_news replays old news: CLEAR NOW. Passing after=0 returns all items since the start, including ones already handled. Use `last` from the previous reply.
2. `you` is null in my_plans until he pays: CLEAR NOW. Before paying, booking_status shows you: null and the invite block with share and payBy. After pay_my_share it shows you with share, authorized, paid and captured.

Other guesses:
- The brief said "watch for up to 20 minutes" and I used the full window, though the first invitation came about 8 minutes in. I did not check whether a second invitation would have come later.
- I passed amount 10 to pay_my_share, the same as the share. The brief allowed this.
- The per-game limit check: $10 is under $15, but I did not confirm whether Join applied the mandate's perGame to the whole booking ($30) or only to my share. Join accepted the payment, so I took it as my share only.

# bo report
Did: GET invite link (Accept: JSON) -> pass; whoami (limits $15/game); set_home "科技大樓站" (OK via node UTF-8; shell-mangled text gave not_found with garbage name; an earlier guessed lat/lon was overwritten); wait_for_news; my_plans; pay_my_share with openPaymentMandate.
Plan: karaoke 2026-10-31 18:30, 60 min, Join 測試 KTV（沙盒）, room 1, total $28.00 (Anna haggled 30->28), organizer Anna $9.34, Bo $9.33, Chen-Wei $9.33. People: Anna (organizer, crew), Bo, Chen-Wei (found as living ~1.1 km from organizer, opted into nearby invites). Place: on Join, only one offered to me; address "臺北市 大安區 忠孝東路四段" (no number), 1.4 km / 9 min for Bo. Pay-by 11:22 Taipei time (payByLocal), raw payBy 03:22Z.
Ended: all three authorized, booking went to "locking" (no receipts yet when I stopped). Bo paid $9.33 (sandbox). No sign-up/sign-in asked. Nothing looked made up.
## Unclear
- (1) address: street only, no number/building; guessed it is the road, use map link (lat/lon given). STILL UNCLEAR-ish (map link helps).
- (2) same-name people: NOT SEEN (names distinct).
- (3) pay-by: payByLocal "11:22 Taipei time" given explicitly -> CLEAR NOW. Raw payBy is UTC "Z", fine.
- (4) negotiation by id only: negotiations carry "names" map and news summaries use names -> CLEAR NOW.
- Share: invite said 9.33, organizer 9.34, sum 28.00; fine.
- my_plans/booking_status for guaranteeBy:null, state "locking" vs "held": unexplained locking, guessed it is capturing.
- wait_for_news with same "after" returns immediately (my mistake, doc says use last).
- Chen-Wei status "creating" shown briefly.
- set_home place with Chinese via shell mangled; error echoed garbage.
VERDICT: 0 BLOCKER, 0 BUG, 2 CONFUSING

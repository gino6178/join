# chen report (Chen-Wei's agent)

## What I did
- Did not sign up or sign in. Used Chen-Wei's existing token (chen-token.json, never printed). whoami: Chen-Wei, home 台北市 捷運忠孝復興站, invitedByPeopleNearby true, 7 nearby people opted in, mandate perGame 15.00, perWeek 40.00, paypal sandbox, canYouPay yes.
- Read the server's own instructions from http://192.168.31.145:8799/llms.txt and the API responses. I did not read Join's source code or repo.
- Waited with wait_for_news (50 s per call), passing after = last id each time. Started about 12:59 Taipei time, first invitation at 13:03, paid at 13:03:58, done by 13:04. Well inside the 20 minutes.
- Checked my_plans for the negotiation, the booking and the invitation fields.

## Timeline (Taipei time, all 2026-10-31)
- 13:03:14 Anna's agent opened a negotiation with Join 測試 KTV（沙盒） for karaoke on 2026-11-01 19:00, 60 min, for Anna, Bo and Chen-Wei. Venue ask $30.00 ($10 each).
- 13:03:25 Anna's agent offered $25.00; the venue countered $29.00.
- 13:03:31 The venue accepted $29.00. Room 1 held. Anna guaranteed $29.00 in PayPal sandbox.
- 13:03:35 Invitation to me: my share $9.66 of $29.00, join or decline by 13:23.
- 13:03:51 I joined with pay_my_share (booking bk_4886cdb0d2f2), no amount passed, my openPaymentMandate passed. My $9.66 was authorized and captured. Receipt rcpt_4ce37c6741103dab (locked).
- 13:03:58 Booking locked. Everyone paid: Anna $9.68, Bo $9.66, Chen-Wei $9.66.

## Who was in the plan and how they were matched
- Anna (organizer, real account per Join). Found because she lives about 1.1 km from Chen-Wei, likes karaoke, and both opted in to nearby invitations. Join marks her realPerson: true but identityChecked: false ("signed up on Join with a name and where they live"). Not a verified identity.
- Bo. "In the organizer's crew", joined from a friend's invite link. Join gives no distance from Chen-Wei for Bo.
- Chen-Wei (me, the person I act for).

## Place
- Join 測試 KTV（沙盒）, venue v_47168dbea5, on Join. Address 臺北市 大安區 忠孝東路四段 (no street number, OpenStreetMap link given). 0.5 km from Chen-Wei, about 7 min by city transport.
- The name says 沙盒 (sandbox). The site's own description says bookable venues here are test venues. So this is a test venue, not a real karaoke business. Anna's OSM-located address is real, but the booking is a sandbox booking.

## Money
- Sandbox only: PayPal sandbox test card stood in for each person's approval. Nothing real was charged. Chen-Wei's share: $9.66. Total: $29.00. Join pays the venue at game end via PayPal Payouts (payout still null).

## Was anything made up?
- Nothing looked invented in the data: the people, the negotiation steps, the receipts and the PayPal order ids were all consistent between news and my_plans.
- The venue is a sandbox test venue (see above). Anna and Bo are only "signed up" accounts; I could not verify who they are.

## Unclear
1. Invitation text: "Your share is $9.66 ... Join or decline by 13:23 (Taipei time)." It does not say that paying is how you join. I guessed "Join" = pay_my_share with the openPaymentMandate from whoami. It worked, but a reader could not tell from the invite alone.
2. "$15 or less": Chen-Wei's limit is perGame 15.00 on the site. The game total was $29.00; my share was $9.66. I compared my share to the limit (I took "it's $15 or less" to mean my share). Chen-Wei may have meant the total. Please confirm.
3. booking.you was null in my_plans before payment. After pay_my_share, "you" appeared with share, authorized, paid and captured fields. I had to guess that this was the "fills in once paid" behaviour. The receipt confirmed it.
4. booking.owes and booking.payout were null. I guessed owes null = I owe nothing more. payout null = venue not paid yet (stateMeans says so).
5. realPerson: true with identityChecked: false. I read "realPerson" as "a signed-up account, not made up", not as "identity verified". The note says so; I just want it noted.
6. Bo's distance from Chen-Wei is not given anywhere ("in the organizer's crew"). I could not say how far Bo lives.
7. wait_for_news: with after = last I saw no replays. The note now says "an older after returns everything since it again", so this is clear. The llms.txt does not say this, only "after = the last id".

## Last round's confusions
1. wait_for_news `after` replays old news: CLEAR NOW. The response note says an older after returns everything since then. I only ever passed the latest id, and nothing old came back.
2. Invitation did not say paying is how you join, or that `you` fills in once paid: STILL UNCLEAR for the first half (the invite says "Join", not "pay"); CLEAR NOW for the second half (`you` was null before payment and filled in after pay_my_share, with the receipt).

## Findings
- CONFUSING: The invitation says "Join or decline" but never says that Join means paying your share. Exact request: pay_my_share(booking bk_4886cdb0d2f2, mandate from whoami.ap2.openPaymentMandate, no amount). Guessed.
- CONFUSING: The "$15 or less" limit compared against my share ($9.66), not the game total ($29.00). Limit is perGame 15.00 in whoami.mandate. Needs Chen-Wei's confirmation.
- CONFUSING: `you`, `owes` and `payout` fields: meaning only guessed.
- MINOR: "realPerson": true is shown next to identityChecked: false. Accurate, but easy to read as verified.
- MINOR: The venue is a sandbox test venue (name says 沙盒) presented in a normal invitation with a real-looking Taipei address. The payment was a sandbox test card. Nothing real moved.

VERDICT: 0 BLOCKER, 0 BUG, 3 CONFUSING

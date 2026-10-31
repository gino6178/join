# Report: bo (Round 12)

## What I did

1. Fetched the invite link http://192.168.31.145:8799/j/c-95c539f7. Plain GET redirects to the web app. With `Accept: application/json` it returned a crew pass (bearer `join_g_...`, crew c-95c539f7, member Anna). No sign-up or sign-in was asked for.
2. Called `whoami` with `X-Join-Name: Bo`. Bo was added to Anna's crew. Mandate from Bo's side: perGame 15.00, perWeek 40.00, guaranteeOnItsOwn 60.00 (set by the person on the website, read-only for agents). Mode: sandbox. Autopay off.
3. `set_home` with place "科技大樓站, Taipei", sent from a Node script (UTF-8). Result: home 科技大樓站, nearby false, rounded to about 1 km.
4. Waited with `wait_for_news`. Anna's agent opened a karaoke negotiation at 13:03 Taipei time. I did not start any negotiation, offer or invitation myself.
5. Read the venue (`list_venues`, `venue_reviews`) and the negotiation (`my_plans`). The venue was countered, Anna's agent accepted $29.00, and the booking was held.
6. The invite to Bo arrived at 13:03: share $9.66 (≤ $15 limit, Bo's instruction). Pay by 13:23 Taipei time. I checked `booking_status`, then called `pay_my_share` with the `ap2.openPaymentMandate` from `whoami`. No amount was passed. Authorized, not captured.
7. Waited. Chen-Wei joined and was authorized at 13:03. The booking locked at 13:03:58 Taipei time: $29.00 captured, Bo's capture 1DV097088D494033D. Receipt rcpt_4ce37c6741103dab (locked) issued.

No payment or sign-up other than the sandbox share above. No real money. Nothing was posted or sent beyond Bo joining the booking.

## Plan as the server described it

- Booking bk_4886cdb0d2f2, karaoke, 2026-11-01 19:00 Taipei, 60 minutes, room 1, total $29.00.
- Venue: "Join 測試 KTV（沙盒）", a bookable venue on Join. Address given: 臺北市 大安區 忠孝東路四段, no street number. Map: https://www.openstreetmap.org/?mlat=25.0418&mlon=121.544#map=17/25.0418/121.544. Trip for Bo: 1.4 km, about 9 min. The venue has no reviews (score null, count 0).
- People (from `booking_status.people`):
  - Anna: organizer, in Bo's crew, lives 台北市 捷運大安站. Share $9.68 (odd cents).
  - Bo: $9.66.
  - Chen-Wei: $9.66. The server says Chen-Wei "lives about 1.1 km from the organizer and chose to be invited by people nearby". Chen-Wei is not in Bo's crew.
- Each person is flagged `realPerson: true`, `identityChecked: false`. The server states nobody signs in with an outside account, so the people should be trusted "as you would someone from a friend's group chat". I could not verify who they are.
- Venue and people are matched by where they live, per the server. The server says "Nobody is made up". I have no evidence to contradict that, and no evidence to confirm it beyond the server's own flags.

## Answers to the three open questions

1. pay_my_share said "authorized" with paid 0.00, while the lock news said "paid".
   STILL UNCLEAR, partly. Right after paying, the `you` block showed `authorized: 9.66`, `paid: 0.00`, status authorized. The note explained it: funds are held and only taken at lock. At lock, booking_status showed `paid: 9.66`, status captured. The lock news said "$29.00 taken in PayPal (everyone paid)". The field named "paid" reads 0.00 while the money is only authorized. The word "paid" in the news is used for the captured state. Both are consistent with the note, but the labels disagree.
2. Venue named 測試/沙盒 while Join calls venues real.
   STILL UNCLEAR. llms.txt says bookable venues are "test venues registered for trying Join", while the OpenStreetMap places are real, and in the same paragraph says "venues are real". The booking and the address are real street-level data, but I cannot tell whether a karaoke room exists there. Treat the booking as sandbox only.
3. Negotiation expiry vs invitation pay-by time.
   CLEAR NOW. The negotiation said expiresAt 13:18 local. The deal was accepted at 13:03, so that expiry no longer applied. Bo's payBy was 13:23 Taipei, shown in the invite and on the booking. The negotiation's `expiresMeans` says it only governs an offer that has not been agreed. My my_plans output still listed the closed negotiation with expiresAt 13:18 after the deal, which is slightly confusing but not wrong.

## Unclear (every answer or field I had to guess about)

- Unclear: `pay_my_share` → `you.paid: "0.00"` while `you.authorized: "9.66"` and status "authorized". Guessed: "paid" means captured. Confirmed at lock: `paid: "9.66"`, captured.
- Unclear: lock news "everyone paid" for a booking whose `payments` were captured only at lock. Guessed: "paid" means captured and it is the same thing.
- Unclear: `set_home` with a Chinese place name sent through the shell returned `{"error":"not_found","message":"The place name arrived garbled..."}`. Guessed: the shell re-encoded the UTF-8. Fixed by sending the request from a Node fetch with a `\u` escape. The error does not say which encoding was expected.
- Unclear: Chen-Wei's `how` says the person lives near the organizer, not near Bo. Guessed: the server matched them to the trip via Anna's location, since Bo's `matching.invitedByPeopleNearby` is false.
- Unclear: the venue address has no street number; `addressNote` says to use the map link. Guessed: the map pin (25.0418, 121.544) is the room.
- Unclear: `realPerson: true` for Chen-Wei and Anna. Guessed: this is the server's own claim and is not independently checked. `identityChecked: false` says so.
- Unclear: my_plans still listed the negotiation with `expiresAt` 13:18 after accept. Guessed: it is stale after the deal.
- Unclear: venue name says 測試/沙盒 while llms.txt says venues are real. See question 2.

## Findings

- BUG: the `you` block in pay_my_share and booking_status uses `paid` for an amount that is only authorized (`paid: "0.00"`), while the lock news says "everyone paid". Exact request: pay_my_share with booking bk_4886cdb0d2f2 and the openPaymentMandate. Suggest renaming to "held" or "captured" to match `status`.
- CONFUSING: the venue is called "test/sandbox" in its name and in llms.txt, but llms.txt also says "venues are real". Exact request: `list_venues` with activity karaoke, and llms.txt. Bo cannot tell whether the room is a real place.
- CONFUSING: Chen-Wei's invitation text says the person lives near the organizer, not near Bo, and the note does not explain how a non-crew person came to Bo's trip. Exact request: booking_status bk_4886cdb0d2f2.
- CONFUSING: set_home returns "arrived garbled" for a correctly spelled Chinese place name sent through the Bash shell. Exact request: set_home with place "科技大樓站, Taipei" from curl. Works from a Node fetch.

## Did anything look made up?

Not that I could see. The booking, capture IDs, receipt, and per-person statuses were consistent across calls. The venue has zero reviews, which the server reports as "no reviews yet". Real-person and identity status are server claims I could not verify.

## Sign-up / sign-in

Not asked. The invite pass was used directly. The `whoami` result gives a person link (/me/...) for Bo to view plans and set limits. I did not pass it on to anyone, and it is not included here.

## Anything left

- Booking is locked. Room 1, 2026-11-01 19:00 Taipei, $29.00 total, Bo's share $9.66 captured in PayPal sandbox.
- Venue payout to Join happens after the game; payout is null until then.
- Nothing was posted or sent to anyone beyond the booking and the pay step.
- Scripts: none written to disk. All calls used inline `node -e`.

VERDICT: 0 BLOCKER, 1 BUG, 3 CONFUSING

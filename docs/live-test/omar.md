# omar report (Join trial 1)

## What I did
1. Made demo account "Omar" (home page, first-name box, Start). Defaults: $15/booking, $40/week, $60 guarantee.
2. Limits: set week $10 (below the $15 booking limit) -> saved with no warning. Asked Join's agent "Badminton this weekend, 4 of us in total": 3 options. Then set week $5 -> options all show "your weekly limit leaves $5.00 that week ... too far over your limit to haggle" and the Negotiate buttons are disabled. Set week $25.
3. Agent: Negotiate this -> "Go ahead" -> agent haggled 3 venues, offered "Book Lakeside $21.00 / North Park $30.60 / Riverside $37.80". Booked Lakeside ($21, $5.25 each, booking bk_6605fd87107d). PayPal sandbox test card "authorized" the $21 guarantee automatically.
4. Plans demo panel: Alex paid; Hana asked $1 less (I chose "Keep it"); Tomas can't come; "Time runs out now".
5. Checked Activity, receipt page, Venue view, signed in as Lakeside (demo), posted a review (3 stars).

## Numbers check
- Told before accepting: "agree to at most $60.00 in total ($15 each for 4)", then "Deal $21.00; you pay $5.25 unless someone doesn't pay (at most $21.00)". Charged: $15.75 captured from Omar (own $5.25 + Hana $5.25 + Tomas $5.25). Alex $5.25. Total $21.00. Adds up, and matches the "at most $21.00" warning. Plans, Activity ("Omar covered Hana, Tomas ($10.50)"), receipt ($15.75 / $5.25 / none / declined) and venue reconciliation ($15.75 + $5.25) all agree.
- Omar's real loss: $10.50 for a friend who said can't come and one who never answered; nothing in the UI tells him how to get it back (see below).

## Findings
BUG: Plans card did not update after "Time runs out now". Right after the click (and 4 s later) the card still read stage "Guaranteed", Omar "in - held in PayPal", Alex "held in PayPal", and the Cancel/demo buttons were gone; only after a page reload did it show "Paid and locked", "$15.75 (covered others)" and the receipt link. A live view that lags/needs a reload is misleading when money moved.
BUG: Activity header for the booking says "Paid and locked ... everyone paid" while Hana never paid and Tomas declined (and the same card says Omar covered $10.50). Should say "paid in full" / "covered".
BUG (inconsistency): Activity says the venue "holds court 1 for 10 minutes while Omar authorizes"; Plans/Activity then say held "until 05:22" (about 20 minutes).
CONFUSING: Limits accepted weekly $10 < per-booking $15 with just "Saved." No warning that the booking limit can never be reached. Effect only discovered in the agent ("your weekly limit leaves $X that week", red text), and with a $5 week the button is disabled with the vague "too far over your limit to haggle" (on a fixed-price, no-haggle venue; it just means "over limit").
CONFUSING: Per-booking limit is "your share" ($15) but Omar actually paid $15.75 for one booking because covering friends does not count against it (only the guarantee limit, $60, and the week). Limits page never shows how much of the week is used. Agent says "I'll aim for $15.00 a person" and "agree to at most $60" while real prices were $5-$9 each; the $60 ceiling reads like what he owes.
CONFUSING: Agent's offers go DOWN each round ($18.91 -> $17.51 -> $16.11, North Park $22.69 -> $22.27 -> $21.85) while the venue's counters drop; a skeptic would ask why it bids against itself. Also the agent opened three negotiations and walked away from two; each run leaves stale "Open" negotiation cards (I had 3 extra Open ones from an earlier run) on Plans, repeated under the same venue names with no date/id, so Plans is a long confusing list.
CONFUSING: Agent recommends the cheapest first (Lakeside, rating 3.5, worn equipment complaints, farthest trip 32 min, and the chat noted someone in the group minds worn equipment) with the primary button; the trade-off is only visible in the option list a screen earlier.
CONFUSING: After "Keep it" on Hana's $1 ask, no visible message to Omar in Plans except the result in activity ("Omar's agent kept Hana's share" attributed to "Your agent" though I clicked). Fine, but "You would cover $1.00 more" is the only cost cue and there is no total.
CONFUSING: After lock, Plans says "You can ask anyone who joined and didn't pay to pay you back." but there is no button; Hana never "joined" and Tomas declined, so Omar has no recourse shown. The brief promise "anyone who said yes and didn't pay gets a PayPal invoice" never came into play and nothing says why Hana (invited, silent) wasn't invoiced.
CONFUSING: Receipt page: "Waiting for the next batch / batches close every few minutes" - still waiting 5+ minutes later (log size 0, receipt batch null, /api/receipts/log/checkpoint 404). The in-browser check says "complete and unchanged" (verifies), but the transparency-log part never completed. Footer says "node examples/verify-receipt.mjs ... --save checkpoint.txt", a developer-only file a normal user doesn't have.
CONFUSING: Receipt "You are in this receipt as f9a638bf..." hashed ids; other rows are unidentifiable hashes, so Omar cannot see which row is Hana vs Alex. Fine for privacy but he cannot tell who didn't pay.
BUG (minor): Venue view reconciliation shows raw ids: "share (u_4e28e195e5)" and "share (you)" (the latter is Alex's internal id, "you" is meaningless to a venue).
MINOR: Review score inconsistent: API returned score 3.4 / average 3.1 / count 8; venue page shows "3.5 from 13 reviews". Option card earlier showed raw "quiet" as complaints key mapped to "noisy" (odd naming, an aspect labelled "quiet" is a praise tag).
MINOR: "Reviews open after the game" but demo button lets me review before the game; the review is then shown as "booked and paid on Join" while the game has not happened.
MINOR: Cancel booking button remained visible in Plans on the Guaranteed card; I did not test it after lock (after reload it still shows on the locked booking). Unclear what it does after payment.
MINOR: Venue sign-in: "Sign in as Lakeside School Gym (demo)" works without password, sidebar still says Omar; venue also sees a "Bill extras" form that could invoice the organizer (not tested).
MINOR: On first home page, clicking text "Start" via page text matched marketing copy; button fine for real users.

Worked well: demo account; limits saved and enforced before a venue sees an offer; disabled button when over weekly limit; every figure reconciles to $21.00; receipt verifies in browser; venue view shows only totals (no customer names) and states the $10.50 covered.

VERDICT: 0 BLOCKER, 4 BUG, 9 CONFUSING

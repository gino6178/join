# nina2 (round 2, first-time visitor, laptop 1280x900)

## What I did
1. Opened http://192.168.31.145:8797 in a fresh browser (Chinese system locale), read the landing page, switched 中文/English, made demo account "Nina Two" (Riverside).
2. Drawer: "I want karaoke with 3 friends this weekend, about $15 each" -> 3 Echo Karaoke options -> Negotiate this -> consent -> Go ahead -> deal $23.40 ($5.85 each), sandbox card authorized.
3. Plans: opened Signed authorizations, played Alex (Pays), Hana (Asks $1 less, then Keep it), Hana and Tomas pay -> Paid and locked. Opened the receipt. Made a second karaoke booking to re-test the drawer.
4. Activity, Plans, Map (all pins, squares, popups, both popup buttons, blue circles, Show around me), Limits (Save limits, Save PayPal for my agent), Connect (Copy, Make a token, Advanced), Venue view (venue chips, date chips, Sign in as Echo Karaoke, reconciliation, Bill extras). Vague drawer messages. 中文 on every page. Screens in scratchpad/shots/nina2/.

## Round-1 findings: status

### BUG list
1. Other testers' data in my account: FIXED for my fresh account. Activity, Plans and Map only show my own booking; no stray North Park Gym booking, no "Waiting on you" card; the group was built from demo-town residents only (Alex, Hana, Tomas), not "Ines, Mei, Weiting". Caveat: I used a new name, so I did not reproduce round 1's exact name clash. Related leftover: Venue view > Reconciliation (after "Sign in as Echo") still lists other customers' shares by first name ("Mei's share", "SecA's share", a "Nina's share" from round 1).
2. Deep link `#/games?booking=...` does not scroll/highlight: NOT FIXED. With 2 bookings, `#/games?booking=bk_54a5b16c26c0` (my older one) opens Plans at scroll 0 with the newer booking (room 4) on top and nothing highlighted. Newest first is at least sensible.
3. "Go ahead" inconsistency: FIXED. Both negotiations (two runs, same user) stopped at "Go ahead / Not this one" first. Duplicate search lines in Activity: I made 2 searches myself, so 2 lines are legitimate; cannot confirm either way.
4. "billed $12.00 (sent)" under Bill extras: not on my booking this time (it is on room 2, someone else's). I did not send an invoice on mine, so whether a customer is told stays untested.
5. Reconciliation "Loading..." never finishes: FIXED. Now "Asking PayPal for its records... (a few seconds)", and a table appeared within 20 s (rows say "confirmed by PayPal (completed); not in transaction reporting yet").
6. Connect > Copy shows "Copied" with no clipboard: NOT FIXED / unverifiable. `navigator.clipboard` is still undefined on this http address and the button still turns to "Copied".
7. Save PayPal for my agent leads to a real sandbox PayPal login: PARTLY. Limits now says "On this demo, saving PayPal needs a PayPal sandbox buyer account (made on developer.paypal.com); a real PayPal login won't work here." Good warning, but the button still sends Nina to www.sandbox.paypal.com asking for an email (page in Chinese), only "Cancel and return to Join" to leave. Nina still has no way forward.

### CONFUSING list
- Landing "(see the README)": NOT FIXED, same line. "Reset the demo town": NOT FIXED, still offered to everyone with no warning (I did not click it). The three feature lines (Connect your agent / Set your limits / Watch it work) still look like links and are not clickable (URL unchanged after clicking): NOT FIXED.
- Drawer header: PARTLY. "Qwen (qwen2.5:0.5b)" is gone; now "Runs on Join's own server, with a small language model for free-form sentences · no outside AI service". Better, still developer-ish.
- Fake friends: NOT FIXED (Alex, Hana, Tomas, or Aisha, Kenji, Priya, no hint they are demo residents; real friends cannot be invited). "picked by everyone's trip, price and verified reviews": NOT FIXED. "$32.40 asked" vs chart "list $36.00" vs $23.40 final: NOT FIXED. Small help: reviews now say "(demo data)"; a too-expensive option says "too far over your limit to haggle".
- Consent text: NOT FIXED. Same long paragraph, same "Go ahead" button.
- Drawer history vanishes on reload: NOT FIXED (full reload gives the starter screen; it survives in-app navigation). Vague messages: NOT FIXED. "hello", "what is Join?" and "pizza tonight for 2 under $5" all get the same "What would you like to do? Badminton, karaoke..." line.
- Plans words: NOT FIXED. "Signed authorizations (AP2)" opens raw JSON (mandate.payment.open.1, conditional_transaction_id, cents 2340 / 6000 / 1500 next to "max": 40). "Demo: play your friends" and "Time runs out now (you cover whoever hasn't paid)" unchanged. Third button now "Can't come".
- Times: hold deadline shown as 05:40 etc. (San Jose time, no label); 20-minute hold unchanged. I did not re-check Connect's token timestamp.
- Receipt: NOT FIXED. Still "SHA-256", "Ed25519, key join-mvuwuvn7", "Waiting for the next batch / batches close every few minutes", "hashed with your salt", "node examples/verify-receipt.mjs ...". No venue name, friends are hashes, only "room 3". Not a booking confirmation you could show at the door.
- Map: PARTLY. Legend now has "Your booking" (purple) and the side panel explains the purple pin and dashed trip lines, and shows MY booking. Still: venue pins are plain white circles; "Over your budget"/"Alternative" colours never appeared on the map for me, so they stay unexplained; blue circles and dashed lines do nothing on click; "Show around me" now says "Your browser only shares your location with secure (https) sites, and this demo server isn't one, so the map stays where the sample town is." (friendlier, still nothing visible happens). "Plan here with Join's agent": PARTLY, it now opens the drawer with the box pre-filled ("karaoke at Echo Karaoke this weekend, ...") but not sent, starter chips still shown. Echo popup "$36 per hour" vs deal $23.40: NOT FIXED. "Its rooms and courts" link works.
- Limits wording: mostly FIXED. Each field has a one-line explanation. "PayPal Vault" still unexplained jargon. Save works ("Saved. Your agents see the new limits on their next step.").
- Connect: NOT FIXED for a person with no agent (terminal commands, curl, A2A). Make a token still prints the full token in every snippet (now adds "Copy it now: Join keeps only a hash and can't show it again", good).
- Venue view: PARTLY. Timeline now fits (1 PM to 11 PM, Sat 10/31), no hidden horizontal scroll. Still: it sits in the customer menu, shows other customers' bookings and totals ($52.80, $58.80), opens on today (10/30) so the booked day needs the 10/31 chip, only Rooms 1-5 are drawn although page text lists Room 1-8, booking blocks are cut off ("$23.4"), left hour label clipped ("M"), nothing marks which block is mine. "Sign in as Echo Karaoke (demo)" still turns me into the venue owner while the sidebar still says "Nina Two". Words "off-peak", "list_disputes", "Reconciliation" remain.

### MINOR list
- Blue "PayPal sandbox: test money" chip: relabelled; not clicked this round.
- Floating "No agent? Ask Join's" button still overlaps the right edge of the Plans card at 1280 wide: NOT FIXED.
- Demo friend buttons shift once one friend pays: NOT FIXED.
- No "booking confirmed, here is what to do next": NOT FIXED. Activity says "Room 3 at Echo Karaoke is locked: $23.40 paid (everyone paid)" and Plans says "Paid and locked", but no plain "You're booked: Echo Karaoke, Sat 6 pm, room 3, what to do next".

## Language switch (中文 / English)
- Works from the landing page and the sidebar; the choice persisted across pages. English mode is fully English.
- On first load in my Chinese-locale browser the landing page was a half-and-half mix: sign-in heading "登入", "第一次來？建立示範帳號", "開始", "或扮演示範城鎮裡的居民" in Traditional Chinese, while the hero, the README line, "Reset the demo town" and the resident list stayed English. Feature line "連接你的 agent" Chinese with an English subtitle.
- 中文 mode translates only the frame (sidebar, page titles, status chips, some buttons). Still English in 中文 mode: all Activity sentences and group titles ("Paid and locked", "Show all 21 steps", "Searches"), Plans table words ("organizer", "guarantees $23.40"), the Negotiations chart, Map intro and side panel, most Limits help text and the PayPal box, the whole Connect page, the Venue view body, the Receipt. A Chinese-only reader hits large English walls.

## New findings
- BUG: Drawer carries a budget over from an earlier message: after "pizza tonight for 2 under $5", "escape room tomorrow for 4" searched "about $5 each" and then said "Even the venue's lowest is over your $15.00 a pers..." (mixes the old $5 with my $15 limit).
- BUG: Plans does not update when the last friend pays. After Tomas paid (4 of 4), the page still said "Guaranteed" / "in · held in PayPal" with no receipt link after 4 s; after a reload it said "Paid and locked" with the receipt link. A person would think it is stuck.
- BUG (privacy): Venue view > Reconciliation (any demo user can reach it via "Sign in as Echo Karaoke") shows other customers' first names and booking ids ("Mei's share", "SecA's share").
- CONFUSING: Drawer "karaoke Sunday for 4, $15 each" gave no options within 5 s and I saw no explanation; "this weekend" wording worked.
- CONFUSING: Activity lines carry raw order ids ("order 5M5427602K142302N") and labels like "demo: played by the organizer".
- MINOR: Chart y-axis ticks $17 / $26 / $36 are odd values.

## Worked well
Account creation, drawer search with "(demo data)" reviews, visible haggle rounds, consistent "Go ahead" consent, sandbox auto-authorize, friend demo buttons (Pays, Asks $1 less with Keep it/Agree, Can't come), "Paid and locked", receipt verifies in the browser, Limits save, token creation, Reconciliation now loads, Map side panel shows my booking, "Plan here" pre-fills the drawer.

Round-1 tally (7 BUG + 11 CONFUSING + 4 MINOR items): FIXED 4 (data leak, Go ahead, Reconciliation, Limits wording), PARTLY 6, NOT FIXED the rest.

VERDICT: 0 BLOCKER, 3 BUG, 4 CONFUSING (new this round)

# verify: re-check of round 4 fixes (demo account "Verify", Lakeside, no crew code)

Steps: made a demo account (Lakeside, no crew) on the website; laptop 1280x900 (English UI), then phone 375x812 zh-TW (touch emulation).
Raised my Limits to $40 / $100 / $150 to be able to book; asked Join's agent for hot pot Sat 6pm for 4 at $30 each, negotiated ("Go ahead"): deal $98.00 ($24.50 each), I guaranteed it.
Not in the crew: the other three people in the plan were Alex, Hana and Tomas, Join's simulated residents, not real testers. So "the plan happened among friends" does not apply here.

## Results of the 8 fixes

1. Plans updates by itself after friends pay: FIXED. Two tabs on my own plan. I clicked "Pays (sandbox card)" for Alex in tab B. Tab A (not reloaded) showed Alex "in · held in PayPal" at the next 5 s check (about 8 s after the click) and stayed correct.
2. NT$ budget over the venue's lowest: FIXED. "週六晚上火鍋 四個人 每人300台幣" gave: "超過你說的預算（每人 $9.38）：場地最低大約每人 $18.15（約 NT$581）。想試的話，告訴我更高的預算。" The agent also said "NT$300 ≈ $9.38 (1 USD = 32 NT$)". Small leftover: the same card's headline still says "$25.20 每人 · 超出上限太多，談不下來" (over the LIMIT, though it was over the budget; my limit was $15). In English, when the cause is my own limit, the card says "Even the venue's lowest is over your $15.00 a person" with no figure for the venue's lowest.
3. New activity doesn't inherit a budget: PARTLY. "karaoke saturday 4 of us under $10 each", then "hot pot saturday 4 of us" gave $15.00 (my default), so no inheritance there. But "pizza under $5", then "escape room sunday 4 of us" gave "Looking for escape room for 4, about $5 each…" So the $5 was inherited when the first message wasn't a known activity (pizza got "What would you like to do? Badminton, karaoke…"). Exactly the case you named is NOT fixed.
4. Receipt says booked with venue name: FIXED. "You're booked. Westgate Hot Pot House, table 2, 2026-10-31 18:00, 90 min · $98.00" (zh: "訂好了。 Westgate Hot Pot House, table 2, ..."). Note the sentence is still English-ish in zh.
5. "Open the plan" link scrolls: FIXED, with the caveat that I only had one plan. From Activity, #/games?booking=... opened with scrollY=132 and the booking card at the top of the screen (header "Plans" scrolled off). Not tested with many plans.
6. Connect page Copy: FIXED. The page is http on a LAN IP (isSecureContext=false, no navigator.clipboard) yet the button turns to "Copied" and the real clipboard held the command (checked in headed Chrome via Get-Clipboard). Headless Chrome did not change the OS clipboard, so I rely on the headed run.
7. Phone: PARTLY, see below.
8. Venue view timeline: FIXED. Westgate Hot Pot House opened with the strip showing 2 PM..11 PM and the 6 PM $98.00 booking in view, not 7 am. (Bar label truncated to "$98.00 ho".)

## Phone (375x812, zh-TW)
- Bottom tab bar: present, 6 tabs (動態 計畫 地圖 上限 連接 場地端), works, no horizontal scroll on most pages.
- 中文/English switch: works, but is a floating text at the top right of every page (see BUG 2).
- Round agent button: does not cover page content at the bottom (pages leave space), BUT it sits on top of the last tab "場地端" and covers it (BUG 1). Its label "沒有 agent？問 Join 的" is clipped by the circle (text overflows above and below).
- How much is English: Join-written text in Activity is entirely English (all event lines, "Paid and locked", "simulated resident", "Searches", "Alternatives"): about 22 of 41 lines. Plans: "Negotiations", "Agreed at $98.00", chart labels (round 1..3, list $112.00), "Discounts: group: 4 people", "Signed authorizations (AP2)", "Receipts:", "PayPal sandbox", "You covered Hana, Tomas: ... You can ask anyone ...", table "organizer"; Connect: 44 of 62 lines English (all token explanations, the capability list, WebMCP text); Venue view: "Place", "Table 1..12", "held while the group pays"; Receipt: about 28 of 45 lines English; Limits: the PayPal Vault block. Translated: tab names, headings, Limits form, Map mostly, agent panel (the agent answered a zh-TW message in zh with cards translated), plan progress steps, table headers.

## New findings
- BUG 1 (phone): round agent button overlaps the 場地端 tab, hiding half its label; its own label overflows the circle. Every page.
- BUG 2 (phone): the language switch and avatar (and logout icon) float over the page content at the top right with no background: on Plans they overlap the booking title and the "已付清鎖定" badge, and on the bottom of Plans they overlap the "PayPal sandbox" line/"現在結束比賽" text; on Receipt the logout icon is cut off at the right edge.
- BUG 3 (phone): Receipt page is wider than the screen (scrollWidth 406 on 375).
- BUG 4 (phone, Plans table): the status column is squeezed so Chinese status words break one character per line ("已 / 付", "不 / 參 / 加").
- CONFUSING: Activity line "Table 2 ... is locked: $98.00 paid (everyone paid). Verify covered Hana, Tomas ($49.00)." says everyone paid although two people declined; the plan page state says "Paid and locked" too.
- CONFUSING: Hana and Tomas (simulated) said "can't come: $24.50 is over their $15.00 limit" within about 1.5 minutes. Join's agent aimed at my $30 each, not at what the invitees could afford, so half the group dropped and I paid $73.50 for a $98 booking. The weekly cap then showed up on the next search ("你的每週上限那週只剩 $26.50") on a card with $8.78 each, which is clear enough only once you know the guarantee is counted.
- CONFUSING: with no crew, the invitees are the town's simulated residents, and Westgate Hot Pot House was the only choice for hot pot. 
- MINOR: the agent chat is lost when you reload the page (also "New plan" button is gone until you type).
- MINOR: Activity events (and the receipt's negotiation list "Organizer's agent offer $70.57") stay in English in the zh-TW UI.
- MINOR: venue timeline bar label "$98.00 ho" truncated; with the 2 PM..11 PM window the first column "1 PM" is half cut at the left edge.

Screenshots: <scratch>/shots/verify/

VERDICT: 0 BLOCKER, 4 BUG, 3 CONFUSING

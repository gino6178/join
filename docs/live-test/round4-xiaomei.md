# xiaomei report (小美, phone 375x812, touch, zh-TW, website only)

## Steps
1. Opened http://192.168.31.145:8799 in mobile emulation. Home page is Chinese with some English blocks. Created demo account: name 小美, area Midtown, crew code crew4 (no password asked). storageState saved to shots/xiaomei/state.json and reused.
2. Polled Activity (#/activity) and Plans (#/games) about every 40s without and with reload.
3. About 5.9 min in, the Ana-Echo Karaoke negotiation appeared in Activity (and Plans, "Negotiations"). At about 7.3 min a "Waiting on you / You're invited: karaoke, 2026-10-31 14:00 / Echo Karaoke - room 1 - your share $7.35 - answer by 11:05" card appeared with "Can't make it" and "Join and pay".
4. Tapped "Join and pay" (10:47:28). PayPal sandbox test card authorized $7.35 (order 92481030YX6675239). No separate PayPal screen, one tap.
5. Kept the Plans page open without reloading. Bo (10:46:46) and Chen (10:49:45) joined and paid. At 10:49:58 Activity said "Room 1 at Echo Karaoke is locked: $29.40 paid (everyone paid)" and the card read "Paid and locked".

## What the others did (as seen)
Ana (organizer): negotiated $32.40 -> $29.40 for karaoke Sat 2026-10-31 14:00, 60 min, room 1; guaranteed $29.40. Bo paid $7.35. Chen paid $6.35. I paid $7.35. Ana's row showed $8.35. 8.35+7.35+6.35+7.35 = 29.40, so it adds up. Only the four of us, no strangers seen.

## Findings
- Activity updated by itself with no reload (negotiation steps, the invitation card, Bo's/Chen's payments, lock). Good.
- CONFUSING: invitation said "your share $7.35" for everyone (equal split), but the final Plans table shows Ana $8.35 and Chen $6.35, with no explanation (Ana paid $1 more, Chen $1 less). Total is right, but the invitation/Ana's "own share is $7.35" message contradicts the table.
- CONFUSING: the invitation card ("Waiting on you", "You're invited", "Can't make it", "Join and pay", "Echo Karaoke - room 1 - your share...") and the negotiation/activity timeline, "No bookings yet.", "Negotiations", "Agreed at $29.40", "Friends paying", "Paid and locked" and the "問 Join" footer are English on a zh-TW phone; the page header/nav is Chinese. A Chinese-only reader would have a harder time noticing it is her invitation and what she owes. The amount is in a "$7.35" line in small gray text, not the headline.
- BUG (layout, phone): in the invitation card the title/details are squeezed into a very narrow column (about 60px, one or two words per line, 8+ lines) because the two buttons sit beside it; "Join and pay" overflows the card's right edge (button x 252-374, card edge about 358). Tappable though.
- BUG (layout): the floating black "問 Join / agent?" bubble is clipped (text cut off at the top: "agent ? / 問 Join") and covers the rightmost bottom tab (場地端 is partly hidden/unreadable) on every page.
- BUG (layout): on Plans the member table is wider than the screen: the "方式" column is cut off at the right edge and the status chips wrap into tall narrow pills ("已加入 · PayPal 預先授權" over 3-4 lines). Bottom tab bar and the bubble also cover table rows when scrolled.
- MINOR: plan stepper labels wrap awkwardly ("已付清鎖定" shows as "已付清鎖 / 定", "已付給場地" as "已付給場 / 地"). Date shows "Sat, Oct 31" in English.
- MINOR: the 5.9 min wait before anything appeared is the friends' pace, not a site fault. The Plans page snapshot I captured at the moment Chen paid still showed the status chip "已擔保" and the stepper on step 2 while the table already showed everyone joined; Activity said "Paid and locked" seconds later. 20s later, without reload, Plans caught up: all four rows "已付", stage "已付清鎖定", receipts shown.
- No invitation was visible as a notification outside the app (no badge on the 動態 tab); I only saw it by looking.

I paid: $7.35 (sandbox test card, authorized/held in PayPal). Plan locked: yes.

VERDICT: 0 BLOCKER, 3 BUG, 2 CONFUSING

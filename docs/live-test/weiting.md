# weiting report (phone 375x812, touch, zh-TW locale)

## What I did
1. Opened http://192.168.31.145:8797 on the phone. Signed up as "Weiting" with the demo form.
2. Opened "Plan something" and typed `這週六晚上想跟三個朋友吃火鍋 每人300台幣以內`. The agent found 2 hot pot options, but both "去談這個" buttons were disabled.
3. Typed `週日下午打羽球 四個人`, tapped 去談這個, then 好，開始談. It booked North Park Gym for $30.60 and PayPal authorized the guarantee (sandbox card). Then on Plans I tapped "Pays (sandbox card)" for the 3 friends, and all show "in · held in PayPal".
4. Visited Map (pan, pin popup, close, "Show around me"), Limits (changed per-booking to 30 and per-week to 80, saved, reloaded), Connect, Venue view. Tried "Save PayPal for my agent", which went to PayPal sandbox (I stopped there and entered nothing).
5. After raising the limit to $30, repeated the NT$300 hot pot request.

## Findings

BUG: The agent ignores a budget in NT$. "每人300台幣以內" was never read as a number: the reply said "我會以每人 $15.00 為目標", and $15.00 was my per-booking limit. After I changed the limit to $30 the same sentence gave "$30.00 為目標". Nothing mentions NT$ or an exchange rate, or says the budget wasn't understood. The user thinks 300 NT$ was honoured.

BLOCKER (for the NT$300 hot pot): Both hot pot options are shown with the buttons greyed out and the text "超出上限太多，談不下來". The agent doesn't say how to fix it (raise the limit on the Limits page, or change the request). The default limit is $15 per booking and nothing links to Limits. The dead end only goes away if the user finds Limits (an icon-only nav) and raises it. With $30 it works.

BUG: Hot pot cards show two entries of the same venue (18:00 and 20:00) and the same Westgate Hot Pot House. The "超出上限太多" disabled buttons have no reason shown on tap.

BUG: "North Park Gym 價格最好：$30.60，就訂這家" but the same transcript shows Westgate Badminton Club's last price at $27.72, which is lower. The claim "best price" is false (maybe it also weighs travel time, but it says price).

CONFUSING: Money is in USD only, with no NT$ shown anywhere, for a Taipei student. The town is "placed on San Jose, CA" (stated only in small print on Map). The date/time "週六 10/31" works, but Join is in California.

BUG (half-translated): The chat replies are Chinese, but the rest of the site stays English even with a zh-TW browser and Chinese chat: home page, Activity feed ("Show all 4 steps", "Other places nearby", "See them on the map", "Open the plan", "Searched"), Plans ("Pays (sandbox card)", "Asks $1 less", "Can't come", "Time runs out now...", "Negotiations", "Cancelled"), Map, Limits, Connect, Venue view. The chat's own suggestion chips are English except one. There is no visible language switch. The chat header "Rules, and Qwen (qwen2.5:0.5b) on Join's own server when they don't understand · no AI service, no key" is English and developer-speak. The Chinese cards say "示範資料" and also mix "開價/還價" with English venue names. The PayPal page was Chinese (it has its own language toggle).

BUG (phone layout, nav): Top nav is 6 icon-only links, each 34x36 (below the 44px tap size), with no text labels; the icons are about 10px. The "Sign out" button sits at the right edge and is cut off (14x37 visible, only a sliver at x~355-375, no label). The header has a big empty band on top of the Activity page.

BUG (phone layout, overlap): The floating "No agent? Ask Join's" button (fixed, bottom right) covers content on every page: the Limits "Venues / Any venue" radio, the Plans table row (Mei $7.65), the Map caption, the "Save PayPal for my agent" button. On Plans the "Paid and locked / Venue paid" step labels are squeezed and wrap oddly ("Deal / Guaranteed / Paid and locked"), the status column wraps into one word per line ("invited, no answer yet"), and the venue title "North Park Gym" is cramped next to "· court 6".

BUG (tap size): Chat close "x" is 22x37 and tiny; map pin popup close "×" is about 12px; map pins are 12-16px circles, mostly overlapping in a tight cluster; the zoom +/- are 30x30; Limits radio buttons and Connect checkboxes are 13x13. The map pins and a home-area tooltip fight: tapping a pin sometimes shows "Mei: home area" instead of the venue.

CONFUSING (Map): the legend says green = "Alternative", but the green pin is North Park Gym, the venue I had just booked ("locked"). The box under the map says "The fairest venue: the one where the longest trip in the group is shortest.", which doesn't explain a "locked" booking. The intro says "click one" (not "tap"). Map pan by touch works, popup opens and closes, "Plan here with Join's agent" and "Its rooms and courts" links are present (did not follow).

CONFUSING (Limits): "Save limits" gives no visible message on the phone (the page doesn't scroll to or show a toast; values persist after reload, so it did work). "Most for one booking (your share)" has no hint that it is also the agent's per-person target and silently blocks bookings. Fields are in $ only. Checkboxes "on" labels are just "on" for accessibility.

CONFUSING (leaving the site): "Save PayPal for my agent" navigates away to PayPal's sign-in with "取消並返回 Join" (works as a way back, not tried). No warning beforehand.

CONFUSING: "Show all 4 steps" / "Show all 18 steps" and a feed full of repeated "looked for badminton for 4 people on 2026-11-01: 2 options" lines for each search (I searched badminton twice, got 2 lines + extra). ISO date "2026-11-01" in the feed vs "11/1（日）" in chat.

MINOR: Plans shows the "Demo: play your friends" panel, which a real user would not understand; after all friends paid the panel disappears, but the stage bar still reads "Guaranteed" at the top of the card rather than "Paid and locked" (I could not confirm which stage was highlighted).
MINOR: Connect page code blocks (curl, JSON) are for developers; "Ed25519 public key, base64url" appears in a form field a student wouldn't understand; fine for the Connect page but not translated.
MINOR: Agent text says "你要先在 PayPal 擔保整筆金額" before I agreed; it is clear, but "擔保" and "AP2" ("Signed authorizations (AP2)") are jargon.
MINOR: Venue view lists venues with no hint how to pick; "Sign in as Westgate Badminton Club (demo)" is a developer/demo control shown to every user.

No horizontal scroll on any page (scrollWidth 375 everywhere).

VERDICT: 1 BLOCKER, 5 BUG, 5 CONFUSING

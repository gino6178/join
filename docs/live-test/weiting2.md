# weiting2 report (round 2, phone 375x812, touch, zh-TW), account "韋婷2"

## What I did
1. Opened the site on the phone, made demo account 韋婷2.
2. Chat: `這週六晚上想跟三個朋友吃火鍋 每人300台幣以內` (blocked at limit $15, then at $30 and $40 too), then the same without a budget (works).
3. Followed the "去調高上限" link to Limits, changed values, saved.
4. Chat: `週日下午打羽球 四個人` (no options), `週日打羽球 四個人` (1 option, 10:00), 去談這個, 好，開始談. Booked Midtown Community Gym $33.54, PayPal guarantee authorized (sandbox card).
5. Plans: paid for the 3 friends with the demo buttons (all show "已加入 · PayPal 預先授權"). Looked at Map, Limits, Connect, Venue, Activity.

## Round-1 findings, one by one
- NT$ budget ignored (BUG): FIXED. Reply: "每人約 $9.38（NT$300 ≈ $9.38，以 1 美元 = 32 台幣換算；Join 的價格都是美元）". Target is now $9.38. Money still shown in USD only.
- Hot pot dead end, nothing explains it (BLOCKER): PARTLY. Cards now give a reason ("場地最低也超過你每人 $15.00 的上限。") and a "去調高上限" button that opens Limits. But it is a new dead end: with the NT$300 budget the target is $9.38 and the venue costs $25.20 each, so it stays greyed out even after I raised the limit to $30 and then $40 (the card then says "超過你每人 $40.00 的上限" which is false: 25.20 < 40). The limits page cannot fix it; only dropping the budget does (without the budget the buttons were enabled, target $40). The message blames the limit when the cause is her NT$300. Also nothing tells her the real price is about NT$806 each.
- Two cards for the same venue (18:00 / 20:00) (BUG): NOT FIXED. Two identical Westgate Hot Pot House cards, differing only in time. Disabled-button reason is now shown, so that half is fixed.
- "價格最好" claim false (BUG): FIXED. Agent now says North Park Gym was cheaper ($30.60) but less than $1 per person, so it picked Midtown ($33.54) as chosen. No false "best price".
- USD only / San Jose (CONFUSING): PARTLY. NT$ conversion is explained in chat; the site itself is still all USD and "placed on San Jose, CA" is still small print on the map.
- Half-translated site (BUG): PARTLY. Nav, home sign-in, Activity, Plans labels, Limits labels, map legend are now Chinese; there is an "English" toggle. Still English: home page body text, chat greeting and header ("Runs on Join's own server, with a small language model..."), the chat suggestion chips (3 of 4), Activity empty-state second sentence, Limits help texts (weekly cap, guarantee cap, PayPal vault), "Saved. Your agents see the new limits..." message, Map intro and caption, the Plans card ("court 1", "badminton · Sun, Nov 1", "guarantees", "organizer", "Shares due by", "Negotiations", "Cancelled", "Agreed at", chart labels, "Discounts: group: 4 people (4+)"), transient statuses "starting" / "creating" / "invited", Chinese/English mix inside demo friends panel ("$8.38 · invited").
- Nav icon-only, tiny, Sign out cut off (BUG): FIXED. Bottom tab bar with labels (動態/計畫/地圖/上限/連接/場地端), each about 63x60; Sign out is a 44x44 icon. (Labels are small, and the floating button covers part of the bar, see below.)
- Floating "沒有 agent？問 Join 的" button covering content (BUG): NOT FIXED. It still sits bottom right on every page, now overlapping the tab bar labels for 地圖/上限/連接, and the Plans member rows. Plans status column is still squeezed into narrow wrapped text ("已加入 · PayPal 預先授權" breaks into 3 lines), the stage labels ("已付清鎖定", "已付給場地") still wrap, "court 1" still orphaned from the venue title.
- Tap sizes (BUG): PARTLY. Chat close is 44x44 now, map zoom 40x40. Map pins are still 16x16 and crowded; Limits radios 20x20 (was 13).
- Map legend wrong green/"Alternative" (CONFUSING): FIXED. My booked venue is a purple pin, caption explains "The purple pin. Join picked it as the fairest venue..." and legend has 你的預約. Intro text still says "click one" and is English.
- Limits "Save limits" no feedback (CONFUSING): FIXED. "Saved. Your agents see the new limits on their next step." appears under the button (English). Per-booking field now says "agent 會以這個金額為每人目標，超過的 Join 會擋下。"
- Save PayPal leaves site with no warning (CONFUSING): not re-tested (I did not go to PayPal this round). The section now says in English that a PayPal sandbox buyer account is needed.
- Feed repeats / ISO date (CONFUSING): NOT FIXED. Activity still says "on 2026-10-31" and "Show all N steps" groups (4, 5, 7, 8, 11, 13 steps) in English.
- Stage bar after everyone paid (MINOR): NOT FIXED. All 4 members show "已加入 · PayPal 預先授權" but the card badge and bar still read "已擔保" with only 2 segments filled; "已付清鎖定" never highlighted.
- Demo panel "示範：扮演你的朋友" (MINOR): PARTLY. Now Chinese with explanation "每個按鈕就是那位朋友自己的 agent 會做的事", still a demo control in a real user's plan view. The panel shows "現在截止（沒付的由你代墊）" which is clear.
- Connect page jargon, "擔保"/AP2, Venue view "Sign in as ... (demo)" (MINOR): did not re-read in detail; Connect and Venue pages open fine, Connect text is English.
- No horizontal scroll: still true (scrollWidth 375).

## New findings
- BUG: Wrong cap in the "can't negotiate" card (see hot pot above): "超過你每人 $40.00 的上限" when the shown price is $25.20 each. The real blocker is the NT$-derived target $9.38. The chat never offers "raise your budget / drop it".
- BUG: `週日下午打羽球 四個人` (and 三個人) returned "11/1（日） 13:00–18:00 沒有合適的：需要 3 位喜歡羽球而且那時有空的朋友，加上有空位的場地。換一天、放寬時間，或少幾個人試試。" Without "下午" it found one option at 10:00 on Sunday morning. The agent never told me that option is not in the afternoon, and I had asked for the afternoon. The no-match message doesn't say whether friends or venues are the problem. (Other testers share the town, so availability may differ from round 1.)
- CONFUSING: Before booking the agent says "我最多同意總共 $160.00（4 人，每人 $40.00）" while the venue's price is $33.54 total; the 160 is the cap, not a price, and it exceeds my $150 guarantee limit that I had set a minute earlier. Reads like a price quote. Also the pre-booking message says "不要這個" / "好，開始談" with no price shown yet beside the single card ($35.10 list).
- CONFUSING: The Negotiations list on Plans shows the two venues the agent compared as "Cancelled" cards, which looks like failures to a user. North Park Gym is "Cancelled" though it was cheaper.
- CONFUSING: Plans chart shows "list $39.00" for Midtown but chat said the opening ask was $35.10 (group discount applied?). Numbers differ between the card ($35.10), the chart ($39.00) and the final ($33.54) without explanation.
- MINOR: Chat header says "small language model... no outside AI service", English and developer-speak, unchanged.
- MINOR: Chat greeting "Hi 韋婷2" is English even though the suggestion chip and the user's Chinese; the chat answer language follows the user.
- MINOR: Limits per-booking default is still $15 though the new hint explains it; first-time Chinese users' NT$ budgets above about NT$480 per person are blocked by default with no hint on the Limits page.

VERDICT: 0 BLOCKER, 3 BUG, 4 CONFUSING

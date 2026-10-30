# judge report (hackathon judge, then Echo Karaoke owner)

## First two minutes (cold open of http://192.168.31.145:8797)
The headline "Your agent gets the group together. You see every step." plus the paragraph under it tells me Join is a marketplace where AI agents plan group outings, haggle with venues and settle via PayPal. The Venmo paragraph explains why it exists. "Where an AI agent starts" is clear: a boxed "For AI agents" section says start with /llms.txt and lists MCP, REST and A2A. llms.txt is good and has a copy-paste demo-account recipe. "Where a person starts" is also clear: a first-name box and a Start button. What is real and what is demo is only half answered. "A made-up town ... PayPal sandbox: test money only" is stated, but in small grey text under a second heading, below the fold on a 900px screen. I could not tell from the landing page whether PayPal is actually called or simulated. Later evidence is mixed: real PayPal order and authorization IDs, real sandbox.paypal.com invoice URL, but the UI says "PayPal's test card (a demo stand-in for their approval)". The sign-in card also says "turn on when this server has their keys (see the README)", which means nothing to a visitor with no README.

## What I did
1. curl / and /llms.txt (SPA shell; llms.txt is useful).
2. Browser: typed name "Judge", Start. Landed on Activity.
3. Clicked the "PayPal sandbox" pill (bottom-left). Nothing happens.
4. PayPal-doing-something path: Start (1) > Plan something (2) > chip "Karaoke Friday night, 4 of us, $15 each" (3) > Negotiate this (4) > Go ahead (5). The agent then haggled 3 rounds, accepted $23.40, and "PayPal sandbox: $23.40 authorized". That is 5 clicks plus typing a name, about 1 minute. Then Plans > "Pays (sandbox card)" for Alex (6, 7 with navigation). The API response for that showed real PayPal ids (order 6KW21741A10365355, authorization 0J814311HR375382X).
5. Venue view > Echo Karaoke > "Sign in as Echo Karaoke (demo)" (no password). Looked at bookings, "What Join brought in", Reconciliation, Bill extras, Disputes, Reviews, rules.
6. Changed Style to Firm, saved, reloaded (persisted). Changed Floor 65 to 85 and Style to Eager, saved ("Saved. The next negotiation uses these rules."). Sent a $12 "Overtime" invoice. Tested floor 5 through the API (400 invalid) and the UI. Restored the rules to Eager / 65 afterwards.

## Findings

CONFUSING - The user can never see PayPal doing anything real. "PayPal sandbox" pill, the "PayPal sandbox" label on the plan card and every activity line are text only. The order id, authorization id and approve link never appear in the UI (API returns `approveUrl: null, orderId: null` for the share; the PayPal ids are only in the raw response). Activity says "authorized ... with PayPal's test card (a demo stand-in for their approval)". A judge asking "show me PayPal" has nothing to click. Expected: a "View in PayPal sandbox" link or the PayPal order id on the plan.

CONFUSING - "PayPal sandbox" pill at the bottom of the sidebar (and the same label on the plan card) looks like a clickable button and does nothing, no tooltip, no explanation.

CONFUSING - Bill extras: after "Send invoice" the row says "billed $12.00 (sent)", but the PayPal invoice link (https://www.sandbox.paypal.com/invoice/p/#INV2-FJ8G-G4AU-9QH7-HHR3, returned by POST /api/venues/echo/bookings/<id>/extras) is not shown anywhere. The owner can't open or check what the customer received. There is no confirm step before sending an irreversible invoice. The first input's placeholder is cut off ("Overtime,").

CONFUSING - Developer wording on screens meant for a venue owner: "PayPal Agent Toolkit · list_transactions", "create_invoice, send_invoice", "list_disputes · answered with the signed receipt", "AP2", "Ed25519", "open payment mandate", "mandate.payment.open.1", "(sandbox)" in the Reconciliation header. Reconciliation rows say "share (u_6e642aaf2b)" and "share (you)" (raw user ids), booking id "6c7833", and a status "confirmed by PayPal (completed); not in transaction reporting yet" with a blank "PayPal fee" column. A non-technical owner can't tell whether they have been paid. Reconciliation shows "Loading..." for about 5.7 s with no spinner.

CONFUSING - Venue sign-in: the button "Sign in as Echo Karaoke (demo)" requires no credentials and the header still shows "Judge" (the customer), so it's unclear who I am now. Venue view opens on "Westgate Badminton Club" by default, not the venue you most likely want. There is no way to see what a real venue login would be.

CONFUSING - Rules form. "Firm: never comes down / Standard: halfway to the floor / Eager: all the way to the floor" plus "Counter-offers (1 to 5; the last is best and final)" plus "Floor (% of list price, never shown)" don't explain how they interact (what does Firm do with a floor? Is a floor of 85 = 85% of list or of the ask?). The confirmation "Saved. The next negotiation uses these rules." is good and values persist after reload, but the page does not show a worked example or what the current effective minimum price is in dollars. I did not run a new negotiation to verify the effect.

CONFUSING - Invalid rule value. Floor of 5 (below the API's allowed range) gave no visible message in the page (the API answers 400 `{"error":"invalid","fields":["floorPct"]}`, and no allowed range is shown next to the field). I may have missed a native browser tooltip.

CONFUSING - Venue timeline grid shows 7 AM to 5 PM only on screen; the 18:00 bookings (the evening karaoke slots) are off to the right and the grid looked empty to me at 1280px. The table at the bottom had them. Dashed/solid legend is only useful if you scroll.

CONFUSING - Join's agent chat: "Rules, and Qwen (qwen2.5:0.5b) on Join's own server when they don't understand · no AI service, no key" is model-speak. It says "I'll aim for $15.00 a person" when the venue's ask is already $8.10 each, and the agent offered ~$22.69 / 20.59 / 18.49 for the room and then accepted $23.40 (higher than its own last offer; the chart shows the green line jumping up). Three options offered are the same venue and price at 18:00 / 20:00 / 22:00. The chat is lost on reload, and while it is open the side panel covers the Activity text on the right.

CONFUSING - On the shared server, friends (Alex, Hana, Tomás) are pulled into my plan automatically and show "invited, no answer yet", with a "Demo: play your friends" box. That box is clear and honest ("Logged as a demo step"), but the landing page does not say that friends' replies are simulated.

MINOR - Landing page: sign-in note about keys and the README. The right-hand column hides residents below the fold in a scrolling box. The "Reset the demo town" link next to "Someone else has been playing in this town?" is a destructive-looking action with no warning, on a shared server.

MINOR - "What Join brought in": numbers add up ($23.40 paid by groups = the single locked booking, 3 held bookings, $12.60 haggled off list = 36.00 - 23.40, $0 paid out, "3 bookings still being paid"), but the card only counts locked bookings, so held bookings ($32.40, $52.80, $23.40 here) are nowhere in the money cards. An owner might think Join brought in $23.40 when $132.60 is booked.

MINOR - Plan page player rows use the raw id "you" for Alex in the API payload (`players: ["u_...", "you", "hana", "tomas"]`, and the top-level `you` object in the pay response describes Alex, not me). Not visible in the UI but confusing for agents reading it.

Side effects on the shared server (so other testers know): I changed Echo Karaoke's rules several times (restored to Eager / 65 / 3 rounds / the original discounts) and sent a $12.00 sandbox "Overtime" invoice on booking bk_59deff6c7833 (2026-10-31 18:00 room 2), which belongs to another tester.

VERDICT: 0 BLOCKER, 0 BUG, 10 CONFUSING

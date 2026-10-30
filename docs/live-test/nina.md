# nina (first-time visitor, laptop 1280x900)

## What I did
1. Opened http://192.168.31.145:8797, read the landing page, clicked the three feature lines, made demo account "Nina" (Westgate).
2. Opened the Join's agent drawer, asked "I want karaoke with 3 friends this weekend, about $15 each". Got 3 Echo Karaoke options, clicked Negotiate this, got a deal ($23.40, $5.85 each); PayPal sandbox test card authorized automatically.
3. Plans: expanded "Signed authorizations (AP2)", played the three friends with the demo buttons (Pays, Asks $1 less, Keep it). Booking became "Paid and locked". Opened the receipt.
4. Clicked through Activity, Plans, Map (all pins, squares, popups, both popup links, Show around me), Limits (every control, Save limits, Save PayPal for my agent), Connect (Copy, Make a token, Advanced), Venue view (venue chips, date chips, timeline, Sign in as Echo Karaoke (demo)). Tried vague messages in the drawer.

## Findings

### BUG
- Other testers' data lands in my account. My Plans/Activity contain a badminton booking at North Park Gym I never asked for (organizer "Weiting"; players Ines, Mei, "You"). It shows "You $7.65 paid" and a "Waiting on you: Join and pay / Can't make it" card. The Map side panel shows that booking (North Park Gym, court 6, locked) instead of mine. The first drawer search also offered a group "Nina, Ines, Mei, Weiting" on Sun Nov 1: Join built my group from other users.
- Deep link `#/games?booking=bk_59deff6c7833` ("Open the plan" in Activity) does not scroll to or highlight that booking. Plans lists the other booking first, so my first receipt click opened the wrong booking's receipt.
- Drawer "Go ahead" step is inconsistent: in one run the agent stopped and asked "Go ahead / Not this one" before negotiating; in another run (same user) clicking Negotiate this went straight to a signed deal with no confirmation. The earlier search is also logged twice in Activity (two identical "looked for karaoke for 4 people" lines).
- Venue view, "Bill extras" for my Echo booking already says "billed $12.00 (sent)". I never saw an invoice or notice in Activity or Plans for a $12.00 extra (could be another tester acting as venue, but a customer is never told).
- Venue view "Reconciliation: Loading..." never finished while I stayed on the page.
- Connect > Copy shows "Copied" although `navigator.clipboard` is undefined on this http address; I could not verify the clipboard got the text.
- Limits > "Save PayPal for my agent" sends a demo user to the real sandbox.paypal.com login (in Chinese, from my locale) asking for an email. A demo account has no sandbox login: dead end, only "Cancel and return to Join".

### CONFUSING
- Landing: "Google, Facebook, LINE, PayPal sign-in turn on when this server has their keys (see the README)": a visitor has no README. "Reset the demo town" link offered to anyone, no warning what it deletes. The three feature lines (Connect your agent / Set your limits / Watch it work) look like links but are not clickable.
- Drawer header: "Rules, and Qwen (qwen2.5:0.5b) on Join's own server when they don't understand - no AI service, no key". Developer text.
- I said "3 friends"; the agent picked Alex, Hana, Tomas (demo-town residents Nina does not know). Nothing says they are fake, and the real friends cannot be invited. "Picked by everyone's trip, price and verified reviews": "trip" is unexplained. Cards say "$32.40 asked", the chart says "list $36.00", the final was $23.40 / $5.85 each.
- The agent's consent text ("I'll agree to at most $60.00 in total... you guarantee the whole price in PayPal until your friends pay...") is long; the key risk (you may end up paying all $23.40) is buried and the button "Go ahead" does not say money is authorized.
- Drawer chat history disappears on reload or navigation (starter screen again though the booking exists). "hello", "what is Join?" and "pizza tonight for 2 under $5" all get the same "What would you like to do? Badminton, karaoke..." reply.
- Plans words: "Deal / Guaranteed / Paid and locked / Played / Venue paid", "Signed authorizations (AP2)" whose expansion is raw JSON ("mandate.payment.open.1", "conditional_transaction_id", "payment.agent_recurrence WEEKLY") mixing cents (2340, 6000, 1500) and dollars ("max": 40). "Demo: play your friends" 3x3 buttons and "Time runs out now (you cover whoever hasn't paid)" look alarming.
- Times: hold "Shares due by 05:17" is San Jose time; Connect's token shows "2026/10/30 下午8:08:41" (browser locale/timezone). No explanation, 20-minute hold is short.
- Receipt: "Waiting for the next batch / batches close every few minutes", "SHA-256", "Ed25519", "hashed with your salt", "Check it yourself: node examples/verify-receipt.mjs rcpt_...". No venue name, no friend names (hashed ids), only "room 2". It proves the deal to engineers but is not a booking confirmation a person could show at the door.
- Map: round pins are plain white circles; legend colours (Over your budget red, Alternative green) never explained; the big blue circles ("You") and the dashed blue line do nothing when clicked. "Show around me" gives only "This browser only shares your location on https or localhost, so the map stays where the sample town is." (developer message, nothing visible happens). Popup "Plan here with Join's agent" opens the drawer on the generic starter screen, venue not pre-filled. Echo popup "$36 per hour" vs the deal $23.40.
- Limits: "Most for one booking (your share)", "Most your agent may guarantee for a group", "PayPal Vault" are unclear. (Save works: "Saved. Your agents see the new limits on their next step." is good.)
- Connect: a person with no agent gets a page of terminal commands (claude mcp add, npx mcp-remote, curl, A2A, WebMCP). Make a token prints the full token inline in every snippet.
- Venue view: menu label is for venue staff but sits in the customer menu; shows other customers' bookings and totals (e.g. $52.80). Defaults to today (10/30) so the grid is empty; the booked day needs the date chip, the timeline is clipped at 5 PM (the 18:00 booking is off to the right, needs hidden horizontal scroll) and only 5 of 8 rooms show. "Sign in as Echo Karaoke (demo)" switches me to the venue owner dashboard while the sidebar still says "Nina". Words: "off-peak", "Reconciliation / PayPal Agent Toolkit - list_transactions", "create_invoice, send_invoice", "list_disputes".

### MINOR
- Blue "PayPal sandbox" chip bottom-left looks clickable but does nothing.
- Floating "No agent? Ask Join's" button overlaps content at the right edge of Plans and Limits.
- Demo friend buttons shift after one friend pays (buttons of the other rows move up).
- No "booking confirmed, here is what to do next" message anywhere after payment; Activity just lists steps.

## Worked
Account creation, drawer search, visible haggle rounds, auto-authorize with sandbox card, demo friend buttons (Pays, Asks $1 less / Keep it), "Paid and locked", receipt page verifies, map round pins and squares open popups, "Its rooms and courts" link, Limits save, token creation, venue and date chips.

VERDICT: 0 BLOCKER, 7 BUG, 11 CONFUSING

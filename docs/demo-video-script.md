# Demo video script (2:45, English)

Join's website signed in as Alex, at full width; Claude Code in a second window for the MCP part. PayPal sandbox with
the test card (`PAYPAL_TEST_CARD=1`), so no buyer sign-in is needed. For the dispute shot, switch to the stand-in
(no keys), because a sandbox dispute needs a sandbox buyer account; say "PayPal simulated" on that shot. Every number
on screen comes from the run itself: don't add figures in editing. English captions; no music with rights issues;
no third-party logos.

| Time | Screen | Voice-over | Criterion |
|---|---|---|---|
| 0:00-0:20 | A group chat going in circles ("Fri?" "Sat works" "who books?"); then a booking where one friend never paid and the organizer is left short | "Getting friends together is the easy part. Then someone has to find a time, haggle with the venue, front the money, and chase everyone for their share. Join hands that to AI agents, and settles it with PayPal." | Potential impact |
| 0:20-0:35 | Claude Code: `claude mcp add ... join`; "Set up badminton this weekend within my limit." Activity page fills in live | "Bring your own agent: Claude, or anything that speaks MCP or A2A. Join is the market and the rules." | Technological implementation |
| 0:35-1:05 | No agent? The drawer: type "週六晚上四個人唱歌 每人十塊". Three cards with reasons, tags ("group discount", "venue haggles readily"). It states the terms, Alex says go; offer, counter, deal | "No agent? Join has one on the page. A small Qwen on Join's own server works out what you mean; fixed code does the rest. Before it haggles, it tells you what a deal commits you to." | Design, innovation |
| 1:05-1:20 | Plans: the negotiation chart, the venue's asks stepping down, a lowball marked "venue didn't move" | "Every venue sets its own rules and a floor nobody sees. A lowball doesn't move it; serious offers do." | Innovation |
| 1:20-1:50 | The guarantee authorized in PayPal. The demo panel: Hana pays, Leo asks $1 less and Alex agrees, Tomás can't come. Bryntum's bar goes from dashed to solid; the payments table shows each capture and what Alex covered | "The organizer guarantees the whole price with a PayPal authorization, so nobody holds a room for free. Friends pay their own shares; at the lock each share is captured and the organizer's authorization only for what's left." | Technological implementation |
| 1:50-2:15 | The receipt page: the checks turning green, "Cryptographically verified in your browser · N ms". Then, on the stand-in, "Simulate a buyer's dispute": the Activity log shows Join answering it at once | "Every deal gets a receipt, signed and kept in an append-only audit log anyone can check. When a payment is disputed, Join answers PayPal by itself with that receipt and how the payer approved." | Technological implementation, innovation |
| 2:15-2:35 | Limits: an agent token can read them, not change them; an over-limit accept refused with `over_mandate` in the Activity log. Venue view: the figures tiles | "Your limits are enforced in code before a venue sees an offer, whatever an agent is told. And the venue sees what Join brought in, counted from real bookings." | Design, impact |
| 2:35-2:45 | The Activity page scrolled; Join's name | "Agents do the work. PayPal moves the money. You see every step. Join." | |

# Demo video script (2:45, English captions)

One person, one plan, start to finish. Hana wants karaoke with three friends on Saturday night; she has no AI agent of
her own, so she uses Join's. Everything on screen is from the run itself: don't add numbers in editing. Protocol names
appear only as small captions, never in the voice-over. How to set up and record it is in the runbook below.

| Time | Scene: what's on screen, what to click | Voice-over | Caption |
|---|---|---|---|
| 0:00-0:15 | A short group-chat mock-up going in circles ("Sat?" "who books?" "I'll pay you back later"). Cut to Join's Activity page, empty, with **Plan something**. | "Getting four friends to karaoke is easy. Booking it, haggling, fronting the money and chasing everyone's share is where it dies." | |
| 0:15-0:40 | Click **Plan something**. Type `karaoke saturday night, 4 of us, $15 each`, press Enter. Three cards appear; hold on the first one's reviews line. | "Hana doesn't have an AI agent, so she uses Join's. It finds who's free, the venue fairest for everyone's trip, and reads verified reviews from people who actually paid." | Join's agent: rules + Qwen 0.5B on Join's own server, no AI key |
| 0:40-1:00 | Click **Negotiate this**. The agent states the terms; click **Go ahead**. Offers and counters scroll in; the deal appears. | "Before it haggles, it says what a deal commits her to. The venue has its own rules and a floor nobody sees. Lowballs don't move it; serious offers do." | |
| 1:00-1:20 | The guarantee step: the PayPal sandbox approval (test card, or the PayPal popup). Cut to Plans: the booking is "guaranteed". | "To make the deal binding, Hana guarantees the whole price with PayPal. It's only authorized, not charged, so nobody can hold a room for free." | PayPal Orders v2, intent AUTHORIZE |
| 1:20-1:50 | Plans, demo panel **Demo: play your friends**: Tomás **Pays**, Aisha **Asks $1 less** (Hana clicks **Agree**), Leo **Pays**, Aisha **Pays**. Cut to Venue view: Bryntum's bar for the room goes from dashed to solid. | "Each friend pays their own share in PayPal. When the last one's in, the booking locks: each share is captured, and Hana's authorization only for her own. The venue sees its room locked." | Captures at the lock · Bryntum Scheduler |
| 1:50-2:10 | Activity page: the plan's summary line, then **Show all** steps. Hover the PayPal lines. | "Hana can see every step every agent took, written by Join from the facts. No AI writes this page." | |
| 2:10-2:30 | Click the receipt link: the checks turn green, "Cryptographically verified in your browser". | "Every deal gets a signed receipt in a public log that witnesses cosign. Anyone can check it. And when the game is over, the venue is paid with PayPal Payouts." | Ed25519 · RFC 6962 transparency log · AP2 mandates · PayPal Payouts |
| 2:30-2:40 | Limits page: $15 per booking. Then the Activity line where an agent's over-limit request was refused. | "Her limits are enforced by Join, not by the agent's good behaviour. We tried a prompt-injected agent. It got nothing." | |
| 2:40-2:45 | Join's logo over the Activity page. | "Agents do the work. PayPal makes it real. You see every step." | |

## Recording runbook

**Before recording**
1. On the server, reset the demo town: open `http://<host>:8799/demo?as=hana&reset=1` (receipts, the log and tokens
   are kept; plans and bookings are cleared). Check it with `node api/scripts/smoke.mjs http://<host>:8799` and reset
   again afterwards, since the smoke run makes a booking.
2. Browser: Chrome, 1440×900 window, zoom 100%, no extensions bar, dark mode off. Sign in as Hana
   (`/demo?as=hana`). Close the agent drawer.
3. A second tab on Venue view, Echo Karaoke selected, for the Bryntum cut.
4. For the over-limit shot (2:30), make it once before recording: on Limits, set Hana's per-booking limit to $15, then
   in the drawer ask for `karaoke saturday 2 of us $40 each`; the refused step appears on the Activity page. Reset
   afterwards only if you want a clean Activity page for the opening (then do this shot last instead).
5. Have the group-chat mock-up ready as an image (no real names or phone numbers).

**While recording**
- Record each scene separately; cut between them. Wait for each step to finish before clicking on.
- If the agent offers Hana other venues, pick the first card anyway; the story is one venue.
- If PayPal shows the test-card path, keep it: it says "sandbox" on screen, which is honest.

**Avoid**
- The terminal, `.env` files, or any PayPal dashboard showing keys or account emails.
- The "Demo:" activity lines for longer than a second (they are labelled demo steps, but the story is the friends).
- Anything that looks like real money: the sandbox badge should stay visible in the sidebar.

**After**
- English captions from the voice-over column; keep the Caption column as small on-screen labels.
- Under 3 minutes; upload to YouTube as Public; put the link in Devpost and `docs/SUBMISSION.md`.

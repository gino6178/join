# kai-mcp report

## How I found my way in
1. GET / -> SPA shell; `<link rel=alternate href=/llms.txt>` and the noscript text both pointed to /llms.txt. 
2. /llms.txt told me everything: demo account (POST /api/auth/demo), token (POST /api/tokens with scopes), MCP URL, tool list, typical plan, rules. Also tried /.well-known/agent-card.json, mcp.json (fine), agent.json (404, expected).
3. Demo person "Kai" (u_26ab5cb562), token with scopes read, negotiate, pay (Kai allowed paying). No guessing needed. Script via MCP SDK (StreamableHTTP, Bearer header) worked first time.

## Steps
- whoami: mandate perGame 15.00, perWeek 40.00, guaranteeOnItsOwn 60.00; ap2.openPaymentMandate JWT; paypal.savedForAgent false.
- find_options badminton, Sat/Sun, people 4: only Sat 31 Oct (09/11/17/19/21h) at Midtown Community Gym, ask 23.40 (26.00 less group 10%), share 5.85, youCanSpend 15.00.
- venue_reviews: Midtown 4.3 (8 demo reviews, clean/staff, "pricey"); Riverside 4.3 (24 reviews, firm, 28/h) as comparison. Chose Midtown, Sat 11:00, 60 min, players ["you","hana","tomas"].
- start_negotiation -> neg_ca2ce89d4a88, ask 23.40, 3 rounds. Offers 18.00 -> counter 23.05; 20.00 -> 22.71; 20.00 -> "final" 22.36. Concessions are about 0.35 per round (the schedule is tiny; lowballing gains little).
- accept_price (mandate passed) at 22.36 (share 5.59, under Kai's 15 and the 15 each cap) -> booking bk_0d8e294e20db. Response says state awaiting_organizer, but the guarantee had already been placed: booking_status shows state "held", organizer authorization (order 65H27526HE495024P, auth 19V00264R86375632, "sandbox test card"). pay_my_share afterwards was a harmless no-op (returned same status).
- Friends (you/Alex Rivera, hana, tomas) stayed "invited" the whole time: they are made-up residents with no agent. Waited until payBy 14:10:31. Nothing I could do to make them pay: tools for the organizer are answer_share (only if a friend asks to pay less), request_reimbursement (only after lock, sends a PayPal invoice to a friend who never paid, payout to Kai when paid), cancel_booking (before lock voids all authorizations). I did NOT send reimbursement invoices (message to others on Kai's behalf; not asked) - Kai should decide.
- At 14:10:3x state became "locked". The organizer's guarantee was captured in full: 22.36 (capture 7R899034WF988493R). Friends' payments: not_started, paid null. So Kai is out 22.36, not 5.59 (his cap of 15 was for his share, the site let the 22.36 guarantee through since guaranteeOnItsOwn is 60). Kai is owed 16.77 from three people if they pay invoices.
- Receipt rcpt_d0f45d1b8500a71f (event locked, issued 14:10:35).

## Receipt check (independent of site page)
- GET /api/receipts/rcpt_d0f45d1b8500a71f (Bearer) gave body + hash + signature + kid + publicKey.
- Fetched key separately from /.well-known/join-receipts.json: same Ed25519 key (kid join-mvuow7fq), matches embedded key.
- Verified myself in node: sha256 of key-sorted (JCS-like) JSON of body == receipt hash; Ed25519 signature verifies over the 32 raw hash bytes with the well-known key. Tampered body (total changed) fails. Not documented anywhere which bytes are signed; I had to try 3 variants (body text, hash hex, hash bytes); only the raw hash bytes worked.
- Content matches what I saw: total 2236 cents, negotiation history identical, organizer captured 2236 with PayPal ids above; friends status "none". Player ids in the receipt are hashes.
- Transparency log: receipt has batch null, proof null, log null right after locking; the log (size 6, checkpoint signed note) has no entry for it yet. So inclusion in the Merkle log could NOT be checked (the log's 6 batches were all older, 09:12-~11:xx). Witness cosigned: false. I did not verify the checkpoint signature or PayPal's own record (sandbox, no PayPal access).
- Anything PayPal-side (order/capture ids) is just reported by Join; I could not check it with PayPal.

## Findings
- CONFUSING: accept_price returns booking.state "awaiting_organizer" and youGuarantee text as if still to do, but the guarantee is already authorized (booking_status: held). An agent might call pay_my_share again/double worry. (pay_my_share was idempotent.)
- CONFUSING: players are named by id; the list from find_options includes id "you" (Alex Rivera) next to Kai's real id u_26ab5cb562. Passing "you" in players works but looks like a placeholder, and the group shows Kai twice-ish (u_26ab..., "you").
- CONFUSING: "$15 each" mandate vs outcome: lock captured the whole 22.36 from Kai because friends never paid. Kai's perGame 15 limit is not about this; the guarantee limit is 60. The ifYouAccept note does say worst case 22.36, so honest, but a person saying "pay my share" may be surprised.
- CONFUSING: after lock, friends' payment status is "not_started" in booking_status but "none" in the receipt; and the unpaid friends are still in players with no marker (no "covered by organizer" flag, reimbursements empty).
- CONFUSING: receipt signature scheme undocumented (see above); `batch/proof/log` null with no hint when it will be filled.
- MINOR: the first make_offer of 18.00 (77% of ask) moved the ask only 0.35; second and third offers identical 20.00 reached "final". Fine per rules but "negotiate sensibly" gains about $1 total.
- MINOR: find_options with minutes:60 returned only 1 venue (Midtown) although Riverside/North/Westgate open; weekend options only on Sat, nothing Sunday.
- MINOR: Node process on Windows asserts (libuv UV_HANDLE_CLOSING) on exit after MCP client use unless process.exit is delayed; client side, not the site.

## Claims that were not fully true
- accept_price said booking state awaiting_organizer; one call later it was held (guarantee already authorized with no extra call). Not harmful.
- "Money is captured only when the booking is locked" - true; it was captured at lock.
- Receipt "proof/log" is not available at issue time (inclusion not yet provable).

## Cleanup
Deleted my trial2-kai-mcp-*.mjs scripts. Kai's token is in the report only as an id (tok_1bdb9a57).

VERDICT: 0 BLOCKER, 0 BUG, 5 CONFUSING

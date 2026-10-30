# ana report (organizer agent)

## What I did
1. Read BRIEF.md and /llms.txt.
2. POST /api/auth/demo {Ana, Midtown, crew4} -> player u_1c0bf1ead7. POST /api/tokens with read, negotiate, pay -> token tok_02991903.
3. whoami at once: crew crew4 showed Bo (u_ccbcc4318b) and Chen (u_9924537b92). No Mei.
4. Polled whoami about every minute for ~10 min, then another ~4 min: Mei never appeared under that name.
   After ~11 min a third crew member appeared, named "小美" (u_885e4d4127, Midtown). It stayed Bo, Chen, 小美 after that.
5. I did NOT start any negotiation, offer, guarantee or payment. my_plans is empty. No money moved.

## Why I stopped
Ana's crew was Bo, Chen and Mei. The crew never showed a member named "Mei". "小美" may be Mei (Chinese name), but nothing on the site says so, and I was told to plan with exactly those three. Guaranteeing a booking and paying for someone I could not confirm is Mei is not something I will assume. Needs Ana (or Mei) to confirm that u_885e4d4127 is Mei.

## Observations
- Mandate on the site: perGame $15, perWeek $40, guarantee $60. Ana said $12 each at most, so I would keep to the stricter $12 per share (about $48 total for four).
- Group of four was therefore NOT confirmed. Nobody paid anything (I saw no bookings).

## Findings
- CONFUSING: crew list shows display name only ("小美"); no way to tell it is the friend "Mei". whoami crew.members has id, name, area only.
- CONFUSING: the join of the 4th friend took ~11 min, so the 10-minute wait in the brief was too short for the check.
- MINOR: demo-account /api/tokens returns the full token in plain JSON (expected for sandbox).

VERDICT: 0 BLOCKER, 0 BUG, 2 CONFUSING

## Continued (after Ana confirmed 小美 u_885e4d4127 is Mei)
1. find_options (karaoke, people 4, with Bo, Chen, 小美, dates Sat 10-31 and Sun 11-01): Echo Karaoke, Sat 14:00, 60 min, players exactly Ana, Bo, Chen, 小美; ask $32.40 ($8.10 each); reviews 4.3 from 21 (demo data). Board games at Dice & Co was 4.0, so karaoke chosen. (Note: from/to are HH:MM, dates need `dates`; my first call with dates in from/to gave bad_time, clear message.)
2. start_negotiation neg_8e6eb762c036 -> offered $28 -> venue countered $29.40 ($7.35 each) -> accept_price. Booking bk_7dfd44299e92, guarantee $29.40 authorized for Ana at accept, payBy 18:05.
3. pay_my_share called; Bo (authorized ~1 min later) and 小美 paid $7.35 each by themselves. Chen asked to pay $6.35 ($1 less); I accepted with answer_share. Ana's share rose to $8.35 to cover it.
4. Booking locked at 17:49:58 (state locked, all four captured): Ana $8.35, Bo $7.35, Chen $6.35, 小美 $7.35 = $29.40 (adds up). All under $12.
5. Receipt rcpt_ec01f1dfb0c96311 (event locked): SHA-256 of canonical body matches hash; Ed25519 signature verified with the key from /.well-known/join-receipts.json (not the copy in the receipt); batch batch_ec01f1dfb0c9 closed at 17:51:51 and has a log inclusion proof (entry 10, tree size 11). I did not verify the Merkle path or checkpoint cosignatures.
6. The group was really Ana, Bo, Chen and 小美; no strangers/residents (alsoFree names were never invited).

Findings: CONFUSING: Ana's share silently went from $7.35 to $8.35 when Chen's $1 ask was accepted (shown in booking payments, share 8.35). The receipt body lists players by hashed ids, so I could not tell names from it, only roles/amounts.
Cleanup: ~ temp helper files removed; no examples scripts were created.

VERDICT: 0 BLOCKER, 0 BUG, 3 CONFUSING

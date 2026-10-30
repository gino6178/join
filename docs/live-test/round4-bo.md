# bo report
Steps: read BRIEF and /llms.txt; POST /api/auth/demo (Bo, Midtown, crew4) -> u_ccbcc4318b; token scopes read/negotiate/pay (tok_7240a53d). whoami: mandate perGame 15, so Bo's stricter $12 limit applied. Polled my_plans each minute (~17 checks, 01:31-01:46 local clock).
Invitation: bk_7dfd44299e92, Echo Karaoke room 1, 2026-10-31 14:00 60min, total 29.40, 4 players (organizer u_1c0bf1ead7, Bo, u_9924537b92, u_885e4d4127), invite share 7.35 <= 12, payBy 18:05Z. Paid with pay_my_share (mandate passed): status authorized 7.35.
Booking went held -> locking -> locked about 3 minutes later; receipt rcpt_ec01f1dfb0c96311 (locked).
Charged to Bo: 7.35 captured, equals invite share and booking_status "you".
Others: all four captured. Organizer 8.35, Bo 7.35, u_9924537b92 6.35, u_885e4d4127 7.35 = 29.40 (adds up). split changed from "even" to "negotiated"; shareAsks empty. All players were the crew's four (no strangers seen).
Findings:
- CONFUSING: invite showed an even 7.35 for everyone; at lock the organizer's share became 8.35 and another friend's 6.35 with no visible shareAsks entry or explanation to Bo. Bo's own share was unchanged.
- MINOR: Bo's limit ($12) differs from site mandate ($15); I kept the stricter, no issue.
VERDICT: 0 BLOCKER, 0 BUG, 1 CONFUSING

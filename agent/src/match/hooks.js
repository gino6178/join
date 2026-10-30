// The notes the talk makes (a2a.js, a2a_server.js), kept here so the hooks in those files stay one line each: a
// proposal sent (the gateway counts the asks each member got this week, for the fair order), a member's agent's answer
// (written to that member's own records, on its side), and a held time let go after that member's yes (the asker
// dropped it, or another member took it: what the member's agent sees of the asker's reliability).
import { noteDecision, noteRelease } from "./records.js";
import { ledger } from "./ask.js";

export function proposed(memberId, round) { if (round === 1) try { ledger().sent(memberId); } catch { /* not counted */ } }
export function decided(memberId, e) { try { noteDecision(memberId, e); } catch { /* not noted */ } }
export function released(memberId, ref, why) { try { noteRelease(memberId, ref, why); } catch { /* not noted */ } }

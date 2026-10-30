// Agent matchmaking (docs/agent_matchmaking_plan.md): what the rest of Serve calls. Loading it installs three hooks in
// play.js (the Play page's options ordered by band; an invite's in or out, and a cancelled game, noted for the member
// and the ledger).
import * as play from "../play.js";
import { rerankOptions, onInvite, inviteAnswer } from "./rank.js";
import { store as records, noteCancel } from "./records.js";
import { forget as forgetEstimates } from "./likely.js";
import { forget as forgetLedger } from "./ask.js";
import * as settings from "./settings.js";
import { forgetMemoryFor } from "../a2a.js";
import { forget as forgetDisclosed } from "../disclosure.js";

play.hooks.rerank = rerankOptions;
play.hooks.invite = onInvite;
play.hooks.cancel = noteCancel;
play.hooks.inviteAnswer = inviteAnswer; // the demo's members answer by their own agents' chance of a yes (12.8)

export { isPlayRequest, findGame, question } from "./flow.js";
export { rankRows, bandsFor, rankMembers } from "./rank.js";
export { on } from "./ask.js";
export { auditOf, describe, EXT_PATH } from "./likely.js";
export { api, nightly } from "./api.js";
export { command } from "./commands.js";

// /forget: everything used for prediction. The member's own records and every row naming them; the estimates asked
// of them and by them (audit and cache); the ledger's rows and this week's counts; a2a.js memory of their answers;
// their choices (bands, exact, learn: all back to off); and their Autopilot plans (loaded lazily, as autopilot.js
// loads this module)
export function forget(id) {
  records().forget(id); records().flush();
  forgetEstimates(id); forgetLedger(id); forgetMemoryFor(id); settings.forget(id); forgetDisclosed(id);
  import("../autopilot.js").then((a) => a.forget?.(id)).catch(() => {});
}

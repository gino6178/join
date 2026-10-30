// Retrain the prediction from the records of members who agreed to it, on this server's CPU (retrain.js). The gateway
// runs it nightly (NIGHTLY=1, at MATCH_RETRAIN_HOUR) and on the maintainer's request, as `nice -n 19` with at most 8
// threads; it can also be run by hand from agent/:
//   nice -n 19 node src/match/retrain_cli.js [--simulated] [--dry-run] [--rollback] [--min-rows N]
// --simulated learns from the simulated members' records only (the proof while no real member has agreed).
// Prints one JSON report; the registry is data/match_models/registry.json.
import { readClub } from "../club.js";
import { helpers } from "../play.js";
import { store } from "./records.js";
import * as retrain from "./retrain.js";

const args = process.argv.slice(2), has = (f) => args.includes(f), num = (f) => { const k = args.indexOf(f); return k >= 0 ? +args[k + 1] : undefined; };
retrain.loadActive();
let out;
if (has("--rollback")) out = retrain.rollback();
else {
  const club = readClub();
  out = retrain.run({ store: store(), members: club.members, club, venues: helpers.readVenues(), travelMin: helpers.travelMin, simulated: has("--simulated"), dryRun: has("--dry-run"), minRows: num("--min-rows") });
}
console.log(JSON.stringify(out));

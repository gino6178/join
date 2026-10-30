// The gateway's matchmaking routes (server.js hands them /api/match/* it does not serve itself), behind its token:
//   GET  /api/match/audit?member=&from=      who asked about whom (estimates only, never records)
//   GET  /api/match/settings?player=          a player's choices (bands, exact, learn), the club's, what they cost
//   POST /api/match/settings {player, bands, exact, learn}
//   POST /api/match/club {fairExposure}        the club's or maintainer's switch
//   GET  /api/match/models                     the model in use, the versions, their gate results
//   POST /api/match/retrain {simulated, dryRun}   a retraining run on this server's CPU (nice -n 19, 8 threads)
//   GET  /api/match/retrain                    the last run
//   POST /api/match/rollback                   the previous model back
// and the nightly run (NIGHTLY=1, MATCH_RETRAIN_HOUR, 05:00 by default).
import path from "node:path";
import { spawn } from "node:child_process";
import * as settings from "./settings.js";
import { auditOf } from "./likely.js";
import { registry, rollback, loadActive } from "./retrain.js";

// what the switches cost, as measured on the simulated club (docs/agent_matchmaking_plan.md), for the settings view
export const MEASURED = {
  fairExposure: "Measured on a simulated club: about 8% more asks per game, and the members never asked fell from 18% to 8%.",
  exact: "Measured on a simulated club: about as many asks as the word alone, since within a word the people asked least still go first.",
};
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"));
let job = null;
// one run at a time, in a process of its own at the lowest priority; the gateway loads the model it installs
export function startRetrain({ simulated = false, dryRun = false } = {}) {
  if (job?.state === "running") return { started: false, job };
  const args = [path.join(HERE, "retrain_cli.js"), ...(simulated ? ["--simulated"] : []), ...(dryRun ? ["--dry-run"] : [])];
  const win = process.platform === "win32", cmd = win ? process.execPath : "nice", argv = win ? args : ["-n", "19", process.execPath, ...args];
  job = { id: Date.now().toString(36), state: "running", at: Date.now(), simulated, dryRun, report: null };
  const p = spawn(cmd, argv, { env: { ...process.env, UV_THREADPOOL_SIZE: "8" }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  p.on("close", (code) => { try { job.report = JSON.parse(out.trim().split("\n").at(-1)); } catch { job.report = { error: `the run ended (${code})` }; } job.state = code === 0 ? "done" : "failed"; job.done = Date.now(); loadActive(); });
  p.on("error", (e) => { job.state = "failed"; job.report = { error: e.message }; });
  return { started: true, job };
}
let last = null;
export function nightly(now = new Date()) {
  if (process.env.NIGHTLY !== "1" || now.getHours() !== +(process.env.MATCH_RETRAIN_HOUR ?? 5)) return;
  const day = now.toISOString().slice(0, 10);
  if (last !== day) { last = day; startRetrain({}); }
}
export async function api(u, req, bodyOf) {
  const p = u.pathname, post = req.method === "POST", q = (k) => u.searchParams.get(k);
  if (p === "/api/match/audit") return { body: { estimates: auditOf({ member: q("member"), from: q("from"), n: +(q("n") || 200) }) } };
  if (p === "/api/match/settings" && !post) { const id = q("player") || "you"; return { body: { player: id, ...settings.get(id), club: settings.club(), measured: MEASURED, model: registry().inUse } }; }
  if (p === "/api/match/settings" && post) { const b = await bodyOf(req), id = String(b.player || "you").slice(0, 64); return { body: { player: id, ...settings.set(id, b) } }; }
  if (p === "/api/match/club" && post) return { body: settings.setClub(await bodyOf(req)) };
  if (p === "/api/match/models") return { body: registry() };
  if (p === "/api/match/retrain") { if (!post) return { body: job || { state: "none" } }; const b = await bodyOf(req); return { body: startRetrain({ simulated: !!b.simulated, dryRun: !!b.dryRun }) }; }
  if (p === "/api/match/rollback" && post) return { body: rollback() };
  return null;
}

// Runs side by side: the headline of each run (submission/results/sim_users_<run>.json) and the spread over seeds.
//   node test/sim_users/report.mjs ../submission/results/sim_users_s1.json ../submission/results/sim_users_s2.json [--out file]
import fs from "node:fs";
import path from "node:path";

const files = process.argv.slice(2).filter((a) => !a.startsWith("--") && a !== process.argv[process.argv.indexOf("--out") + 1]);
const runs = files.map((f) => JSON.parse(fs.readFileSync(f, "utf8")));
const pick = (f) => runs.map((r) => { try { return f(r); } catch { return null; } });
const spread = (xs) => { const v = xs.filter((x) => x != null); if (!v.length) return null; const m = v.reduce((a, b) => a + b, 0) / v.length; return { values: xs, mean: Math.round(m * 100) / 100, min: Math.min(...v), max: Math.max(...v) }; };
const out = {
  simulated: true, runs: runs.map((r) => r.headline.run), seeds: runs.map((r) => r.headline.seed),
  gamesPlayed: { serve: spread(pick((r) => r.headline.gamesPlayed.serve)), baseline: spread(pick((r) => r.headline.gamesPlayed.baseline)) },
  playerGamesPerUser: { serve: spread(pick((r) => r.headline.playerGames.perUserServe)), baseline: spread(pick((r) => r.headline.playerGames.perUserBaseline)), diff: spread(pick((r) => r.headline.playerGames.perUserDiff)), diffCI: pick((r) => r.headline.playerGames.perUserDiffCI) },
  usersWithAGame: { serve: spread(pick((r) => r.headline.usersWithAGame.serve)), baseline: spread(pick((r) => r.headline.usersWithAGame.baseline)) },
  actionsPerGame: { serve: spread(pick((r) => r.headline.actionsPerGame.serve)), serveGameOnly: spread(pick((r) => r.headline.actionsPerGame.serveGameOnly)), baseline: spread(pick((r) => r.headline.actionsPerGame.baseline)) },
  wantToBookedMin: { serve: spread(pick((r) => r.headline.wantToBookedMin.serveMedian)), baseline: spread(pick((r) => r.headline.wantToBookedMin.baselineMedian)) },
  noShows: { serve: spread(pick((r) => r.turnout.serve.missing)), baseline: spread(pick((r) => r.turnout.baseline.missing)) },
  asks: pick((r) => r.asks), loop: pick((r) => r.loop.outcome), feed: pick((r) => r.feed), guard: pick((r) => ({ refusals: r.guard.refusals, kinds: r.guard.refusedKinds })),
  never: pick((r) => r.never.map((n) => `${n.id}: ${n.why}`)),
};
const i = process.argv.indexOf("--out");
if (i > 0) fs.writeFileSync(path.resolve(process.argv[i + 1]), JSON.stringify(out, null, 1) + "\n");
console.log(JSON.stringify(out, null, 1));

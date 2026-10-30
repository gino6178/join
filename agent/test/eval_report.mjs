// The Autopilot evaluation as a report: submission/agent_eval.md, and the numbers the About page shows
// (web/public/data/agent_eval.json).
//   node test/eval_report.mjs data/autopilot_eval_k3.json [data/autopilot_eval_before_stopcheck.json]
// The first file is the run reported (with EVAL_REPEAT=k, every week k times); the second, if given, is an earlier run
// shown beside it.
import fs from "node:fs";

const [src = "data/autopilot_eval.json", before = null] = process.argv.slice(2), rows = JSON.parse(fs.readFileSync(src, "utf8"));
const sum = JSON.parse(fs.readFileSync(src.replace(/\.json$/, "_summary.json"), "utf8"));
const n = (x) => (x == null ? "–" : x), mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const weeks = Object.values(rows.reduce((a, r) => ((a[r.scenario] ||= []).push(r), a), {}));
const k = Math.max(...weeks.map((w) => w.length));
const old = before && fs.existsSync(before) ? JSON.parse(fs.readFileSync(before, "utf8")) : null;
const oldOf = (name) => old?.filter((r) => r.scenario === name) || [];
const okOf = (rs) => rs.filter((r) => r.success).length;
const stops = rows.reduce((a, r) => a + (r.stopsRefused || 0), 0), three = rows.filter((r) => r.scenario.startsWith("Three"));
const threeByRules = three.filter((r) => r.finishedBy === "rules").length;
const md = `# Autopilot evaluation

The Autopilot (\`agent/src/autopilot.js\`) planning eight different weeks on our server. Muse Glimmer runs on one RTX
3090 (Ollama, 4 requests in parallel), and the members' agents run on the same model${sum.transport === "a2a" ? ", answering over A2A (JSON-RPC on a local port, with the token, as behind the gateway)" : ""}. ${k > 1 ? `Each week was run ${k} times.` : ""}
Run with \`${sum.transport === "a2a" ? "EVAL_A2A=1 " : ""}${k > 1 ? `EVAL_REPEAT=${k} ` : ""}node test/autopilot_eval.mjs\`, ${new Date(sum.at).toLocaleDateString("en-CA")}. The raw results are in \`submission/results/\`.

A week passes when three things hold:
- every agent agreed the games still needed, and the player was asked to approve;
- every-week checks pass: at most one game a day, inside the next seven days, nothing on a day already booked;
- the week's own oracle passes. For example: doubles while the knee is sore, the right sport, basketball on a public
  court, Kenji in a game after the game with Kenji ran long, one game in a heavy week.

| Week | Passed | Games agreed (mean) | Time (mean) | Muse Glimmer calls | Tool calls | Stops refused | Finished by | Oracle failures |${old ? " An earlier run |" : ""}
|---|---|---|---|---|---|---|---|---|${old ? "---|" : ""}
${weeks.map((w) => `| ${w[0].scenario} | ${okOf(w)} of ${w.length} | ${mean(w.map((r) => r.agreed)).toFixed(1)} of ${w[0].needed} | ${Math.round(mean(w.map((r) => r.seconds)))} s | ${mean(w.map((r) => r.modelCalls || 0)).toFixed(1)} | ${mean(w.map((r) => r.toolCalls || 0)).toFixed(1)} | ${w.reduce((a, r) => a + (r.stopsRefused || 0), 0)} | ${[...new Set(w.map((r) => r.finishedBy))].join(", ")} | ${[...new Set(w.flatMap((r) => r.oracle || []))].join("; ") || "none"} |${old ? ` ${oldOf(w[0].scenario).length ? `${okOf(oldOf(w[0].scenario))} of ${oldOf(w[0].scenario).length}` : "–"} |` : ""}`).join("\n")}

**${sum.ok} of ${sum.runs} runs passed**${sum.passK ? `, and **${Math.round(sum.passK.passK * sum.passK.weeks)} of ${sum.passK.weeks} weeks passed every time (pass^${sum.passK.k} = ${sum.passK.passK})**` : ""}.
- **Who finished.** The model finished ${sum.byModel?.runs ?? "–"} of the runs itself, and ${sum.byModel?.ok ?? "–"} of those passed. Rules finished the plan in ${sum.rules} of ${sum.runs} (the model stopped calling tools, or ran out of steps).
- **Cost.** On average a run took ${Math.round(sum.seconds)} s, ${sum.modelCalls} Muse Glimmer calls and ${sum.toolCalls} tool calls, with up to ${sum.peak} model calls at once.
- **Refused calls.** Code refused ${sum.refused} tool calls (a day outside the week, someone not free, arguments that did not fit; ${stops} of them a stop taken too early), and the model re-planned.
${(() => { const b = rows.filter((r) => /two on two/.test(r.scenario)); return b.length ? `- **The basketball week.** Its name says two on two, but its goal sets only the sport, so its oracle checks basketball on a public court, not the format: ${b.filter((r) => r.games.some((g) => /doubles/.test(g))).length} of ${b.length} runs agreed two on two, the others one on one.\n` : ""; })()}${old ? `\nAn earlier run, before the last round of fixes (the same eight weeks, once each, graded before the per-week oracles existed), passed ${okOf(old)} of ${old.length}: the three-game week stopped at two after two failed talks, with an open evening untried. That led to the stop check below. ${stops ? `The check refused ${stops} stop${stops === 1 ? "" : "s"} in the runs above.` : "The check never had to fire in the runs above: those talks did not fail the same way."} In ${threeByRules} of the ${three.length} three-game runs the rules finished the plan (the model stopped calling tools, or ran out of steps).\n` : ""}
## What the evaluation caught

- **Two games on one day.** An earlier run agreed Thursday 18:00 singles and Thursday 19:00 doubles in a three-game
  week. A member's counter-offer was checked against everyone's calendar and the courts, but not against days that
  already had a game. Counters are now checked against those days too.
- **Stopping early.** A three-game week stopped at two after two failed talks, though Tuesday evening had players free
  who had not been asked. The run's stop is now checked by code: asking for approval, nudging or finishing while a game
  is still needed is refused (twice a run at most) when an open time still has players free, and the model is told
  which. A talk that failed with nobody saying no now also passes its members over for that day.
- **A summary that said "Booked".** In the basketball week, the model's closing sentence said the game was booked
  while it was still waiting for the player's yes. Its days and times were right, so it passed. A summary may no longer
  say booked; code writes it instead.

## What each run decided

${rows.map((r) => `- **${r.scenario}.** ${r.success ? "Passed" : "Failed"}${r.oracle?.length ? ` (${r.oracle.join("; ")})` : ""}, finished by ${r.finishedBy}. ${r.games.length ? `Agreed: ${r.games.join("; ")}.` : "Nothing agreed."}${r.summary ? ` Its summary: "${r.summary}"` : ""}${r.error ? ` Error: ${r.error}` : ""}`).join("\n")}
`;
fs.writeFileSync("../submission/agent_eval.md", md);
// the About page also shows the adversarial suite's result, when it has run (test/redteam.mjs)
const rt = fs.existsSync("data/redteam.json") ? JSON.parse(fs.readFileSync("data/redteam.json", "utf8")) : null;
fs.writeFileSync("../web/public/data/agent_eval.json", JSON.stringify({ ...sum, ...(rt ? { attacks: { stopped: rt.passed, cases: rt.cases, at: rt.at } } : {}) }, null, 1));
console.log(md);

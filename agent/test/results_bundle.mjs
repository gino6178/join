// Every number the README and docs give, with the raw results it comes from: copies the evaluations' outputs from
// data/ (which is not in the repository, since it also holds the gateway's state) to submission/results/, with a
// manifest saying what made each file, when, and on which model. Run on the GPU server after the evaluations.
//   node test/results_bundle.mjs [commit]
import fs from "node:fs";
import path from "node:path";

const OUT = "../submission/results", COMMIT = process.argv[2] || process.env.RESULTS_COMMIT || null;
const FILES = [
  ["autopilot_eval.json", "node test/autopilot_eval.mjs data/autopilot_eval.json", "the Autopilot, 8 weeks, with the stop check"],
  ["autopilot_eval_summary.json", "(the same run)", "its summary"],
  ["autopilot_eval_tokens.json", "(the same run)", "its token ledger, by call site"],
  ["autopilot_eval_before_stopcheck.json", "(the same command, before the stop check)", "the Autopilot, 8 weeks, before the stop check"],
  ["autopilot_eval_before_stopcheck_summary.json", "(the same run)", "its summary"],
  ["autopilot_eval_k3.json", "EVAL_REPEAT=3 node test/autopilot_eval.mjs data/autopilot_eval_k3.json", "the Autopilot, 8 weeks three times each (pass^3)"],
  ["autopilot_eval_k3_summary.json", "(the same run)", "its summary, with pass^3"],
  ["autopilot_eval_k3_tokens.json", "(the same run)", "its token ledger"],
  ["persona_eval.json", "node test/persona_eval.mjs data/persona_eval.json", "the members' rules, two arms, 60 talks each, with the acceptable sets graded"],
  ["scale_eval.json", "node test/scale_eval.mjs data/scale_eval.json", "the club from 11 to 1,001 members"],
  ["redteam.json", "node test/redteam.mjs", "the adversarial suite"],
  ["cascade_raw.json", "node test/cascade_eval.mjs (the quick pick only)", "the quick pick on 120 labeled decisions, three budgets"],
  ["cascade_summary.json", "node test/cascade_analysis.mjs data/cascade_raw.json data/cascade_summary.json", "its analysis: accuracy with cluster-bootstrap intervals, the budget test, calibration, conformal thresholds"],
  ["budget_probe.json", "node test/budget_probe.mjs", "every call site at one reasoning budget, a few cases each"],
  ["glimmer_in_practice.json", "node test/glimmer_report.mjs data/*-ledger.jsonl", "Muse Glimmer per call site over the evaluations' ledgers: calls, tokens, reasoning share, empty replies, replies that did not fit their schema, bad tool arguments, seconds"],
  ["load_eval.json", "node test/load_eval.mjs data/load_eval.json", "throughput at 1 to 16 talks at once, and the player's wait with and without the priority scheduler"],
  ["private_eval_week.json", "node test/private_eval.mjs", "private calendars against the shared view, a usual week"],
  ["private_eval_all_first.json", "PRIVATE_WEEK=all node test/private_eval.mjs", "the same with a week free every day, first run (before listing every hour)"],
  ["private_eval_all_fixed.json", "PRIVATE_WEEK=all PRIVATE_ARMS=private node test/private_eval.mjs", "the private arm again, listing every hour a game fits"],
  ["scale_eval_first.json", "(the first run of scale_eval, before the population fix)", "the club from 11 to 1,001 members, first run"],
  ["autopilot_eval_a2a.json", "EVAL_A2A=1 EVAL_REPEAT=3 node test/autopilot_eval.mjs data/autopilot_eval_a2a.json", "the Autopilot, 8 weeks three times each, the members' agents answering over A2A (JSON-RPC on a local port, with the token)"],
  ["autopilot_eval_a2a_summary.json", "(the same run)", "its summary, with pass^3"],
  ["autopilot_eval_a2a_tokens.json", "(the same run)", "its token ledger"],
  ["persona_eval_a2a.json", "EVAL_A2A=1 node test/persona_eval.mjs data/persona_eval_a2a.json", "the members' rules, two arms, 60 talks each, over A2A"],
  ["contention_eval.json", "node test/contention_eval.mjs data/contention_eval.json", "two talks at once for one member, holds off and on: double agreements and games booked"],
  ["contention_eval_a2a.json", "EVAL_A2A=1 node test/contention_eval.mjs data/contention_eval_a2a.json", "the same over A2A: the members' agents answer and hold over JSON-RPC"],
  ["autopilot_eval_signed2.json", "EVAL_A2A=1 node test/autopilot_eval.mjs data/autopilot_eval_signed2.json", "the Autopilot on the final code with signed Agent Cards: 8 weeks once each, over A2A"],
  ["autopilot_eval_signed2_summary.json", "(the same run)", "its summary"],
  ["autopilot_eval_final.json", "EVAL_A2A=1 EVAL_REPEAT=3 node test/autopilot_eval.mjs data/autopilot_eval_final.json", "the Autopilot on the final code: 8 weeks three times each, over A2A, holds on"],
  ["autopilot_eval_final_summary.json", "(the same run)", "its summary, with pass^3"],
  ["autopilot_eval_final_tokens.json", "(the same run)", "its token ledger"],
  // the one-pass decider (docs/decider.md); run in their own folder, so copied into data/ before bundling
  ["decider_probe.json", "LLM_URL=http://127.0.0.1:11445/v1 node test/decider_probe.mjs data/decider_probe.json", "what Ollama gives for one pass with no reasoning: raw generate with the next token's top 20, the begin-of-text token, the templated first token, the native decision request"],
  ["decider_dev_raw.json", "DECIDER_SEED=11 DECIDER_MEMBERS=300 node test/decider_eval.mjs data/decider_dev_raw.json raw,rawall,full (and DECIDER_PROMPT / DECIDER_ORDERS / DECIDER_TAG per variant)", "the decider's dev set (seed 11, 61 cases): five prompt variants and the full answer; RTX 3090 locked, but raw:habits on an A100"],
  ["decider_dev_summary.json", "node test/decider_analysis.mjs data/decider_dev_raw.json data/decider_dev_summary.json raw:habits", "its analysis for the chosen variant (agreement with the full answer, calibration, latency on the 3090)"],
  ["decider_raw.json", "LLM_URL=http://127.0.0.1:11445/v1 node test/decider_eval.mjs data/decider_raw.json raw,rawall,full (and per variant)", "the decider against the full answer on seed 7 (196 cases from 152 members), on an A100: five variants, the variants without code's filter, the full answer"],
  ["decider_raw_full2.json", "LLM_URL=http://127.0.0.1:11446/v1 node test/decider_eval.mjs data/decider_raw_full2.json full2", "the full answer again on the same cases, on a second A100 with the same model"],
  ["decider_summary.json", "node test/decider_analysis.mjs data/decider_raw.json,data/decider_raw_full2.json data/decider_summary.json raw:habits", "its analysis: agreement with cluster-bootstrap intervals, decline rate, preference hits, calibration, conformal thresholds, the cascade on held-out members"],
];
// test/run_final.sh's logs (the checks on the final code), and the crash-and-resume test on the real model
const LOGS = [["/tmp/final_e2e.log", "e2e.log", "node test/e2e.mjs", "the Messenger end-to-end test's output"], ["/tmp/final_unit.log", "unit.log", "node test/unit.mjs", "the unit tests' output"],
  ["/tmp/final_crash.log", "crash_matrix.log", "node test/crash_matrix.mjs", "the crash matrix's output (SIGKILL at each durable step, a stand-in model)"], ["/tmp/final_redteam.log", "redteam.log", "node test/redteam.mjs", "the adversarial suite's output"],
  ["/tmp/final_resume.log", "a2a_resume.log", "node test/a2a_resume.mjs", "the crash and resume test's output (the real model)"]];

fs.mkdirSync(OUT, { recursive: true });
const ollama = (process.env.LLM_URL || "http://127.0.0.1:11435/v1").replace(/\/v1$/, ""), model = process.env.LLM_MODEL || "muse-glimmer";
const get = async (p, body) => { try { const r = await fetch(ollama + p, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}); return r.ok ? r.json() : null; } catch { return null; } };
const version = await get("/api/version"), ps = await get("/api/ps"), loaded = ps?.models?.find((m) => m.name.startsWith(model));
// nothing from the server's own paths or addresses goes into the bundle
const clean = (t) => t.replace(/\/home\/[\w.-]+/g, "~").replace(/\b192\.168\.\d+\.\d+\b/g, "<server>");
const manifest = { made: new Date().toISOString(), commit: COMMIT, model: { name: model, digest: loaded?.digest || null, parameters: loaded?.details?.parameter_size || null, quantization: loaded?.details?.quantization_level || null, context: loaded?.context_length || null },
  ollama: version?.version || null, gpu: "RTX 3090 (GPU 1), 4 requests in parallel", seed: "simulated members: population.js seed 7", files: [] };
for (const [f, how, what] of FILES) {
  const src = path.join("data", f);
  if (!fs.existsSync(src)) continue;
  fs.writeFileSync(path.join(OUT, f), clean(fs.readFileSync(src, "utf8")));
  manifest.files.push({ file: f, what, made: fs.statSync(src).mtime.toISOString(), by: how });
}
for (const [src, f, how, what] of LOGS) {
  if (!fs.existsSync(src)) continue;
  fs.writeFileSync(path.join(OUT, f), clean(fs.readFileSync(src, "utf8")));
  manifest.files.push({ file: f, what, made: fs.statSync(src).mtime.toISOString(), by: how });
}
fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 1));
// the same list for people
const when = (t) => t.slice(0, 16).replace("T", " ");
fs.writeFileSync(path.join(OUT, "README.md"), `# Raw results

What every number in the README and docs comes from: the evaluations' own output files, copied from the GPU server
by \`agent/test/results_bundle.mjs\`${COMMIT ? ` (code at ${COMMIT})` : ""}. Model: ${model}${manifest.model.parameters ? ` (${manifest.model.parameters}, ${manifest.model.quantization}` : " ("}${manifest.model.context ? `, a ${manifest.model.context.toLocaleString("en-US")}-token context` : ""}${manifest.model.digest ? `, digest \`${manifest.model.digest.slice(0, 12)}\`` : ""}), Ollama ${manifest.ollama || "?"}, ${manifest.gpu}. Simulated members: population.js seed 7. Times are UTC.

The runs were made over the last day of work, so they span several commits: a run made before the commit named
above ran on the code of its own time (\`git log\` dates each commit). ${process.env.RESULTS_NOTE || ""}

| File | What it is | Made by | When |
|---|---|---|---|
${manifest.files.map((f) => `| \`${f.file}\` | ${f.what} | \`${f.by}\` | ${when(f.made)} |`).join("\n")}

\`manifest.json\` has the same list.
`);
console.log(`${manifest.files.length} files in ${OUT}; model ${manifest.model.name} ${manifest.model.digest?.slice(0, 12) || "?"}, Ollama ${manifest.ollama}`);

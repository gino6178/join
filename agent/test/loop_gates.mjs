// The gates for one change of the community loop (src/loop/gates.js), on the GPU server:
//   node test/loop_gates.mjs <spec.json | P-id> [--branch <branch>] [--only policy,scan,...] [--out <file>] [--endpoint <url>]
//   node test/loop_gates.mjs --example places.radius=3000 [--only ...]     a C0 spec for a declared flag
//   node test/loop_gates.mjs --baseline [unit,redteam,...]                 measure the suites as they are, into the baselines
// --endpoint http://127.0.0.1:11445: the suites use Muse Glimmer there, without the lock (by default: this server's
// GPU, under flock /tmp/serve-gpu.lock: the numbers that are reported). Each endpoint has its own baselines.
// Each gate prints PASS or FAIL as it finishes, with its seconds (and, under the lock, the seconds waited for it).
// Exits 0 when every gate run passed.
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] ?? "" : null; };
const { runGates, measureBaselines, baselinesFile, endpoint, ORDER } = await import("../src/loop/gates.js");
const flags = await import("../src/loop/flags.js");
const show = (r) => console.log(`  ${r.ok ? "PASS" : "FAIL"} ${r.gate ?? r.suite} (${r.details?.took ?? r.details?.seconds ?? "?"} s${r.details?.waitedForLock ? `, ${r.details.waitedForLock} s waiting for the lock` : ""}) ${JSON.stringify(r.details)}`);
const ep = opt("endpoint") || undefined, where = endpoint(ep);
console.log(`Muse Glimmer for the suites: ${where.url ? `${where.url} (no lock)` : "this server's GPU (under the lock)"}`);

if (opt("baseline") !== null) {
  const suites = opt("baseline") && !opt("baseline").startsWith("--") ? opt("baseline").split(",") : undefined;
  const b = await measureBaselines({ suites, onResult: show, endpoint: ep });
  console.log(`\nbaselines in ${baselinesFile(where.name)}:\n${JSON.stringify(b, null, 1)}`);
  process.exit(Object.values(b).every((x) => x?.ok !== false) ? 0 : 1);
}

let spec;
if (opt("example") !== null) {
  const [key, raw] = String(opt("example")).split("=");
  const d = flags.schema()[key];
  if (!d) { console.error(`${key} is not a declared flag`); process.exit(2); }
  spec = { id: "P-gates", title: `${key} to ${raw}`, cluster: "C-gates", status: "review", problem: { text: "(a gate run)", members: 5, unmet: 5, wishes: 0, votes: 0 },
    change: { class: "C0", key, value: d.type === "bool" ? raw === "true" : Number(raw), files: d.readers.map((f) => `agent/${f}`), summary: `${key}: ${d.default} to ${raw}` },
    oracle: { kind: "check", how: "every reader reads the key with flags.get, and every player gets the value in the scratch folder" }, privacy: "a config value: no player data", ruleOfTwo: [], reasons: [], history: [] };
} else {
  const values = ["branch", "only", "out", "endpoint"].map(opt);
  const a = args.find((x) => !x.startsWith("--") && !values.includes(x));
  if (!a) { console.error("usage: node test/loop_gates.mjs <spec.json | P-id> [--branch b] [--only gates] [--out file] [--endpoint url]"); process.exit(2); }
  const file = /^P-[\w-]+$/.test(a) ? path.join(process.env.LOOP_DIR || "data/loop", "proposals", `${a}.json`) : a;
  spec = JSON.parse(fs.readFileSync(file, "utf8"));
}
const only = opt("only") ? opt("only").split(",").filter((g) => ORDER.includes(g)) : null;
console.log(`gates for ${spec.id} (${spec.change?.class} ${spec.change?.key ?? ""}${spec.change?.value != null ? ` = ${spec.change.value}` : ""})${only ? `, only ${only.join(", ")}` : ""}`);
const t0 = Date.now();
const r = await runGates(spec, { branch: opt("branch") || null, only, onResult: show, endpoint: ep });
const out = { at: new Date().toISOString(), spec: { id: spec.id, change: spec.change }, seconds: +((Date.now() - t0) / 1000).toFixed(1), ...r };
if (opt("out")) fs.writeFileSync(opt("out"), JSON.stringify(out, null, 1));
console.log(`\n${r.results.filter((x) => x.ok).length} of ${r.results.length} gates passed in ${out.seconds} s on ${r.endpoint}${only ? ` (a subset: ${r.subsetOk ? "all passed" : "not all passed"}; a change ships only on all nine)` : r.pass ? ": ALL PASSED" : ""}`);
process.exit((only ? r.subsetOk : r.pass) ? 0 : 1);

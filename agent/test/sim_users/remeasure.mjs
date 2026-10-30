// The measures of a finished run again, from what it saved (serve.json, baseline.json, personas.json and the
// gateway's data folder), with this tree's metrics.mjs: a fix to a measure needs no new run.
//   node test/sim_users/remeasure.mjs <run folder> [--out file]
import fs from "node:fs";
import path from "node:path";
import { measure } from "./metrics.mjs";

const [dir] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!dir) { console.error("usage: remeasure.mjs <run folder> [--out file]"); process.exit(2); }
const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
const lines = fs.readFileSync(path.join(dir, "run.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const start = lines.find((x) => x.kind === "start");
const serve = read("serve.json"), base = read("baseline.json"), personas = read("personas.json").personas;
const result = measure({ run: start.run, seed: start.seed, arm: start.arm || "natural", dates: start.days, personas, serve, base, dataDir: path.join(dir, "agent/data") });
const i = process.argv.indexOf("--out"), out = i > 0 ? process.argv[i + 1] : path.join(dir, `sim_users_${start.run}.json`);
fs.writeFileSync(out, JSON.stringify(result, null, 1));
console.log(JSON.stringify(result.headline, null, 1));

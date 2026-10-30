// The photo-to-result reader on the synthetic scoreboards (test/sim/scores): what Muse Glimmer read against the
// label, whether the rules accepted it, and whether the instruction written on one board was ignored.
//   node test/vision_check.mjs
import fs from "node:fs";
process.env.LEDGER_FILE ||= "data/vision-ledger.jsonl"; process.env.TRACE_FILE ||= "data/vision-traces.jsonl";
const { readScore } = await import("../src/vision.js");
const dir = new URL("./sim/scores/", import.meta.url), labels = JSON.parse(fs.readFileSync(new URL("labels.json", dir), "utf8"));
let right = 0, rules = 0;
for (const l of labels) {
  const t0 = Date.now(), img = fs.readFileSync(new URL(l.file, dir)).toString("base64");
  const r = await readScore(img, { players: [l.first, l.second] });
  const same = r.read && JSON.stringify(r.games) === JSON.stringify(l.games);
  if (same) right++;
  if (r.read && r.valid === l.valid) rules++;
  console.log(`${l.file.padEnd(24)} read ${r.read ? r.games.map((g) => `${g.first}-${g.second}`).join(" ") : `no (${r.why})`}  ${same ? "= label" : "≠ label " + l.games.map((g) => `${g.first}-${g.second}`).join(" ")}  rules: ${r.read ? (r.valid ? "valid" : r.problems.join("; ")) : "-"}  ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
console.log(`\n${right} of ${labels.length} read exactly; the rules gave the right verdict on ${rules} of ${labels.length}`);

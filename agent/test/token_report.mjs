// The token report: the Autopilot eval run several times as the agent changed, each run's ledger side by side, and
// where the tokens went per call site in the first and the last run. Reads data/eval_<label>_tokens.json (and the rows
// in data/eval_<label>.json), writes Markdown.
//   node test/token_report.mjs out.md label1 label2 ...       (in the order the changes were made)
import fs from "node:fs";

const [OUT, ...labels] = process.argv.slice(2);
const load = (l) => ({ label: l, tok: JSON.parse(fs.readFileSync(`data/eval_${l}_tokens.json`, "utf8")), rows: JSON.parse(fs.readFileSync(`data/eval_${l}.json`, "utf8")) });
const runs = labels.map(load);
const k = (n) => (n >= 10000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const pct = (a, b) => (b ? `${a > b ? "+" : ""}${Math.round(((a - b) / b) * 100)}%` : "");
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

const lines = [];
lines.push("| Run | Weeks at goal | Seconds a week | Model calls a week | Prompt tokens a week (cached) | Written a week (of it reasoning) | Empty replies | Replies not in format | Member answers by quick pick |", "|---|---|---|---|---|---|---|---|---|");
const base = runs[0];
for (const r of runs) {
  const w = r.rows.length, t = r.tok.total, sec = mean(r.rows.map((x) => x.seconds)), qa = r.rows.reduce((a, x) => a + (x.quickAnswers || 0), 0), fa = r.rows.reduce((a, x) => a + (x.fullAnswers || 0), 0);
  const bsec = mean(base.rows.map((x) => x.seconds)), bt = base.tok.total, bw = base.rows.length;
  lines.push(`| ${r.label} | ${r.rows.filter((x) => x.success).length} of ${w} | ${sec.toFixed(0)}${r === base ? "" : ` (${pct(sec, bsec)})`} | ${(t.calls / w).toFixed(1)} | ${k(Math.round(t.prompt / w))} (${Math.round(t.cachedShare * 100)}%) | ${k(Math.round(t.output / w))} (${k(Math.round(t.reasoning / w))})${r === base ? "" : ` ${pct(t.output / w, bt.output / bw)}`} | ${t.empty} | ${t.invalid} | ${qa + fa ? `${qa} of ${qa + fa}` : "–"} |`);
}
const site = (r) => Object.fromEntries(r.tok.bySite.map((s) => [s.site, s]));
const first = site(runs[0]), last = site(runs.at(-1));
lines.push("", `Per call site, ${runs[0].label} against ${runs.at(-1).label} (per call):`, "", "| Call site | Calls | Prompt | Written | Seconds |", "|---|---|---|---|---|");
for (const name of [...new Set([...Object.keys(first), ...Object.keys(last)])].sort((a, b) => (last[b]?.seconds || first[b]?.seconds || 0) - (last[a]?.seconds || first[a]?.seconds || 0))) {
  const a = first[name], b = last[name], f = (x, g) => (x ? g(x) : "–");
  lines.push(`| \`${name}\` | ${f(a, (x) => x.calls)} → ${f(b, (x) => x.calls)} | ${f(a, (x) => x.perCall.prompt)} → ${f(b, (x) => x.perCall.prompt)} | ${f(a, (x) => x.perCall.output)} → ${f(b, (x) => x.perCall.output)} | ${f(a, (x) => x.perCall.seconds)} → ${f(b, (x) => x.perCall.seconds)} |`);
}
fs.writeFileSync(OUT, lines.join("\n") + "\n");
console.log(lines.join("\n"));

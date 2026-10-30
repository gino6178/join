// The club feed's photo screen, measured: every photo in test/sim/photos (labels.json: ordinary club photos, and
// unsafe stand-ins drawn by make.py) through posts.screenPhoto with the real models: Muse Glimmer's vision at LLM_URL,
// Prompt Guard 2 and Llama Guard 3 on this server's CPU. It reports the catch rate on the unsafe ones, the false
// refusals on the ordinary ones, what refused each, and the time, to ../submission/results/feed_photo_eval.json.
//   LLM_URL=http://127.0.0.1:11446/v1 node test/feed_photo_eval.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "serve-feed-photos-"));
Object.assign(process.env, { FEED_FILE: `${tmp}/feed.json`, FEED_MEDIA_DIR: `${tmp}/media`, FEED_DEMO: "off", LEDGER_FILE: `${tmp}/ledger.jsonl`, TRACE_FILE: `${tmp}/traces.jsonl`, LOOP_DIR: `${tmp}/loop`, STORE_FILE: `${tmp}/players.json`, LOOP_WATCH: "off" });
const S = await import("../src/feed/store.js");
const P = await import("../src/feed/posts.js");
const guard = await import("../src/guard.js");
const { health } = await import("../src/llm.js");

const DIR = new URL("./sim/photos/", import.meta.url), set = JSON.parse(fs.readFileSync(new URL("labels.json", DIR), "utf8")).photos;
const llm = await health();
console.log(`model ${llm.model} at ${llm.url}: ${llm.ready ? "ready" : llm.error}`);
const rows = [];
for (const x of set) {
  const m = S.putMedia(fs.readFileSync(new URL(x.file, DIR)), "image/jpeg"), t0 = Date.now();
  const r = await P.screenPhoto(m, "app");
  const row = { file: x.file, label: x.label, about: x.about, result: r.ok ? "shown" : r.down ? "waits" : "refused", check: r.check || null, verdict: r.verdict || null, why: r.why || null, describe: r.describe || null, text: r.text ?? null, seconds: +((Date.now() - t0) / 1000).toFixed(1) };
  rows.push(row);
  console.log(`${row.label.padEnd(6)} ${row.result.padEnd(7)} ${(row.check || "").padEnd(12)} ${row.seconds}s  ${x.file}${row.why ? `  (${row.why})` : ""}`);
}
const ok = rows.filter((r) => r.label === "ok"), bad = rows.filter((r) => r.label === "unsafe"), secs = rows.map((r) => r.seconds).sort((a, b) => a - b);
const out = {
  at: new Date().toISOString(), model: { url: llm.url, model: llm.model },
  ordinary: { n: ok.length, shown: ok.filter((r) => r.result === "shown").length, falseRefusals: ok.filter((r) => r.result === "refused").length, waited: ok.filter((r) => r.result === "waits").length },
  unsafe: { n: bad.length, caught: bad.filter((r) => r.result === "refused").length, missed: bad.filter((r) => r.result === "shown").length, waited: bad.filter((r) => r.result === "waits").length,
    by: bad.filter((r) => r.result === "refused").reduce((a, r) => ({ ...a, [r.check]: (a[r.check] || 0) + 1 }), {}) },
  seconds: { median: secs[Math.floor(secs.length / 2)], max: secs.at(-1) }, rows,
};
out.catchRate = +(out.unsafe.caught / out.unsafe.n).toFixed(3);
out.falseRefusalRate = +(out.ordinary.falseRefusals / out.ordinary.n).toFixed(3);
fs.mkdirSync("../submission/results", { recursive: true });
fs.writeFileSync("../submission/results/feed_photo_eval.json", JSON.stringify(out, null, 1));
console.log(`\ncaught ${out.unsafe.caught} of ${out.unsafe.n} unsafe (${out.unsafe.missed} missed, ${out.unsafe.waited} waited); refused ${out.ordinary.falseRefusals} of ${out.ordinary.n} ordinary; median ${out.seconds.median} s`);
guard.stopWorker();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);

// The club's reading agent, measured for real: the three paper services on the internet, Prompt Guard 2 on this
// server's CPU, Muse Glimmer at LLM_URL and Llama Guard 3 at GUARD_URL. It runs in a scratch folder (data/feed-eval),
// with the flag at 7 a week so three runs post up to seven papers, and writes what each step found, kept or dropped,
// and how long it took, to ../submission/results/feed_eval.json. No player data is involved.
//   LLM_URL=http://127.0.0.1:11446/v1 LLM_SLOTS=8 node test/feed_eval.mjs [runs]
import fs from "node:fs";
import path from "node:path";

const D = path.resolve("data/feed-eval");
fs.rmSync(D, { recursive: true, force: true }); fs.mkdirSync(D, { recursive: true });
Object.assign(process.env, { FEED_FILE: `${D}/feed.json`, FEED_CACHE_FILE: process.env.FEED_CACHE_FILE || path.resolve("data/feed-eval-cache.json"), FEED_DEMO: "off",
  LOOP_DIR: `${D}/loop`, STORE_FILE: `${D}/players.json`, LEDGER_FILE: `${D}/ledger.jsonl`, TRACE_FILE: `${D}/traces.jsonl`, LOOP_WATCH: "off" });
const papers = await import("../src/feed/papers.js");
const S = await import("../src/feed/store.js");
const P = await import("../src/feed/posts.js");
const flags = await import("../src/loop/flags.js");
const guard = await import("../src/guard.js");
const { health } = await import("../src/llm.js");

const runs = +(process.argv[2] || 3), t0 = Date.now();
const llm = await health();
console.log(`model ${llm.model} at ${llm.url}: ${llm.ready ? "ready" : llm.error}`);
flags.set("feed.papers.perWeek", 7, { by: "feed_eval", reason: "measure up to seven papers in one week" });
const log = [];
for (let i = 0; i < runs; i++) {
  const r = await papers.run({ manual: true, n: 3 });
  log.push(r);
  console.log(`run ${i + 1}: ${r.queries.join(" | ")}\n  found ${r.found}, too old or no abstract ${r.old}, duplicates ${r.duplicates}, fresh ${r.fresh}; Prompt Guard screened ${r.screened} (injected ${r.injected}, unscreened ${r.unscreened}); summarized ${r.summarized} (not sport ${r.unfit}, code refused ${r.rejected}); Llama Guard flagged ${r.flagged} (down ${r.guardDown}); posted ${r.posted} in ${r.seconds} s${r.errors.length ? `\n  source errors: ${r.errors.join("; ")}` : ""}`);
}
const sum = (k) => log.reduce((a, r) => a + (r[k] || 0), 0), all = (k) => log.flatMap((r) => r.timing[k]);
const stat = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? { n: s.length, median: s[Math.floor(s.length / 2)], max: s.at(-1), mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(3) } : { n: 0 }; };
const posts = S.data().posts.filter((p) => p.kind === "paper").map((p) => ({ title: p.paper.title, authors: p.paper.authors, year: p.paper.year, venue: p.paper.venue, link: p.paper.link, source: p.paper.source, sport: p.sport, summary: p.text, forWhom: p.forWhom, checks: p.checks }));
const out = {
  at: new Date().toISOString(), model: { url: llm.url, model: llm.model }, guard: { url: process.env.GUARD_URL || "http://127.0.0.1:11436", stats: guard.stats },
  totals: { runs, queries: log.reduce((a, r) => a + r.queries.length, 0), requests: sum("requests"), cachedRequests: sum("cached"), found: sum("found"), old: sum("old"), duplicates: sum("duplicates"), fresh: sum("fresh"),
    screened: sum("screened"), injected: sum("injected"), unscreened: sum("unscreened"), summarized: sum("summarized"), unfit: sum("unfit"), rejected: sum("rejected"), flagged: sum("flagged"), guardDown: sum("guardDown"), posted: sum("posted") },
  timing: { promptGuardSeconds: stat(all("promptGuard")), modelSeconds: stat(all("model")), llamaGuardSeconds: stat(all("llamaGuard")), runSeconds: log.map((r) => r.seconds), totalSeconds: +((Date.now() - t0) / 1000).toFixed(1) },
  errors: log.flatMap((r) => r.errors), runs: log.map(({ posts: ps, timing, ...r }) => ({ ...r, posts: ps })), posts,
  seen: Object.values(S.data().papers.seen).reduce((a, s) => { const k = s.why.replace(/: .*/, ""); a[k] = (a[k] || 0) + 1; return a; }, {}),
  feedView: P.feed("app").posts.length,
};
fs.mkdirSync("../submission/results", { recursive: true });
fs.writeFileSync("../submission/results/feed_eval.json", JSON.stringify(out, null, 1));
console.log(`\n${out.totals.posted} posted of ${out.totals.fresh} fresh papers (${out.totals.found} found); timing ${JSON.stringify(out.timing)}`);
guard.stopWorker();
process.exit(0);

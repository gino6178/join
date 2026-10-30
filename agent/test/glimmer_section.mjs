// The "Muse Glimmer in practice" section of docs/methods.md, written from test/glimmer_report.mjs's output, so the
// table is the measurement as it is.  node test/glimmer_section.mjs data/glimmer_in_practice.json
import fs from "node:fs";

const d = JSON.parse(fs.readFileSync(process.argv[2] || "data/glimmer_in_practice.json", "utf8"));
const label = { "a2a.answer": "a member's agent deciding a proposal", "autopilot.runWeek": "the Autopilot choosing its next tool", "a2a.pick": "the quick pick (off by default)",
  "places.judge": "judging a court", "life.read": "reading the calendar from a message", "ask.word": "wording \"want a game?\"", "vision.score": "reading a scoreboard photo", "body.read": "filing what hurts",
  "a2a.write": "writing an agent's message (before templates)", "body.summary": "the body report's summary", "answer": "your agent's answers from your own facts", "places.english": "a place's name in English" };
const pct = (x) => `${Math.round(x * 100)}%`;
const rows = d.sites.filter((s) => label[s.site] && s.calls >= 5);
console.log(`## Muse Glimmer in practice

Over the evaluations' ${d.calls.toLocaleString("en-US")} model calls (\`test/glimmer_report.mjs\`, over their token ledgers):
- **Reasoning.** ${pct(d.reasoningShare)} of the tokens Muse Glimmer writes are reasoning, from about a third when the
  Autopilot picks a tool to almost all of it for a short decision.
- **Empty replies.** ${pct(d.emptyShare)} of calls came back empty, nearly all of them the quick pick reasoning past
  its budget. That is why every call has room to reason beyond its answer, and why the quick pick is off.
- **Thinking switched off.** With \`think: false\` (or \`reasoning_effort: "none"\`), it still reasoned in a hidden channel
  and returned nothing, so Serve calls Ollama's \`/api/chat\` with \`think: "low"\`.

| Call site | Calls | Prompt (cached) | Written (reasoning) | Empty | Not fitting its schema | Bad tool arguments | Seconds, p50 / p95 |
|---|---|---|---|---|---|---|---|
${rows.map((s) => `| ${label[s.site]} (\`${s.site}\`) | ${s.calls} | ${s.promptPerCall} (${pct(s.cachedShare)}) | ${s.outputPerCall} (${pct(s.reasoningShare)}) | ${s.empty} | ${s.schemaCalls ? `${s.notFittingSchema} of ${s.schemaCalls}` : "–"} | ${s.site === "autopilot.runWeek" ? s.toolCallsWithBadArgs : "–"} | ${s.secondsP50} / ${s.secondsP95} |`).join("\n")}

Tokens are per call. "Not fitting its schema" counts replies asked for once more because they did not fit; constrained
decoding makes it rare.
`);

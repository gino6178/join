// What our Ollama gives for one pass with no reasoning (docs/decider.md): /api/generate with raw on, one token at
// temperature 0, and the next token's probabilities. Asked once each, on one dev question (population seed 11):
//   raw        raw on, logprobs with the top 20 (the decider's call)
//   word       a one-word prompt, raw: two tokens if raw adds the begin-of-text token by itself
//   bos        the question with the begin-of-text token written into the prompt as well (so then it is there twice)
//   top21      top_logprobs 21 (the server's limit)
//   templated  raw off, think off: the chat template, so the reasoning channel comes first
//   ask        the native decision request (questions), which this Ollama keeps for decision models: for Muse Glimmer
//              it is ignored, and the model reasons as for any prompt
// LLM_URL picks the server (the evals ran on http://127.0.0.1:11445/v1, an A100 with the same model).
//   node test/decider_probe.mjs out.json
import fs from "node:fs";

process.env.SIM_ONLY ||= "1"; process.env.LEDGER_FILE ||= "data/decider-ledger.jsonl";
const { population } = await import("../src/population.js");
const { decisionPrompt } = await import("../src/decider.js");
const BASE = (process.env.LLM_URL || "http://127.0.0.1:11435/v1").replace(/\/v1\/?$/, ""), MODEL = process.env.LLM_MODEL || "muse-glimmer";
const m = population(300, 11).find((x) => x.rules.endBy && x.prefers !== "doubles");
const times = [{ text: "Tue 3 Nov 19:00–20:30 at Riverside Sports Centre, court 2 (trips: you 9 min, A 15 min)" }, { text: "Sat 7 Nov 09:00–10:30 at Riverside Sports Centre, court 1 (trips: you 9 min, A 15 min)" }];
const { text } = decisionPrompt({ profile: `You are ${m.name}'s agent. ${m.agent}`, rule: "Decide by this rule: ask for the listed time they like best.", them: m.name.split(" ")[0], sport: "badminton", format: "singles", cur: "Tue 3 Nov 20:30–22:00", why: `it ends after ${m.rules.endBy}`, times });
const post = async (url, body) => { const t0 = Date.now(), r = await fetch(BASE + url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); const s = await r.text(); let j; try { j = JSON.parse(s); } catch { j = { text: s.slice(0, 300) }; } return { status: r.status, ms: Date.now() - t0, j }; };
const gen = (extra) => post("/api/generate", { model: MODEL, prompt: text, stream: false, keep_alive: "24h", options: { num_predict: 1, temperature: 0 }, ...extra });
const brief = ({ status, ms, j }) => ({ status, ms, error: j.error, response: j.response, thinking: j.thinking, done_reason: j.done_reason, prompt_eval_count: j.prompt_eval_count, eval_count: j.eval_count,
  top: (j.logprobs?.[0]?.top_logprobs || []).slice(0, 8).map((t) => [t.token, +Math.exp(t.logprob).toFixed(4)]), topCount: j.logprobs?.[0]?.top_logprobs?.length ?? null, fields: Object.keys(j) });
const out = { at: new Date().toISOString(), url: BASE, version: (await (await fetch(BASE + "/api/version")).json()).version, model: MODEL, member: m.id, promptChars: text.length };
out.raw = brief(await gen({ raw: true, logprobs: true, top_logprobs: 20 }));
out.word = brief(await gen({ raw: true, prompt: "Hello" }));
out.bos = brief(await gen({ raw: true, logprobs: true, top_logprobs: 20, prompt: "<|begin_of_text|>" + text }));
out.top21 = brief(await gen({ raw: true, logprobs: true, top_logprobs: 21 }));
out.templated = brief(await gen({ think: false, logprobs: true, top_logprobs: 20 }));
out.ask = brief(await post("/api/generate", { model: MODEL, prompt: text, stream: false, questions: [{ question: "Which listed time does the member like best?", choices: [{ label: "A", description: times[0].text }, { label: "B", description: times[1].text }] }] }));
fs.writeFileSync(process.argv[2] || "data/decider_probe.json", JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));

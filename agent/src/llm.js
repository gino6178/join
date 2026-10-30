// Client for the agents' language model. LLM_URL points at whichever runs it:
//   by default our own GPU, where Ollama serves Muse Glimmer, Meta's open-weights model (http://127.0.0.1:11435/v1,
//   LLM_MODEL=muse-glimmer); or the Meta Model API with Muse Spark (LLM_URL=https://api.meta.ai/v1,
//   LLM_MODEL=muse-spark-1.3, MODEL_API_KEY=<key>).
// Ollama is asked through its own chat API, with thinking at "low". Glimmer told not to think (think: false, or
// reasoning_effort "none") goes on reasoning out of sight, and may spend the whole token budget there and send back an
// empty reply; at "low" its reasoning is short and arrives apart from the reply, so the budget is left for the answer.
// Every other server (llama.cpp, vLLM, SGLang, the Meta Model API) is asked for OpenAI-compatible chat completions
// (LLM_API=openai, which a key also implies).
// Every call goes in the token ledger (ledger.js) under its call site: the caller's file and function ("a2a.answer"),
// or the `site` a caller names. The reasoning budget is set per call site (BUDGETS, or LLM_BUDGETS as JSON to try
// others). A caller can pass a JSON Schema as `format`: the server constrains the reply to it, and chatJSON checks it.
// Each call is also an OpenTelemetry span, "chat <model>", with the GenAI conventions' attributes (trace.js).
import { record, current } from "./ledger.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { span, active, traceId, SpanKind } from "./trace.js";
import { validate } from "./schema.js";

// The server and how to ask it, read once when the gateway starts. A key (MODEL_API_KEY, or LLM_API_KEY) stands for a
// hosted API: every request carries it, and the protocol is OpenAI's unless LLM_API names another.
const KEY = [process.env.MODEL_API_KEY, process.env.LLM_API_KEY].find(Boolean) || "";
const DEFAULTS = {
  LLM_URL: "http://127.0.0.1:11435/v1", // Muse Glimmer on our own GPU
  LLM_MODEL: "muse-glimmer",
  LLM_API: KEY ? "openai" : "ollama",
  LLM_TIMEOUT_MS: 180000,
  LLM_THINK: "low", // false, low, medium or high
};
const setting = (name) => process.env[name] || DEFAULTS[name];
const BASE = setting("LLM_URL").replace(/\/$/, ""); // where the OpenAI-compatible routes are (.../v1)
const ROOT = BASE.replace(/\/v1$/, ""); // Ollama's own routes (/api/chat, /api/generate) sit beside them
const MODEL = setting("LLM_MODEL"), API = setting("LLM_API"), TIMEOUT = +setting("LLM_TIMEOUT_MS"), THINKING = setting("LLM_THINK");
const THINK_BUDGET = +(process.env.LLM_THINK_TOKENS || 900); // tokens allowed for reasoning on top of the reply, by default
// tokens allowed for reasoning beyond the answer, per call site (LLM_BUDGETS; test/budget_probe.mjs measures them)
export const BUDGETS = { ...JSON.parse(process.env.LLM_BUDGETS || "{}") };
const THINK = /<think>[\s\S]*?<\/think>\s*|<\|[a-z_]+\|>/g; // a reasoning block, or a special token that leaked into the reply
const HEADERS = { "content-type": "application/json" };
if (KEY) HEADERS.authorization = `Bearer ${KEY}`;

// The hardware a reply names (and /api/status): LLM_DEVICE when it is set, else what the key or its absence implies.
export function device() {
  if (process.env.LLM_DEVICE) return process.env.LLM_DEVICE;
  return KEY ? "Meta Model API" : "local GPU";
}
// LLM_DEBUG, when set, names a file that gets each exchange as one JSON line, { messages, response }, to read back later
async function debug(messages, response) {
  const file = process.env.LLM_DEBUG;
  if (!file) return;
  const { appendFileSync } = await import("node:fs");
  appendFileSync(file, `${JSON.stringify({ messages, response })}\n`);
}
// A POST to the model server, resolving to the response once it is a success. Any other status rejects with the status
// and the first 200 characters the server sent back, so the caller's log says what the server objected to.
async function send(url, init) {
  const res = await fetch(url, { method: "POST", headers: HEADERS, ...init });
  if (res.ok) return res;
  const said = (await res.text()).slice(0, 200);
  throw new Error(`LLM server ${res.status}: ${said}`);
}
// how long a reply took and how fast it came out, as the chat callers return it
const timing = (secs, rate) => ({ seconds: +secs.toFixed(2), tokens_per_s: rate ? +rate.toFixed(1) : null, device: device() });

// every model call is counted, with how many ran at the same time (the agent runs read it for their reports)
export const stats = { calls: 0, seconds: 0, inflight: 0, peak: 0 };
const begin = () => { stats.calls++; stats.inflight++; stats.peak = Math.max(stats.peak, stats.inflight); return Date.now(); };
const end = (t0) => { stats.inflight--; stats.seconds += (Date.now() - t0) / 1000; };

// Who goes first. The model server runs LLM_SLOTS requests at once (OLLAMA_NUM_PARALLEL, 4), and the gateway keeps to
// that itself so it can choose the order: a call someone is waiting on (a reply in Messenger, "want a game?", the
// members' answers in a talk the player started) goes before background work (anything inside an Autopilot run, and
// the members' answers in its talks, which carry the priority in their A2A message). Without this, a week planned in
// the background holds every slot and the player's reply waits behind it. Each call's wait is in the ledger
// (queuedMs). LLM_PRIORITY=off sends every call straight to the server, as before (test/load_eval.mjs compares them).
const SLOTS = Math.max(1, Math.floor(+process.env.LLM_SLOTS || 4)), waiting = [], prioScope = new AsyncLocalStorage();
let running = 0;
export const withPriority = (p, fn) => prioScope.run(p === "background" ? 1 : 0, fn);
export function priorityOf() {
  const p = prioScope.getStore();
  if (p != null) return p;
  for (let j = current(); j; j = j.parent) if (j.name === "autopilot" || j.name.startsWith("background")) return 1;
  return 0;
}
const slotError = (ms) => Object.assign(new Error(`no model slot came free in ${Math.round(ms / 1000)} s`), { slot: true });
function acquire(prio, limitMs = Infinity) {
  if (process.env.LLM_PRIORITY === "off") return Promise.resolve(() => {});
  return new Promise((ok, no) => {
    let timer = null;
    const go = () => { clearTimeout(timer); running++; let done = false; ok(() => { if (done) return; done = true; running--; waiting.shift()?.go(); }); };
    if (running < SLOTS) return go();
    const w = { prio, go }, i = waiting.findIndex((x) => x.prio > prio); // after everyone of the same priority, before anyone lower
    i < 0 ? waiting.push(w) : waiting.splice(i, 0, w);
    // a call still waiting when its time limit is up leaves the queue: its caller has stopped waiting for it
    if (Number.isFinite(limitMs)) timer = setTimeout(() => { const k = waiting.indexOf(w); if (k >= 0) { waiting.splice(k, 1); no(slotError(limitMs)); } }, limitMs);
  });
}

// the call site: the first frame outside this file, as file.function ("a2a.answer"), or file:line for an anonymous one
function siteOf() {
  for (const l of (new Error().stack || "").split("\n").slice(2)) {
    const m = /at (?:async )?(?:([\w$.<>]+) \()?[^()\s]*?[\\/]([\w-]+)\.m?js:(\d+)/.exec(l);
    if (!m || m[2] === "llm") continue;
    const fn = m[1] && !/^(Object|Promise|Array|<anonymous>|new)/.test(m[1]) ? m[1].split(".").pop() : null;
    return fn ? `${m[2]}.${fn}` : `${m[2]}:${m[3]}`;
  }
  return "unknown";
}
const budgetOf = (site, budget) => budget ?? BUDGETS[site] ?? THINK_BUDGET;
// the thinking level for a call: its own (false turns reasoning off), else the default
const levelOf = (think) => (think != null ? think : THINKING === "false" ? false : THINKING);
// the seconds the server spent reading the prompt and writing the reply (Ollama's own counts): unlike `seconds`, this
// leaves out the wait for a free slot on a server others use too
const computeOf = (j) => (j.prompt_eval_duration != null || j.eval_duration != null ? +(((j.prompt_eval_duration || 0) + (j.eval_duration || 0)) / 1e9).toFixed(3) : undefined);
// a row for the ledger from one reply. Ollama gives the reasoning as text beside the reply; its share of the output
// tokens is estimated from the two lengths
function ledgerRow(site, j, secs, extra) {
  const m = j.message || {}, think = (m.thinking || "").length, said = (m.content || "").length + JSON.stringify(m.tool_calls || "").length;
  const output = j.eval_count || 0;
  return toSpan(record({ site, model: MODEL, prompt: j.prompt_eval_count || 0, cached: j.prompt_eval_cached_count || 0, output,
    reasoning: think ? Math.round(output * think / (think + said)) : 0, seconds: +secs.toFixed(2), compute: computeOf(j), empty: !(m.content || "").trim() && !m.tool_calls?.length, trace: traceId(), ...extra }), j.done_reason);
}
// what a model call cost, on its span (the OpenTelemetry GenAI conventions: the cache and reasoning counts are part
// of the input and output counts; and Serve's own beside them)
function toSpan(r, finish) {
  active()?.setAttributes({ "gen_ai.usage.input_tokens": r.prompt, "gen_ai.usage.output_tokens": r.output, ...(r.cached ? { "gen_ai.usage.cache_read.input_tokens": r.cached } : {}), ...(r.reasoning ? { "gen_ai.usage.reasoning.output_tokens": r.reasoning } : {}),
    "gen_ai.response.model": r.model || MODEL, "serve.budget": r.budget ?? 0, "serve.empty": !!r.empty, ...(finish ? { "gen_ai.response.finish_reasons": [finish] } : {}) });
  return r;
}
const callSpan = (site, attrs, fn) => span(`chat ${MODEL}`, { "gen_ai.operation.name": "chat", "gen_ai.provider.name": API === "ollama" ? "ollama" : "openai", "gen_ai.request.model": MODEL, ...(levelOf(null) ? { "gen_ai.request.reasoning.level": String(levelOf(null)) } : {}), "serve.site": site, ...attrs }, fn, SpanKind.CLIENT);
// (a model call that ran out of time ends with error.type timeout: attribution.js reads it)
const timedOut = (e) => /abort|no model slot came free/i.test(String(e?.name) + String(e?.message));
const marked = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { active()?.setAttributes({ "error.type": timedOut(e) ? "timeout" : e?.name && e.name !== "Error" ? e.name : "_OTHER" }); throw e; } };

export function chat(messages, opts = {}) {
  const site = opts.site || siteOf();
  return callSpan(site, { "gen_ai.request.temperature": opts.temperature ?? 0.4, "gen_ai.request.max_tokens": opts.maxTokens ?? 420, "serve.format": !!opts.format, ...(opts.format ? { "gen_ai.output.type": "json" } : {}) }, marked(() => rawChat(messages, { ...opts, site })));
}
// an image on a message: Ollama takes base64 in `images`; an OpenAI-compatible server takes image_url parts (data URIs)
const mimeOf = (b64) => (b64.startsWith("iVBOR") ? "image/png" : b64.startsWith("UklGR") ? "image/webp" : "image/jpeg");
const openaiMessages = (ms) => ms.map(({ images, ...m }) => (images?.length ? { ...m, content: [{ type: "text", text: m.content }, ...images.map((b) => ({ type: "image_url", image_url: { url: `data:${mimeOf(b)};base64,${b}` } }))] } : m));
async function rawChat(messages, { maxTokens = 420, temperature = 0.4, site = siteOf(), format = null, think = null, budget: own = null, logprobs = 0, extra = null, timeoutMs = TIMEOUT } = {}) {
  // (the wait for a slot counts against the call's time limit, so a call never outlives what its caller waits for)
  const prio = priorityOf(), w0 = Date.now(), release = await acquire(prio, timeoutMs), q = { queuedMs: Date.now() - w0, priority: prio ? "background" : "now" };
  if (q.queuedMs >= timeoutMs) { release(); throw slotError(timeoutMs); }
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeoutMs - q.queuedMs);
  const level = levelOf(think), t0 = begin(), budget = level === false ? 0 : budgetOf(site, own);
  try {
    if (API !== "ollama") {
      // OpenAI's protocol: images go as image_url parts, a schema as response_format, and the usage block has the counts
      const r = await send(`${BASE}/chat/completions`, {
        signal: ctl.signal,
        body: JSON.stringify({ model: MODEL, messages: openaiMessages(messages), max_tokens: maxTokens, temperature, ...(format ? { response_format: { type: "json_schema", json_schema: { name: "reply", schema: format } } } : {}) }),
      });
      const j = await r.json();
      const secs = (Date.now() - t0) / 1000, n = j.usage?.completion_tokens;
      await debug(messages, j);
      toSpan(record({ site, model: MODEL, ...q, prompt: j.usage?.prompt_tokens || 0, cached: j.usage?.prompt_tokens_details?.cached_tokens || 0, output: n || 0, reasoning: j.usage?.completion_tokens_details?.reasoning_tokens || 0,
        seconds: +secs.toFixed(2), empty: !(j.choices[0].message.content || "").trim(), budget, format: !!format, trace: traceId() }), j.choices[0].finish_reason);
      const said = j.choices[0].message.content || "";
      // (a server that sends its own timing is taken at its word)
      return { text: said.replace(THINK, "").trim(), timing: j.timing ?? timing(secs, n ? n / secs : null) };
    }
    // Ollama's own chat: thinking set per call, the reply budget plus the reasoning budget as num_predict
    const r = await send(`${ROOT}/api/chat`, {
      signal: ctl.signal,
      body: JSON.stringify({ model: MODEL, messages, stream: false, think: level, keep_alive: "24h", ...(format ? { format } : {}),
        ...(logprobs ? { logprobs: true, top_logprobs: logprobs } : {}), options: { num_predict: maxTokens + budget, temperature } }),
    });
    const j = await r.json();
    const secs = (Date.now() - t0) / 1000;
    await debug(messages, j);
    ledgerRow(site, j, secs, { budget, format: !!format, ...q, ...(extra || {}) });
    // the speed by Ollama's own clock for the generation (eval_duration, in ns), which leaves the prompt out
    const genSecs = j.eval_duration / 1e9;
    return { text: (j.message?.content || "").replace(THINK, "").trim(), logprobs: j.logprobs || null,
      timing: timing(secs, genSecs ? j.eval_count / genSecs : null) };
  } finally { clearTimeout(t); end(t0); release(); }
}

// a reply in a JSON Schema: the server constrains decoding to it, code parses and checks it, and a reply that does not
// fit is asked for once more with what was wrong. Returns { value, errors } (value null when it never fitted).
export async function chatJSON(messages, schema, { site = siteOf(), tries = 2, ...opts } = {}) {
  let errors = ["no reply"], msgs = messages;
  for (let k = 0; k < tries; k++) {
    let text = "";
    // (no slot came free in time: asking again would only wait again, past what the caller waits for)
    try { ({ text } = await chat(msgs, { ...opts, site, format: schema })); } catch (e) { errors = [String(e.message || e)]; if (e.slot) break; continue; }
    let value;
    try { value = JSON.parse(text); errors = validate(schema, value); } catch { errors = ["not JSON"]; }
    if (!errors.length) return { value, errors: [], tries: k + 1 };
    record({ site, model: MODEL, prompt: 0, cached: 0, output: 0, reasoning: 0, seconds: 0, invalid: true, marker: true, errors: errors.slice(0, 3) });
    msgs = [...messages, { role: "assistant", content: text.slice(0, 600) }, { role: "user", content: `That does not fit the format: ${errors.slice(0, 3).join("; ")}. Answer again as JSON that fits.` }];
  }
  return { value: null, errors, tries };
}

// a quick pick: the model answers with one option id only (the format allows nothing else) and no reasoning, and the
// probability it gave that id, against the other ids, is turned into a confidence from 0 (a guess among n options)
// to 1 (certain): (p - 1/n) / (1 - 1/n). The caller decides by confidence band whether to act on it, or to ask the full
// agent. A server that gives no token probabilities returns confidence null.
// It reasons briefly first (a short budget): with reasoning off, the format still forces an id out, but the model's own
// next word was the start of its reasoning, so the probabilities say nothing about the choice.
export async function pick(messages, ids, { site = siteOf(), temperature = 0, budget = 300, timeoutMs } = {}) {
  const r = await chat(messages, { maxTokens: 12, temperature, site, budget: BUDGETS[site] ?? budget, format: { type: "string", enum: ids }, logprobs: 10, ...(timeoutMs ? { timeoutMs } : {}) });
  let picked = null;
  try { picked = JSON.parse(r.text); } catch { picked = r.text.replace(/"/g, "").trim(); }
  const idOf = (t) => String(t || "").replace(/["\s]/g, "");
  const first = (r.logprobs || []).find((t) => ids.includes(idOf(t.token)));
  const mass = {};
  for (const t of first?.top_logprobs || []) { const k = idOf(t.token); if (ids.includes(k)) mass[k] = (mass[k] || 0) + Math.exp(t.logprob); }
  const sum = Object.values(mass).reduce((a, b) => a + b, 0), n = ids.length;
  const p = sum && ids.includes(picked) ? (mass[picked] || 0) / sum : null;
  return { pick: ids.includes(picked) ? picked : null, p: p == null ? null : +p.toFixed(3), confidence: p == null ? null : +Math.max(0, (p - 1 / n) / (1 - 1 / n)).toFixed(3), dist: sum ? Object.fromEntries(Object.entries(mass).map(([k, v]) => [k, +(v / sum).toFixed(3)])) : null };
}

// One pass, nothing generated: a prompt of plain text, sent through Ollama's /api/generate with raw on (no chat
// template, so no reasoning channel), for one token at temperature 0, and the `top` most likely next tokens with their
// log probabilities. The caller reads its options' probabilities from them (decider.js). Ollama only: another server
// gives null, and the caller does without.
export function nextToken(prompt, { site = siteOf(), top = 20, timeoutMs = TIMEOUT } = {}) {
  return callSpan(site, { "gen_ai.request.temperature": 0, "gen_ai.request.max_tokens": 1, "serve.raw": true }, async () => {
    if (API !== "ollama") return null;
    const prio = priorityOf(), w0 = Date.now(), release = await acquire(prio, timeoutMs), q = { queuedMs: Date.now() - w0, priority: prio ? "background" : "now" };
    if (q.queuedMs >= timeoutMs) { release(); throw slotError(timeoutMs); }
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeoutMs - q.queuedMs), t0 = begin();
    try {
      const r = await send(`${ROOT}/api/generate`, {
        signal: ctl.signal,
        body: JSON.stringify({ model: MODEL, prompt, raw: true, stream: false, keep_alive: "24h", logprobs: true, top_logprobs: top, options: { num_predict: 1, temperature: 0 } }),
      });
      const j = await r.json(), secs = (Date.now() - t0) / 1000, lp = (j.logprobs || [])[0] || null;
      await debug(prompt, j);
      toSpan(record({ site, model: MODEL, prompt: j.prompt_eval_count || 0, cached: j.prompt_eval_cached_count || 0, output: j.eval_count || 0, reasoning: 0, seconds: +secs.toFixed(2), compute: computeOf(j),
        empty: !lp, budget: 0, raw: true, ...q, trace: traceId() }), j.done_reason);
      return { token: lp ? lp.token : j.response || "", top: lp?.top_logprobs || [], prompt: j.prompt_eval_count || 0, output: j.eval_count || 0, seconds: +secs.toFixed(3), compute: computeOf(j) };
    } finally { clearTimeout(t); end(t0); release(); }
  });
}

// one turn of a tool-using agent: the model either answers or asks for tools. Returns { text, calls: [{ name, args }],
// message } where message is what to append to the conversation before the tool results. Muse Glimmer through Ollama's
// native tool calling; any OpenAI-compatible server (Meta Model API included) through function calling. Each call's
// arguments are checked against that tool's parameters schema; a call that does not fit carries `errors`.
export function chatTools(messages, tools, opts = {}) {
  const site = opts.site || siteOf();
  // (how the turn ended, for attribution.js: how many tool calls, how many did not fit, and whether the model wrote
  // words instead, a refusal among them; never the words)
  return callSpan(site, { "gen_ai.request.temperature": opts.temperature ?? 0.2, "gen_ai.request.max_tokens": opts.maxTokens ?? 500, "serve.tools": tools.length }, marked(async () => {
    const out = await rawChatTools(messages, tools, { ...opts, site });
    active()?.setAttributes({ "serve.tool_calls": out.calls.length, "serve.invalid_calls": out.calls.filter((c) => c.errors).length, "serve.text_reply": !out.calls.length && !!out.text, ...(!out.calls.length && REFUSAL.test(out.text) ? { "serve.refusal": true } : {}) });
    return out;
  }));
}
async function rawChatTools(messages, tools, { maxTokens = 500, temperature = 0.2, site = siteOf(), think = null, budget: own = null } = {}) {
  const prio = priorityOf(), w0 = Date.now(), release = await acquire(prio, TIMEOUT), q = { queuedMs: Date.now() - w0, priority: prio ? "background" : "now" };
  if (q.queuedMs >= TIMEOUT) { release(); throw slotError(TIMEOUT); }
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), TIMEOUT - q.queuedMs);
  const level = levelOf(think), t0 = begin(), budget = level === false ? 0 : budgetOf(site, own);
  const check = (c) => { const tool = tools.find((x) => x.function?.name === c.name); const errors = tool ? validate(tool.function.parameters || {}, c.args || {}) : [`no tool called ${c.name}`]; return errors.length ? { ...c, errors } : c; };
  try {
    if (API !== "ollama") {
      // function calling the OpenAI way: the arguments arrive as a JSON string, and the call keeps its id for the result
      const r = await send(`${BASE}/chat/completions`, {
        signal: ctl.signal,
        body: JSON.stringify({ model: MODEL, messages, tools, max_tokens: maxTokens, temperature }),
      });
      const j = await r.json(), m = j.choices[0].message;
      await debug(messages, j);
      const calls = (m.tool_calls || []).map((c) => check({ id: c.id, name: c.function?.name, args: safeJSON(c.function?.arguments) }));
      toSpan(record({ site, model: MODEL, ...q, prompt: j.usage?.prompt_tokens || 0, cached: j.usage?.prompt_tokens_details?.cached_tokens || 0, output: j.usage?.completion_tokens || 0, reasoning: j.usage?.completion_tokens_details?.reasoning_tokens || 0,
        seconds: +((Date.now() - t0) / 1000).toFixed(2), empty: !(m.content || "").trim() && !calls.length, budget, tools: tools.length, trace: traceId() }), j.choices[0].finish_reason);
      return { text: (m.content || "").replace(THINK, "").trim(), calls, message: m, seconds: +((Date.now() - t0) / 1000).toFixed(2) };
    }
    // Ollama's native tool calling, with the same thinking level and budget as a plain chat
    const r = await send(`${ROOT}/api/chat`, {
      signal: ctl.signal,
      body: JSON.stringify({ model: MODEL, messages, tools, stream: false, think: level, keep_alive: "24h",
        options: { num_predict: maxTokens + budget, temperature } }),
    });
    const j = await r.json(), m = j.message || {};
    await debug(messages, j);
    const calls = (m.tool_calls || []).map((c) => check({ name: c.function?.name, args: typeof c.function?.arguments === "string" ? safeJSON(c.function.arguments) : c.function?.arguments || {} }));
    ledgerRow(site, j, (Date.now() - t0) / 1000, { budget, tools: tools.length, invalidCalls: calls.filter((c) => c.errors).length || undefined, ...q });
    return { text: (m.content || "").replace(THINK, "").trim(), calls, message: { role: "assistant", content: m.content || "", tool_calls: m.tool_calls }, seconds: +((Date.now() - t0) / 1000).toFixed(2) };
  } finally { clearTimeout(t); end(t0); release(); }
}
const safeJSON = (s) => { try { return JSON.parse(s || "{}"); } catch { return {}; } };
const REFUSAL = /\b(I can(?:no|')t|I am unable|I'm unable|I won't|I will not|sorry)\b/i;

// Is the model there? Each server here lists its models the OpenAI way (GET /models: Ollama, llama.cpp, vLLM, SGLang,
// the Meta Model API), and Ollama tags its names ("muse-glimmer:latest"), so the name counts with a tag or without.
// It never throws: a server that is down or answers nonsense is reported, with what went wrong.
export async function health() {
  const status = { url: BASE, ready: false, model: MODEL };
  try {
    const res = await fetch(`${BASE}/models`, { headers: HEADERS, signal: AbortSignal.timeout(4000) });
    const names = ((await res.json()).data ?? []).map((m) => m.id);
    status.ready = names.some((id) => [id, id.split(":")[0]].includes(MODEL));
    return { ...status, device: device(), error: status.ready ? null : `model ${MODEL} not loaded` };
  } catch (e) {
    return { ...status, error: String(e.message || e) };
  }
}

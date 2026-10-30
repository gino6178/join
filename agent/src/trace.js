// Tracing with OpenTelemetry (the official JS SDK, Apache 2.0). Spans follow the OpenTelemetry GenAI semantic
// conventions for agents and the A2A conventions, as they stand in the semantic-conventions-genai repository at commit
// 51a0f58 (2026-10-27; built on semantic-conventions v1.44.0; both still Development status, so names may change):
//   invoke_agent <name>   an agent in this process at work (span kind INTERNAL): the Autopilot, the Match and Talk
//                         helpers, a member's agent answering. gen_ai.agent.name, a stable gen_ai.agent.id
//                         (serve.<name>, never an instance id), gen_ai.agent.version, and gen_ai.conversation.id when
//                         there is a real one: an Autopilot run's id (kept across a restart), a talk's A2A contextId.
//   invoke_agent member:<id>  your agent invoking a member's agent over A2A (kind CLIENT): gen_ai.agent.id is the
//                         agent's A2A address, gen_ai.provider.name "serve" (the club's own agents), server.address/port
//     SendMessage         under it, the A2A request itself (kind CLIENT): a2a.method.name, a2a.message.id,
//                         a2a.task.id and a2a.task.state from the answer, a2a.protocol.version, and the contextId as
//                         gen_ai.conversation.id. A hold or an estimate is a SendMessage on its own (serve.a2a.kind).
//                         The W3C traceparent goes with the request, and the member's side continues the same trace.
//   chat <model>          one model call (kind CLIENT): gen_ai.request.model, gen_ai.usage.input_tokens / output_tokens,
//                         gen_ai.usage.cache_read.input_tokens, gen_ai.usage.reasoning.output_tokens,
//                         gen_ai.request.reasoning.level, gen_ai.response.finish_reasons (and Serve's serve.site)
//   execute_tool <name>   one tool call in the Autopilot's loop (INTERNAL): gen_ai.tool.name, gen_ai.tool.type
//                         "function", gen_ai.tool.description, gen_ai.tool.call.id when the model gave one. A call that
//                         did not do what was asked ends in error, with an error.type from the list in errorType().
// Content stays out (the opt-in gen_ai.input.messages, gen_ai.tool.call.arguments and .result are never recorded).
// Every name or attribute Serve adds is under serve.*. attribution.js reads these spans to name the step a failed
// run ended on.
// Spans go to data/traces.jsonl and to a window in memory for /api/traces, which the app draws as a waterfall. With
// OTEL_EXPORTER_OTLP_ENDPOINT set and @opentelemetry/exporter-trace-otlp-http installed they also go to any OTLP
// collector (Jaeger, Tempo, ...). No message contents are recorded, only names, ids, counts and timings: the body log
// is health data.
import fs from "node:fs";
import path from "node:path";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { SimpleSpanProcessor, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { trace, context, propagation, SpanKind, SpanStatusCode } from "@opentelemetry/api";

const FILE = path.resolve(process.env.TRACE_FILE || "data/traces.jsonl");
const recent = [];
const ms = (t) => t[0] * 1e3 + t[1] / 1e6;
const row = (s) => ({ traceId: s.spanContext().traceId, spanId: s.spanContext().spanId, parentId: s.parentSpanContext?.spanId || null, name: s.name, kind: s.kind,
  start: +ms(s.startTime).toFixed(1), ms: +ms(s.duration).toFixed(1), status: s.status.code === SpanStatusCode.ERROR ? "error" : "ok", error: s.status.message || undefined, attributes: s.attributes, service: s.resource.attributes["service.name"] });
class FileExporter {
  export(spans, done) {
    const rows = spans.map(row);
    recent.push(...rows); if (recent.length > 5000) recent.splice(0, recent.length - 5000);
    try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.appendFileSync(FILE, rows.map((r) => JSON.stringify(r)).join("\n") + "\n"); } catch { /* tracing never stops the work */ }
    done({ code: 0 });
  }
  shutdown() { return Promise.resolve(); }
}
const processors = [new SimpleSpanProcessor(new FileExporter())];
if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  try { const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http"); processors.push(new BatchSpanProcessor(new OTLPTraceExporter())); }
  catch { console.error("OTEL_EXPORTER_OTLP_ENDPOINT is set but @opentelemetry/exporter-trace-otlp-http is not installed"); }
}
const provider = new NodeTracerProvider({ resource: resourceFromAttributes({ "service.name": process.env.OTEL_SERVICE_NAME || "serve-gateway", "service.version": "1.0.0" }), spanProcessors: processors });
provider.register();
export const tracer = trace.getTracer("serve", "1.0.0");
export { SpanKind };

// run fn inside a span; an exception marks it as an error and goes on
export function span(name, attributes, fn, kind = SpanKind.INTERNAL) {
  return tracer.startActiveSpan(name, { kind, attributes }, async (s) => {
    try { return await fn(s); }
    catch (e) { s.recordException(e); s.setStatus({ code: SpanStatusCode.ERROR, message: String(e.message || e) }); throw e; }
    finally { s.end(); }
  });
}
export const active = () => trace.getActiveSpan() || null;
export const traceId = () => active()?.spanContext().traceId || null;
// W3C trace context into outgoing headers, and out of incoming ones
export function inject(headers = {}) { propagation.inject(context.active(), headers); return headers; }
export const within = (headers, fn) => context.with(propagation.extract(context.active(), headers), fn);
// a fetch that carries the trace context (for the A2A client)
export const tracingFetch = (url, init = {}) => { const h = new Headers(init.headers || {}), c = inject({}); for (const [k, v] of Object.entries(c)) h.set(k, v); return fetch(url, { ...init, headers: h }); };

// ---- the conventions' attributes, in one place --------------------------------------------------------------------
// (following semantic-conventions-genai@51a0f58, semconv v1.44.0)
const VERSION = "1.0.0";
const ABOUT = {
  autopilot: "Plans the player's week against their goal: finds partners, agrees games with their agents, asks once before booking",
  talk: "Agrees one game with members' agents over A2A (the acceptable-set protocol)",
  match: "Asks the player whether they want a game at one of their usual times",
};
// an agent in this process (invoke_agent, INTERNAL). conversation: a real conversation id or nothing (the conventions
// say not to make one up from a trace id or a fresh UUID)
export const agentAttrs = (name, conversation = null) => ({ "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": name, "gen_ai.agent.id": `serve.${name.split(":")[0]}`, "gen_ai.agent.version": VERSION,
  ...(ABOUT[name] ? { "gen_ai.agent.description": ABOUT[name] } : {}), ...(conversation ? { "gen_ai.conversation.id": conversation } : {}) });
// one tool call of the Autopilot (execute_tool, INTERNAL)
export const toolAttrs = (name, description, conversation = null, callId = null) => ({ "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": name, "gen_ai.tool.type": "function", ...(description ? { "gen_ai.tool.description": description.slice(0, 200) } : {}),
  "gen_ai.agent.name": "autopilot", ...(conversation ? { "gen_ai.conversation.id": conversation } : {}), ...(callId ? { "gen_ai.tool.call.id": String(callId) } : {}) });
// error.type for a tool call that did not do what was asked (the conventions ask instrumentations to list theirs):
//   invalid_arguments  the model's arguments did not fit the tool's parameters
//   unknown_tool       the model named a tool there is not
//   stop_refused       the model stopped (approval, nudge, finish) while a game was still within reach
//   rule_refused       code refused a step that breaks a rule: a time or member not from the tools, a day outside the
//                      week, someone the player left out, a format the body log pauses
//   no_option          the tool found nothing to offer (nobody free then, no playable public court)
//   timeout            the tool ran out of time
//   tool_failed        the tool itself failed (an exception, a service that did not answer)
export function errorType(name, res = {}) {
  const e = String(res.error || "");
  if (/^the arguments do not fit/.test(e)) return "invalid_arguments";
  if (/^no tool called/.test(e)) return "unknown_tool";
  if (/^not yet:/.test(e)) return "stop_refused";
  if (/time(d)? ?out|aborted|no model slot came free/i.test(e)) return "timeout";
  if (res.threw) return "tool_failed";
  if (/^Nobody who plays|^No public place nearby/.test(e)) return "no_option";
  if (/not in the next seven days|not usually free|is paused while|needs (three members|one member)|is not a place find_places returned|left out this week|(is|are) not free|nothing agreed yet/.test(e)) return "rule_refused";
  return "tool_failed";
}
// error.type for a failed call: a timeout, else the exception's name
export const failureOf = (e) => (/abort|time(d)? ?out/i.test(String(e?.name) + String(e?.message)) ? "timeout" : e?.name && e.name !== "Error" ? e.name : "unreachable");
// Your agent's A2A request to a member's agent. A proposal is an agent invocation: "invoke_agent member:<id>" (CLIENT)
// with the A2A "SendMessage" span (CLIENT) under it; a hold or an estimate is the SendMessage alone. send() runs inside
// the SendMessage span, so the trace context it injects makes the member's side its child.
export function a2aCall({ member, url, messageId, contextId, kind = "proposal", round = null }, send) {
  const where = (() => { try { const u = new URL(url); return { "server.address": u.hostname, "server.port": +(u.port || (u.protocol === "https:" ? 443 : 80)) }; } catch { return {}; } })();
  const conv = contextId ? { "gen_ai.conversation.id": contextId } : {};
  const msg = () => span("SendMessage", { "a2a.method.name": "SendMessage", "a2a.message.id": messageId, "a2a.protocol.version": "1.0", ...conv, ...where, "serve.member": member, "serve.a2a.kind": kind, ...(round != null ? { "serve.a2a.round": round } : {}) }, async (s) => {
    try {
      const task = await send();
      s.setAttributes({ ...(task?.id ? { "a2a.task.id": task.id } : {}), ...(task?.status?.state ? { "a2a.task.state": task.status.state } : {}) });
      if (["TASK_STATE_FAILED", "TASK_STATE_REJECTED"].includes(task?.status?.state)) { s.setAttributes({ "error.type": task.status.state }); s.setStatus({ code: SpanStatusCode.ERROR, message: task.status.state }); }
      return task;
    } catch (e) { s.setAttributes({ "error.type": failureOf(e) }); throw e; }
  }, SpanKind.CLIENT);
  if (kind !== "proposal") return msg();
  return span(`invoke_agent member:${member}`, { "gen_ai.operation.name": "invoke_agent", "gen_ai.provider.name": "serve", "gen_ai.agent.name": `member:${member}`, "gen_ai.agent.id": url, ...conv, ...where, "serve.member": member, ...(round != null ? { "serve.a2a.round": round } : {}) }, async (s) => {
    try { const task = await msg(); if (["TASK_STATE_FAILED", "TASK_STATE_REJECTED"].includes(task?.status?.state)) s.setAttributes({ "error.type": task.status.state }); return task; }
    catch (e) { s.setAttributes({ "error.type": failureOf(e) }); throw e; }
  }, SpanKind.CLIENT);
}

// the spans of one trace (or the latest traces whose root has this name)
export function spans({ trace: id = null, root = null, n = 1 } = {}) {
  if (id) return recent.filter((r) => r.traceId === id);
  const roots = recent.filter((r) => !r.parentId && (!root || r.name === root)).slice(-n).map((r) => r.traceId);
  return recent.filter((r) => roots.includes(r.traceId));
}

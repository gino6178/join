import { useEffect, useState } from "react";
import { agentFetch } from "../agent.js";

// One OpenTelemetry trace from the gateway (/api/traces), drawn as a waterfall: every span in its place in the tree,
// its bar where it ran in time, and what it cost. The names follow the OpenTelemetry GenAI conventions: invoke_agent
// (an agent at work), chat (a model call, with its tokens), execute_tool (a tool call), SendMessage (an A2A message to
// a member's agent, whose side of the talk continues the same trace).
const KIND = (n) => (n.startsWith("invoke_agent member") ? "a2a" : n.startsWith("invoke_agent") ? "agent" : n.startsWith("chat ") ? "chat" : n.startsWith("execute_tool") ? "tool" : n.startsWith("SendMessage") ? "a2a" : n.startsWith("guard ") ? "guard" : "other");
// the cached tokens, by the conventions' name (and Serve's earlier one, for traces recorded before)
const cached = (a) => a["gen_ai.usage.cache_read.input_tokens"] ?? a["serve.usage.cached_tokens"] ?? 0;
const A2A = { hold: "hold the time", release: "let the time go", likely: "how likely a yes is" };
// a safety check (guard.js): which guard, on what, its verdict and what happened; the span never holds the text
const ON = { message: "your message", answer: "an answer", reviews: "court reviews", idea: "an idea for the club" };
const DID = { passed: "passed", refused: "not acted on", helpline: "helpline reply", replaced: "replaced", "left out": "left out", held: "held" };
const guardLabel = (a) => {
  const on = a["serve.guard.on"], n = a["serve.guard.count"], k = a["serve.guard.flagged"];
  const what = on === "reviews" && n != null ? `${n} court review${n > 1 ? "s" : ""}` : ON[on] || on;
  const v = a["serve.guard.verdict"], did = on === "reviews" && k ? `${k} left out` : DID[a["serve.guard.action"]] || a["serve.guard.action"] || "";
  return `Safety check · ${what} · ${v || "…"}${did && did !== "passed" ? `, ${did}` : ""}`;
};
const label = (s) => {
  const a = s.attributes || {};
  if (s.name.startsWith("guard ")) return guardLabel(a);
  if (s.name.startsWith("chat ")) return `${a["serve.site"] || "model"} · ${a["gen_ai.usage.input_tokens"] ?? "?"} in${cached(a) ? ` (${cached(a)} cached)` : ""}, ${a["gen_ai.usage.output_tokens"] ?? "?"} out`;
  if (s.name.startsWith("execute_tool")) return `${a["gen_ai.tool.name"]}${a["serve.refused"] ? " · refused" : ""}`;
  if (s.name.startsWith("SendMessage hold")) return `A2A to ${a["serve.member"]}'s agent · hold the time`;
  if (s.name.startsWith("SendMessage likely")) return `A2A to ${a["serve.member"]}'s agent · how likely a yes is`;
  if (s.name === "SendMessage" && A2A[a["serve.a2a.kind"]]) return `A2A SendMessage to ${a["serve.member"]}'s agent · ${A2A[a["serve.a2a.kind"]]}`;
  if (s.name === "SendMessage") return `A2A SendMessage${a["a2a.task.state"] ? ` · ${a["a2a.task.state"].replace("TASK_STATE_", "").toLowerCase()}` : ""}`;
  if (s.name.startsWith("SendMessage")) return `A2A to ${a["serve.member"]}'s agent${a["serve.a2a.round"] != null ? ` · round ${a["serve.a2a.round"]}` : ""}`;
  // your agent invoking a member's agent (CLIENT), and that agent at work on its side
  if (s.name.startsWith("invoke_agent member") && s.kind === 2) return `Asked ${a["serve.member"]}'s agent${a["serve.a2a.round"] != null ? ` · round ${a["serve.a2a.round"]}` : ""}`;
  if (s.name.startsWith("invoke_agent member")) return `${a["gen_ai.agent.name"]} · ${a["serve.decision"] || ""}${a["serve.overruled"] ? " (put right by code)" : ""}`;
  return s.name.replace("invoke_agent ", "");
};

export default function TraceView({ id }) {
  const [spans, setSpans] = useState(null), [why, setWhy] = useState(null), [err, setErr] = useState(null);
  useEffect(() => { if (!id) return; agentFetch(`/api/traces?trace=${id}`).then((r) => r.json()).then((j) => { setSpans(j.spans || []); setWhy(j.attribution || null); }).catch((e) => setErr(e.message)); }, [id]);
  if (err) return <p className="tiny muted">The trace could not be loaded ({err}).</p>;
  if (!spans) return <p className="tiny muted">Loading the trace…</p>;
  if (!spans.length) return <p className="tiny muted">This run's trace is no longer on the server.</p>;
  // the tree, depth first, children by start time
  const kids = {}, byId = Object.fromEntries(spans.map((s) => [s.spanId, s]));
  for (const s of spans) (kids[s.parentId && byId[s.parentId] ? s.parentId : "root"] ||= []).push(s);
  const rows = [], walk = (p, d) => (kids[p] || []).sort((a, b) => a.start - b.start).forEach((s) => { rows.push([s, d]); walk(s.spanId, d + 1); });
  walk("root", 0);
  const t0 = Math.min(...spans.map((s) => s.start)), t1 = Math.max(...spans.map((s) => s.start + s.ms)), total = Math.max(1, t1 - t0);
  const chats = spans.filter((s) => s.name.startsWith("chat ")), sum = (k) => chats.reduce((a, s) => a + (s.attributes?.[k] || 0), 0);
  const checks = spans.filter((s) => s.name.startsWith("guard ")), flagged = checks.filter((s) => s.attributes?.["serve.guard.verdict"] === "flagged").length;
  return (
    <div className="trace">
      <p className="tiny muted trace-sum">{spans.length} spans · {chats.length} model calls · {sum("gen_ai.usage.input_tokens")} tokens read ({chats.reduce((x, s) => x + cached(s.attributes || {}), 0)} from cache), {sum("gen_ai.usage.output_tokens")} written · {checks.length ? `${checks.length} safety check${checks.length > 1 ? "s" : ""}${flagged ? `, ${flagged} flagged` : ", nothing flagged"} · ` : ""}{(total / 1000).toFixed(1)} s · trace {id.slice(0, 8)}</p>
      {why && <p className="tiny trace-why">{why.line}</p>}
      <ol className="trace-rows" aria-label="Spans">
        {rows.map(([s, d]) => (
          <li key={s.spanId} className={`trace-row k-${KIND(s.name)}${s.status === "error" ? " error" : ""}${why && (s.spanId === why.spanId || s.spanId === why.cause) ? " ended" : ""}`} title={`${s.name} · ${(s.ms / 1000).toFixed(2)} s${s.error ? ` · ${s.error}` : ""}`}>
            <span className="trace-name" style={{ paddingLeft: `${d * 14}px` }}>{label(s)}</span>
            <span className="trace-lane"><i style={{ left: `${((s.start - t0) / total) * 100}%`, width: `${Math.max(0.4, (s.ms / total) * 100)}%` }} /></span>
            <span className="trace-ms tiny mono">{s.ms >= 1000 ? `${(s.ms / 1000).toFixed(1)} s` : `${Math.round(s.ms)} ms`}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

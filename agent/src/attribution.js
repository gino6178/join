// Failure attribution, by code, from a run's trace (the spans trace.js records): when an Autopilot run ends short of
// its goal (or the rules had to finish it), which step did it end on, and what kind of failure was it. One plain line
// for the trace view, and the same answer for the evals (test/autopilot_eval.mjs counts them against a hand check).
// The kinds:
//   tool_error         a tool failed to do its job (it threw, or a service behind it did not answer)
//   model_format       the model refused, wrote words instead of calling a tool, or gave arguments that do not fit
//   rule_caught        a step broke a rule and code caught it: the model's (a time, a member or a stop it may not
//                      take) or a member's agent's (a yes that broke its member's rule, put right by code)
//   timeout            a model call, an A2A call or the run's step budget ran out of time
//   agent_unreachable  a member's agent could not be reached, or did not answer
//   no_option          nothing was wrong, but nothing was left: the members' agents said no, no time in common, no
//                      court free, a hold taken by another talk
//   rule_missed        (with the eval's oracle) a game was agreed that breaks a rule code did not check
// The step is the first failure the run did not recover from: a failure followed by a game agreed was got past, so
// the search starts after the last game agreed. Within a talk that failed, the cause is looked for inside it (the
// member's agent that timed out, the hold refused). When no step failed after the last game, the run's stop is the
// step, and why it was allowed to stop says the kind. Who&When (Zhang et al., ICML 2025) and MAST (Cemri et al., 2025)
// grade this kind of attribution; this one only reads typed spans, so it is the same every time.
export const KINDS = { tool_error: "tool error", model_format: "model refusal or format", rule_caught: "rule break caught", timeout: "timeout", agent_unreachable: "agent unreachable", no_option: "no option left", rule_missed: "rule break missed" };

// why a talk ended without a game, from its result (a2a.js reasons are made by code, so their words are stable)
export function outcomeOf(r = {}) {
  const t = String(r.reason || "");
  if (r.silent?.length || /did not answer/.test(t)) return "no_answer";
  if (/could not put the proposal/.test(t)) return "protocol";
  if (/declined|can't play at any of the times/.test(t)) return "declined";
  if (/no court is free/.test(t)) return "no_court";
  if (/no free time in common|no time works for everyone|did not settle on a time/.test(t)) return "no_common_time";
  if (/can't hold|no longer free at any of the times|held by other talks/.test(t)) return "hold_refused";
  if (/changed while the talk was cut off|no longer free|cut off|its time has passed|talk stopped/.test(t)) return "stale";
  return "other";
}
const OUTCOME = { declined: "the members' agents said no", no_court: "no court was free when everyone was", no_common_time: "no time worked for everyone", hold_refused: "another talk held the time", stale: "the time was gone", protocol: "the proposal did not fit the protocol", other: "the talk ended without a game" };

const A = (s) => s.attributes || {};
const failed = (s) => s.status === "error" || A(s)["error.type"] != null;
const end = (s) => s.start + s.ms;
const who = (s) => String(A(s)["serve.member"] || A(s)["gen_ai.agent.name"] || "a member").replace(/^member:/, "");

// the cause inside one talk that ended without a game: a member's agent that timed out or could not be reached, a
// member's yes that broke its rule (put right by code), or else what the talk's result says
export function talkCause(spans, talk) {
  const kids = {}; for (const s of spans) (kids[s.parentId] ||= []).push(s);
  const under = []; const walk = (id) => (kids[id] || []).forEach((s) => { under.push(s); walk(s.spanId); }); walk(talk.spanId);
  under.sort((a, b) => a.start - b.start);
  const a2a = under.find((s) => (s.name === "SendMessage" || s.name.startsWith("invoke_agent member")) && A(s)["serve.a2a.kind"] !== "release" && failed(s));
  const outcome = A(talk)["serve.outcome"] || null;
  if (a2a) {
    const t = A(a2a)["error.type"];
    return { kind: t === "timeout" ? "timeout" : "agent_unreachable", span: a2a, what: `${who(a2a)}'s agent ${t === "timeout" ? "did not answer in time" : t === "TASK_STATE_FAILED" || t === "no_answer" ? "did not answer" : "could not be reached"}` };
  }
  const model = under.find((s) => s.name.startsWith("chat ") && failed(s));
  if (model) return { kind: A(model)["error.type"] === "timeout" ? "timeout" : "agent_unreachable", span: model, what: `a member's agent's model call ${A(model)["error.type"] === "timeout" ? "ran out of time" : "failed"}` };
  if (outcome === "no_answer") { const m = under.find((s) => s.name.startsWith("invoke_agent member") && A(s)["serve.decision"] === "none"); return { kind: "agent_unreachable", span: m || talk, what: `${m ? who(m) : "a member"}'s agent did not answer` }; }
  const over = under.find((s) => A(s)["serve.overruled"]);
  if (over && ["declined", "no_common_time"].includes(outcome)) return { kind: "rule_caught", span: over, what: `${who(over)}'s agent said yes to a time that breaks its member's rule, and code turned it into a no` };
  if (outcome === "protocol") return { kind: "tool_error", span: talk, what: OUTCOME.protocol };
  return { kind: "no_option", span: talk, what: OUTCOME[outcome] || OUTCOME.other, outcome };
}

const TOOL_KIND = { invalid_arguments: "model_format", unknown_tool: "model_format", stop_refused: "rule_caught", rule_refused: "rule_caught", timeout: "timeout", no_option: "no_option", tool_failed: "tool_error" };
const TOOL_WHAT = { invalid_arguments: "its arguments did not fit", unknown_tool: "the model named a tool there is not", stop_refused: "the model tried to stop while a game was still within reach", rule_refused: "code refused it", timeout: "it ran out of time", no_option: "it found nothing", tool_failed: "the tool failed" };

// One Autopilot run: spans of its trace. opts.badGames: games the eval's oracle rejected ("Thu 19:00"), for
// rule_missed. Returns null when the run met its goal by the model's own steps; else { kind, label, step, tool,
// spanId, what, line, recovered } (recovered: the rules finished the plan and met the goal).
export function attribute(spans = [], { badGames = [] } = {}) {
  const root = spans.find((s) => s.name === "invoke_agent autopilot" && !spans.some((p) => p.spanId === s.parentId && p.name === "invoke_agent autopilot"));
  if (!root) return null;
  const ra = A(root), short = (ra["serve.agreed"] ?? 0) < (ra["serve.needed"] ?? 0), rules = !!ra["serve.rules_took_over"];
  if (!short && !rules && !badGames.length && !failed(root)) return null;
  const steps = spans.filter((s) => s.parentId === root.spanId && (s.name.startsWith("execute_tool") || s.name.startsWith("chat "))).sort((a, b) => a.start - b.start);
  const tools = steps.filter((s) => s.name.startsWith("execute_tool"));
  const n = (s) => tools.indexOf(s) + 1; // the step number, as the trail counts tool calls
  const out = (kind, s, what, extra = {}) => {
    const tool = s ? A(s)["gen_ai.tool.name"] || (s.name.startsWith("chat ") ? "model turn" : s.name.replace(/^invoke_agent /, "")) : "run";
    const at = s && s.name.startsWith("execute_tool") ? `step ${n(s)} (${tool})` : s && s.name.startsWith("chat ") ? `a model turn` : tool === "run" ? "the run" : tool;
    const lead = !short && rules ? "Rules finished the plan" : badGames.length && !short ? "A game broke a rule" : "Ended short";
    return { kind, label: KINDS[kind], step: s && s.name.startsWith("execute_tool") ? n(s) : null, tool, spanId: s?.spanId || null, what, recovered: !short && rules && !badGames.length,
      line: `${lead} at ${at}: ${what} (${KINDS[kind]}).`, ...extra };
  };
  // an oracle failure: the agreed game that breaks the rule
  if (badGames.length) {
    const g = tools.find((s) => A(s)["gen_ai.tool.name"] === "negotiate" && A(s)["serve.agreed"] && badGames.some((b) => String(A(s)["serve.when"] || "").startsWith(b)));
    if (g) return out("rule_missed", g, `a game was agreed that breaks a rule code does not check (${A(g)["serve.when"]})`);
  }
  if (failed(root) && !tools.length) return out(/timeout/.test(String(A(root)["error.type"])) ? "timeout" : "tool_error", root, `the run stopped: ${root.error || "an error"}`);
  // when the rules finished the run, what is looked at is the model's part of it (before the rules' first step)
  const cut = rules ? tools.find((s) => A(s)["serve.decided_by"] === "rules")?.start ?? Infinity : Infinity;
  const mine = steps.filter((s) => s.start < cut);
  const lastWin = mine.filter((s) => A(s)["gen_ai.tool.name"] === "negotiate" && A(s)["serve.agreed"]).at(-1);
  const after = mine.filter((s) => !lastWin || s.start >= end(lastWin));
  // got past: a model turn that failed and a later one that called tools; a tool call that failed and a later call of
  // the same tool that did not; a stop refused, after which the run went on
  const later = (s) => after.filter((x) => x.start > s.start);
  const gotPast = (s) => s.name.startsWith("chat ") ? later(s).some((x) => x.name.startsWith("chat ") && A(x)["serve.tool_calls"] > 0)
    : A(s)["error.type"] === "stop_refused" ? later(s).some((x) => x.name.startsWith("execute_tool"))
    : later(s).some((x) => A(x)["gen_ai.tool.name"] === A(s)["gen_ai.tool.name"] && !failed(x) && !(A(x)["gen_ai.tool.name"] === "negotiate" && A(x)["serve.agreed"] === false));
  // the failures not got past, in order; the first fault wins over a dead end before it (a talk the members declined is
  // not what stopped a run whose model then stalled)
  const found = [];
  for (const s of after) {
    const a = A(s);
    if ((failed(s) || a["serve.tool_calls"] === 0) && gotPast(s)) continue;
    if (s.name.startsWith("chat ")) {
      if (failed(s)) found.push(out(a["error.type"] === "timeout" ? "timeout" : "agent_unreachable", s, a["error.type"] === "timeout" ? "Muse Glimmer did not answer in time" : "the model server did not answer"));
      else if (a["serve.tool_calls"] === 0) found.push(out("model_format", s, a["serve.refusal"] ? "the model refused instead of calling a tool" : a["serve.text_reply"] ? "the model wrote words instead of calling a tool" : "the model's reply was empty"));
      continue;
    }
    const name = a["gen_ai.tool.name"];
    if (failed(s)) { const t = a["error.type"] || "tool_failed"; found.push(out(TOOL_KIND[t] || "tool_error", s, `${name}: ${TOOL_WHAT[t] || "it failed"}`)); }
    else if (name === "negotiate" && a["serve.agreed"] === false) {
      const talk = spans.filter((x) => x.parentId === s.spanId && x.name === "invoke_agent talk")[0];
      // (a talk replayed from the journal has no spans of its own here: its reason says what ended it)
      const o = outcomeOf({ reason: a["serve.reason"] });
      const c = talk ? talkCause(spans, talk) : o === "no_answer" ? { kind: "agent_unreachable", what: "a member's agent did not answer" } : { kind: o === "protocol" ? "tool_error" : "no_option", what: OUTCOME[o] || OUTCOME.other };
      found.push(out(c.kind, s, `negotiate: ${c.what}`, { cause: c.span?.spanId || null }));
    }
  }
  // the model used every step it had: the run's budget ran out (the rules finished it)
  const lastChat = steps.filter((s) => s.name.startsWith("chat ")).at(-1);
  if (rules && ra["serve.steps_left"] === 0) found.push(out("timeout", lastChat || root, "the model used the run's whole step budget before the plan was done"));
  const fault = found.find((f) => f.kind !== "no_option") || found[0];
  if (fault) return fault;
  // no step failed after the last game: the run's stop is the step
  const stop = [...tools].reverse().find((s) => ["finish", "request_approval", "nudge"].includes(A(s)["gen_ai.tool.name"]));
  return out("no_option", stop || root, "no open time had anyone free who had not been asked");
}
// the line alone, for a trace's spans (the trace view; /api/traces)
export const line = (spans, opts) => attribute(spans, opts)?.line || null;

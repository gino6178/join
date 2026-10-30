// A stand-in for the model server (Ollama's /api/chat), for tests that check the gateway's own logic, not the model:
// it answers at once and the same way every time. A member's decision (a reply in the MEMBER_REPLY schema) is a yes,
// with every listed time in its "works"; any other reply is a plain sentence (which the gateway's checks may reject,
// and then its rules or templates speak, as they would for a real model). It counts what it was asked.
// An Autopilot turn (a request with tools) gets the next tool call from a fixed plan, read off the tool results so
// far (autopilotTurn): the open usual times in order, find_partners for each, negotiate with its candidates one at a
// time, request_approval once the week's games are agreed (or nudge when nothing was), then finish. So the same week
// gives the same calls, turn by turn, which is what the crash test compares a resumed run with.
import http from "node:http";

const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
// the tool calls so far with their results, in order
function history(messages) {
  const calls = [], out = [];
  for (const m of messages) {
    if (m.role === "assistant") for (const c of m.tool_calls || []) calls.push({ name: c.function?.name, args: typeof c.function?.arguments === "string" ? parse(c.function.arguments) || {} : c.function?.arguments || {} });
    else if (m.role === "tool") { const c = calls[out.length] || { name: m.tool_name, args: {} }; out.push({ ...c, name: m.tool_name || c.name, res: parse(m.content) || {} }); }
  }
  return out;
}
export function autopilotTurn(messages) {
  const h = history(messages), last = (n) => [...h].reverse().find((x) => x.name === n);
  const call = (name, args = {}) => [{ function: { name, arguments: { ...args, reason: args.reason || `the plan's next step: ${name}` } } }];
  if (h.some((x) => x.name === "request_approval" && x.res.sent) || h.some((x) => x.name === "nudge" && x.res.sent)) return call("finish", { summary: "Your week is lined up and waits for your yes." });
  const week = h.find((x) => x.name === "get_week")?.res;
  if (!week) return [...call("get_week"), ...call("check_body")];
  const wins = h.filter((x) => x.name === "negotiate" && x.res.agreed), used = new Set(wins.map((x) => x.args.day));
  const asked = (n) => h.filter((x) => x.name === n && !x.res.error).length;
  if ((week.stillNeeded || 0) - wins.length <= 0) return asked("request_approval") ? call("finish") : call("request_approval");
  const times = [...(week.habitualTimes || []).filter((t) => !t.alreadyTaken), ...(week.otherFreeTimes || [])];
  for (const t of times) {
    if (used.has(t.day)) continue;
    const fp = [...h].reverse().find((x) => x.name === "find_partners" && x.args.day === t.day && x.args.start === t.start);
    if (!fp || (fp.res.summary && !fp.res.candidates)) return call("find_partners", { day: t.day, start: t.start, format: "singles" });
    if (fp.res.error || !fp.res.candidates) continue;
    const tried = new Set(h.filter((x) => x.name === "negotiate" && x.args.day === t.day).flatMap((x) => x.args.members || []));
    const next = fp.res.candidates.slice(0, 2).find((c) => !tried.has(c.id));
    if (next) return call("negotiate", { members: [next.id], day: t.day, start: t.start, format: "singles" });
  }
  // nothing left to try: ask about what was agreed, or tell the player
  if (wins.length) return call("request_approval");
  return asked("nudge") ? call("finish") : call("nudge", { text: "Nothing fit this week." });
}

// (stallAfter: from that Autopilot turn on, it calls no tool, as a model that stalls; the rules then finish the run)
export async function fakeModel({ delayMs = 0, stallAfter = Infinity } = {}) {
  const asked = { decisions: 0, other: 0, turns: 0, decisionPrompts: [] };
  const srv = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", async () => {
      const send = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
      if (req.url.startsWith("/api/version")) return send({ version: "fake" });
      if (req.url.startsWith("/api/ps") || req.url.startsWith("/api/tags")) return send({ models: [{ name: "muse-glimmer:latest", model: "muse-glimmer:latest" }] });
      if (req.url.endsWith("/models")) return send({ data: [{ id: "muse-glimmer" }] });
      let j = {};
      try { j = JSON.parse(b || "{}"); } catch { /* empty */ }
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      const text = (j.messages || []).map((m) => m.content).join("\n");
      let content = "", tool_calls;
      if (j.tools?.length) { asked.turns++; tool_calls = asked.turns > stallAfter ? undefined : autopilotTurn(j.messages || []); }
      else if (j.format?.properties?.intent) {
        asked.decisions++; asked.decisionPrompts.push(text.slice(0, 200));
        content = JSON.stringify({ intent: "accept", date: "", start: "", works: [...new Set(text.match(/\bt\d{1,2}(?=:)/g) || [])] });
      } else { asked.other++; content = "Sounds good."; }
      send({ model: j.model, message: { role: "assistant", content, ...(tool_calls ? { tool_calls } : {}) }, done: true, done_reason: "stop", prompt_eval_count: Math.ceil(text.length / 4), prompt_eval_cached_count: 0, eval_count: Math.ceil((content.length + JSON.stringify(tool_calls || "").length) / 4), eval_duration: 1e6 });
    });
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${srv.address().port}/v1`, asked, close: () => srv.close() };
}

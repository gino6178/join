// Saves what every test agent actually did, step by step, from Claude Code's subagent transcripts: one JSON file per
// agent in docs/live-test/ops/ (each call, what it sent, what came back), with tokens, passes and local paths removed,
// and its screenshots as image files in a folder outside the repository (they can't be scrubbed).
//   node docs/live-test/extract-ops.mjs <subagents folder> [screenshots folder]
// Run again after each round: files are rewritten, nothing else is touched.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const [src, shots = "D:/paypal/video/agent-screens"] = process.argv.slice(2);
if (!src) { console.error("usage: node extract-ops.mjs <subagents folder> [screenshots folder]"); process.exit(1); }
const out = path.join(here, "ops");
fs.mkdirSync(out, { recursive: true });

// which round each agent belonged to, by when it ran and what it was asked (descriptions are the Agent tool's)
const SKIP = /review of (hackathon )?plan/i;
function roundOf(desc, at) {
  const m = desc.match(/^Round (\d+):/); if (m) return +m[1];
  const t = Date.parse(at);
  const d = (s) => Date.parse(`2026-${s}:00+08:00`);
  if (t < d("10-30T19:45")) return 0;          // the first agent tests, before the live server
  if (t < d("10-30T20:15")) return 1;
  if (t < d("10-30T21:00")) return 2;
  if (t < d("10-30T23:59")) return 3;
  if (t < d("10-31T02:20")) return 4;
  if (t < d("10-31T05:00")) return 5;
  return 6;
}

const scrub = (s) => String(s)
  .replace(/join_g_[A-Za-z0-9_-]+/g, "join_g_<pass>")
  .replace(/join_[A-Za-z0-9_-]{16,}/g, "join_<token>")
  .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1<token>")
  .replace(/("(?:token|pass|access_token|secret)"\s*:\s*")[^"]{8,}"/gi, '$1<hidden>"')
  .replace(/\/me\/[A-Za-z0-9_-]{8,}/g, "/me/<link>")
  .replace(/[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"']+[\\/]+AppData[\\/]+Local[\\/]+Temp[\\/]+claude[\\/]+[^\s"'`]*/gi, "<scratch>")
  .replace(/\/c\/Users\/[^/\s]+\/AppData\/Local\/Temp\/claude\/[^\s"'`]*/gi, "<scratch>")
  .replace(/[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"']+/gi, "~")
  .replace(/\/c\/Users\/[^/\s:"']+/gi, "~").replace(/AppData\/Local\/Temp\/claude\/[^\s"'`]*/g, "<scratch>")
  .replace(/[\w.+-]+@brockforge-robotics\.com/gi, "<email>");
const clip = (s, n) => (s.length > n ? s.slice(0, n) + ` …(+${s.length - n} chars)` : s);
const text = (c) => typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => b.type === "text" ? b.text : b.type === "image" ? "[screenshot]" : "").join("\n") : "";
// what a call did, in one line: the command, the page, the action
function what(name, input) {
  if (name === "Bash" || name === "PowerShell") return input.command;
  if (name === "Write") return `write ${input.file_path}\n${input.content}`;
  if (name === "Read") return `read ${input.file_path}`;
  if (name === "WebFetch") return `fetch ${input.url}`;
  if (/navigate/.test(name)) return `open ${input.url}`;
  if (/computer/.test(name)) return [input.action, input.text, input.coordinate && `at ${input.coordinate}`, input.action_summary].filter(Boolean).join(" ");
  if (/browser_batch/.test(name)) return input.actions.map((a) => `${a.name.split("__").pop()} ${what(a.name, a.input)}`).join("\n");
  return JSON.stringify(input);
}

const index = [];
for (const f of fs.readdirSync(src).filter((f) => f.endsWith(".meta.json"))) {
  const id = f.replace(".meta.json", ""), meta = JSON.parse(fs.readFileSync(path.join(src, f), "utf8"));
  const desc = meta.description || "";
  if (SKIP.test(desc)) continue;
  const lines = fs.readFileSync(path.join(src, id + ".jsonl"), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const first = lines.find((l) => l.type === "user");
  if (!first) continue;
  const brief = text(first.message.content), at = first.timestamp, round = roundOf(desc, at);
  const model = lines.find((l) => l.attachment?.type === "model")?.attachment.identity.marketingName || meta.model || null;
  const steps = [], pending = new Map(); let n = 0, shot = 0, final = "";
  for (const l of lines) {
    const c = l.message?.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (l.type === "assistant" && b.type === "text" && b.text.trim()) final = b.text;
      if (l.type === "assistant" && b.type === "tool_use") {
        const s = { n: ++n, at: l.timestamp, tool: b.name.split("__").pop(), did: clip(scrub(what(b.name, b.input || {})), 4000) };
        steps.push(s); pending.set(b.id, s);
      }
      if (l.type === "user" && b.type === "tool_result") {
        const s = pending.get(b.tool_use_id); if (!s) continue;
        s.got = clip(scrub(text(b.content)), 3000);
        if (b.is_error) s.error = true;
        for (const img of Array.isArray(b.content) ? b.content.filter((x) => x.type === "image" && x.source?.data) : []) {
          const dir = path.join(shots, `round${round}-${id.slice(6, 14)}`); fs.mkdirSync(dir, { recursive: true });
          const ext = /png/.test(img.source.media_type) ? "png" : "jpg", name = `${String(s.n).padStart(3, "0")}-${++shot}.${ext}`;
          fs.writeFileSync(path.join(dir, name), Buffer.from(img.source.data, "base64"));
          (s.screens ||= []).push(name);
        }
      }
    }
  }
  const rec = { id: id.slice(6), round, title: desc, model, startedAt: at, endedAt: lines.at(-1)?.timestamp, calls: steps.length,
    brief: clip(scrub(brief), 4000), steps, finalMessage: clip(scrub(final), 4000), ...(shot ? { screenshots: `${shots}/round${round}-${id.slice(6, 14)}` } : {}) };
  const file = `round${String(round).padStart(2, "0")}-${desc.replace(/^Round \d+:\s*/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)}-${id.slice(6, 12)}.json`;
  fs.writeFileSync(path.join(out, file), JSON.stringify(rec, null, 1));
  index.push({ file, round, title: desc, model, startedAt: at, calls: steps.length, screenshots: shot });
}
index.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
fs.writeFileSync(path.join(out, "index.json"), JSON.stringify({ about: "Every test agent's operations, one file each (from extract-ops.mjs). Round 0 is the agent tests before the live server.", agents: index.length, calls: index.reduce((t, x) => t + x.calls, 0), screenshots: index.reduce((t, x) => t + x.screenshots, 0), list: index }, null, 1));
console.log(`${index.length} agents, ${index.reduce((t, x) => t + x.calls, 0)} calls, ${index.reduce((t, x) => t + x.screenshots, 0)} screenshots`);

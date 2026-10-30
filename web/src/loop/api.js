// The community loop's API, as docs/community_loop_contract.md has it:
//   GET  /api/loop/ideas       clusters shown (5 or more members), with status and votes
//   POST /api/loop/vote        { proposal, votes } -> { ok, credits }
//   GET  /api/loop/proposals   specs, with gate results
//   POST /api/loop/decide      { proposal, decision: "approve" | "refuse", note } (maintainer) -> the spec
//   GET  /api/loop/flags       flags, with canary and history
//   POST /api/loop/rollback    { key, reason } (maintainer) -> the flag
//   GET  /api/loop/builds      (maintainer) the builder's work on approved C1-C3 proposals, by proposal
//   POST /api/loop/build       { proposal } (maintainer) -> the build, started
// Reads and votes go with the gateway's own token, like every other call (agent.js). Decisions and rollbacks carry the
// maintainer's token as Authorization: Bearer, typed into #/maintain and kept in that browser tab only: it is never
// part of the build.
import { AGENT_URL, agentFetch } from "../agent.js";
import * as mock from "./mock.js";

// THE SWITCH. "mock": the sample data in mock.js, until the loop's routes are on the gateway. "live": the gateway.
// Set VITE_LOOP_SOURCE=live (or mock) in web/.env.local, or change the default here once the routes land. To try the
// other one without a restart, add loop=live or loop=mock to the page's address (#/maintain?loop=live).
const DEFAULT_SOURCE = "mock";
export function source() {
  const q = new URLSearchParams(location.hash.split("?")[1] || "").get("loop");
  if (q === "live" || q === "mock") return q;
  const env = import.meta.env.VITE_LOOP_SOURCE;
  return env === "live" || env === "mock" ? env : DEFAULT_SOURCE;
}

// an error the pages can explain: offline (no answer), missing (no loop routes yet), auth (token refused), or the
// server's own message
export class LoopError extends Error {
  constructor(kind, message, status) { super(message); this.kind = kind; this.status = status; }
}
const asLoopError = (e) => (e instanceof LoopError ? e : new LoopError(e.status === 401 || e.status === 403 ? "auth" : "server", e.message, e.status));

async function send(path, { body, token } = {}) {
  const init = body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {};
  let r;
  try {
    // the maintainer's token replaces the gateway's: agentFetch would put the gateway's token over it
    r = token ? await fetch(AGENT_URL + path, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } }) : await agentFetch(path, init);
  } catch {
    throw new LoopError("offline", "Your server did not answer.");
  }
  const j = await r.json().catch(() => null);
  if (r.status === 404 && !j?.error) throw new LoopError("missing", "Your server does not have this part of Serve yet.", 404);
  if (r.status === 401 || r.status === 403) throw new LoopError("auth", j?.error || "The gateway refused the token.", r.status);
  if (!r.ok) throw new LoopError("server", j?.error || `The gateway answered ${r.status}.`, r.status);
  // a 200 that is not JSON (an HTML fallback page, a proxy's notice) is not the club's data: never show it as empty
  if (j == null) throw new LoopError("server", "Your server's answer was not the club's data.", r.status);
  return j;
}
const via = (live, fake) => async (...a) => {
  try { return source() === "live" ? await live(...a) : await fake(...a); } catch (e) { throw asLoopError(e); }
};

// ---------- normalising: the pages read one shape whatever the routes return around it ----------
const count = (x) => (Array.isArray(x) ? x.length : Number(x) || 0);
const list = (x) => (x == null ? [] : [].concat(x)).filter((v) => v != null && v !== "");
export const ms = (t) => (t == null ? null : t < 1e12 ? t * 1000 : t); // seconds or milliseconds
const simulatedOf = (res) => (res?.simulated ? { seed: res.simulated.seed ?? res.seed ?? null } : res?.seed != null ? { seed: res.seed } : null);

export function normIdea(c) {
  const texts = list(c.texts || c.samples || (Array.isArray(c.items) ? c.items.filter((i) => i && typeof i === "object").map((i) => i.text) : []));
  const votes = typeof c.votes === "object" && c.votes ? c.votes : { total: c.votes, mine: c.mine ?? c.myVotes };
  return {
    id: c.id, proposal: c.proposal ?? c.proposalId ?? null, target: c.proposal ?? c.proposalId ?? c.id,
    title: c.title || c.summary || c.text || texts[0] || `Idea ${c.id}`, texts,
    members: count(c.members), unmet: count(c.unmet), wishes: count(c.wishes), groups: list(c.groups),
    score: Number(c.score) || 0, status: c.status || "open", reasons: list(c.reasons ?? c.reason),
    votes: Number(votes.total) || 0, mine: Number(votes.mine) || 0, at: ms(c.at ?? c.shippedAt),
  };
}
export function normIdeas(res) {
  const ideas = (Array.isArray(res) ? res : res?.clusters || res?.ideas || []).map(normIdea).filter((c) => c.members >= 5);
  const of = Number(res?.of ?? res?.credits?.of) || 9;
  const spent = ideas.reduce((a, c) => a + c.mine * c.mine, 0);
  const credits = typeof res?.credits === "number" ? res.credits : res?.credits?.left != null ? Number(res.credits.left) : Math.max(0, of - spent);
  const notes = (res?.notes ? list(res.notes) : ideas.filter((c) => c.status === "shipped"))
    .map((n) => ({ id: n.proposal || n.id, title: n.title, members: count(n.members), at: ms(n.at), text: n.text || `Shipped, asked for by ${count(n.members)} members` }));
  return { ideas, credits, of, notes, simulated: source() === "mock" ? { seed: mock.SEED } : simulatedOf(res) };
}

// the gates, in the contract's order; unknown names keep their own label and come last
export const GATES = [
  ["policy", "Never-list policy", "test/policy.mjs on the diff"],
  ["scan", "Code scan", "secrets, shell, network, eval"],
  ["unit", "Unit tests", "npm test"],
  ["crash", "Crash matrix", "crash_matrix.mjs"],
  ["redteam", "Red team", "redteam.mjs"],
  ["e2e", "End to end", "e2e.mjs"],
  ["autopilot", "Autopilot eval", "pass^3 = 1.0, tokens +15% and p95 +20% at most"],
  ["oracle", "The spec's oracle", "the check the spec names"],
  ["privacy", "Privacy canary", "no body-log marker in any outbound request"],
];
const gateId = (g) => {
  const s = String(g ?? "").toLowerCase().replace(/^test\//, "").replace(/\.mjs$/, "");
  return /^(1|policy)/.test(s) ? "policy" : /scan|codeshield|^2$/.test(s) ? "scan" : /unit|npm|^3$/.test(s) ? "unit" : /crash|^4$/.test(s) ? "crash"
    : /red|^5$/.test(s) ? "redteam" : /e2e|^6$/.test(s) ? "e2e" : /autopilot|^7$/.test(s) ? "autopilot" : /oracle|^8$/.test(s) ? "oracle" : /privacy|canary|^9$/.test(s) ? "privacy" : s;
};
// what a gate found, in a line, from the gate runner's own details (gates.js); a shape not known here stays as it came
const n = (k, w) => `${k} ${w}${k === 1 ? "" : "s"}`;
function plainDetails(id, d) {
  if (d == null) return "";
  if (typeof d === "string") return d;
  const took = d.took != null ? ` · ${d.took} s` : "", err = d.errors?.[0] || d.error || d.skipped;
  if (err) return `${d.skipped ? "Not run" : "Could not run"}: ${String(err).slice(0, 200)}${took}`;
  if (id === "policy" && Array.isArray(d.refused)) return `${d.refused.length ? `Refused: ${d.refused.map((r) => r.why || r.rule).join("; ")}` : "Nothing in the diff is on the never-list"}${took}`;
  if (id === "scan" && Array.isArray(d.findings)) return `${d.findings.length ? n(d.findings.length, "finding") + ": " + d.findings.map((f) => f.rule || f.why || f).join(", ") : `${n(d.lines ?? 0, "added line")}, no findings`}${took}`;
  if (d.pass != null && d.fail != null) return `${d.pass} passed, ${d.fail} failed${d.files ? ` (${d.files.join(", ")})` : ""}${d.regressions?.length ? `; ${n(d.regressions.length, "regression")}` : ""}${took}`;
  if (id === "oracle" && d.file) return `${d.file}: ${d.code === 0 ? "passed" : `failed (exit ${d.code})`}${took}`;
  if (id === "privacy" && d.outsideRequests != null) return `${n(d.outsideRequests, "outside request")}, ${d.carriedTheMarker} carried the marker; the planted request was ${d.controlStopped ? "stopped" : "not stopped"}${took}`;
  return JSON.stringify(d);
}
function normGates(g) {
  if (!g) return null;
  const results = (Array.isArray(g) ? g : g.results || []).map((x) => {
    const id = gateId(x.gate ?? x.name), known = GATES.find(([k]) => k === id);
    return { id, label: known?.[1] ?? String(x.gate ?? x.name), what: known?.[2] ?? "", ok: x.ok === true ? true : x.ok === false ? false : null, details: plainDetails(id, x.details) };
  }).sort((a, b) => (GATES.findIndex(([k]) => k === a.id) + 1 || 99) - (GATES.findIndex(([k]) => k === b.id) + 1 || 99));
  const pass = typeof g.pass === "boolean" ? g.pass : results.length > 0 && results.every((x) => x.ok !== false) && results.some((x) => x.ok);
  return { pass, results };
}
export function normSpec(p) {
  return {
    ...p,
    problem: { text: "", members: 0, unmet: 0, wishes: 0, votes: 0, ...(p.problem || {}) },
    change: { class: "C?", files: [], summary: "", ...(p.change || {}) },
    oracle: p.oracle || null, privacy: p.privacy || "", ruleOfTwo: list(p.ruleOfTwo),
    status: p.status || "open", reasons: list(p.reasons), history: list(p.history).map((x) => ({ ...x, at: ms(x.at) })),
    gates: normGates(p.gates ?? p.gateResults), review: p.review || p.check || null,
  };
}
const normSpecs = (res) => (Array.isArray(res) ? res : res?.proposals || res?.specs || []).map(normSpec);

export function normFlag(key, f, hist = []) {
  return {
    key, type: f.type, range: f.range, default: f.default, value: f.value, beta: count(f.beta), canary: Number(f.canary) || 0,
    status: f.status || "off", since: ms(f.since), proposal: f.proposal || null,
    history: [...list(f.history), ...hist.filter((x) => x.key === key)].map((x) => ({ ...x, at: ms(x.at) })).sort((a, b) => (b.at || 0) - (a.at || 0)),
  };
}
function normFlags(res) {
  const hist = Array.isArray(res?.history) ? res.history : [];
  const src = res?.flags ?? res;
  if (Array.isArray(src)) return src.map((f) => normFlag(f.key, f, hist));
  return Object.entries(src || {}).filter(([, f]) => f && typeof f === "object" && !Array.isArray(f)).map(([k, f]) => normFlag(k, f, hist));
}

// ---------- the calls ----------
export const loop = {
  ideas: via(async () => normIdeas(await send("/api/loop/ideas")), async () => normIdeas(await mock.ideas())),
  vote: via((proposal, votes) => send("/api/loop/vote", { body: { proposal, votes } }), (proposal, votes) => mock.vote({ proposal, votes })),
  proposals: via(async () => normSpecs(await send("/api/loop/proposals")), async () => normSpecs(await mock.proposals())),
  decide: via(async (token, proposal, decision, note) => normSpec(await send("/api/loop/decide", { token, body: { proposal, decision, note } })),
    async (token, proposal, decision, note) => normSpec(await mock.decide({ proposal, decision, note }))),
  flags: via(async () => normFlags(await send("/api/loop/flags")), async () => normFlags(await mock.flags())),
  // the builder's work on approved C1-C3 proposals, and a build started (both with the maintainer's token)
  builds: via(async (token) => (await send("/api/loop/builds", { token })).builds || {}, async () => (await mock.builds()).builds || {}),
  build: via((token, proposal) => send("/api/loop/build", { token, body: { proposal } }), (token, proposal) => mock.build({ proposal })),
  rollback: via(async (token, key, reason) => {
    const f = await send("/api/loop/rollback", { token, body: { key, reason } });
    return normFlag(f.key ?? key, f.flag ?? (f[key] && typeof f[key] === "object" ? f[key] : f));
  },
    async (token, key, reason) => { const f = await mock.rollback({ key, reason }); return normFlag(key, f); }),
};

// ---------- the maintainer's token: typed in, kept in this tab (sessionStorage) and nowhere else ----------
const TOKEN = "serve.maintainer.token";
let memo = "";
export const maintainerToken = {
  get() { try { return sessionStorage.getItem(TOKEN) || memo; } catch { return memo; } },
  set(t) { memo = t; try { sessionStorage.setItem(TOKEN, t); } catch { /* storage blocked: this page view only */ } },
  clear() { memo = ""; try { sessionStorage.removeItem(TOKEN); } catch { /* nothing kept */ } },
};

// The failure attribution (attribution.js) against a hand check, on the Autopilot eval's own failures.
//   node test/attribution_check.mjs show    [rows.json traces.jsonl ...]   every run that missed its goal, broke its
//        oracle or was finished by the rules, as its steps from the trace (what each tool call did, what each talk's
//        members answered), and every talk that ended without a game, WITHOUT the code's answer: for labelling by hand
//   node test/attribution_check.mjs compare [rows.json traces.jsonl ...]   the code's answer for the same runs and
//        talks against the labels in test/attribution_hand.json ({ runs: { "<set>#<row>": { kind, step } },
//        talks: { "<talk id>": kind } }): how often the kind agrees, the step, both
// The eval's rows and its trace file pair up in order: one root "invoke_agent autopilot" span per row.
// Defaults: the held-out and the tuned weeks' files (test/autopilot_eval.mjs).
import fs from "node:fs";
import { attribute, talkCause, KINDS } from "../src/attribution.js";
import { population } from "../src/population.js";
const sim = Object.fromEntries(population(16, 2611).map((m) => [m.id, m.name.split(" ")[0]])); // the held-out weeks' simulated members

const [mode = "show", ...files] = process.argv.slice(2);
const pairs = files.length ? Array.from({ length: files.length / 2 }, (_, k) => [files[2 * k], files[2 * k + 1]]) : [["data/autopilot_eval_heldout.json", "data/eval-heldout-traces.jsonl"], ["data/autopilot_eval_tuned.json", "data/eval-traces.jsonl"]];
const HAND = "test/attribution_hand.json";
const A = (s) => s.attributes || {};
const cases = [], talks = [];
for (const [rf, tf] of pairs) {
  if (!fs.existsSync(rf) || !fs.existsSync(tf)) { console.error(`(${rf} or ${tf} missing: skipped)`); continue; }
  const set = /heldout/.test(rf) ? "heldout" : "tuned", rows = JSON.parse(fs.readFileSync(rf, "utf8"));
  const spans = fs.readFileSync(tf, "utf8").trim().split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const byTrace = {}; for (const s of spans) (byTrace[s.traceId] ||= []).push(s);
  const roots = spans.filter((s) => s.name === "invoke_agent autopilot" && !s.parentId);
  if (roots.length < rows.length) console.error(`${tf}: ${roots.length} runs for ${rows.length} rows`);
  // (the last rows.length roots: a file from an earlier eval in the same folder may come first)
  const mine = roots.slice(-rows.length);
  rows.forEach((row, k) => {
    const root = mine[k], sp = root ? byTrace[root.traceId] : [];
    if (root && (A(root)["serve.agreed"] !== row.agreed)) console.error(`${set}#${k}: the trace and the row do not match (${A(root)["serve.agreed"]} agreed, ${row.agreed})`);
    const missed = !row.success, rules = row.finishedBy === "rules";
    for (const t of sp.filter((x) => x.name === "invoke_agent talk" && A(x)["serve.agreed"] === false)) talks.push({ id: A(t)["gen_ai.conversation.id"], set, row: k, sp, talk: t });
    if (!missed && !rules) return;
    cases.push({ key: `${set}#${k}`, set, row, sp, root });
  });
}
const kids = (sp, id) => sp.filter((s) => s.parentId === id).sort((a, b) => a.start - b.start);
function stepsOf(c) {
  const out = [];
  let n = 0;
  for (const s of kids(c.sp, c.root.spanId)) {
    const a = A(s);
    if (s.name.startsWith("chat ")) { out.push(`     model turn: ${a["serve.tool_calls"] ?? "?"} tool call(s)${a["serve.text_reply"] ? ", wrote words" : ""}${a["serve.refusal"] ? ", a refusal" : ""}${a["serve.invalid_calls"] ? `, ${a["serve.invalid_calls"]} not fitting` : ""}${s.status === "error" ? `, ERROR ${a["error.type"] || s.error}` : ""}`); continue; }
    if (!s.name.startsWith("execute_tool")) continue;
    n++;
    let line = `  ${String(n).padStart(2)} ${a["gen_ai.tool.name"]} by ${a["serve.decided_by"]}`;
    if (a["serve.refused"]) line += ` — refused: ${a["serve.refused"]}`;
    if (a["gen_ai.tool.name"] === "negotiate" && a["serve.agreed"] != null) line += a["serve.agreed"] ? ` — agreed ${a["serve.when"] || ""}` : ` — no game: ${a["serve.reason"] || ""}`;
    out.push(line);
    for (const t of kids(c.sp, s.spanId).filter((x) => x.name === "invoke_agent talk")) out.push(...talkLines(c.sp, t, "       "));
  }
  return out;
}
function talkLines(sp, t, pad) {
  const out = [], walk = (id) => kids(sp, id).forEach((s) => { const a = A(s);
    if (s.name.startsWith("invoke_agent member") && s.kind !== 2) out.push(`${pad}${a["gen_ai.agent.name"]}: ${a["serve.decision"]} (${a["serve.tier"] || "?"}${a["serve.overruled"] ? ", put right by code" : ""})`);
    if ((s.name === "SendMessage" || s.name.startsWith("invoke_agent member")) && a["error.type"]) out.push(`${pad}${s.name} to ${a["serve.member"]}: ${a["error.type"]}`);
    if (s.name === "SendMessage" && ["hold", "release"].includes(a["serve.a2a.kind"])) out.push(`${pad}${a["serve.a2a.kind"]} ${a["serve.member"]}: ${a["a2a.task.state"] || a["error.type"] || ""}`);
    walk(s.spanId); });
  walk(t.spanId);
  return out;
}
if (mode === "show") {
  for (const c of cases) {
    const r = c.row;
    console.log(`\n${c.key} ${r.scenario}: needed ${r.needed}, agreed ${r.agreed}, finished by ${r.finishedBy}${r.oracle?.length ? `, oracle: ${r.oracle.join("; ")}` : ""}${r.games?.length ? ` · games: ${r.games.join("; ")}` : ""}`);
    console.log(stepsOf(c).join("\n"));
  }
  console.log(`\n${cases.length} runs to label · ${talks.length} talks without a game`);
  for (const t of talks) console.log(`\ntalk ${t.id} (${t.set}#${t.row}): ${A(t.talk)["serve.reason"]}\n${talkLines(t.sp, t.talk, "   ").join("\n")}`);
  process.exit(0);
}
// the games an oracle message rejects, from the row ("badminton singles Thu 19:00 with Leo"): a person who should not
// be there, a format or a sport that is not the week's; a partner missing from every game rejects none (then the first
// game agreed is the step: any of them could have had them)
const club = JSON.parse(fs.readFileSync("../web/public/data/club.json", "utf8"));
const nameOf = (id) => sim[id] || club.members.find((x) => x.id === id)?.name.split(" ")[0] || id;
function badOf(row) {
  const gs = (row.games || []).map((g) => { const m = /^(.+?) (singles|doubles) (\w{3}) (\d\d:\d\d) with (.*)$/.exec(g); return m && { sport: m[1], format: m[2], at: `${m[3]} ${m[4]}`, with: m[5] }; }).filter(Boolean);
  const out = new Set();
  for (const o of row.oracle || []) {
    let m;
    if ((m = /^(\S+) in a game/.exec(o))) gs.filter((g) => g.with.includes(nameOf(m[1]))).forEach((g) => out.add(g.at));
    else if (/singles game|not doubles/.test(o)) gs.filter((g) => g.format === "singles").forEach((g) => out.add(g.at));
    else if ((m = /^not (.+)$/.exec(o))) gs.filter((g) => g.sport !== m[1]).forEach((g) => out.add(g.at));
    else if (/not in any game/.test(o) && gs[0]) out.add(gs[0].at);
  }
  return [...out];
}
const hand = JSON.parse(fs.readFileSync(HAND, "utf8"));
const res = cases.map((c) => {
  const a = attribute(c.sp, { badGames: [] }), h = hand.runs?.[c.key];
  // (an oracle failure: the code is given the games the oracle rejected, as the eval gives them)
  const bad = c.row.oracle?.length ? attribute(c.sp, { badGames: badOf(c.row) }) : a;
  const got = c.row.oracle?.length ? bad : a;
  return { key: c.key, scenario: c.row.scenario, code: got && { kind: got.kind, step: got.step, line: got.line }, hand: h || null, kindOk: !!h && got?.kind === h.kind, stepOk: !!h && (got?.step ?? null) === (h.step ?? null) };
});
const tres = talks.map((t) => { const c = talkCause(t.sp, t.talk), h = hand.talks?.[t.id]; return { id: t.id, reason: A(t.talk)["serve.reason"], code: c.kind, hand: h ?? null, ok: h != null && h === c.kind }; });
const labelled = res.filter((r) => r.hand), tl = tres.filter((r) => r.hand != null);
const pct = (a, b) => (b ? `${a} of ${b} (${Math.round((100 * a) / b)}%)` : "none");
const summary = { at: new Date().toISOString(), runs: { labelled: labelled.length, kind: labelled.filter((r) => r.kindOk).length, step: labelled.filter((r) => r.stepOk).length, both: labelled.filter((r) => r.kindOk && r.stepOk).length },
  talks: { labelled: tl.length, kind: tl.filter((r) => r.ok).length }, byKind: Object.fromEntries(Object.keys(KINDS).map((k) => [k, { code: res.filter((r) => r.code?.kind === k).length, hand: labelled.filter((r) => r.hand.kind === k).length }])), runsDetail: res, talksDetail: tres };
for (const r of res) console.log(`${r.kindOk && r.stepOk ? "  same " : "  DIFF "} ${r.key} ${r.scenario.slice(0, 50)}: code ${r.code?.kind ?? "-"} @${r.code?.step ?? "-"} · hand ${r.hand?.kind ?? "-"} @${r.hand?.step ?? "-"}`);
for (const r of tres.filter((x) => !x.ok)) console.log(`  DIFF talk ${r.id}: code ${r.code} · hand ${r.hand}`);
console.log(`\nruns: kind ${pct(summary.runs.kind, summary.runs.labelled)}, step ${pct(summary.runs.step, summary.runs.labelled)}, both ${pct(summary.runs.both, summary.runs.labelled)} · talks: kind ${pct(summary.talks.kind, summary.talks.labelled)}`);
fs.writeFileSync("data/attribution_check.json", JSON.stringify(summary, null, 1));

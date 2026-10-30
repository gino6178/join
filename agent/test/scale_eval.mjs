// What changes as the club grows, from the 11 demo members to 1,000 simulated ones (population.js), measured on the
// GPU server with Muse Glimmer.
//   A. Two ways for an agent to see the club. "Whole club in the prompt": every member's public line (level, rating,
//      singles or doubles, sports, area, when they are free) goes to the model, which picks. "Found by code first" (how
//      Serve works): code keeps who is free then and plays that, ranks them (fit and trip), and the model reads the few
//      best. For each size: the prompt the first design needs (measured by the model server itself, a fresh prompt each
//      time so nothing comes from its cache, or "does not fit" past the model's context), how long the model takes to
//      read it, and how long code takes to find the members the second design shows (the Match helper's opening()).
//   B. The Autopilot itself, the same week planned with the demo club and with 300 simulated members more: what its
//      model calls read and wrote, every model call in its trace (the members' agents included), and how long it took.
//   node test/scale_eval.mjs [out.json]          SCALE_RUNS=2 (Autopilot runs per club size)
import fs from "node:fs";
import crypto from "node:crypto";

// (holds off, A2A_LEASE: this measures the agreement itself, and a time held in one talk would change the next)
// (and every answer from the model, A2A_ROUTE and A2A_STUDENT off: this measures what the model does)
for (const [k, v] of Object.entries({ A2A_ROUTE: "off", A2A_STUDENT: "off", A2A_LEASE: "off", A2A_FILE: "data/scale-a2a.json", AUTOPILOT_FILE: "data/scale-autopilot.json", NEGOTIATIONS_FILE: "data/scale-negotiations.json", TRACE_FILE: "data/scale-traces.jsonl",
  LEDGER_FILE: "data/scale-ledger.jsonl", ASK_FILE: "data/scale-asks.json", BOOKINGS_FILE: "data/scale-bookings.json" })) process.env[k] ||= v;
fs.rmSync(process.env.A2A_FILE, { force: true });
const { chat } = await import("../src/llm.js");
const ledger = await import("../src/ledger.js");
const { readClub } = await import("../src/club.js");
const { opening } = await import("../src/ask.js");
const { run } = await import("../src/autopilot.js");
const OUT = process.argv[2] || "data/scale_eval.json", RUNS = +(process.env.SCALE_RUNS || 2), CONTEXT = 16384;
const SIZES = [11, 51, 101, 201, 401, 1001];
const club0 = readClub(), history = []; // opening() reads the player's history from the club itself
const line = (m) => JSON.stringify({ id: m.id, name: m.name, level: m.level, rating: m.rating, plays: m.prefers, sports: m.sports, area: m.area?.name, free: m.free });
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const out = { at: new Date().toISOString(), model: process.env.LLM_MODEL || "muse-glimmer", context: CONTEXT, sizes: [], autopilot: [] };
const save = () => fs.writeFileSync(OUT, JSON.stringify(out, null, 1));

// A
let perMember = null, fixed = null;
for (const n of SIZES) {
  process.env.SIM_MEMBERS = String(n - 11);
  const club = readClub(), members = club.members;
  // found by code: the Match helper's opening for the next three days, timed (median of 15)
  const times = [];
  let o = null;
  for (let k = 0; k < 15; k++) { const t = process.hrtime.bigint(); o = opening({ history, now: new Date() }); times.push(Number(process.hrtime.bigint() - t) / 1e6); }
  const freeThen = o?.date ? members.filter((m) => m.free.some((f) => f.startsWith(o.day))).length : null;
  // the whole club in the prompt: measured while it fits, then estimated from the members per token measured so far
  const sys = `Request ${crypto.randomUUID()}. You are a player's agent in a sports club app. The club's members, one per line:\n${members.map(line).join("\n")}\nThe player is free ${club.you.free.join(", ")}.`;
  const ask = "Pick the best singles opponent for the player on Thursday at 19:00 for 90 minutes: free then, close in rating. Answer with the member's id only.";
  const estimate = perMember ? Math.round(fixed + perMember * n) : null;
  let row = { members: n, simulated: n - 11, codeMs: +median(times).toFixed(2), codeFound: o?.partners?.length || 0, freeThatDay: freeThen };
  if (estimate && estimate > CONTEXT - 200) row = { ...row, wholeClubTokens: estimate, wholeClub: "does not fit", estimated: true };
  else {
    const before = Date.now();
    await chat([{ role: "system", content: sys }, { role: "user", content: ask }], { maxTokens: 1, temperature: 0, think: false, site: "scale.whole_club" });
    const c = ledger.calls(5).filter((x) => x.site === "scale.whole_club" && x.at >= before).at(-1);
    // a prompt at the context's length was cut by the server: it did not fit
    row = { ...row, wholeClubTokens: c?.prompt ?? null, wholeClubCached: c?.cached ?? null, wholeClubSeconds: c?.seconds ?? null, wholeClub: c?.prompt >= CONTEXT - 64 ? "does not fit (cut by the server)" : "measured" };
    if (out.sizes.length && c?.prompt) { const a = out.sizes.find((x) => x.wholeClub === "measured"); if (a) { perMember = (c.prompt - a.wholeClubTokens) / (n - a.members); fixed = c.prompt - perMember * n; } }
  }
  out.sizes.push(row); save();
  console.log(JSON.stringify(row));
}
out.tokensPerMember = perMember && +perMember.toFixed(1);

// B
for (const n of [11, 301]) {
  process.env.SIM_MEMBERS = String(n - 11);
  for (let k = 0; k < RUNS; k++) {
    const t0 = Date.now(), msgs = [];
    let r = null, err = null;
    try { r = await run({ you: { weak: "rear forehand" }, goal: { perWeek: 2 }, onStep: (e) => e.type === "a2a" && msgs.push(e) }); } catch (e) { err = String(e.message || e); }
    const row = { members: n, run: k + 1, agreed: r?.agreed.length ?? 0, approval: !!r?.approval, seconds: +((Date.now() - t0) / 1000).toFixed(1), modelCalls: r?.report.modelCalls ?? null, toolCalls: r?.report.toolCalls ?? null,
      tokens: r?.report.tokens ?? null, traceTokens: r?.report.traceTokens ?? null, agentMessages: msgs.length, simulatedPartners: (r?.agreed || []).flatMap((g) => g.partners).filter((p) => /^s\d{3}$/.test(p.id)).length,
      games: (r?.agreed || []).map((g) => `${g.format} ${g.day} ${g.start} with ${g.partners.map((p) => p.name).join(", ")}`), error: err };
    out.autopilot.push(row); save();
    console.log(JSON.stringify(row));
  }
}
const by = (n) => out.autopilot.filter((x) => x.members === n && x.tokens), avg = (xs, f) => xs.length ? Math.round(xs.reduce((a, x) => a + f(x), 0) / xs.length) : null;
out.summary = Object.fromEntries([11, 301].map((n) => [n, { runs: by(n).length, prompt: avg(by(n), (x) => x.tokens.prompt), fresh: avg(by(n), (x) => x.tokens.fresh), output: avg(by(n), (x) => x.tokens.output), tracePrompt: avg(by(n), (x) => x.traceTokens?.prompt || 0), seconds: avg(by(n), (x) => x.seconds), agreed: avg(by(n), (x) => x.agreed) }]));
save();
console.log("\n" + JSON.stringify(out.summary));

// The community loop's parts that other modules provide (docs/community_loop_contract.md): the safety review
// (loop/review.js), the flags (loop/flags.js), the gates (loop/gates.js) and the builder (loop/builder.js). Each is
// loaded if it is there; until it is, a stand-in with the same exports takes its place, and every stand-in fails
// closed: nothing it judges is allowed, shipped or built. `stubs` names the stand-ins in use, so a report can say so.
import * as guard from "../guard.js";

// the guards a shared item must pass (LOOP_GUARDS, a maintainer setting): one that is required and down, or not
// installed, blocks the item; one left out is recorded as waived
// (as loop/review.js reads it: empty means the default, "none" waives both)
export const requiredGuards = () => { const raw = String(process.env.LOOP_GUARDS ?? "").trim() || "llama-guard,prompt-guard"; return raw.toLowerCase() === "none" ? [] : raw.split(",").map((s) => s.trim()).filter(Boolean); };

const review = {
  async screen(items) {
    const need = requiredGuards(), out = [];
    for (const it of items) {
      const g = { safe: null, injected: null };
      if (need.includes("llama-guard")) { const r = await guard.screen([{ role: "user", content: it.text }], { site: "loop.screen" }); g.safe = r.safe; if (r.safe === false) g.categories = r.categories; if (r.safe == null) g.blocked = "Llama Guard is not running"; }
      else { g.safe = true; g.waived = "llama-guard"; }
      if (need.includes("prompt-guard")) { const [r] = await guard.injected([it.text], { site: "loop.screen" }); g.injected = r?.injected ?? null; if (g.injected == null) g.blocked ||= "Prompt Guard 2 is not installed or not running"; }
      else g.waived = g.waived ? `${g.waived},prompt-guard` : "prompt-guard not installed";
      out.push({ ...it, guard: g });
    }
    return out;
  },
  classify(change = {}) {
    const k = change.kind;
    return { class: k === "config" ? "C0" : k === "wording" ? "C1" : k === "parameter" ? "C2" : "C3", reasons: ["by the kind of change only (the safety review, loop/review.js, is not on this branch yet)"] };
  },
  check() { return { allowed: false, needs: "maintainer", reasons: ["the safety review (loop/review.js) is not on this branch yet, so everything waits for the maintainer"], gates: [] }; },
};
const flags = {
  get() { return undefined; }, // the caller's own default
  set() { throw new Error("flags (loop/flags.js) are not on this branch yet"); },
  ship() { throw new Error("flags (loop/flags.js) are not on this branch yet"); },
  rollback() { throw new Error("flags (loop/flags.js) are not on this branch yet"); },
  beta() { throw new Error("flags (loop/flags.js) are not on this branch yet"); },
  list() { return {}; },
  monitor() { return []; },
  history() { return []; },
};
const gates = { async runGates() { return { pass: false, results: [{ gate: "gates", ok: false, details: "the gate runner (loop/gates.js) is not on this branch yet" }] }; } };
const builder = { async build() { return { ok: false, branch: null, worktree: null, diff: "", attempts: 0, log: ["the builder (loop/builder.js) is not on this branch yet"] }; } };
const STUBS = { review, flags, gates, builder };

let loaded = null;
async function one(name) {
  try { return { mod: await import(`./${name}.js`), stub: false }; }
  catch (e) {
    // only the module itself missing means "not here yet"; anything else wrong inside it is an error to see
    if (e.code === "ERR_MODULE_NOT_FOUND" && new RegExp(`[\\\\/]loop[\\\\/]${name}\\.js'`).test(String(e.message))) return { mod: STUBS[name], stub: true };
    throw e;
  }
}
export async function load() {
  if (loaded) return loaded;
  const out = { stubs: [] };
  for (const name of Object.keys(STUBS)) { const r = await one(name); out[name] = r.mod; if (r.stub) out.stubs.push(name); }
  return (loaded = out);
}
export const stub = STUBS;

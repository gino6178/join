// The community loop's safety review. What the club shares is screened before anyone clusters it; every proposed change
// is classed by what it does, not by what it claims; a spec, and later its diff, is checked against the never-list
// (docs/never.md, enforced by test/policy.mjs) before it may ship.
//   screen(items)       Prompt Guard 2 and Llama Guard 3 on each shared item, and code's own checks of the paraphrase.
//                       It fails closed: a required guard (LOOP_GUARDS, a maintainer setting, default
//                       "llama-guard,prompt-guard") that is down or not installed blocks the item. (In chat a guard that
//                       is down is skipped; here nothing is waiting on an answer, so nothing gets through unchecked.)
//   classify(change)    C0: a key declared in flags.schema.json (or a schema passed in), set inside its range.
//                       C1: prompt or playbook wording. C2: a new tool parameter. C3: anything else, new code included.
//                       A claim lower than what the change shows is a reason, and the higher class holds.
//   check(spec, diff?)  { allowed, needs: "none" | "maintainer" | "never", reasons, gates, class }
//   support(spec, ctx)  the cluster's support worked out again from the items and the votes: distinct members, both
//                       groups, each member's quadratic budget, so near-duplicates and repeated votes count once.
//   RULE_OF_TWO         each stage of the loop, and which of untrusted input, private data and the power to change
//                       things it holds (never all three).
// Code decides here. The only models this file calls are the two guards, and only from screen().
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "../schema.js";
import { policy, parseDiff, lex, neverPath, hostAllowed, NON_ENGLISH } from "../../test/policy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_FILE = () => process.env.LOOP_FLAGS_SCHEMA || path.join(HERE, "flags.schema.json");
const CLUB_DATA = () => process.env.LOOP_CLUB_DATA || path.resolve(HERE, "../../../web/public/data");
export const MIN_MEMBERS = 5, CREDITS = 9;
const RANK = { C0: 0, C1: 1, C2: 2, C3: 3 }, CLASS = ["C0", "C1", "C2", "C3"];

// ---- the Agents Rule of Two, stage by stage ----
// untrusted: the stage reads text a club member wrote (or a model wrote from it); private: it can read a player's own
// data; power: it can change the system or act outside it. No stage holds all three; the builder never reads community
// text, and a person stands between the summaries and the builder.
export const RULE_OF_TWO = [
  { stage: "record", where: "loop/signals.js record", untrusted: true, private: true, power: false, how: "keeps a player's unmet request in their own record; counts only in loop data" },
  { stage: "paraphrase", where: "loop/signals.js offerShare (Muse Glimmer)", untrusted: true, private: true, power: false, how: "writes a paraphrase the player sees; it can only offer it" },
  { stage: "share", where: "loop/signals.js share (the player's yes)", untrusted: true, private: false, power: false, how: "the paraphrase code accepted, with the player's yes; no names, places, numbers or links" },
  { stage: "screen", where: "loop/review.js screen", untrusted: true, private: false, power: false, how: "labels items; a required guard that is down blocks them" },
  { stage: "cluster", where: "loop/proposals.js cluster, vote, rank", untrusted: true, private: false, power: false, how: "code groups and counts; who is an HMAC" },
  { stage: "summarize", where: "loop/proposals.js draft (Muse Glimmer)", untrusted: true, private: false, power: false, how: "drafts a spec from cluster summaries; it can't change anything" },
  { stage: "review", where: "loop/review.js check, test/policy.mjs", untrusted: true, private: false, power: false, how: "code returns a verdict; it changes nothing" },
  { stage: "decide", where: "POST /api/loop/decide (a maintainer)", untrusted: true, private: false, power: true, how: "a person reads the spec and approves or refuses" },
  { stage: "build", where: "loop/builder.js (Muse Glimmer in a worktree)", untrusted: false, private: false, power: true, how: "reads the approved spec and the repository, never community text; no data/, .env or network; never merges" },
  { stage: "gates", where: "loop/gates.js", untrusted: true, private: false, power: false, how: "runs a model-written diff against tests with a canary, not player data; reports pass or fail" },
  { stage: "ship", where: "loop/flags.js ship (C0 only)", untrusted: true, private: false, power: true, how: "sets a declared key to a typed value inside its range, behind a flag, to a canary" },
  { stage: "monitor", where: "loop/flags.js monitor, rollback", untrusted: false, private: true, power: true, how: "reads code's own counts and records; its only power is turning a flag off" },
];

// ---- screen: the guards on each shared item ----
export const GUARDS = ["llama-guard", "prompt-guard"];
export function requiredGuards(setting = process.env.LOOP_GUARDS) {
  const raw = setting == null || !String(setting).trim() ? GUARDS.join(",") : String(setting);
  if (raw.trim().toLowerCase() === "none") return { want: new Set(), unknown: [] };
  const names = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return { want: new Set(names.filter((n) => GUARDS.includes(n))), unknown: names.filter((n) => !GUARDS.includes(n)) };
}

// what a shared paraphrase may not carry (the contract: 120 characters at most, no names, places, numbers, links or body
// or health terms), and what an item must not read as (an instruction to the system)
const INVISIBLE = /[­​-‏‪-‮⁠-⁤﻿]/;
const LINK = /\b(?:https?|wss?|ftp):\/\/|\bwww\.|\S+@\S+\.\S+|(^|\s)@\w{2,}|\b[a-z0-9-]+\s*(?:\.|\(dot\)|\[dot\]|\sdot\s)\s*(?:com|net|org|io|me|ly|tw|app|dev|co|info|link|xyz|site|gg|club|ai)\b|\b(bit\.ly|t\.me|wa\.me|tinyurl|qr code|scan (the|this) code|dm me|whatsapp|telegram|line id)\b/i;
const NUMBER_WORDS = /\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|sixty|hundred|thousand|o'clock|half past|quarter (past|to))\b/i;
const BODY = /\b(knees?|kneecaps?|ankles?|achilles|cal(f|ves)|shins?|foot|feet|heels?|toes?|hamstrings?|thighs?|quads?|hips?|groin|glutes?|lower back|upper back|back pain|lumbar|neck|shoulders?|rotator|elbows?|wrists?|forearms?|chest|abs|ribs?|injur\w*|pain\w*|sore\w*|aches?|aching|hurts?|hurting|sprain\w*|strain\w*|tendon\w*|tendin\w*|ligament\w*|physio\w*|doctors?|clinic|hospital|medic\w*|pills?|drugs?|heart( rate)?|pulse|bpm|blood|sleep\w*|daily steps|step count|calories|body weight|bmi|pregnan\w*|menstrua\w*|asthma|diabet\w*|surgery|rehab\w*|diagnos\w*|symptoms?|illness|sick|fever|covid|mental health|anxiety|depress\w*|therapy|health\w*|body logs?)\b/i;
const INSTRUCTION = /\b(ignore|disregard|override)\b[^.]{0,40}\b(rules?|instructions?|prompts?|polic(y|ies)|guards?|never-?list|filters?|safety)\b|\b(forget|ignore|disregard)\s+(all\s+|any\s+|the\s+|your\s+)?(previous|above|prior|earlier)\s+(instructions?|rules?|prompts?|messages?|text)\b|\b(system|developer)\s*(prompt|message|mode)\b|^\s*(system|assistant|developer)\s*:|<\|[a-z_]+\|>|\[\/?inst\]|\byou are now\b|\bjailbreak\w*\b|\b(export|dump|leak|upload|send|forward|email|exfiltrat\w*)\b[^.]{0,40}\b(all|every|everyone'?s|body|health|logs?|data|records?|messages|calendars?|database)\b|\b(skip|bypass|without)\b[^.]{0,30}\b(approval|review|maintainer|consent|confirmation|guards?|checks?)\b/i;
const CAPS_OK = new Set("monday tuesday wednesday thursday friday saturday sunday mon tue tues wed thu thur thurs fri sat sun january february march april may june july august september october november december i i'm i'd i'll i've ok".split(" "));
const GENERIC = new Set("sports sport centre center central gym hall school club court courts park community district badminton the of and at arena field ground grounds pitch".split(" "));
let roster = null;
function club() {
  if (roster) return roster;
  const people = new Set(), places = new Set();
  try {
    const c = JSON.parse(fs.readFileSync(path.join(CLUB_DATA(), "club.json"), "utf8"));
    // first names (a surname such as Park is also a word; written capitalized, the capitalized-word check finds it)
    for (const m of c.members || []) { const w = String(m.name || "").toLowerCase().match(/[\p{L}']{3,}/u)?.[0]; if (w) people.add(w); }
    for (const w of String(c.name || "").toLowerCase().match(/[\p{L}']{3,}/gu) || []) if (!GENERIC.has(w)) places.add(w);
  } catch { /* no roster: the capitalized-word check remains */ }
  try {
    const v = JSON.parse(fs.readFileSync(path.join(CLUB_DATA(), "venues.json"), "utf8"));
    for (const x of v.venues || []) for (const w of String(x.name || "").toLowerCase().match(/[\p{L}']{3,}/gu) || []) if (!GENERIC.has(w)) places.add(w);
  } catch { /* no venues */ }
  return (roster = { people, places });
}
// what is wrong with a shared item's text, in words a maintainer reads (the text itself is not repeated)
export function textProblems(text) {
  const t = String(text ?? ""), out = [];
  if (!t.trim()) return ["no text"];
  if (t.length > 120) out.push(`longer than 120 characters (${t.length})`);
  if (INVISIBLE.test(t)) out.push("hidden characters");
  if (NON_ENGLISH.test(t)) out.push("text that is not English");
  if (LINK.test(t)) out.push("a link, an address or a handle");
  if (/\d/.test(t) || NUMBER_WORDS.test(t)) out.push("a number");
  if (BODY.test(t)) out.push("a body or health term");
  const { people, places } = club(), words = t.toLowerCase().match(/[\p{L}']+/gu) || [];
  if (words.some((w) => people.has(w))) out.push("a club member's name");
  if (words.some((w) => places.has(w))) out.push("a place's name");
  // a capitalized word inside a sentence is a name or a place, unless it is a day, a month or "I"
  const caps = t.split(/(?<=[.!?])\s+/).flatMap((s) => s.trim().split(/\s+/).slice(1)).map((w) => w.replace(/^[^\p{L}]+|[^\p{L}']+$/gu, "")).filter((w) => /^\p{Lu}/u.test(w) && !CAPS_OK.has(w.toLowerCase()));
  if (caps.length) out.push("a capitalized word that may be a name or a place");
  if (INSTRUCTION.test(t)) out.push("it reads as an instruction to the system");
  return out;
}

async function pool(xs, n, fn) {
  const out = new Array(xs.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, async () => { while (next < xs.length) { const i = next++; out[i] = await fn(xs[i], i); } }));
  return out;
}
const KINDS = ["unmet", "wish"], GROUPS = ["weekday", "weekend"];
// items: shared items ({ id, who, text, kind, group, band }). Returns each with { guard, ok, reasons }: guard is the
// guards' verdict ({ safe, injected } and, for a guard LOOP_GUARDS leaves out, waived), ok whether it may be clustered.
// opts.guards overrides LOOP_GUARDS; opts.guard replaces guard.js (tests).
export async function screen(items = [], opts = {}) {
  const list = Array.isArray(items) ? items : [];
  const { want, unknown } = requiredGuards(opts.guards ?? process.env.LOOP_GUARDS);
  const g = opts.guard || (await import("../guard.js"));
  const texts = list.map((it) => (it && typeof it.text === "string" && it.text.trim() ? it.text.slice(0, 2000) : null));
  const idx = texts.map((t, i) => (t == null ? -1 : i)).filter((i) => i >= 0);
  // Prompt Guard 2: every text in one call
  let pg = new Map();
  if (want.has("prompt-guard") && idx.length) {
    let r; try { r = await g.injected(idx.map((i) => texts[i]), { site: "loop.screen" }); } catch (e) { r = idx.map(() => ({ injected: null, error: String(e?.message || e).slice(0, 120) })); }
    idx.forEach((i, k) => pg.set(i, r?.[k] || { injected: null, error: "no answer" }));
  }
  // Llama Guard 3: one conversation per item, two at a time (its server answers two at once)
  const lg = new Map();
  if (want.has("llama-guard") && idx.length) {
    const r = await pool(idx, 2, async (i) => { try { return await g.screen([{ role: "user", content: texts[i] }], { site: "loop.screen" }); } catch (e) { return { safe: null, categories: [], error: String(e?.message || e).slice(0, 120) }; } });
    idx.forEach((i, k) => lg.set(i, r[k]));
  }
  return list.map((it, i) => {
    const reasons = [], waived = [];
    if (!it || typeof it !== "object") return { item: it, guard: { safe: null, injected: null }, ok: false, reasons: ["not an item"] };
    if (texts[i] == null) reasons.push("no text");
    if (!it.id || typeof it.id !== "string") reasons.push("no id");
    if (!it.who || typeof it.who !== "string") reasons.push("no who");
    if (it.kind != null && !KINDS.includes(it.kind)) reasons.push(`kind ${String(it.kind).slice(0, 20)} is not unmet or wish`);
    if (it.group != null && !GROUPS.includes(it.group)) reasons.push(`group ${String(it.group).slice(0, 20)} is not weekday or weekend`);
    for (const u of unknown) reasons.push(`LOOP_GUARDS names a guard this review doesn't know (${u.slice(0, 30)}), so nothing passes`);
    if (texts[i] != null) for (const p of textProblems(it.text)) reasons.push(`the text has ${p}`.replace("has it reads", "reads"));
    const guard = { safe: null, injected: null };
    if (want.has("llama-guard")) {
      const v = lg.get(i);
      if (v) { guard.safe = v.safe ?? null; if (v.categories?.length) guard.categories = v.categories; }
      if (v && v.safe === false) reasons.push(`Llama Guard flags it (${(v.categories || []).join(", ") || "unsafe"})`);
      else if (texts[i] != null && v?.safe !== true) reasons.push(`llama-guard is required and did not answer (${v?.error || "off or down"}): the item waits`);
    } else waived.push("llama-guard not required (LOOP_GUARDS)");
    if (want.has("prompt-guard")) {
      const v = pg.get(i);
      if (v) { guard.injected = v.injected ?? null; if (v.score != null) guard.score = v.score; }
      if (v && v.injected === true) reasons.push(`Prompt Guard reads it as an injection (score ${v.score})`);
      else if (texts[i] != null && v?.injected !== false) reasons.push(`prompt-guard is required and did not answer (${v?.error || "off or not installed"}): the item waits`);
    } else waived.push("prompt-guard not required (LOOP_GUARDS)");
    if (waived.length) guard.waived = waived.join("; ");
    return { ...it, guard, ok: reasons.length === 0, reasons };
  });
}
export const passed = (screened) => (screened || []).filter((x) => x?.ok === true);

// ---- classify ----
// the declared flags (flags.schema.json): { key: { type, range, default } }, also read from { flags: {...} }
function normalizeSchema(j) {
  const src = j && typeof j === "object" ? (j.flags && typeof j.flags === "object" ? j.flags : j.keys && typeof j.keys === "object" ? j.keys : j) : {};
  const out = {};
  for (const [k, v] of Object.entries(src)) if (v && typeof v === "object" && typeof v.type === "string") out[k] = v;
  return out;
}
export function loadSchema(file = SCHEMA_FILE()) {
  try { return normalizeSchema(JSON.parse(fs.readFileSync(file, "utf8"))); } catch { return {}; }
}
function inRange(key, d, v) {
  const t = d.type.toLowerCase(), values = d.values || d.enum || d.options || (t === "enum" || t === "string" ? d.range : null);
  const [lo, hi] = Array.isArray(d.range) && d.range.length === 2 && typeof d.range[0] === "number" ? d.range : [d.min, d.max];
  if (["int", "integer"].includes(t) && !Number.isInteger(v)) return `${key} is an integer, and ${JSON.stringify(v)} is not`;
  if (["number", "float"].includes(t) && !(typeof v === "number" && Number.isFinite(v))) return `${key} is a number, and ${JSON.stringify(v)} is not`;
  if (["bool", "boolean"].includes(t)) return typeof v === "boolean" ? null : `${key} is true or false, and ${JSON.stringify(v)} is neither`;
  if (["int", "integer", "number", "float"].includes(t)) {
    if (typeof lo !== "number" || typeof hi !== "number") return `${key} declares no range`;
    return v < lo || v > hi ? `${JSON.stringify(v)} is outside ${key}'s range [${lo}, ${hi}]` : null;
  }
  if (["enum", "string"].includes(t)) {
    if (!Array.isArray(values)) return `${key} declares no values`;
    return values.includes(v) ? null : `${JSON.stringify(v).slice(0, 40)} is not one of ${key}'s values`;
  }
  return `${key} has a type this review doesn't know (${d.type})`;
}
function classifyFlag(change, schema) {
  const key = change?.key;
  if (typeof key !== "string" || !key) return { class: "C3", reasons: ["a C0 change names a declared flag key, and this names none"] };
  const d = Object.prototype.hasOwnProperty.call(schema, key) ? schema[key] : null;
  if (!d) return { class: "C3", reasons: [`${key.slice(0, 60)} is not declared in flags.schema.json, and only declared keys exist`] };
  if (!("value" in change)) return { class: "C3", reasons: [`no value for ${key}`] };
  const bad = inRange(key, d, change.value);
  if (bad) return { class: "C3", reasons: [`${bad}; widening a range is a maintainer's edit to flags.schema.json, outside the loop`] };
  return { class: "C0", reasons: [`${key} = ${JSON.stringify(change.value)}, inside its declared range`] };
}
// a string that reads as words (a prompt, a playbook rule, a label), not a key, a path, an address or a pattern
const isProse = (s) => (s.match(/\s+/g) || []).length >= 2 && !/:\/\/|^\.{0,2}\/|\.(m?js|json|jsonl|py|md)\b|\\[dwsbDWSB]|\$\{/.test(s) && /[a-z]{3}/i.test(s);
const PROP = /\b\w+\s*:\s*\{\s*type\s*:\s*"S"(?:\s*,\s*\w+\s*:\s*(?:"S"|\[[^\]]*\]|\{[^{}]*\}|-?\d+(?:\.\d+)?|true|false))*\s*\}\s*,?\s*/g;
const propNames = (code) => new Set([...code.matchAll(/\b(\w+)\s*:\s*\{\s*type\s*:/g)].map((m) => m[1]));
function classifyDiff(diff) {
  const files = parseDiff(diff), reasons = [];
  if (!files.length) return { class: "C3", reasons: ["a diff that can't be read is classed as new code"] };
  let top = 0;
  const raise = (c, why) => { if (RANK[c] > top) top = RANK[c]; if (why) reasons.push(why); };
  for (const f of files) {
    const p = f.path.toLowerCase();
    if (f.binary || f.symlink) { raise("C3", `${f.path}: a binary file or a link`); continue; }
    if (f.created || f.deleted || (f.old && f.new && f.old !== f.new)) { raise("C3", `${f.path}: a file added, deleted or moved`); continue; }
    if (/\.(md|txt)$/.test(p)) { raise("C1", `${f.path}: wording in a document`); continue; }
    if (!/\.(m?js|cjs|jsx)$/.test(p)) { raise("C3", `${f.path}: not a JavaScript file or a document`); continue; }
    const params = new Set(), pending = [];
    for (const h of f.hunks) {
      const o = {}, nw = {}, rows = h.lines.map((l) => ({ ...l, x: l.kind === "-" ? lex(l.text, o) : l.kind === "+" ? lex(l.text, nw) : (lex(l.text, o), lex(l.text, nw)) }));
      const inTool = rows.some((r) => /\b(parameters|properties)\s*:/.test(r.text)) || /TOOLS|tools/.test(h.context);
      // blocks of changed lines: what was removed, what took its place
      for (let i = 0; i < rows.length;) {
        if (rows[i].kind === " ") { i++; continue; }
        const rem = [], add = [];
        while (i < rows.length && rows[i].kind !== " ") (rows[i].kind === "-" ? rem : add).push(rows[i++]);
        const wording = rem.length === add.length && rem.every((r, k) => {
          const a = add[k]; if (r.x.skel.trim() !== a.x.skel.trim()) return false;
          return r.x.strings.every((s, j) => s === a.x.strings[j] || (isProse(s) && isProse(a.x.strings[j] || "")));
        });
        if (wording) { raise("C1"); continue; }
        const strip = (s) => s.replace(PROP, "").replace(/required\s*:\s*\[[^\]]*\]\s*,?/g, "").replace(/\s+/g, "");
        const tool = inTool && add.length && (rem.length === add.length
          ? rem.every((r, k) => strip(r.x.skel) === strip(add[k].x.skel) && propNames(add[k].x.code).size >= propNames(r.x.code).size)
          : !rem.length && add.every((a) => /^\s*\w+\s*:\s*\{\s*type\s*:/.test(a.x.skel) && !strip(a.x.skel).replace(/[,}\]]/g, "")));
        if (tool) {
          const before = new Set(rem.flatMap((r) => [...propNames(r.x.code)])), now = add.flatMap((a) => [...propNames(a.x.code)]).filter((n) => !before.has(n));
          now.forEach((n) => params.add(n)); raise("C2"); continue;
        }
        pending.push(add);
      }
    }
    // the code that reads a new parameter goes with it; any other change is new code
    for (const add of pending) {
      if (params.size && add.length && add.every((a) => [...params].some((n) => new RegExp(`\\b${n}\\b`).test(a.x.code)))) raise("C2");
      else raise("C3");
    }
    if (params.size) reasons.push(`${f.path}: a new tool parameter (${[...params].join(", ")})`);
    if (top === 3 && !reasons.some((r) => r.startsWith(f.path))) reasons.push(`${f.path}: changes code`);
  }
  if (top === 1 && !reasons.length) reasons.push("only the wording of strings changes");
  return { class: CLASS[top], reasons };
}
const CODE_WORDS = /\b(add|adds|create|creates|new|write|writes|implement|build|refactor|rewrite|wire)\b[^.]{0,40}\b(code|function|endpoint|route|tool|module|file|job|command|button|page|parameter|api|script|handler|integration)\b/i;
// change: a spec's change ({ class, key, value, files, summary }); opts.schema: the declared flags (else flags.schema.json);
// opts.diff (or change.diff): the diff, when there is one
export function classify(change = {}, { schema, diff } = {}) {
  const c = change && typeof change === "object" ? change : {}, reasons = [];
  const claimed = Object.prototype.hasOwnProperty.call(RANK, c.class) ? c.class : null;
  const d = diff ?? c.diff;
  let evidence;
  if (typeof d === "string" && d.trim()) { const r = classifyDiff(d); evidence = r.class; reasons.push(...r.reasons); if (claimed === "C0") reasons.push("a C0 change sets a flag and has no diff"); }
  else if (c.key != null || claimed === "C0") { const r = classifyFlag(c, schema ? normalizeSchema(schema) : loadSchema()); evidence = r.class; reasons.push(...r.reasons); }
  else if (claimed) { evidence = claimed; reasons.push(`no diff yet: ${claimed} as claimed, and the diff is classed again when it exists`); }
  else { evidence = "C3"; reasons.push("nothing shows the change is smaller than new code"); }
  if (evidence === "C0" && CODE_WORDS.test(String(c.summary || ""))) { evidence = "C3"; reasons.push("the summary describes new code, which a flag value can't be"); }
  if (claimed && RANK[claimed] < RANK[evidence]) reasons.unshift(`claims ${claimed}, but it is ${evidence}`);
  if (!claimed) reasons.push("no class claimed");
  return { class: claimed && RANK[claimed] > RANK[evidence] ? claimed : evidence, reasons, claimed, evidence };
}

// ---- support: the cluster's numbers worked out again ----
const words = (t) => new Set(String(t || "").toLowerCase().match(/[a-z']+/g) || []);
const jaccard = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return a.size + b.size - n ? n / (a.size + b.size - n) : 1; };
const guardPassed = (it) => {
  const g = it?.guard || {}, w = String(g.waived || "");
  return it?.ok !== false && (g.safe === true || (g.safe == null && /llama-guard/.test(w))) && (g.injected === false || (g.injected == null && /prompt-guard/.test(w)));
};
const monthOf = (at) => (Number.isFinite(+at) && +at > 0 ? new Date(+at).toISOString().slice(0, 7) : "?");
// ctx: { items (shared items, screened), cluster or clusters, votes: [{ who, proposal, votes, at }] }
export function support(spec, ctx = {}) {
  const reasons = [], hard = [];
  const cluster = ctx.cluster || (ctx.clusters || []).find((c) => c?.id === spec?.cluster) || null;
  if (!cluster || !Array.isArray(ctx.items)) return { ok: null, reasons: [!cluster ? "the cluster was not given, so its support is not verified" : "the items were not given, so the support is not verified"] };
  if (spec?.cluster && cluster.id && cluster.id !== spec.cluster) hard.push(`the spec names cluster ${spec.cluster}, not ${cluster.id}`);
  const byId = new Map(ctx.items.filter((x) => x && x.id).map((x) => [x.id, x]));
  const ids = Array.isArray(cluster.items) ? cluster.items : [];
  let missing = 0, failed = 0, dupes = 0;
  const per = new Map(); // who → [{ words, kind, group }]
  for (const id of ids) {
    const it = byId.get(id);
    if (!it) { missing++; continue; }
    if (!guardPassed(it) || textProblems(it.text).length || typeof it.who !== "string" || !it.who) { failed++; continue; }
    const w = words(it.text), mine = per.get(it.who) || [];
    if (mine.some((m) => jaccard(m.words, w) >= 0.6)) dupes++;
    mine.push({ words: w, kind: it.kind, group: it.group, norm: [...w].sort().join(" ") }); per.set(it.who, mine);
  }
  const members = per.size, all = [...per.values()].flat();
  const groups = [...new Set(all.map((x) => x.group).filter(Boolean))].sort();
  const unmet = [...per.values()].filter((xs) => xs.some((x) => x.kind === "unmet")).length, wishes = [...per.values()].filter((xs) => xs.some((x) => x.kind === "wish")).length;
  if (missing) reasons.push(`${missing} of the cluster's items are not shared items (withdrawn, forgotten, or never shared)`);
  if (failed) reasons.push(`${failed} items did not pass the screen and are not counted`);
  if (dupes) reasons.push(`${dupes} near-duplicate items from the same members count once`);
  if (members < MIN_MEMBERS) hard.push(`${members} distinct members, fewer than ${MIN_MEMBERS}`);
  for (const gname of GROUPS) if (!groups.includes(gname)) hard.push(`no support from the ${gname} group`);
  const claim = spec?.problem || {};
  if (+claim.members > members) hard.push(`claims ${claim.members} members; the items show ${members}`);
  if (+cluster.members > members) hard.push(`the cluster claims ${cluster.members} members; the items show ${members}`);
  if (+claim.unmet > unmet) hard.push(`claims ${claim.unmet} unmet requests; the items show ${unmet} members with one`);
  if (+claim.wishes > wishes) hard.push(`claims ${claim.wishes} wishes; the items show ${wishes} members with one`);
  // many members with the very same words: copies, not paraphrases of what each one said
  const same = new Map(); for (const [who, xs] of per) for (const n of new Set(xs.map((x) => x.norm))) same.set(n, (same.get(n) || new Set()).add(who));
  const most = Math.max(0, ...[...same.values()].map((s) => s.size));
  const copies = members >= MIN_MEMBERS && most >= Math.ceil(0.8 * members);
  if (copies) reasons.push(`${most} of ${members} members shared the same words: a maintainer looks before anything ships`);
  // votes: each member has CREDITS a month, and n votes on one proposal cost n²; a vote over the budget does not count
  let votes = null;
  if (Array.isArray(ctx.votes)) {
    const spent = new Map(), tally = new Map(); let over = 0;
    for (const v of [...ctx.votes].filter((v) => v && typeof v.who === "string" && Number.isInteger(v.votes) && v.votes > 0).sort((a, b) => (+a.at || 0) - (+b.at || 0))) {
      const m = `${v.who}|${monthOf(v.at)}`, mine = spent.get(m) || new Map(), now = (mine.get(v.proposal) || 0) + v.votes;
      const cost = [...mine.entries()].reduce((s, [p, n]) => s + (p === v.proposal ? 0 : n * n), 0) + now * now;
      if (cost > CREDITS) { over++; continue; }
      mine.set(v.proposal, now); spent.set(m, mine);
      if (v.proposal === spec?.id) tally.set(v.who, (tally.get(v.who) || 0) + v.votes);
    }
    votes = [...tally.values()].reduce((a, b) => a + b, 0);
    if (over) reasons.push(`${over} votes over a member's monthly budget of ${CREDITS} credits are not counted`);
    if (+claim.votes > votes) hard.push(`claims ${claim.votes} votes; the ledger shows ${votes} within each member's budget`);
  }
  return { ok: hard.length === 0, members, groups, unmet, wishes, votes, copies, reasons: [...hard, ...reasons], hard };
}

// ---- check ----
const SPEC = {
  type: "object", required: ["id", "change", "status"],
  properties: {
    id: { type: "string", pattern: "^P-[A-Za-z0-9-]{1,40}$" }, title: { type: "string", maxLength: 200 }, cluster: { type: "string", maxLength: 80 },
    problem: { type: "object", properties: { text: { type: "string", maxLength: 600 }, members: { type: "integer", minimum: 0 }, unmet: { type: "integer", minimum: 0 }, wishes: { type: "integer", minimum: 0 }, votes: { type: "integer", minimum: 0 } } },
    change: { type: "object", required: ["class"], properties: { class: { enum: CLASS }, key: { type: "string", maxLength: 80 }, files: { type: "array", maxItems: 50, items: { type: "string", maxLength: 200 } }, summary: { type: "string", maxLength: 1000 } } },
    oracle: { type: "object", properties: { kind: { enum: ["check", "unit", "eval"] }, how: { type: "string", maxLength: 600 } } },
    privacy: { type: "string", maxLength: 600 },
    ruleOfTwo: { type: "array", maxItems: 20, items: { type: "object", required: ["stage", "untrusted", "private", "power"], properties: { stage: { type: "string", maxLength: 40 }, untrusted: { type: "boolean" }, private: { type: "boolean" }, power: { type: "boolean" } } } },
    status: { enum: ["open", "review", "approved", "building", "gated", "shipped", "rolledBack", "refused"] },
    reasons: { type: "array" }, history: { type: "array", maxItems: 200, items: { type: "object", properties: { at: { type: "number" }, status: { type: "string", maxLength: 20 }, by: { enum: ["code", "maintainer", "rules"] } } } },
  },
};
// what a spec's own words may not ask for: the never-list (never), or what only a maintainer may do (maintainer)
const NEG = /\b(not|never|no|can'?t|cannot|won'?t|doesn'?t|don'?t|isn'?t|without any)\s+(a\s+|any\s+|give\s+(a\s+|any\s+)?|make\s+(a\s+)?|offer\s+(a\s+)?)?(medical\s+)?(diagnos\w*|dos(e|age|ing)\w*|prescri\w*)/gi;
const ASKS = [
  ["book-without-yes", "never", "asks to book without the player's yes", /\bauto-?book\w*|\bbook\w*\s+(it\s+|them\s+|games?\s+|courts?\s+)?(automatically|straight away|right away|directly|silently)|\bbook\w*[^.]{0,30}\bwithout (asking|a tap|the player'?s?\s+(yes|ok|tap|approval|confirmation)|(any |a )?confirmation)|\bskip\w*\s+(the\s+)?(player'?s?\s+)?(yes|tap|confirm\w*)\b/i],
  ["skip-review", "never", "asks to skip the review or the maintainer's approval", /\b(skip|bypass|avoid|no need for|without|don'?t need|disable|turn off|ignore)\b[^.]{0,30}\b(approval|approve|review|maintainer|gates?|polic(y|ies)|sign-?off|safety checks?)\b|\b(pre-?approved|already approved|auto-?approv\w*|approved in advance|ships? (it )?without)\b/i],
  ["injection", "never", "reads as an instruction to the system", INSTRUCTION],
  ["export", "never", "asks to send player data off the server", /\b(export|dump|leak|upload|send|post|forward|email|sync|copy|transfer|publish|share)\w*\b[^.]{0,50}\b(all|every|each|body|health|logs?|data|records?|calendars?|messages|histor(y|ies)|database|players'?|members'?)\b[^.]{0,50}\b(to|with|outside|external|third[- ]party|off the server|https?:|www\.)/i],
  ["prose-between-agents", "never", "asks to pass a model's prose between agents", /\b(send|pass|forward|include|let|show)\w*\b[^.]{0,30}\b(model'?s?|agent'?s?|glimmer'?s?|llm'?s?|free[- ]text|prose|own words|sentences?)\b[^.]{0,40}\b(to|between|with|read by)\b[^.]{0,25}\bagents?\b|\bagents?\b[^.]{0,20}\b(chat|talk) freely\b/i],
  ["medical", "never", "asks for a medical diagnosis or dosage", /\b(diagnos\w+|dosage|doses?|dosing|prescri\w+|medication|medicines?|ibuprofen|paracetamol|acetaminophen|naproxen|aspirin|painkillers?|anti-inflammator\w+|steroids?|supplement doses?)\b/i],
  ["forget", "never", "asks to weaken /forget", /\b(weaken|disable|remove|delay|limit|narrow|soft[- ]delete|undo|slow down|bypass|skip|change)\w*\s+(the\s+)?(\/forget|forget command|deletion|erasure)\b|(\/forget|\bforget command)\s+(should\s+|to\s+|must\s+|will\s+|could\s+)?(keep|retain|archive|skip|only delete|not delete|wait)\b/i],
  ["non-english-ui", "never", "asks for text in the app that is not English", /\b(translat\w+|locali[sz]\w+|i18n|multilingual|in (chinese|mandarin|cantonese|japanese|korean|spanish|french|german|thai|vietnamese|indonesian|malay|hindi|arabic))\b|\b(chinese|mandarin|japanese|korean|spanish|french|german)\s+(ui|text|labels?|version|buttons?|menus?|interface)\b/i],
  ["paper-names", "never", "asks for paper names or research claims in the app UI", /\b(cite|citations?|paper names?|paper titles?|arxiv|doi|research claims?|research section|our (lab|research))\b|\b(show|add|display|list)\b[^.]{0,30}\b(papers?|studies|citations?|references)\b/i],
  ["tracking", "never", "asks for analytics or tracking", /\b(google|web|usage|product|user|visitor|third[- ]party|marketing)\s+analytics\b|\btelemetry\b|\btracking (pixel|script|id|cookies?)\b|\btrack(ing)? (users|players|visitors|clicks|behaviou?r|where (players|users) go)\b|\bsession replay\b|\b(mixpanel|posthog|hotjar|sentry|segment\.io|amplitude sdk|fingerprint\w*)\b/i],
  ["dependency", "never", "asks for a new dependency", /\b(npm|pip|yarn|pnpm)\s+(i|install|add)\b|\b(add|install|use|pull in|bring in)\b[^.]{0,20}\b(a |the |new )?(dependency|dependencies|package|library|sdk|framework)\b|\bnew (dependency|package|library)\b/i],
  ["edit-tests", "never", "asks to change the tests, the policy or the guard", /\b(edit|change|delete|remove|disable|skip|relax|loosen|weaken|update|rewrite|turn off|lower|raise)\w*\b[^.]{0,30}\b(tests?|redteam|red-team|policy|never-?list|guards?|gates?|baselines?|thresholds?|safety checks?)\b/i],
  ["widen-range", "maintainer", "asks to widen a flag's range", /\b(widen|extend|raise|lower|change|remove|lift)\w*\b[^.]{0,20}\b(range|bounds?)\b|\bflags\.schema\b/i],
];
const HOST_IN_TEXT = /\b(?:https?|wss?|ftp):\/\/([^\s"'`\/?#)\]<>\\,;|]+)|\b((?:[a-z0-9-]+\.)+(?:com|net|org|io|ai|app|dev|co|me|ly|gg|xyz|info|biz|us|uk|de|ru|cn|tw|hk|jp|kr|sg|example))\b/gi;
function scanText(spec) {
  const fields = { title: spec.title, problem: spec.problem?.text, summary: spec.change?.summary, key: spec.change?.key, value: typeof spec.change?.value === "string" ? spec.change.value : null, oracle: spec.oracle?.how, privacy: spec.privacy };
  const hits = [];
  for (const [field, raw] of Object.entries(fields)) {
    if (typeof raw !== "string" || !raw) continue;
    for (const [rule, level, why, rx] of ASKS) {
      const t = rule === "medical" ? raw.replace(NEG, "") : raw;
      if (rx.test(t)) hits.push({ rule, level, why: `${field} ${why}` });
    }
    for (const m of raw.matchAll(HOST_IN_TEXT)) { const h = m[1] || m[2]; if (!hostAllowed(h)) hits.push({ rule: "outside-host", level: "never", why: `${field} names an outside address (${h.toLowerCase().slice(0, 60)})` }); }
    if (NON_ENGLISH.test(raw)) hits.push({ rule: "not-english", level: "maintainer", why: `${field} is not in English` });
  }
  return hits;
}
// a maintainer's approval on record: the last decision in the history is "approved", by a maintainer (only the
// /api/loop/decide route, with MAINTAINER_TOKEN, writes by: "maintainer"), and the spec has not been refused since
export function approvedByMaintainer(spec) {
  const h = Array.isArray(spec?.history) ? spec.history : [];
  const last = [...h].reverse().find((e) => e && ["approved", "refused", "open", "review", "rolledBack"].includes(e.status));
  return !!last && last.status === "approved" && last.by === "maintainer" && ["approved", "building", "gated", "shipped"].includes(spec?.status);
}
function ruleOfTwoOf(spec) {
  const rows = Array.isArray(spec?.ruleOfTwo) ? spec.ruleOfTwo : [], never = [], under = [];
  for (const r of rows) {
    if (r?.untrusted === true && r?.private === true && r?.power === true) never.push(`the stage ${String(r.stage).slice(0, 30)} holds untrusted input, private data and the power to change things at once`);
    const c = RULE_OF_TWO.find((x) => x.stage === r?.stage);
    if (c) for (const k of ["untrusted", "private", "power"]) if (c[k] && r[k] === false) under.push(`the spec says ${c.stage} holds no ${k === "power" ? "power to change things" : k === "private" ? "private data" : "untrusted input"}; it does`);
  }
  for (const c of RULE_OF_TWO) if (c.untrusted && c.private && c.power) never.push(`the review's own row for ${c.stage} holds all three`);
  return { never, under, rows: rows.length };
}

// spec: a proposal spec (docs/community_loop_contract.md). diff: the builder's diff (a string, or { diff }), when there
// is one. ctx: { schema (the declared flags; else flags.schema.json), items, cluster or clusters, votes } for support.
export function check(spec, diff = null, ctx = {}) {
  const gates = [], reasons = [];
  let never = false, maintainer = false, hard = false;
  const gate = (name, ok, details, { level = null } = {}) => {
    gates.push({ gate: name, ok, details });
    if (ok === true) return;
    if (level === "never") never = true;
    if (level === "maintainer" || level === "hard") maintainer = true;
    if (level === "hard") hard = true;
  };
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return { allowed: false, needs: "maintainer", reasons: ["not a spec"], gates: [{ gate: "shape", ok: false, details: "not a spec" }], class: "C3" };
  const d = typeof diff === "string" ? diff : typeof diff?.diff === "string" ? diff.diff : null;

  const shape = validate(SPEC, spec);
  gate("shape", !shape.length, shape.length ? shape.slice(0, 6).join("; ") : "fits the spec's form", { level: "hard" });
  if (shape.length) reasons.push(`the spec does not fit its form (${shape.slice(0, 3).join("; ")})`);

  const asks = scanText(spec);
  gate("text", !asks.length, asks.length ? asks.map((a) => a.why).join("; ") : "asks for nothing on the never-list", { level: asks.some((a) => a.level === "never") ? "never" : "maintainer" });
  for (const a of asks) reasons.push(a.why);

  const c = classify(spec.change || {}, { schema: ctx.schema, diff: d });
  const honest = !c.claimed || RANK[c.claimed] >= RANK[c.evidence];
  gate("class", c.class === "C0" && honest ? true : honest ? null : false, `${c.class}: ${c.reasons.join("; ")}`, { level: "maintainer" });
  if (!honest) reasons.push(c.reasons[0]);
  else if (c.class !== "C0") reasons.push(`${c.class} needs a maintainer`);
  if (c.claimed === "C0" && c.evidence !== "C0") reasons.push(...c.reasons.slice(1, 3));

  // the files a C1-C3 change says it will touch, before there is a diff (with a diff, the policy reads the files it
  // touches; a flag change touches none: its files are where the flag is read, and a range only a maintainer widens)
  if (c.class !== "C0" && d == null && spec.change?.key == null) {
    const files = Array.isArray(spec.change?.files) ? spec.change.files : [];
    const bad = files.map((f) => [f, neverPath(String(f).replace(/^\.?\//, ""))]).filter(([, why]) => why);
    gate("paths", !bad.length, bad.length ? bad.map(([f, why]) => `${f}: ${why}`).join("; ") : `${files.length} files, none on the never-list`, { level: "never" });
    for (const [f, why] of bad) reasons.push(`it would change ${String(f).slice(0, 80)}, on the never-list (${why})`);
  }

  if (d != null) {
    const v = policy(d);
    gate("policy", v.allowed, v.allowed ? `${v.files.length} files, ${v.added} lines added, ${v.removed} removed; nothing on the never-list` : v.refused.slice(0, 8).map((r) => `${r.file || ""}${r.line ? `:${r.line}` : ""} ${r.why}`).join("; "), { level: "never" });
    for (const r of v.refused.slice(0, 8)) reasons.push(`the diff ${r.why}${r.file ? ` (${r.file}${r.line ? `:${r.line}` : ""})` : ""}`);
  } else gate("policy", c.class === "C0" ? true : null, c.class === "C0" ? "a flag value has no diff" : "no diff yet: test/policy.mjs runs on the builder's diff");

  const s = support(spec, ctx);
  gate("support", s.ok === false ? false : s.ok === true && !s.copies ? true : null, s.reasons.join("; ") || `${s.members} members from ${s.groups.join(" and ")}${s.votes != null ? `, ${s.votes} votes` : ""}`, { level: s.ok === false ? "hard" : "maintainer" });
  if (s.ok === false) reasons.push(...s.hard);
  else if (s.ok == null && c.class === "C0") reasons.push(`${s.reasons[0]}: a maintainer looks instead`);
  else if (s.copies) reasons.push(s.reasons.find((r) => /same words/.test(r)));

  const r2 = ruleOfTwoOf(spec);
  gate("ruleOfTwo", !r2.never.length && !r2.under.length, [...r2.never, ...r2.under].join("; ") || (r2.rows ? "no stage holds all three" : "the spec carries no rows; the review's own hold"), { level: r2.never.length ? "never" : "maintainer" });
  reasons.push(...r2.never, ...r2.under);

  if (spec.status === "refused") { gate("status", false, "the spec was refused", { level: "hard" }); reasons.push("the spec was refused"); }

  const needs = never ? "never" : maintainer || c.class !== "C0" ? "maintainer" : "none";
  const approved = approvedByMaintainer(spec);
  if (needs === "maintainer") gate("approval", approved, approved ? "a maintainer approved it" : "waits for a maintainer");
  const allowed = needs !== "never" && !hard && (needs === "none" || approved);
  if (needs === "maintainer" && !approved && !hard) reasons.push("waits for a maintainer's approval");
  if (needs === "never") reasons.unshift("on the never-list: nobody approves this through the loop");
  return { allowed, needs, reasons: [...new Set(reasons.filter(Boolean))], gates, class: c.class };
}

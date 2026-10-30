// Flags: how a C0 change of the community loop ships, and how it comes back by itself.
//   A flag is a config value the code reads with get(key, player). Only keys declared in flags.schema.json (committed,
//   reviewed) exist, each with a type, a range and today's default; set() refuses anything else. While a flag is off,
//   every reader gets the default, so nothing changes.
//   ship(spec, { now }) takes a C0 proposal whose gates passed and gives its value to a canary: the members of the
//   flag's beta list whose HMAC bucket falls in the first 20%, for LOOP_CANARY_DAYS (7) days, one canary at a time.
//   monitor({ now }), run by part A's cycle, then rolls it back by itself on a breach, or promotes it to everyone when
//   the days pass clean:
//     hard: a game booked without the player's yes, a member booked into two games at once, the privacy canary's
//           marker in a request to an outside host, or the guard flagging more of what the models write. Off at once.
//     soft: thumbs down on the flag's feature up 10 points or more and beyond chance, or the unmet requests in the
//           proposal's cluster not falling. "Beyond chance" is anytime-valid evidence (loop/anytime.js): the canary
//           members' thumbs since the ship against their thumbs in the canary's length of days before it, 20 to 1
//           or more, which holds however often the monitor looks (every 5 minutes). LOOP_SOFT_TEST=z brings back the
//           fixed-sample z >= 1.645 against a window of the same length, for comparison only: checked at every look,
//           it rolled back 19% to 29% of changes that did nothing, not 5% (test/loop_canary_sim.mjs). Off (part A's
//           cycle opens the proposal again).
//   Every change and rollback goes into history.json, with who and why (code-made words only: no proposal text), and
//   the club hears it in a code-made note: "Shipped, asked for by 7 members: ..." or "Rolled back: ...".
// Each key keeps its version history for rollback; the version number only rises.
// Runtime state lives in agent/data/loop/ (LOOP_DIR, or each file by its own variable); a player is never stored by
// id, only by who = signals.whoOf(player).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { readJSON, writeJSON } from "../jsonfile.js";
import * as anytime from "./anytime.js";

export const CANARY = 0.2, CANARY_DAYS = 7, SOFT_POINTS = anytime.RISE, SOFT_Z = anytime.Z, SOFT_E = 1 / anytime.ALPHA, MIN_THUMBS = anytime.MIN_THUMBS, GUARD_MARGIN = 0.02, WATCH_AFTER_DAYS = 7;
export const STATUSES = ["off", "canary", "on", "rolledBack"];
const DAY = 864e5;

// ---- where things are ----------------------------------------------------------------------------------------
const dir = () => path.resolve(process.env.LOOP_DIR || "data/loop");
const at = (name, env) => () => path.resolve(process.env[env] || path.join(dir(), name));
export const files = {
  flags: at("flags.json", "LOOP_FLAGS_FILE"), history: at("history.json", "LOOP_HISTORY_FILE"), notes: at("notes.json", "LOOP_NOTES_FILE"),
  leaks: at("leaks.json", "LOOP_LEAKS_FILE"), marker: at("canary_marker.json", "LOOP_MARKER_FILE"), secret: at("secret", "LOOP_SECRET_FILE"),
  schema: () => path.resolve(process.env.LOOP_FLAGS_SCHEMA || fileURLToPath(new URL("./flags.schema.json", import.meta.url))),
};
// a file read again only when it changed on disk (a write is a rename: a new inode); get() runs on every ask
const cache = new Map();
function load(f, empty) {
  let st;
  try { st = fs.statSync(f); } catch { return structuredClone(empty); }
  const c = cache.get(f);
  if (c && c.m === st.mtimeMs && c.s === st.size && c.i === st.ino) return c.v;
  const v = readJSON(f, empty);
  cache.set(f, { m: st.mtimeMs, s: st.size, i: st.ino, v });
  return v;
}
const edit = (f, empty) => structuredClone(load(f, empty));
function keep(f, v) { writeJSON(f, v); cache.delete(f); }

// ---- the parts other people build, behind stubs until they land ------------------------------------------------
// signals.js (A): whoOf, counts, items; proposals.js (A): measure; review.js (B): classify. (A proposal's status is
// part A's to set, from what monitor() returns.) use() swaps any of them, and any of monitor()'s readers (tests).
const deps = { signals: null, proposals: null, review: null };
const stubs = {
  // no signals yet: nothing measured, so no soft breach can be found (hard breaches do not need signals)
  signals: { counts: async () => ({ thumbs: {}, unmet: {}, sites: {} }), items: () => [] },
  // no proposals yet: nothing measured
  proposals: { measure: async () => null },
  // no review yet: ship() checks the key, type and range against the schema itself
  review: null,
};
const tried = {};
async function dep(name) {
  if (deps[name]) return deps[name];
  if (!(name in tried)) tried[name] = import(`./${name}.js`).then((m) => m, () => null);
  return (await tried[name]) || stubs[name];
}
// the HMAC is needed synchronously in get(): part A's whoOf once its module has loaded, the same HMAC here until then
let signalsNow = null;
dep("signals").then((m) => { if (m !== stubs.signals && typeof m?.whoOf === "function") signalsNow = m; }).catch(() => {});
const secrets = new Map();
function secret() {
  const f = files.secret();
  if (secrets.has(f)) return secrets.get(f);
  if (!fs.existsSync(f)) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    try { fs.writeFileSync(f, crypto.randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" }); } catch (e) { if (e.code !== "EEXIST") throw e; }
  }
  const s = fs.readFileSync(f, "utf8").trim();
  secrets.set(f, s);
  return s;
}
const hmac = (text) => crypto.createHmac("sha256", secret()).update(String(text)).digest();
export const whoOf = (player) => (deps.signals || signalsNow)?.whoOf?.(player) ?? hmac(player).toString("hex");
export function use(over = {}) {
  if (over.reset) { for (const k of Object.keys(deps)) deps[k] = null; Object.assign(readers, defaults); listeners.length = 0; }
  for (const k of ["signals", "proposals", "review"]) if (k in over) deps[k] = over[k];
  if (over.readers) Object.assign(readers, over.readers);
}

// ---- declarations, values ------------------------------------------------------------------------------------
export const schema = () => load(files.schema(), {});
function declared(key) {
  const d = schema()[key];
  if (!d) throw new Error(`${key} is not a declared flag (agent/src/loop/flags.schema.json)`);
  return d;
}
// null when the value fits the declaration, else why not
export function check(key, value) {
  const d = schema()[key];
  if (!d) return `${key} is not a declared flag`;
  if (d.type === "int" && !Number.isInteger(value)) return `${key} takes a whole number`;
  if (d.type === "number" && !(typeof value === "number" && Number.isFinite(value))) return `${key} takes a number`;
  if (d.type === "bool" && typeof value !== "boolean") return `${key} takes true or false`;
  if (d.type === "enum" && !(d.values || []).includes(value)) return `${key} takes one of ${(d.values || []).join(", ")}`;
  if (!["int", "number", "bool", "enum"].includes(d.type)) return `${key} has an unknown type ${d.type}`;
  if (d.range && (value < d.range[0] || value > d.range[1])) return `${key} must be between ${d.range[0]} and ${d.range[1]}`;
  return null;
}
const state = () => load(files.flags(), {});
// a flag with everything, beta HMACs included (inside this module only)
function full(key) {
  const d = declared(key), f = state()[key] || {};
  return { ...f, key, ...d, value: f.value ?? d.default, beta: f.beta || [], canary: f.canary ?? CANARY, status: f.status || "off", since: f.since ?? null, proposal: f.proposal ?? null, version: f.version || 0 };
}
// the canary: a beta member whose bucket (an HMAC of the key and their who, so the same member is not always first)
// is under the canary share
export const bucket = (key, who) => hmac(`canary:${key}:${who}`).readUInt32BE(0) / 2 ** 32;
const canaryOf = (f) => f.beta.filter((w) => bucket(f.key, w) < f.canary);
// a flag as the API shows it: the beta list and the canary as counts, never the HMACs
export function flag(key) {
  const f = full(key);
  return { key, type: f.type, range: f.range, default: f.default, unit: f.unit ?? null, feature: f.feature ?? null, about: f.about, value: f.value, status: f.status, since: f.since,
    ...(f.until ? { until: f.until } : {}), proposal: f.proposal, canary: f.canary, beta: f.beta.length, inCanary: f.beta.length ? canaryOf(f).length : 0, version: f.version, ...(f.reason ? { reason: f.reason } : {}) };
}
export const list = () => Object.keys(schema()).map(flag);

// the value a reader uses: the canary value for a beta member in the canary, the shipped value when on, else the
// default. A value that no longer fits its declaration (a hand edit) reads as the default.
export function get(key, player = null) {
  const d = declared(key), f = state()[key];
  if (!f || !f.status || f.status === "off" || f.status === "rolledBack") return d.default;
  try {
    const on = f.status === "on" || (f.status === "canary" && player != null && (f.beta || []).includes(whoOf(player)) && bucket(key, whoOf(player)) < (f.canary ?? CANARY));
    if (on) return check(key, f.value) ? d.default : f.value;
  } catch { /* the secret could not be read: the default */ }
  return d.default;
}

// ---- history -------------------------------------------------------------------------------------------------
function log(entry) {
  keep(files.history(), [...edit(files.history(), []), entry].slice(-5000));
  return entry;
}
export const history = (key = null) => load(files.history(), []).filter((e) => key == null || e.key === key);
const brief = (key, f) => ({ status: f?.status || "off", value: f?.value ?? schema()[key].default });

// set a flag's value (validated) and status, with who and why
export function set(key, value, { by = "code", reason, status = "on", canary, proposal, until, extra, now = Date.now() } = {}) {
  const err = check(key, value);
  if (err) throw new Error(err);
  if (!STATUSES.includes(status)) throw new Error(`a flag is ${STATUSES.join(", ")}`);
  if (typeof reason !== "string" || !reason.trim()) throw new Error("a change needs a reason");
  if (typeof by !== "string" || !by.trim() || by.length > 40) throw new Error("a change needs who made it");
  const all = edit(files.flags(), {}), prev = all[key] || {};
  const next = { ...prev, value, status, since: now, by, version: (prev.version || 0) + 1, ...(canary != null ? { canary } : {}), ...(proposal !== undefined ? { proposal } : {}), ...(extra || {}) };
  if (status === "canary") next.until = until ?? now + canaryDays() * DAY; else delete next.until;
  delete next.reason;
  all[key] = next;
  keep(files.flags(), all);
  log({ at: now, key, action: status === "canary" ? "canary" : prev.status === "canary" && status === "on" ? "promote" : "set", by, reason: reason.slice(0, 300), from: brief(key, prev), to: brief(key, next), proposal: next.proposal ?? null, version: next.version });
  return flag(key);
}

// roll a flag back to its default, at once (evidence: what the monitor measured, kept in the history beside the
// reason: the test, the counts, z and E)
export async function rollback(key, reason, { by = "code", kind = "manual", now = Date.now(), evidence = null } = {}) {
  const d = declared(key), all = edit(files.flags(), {}), prev = all[key];
  if (!prev || !prev.status || prev.status === "off" || prev.status === "rolledBack") return { ...flag(key), already: true };
  if (typeof reason !== "string" || !reason.trim()) throw new Error("a rollback needs a reason");
  all[key] = { ...prev, status: "rolledBack", value: d.default, since: now, by, version: (prev.version || 0) + 1, reason: reason.slice(0, 300) };
  delete all[key].until;
  keep(files.flags(), all);
  log({ at: now, key, action: "rollback", kind, by, reason: reason.slice(0, 300), from: brief(key, prev), to: brief(key, all[key]), proposal: prev.proposal ?? null, version: all[key].version, ...(evidence ? { evidence } : {}) });
  await note({ kind: "rolledBack", key, proposal: prev.proposal ?? null, text: `Rolled back: ${d.about} is back to ${shown(d, d.default)} (${reason.replace(/\.$/, "")}).`, now });
  return flag(key);
}

// ---- the club's notes (code-made) ----------------------------------------------------------------------------
const listeners = [];
export const onNote = (fn) => { listeners.push(fn); };
export const notes = () => load(files.notes(), []);
async function note({ kind, key, proposal, text, now = Date.now() }) {
  const n = { at: now, kind, key, proposal, text };
  keep(files.notes(), [...edit(files.notes(), []), n].slice(-200));
  for (const fn of listeners) { try { await fn(n); } catch { /* a note that could not be posted stays in notes.json */ } }
  return n;
}
const shown = (d, v) => d.unit === "hour" ? `${String(v).padStart(2, "0")}:00` : d.unit === "m" ? `${(v / 1000).toFixed(1)} km` : d.unit ? `${v} ${d.unit}` : String(v);

// ---- beta members ----------------------------------------------------------------------------------------------
// who said yes to trying changes first (Messenger /beta on|off): their who, in every flag's beta list
export function beta(player, on = true) {
  const w = whoOf(player), all = edit(files.flags(), {});
  for (const key of Object.keys(schema())) {
    const f = (all[key] ||= {}), b = new Set(f.beta || []);
    if (on) b.add(w); else b.delete(w);
    f.beta = [...b];
  }
  keep(files.flags(), all);
  return on;
}
export const isBeta = (player) => { const w = whoOf(player); return Object.values(state()).some((f) => f.beta?.includes(w)); };
// /forget: the player leaves every beta list
export function forget(player) { beta(player, false); }

// ---- the privacy canary ----------------------------------------------------------------------------------------
// A marker planted in a test player's body log. Every request to a host outside this machine (and the model and guard
// it is set up with) is checked for it; one that carries it is not sent, and is kept in leaks.json for monitor().
export function marker() { return load(files.marker(), null); }
export function plantMarker(player) {
  let m = marker();
  if (!m) { m = { marker: `zq${crypto.randomBytes(9).toString("hex")}`, player: String(player), at: Date.now() }; keep(files.marker(), m); }
  watchOutbound();
  return { ...m, entry: { id: `canary-${m.marker.slice(2, 10)}`, at: new Date().toISOString(), part: "knee", side: "left", kind: "pain", level: 1, trigger: `after ${m.marker}`, note: m.marker } };
}
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^\[|\]$/g, ""); } catch { return null; } };
export function localHosts() {
  const own = [process.env.LLM_URL || "http://127.0.0.1:11435", process.env.GUARD_URL || "http://127.0.0.1:11436", process.env.A2A_BASE, ...(process.env.A2A_SELF || "").split(",")].filter(Boolean).map(hostOf);
  return new Set(["127.0.0.1", "localhost", "::1", ...own, ...(process.env.LOOP_LOCAL_HOSTS || "").split(",").map((s) => s.trim())].filter(Boolean));
}
const bodyText = (b) => {
  if (b == null) return "";
  if (typeof b === "string") return b;
  if (b instanceof URLSearchParams) return b.toString();
  if (b instanceof Uint8Array || b instanceof ArrayBuffer) return Buffer.from(b instanceof ArrayBuffer ? new Uint8Array(b) : b).toString("utf8");
  return "";
};
export const outbound = { seen: 0, outside: 0, blocked: 0, hosts: {} };
let realFetch = null, offline = false;
// offline: requests to outside hosts get an empty answer instead of going out (the privacy gate runs this way)
export function watchOutbound({ offline: off = false } = {}) {
  if (off) offline = true;
  if (realFetch) return;
  realFetch = globalThis.fetch;
  globalThis.fetch = async function watched(input, init = {}) {
    let host = null, hit = null, outside = false;
    try {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
      host = hostOf(url); outside = !!host && !localHosts().has(host);
      outbound.seen++;
      if (outside) {
        outbound.outside++; outbound.hosts[host] = (outbound.hosts[host] || 0) + 1;
        const m = marker()?.marker, raw = `${url}\n${JSON.stringify(init.headers || {})}\n${bodyText(init.body)}`;
        let text = raw; try { text += "\n" + decodeURIComponent(raw); } catch { /* as it is */ }
        // Messenger may carry the test player's own body log to the test player, and to no one else
        const own = /(^|\.)facebook\.com$/.test(host) && (() => { try { return JSON.parse(bodyText(init.body)).recipient?.id === marker()?.player; } catch { return false; } })();
        if (m && text.includes(m) && !own) hit = m;
      }
    } catch { /* the check never stops a request it could not read */ }
    if (hit) {
      outbound.blocked++;
      keep(files.leaks(), [...edit(files.leaks(), []), { at: Date.now(), host }].slice(-500));
      throw new Error(`blocked: the privacy canary's marker was in a request to ${host}`);
    }
    if (offline && outside) return new Response('{"elements":[]}', { status: 200, headers: { "content-type": "application/json" } });
    return realFetch(input, init);
  };
}
export const leaks = () => load(files.leaks(), []);
if (process.env.LOOP_WATCH !== "off" && fs.existsSync(files.marker())) watchOutbound();

// ---- what monitor() reads (each one replaceable in tests) ---------------------------------------------------------
const toMin = (s) => { const [h, m] = String(s).split(":").map(Number); return h * 60 + (m || 0); };
const defaults = {
  // the games booked, as play.js keeps them
  bookings: () => readJSON(path.resolve(process.env.BOOKINGS_FILE || "data/bookings.json"), { bookings: [] }).bookings || [],
  // the talks the player said yes to: a "Want a game?" booked after a yes (ask.js), an Autopilot plan answered all or
  // first (autopilot.js). A talk is known by its id; an ask's talk is neg-<ask id>.
  approvals: () => {
    const asks = readJSON(path.resolve(process.env.ASK_FILE || "data/asks.json"), { asks: {} }).asks || {};
    const plans = readJSON(path.resolve(process.env.AUTOPILOT_FILE || "data/autopilot.json"), { pending: {} }).pending || {};
    const yes = new Set(), asked = new Set(Object.keys(asks).map((id) => `neg-${id}`)), planned = new Set();
    for (const a of Object.values(asks)) if (a.status === "booked" && a.agreed?.talk) yes.add(a.agreed.talk);
    for (const p of Object.values(plans)) {
      for (const o of p.options || []) if (o.talk) planned.add(o.talk);
      if (p.status === "all" || p.status === "first") for (const o of (p.status === "first" ? (p.options || []).slice(0, 1) : p.options || [])) if (o.talk) yes.add(o.talk);
    }
    return { yes, asked, planned };
  },
  playing: async (member, date) => (await import("../play.js")).playing(member, date, null, { holds: false }),
  leaks: () => leaks(),
  guard: async ({ since, until }) => guardTally((await import("../ledger.js")).calls(100000), { since, until }),
};
// what the guard checked and flagged of what models wrote to players (the ledger's guard.out rows). A player's own words
// (guard.in), Prompt Guard on texts (guard.injection) and the loop's screen of shared ideas (loop.screen, where hostile
// items are flagged on purpose) are not what a model wrote, and do not count.
export function guardTally(rows, { since, until }) {
  let checked = 0, flagged = 0;
  for (const r of rows) {
    if (!r.guard || !/^guard\.out\b/.test(r.site || "") || r.at < since || r.at > until) continue;
    const m = /^(\d+)\/(\d+)$/.exec(r.guard);
    if (m) { flagged += +m[1]; checked += +m[2]; } else { checked++; if (r.guard !== "safe") flagged++; }
  }
  return { checked, flagged };
}
const readers = { ...defaults };

// thumbs (part A's signals.counts) and the cluster's unmet requests (part A's proposals.measure) for a list of members
// (whos: HMACs) in a window
async function measure({ feature, proposal, whos, since, until }) {
  const s = await dep("signals"), p = await dep("proposals");
  let c = null, m = null;
  try { c = await s?.counts?.({ since, until, whos }); } catch { c = null; }
  try { m = proposal && p?.measure ? await p.measure(proposal, { since, until, whos, items: (await s?.items?.()) || [] }) : null; } catch { m = null; }
  const t = c?.thumbs?.[feature] || {}, u = m?.unmet;
  return { up: +(t.up ?? t[1] ?? 0) || 0, down: +(t.down ?? t[-1] ?? 0) || 0, unmet: typeof u === "number" ? u : Array.isArray(u) ? u.length : null };
}
const share = anytime.share;
// the old rule's statistic: a one-sided two-proportion z, pooled (no thumbs before means no rise can be seen)
export const zRise = anytime.zRise;
const pct = (x) => `${Math.round(x * 100)}%`;
// LOOP_CANARY_DAYS (7): how long a canary runs before it is promoted
export const canaryDays = () => +(process.env.LOOP_CANARY_DAYS || CANARY_DAYS);

// ---- ship ----------------------------------------------------------------------------------------------------
// a C0 proposal whose gates passed: its value goes to the canary for canaryDays() days. One canary at a time: two on the
// same members (ask.hour and ask.ahead act on the same Match helper) would leave a breach that no flag can be blamed for.
export async function ship(spec, { now = Date.now(), gates = null, days = canaryDays() } = {}) {
  const no = (...reasons) => ({ ok: false, reasons });
  const c = spec?.change || {};
  if (c.class !== "C0") return no("only a C0 change ships by itself; anything else needs the maintainer");
  const err = check(c.key, c.value);
  if (err) return no(err);
  if (gates?.pass === false) return no("the gates failed");
  if (!(spec.status === "gated" || gates?.pass === true)) return no("the gates have not passed");
  const review = await dep("review");
  if (review?.classify) {
    const r = await review.classify(c);
    if (r?.class !== "C0") return no(`the review classes it ${r?.class ?? "unknown"}${r?.reasons?.length ? `: ${r.reasons.join("; ")}` : ""}`);
  }
  const f = full(c.key);
  if (f.status === "canary") return no(`${c.key} is already in a canary (${f.proposal})`);
  const other = Object.keys(schema()).map(full).find((x) => x.status === "canary");
  if (other) return no(`${other.key} is in a canary (${other.proposal}) until ${new Date(other.until).toISOString().slice(0, 10)}: one canary at a time`);
  if (f.status === "on" && f.value !== f.default) return no(`${c.key} already ships ${f.value}; roll it back first`);
  if (c.value === f.default) return no(`${c.value} is already the default`);
  const whos = canaryOf(f);
  if (!whos.length) return no(`no beta member falls in the ${pct(CANARY)} canary (${f.beta.length} beta member${f.beta.length === 1 ? "" : "s"})`);
  const until = now + days * DAY;
  // what the guard flagged in the window before (the ledger is in memory: kept in case the gateway restarts)
  const guard = await readers.guard({ since: now - days * DAY, until: now });
  set(c.key, c.value, { by: "code", reason: `canary for ${spec.id}`, status: "canary", canary: CANARY, proposal: spec.id ?? null, until, now, extra: { asked: spec.problem?.members ?? null, cluster: spec.cluster ?? null, watch: { guard } } });
  return { ok: true, key: c.key, value: c.value, canary: whos.length, beta: f.beta.length, until };
}

// ---- monitor -------------------------------------------------------------------------------------------------
async function hardBreach(f, now) {
  const since = f.since;
  const made = readers.bookings().filter((b) => !b.cancelled && b.created >= since && b.created <= now);
  if (made.length) {
    const { yes, asked, planned } = readers.approvals();
    // a game the Match helper or the Autopilot agreed is booked only after the player's yes; a game the player booked
    // from the Play page, or after a talk they started themselves, is theirs (the tap is the yes)
    const without = made.find((b) => { const t = b.option?.talk; return t && (asked.has(t) || planned.has(t)) && !yes.has(t); });
    if (without) return `a game was booked without the player's yes (booking ${without.id})`;
    for (const b of made) {
      const from = toMin(b.option?.start), to = from + (b.option?.minutes || 90);
      for (const p of b.option?.partners || []) {
        const games = await readers.playing(p.id, b.option.date);
        if (games.some((g) => !g.held && g.ref !== b.id && g.from < to && from < g.to)) return `a member was booked into two games at once (booking ${b.id})`;
      }
    }
  }
  const leak = readers.leaks().find((l) => l.at >= since && l.at <= now);
  if (leak) return `the privacy canary's marker was in a request to ${leak.host}`;
  // the guard: since the change against the window of the same length just before it (or, if the ledger in memory
  // does not reach back that far, against what it was when the canary started)
  const len = Math.max(now - since, 1);
  const g = await readers.guard({ since, until: now }), before = await readers.guard({ since: since - len, until: since }), base = before.checked ? before : f.watch?.guard;
  const rate = g.checked ? g.flagged / g.checked : 0, baseRate = base?.checked ? base.flagged / base.checked : 0;
  if (g.flagged && rate > baseRate + GUARD_MARGIN) return `the guard flagged ${pct(rate)} of what the models wrote (${pct(baseRate)} before)`;
  return null;
}
// The canary's members' thumbs since the ship against the same members' thumbs before it. (Only the canary got the
// value: measuring the whole beta list would dilute a real rise with members who never saw it.) The e-process (the
// default) compares with the canary's length of days before the ship, a window fixed when the canary starts, so its
// evidence grows only with the canary's own thumbs; the z-test (LOOP_SOFT_TEST=z) with a window of the same length as
// the canary so far. Returns null, or { reason, evidence }.
async function softBreach(f, now) {
  const len = Math.max(now - f.since, 1), whos = canaryOf(f), test = anytime.softTest();
  const span = test === "z" ? len : Math.max((f.until ?? f.since + canaryDays() * DAY) - f.since, 1);
  const m = await measure({ feature: f.feature, proposal: f.proposal, whos, since: f.since, until: now });
  const base = await measure({ feature: f.feature, proposal: f.proposal, whos, since: f.since - span, until: f.since });
  const r = anytime.softRise(m, base, { test });
  if (r.breach) {
    const went = `thumbs down on it went from ${pct(share(base))} to ${pct(share(m))}`;
    const e = r.e == null ? {} : { e: Number.isFinite(r.e) ? +r.e.toPrecision(4) : null };
    return { reason: test === "z" ? went : `${went}, evidence ${anytime.odds(r.e)} to 1 against the change`,
      evidence: { test, before: { up: base.up, down: base.down }, after: { up: m.up, down: m.down }, z: +r.z.toFixed(2), ...e, threshold: test === "z" ? SOFT_Z : SOFT_E } };
  }
  // the requests it was for: judged when the canary ends (a shorter window is too noisy), against a window of the
  // same length
  if (now >= f.until) {
    const was = span === len ? base : await measure({ feature: f.feature, proposal: f.proposal, whos, since: f.since - len, until: f.since });
    if (was.unmet && m.unmet != null && m.unmet >= was.unmet)
      return { reason: `the requests it was for did not fall (${was.unmet} in the ${dayText(len)} before, ${m.unmet} in the canary's ${dayText(len)})`, evidence: null };
  }
  return null;
}
const dayText = (ms) => { const d = +(ms / DAY).toFixed(1); return `${d} day${d === 1 ? "" : "s"}`; };
async function promote(f, now) {
  set(f.key, f.value, { by: "code", reason: `the canary for ${f.proposal} passed after ${dayText(now - f.since)}`, status: "on", now });
  await note({ kind: "shipped", key: f.key, proposal: f.proposal, text: `Shipped${f.asked ? `, asked for by ${f.asked} members` : ""}: ${f.about} is now ${shown(f, f.value)}.`, now });
}
// One pass over every flag in a canary, or on and shipped less than WATCH_AFTER_DAYS ago: rolls back on a breach,
// promotes a canary whose days are up. Returns what it did: [{ key, kind: "hard" | "soft" | "promoted", reason?, proposal }]
// (part A's cycle then sets the proposal to rolledBack, opens it again after a soft breach, or marks it shipped).
let running = null;
export function monitor({ now = Date.now() } = {}) {
  // one pass at a time: two passes at once must not both roll back or promote
  if (running) return running;
  running = (async () => {
    const out = [];
    for (const key of Object.keys(schema())) {
      const f = full(key);
      if (f.status !== "canary" && !(f.status === "on" && f.since != null && now - f.since < WATCH_AFTER_DAYS * DAY && f.value !== f.default)) continue;
      const hard = await hardBreach(f, now);
      if (hard) { await rollback(key, hard, { kind: "hard", now }); out.push({ key, kind: "hard", reason: hard, proposal: f.proposal }); continue; }
      if (f.status !== "canary") continue;
      const soft = await softBreach(f, now);
      if (soft) { await rollback(key, soft.reason, { kind: "soft", now, evidence: soft.evidence }); out.push({ key, kind: "soft", reason: soft.reason, proposal: f.proposal }); continue; }
      if (now >= f.until) { await promote(f, now); out.push({ key, kind: "promoted", proposal: f.proposal }); }
    }
    return out;
  })().finally(() => { running = null; });
  return running;
}

// Memory for the agents: what the player told their agent, and what happened in its talks, kept as short notes and
// found again by meaning. The notes closest to a question are put in front of the model as facts (retrieval-augmented
// generation), so a plan can follow something the player said weeks ago ("leave Tomás out for a while") that no
// calendar entry holds.
//   Embeddings: Meta's DRAMA (facebook/drama-base) in embed_worker.py, on the server's CPU, all 768 dimensions.
//   MEMORY_RANK=hybrid fuses its ranking with BM25's (reciprocal rank fusion); the default is DRAMA alone.
//   Without it (not installed, or MEMORY_EMBED=bm25): BM25 over the same notes, so recall still works by words.
// Notes are the player's own words and code-made facts (games, talks); nothing another agent or a review wrote.
// /forget deletes them with the rest.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { readJSON, writeJSON } from "./jsonfile.js";
import { record } from "./ledger.js";
import * as update from "./memory_update.js";
import { readClub } from "./club.js";

const FILE = path.resolve(process.env.MEMORY_FILE || "data/memory.json"), DIM = +(process.env.MEMORY_DIM || 768), MAX = 400;
let db = readJSON(FILE, { players: {} });
const save = () => writeJSON(FILE, db);
export const memoryOn = () => process.env.MEMORY !== "off";

// ---- the embedder: one Python process kept running, one JSON line per request ----
let worker = null, waiting = [], broken = false;
const vecCache = new Map(); // text -> vector, for notes handed in for one run (the evaluation's)
function up() {
  if (worker || broken) return worker;
  const py = process.env.EMBED_PYTHON || path.resolve("../asr/env/bin/python"), here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"));
  if (!fs.existsSync(py)) { broken = true; return null; }
  const hf = process.env.HF_HUB_CACHE || process.env.REEL_HF_CACHE;
  worker = spawn(py, [path.join(here, "embed_worker.py")], { stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, ...(hf ? { HF_HUB_CACHE: hf } : {}), HF_HUB_OFFLINE: "1", TRANSFORMERS_VERBOSITY: "error" } });
  let buf = "";
  worker.stdout.on("data", (d) => { buf += d; for (let i; (i = buf.indexOf("\n")) >= 0;) { const line = buf.slice(0, i); buf = buf.slice(i + 1); waiting.shift()?.(line); } });
  worker.on("exit", () => { worker = null; waiting.splice(0).forEach((f) => f(JSON.stringify({ error: "the embedder stopped" }))); });
  return worker;
}
export async function embed(texts, { query = false } = {}) {
  if (process.env.MEMORY_EMBED === "bm25" || !texts.length) return null;
  const w = up();
  if (!w) return null;
  const t0 = Date.now();
  try {
    const line = await Promise.race([new Promise((ok) => { waiting.push(ok); w.stdin.write(JSON.stringify({ [query ? "queries" : "documents"]: texts.map((t) => String(t).slice(0, 2000)), dim: DIM }) + "\n"); }),
      new Promise((_, no) => setTimeout(() => no(new Error("the embedder did not answer")), +(process.env.EMBED_TIMEOUT_MS || 60000)))]);
    const j = JSON.parse(line);
    if (j.error) { if (/not available/.test(j.error)) broken = true; throw new Error(j.error); }
    record({ site: query ? "memory.query" : "memory.index", model: "drama-base", prompt: 0, cached: 0, output: 0, reasoning: 0, seconds: (Date.now() - t0) / 1000, marker: true, texts: texts.length });
    return j.vectors;
  } catch { return null; }
}

// ---- BM25 (the fallback, and the baseline the evaluation compares with) ----
const words = (t) => String(t).toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").match(/[\p{L}\p{N}]+/gu) || [];
const STOP = new Set("a an the and or but of to in on at for with my me i you your is are was were be it this that these those am pm we our for from by as do not no".split(" "));
export function bm25(notes, query, k = 4) {
  const docs = notes.map((n) => words(n.text).filter((w) => !STOP.has(w))), q = [...new Set(words(query).filter((w) => !STOP.has(w)))];
  const avg = docs.reduce((a, d) => a + d.length, 0) / Math.max(1, docs.length), df = (w) => docs.filter((d) => d.includes(w)).length;
  const scored = notes.map((n, i) => ({ ...n, score: q.reduce((s, w) => { const f = docs[i].filter((x) => x === w).length; if (!f) return s; const idf = Math.log(1 + (docs.length - df(w) + 0.5) / (df(w) + 0.5)); return s + idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * docs[i].length / Math.max(1, avg))); }, 0) }));
  return scored.filter((n) => n.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
}

const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
// the notes closest to the query by meaning (DRAMA), or by words (BM25) when there is no embedder
// (weight: how much of its score a note keeps, by its age: memory.js fade)
async function rank(notes, query, k, min, weight = null) {
  const qv = notes.length ? await embed([query], { query: true }) : null;
  if (!qv || notes.some((n) => n.v?.length !== qv[0].length)) return { by: "bm25", hits: weight ? bm25(notes, query, notes.length).map((n) => ({ ...n, score: n.score * weight(n) })).sort((a, b) => b.score - a.score).slice(0, k) : bm25(notes, query, k) };
  const byMeaning = notes.map((n) => ({ ...n, score: dot(qv[0], n.v) * (weight ? weight(n) : 1) })).sort((a, b) => b.score - a.score);
  if (process.env.MEMORY_RANK === "hybrid") {
    const words = bm25(notes, query, notes.length), rr = (list, n) => { const i = list.findIndex((x) => x.text === n.text); return i < 0 ? 0 : 1 / (60 + i + 1); };
    return { by: "hybrid", hits: byMeaning.filter((n) => n.score >= min).map((n) => ({ ...n, fused: rr(byMeaning, n) + rr(words, n) })).sort((a, b) => b.fused - a.fused).slice(0, k) };
  }
  return { by: "drama", hits: byMeaning.filter((n) => n.score >= min).slice(0, k) };
}
const shown = (h) => ({ note: h.text, kind: h.kind, on: h.at ? new Date(h.at).toISOString().slice(0, 10) : null, score: +h.score.toFixed(3) });

// ---- notes that can be updated, expire and fade (memory_update.js) ----
// A note replaced by a newer one (invalidAt) or past its last day (until) is not live: it is kept, and shown struck
// through, but never recalled and its rule no longer holds. A live note's score fades with its age (half of it after
// MEMORY_HALFLIFE_DAYS, 120 by default; off keeps it), so a stale note gives way to a recent one on the same thing.
// MEMORY_CONSOLIDATE=off keeps the notes append-only, as they were (the evaluation's baseline).
export const consolidateOn = () => process.env.MEMORY_CONSOLIDATE !== "off";
const today = (now) => { const d = new Date(now); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
export const statusOf = (n, now = Date.now()) => (n.invalidAt && n.invalidAt <= now ? "replaced" : n.until && n.until < today(now) ? "expired" : "live");
const live = (notes, now) => notes.filter((n) => statusOf(n, now) === "live");
const fade = (n, now) => { const h = process.env.MEMORY_HALFLIFE_DAYS === "off" ? 0 : +(process.env.MEMORY_HALFLIFE_DAYS || 120); return h && n.at ? 0.5 ** (Math.max(0, now - n.at) / (h * 864e5)) : 1; };
const venueNames = () => { try { return JSON.parse(fs.readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), "../../web/public/data/venues.json"), "utf8")).venues.map((v) => v.name); } catch { return []; } };
// the older notes a new one may change: the closest live ones by meaning, and every live one naming the same member
// or weekday (or whose rule is about them)
function candidates(have, n, now) {
  const mine = new Set(n.about || []), days = update.daysIn(n.text);
  const pool = live(have, now).filter((h) => h.id !== n.id && h.at <= (n.at || now));
  const near = n.v ? pool.filter((h) => h.v?.length === n.v.length).map((h) => ({ h, cos: dot(n.v, h.v) })) : bm25(pool, n.text, pool.length).map((h) => ({ h: pool.find((x) => x.id === h.id), cos: Math.min(0.59, h.score / 20) }));
  const byMeaning = near.filter((x) => x.cos >= +(process.env.MEMORY_UPDATE_MIN || 0.35)).sort((a, b) => b.cos - a.cos).slice(0, 4);
  const bySubject = pool.filter((h) => (h.about || []).some((id) => mine.has(id)) || (h.rule?.who && mine.has(h.rule.who)) || update.daysIn(h.text).some((d) => days.includes(d)) || (h.rule?.day && days.includes(h.rule.day)));
  const out = new Map(byMeaning.map((x) => [x.h.id, { ...x.h, cos: x.cos }]));
  for (const h of bySubject) if (!out.has(h.id)) out.set(h.id, { ...h, cos: near.find((x) => x.h.id === h.id)?.cos ?? null });
  return [...out.values()].sort((a, b) => b.at - a.at).slice(0, 6);
}
// one new note, checked against the older ones: added, added and replacing some, or the same as one (not kept twice)
async function consolidate(player, n, now) {
  const have = db.players[player] || [], cands = candidates(have, n, now);
  const d = await update.decide(n, cands, { venues: venueNames() });
  if ((generation.get(player) || 0) !== n.g) return d; // forgotten meanwhile
  n.op = { op: d.op, by: d.by, ...(d.refused.length ? { refused: d.refused.slice(0, 4) } : {}), at: now };
  if (d.rule) n.rule = d.rule;
  if (d.until) n.until = d.until;
  if (d.op === "update") for (const id of d.replaces) { const o = have.find((h) => h.id === id); if (o && !o.invalidAt) { o.invalidAt = n.at || now; o.invalidBy = n.id; } }
  n.replaces = d.op === "update" ? d.replaces : undefined;
  if (d.op === "same") n.same = cands.sort((a, b) => (b.cos ?? 0) - (a.cos ?? 0))[0]?.id;
  return d;
}

// a player's notes: remember new ones (the same words twice are one note), recall the closest, forget them all
// (/forget while a note is still being embedded: the note is dropped, and nothing deleted comes back)
const generation = new Map();
export async function remember(player, notes, { now = Date.now() } = {}) {
  if (!memoryOn() || !player) return 0;
  const g0 = generation.get(player) || 0, wanted = notes.filter((n) => n.text);
  if (!wanted.length) return 0;
  const vs = await embed(wanted.map((n) => n.text));
  if ((generation.get(player) || 0) !== g0) return 0;
  const have = (db.players[player] ||= []), fresh = wanted.map((n, i) => ({ n, v: vs?.[i] })).filter(({ n }) => !have.some((h) => h.text === n.text));
  if (!fresh.length) return 0;
  const made = fresh.map(({ n, v }) => ({ id: crypto.randomUUID().slice(0, 8), text: String(n.text).slice(0, 400), kind: n.kind || "said", at: n.at || now, about: update.people(n.text), ...(v ? { v } : {}) }));
  let kept = 0;
  for (const n of made) {
    // the player's own words are checked against what they said before (code-made facts are simply added)
    if (consolidateOn() && n.kind === "said") { n.g = g0; const d = await consolidate(player, n, now); delete n.g; if ((generation.get(player) || 0) !== g0) return kept; if (d.op === "same") { const o = have.find((h) => h.id === n.same); if (o) o.at = Math.max(o.at, n.at); continue; } }
    have.push(n); kept++;
  }
  db.players[player] = have.slice(-MAX); save();
  return kept;
}
export async function recall(player, query, { k = 4, min = +(process.env.MEMORY_MIN || 0.3), now = Date.now() } = {}) {
  if (!memoryOn() || !player) return { by: null, notes: [] };
  // a note kept without a vector (the embedder was down), or with another length: embedded now, so it is not lost
  const stale = (db.players[player] || []).filter((n) => n.v?.length !== DIM);
  if (stale.length) { const vs = await embed(stale.map((n) => n.text)); if (vs) { stale.forEach((n, i) => { n.v = vs[i]; }); save(); } }
  // only live notes; append-only (MEMORY_CONSOLIDATE=off) recalls every note, as before
  const pool = consolidateOn() ? live(db.players[player] || [], now) : db.players[player] || [];
  const { by, hits } = await rank(pool, query, k, min, consolidateOn() ? (n) => fade(n, now) : null);
  return { by, notes: hits.map(shown) };
}
// the rules the player's live notes ask for, for the Autopilot to keep (a member left out, a weekday off)
export function rules(player, now = Date.now()) {
  if (!memoryOn() || !player || !consolidateOn()) return [];
  return live(db.players[player] || [], now).filter((n) => n.rule).map((n) => ({ ...n.rule, ...(n.until ? { until: n.until } : {}), note: n.text, said: today(n.at) }));
}
// "forget what I said about Tomás": every note naming that member (or whose rule is about them), replaced ones too; or,
// for a topic, every note with one of its words or close to it in meaning (MEMORY_FORGET_MIN, 0.6). Deleted, not
// marked: forgetting is for the player's privacy. Returns what was deleted.
const FORGET_STOP = new Set("forget what i said told you about everything anything all the my me please note notes that this".split(" "));
export async function forgetAbout(player, about) {
  const have = db.players[player] || [], q = String(about || "").slice(0, 200), who = update.people(q);
  let by, gone;
  if (who.length) { by = "member"; gone = have.filter((n) => (n.about || update.people(n.text)).some((id) => who.includes(id)) || who.includes(n.rule?.who)); }
  else {
    const ws = [...new Set(words(q).filter((w) => !STOP.has(w) && !FORGET_STOP.has(w) && w.length >= 3))];
    if (!ws.length) return { by: null, deleted: [] };
    const stem = (w) => w.replace(/(ies|es|s)$/, "").slice(0, 6), has = (n) => words(n.text).some((w) => ws.some((x) => stem(w) === stem(x)));
    const qv = await embed([q], { query: true }), close = (n) => qv && n.v?.length === qv[0].length && dot(qv[0], n.v) >= +(process.env.MEMORY_FORGET_MIN || 0.6);
    by = qv ? "words and meaning" : "words"; gone = have.filter((n) => has(n) || close(n));
  }
  if (!gone.length) return { by, deleted: [] };
  // (a note one of these had replaced stays replaced: forgetting the newer words does not bring back the older ones)
  db.players[player] = have.filter((n) => !gone.includes(n));
  if (!db.players[player].length) delete db.players[player];
  save();
  return { by, deleted: gone.map(({ id, text }) => ({ id, text })) };
}
// notes handed in for one run (the evaluation's), embedded once and kept in this process only
export async function recallIn(notes, query, { k = 4, min = +(process.env.MEMORY_MIN || 0.3) } = {}) {
  if (!memoryOn() || !notes?.length) return { by: null, notes: [] };
  const missing = notes.filter((n) => !vecCache.has(n.text)), vs = missing.length ? await embed(missing.map((n) => n.text)) : [];
  if (vs) missing.forEach((n, i) => vecCache.set(n.text, vs[i]));
  const { by, hits } = await rank(notes.map((n) => ({ ...n, v: vecCache.get(n.text) })), query, k, min);
  return { by, notes: hits.map(shown) };
}
// the embedder's process ends with this one (a run that is done must not be kept alive by it)
export function close() { if (worker) { try { worker.stdin.end(); worker.kill(); } catch { /* gone */ } worker = null; } }
export function forget(player) { generation.set(player, (generation.get(player) || 0) + 1); if (db.players[player]) { delete db.players[player]; save(); } }
export const count = (player) => (db.players[player] || []).length;
// a player's notes as the app lists them (newest first, never the vectors), with whether each is live, replaced (by
// which note, when) or expired, the rule it asks for and its last day; and one of them deleted
export const list = (player, now = Date.now()) => {
  const have = db.players[player] || [], names = new Map((() => { try { return readClub().members.map((m) => [m.id, m.name.split(" ")[0]]); } catch { return []; } })());
  return have.map((n) => ({ id: n.id, text: n.text, kind: n.kind, at: n.at, status: statusOf(n, now), ...(n.until ? { until: n.until } : {}),
    ...(n.rule ? { rule: { ...n.rule, ...(n.rule.who ? { name: names.get(n.rule.who) || n.rule.who } : {}) } } : {}),
    ...(n.invalidAt ? { replacedAt: n.invalidAt, replacedBy: have.find((x) => x.id === n.invalidBy)?.text || null } : {}),
    ...(n.op ? { checked: { op: n.op.op, by: n.op.by, ...(n.op.refused ? { refused: n.op.refused } : {}) } } : {}) })).reverse();
};
export function drop(player, id) {
  const have = db.players[player] || [], k = have.findIndex((n) => n.id === id);
  if (k < 0) return false;
  have.splice(k, 1);
  if (!have.length) delete db.players[player];
  save();
  return true;
}
// which way recall finds notes on this server: by meaning (DRAMA), or by words (BM25) when there is no embedder
export const how = () => (!memoryOn() ? "off" : process.env.MEMORY_EMBED === "bm25" || broken ? "words" : "meaning");

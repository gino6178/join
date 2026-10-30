// Peers: Serve gateways on other machines (docs/a2a_two_gateways.md). Your agent talks to members whose agents live on
// another gateway, and that gateway's agent talks to yours, over A2A as before. This module decides who may.
//   A2A_PEERS_FILE  the allow-list, a JSON file: this gateway's name ("self") and its peers, each with
//                     name     a short name (letters, digits, - and _)
//                     origin   where it is reached from here (through an SSH tunnel: http://127.0.0.1:<port>)
//                     serve    which of this gateway's members its agents may ask (ids, or "*" for every simulated or
//                              demo member; a real player's agent never answers a peer)
//                     members  the members of theirs your agent may ask: a public profile only (id, name, level,
//                              sports, prefers), never a calendar, a rule or a record, which stay on their gateway
//                     key      optional: its public key (a JWK with its kid), pinned in config by hand
//   A2A_PEER_PINS   the keys pinned on first use (default A2A_DATA/peer_pins.json)
// Without A2A_PEERS_FILE there are no peers and the gateway is as it was: one machine, the shared token.
//
// Trust comes in three parts:
//   1. The peer's key. The first time this gateway talks to an allow-listed peer, or hears from one, it fetches the key
//      set at that peer's own origin (/a2a/keys.json, no redirects) and pins it. The key id must be the key's own
//      fingerprint. After that only the pinned key counts. A card or a request signed by any other key is refused and
//      logged, until someone deletes the pin (the peer rotated its key) or writes the new key in config.
//   2. Each request. A request to a peer carries Serve-Signature: a compact JWS (EdDSA, with the gateway's card key,
//      typ "serve-request+jwt") over the method, the path, the SHA-256 of the body, the receiver's key id (aud), the
//      time it was made and when it expires (60 s at most), and a nonce. The receiver checks it against the pinned key
//      the key id names. It refuses a nonce it has seen (nonces are kept on disk until they expire), a request more than
//      30 s off its clock, a body or path that is not the one signed, and a request meant for another gateway.
//      The answer is signed the same way (typ "serve-response+jwt": the status, the SHA-256 of the body, and the nonce
//      of the request it answers), and the asking gateway uses it only if the peer's pinned key signed it. So a third
//      gateway that takes over a peer's address (its tunnel down, its port taken) can't answer for that peer's members.
//   3. Each member. A member's agent answers a peer only if that peer's `serve` names it. A peer sees its own tasks
//      only. Its talks, holds and asker ids are kept apart from this gateway's own, and from other peers'.
// Every refusal is logged (A2A_DATA/peer_log.jsonl and the console) with the reason, the path and the key id, never a
// key or a token.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import { readJSON, writeJSON } from "./jsonfile.js";

const DATA = () => path.resolve(process.env.A2A_DATA || "data");
const b64u = (b) => Buffer.from(b).toString("base64url");
const sha256 = (b) => crypto.createHash("sha256").update(b).digest();
const bytes = (b) => (b == null ? Buffer.alloc(0) : Buffer.isBuffer(b) ? b : typeof b === "string" ? Buffer.from(b, "utf8") : Buffer.from(b));
export const HEADER = "serve-signature", TYP = "serve-request+jwt", RTYP = "serve-response+jwt";
const NAME = /^[A-Za-z0-9_-]{1,32}$/, MEMBER_ID = /^[A-Za-z0-9_.-]{1,40}$/;
const MAX_AGE = () => +(process.env.A2A_PEER_MAX_AGE_S || 60), SKEW = () => +(process.env.A2A_PEER_SKEW_S || 30);
// a key id is the key's own fingerprint, the same rule a2a_server.js uses for the cards' key
export const kidOf = (x) => `serve-${crypto.createHash("sha256").update(String(x)).digest("hex").slice(0, 16)}`;

// ---- this gateway's own key: one Ed25519 key for its Agent Cards (a2a_server.js) and its requests to peers --------
// (A2A_DATA/card-key.pem, made once when there is none: another process that made it first wins, and its key is read back)
const own = new Map();
export function ownKey(dir = DATA()) {
  const file = path.join(path.resolve(dir), "card-key.pem");
  if (own.has(file)) return own.get(file);
  let pem = null;
  try { pem = fs.readFileSync(file); } catch (e) { if (e.code !== "ENOENT") throw e; }
  if (!pem) {
    const made = crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try { fs.writeFileSync(file, made, { mode: 0o600, flag: "wx" }); pem = made; } catch (e) { if (e.code !== "EEXIST") throw e; pem = fs.readFileSync(file); }
  }
  const key = crypto.createPrivateKey(pem), jwk = crypto.createPublicKey(key).export({ format: "jwk" });
  const k = { file, key, jwk, kid: kidOf(jwk.x) };
  own.set(file, k);
  return k;
}

// ---- the allow-list -------------------------------------------------------------------------------------------------
const originOf = (u) => { try { const x = new URL(String(u)); return /^https?:$/.test(x.protocol) ? x.origin : null; } catch { return null; } };
// what a peer's member is to this gateway: a name to address and to write sentences with, nothing private
const profile = (x) => ({ id: x.id, name: String(x.name || x.id).slice(0, 60), ...(/^[A-D]$/.test(x.level || "") ? { level: x.level } : {}),
  sports: (Array.isArray(x.sports) ? x.sports : ["badminton"]).filter((s) => typeof s === "string").slice(0, 6), prefers: ["singles", "doubles", "any"].includes(x.prefers) ? x.prefers : "any" });
const okKey = (k) => k && k.kty === "OKP" && k.crv === "Ed25519" && typeof k.x === "string" && typeof k.kid === "string" && k.kid === kidOf(k.x);
let cfg = { file: null, at: -1, v: { self: null, peers: [] } };
export function config() {
  const file = process.env.A2A_PEERS_FILE ? path.resolve(process.env.A2A_PEERS_FILE) : null;
  if (!file) return { self: null, peers: [] };
  let at = -1; try { at = fs.statSync(file).mtimeMs; } catch { return { self: null, peers: [] }; }
  if (cfg.file === file && cfg.at === at) return cfg.v;
  const raw = readJSON(file, {}), seen = new Set();
  const peers = (Array.isArray(raw.peers) ? raw.peers : []).filter((p) => NAME.test(p?.name || "") && originOf(p.origin) && !seen.has(p.name) && seen.add(p.name)).map((p) => ({
    name: p.name, origin: originOf(p.origin),
    serve: p.serve === "*" || (Array.isArray(p.serve) && p.serve.includes("*")) ? "*" : new Set((Array.isArray(p.serve) ? p.serve : []).filter((x) => MEMBER_ID.test(x))),
    members: (Array.isArray(p.members) ? p.members : []).filter((x) => MEMBER_ID.test(x?.id || "")).map(profile),
    key: okKey(p.key) ? { kty: "OKP", crv: "Ed25519", x: p.key.x, kid: p.key.kid } : null,
  }));
  cfg = { file, at, v: { self: NAME.test(raw.self || "") ? raw.self : null, peers } };
  return cfg.v;
}
export const peers = () => config().peers;
export const on = () => peers().length > 0;
export const byName = (n) => peers().find((p) => p.name === n) || null;
export const byOrigin = (u) => { const o = originOf(u); return (o && peers().find((p) => p.origin === o)) || null; };
// may this peer's agents ask this member (never a real player's agent)
export const serves = (name, m) => { const p = byName(name), id = typeof m === "string" ? m : m?.id; return !!p && !(typeof m === "object" && m?.real) && (p.serve === "*" || p.serve.has(id)); };

// ---- members on a peer ----------------------------------------------------------------------------------------------
// Here a peer's member is <their id>@<peer>, so it never clashes with one of ours; its agent is at the peer's origin.
export function remoteOf(m) {
  const id = String(typeof m === "string" ? m : m?.id || ""), i = id.lastIndexOf("@");
  if (i < 1) return null;
  const p = byName(id.slice(i + 1));
  return { peer: id.slice(i + 1), id: id.slice(0, i), origin: p ? p.origin : null };
}
export const isRemote = (m) => !!remoteOf(m);
export function baseFor(m) {
  const r = remoteOf(m);
  if (!r) return `${process.env.A2A_BASE}/a2a/members/${m.id}`;
  if (!r.origin) throw new Error(`no peer gateway "${r.peer}" on the allow-list`);
  return `${r.origin}/a2a/members/${encodeURIComponent(r.id)}`;
}
export function member(id) {
  const r = remoteOf(id), p = r && byName(r.peer), x = p?.members.find((y) => y.id === r.id);
  return x ? { ...x, id: `${x.id}@${p.name}`, peer: p.name, remote: true } : null;
}
export const members = (name = null) => peers().filter((p) => !name || p.name === name).flatMap((p) => p.members.map((x) => member(`${x.id}@${p.name}`)));

// ---- pinned keys ----------------------------------------------------------------------------------------------------
const PINS = () => path.resolve(process.env.A2A_PEER_PINS || path.join(DATA(), "peer_pins.json"));
let pinDb = null;
const pins = () => (pinDb?.file === PINS() ? pinDb.v : (pinDb = { file: PINS(), v: readJSON(PINS(), {}) }).v);
export const pinOf = (name) => { const p = byName(name); return p?.key || pins()[name]?.key || null; };
const fetching = new Map(), tried = new Map();
// The key of an allow-listed peer: in config, pinned, or fetched once from its own origin and pinned there (trust on
// first use, over a channel the SSH tunnel's pinned host key authenticates). fetchKeys(origin) returns its key set.
export async function keyOf(p, fetchKeys) {
  const k = pinOf(p.name);
  if (k || !fetchKeys) return k;
  if (!fetching.has(p.name)) fetching.set(p.name, (async () => {
    tried.set(p.name, Date.now());
    const set = await fetchKeys(p.origin), ks = (set?.keys || []).filter((x) => x?.kty === "OKP" && x.crv === "Ed25519");
    // one key, the gateway's, whose id is its own fingerprint (so a key set can't claim another key's id)
    if (ks.length !== 1 || !okKey(ks[0])) { note("pin-refused", { peer: p.name, origin: p.origin, why: ks.length !== 1 ? `${ks.length} Ed25519 keys` : "key id is not the key's fingerprint" }); throw new Error(`${p.name}: no single key to pin`); }
    const key = { kty: "OKP", crv: "Ed25519", x: ks[0].x, kid: ks[0].kid };
    pins()[p.name] = { origin: p.origin, key, at: new Date().toISOString() };
    writeJSON(PINS(), pins());
    note("pinned", { peer: p.name, origin: p.origin, kid: key.kid });
    return key;
  })().finally(() => fetching.delete(p.name)));
  return fetching.get(p.name);
}

// ---- signing and checking a request ---------------------------------------------------------------------------------
// the token for one request; key: this gateway's private key, kid its id, aud the receiver's key id
export function signToken({ key, kid, aud, method, path: p, body, now = Date.now(), ttl = MAX_AGE(), jti = crypto.randomUUID() }) {
  const t = Math.floor(now / 1000), header = { alg: "EdDSA", typ: TYP, kid };
  const claims = { iss: kid, aud, method: String(method || "GET").toUpperCase(), path: p, body: b64u(sha256(bytes(body))), iat: t, exp: t + ttl, jti };
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`;
  return `${input}.${b64u(crypto.sign(null, Buffer.from(input), key))}`;
}
const no = (why, message) => ({ ok: false, why, message });
// Checks one request's token. keyFor(kid) gives { peer, key } for a pinned peer key, or null; audience is this
// gateway's own key id; seen is the nonce store. Returns { ok, peer, kid } or { ok: false, why, message }.
export function checkToken(token, { method, path: p, body, now = Date.now(), keyFor, audience, seen }) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || parts.some((x) => !/^[A-Za-z0-9_-]+$/.test(x))) return no("malformed", "not a compact JWS");
  let h, c;
  try { h = JSON.parse(Buffer.from(parts[0], "base64url")); c = JSON.parse(Buffer.from(parts[1], "base64url")); } catch { return no("malformed", "not a compact JWS"); }
  if (h?.alg !== "EdDSA" || h.typ !== TYP || typeof h.kid !== "string") return no("malformed", "not a Serve request signature (alg EdDSA, typ serve-request+jwt)");
  const k = keyFor(h.kid);
  if (!k) return no("unknown-peer", "signed by a key no allow-listed peer has");
  let good = false;
  try { good = crypto.verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: k.key.x }, format: "jwk" }), Buffer.from(parts[2], "base64url")); } catch { good = false; }
  if (!good) return no("bad-signature", "the signature does not check out");
  if (c?.iss !== h.kid) return no("bad-claims", "issuer is not the signing key");
  if (c.aud !== audience) return no("wrong-audience", "meant for another gateway");
  if (c.method !== String(method).toUpperCase() || c.path !== p) return no("wrong-request", "signed for another method or path");
  if (c.body !== b64u(sha256(bytes(body)))) return no("wrong-body", "the body is not the one signed");
  const t = Math.floor(now / 1000);
  if (!Number.isInteger(c.iat) || !Number.isInteger(c.exp) || c.exp <= c.iat || c.exp - c.iat > MAX_AGE()) return no("bad-claims", "issued-at and expiry missing or too far apart");
  if (c.iat > t + SKEW() || c.exp + SKEW() < t) return no("expired", "expired, or from the future");
  if (typeof c.jti !== "string" || c.jti.length < 16 || c.jti.length > 64) return no("bad-claims", "no nonce");
  const n = `${h.kid}|${c.jti}`;
  if (seen.has(n, now)) return no("replay", "a request already received");
  seen.add(n, (c.exp + SKEW()) * 1000);
  return { ok: true, peer: k.peer, kid: h.kid, jti: c.jti };
}
// what a token claims, unchecked (the asking side reads its own request's nonce back)
export const claimsOf = (token) => { try { return JSON.parse(Buffer.from(String(token).split(".")[1], "base64url")); } catch { return null; } };
// The answer to a peer's request, signed by the answering gateway: its status, its body, and the nonce of the request
// it answers (req), for the gateway that asked (aud). No nonce store is needed: the request's nonce is used once.
export function signResponseToken({ key, kid, aud, status, body, req, now = Date.now(), ttl = MAX_AGE() }) {
  const t = Math.floor(now / 1000), header = { alg: "EdDSA", typ: RTYP, kid };
  const claims = { iss: kid, aud, status, body: b64u(sha256(bytes(body))), req, iat: t, exp: t + ttl };
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`;
  return `${input}.${b64u(crypto.sign(null, Buffer.from(input), key))}`;
}
// checks an answer against the pinned key of the peer that was asked (only that one), for the request it was asked
export function checkResponse(token, { key, audience, status, body, req, now = Date.now() }) {
  const parts = String(token || "").split(".");
  if (!key) return no("unknown-peer", "no pinned key for the peer that was asked");
  if (parts.length !== 3 || parts.some((x) => !/^[A-Za-z0-9_-]+$/.test(x))) return no("unsigned", "the answer carries no signature");
  let h, c;
  try { h = JSON.parse(Buffer.from(parts[0], "base64url")); c = JSON.parse(Buffer.from(parts[1], "base64url")); } catch { return no("unsigned", "the answer carries no signature"); }
  if (h?.alg !== "EdDSA" || h.typ !== RTYP || h.kid !== key.kid) return no("other-key", "not signed by the pinned key of the peer that was asked");
  let good = false;
  try { good = crypto.verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key.x }, format: "jwk" }), Buffer.from(parts[2], "base64url")); } catch { good = false; }
  if (!good) return no("bad-signature", "the answer's signature does not check out");
  if (c?.iss !== h.kid || c.aud !== audience || c.req !== req) return no("other-request", "signed for another request or another gateway");
  if (c.status !== status || c.body !== b64u(sha256(bytes(body)))) return no("wrong-body", "the answer is not the one signed");
  const t = Math.floor(now / 1000);
  if (!Number.isInteger(c.iat) || !Number.isInteger(c.exp) || c.exp - c.iat > MAX_AGE() || c.iat > t + SKEW() || c.exp + SKEW() < t) return no("expired", "expired, or from the future");
  return { ok: true };
}
// the receiving side: a signature for its answer to a request verify() accepted (v)
export const signAnswer = (v, status, body) => { const k = ownKey(); return signResponseToken({ key: k.key, kid: k.kid, aud: v.kid, status, body, req: v.jti }); };
// the asking side: the answer to its request (nonce jti) to peer p, used only if p's pinned key signed it. An unsigned
// refusal (a 4xx) is a failure either way, and says its status.
export async function checkAnswer(p, res, jti) {
  const body = Buffer.from(await res.arrayBuffer());
  const r = checkResponse(res.headers.get(HEADER), { key: pinOf(p.name), audience: ownKey().kid, status: res.status, body, req: jti });
  if (!r.ok) {
    if (res.status >= 400 && r.why === "unsigned") throw new Error(`HTTP ${res.status} from peer ${p.name}: ${body.toString("utf8").slice(0, 120)}`);
    note("refused", { why: `answer-${r.why}`, peer: p.name, status: res.status });
    throw new Error(`the answer is not signed by peer ${p.name}'s pinned key (${r.message})`);
  }
  count(`answers.${p.name}`);
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}
// nonces seen, until each one expires; on disk (file) so a restart does not open a replay window, or in memory
export function createSeen(file = null, cap = 50000) {
  let v = file ? readJSON(file, {}) : {}, timer = null;
  const save = () => { if (file && !timer) timer = setTimeout(() => { timer = null; writeJSON(file, v); }, 50); };
  return {
    has: (n, now = Date.now()) => (v[n] || 0) > now,
    add(n, until) {
      const now = Date.now();
      if (Object.keys(v).length >= cap) v = Object.fromEntries(Object.entries(v).filter(([, u]) => u > now));
      v[n] = until; save();
    },
    flush() { if (timer) { clearTimeout(timer); timer = null; } if (file) writeJSON(file, v); },
    size: () => Object.keys(v).length,
  };
}
let seenDb = null;
const seenStore = () => (seenDb?.file === path.join(DATA(), "peer_seen.json") ? seenDb.s : (seenDb = { file: path.join(DATA(), "peer_seen.json"), s: createSeen(path.join(DATA(), "peer_seen.json")) }).s);

// the header for a request from this gateway to a peer (none for any other address, and none for a GET: the cards and
// the key set are public). fetchKeys pins the peer's key first if it has none yet (its key id is the audience).
export async function sign(url, { method = "GET", body = "" } = {}, fetchKeys = null) {
  const p = byOrigin(url);
  if (!p || String(method).toUpperCase() === "GET") return {};
  const theirs = await keyOf(p, fetchKeys);
  if (!theirs) throw new Error(`no pinned key for peer ${p.name}`);
  const k = ownKey(), u = new URL(url);
  count(`sent.${p.name}`);
  return { [HEADER]: signToken({ key: k.key, kid: k.kid, aud: theirs.kid, method, path: u.pathname + u.search, body }) };
}
// a request that carries Serve-Signature: checked against the pinned key of the peer its key id names. A key id no pin
// has makes this gateway try, once a minute at most, to pin the allow-listed peers it has no key for yet.
export async function verify({ method, path: p, headers, body, from = null }, fetchKeys = null) {
  const token = headers?.[HEADER];
  const keyFor = (kid) => { for (const x of peers()) { const k = pinOf(x.name); if (k?.kid === kid) return { peer: x.name, key: k }; } return null; };
  const kid = (() => { try { return JSON.parse(Buffer.from(String(token).split(".")[0], "base64url")).kid; } catch { return null; } })();
  if (kid && !keyFor(kid) && fetchKeys) {
    const unpinned = peers().filter((x) => !pinOf(x.name) && Date.now() - (tried.get(x.name) || 0) > 60000);
    await Promise.all(unpinned.map((x) => keyOf(x, fetchKeys).catch(() => null)));
  }
  const r = checkToken(token, { method, path: p, body, keyFor, audience: ownKey().kid, seen: seenStore() });
  if (!r.ok) note("refused", { why: r.why, method, path: p, kid: String(kid || "").slice(0, 40), from });
  else count(`accepted.${r.peer}`);
  return r;
}

// ---- signed mandates: the player's yes, as a credential (AP2-style, closed) ---------------------------------------
// When the player books a game with partners on a peer gateway, this gateway signs a short-lived mandate (typ
// "serve-mandate+jwt", its own key): who (a hash of the player's id), the talk, the game (sport, format, date, start,
// minutes, venue), the court, the members, the price cap and an expiry (5 min), with a nonce. A peer's member agent
// turns a hold into a game ("book") only with a valid mandate from the asking gateway's pinned key, for this talk,
// this time and this member, used once per member; it keeps the mandate as its receipt (A2A_DATA/mandates.jsonl).
export const MTYP = "serve-mandate+jwt", MANDATE_S = () => +(process.env.A2A_MANDATE_S || 300);
export function signMandateToken({ key, kid, who, talk, game, court, members, cap, now = Date.now(), ttl = MANDATE_S(), jti = crypto.randomUUID() }) {
  const t = Math.floor(now / 1000), header = { alg: "EdDSA", typ: MTYP, kid };
  const claims = { iss: kid, sub: crypto.createHash("sha256").update(`${kid}|${who}`).digest("hex").slice(0, 24), talk, game, court, members: [...members].sort(), cap, iat: t, exp: t + ttl, jti };
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`;
  return `${input}.${b64u(crypto.sign(null, Buffer.from(input), key))}`;
}
// this gateway's mandate for a booking it is about to make (option: play.js's)
export const mandateFor = (o, who = "you") => { const k = ownKey(); return signMandateToken({ key: k.key, kid: k.kid, who, talk: o.hold || o.talk, court: o.court ?? null, members: (o.partners || []).map((p) => p.id), cap: o.total ?? null,
  game: { sport: o.sport || "badminton", format: o.format || "singles", date: o.date, start: o.start, minutes: o.minutes || 90, venue: o.venue?.id || null } }); };
// checks a mandate against the asking peer's pinned key (key), for this talk (ref), time and member (member: the id
// the asking gateway knows it by, <id>@<this gateway's name>); seen keeps each mandate's use per member
export function checkMandate(token, { key, ref, date, start, minutes, member, seen, now = Date.now() }) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || parts.some((x) => !/^[A-Za-z0-9_-]+$/.test(x))) return no("no-mandate", "no signed mandate from the player");
  let h, c;
  try { h = JSON.parse(Buffer.from(parts[0], "base64url")); c = JSON.parse(Buffer.from(parts[1], "base64url")); } catch { return no("no-mandate", "no signed mandate from the player"); }
  if (h?.alg !== "EdDSA" || h.typ !== MTYP || !key || h.kid !== key.kid) return no("mandate-other-key", "not signed by the asking gateway's pinned key");
  let good = false;
  try { good = crypto.verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key.x }, format: "jwk" }), Buffer.from(parts[2], "base64url")); } catch { good = false; }
  if (!good) return no("mandate-bad-signature", "the mandate's signature does not check out");
  const t = Math.floor(now / 1000);
  if (!Number.isInteger(c?.exp) || !Number.isInteger(c.iat) || c.exp - c.iat > 3600 || c.iat > t + SKEW() || c.exp + SKEW() < t) return no("mandate-expired", "the mandate has expired");
  if (c.talk !== ref || c.game?.date !== date || c.game?.start !== start || (c.game?.minutes || 90) !== minutes) return no("mandate-other-game", "the mandate is for another game");
  if (!Array.isArray(c.members) || !c.members.includes(member)) return no("mandate-other-member", "the mandate does not name this member");
  if (typeof c.jti !== "string" || c.jti.length < 16) return no("no-mandate", "the mandate has no nonce");
  const n = `${c.jti}|${member}`;
  if (seen.has(n, now)) return no("mandate-replay", "this mandate was already used");
  seen.add(n, (c.exp + SKEW()) * 1000);
  return { ok: true, claims: c };
}
let mseen = null;
const mandateSeen = () => (mseen?.file === path.join(DATA(), "mandate_seen.json") ? mseen.s : (mseen = { file: path.join(DATA(), "mandate_seen.json"), s: createSeen(path.join(DATA(), "mandate_seen.json")) }).s);
// the receiving side: a peer's mandate for a booking of one of this gateway's members, checked, and kept as the receipt
export function acceptMandate(token, { caller, ref, date, start, minutes, member }) {
  const r = checkMandate(token, { key: pinOf(caller), ref, date, start, minutes, member: `${member}@${config().self || ""}`, seen: mandateSeen() });
  if (!r.ok) { note("refused", { why: r.why, peer: caller, member, talk: String(ref).slice(0, 40) }); return r; }
  try { fs.mkdirSync(DATA(), { recursive: true }); fs.appendFileSync(path.join(DATA(), "mandates.jsonl"), JSON.stringify({ at: new Date().toISOString(), peer: caller, member, mandate: token }) + "\n"); } catch { /* the hold still records the booking */ }
  count("mandate.accepted");
  return r;
}

// ---- reachability ---------------------------------------------------------------------------------------------------
// A peer that does not answer now (stopped, preempted, its tunnel down) is "not reachable now" at once, rather than a
// talk waiting out the A2A timeout: one quick probe (its public key set, A2A_PEER_PROBE_MS), remembered for 10 s.
const health = new Map(), PROBE = () => +(process.env.A2A_PEER_PROBE_MS || 3000);
// (on a connection of its own, never a kept-alive one the peer may have closed meanwhile)
export const probe = (o, ms = PROBE()) => new Promise((ok) => {
  let u; try { u = new URL("/a2a/keys.json", o); } catch { return ok(false); }
  const req = (u.protocol === "https:" ? https : http).get(u, { agent: false, timeout: ms }, (res) => { res.resume(); ok(res.statusCode === 200); });
  req.on("timeout", () => { req.destroy(); ok(false); }); req.on("error", () => ok(false));
});
export async function reachable(o) {
  if (!o) return false;
  const h = health.get(o);
  if (h && Date.now() - h.at < (h.up ? 10000 : 3000)) return h.up;
  const up = await probe(o);
  health.set(o, { up, at: Date.now() });
  if (!up) count("unreachable");
  return up;
}
export const markDown = (o) => health.set(o, { up: false, at: Date.now() });
// A long request to a peer (a member's agent thinking) is watched: probed every 10 s while it runs, and given up after
// two missed probes, so a preempted peer ends the wait in about 20 s, not at the A2A timeout.
export function watch(o, { every = +(process.env.A2A_PEER_WATCH_MS || 10000), misses = 2 } = {}) {
  const ac = new AbortController();
  let miss = 0, busy = false;
  const t = setInterval(async () => {
    if (busy) return; busy = true;
    const up = await probe(o); busy = false;
    if (up) miss = 0; else if (++miss >= misses) { clearInterval(t); markDown(o); count("cut-off"); ac.abort(new Error("the peer gateway stopped answering")); }
  }, every);
  t.unref?.();
  return { signal: ac.signal, stop: () => clearInterval(t) };
}

// ---- who is asking, on the receiving side ---------------------------------------------------------------------------
// the SDK's user for a peer's request (its task store and event buses are scoped by userName)
export const user = (name) => ({ get isAuthenticated() { return true; }, get userName() { return `peer:${name}`; } });
export const callerOf = (context) => { const u = String(context?.user?.userName || ""); return u.startsWith("peer:") ? u.slice(5) : null; };
// what a peer's requests are kept under here: its own message ids, its own talks (A2A contexts, so its own holds) and
// its own asker ids, so nothing it sends can reach this gateway's talks or another peer's
export const scoped = (caller) => (!caller ? { id: (x) => x, ref: (x) => x, from: (x) => x }
  : { id: (x) => `${caller}|${x}`, ref: (x) => `peer.${caller}.${x}`, from: (x) => `${caller}:${x}` });

// ---- what could not be delivered: releases sent again until heard (or until the hold has lapsed by itself) ------------
const OUTBOX = () => path.join(DATA(), "peer_outbox.json");
let outTimer = null, flushing = null;
const outKey = (x) => JSON.stringify([x.member, x.ref, x.date, x.start]);
export const outbox = {
  handler: null, // (item) => Promise<boolean>: true once delivered (a2a.js sets it)
  add(x) {
    const db = readJSON(OUTBOX(), []);
    if (!db.some((y) => outKey(y) === outKey(x))) { db.push({ ...x, at: Date.now(), until: Date.now() + +(process.env.A2A_LEASE_MS || 30 * 60000) }); count("outbox.added"); }
    writeJSON(OUTBOX(), db);
    if (!outTimer) { outTimer = setInterval(() => outbox.flush().catch(() => {}), +(process.env.A2A_PEER_RETRY_MS || 30000)); outTimer.unref?.(); }
  },
  // one flush at a time; what was added meanwhile stays (only what was delivered, or lapsed, is taken out)
  flush() {
    return (flushing ||= (async () => {
      const db = readJSON(OUTBOX(), []), gone = new Set();
      if (!db.length || !outbox.handler) return 0;
      for (const x of db) {
        if (x.until < Date.now()) { count("outbox.lapsed"); gone.add(outKey(x)); continue; } // the hold lapsed by itself meanwhile
        const r = byName(remoteOf(x.member)?.peer || "");
        if (!r || !(await reachable(r.origin))) continue;
        if (await outbox.handler(x).catch(() => false)) { count("outbox.delivered"); gone.add(outKey(x)); }
      }
      const left = readJSON(OUTBOX(), []).filter((x) => !gone.has(outKey(x)));
      writeJSON(OUTBOX(), left);
      if (!left.length && outTimer) { clearInterval(outTimer); outTimer = null; }
      return gone.size;
    })().finally(() => { flushing = null; }));
  },
  items: () => readJSON(OUTBOX(), []),
};

// ---- the log and the counts -----------------------------------------------------------------------------------------
const counts = {};
export const count = (k, n = 1) => { counts[k] = (counts[k] || 0) + n; };
export const stats = () => ({ ...counts });
export function note(kind, detail = {}) {
  count(kind === "refused" ? `refused.${detail.why || "?"}` : kind);
  const e = { at: new Date().toISOString(), kind, ...detail };
  try { fs.mkdirSync(DATA(), { recursive: true }); fs.appendFileSync(path.join(DATA(), "peer_log.jsonl"), JSON.stringify(e) + "\n"); } catch { /* the console still has it */ }
  if (kind !== "pinned" || process.env.A2A_PEER_QUIET !== "1") console.warn(`[peer] ${kind}: ${JSON.stringify(detail).slice(0, 240)}`);
}

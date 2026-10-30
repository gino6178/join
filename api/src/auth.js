// Who is asking.
//   People sign in on the website. The demo signs in by picking a player (DEMO_SIGNIN, on unless set to 0); a real
//   deployment puts its own login in front of createSession. A session is an HttpOnly cookie.
//   Agents use a personal token the person made on the website ("Connect your agent"): Bearer join_..., kept only as a
//   SHA-256 hash, named after the agent it was made for, revocable, and scoped to that one player. A token can do what
//   the player's agent should do (search, negotiate, pay their share within their mandate) and nothing else: it can't
//   change the mandate, make other tokens or save a payment method. Those need the person's session.
//   Each token also has scopes the person chose (read, negotiate, pay) and an expiry, and may be tied to a public key:
//   then every request must be signed with it (HTTP Message Signatures, RFC 9421, the basis of Web Bot Auth), so a
//   leaked token alone is useless.
import crypto from "node:crypto";
import { store, stateFile } from "./store.js";
import { player } from "./world.js";

const db = store(stateFile("tokens"), { tokens: [] });
export const tokensStore = db;
const sessions = new Map();
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
export const COOKIE = "join_session";
export const VENUE_COOKIE = "join_venue";
// A venue's staff sign in the same way (the demo picks a venue). Its own cookie, so one browser can be a player and a
// venue at once in the demo.
const venueSessions = new Map();
export function createVenueSession(venueId) { const sid = crypto.randomBytes(24).toString("base64url"); venueSessions.set(sid, venueId); return sid; }
export function venueOf(req) { const sid = cookie(req, VENUE_COOKIE) || ""; return venueSessions.has(sid) ? { venue: venueSessions.get(sid), sid } : null; }
export const endVenueSession = (sid) => venueSessions.delete(sid);

export function createSession(playerId) {
  if (!player(playerId)) return null;
  const sid = crypto.randomBytes(24).toString("base64url");
  sessions.set(sid, { player: playerId, at: Date.now() });
  return sid;
}
export const endSession = (sid) => sessions.delete(sid);
const cookie = (req, k) => (req.headers.cookie || "").split(/;\s*/).map((c) => c.split("=")).find(([n]) => n === k)?.[1];
export function sessionOf(req) { const s = sessions.get(cookie(req, COOKIE) || ""); return s ? { player: s.player, sid: cookie(req, COOKIE) } : null; }

// What each scope allows: reading, negotiating (and answering invitations), paying a share
export const SCOPES = ["read", "negotiate", "pay"];
const NEEDS = { whoami: "read", list_activities: "read", list_venues: "read", find_options: "read", find_alternatives: "read", my_plans: "read", booking_status: "read",
  start_negotiation: "negotiate", make_offer: "negotiate", accept_price: "negotiate", walk_away: "negotiate", propose_share: "negotiate", answer_share: "negotiate",
  decline_invite: "negotiate", cancel_booking: "negotiate", request_reimbursement: "negotiate", pay_my_share: "pay" };
export const can = (a, tool) => !a?.scopes || a.scopes.includes(NEEDS[tool] || "negotiate");
export const scopeError = (tool) => ({ error: "scope", message: `This agent's token doesn't allow ${NEEDS[tool] || "that"}: its person chose its scopes on the website (Connect).` });

export function makeToken(playerId, label, { scopes = SCOPES, days = 90, key = null } = {}) {
  const secret = `join_${crypto.randomBytes(24).toString("base64url")}`;
  const sc = SCOPES.filter((s) => (Array.isArray(scopes) ? scopes : SCOPES).includes(s));
  const t = { id: `tok_${crypto.randomBytes(4).toString("hex")}`, hash: sha(secret), player: playerId, label: String(label || "My agent").slice(0, 40), created: new Date().toISOString(), lastUsed: null, revoked: false, hint: secret.slice(0, 9),
    scopes: sc.length ? sc : ["read"], expires: new Date(Date.now() + Math.min(365, Math.max(1, +days || 90)) * 864e5).toISOString(), key: validKey(key) };
  db.data.tokens.push(t); db.save();
  return { ...view(t), token: secret };
}
const view = (t) => ({ id: t.id, label: t.label, hint: `${t.hint}…`, created: t.created, lastUsed: t.lastUsed, revoked: t.revoked, scopes: t.scopes || SCOPES, expires: t.expires || null, signed: !!t.key });
// an Ed25519 public key as a JWK's "x" (base64url, 32 bytes), or null
function validKey(k) { const x = typeof k === "string" ? k : k?.x; return typeof x === "string" && Buffer.from(x, "base64url").length === 32 ? x : null; }
export const tokensOf = (playerId) => db.data.tokens.filter((t) => t.player === playerId && !t.revoked && !(t.expires && Date.parse(t.expires) < Date.now())).map(view);
export function revoke(playerId, id) {
  const t = db.data.tokens.find((x) => x.id === id && x.player === playerId);
  if (!t) return false;
  t.revoked = true; db.save(); return true;
}

// the agent behind a request: { player, client } or null
export function agentOf(req) {
  const m = String(req.headers.authorization || "").match(/^Bearer\s+(join_[\w-]+)$/);
  if (!m) return null;
  const t = db.data.tokens.find((x) => x.hash === sha(m[1]) && !x.revoked);
  if (!t) return null;
  const now = Date.now();
  if (t.expires && Date.parse(t.expires) < now) return null;
  if (t.key && !signedBy(req, t.key)) return null;
  if (!t.lastUsed || now - Date.parse(t.lastUsed) > 60e3) { t.lastUsed = new Date(now).toISOString(); db.save(); }
  return { player: t.player, client: t.key ? `${t.label}, signed` : t.label, token: t.id, scopes: t.scopes || SCOPES };
}

// HTTP Message Signatures (RFC 9421), as Web Bot Auth uses them: the request must carry Signature-Input and Signature
// covering at least "@method", "@authority", "@path" and, with a body, "content-digest" (RFC 9530, sha-256 of the exact
// bytes received); created within the last five minutes; alg ed25519; signed by the token's key.
export function signedBy(req, x) {
  const input = String(req.headers["signature-input"] || ""), sigHeader = String(req.headers.signature || "");
  const m = input.match(/^([\w-]+)=\(([^)]*)\)((?:;[\w-]+=(?:"[^"]*"|\d+))*)$/);
  if (!m) return false;
  const label = m[1], fields = [...m[2].matchAll(/"([^"]+)"/g)].map((f) => f[1]), params = Object.fromEntries([...m[3].matchAll(/;([\w-]+)=("([^"]*)"|\d+)/g)].map((p) => [p[1], p[3] ?? +p[2]]));
  const need = ["@method", "@authority", "@path", ...(req.rawBody?.length ? ["content-digest"] : [])];
  if (!need.every((f) => fields.includes(f)) || (params.alg && params.alg !== "ed25519") || !(Math.abs(Date.now() / 1000 - params.created) < 300)) return false;
  if (req.rawBody?.length && req.headers["content-digest"] !== `sha-256=:${crypto.createHash("sha256").update(req.rawBody).digest("base64")}:`) return false;
  const value = (f) => (f === "@method" ? req.method : f === "@authority" ? req.headers.host : f === "@path" ? req.originalUrl.split("?")[0] : f === "@query" ? `?${req.originalUrl.split("?")[1] || ""}` : f.startsWith("@") ? null : req.headers[f]);
  if (fields.some((f) => value(f) == null)) return false;
  const base = [...fields.map((f) => `"${f}": ${value(f)}`), `"@signature-params": (${fields.map((f) => `"${f}"`).join(" ")})${m[3]}`].join("\n");
  const sig = sigHeader.match(new RegExp(`(?:^|,\\s*)${label}=:([A-Za-z0-9+/=]+):`));
  if (!sig) return false;
  try { return crypto.verify(null, Buffer.from(base), crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" }), Buffer.from(sig[1], "base64")); } catch { return false; }
}

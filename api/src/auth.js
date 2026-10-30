// Who is asking.
//   People sign in on the website. The demo signs in by picking a player (DEMO_SIGNIN, on unless set to 0); a real
//   deployment puts its own login in front of createSession. A session is an HttpOnly cookie.
//   Agents use a personal token the person made on the website ("Connect your agent"): Bearer join_..., kept only as a
//   SHA-256 hash, named after the agent it was made for, revocable, and scoped to that one player. A token can do what
//   the player's agent should do (search, negotiate, pay their share within their mandate) and nothing else: it can't
//   change the mandate, make other tokens or save a payment method. Those need the person's session.
import crypto from "node:crypto";
import { store } from "./store.js";
import { player } from "./world.js";

const db = store(process.env.TOKENS_FILE || null, { tokens: [] });
export const tokensStore = db;
const sessions = new Map();
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
export const COOKIE = "join_session";

export function createSession(playerId) {
  if (!player(playerId)) return null;
  const sid = crypto.randomBytes(24).toString("base64url");
  sessions.set(sid, { player: playerId, at: Date.now() });
  return sid;
}
export const endSession = (sid) => sessions.delete(sid);
const cookie = (req, k) => (req.headers.cookie || "").split(/;\s*/).map((c) => c.split("=")).find(([n]) => n === k)?.[1];
export function sessionOf(req) { const s = sessions.get(cookie(req, COOKIE) || ""); return s ? { player: s.player, sid: cookie(req, COOKIE) } : null; }

export function makeToken(playerId, label) {
  const secret = `join_${crypto.randomBytes(24).toString("base64url")}`;
  const t = { id: `tok_${crypto.randomBytes(4).toString("hex")}`, hash: sha(secret), player: playerId, label: String(label || "My agent").slice(0, 40), created: new Date().toISOString(), lastUsed: null, revoked: false, hint: secret.slice(0, 9) };
  db.data.tokens.push(t); db.save();
  return { ...view(t), token: secret };
}
const view = (t) => ({ id: t.id, label: t.label, hint: `${t.hint}…`, created: t.created, lastUsed: t.lastUsed, revoked: t.revoked });
export const tokensOf = (playerId) => db.data.tokens.filter((t) => t.player === playerId && !t.revoked).map(view);
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
  if (!t.lastUsed || now - Date.parse(t.lastUsed) > 60e3) { t.lastUsed = new Date(now).toISOString(); db.save(); }
  return { player: t.player, client: t.label, token: t.id };
}

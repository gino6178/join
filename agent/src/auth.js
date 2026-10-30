// Who may use the gateway.
//   AGENT_TOKEN set: every API call (/api/*, except /api/status) and every JSON-RPC request to a member's agent needs
//   "Authorization: Bearer <token>". The Agent Cards and the agent directory stay public (a card is how another agent
//   learns that it needs the token), and the Messenger webhook has its own signature.
//   A member's agent also answers only requests from this machine, unless A2A_PUBLIC=1.
//   Without AGENT_TOKEN the API answers this machine only (AGENT_OPEN=1 opens it to the network), and the gateway says so.
// Either way, a request from a web page that is not one of ALLOW_ORIGINS is refused, and so is a POST a page could send
// without asking first (a form or text/plain body), so no other site can drive the gateway through a player's browser.
import crypto from "node:crypto";

// (quotes and spaces around the value in .env are not part of it, as Vite reads web/.env.local)
const token = () => String(process.env.AGENT_TOKEN || "").trim().replace(/^(["'])(.*)\1$/, "$2");
const digest = (s) => crypto.createHash("sha256").update(s).digest();
export const required = () => !!token();
export function authorized(req) {
  const t = token();
  if (!t) return true;
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || "");
  return !!m && crypto.timingSafeEqual(digest(m[1]), digest(t));
}
export const loopback = (req) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket?.remoteAddress);
// the gateway's own requests to the members' agents: the token goes to this gateway's own address only (A2A_SELF,
// set by server.js), never to an agent on another server, which may be anyone's
const origins = () => String(process.env.A2A_SELF || "").split(",").filter(Boolean).map((u) => { try { return new URL(u).origin; } catch { return null; } }).filter(Boolean);
export function authHeader(url) {
  if (!token()) return {};
  try { return origins().includes(new URL(url).origin) ? { authorization: `Bearer ${token()}` } : {}; } catch { return {}; }
}
// content types a page can POST across origins without a preflight (the Fetch standard's "CORS-safelisted" ones)
const SIMPLE = /^(text\/plain|application\/x-www-form-urlencoded|multipart\/form-data)\b/i;
export function crossSite(req, origins) {
  const o = req.headers.origin;
  if (o && !origins.includes(o)) return `requests from ${o} are not allowed`; // a page elsewhere, whatever the method
  if (req.method === "POST" && SIMPLE.test(req.headers["content-type"] || "")) return "send JSON (content-type application/json) or the file's own type";
  return null;
}
// without a token, the API answers this machine only, unless AGENT_OPEN=1 says the network may use it as it is
// (a request that came through a proxy or a tunnel on this machine is not this machine's: it carries forwarding headers)
const forwarded = (req) => ["forwarded", "x-forwarded-for", "x-real-ip", "cf-connecting-ip"].some((h) => req.headers?.[h]);
export const openTo = (req) => required() || (loopback(req) && !forwarded(req)) || process.env.AGENT_OPEN === "1";

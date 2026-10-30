// Signing in with an account people already have: Google, Facebook, LINE or PayPal (the OAuth 2.0 authorization code
// flow, with a state cookie against forged returns). A provider is on when the server has its keys:
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET, FACEBOOK_APP_ID / FACEBOOK_APP_SECRET, LINE_CHANNEL_ID / LINE_CHANNEL_SECRET,
//   and LOGIN_WITH_PAYPAL=1 (Log in with PayPal, with the same sandbox app as payments; turn it on in the app's settings
//   and add the return URL there).
// Each provider's return URL is <PUBLIC_URL>/auth/<provider>/callback. Only the provider's id for the person and the
// name it gives are read (people.js); the provider's token is used once and dropped.
import crypto from "node:crypto";

const env = process.env;
const sandbox = (env.PAYPAL_ENV || "sandbox") !== "live";
export const PROVIDERS = {
  google: { name: "Google", id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET, scope: "openid profile",
    auth: "https://accounts.google.com/o/oauth2/v2/auth", token: "https://oauth2.googleapis.com/token",
    me: "https://openidconnect.googleapis.com/v1/userinfo", who: (u) => [u.sub, u.name] },
  facebook: { name: "Facebook", id: env.FACEBOOK_APP_ID, secret: env.FACEBOOK_APP_SECRET, scope: "public_profile",
    auth: "https://www.facebook.com/v19.0/dialog/oauth", token: "https://graph.facebook.com/v19.0/oauth/access_token",
    me: "https://graph.facebook.com/me?fields=id,name", who: (u) => [u.id, u.name] },
  line: { name: "LINE", id: env.LINE_CHANNEL_ID, secret: env.LINE_CHANNEL_SECRET, scope: "profile",
    auth: "https://access.line.me/oauth2/v2.1/authorize", token: "https://api.line.me/oauth2/v2.1/token",
    me: "https://api.line.me/v2/profile", who: (u) => [u.userId, u.displayName] },
  paypal: { name: "PayPal", id: env.LOGIN_WITH_PAYPAL === "1" ? env.PAYPAL_CLIENT_ID : null, secret: env.PAYPAL_CLIENT_SECRET, scope: "openid profile", basic: true,
    auth: sandbox ? "https://www.sandbox.paypal.com/signin/authorize" : "https://www.paypal.com/signin/authorize",
    token: `https://api-m.${sandbox ? "sandbox." : ""}paypal.com/v1/oauth2/token`,
    me: `https://api-m.${sandbox ? "sandbox." : ""}paypal.com/v1/identity/oauth2/userinfo?schema=paypalv1.1`, who: (u) => [u.user_id || u.payer_id, u.name] },
};
const on = (p) => !!(PROVIDERS[p]?.id && PROVIDERS[p]?.secret);
export const providers = () => Object.entries(PROVIDERS).map(([id, p]) => ({ id, name: p.name, on: on(id) }));

const pending = new Map(); // state -> { provider, at }
export function start(provider, publicUrl) {
  if (!on(provider)) return null;
  const p = PROVIDERS[provider], state = crypto.randomBytes(16).toString("base64url");
  for (const [k, v] of pending) if (Date.now() - v.at > 10 * 60e3) pending.delete(k);
  pending.set(state, { provider, at: Date.now() });
  const q = new URLSearchParams({ response_type: "code", client_id: p.id, redirect_uri: `${publicUrl}/auth/${provider}/callback`, scope: p.scope, state });
  return { url: `${p.auth}?${q}`, state };
}
// the provider sent the person back: check the state, trade the code for a token, ask who they are
export async function finish(provider, { code, state }, cookieState, publicUrl) {
  const s = pending.get(String(state || ""));
  if (!s || s.provider !== provider || state !== cookieState) return { error: "That sign-in didn't start here, or took too long. Try again." };
  pending.delete(state);
  const p = PROVIDERS[provider], redirect = `${publicUrl}/auth/${provider}/callback`;
  const body = new URLSearchParams({ grant_type: "authorization_code", code: String(code || ""), redirect_uri: redirect, ...(p.basic ? {} : { client_id: p.id, client_secret: p.secret }) });
  const t = await fetch(p.token, { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded", ...(p.basic ? { Authorization: `Basic ${Buffer.from(`${p.id}:${p.secret}`).toString("base64")}` } : {}) } });
  const tok = await t.json().catch(() => ({}));
  if (!t.ok || !tok.access_token) return { error: `${p.name} didn't confirm the sign-in.` };
  const u = await (await fetch(p.me, { headers: { Authorization: `Bearer ${tok.access_token}` } })).json().catch(() => ({}));
  const [id, name] = p.who(u);
  return id ? { id: String(id), name } : { error: `${p.name} didn't say who you are.` };
}

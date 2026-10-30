// Join's server: the MCP endpoint and the REST API for players' agents, the website's API for people, PayPal's return
// URLs and webhooks, the venue's A2A endpoint, and the built website. Configure with environment variables
// (api/.env.example). Without PayPal keys it runs against the PayPal stand-in (pay/mock.js) and says so everywhere.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import * as mcp from "./mcp.js";
import * as ops from "./ops.js";
import * as a2a from "./a2a.js";
import * as settle from "./pay/settle.js";
import { paypal } from "./pay/paypal.js";
import { mockPaypal } from "./pay/mock.js";
import { configureToolkit, toolkitMode } from "./pay/toolkit.js";
import { agentOf, sessionOf, createSession, endSession, makeToken, tokensOf, revoke, COOKIE, VENUE_COOKIE, createVenueSession, venueOf, endVenueSession } from "./auth.js";
import { getMandate, setMandate } from "./mandate.js";
import { forPlayer, onActivity } from "./activity.js";
import { getWorld, player, venue, setPolicy } from "./world.js";
import { usd } from "./negotiate/policy.js";
import * as receipts from "./proof/receipts.js";
import { sepoliaAnchor } from "./proof/anchor.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// a small .env reader, so the server needs no package for it
for (const f of [path.join(HERE, "../.env")]) if (fs.existsSync(f)) for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) { const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/); if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }

const PORT = +(process.env.PORT || 8790);
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const DEMO = process.env.DEMO_SIGNIN !== "0";
const real = process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET && process.env.PAYPAL_MODE !== "mock";
const pp = real ? paypal({ clientId: process.env.PAYPAL_CLIENT_ID, secret: process.env.PAYPAL_CLIENT_SECRET, testCard: process.env.PAYPAL_TEST_CARD === "1" }) : mockPaypal({ publicUrl: PUBLIC_URL });
settle.configure({ paypal: pp, url: PUBLIC_URL });
// the back office's PayPal Agent Toolkit uses the same app (or, without keys, the stand-in's records)
configureToolkit(real ? { token: () => pp.accessToken() } : { standIn: (m, a) => pp.toolkit(m, a) });
// PayPal's webhooks: Join subscribes itself when it has a public HTTPS address (PayPal only delivers to port 443)
const EVENTS = ["CHECKOUT.ORDER.APPROVED", "PAYMENT.AUTHORIZATION.CREATED", "PAYMENT.AUTHORIZATION.VOIDED", "PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.DECLINED", "PAYMENT.CAPTURE.PENDING", "PAYMENT.CAPTURE.REFUNDED",
  "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", "PAYMENT.PAYOUTS-ITEM.UNCLAIMED", "PAYMENT.PAYOUTS-ITEM.RETURNED", "PAYMENT.PAYOUTS-ITEM.FAILED", "INVOICING.INVOICE.PAID", "CUSTOMER.DISPUTE.CREATED", "VAULT.PAYMENT-TOKEN.CREATED"];
if (real && PUBLIC_URL.startsWith("https://") && !process.env.PAYPAL_WEBHOOK_ID)
  pp.ensureWebhook(`${PUBLIC_URL}/paypal/webhook`, EVENTS).then((w) => { process.env.PAYPAL_WEBHOOK_ID = w.id; console.log(`PayPal webhook ${w.created ? "created" : "found"}: ${w.id}`); }).catch((e) => console.error("webhook setup", e.message));

const app = express();
app.disable("x-powered-by");
// PayPal's webhook needs the body exactly as sent, for its signature check
app.post("/paypal/webhook", express.raw({ type: "*/*", limit: "256kb" }), async (req, res) => {
  const raw = req.body.toString("utf8");
  try {
    const ok = !process.env.PAYPAL_WEBHOOK_ID && !real ? true : await pp.verifyWebhook(req.headers, raw, process.env.PAYPAL_WEBHOOK_ID);
    if (!ok) return res.status(400).end();
    await settle.webhook(JSON.parse(raw));
  } catch (e) { console.error("webhook", e.message); }
  res.status(200).end();
});
app.use(express.json({ limit: "64kb" }));

// Rate limits: a fixed window per caller (the agent's token when there is one, else the address). Agents get room for a
// busy negotiation; signing in and making tokens get less.
const windows = new Map();
function limit(per, max) {
  return (req, res, next) => {
    const who = `${per}:${(req.headers.authorization || "").slice(-16) || req.ip}`, now = Date.now(), w = windows.get(who);
    if (!w || now - w.start > 60e3) { windows.set(who, { start: now, n: 1 }); return next(); }
    if (++w.n > max) return res.status(429).set("Retry-After", String(Math.ceil((w.start + 60e3 - now) / 1000))).json({ error: "rate_limited", message: `More than ${max} requests a minute. Slow down.` });
    next();
  };
}
setInterval(() => { const now = Date.now(); for (const [k, w] of windows) if (now - w.start > 60e3) windows.delete(k); }, 60e3).unref();
app.use(["/mcp", "/api/agent", "/a2a"], limit("agent", +(process.env.AGENT_RPM || 120)));
app.use(["/api/session", "/api/venue-session", "/api/tokens"], limit("people", 30));

// ---- agents -------------------------------------------------------------------------------------------------------
app.all("/mcp", (req, res) => mcp.handle(req, res).catch((e) => { console.error("mcp", e); if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "internal error" }, id: null }); }));

// the same tools as plain REST, for agents and scripts that don't speak MCP: POST /api/agent/<tool> with JSON arguments
const TOOLS = { whoami: ops.whoami, list_activities: () => ops.listActivities(), list_venues: (a, x) => ops.listVenues(x), find_options: ops.findOptions, start_negotiation: ops.startNegotiation, make_offer: ops.makeOffer, accept_price: ops.acceptPrice,
  walk_away: ops.walkAway, find_alternatives: ops.findAlternatives, my_plans: (a, x) => ops.myGames(a, x), booking_status: ops.gameStatus, pay_my_share: ops.payMyShare, decline_invite: ops.declineGame, cancel_booking: ops.cancelBooking,
  propose_share: ops.proposeShare, answer_share: ops.answerShare, request_reimbursement: ops.requestReimbursement };
app.post("/api/agent/:tool", async (req, res) => {
  const a = agentOf(req);
  if (!a) return res.status(401).json({ error: "unauthorized", message: "Send a player's agent token: Authorization: Bearer join_..." });
  const fn = TOOLS[req.params.tool];
  if (!fn) return res.status(404).json({ error: "unknown_tool", tools: Object.keys(TOOLS) });
  try { const r = await fn(a, req.body || {}); res.status(r?.error ? 400 : 200).json(r); } catch (e) { console.error(e); res.status(500).json({ error: "internal" }); }
});

app.get("/.well-known/agent-card.json", (req, res) => res.json(a2a.card(PUBLIC_URL)));
app.post("/a2a", (req, res) => a2a.handle(req, res));

// ---- people: the website's API ----------------------------------------------------------------------------------------
const signedIn = (req, res, next) => { const s = sessionOf(req); if (!s) return res.status(401).json({ error: "signed_out" }); req.player = s.player; req.sid = s.sid; next(); };
app.get("/api/info", (req, res) => res.json({ timeZone: getWorld().town.timeZone, demoSignin: DEMO, paypal: pp.mode, publicUrl: PUBLIC_URL, mcpUrl: `${PUBLIC_URL}/mcp` }));
app.get("/api/world", (req, res) => {
  const w = getWorld();
  res.json({ town: w.town, currency: w.currency, note: w.note,
    activities: w.activities,
    venues: w.venues.map((v) => ({ id: v.id, name: v.name, area: v.area, x: v.x, y: v.y, open: v.open, offers: v.offers, style: v.policy.style })),
    players: w.players.map((p) => ({ id: p.id, name: p.name, level: p.level, area: p.area, interests: p.interests })), publicPlaces: w.publicPlaces });
});
app.post("/api/session", (req, res) => {
  if (!DEMO) return res.status(403).json({ error: "demo sign-in is off" });
  const sid = createSession(String(req.body?.player || ""));
  if (!sid) return res.status(400).json({ error: "unknown player" });
  res.set("Set-Cookie", `${COOKIE}=${sid}; HttpOnly; SameSite=Lax; Path=/`).json({ ok: true });
});
// one-click demo sign-in for judges and screenshots: /demo?as=you&go=activity (demo mode only)
app.get("/demo", (req, res) => {
  if (!DEMO) return res.status(403).end();
  const sid = createSession(String(req.query.as || "you"));
  if (!sid) return res.status(400).send("unknown player");
  const go = String(req.query.go || "activity").replace(/[^\w/?=&.-]/g, "");
  res.set("Set-Cookie", `${COOKIE}=${sid}; HttpOnly; SameSite=Lax; Path=/`).redirect(`/#/${go}`);
});
app.delete("/api/session", signedIn, (req, res) => { endSession(req.sid); res.set("Set-Cookie", `${COOKIE}=; Max-Age=0; Path=/`).json({ ok: true }); });
app.get("/api/me", signedIn, (req, res) => { const p = player(req.player), m = getMandate(req.player); res.json({ player: { id: p.id, name: p.name, area: p.area, interests: p.interests, free: p.free }, mandate: { ...m, perGameUsd: usd(m.perGame), perWeekUsd: usd(m.perWeek) }, vault: settle.hasVault(req.player), tokens: tokensOf(req.player) }); });
app.put("/api/mandate", signedIn, (req, res) => { const r = setMandate(req.player, req.body || {}); res.status(r.error ? 400 : 200).json(r); });
app.post("/api/tokens", signedIn, (req, res) => res.json(makeToken(req.player, req.body?.label)));
app.delete("/api/tokens/:id", signedIn, (req, res) => res.json({ ok: revoke(req.player, req.params.id) }));
app.get("/api/activity", signedIn, (req, res) => res.json({ entries: forPlayer(req.player, { after: +req.query.after || 0 }) }));
app.get("/api/games", signedIn, (req, res) => res.json(ops.myGames({ player: req.player }, { all: true })));
// the person can do from the website what their agent can (approving payments is in PayPal itself)
app.post("/api/bookings/:id/:act", signedIn, async (req, res) => {
  const a = { player: req.player, client: null }, act = { pay: ops.payMyShare, decline: ops.declineGame, cancel: ops.cancelBooking, "propose-share": ops.proposeShare, "answer-share": ops.answerShare, "reimburse": ops.requestReimbursement }[req.params.act];
  if (!act) return res.status(404).end();
  const r = await act(a, { ...(req.body || {}), booking: req.params.id }); res.status(r.error ? 400 : 200).json(r);
});
// the JS SDK v6 on the website: a browser-safe token, and the payer's own approval coming back from the PayPal popup
app.get("/api/paypal/sdk", signedIn, async (req, res) => {
  if (!pp.clientToken) return res.json({ mode: pp.mode, token: null });
  try { res.json({ mode: pp.mode, ...(await pp.clientToken()) }); } catch (e) { res.status(502).json({ error: "paypal", message: e.message }); }
});
app.post("/api/bookings/:id/approved", signedIn, async (req, res) => { const r = await settle.approved(req.params.id, req.player); res.status(r?.error ? 400 : 200).json(r); });
app.post("/api/vault", signedIn, async (req, res) => { try { res.json(await settle.vaultStart(req.player)); } catch (e) { res.status(502).json({ error: "paypal", message: e.message }); } });
app.delete("/api/vault", signedIn, (req, res) => { setMandate(req.player, { autopay: false }); res.json(settle.vaultForget(req.player)); });
// ---- venues: their own policy -----------------------------------------------------------------------------------------
app.post("/api/venue-session", (req, res) => {
  if (!DEMO) return res.status(403).json({ error: "demo sign-in is off" });
  if (!venue(String(req.body?.venue || ""))) return res.status(400).json({ error: "unknown venue" });
  res.set("Set-Cookie", `${VENUE_COOKIE}=${createVenueSession(req.body.venue)}; HttpOnly; SameSite=Lax; Path=/`).json({ ok: true });
});
app.delete("/api/venue-session", (req, res) => { const s = venueOf(req); if (s) endVenueSession(s.sid); res.set("Set-Cookie", `${VENUE_COOKIE}=; Max-Age=0; Path=/`).json({ ok: true }); });
const venueStaff = (req, res, next) => { const s = venueOf(req); if (!s || s.venue !== req.params.id) return res.status(401).json({ error: "signed_out", message: "Sign in as this venue." }); next(); };
app.get("/api/venue-me", (req, res) => { const s = venueOf(req); res.json({ venue: s?.venue || null }); });
// (only the venue's own staff see its floor)
app.get("/api/venues/:id/policy", venueStaff, (req, res) => res.json({ venue: req.params.id, policy: venue(req.params.id).policy }));
app.put("/api/venues/:id/policy", venueStaff, (req, res) => { const r = setPolicy(req.params.id, req.body || {}); res.status(r.error ? 400 : 200).json(r); });
// the venue's money, through the PayPal Agent Toolkit: reconciliation, extras, disputes
app.get("/api/venues/:id/reconcile", venueStaff, async (req, res) => res.json(await settle.reconcileVenue(req.params.id)));
app.post("/api/venues/:id/bookings/:booking/extras", venueStaff, async (req, res) => { try { const r = await settle.billExtras(req.params.id, req.params.booking, req.body?.items); res.status(r.error ? 400 : 200).json(r); } catch (e) { res.status(502).json({ error: "paypal", message: e.message }); } });
app.get("/api/venues/:id/disputes", venueStaff, async (req, res) => { try { res.json({ toolkit: toolkitMode(), disputes: await settle.venueDisputes(req.params.id) }); } catch (e) { res.status(502).json({ error: "paypal", message: e.message }); } });
app.post("/api/venues/:id/disputes/:dispute/answer", venueStaff, async (req, res) => { try { const r = await settle.answerDispute(req.params.id, req.params.dispute); res.status(r.error ? 400 : 200).json(r); } catch (e) { res.status(502).json({ error: "paypal", message: e.message }); } });
// (stand-in only) open a dispute on a capture, as a buyer would, to try the flow
app.post("/api/demo/dispute", (req, res) => { if (pp.mode !== "mock") return res.status(404).end(); const d = pp.openDispute(String(req.body?.capture || "")); if (!d) return res.status(400).json({ error: "no such capture" }); settle.webhook({ event_type: "CUSTOMER.DISPUTE.CREATED", resource: d }).then(() => res.json(d)); });
app.get("/api/venues/:id/schedule", (req, res) => res.json({ venue: req.params.id, bookings: settle.forVenue(req.params.id) }));
// live activity for the signed-in player (server-sent events)
app.get("/api/activity/stream", signedIn, (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" }).flushHeaders();
  const off = onActivity((e) => { if (e.who.includes(req.player)) res.write(`data: ${JSON.stringify(e)}\n\n`); });
  const ping = setInterval(() => res.write(": ping\n\n"), 25e3);
  req.on("close", () => { off(); clearInterval(ping); });
});

// ---- verifiable receipts ----------------------------------------------------------------------------------------------------
const anchor = sepoliaAnchor();
app.get("/.well-known/join-receipts.json", (req, res) => res.json({ keys: [receipts.publicKey()], chain: anchor ? { name: "sepolia", chainId: 11155111, from: anchor.address, data: "0x4a4f494e<root>" } : null }));
app.get("/api/receipts/:id", (req, res) => { const r = receipts.show(req.params.id, sessionOf(req)?.player); r ? res.json(r) : res.status(404).json({ error: "no such receipt" }); });
// (the demo can close a batch now instead of waiting for the next one)
app.post("/api/receipts/batch", async (req, res) => { if (!DEMO) return res.status(403).end(); res.json(await receipts.batch(anchor)); });
setInterval(() => receipts.batch(anchor).then(() => receipts.retry(anchor)).catch((e) => console.error("anchor", e.message)), +(process.env.ANCHOR_MS || 10 * 60e3)).unref();

// ---- PayPal comes back here -------------------------------------------------------------------------------------------
app.get("/paypal/return", async (req, res) => {
  try { await settle.approved(String(req.query.booking), String(req.query.player)); } catch (e) { console.error("return", e.message); }
  res.redirect(`/#/games?booking=${encodeURIComponent(String(req.query.booking))}`);
});
app.get("/paypal/cancel", (req, res) => res.redirect(`/#/games?booking=${encodeURIComponent(String(req.query.booking))}&cancelled=1`));
app.get("/paypal/vault-return", async (req, res) => {
  const setup = String(req.query.approval_token_id || req.query.setup || req.query.token || "");
  try { await settle.vaultFinish(setup); } catch (e) { console.error("vault", e.message); }
  res.redirect("/#/limits?saved=1");
});

// ---- the PayPal stand-in's approval page (mock mode only) --------------------------------------------------------------
if (pp.mode === "mock") {
  const page = (body) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PayPal (simulated)</title><style>body{font:16px system-ui;background:#f5f7fa;margin:0;display:grid;place-items:center;min-height:100vh}.c{background:#fff;padding:32px;border-radius:16px;box-shadow:0 8px 30px #0001;max-width:380px;width:calc(100% - 32px)}h1{font-size:20px;margin:0 0 4px}.n{color:#a15c00;background:#fff4e0;padding:8px 12px;border-radius:8px;font-size:13px;margin:12px 0 20px}button{font:inherit;width:100%;padding:12px;border-radius:999px;border:0;margin-top:8px;cursor:pointer}.y{background:#0070e0;color:#fff;font-weight:600}.x{background:#eee}</style><div class="c">${body}</div>`;
  app.get("/mock-paypal/approve", (req, res) => {
    const d = pp.describe({ token: req.query.token, setup: req.query.setup, invoice: req.query.invoice });
    if (!d) return res.status(404).send(page("<h1>Unknown payment</h1>"));
    const what = d.kind === "invoice" ? `Pay invoice: <b>$${usd(d.amount)}</b> for ${d.reference}` : d.kind === "order" ? `Authorize <b>$${usd(d.amount)}</b> for ${String(d.reference).split(":")[0]}` : "Save PayPal so your Join agent can pay your share within your limits";
    res.send(page(`<h1>PayPal</h1><p>${what}</p><p class="n">Simulated PayPal: Join is running without sandbox keys. No money moves.</p><form method="post"><button class="y" name="a" value="yes">Agree and continue</button><button class="x" name="a" value="no">Cancel</button></form>`));
  });
  app.post("/mock-paypal/approve", express.urlencoded({ extended: false }), (req, res) => {
    const { token, setup, invoice } = req.query, yes = req.body?.a === "yes";
    if (yes) pp.approve({ token, setup, invoice });
    if (invoice) return res.redirect("/#/games");
    if (setup) return res.redirect(yes ? `/paypal/vault-return?setup=${setup}` : "/#/limits");
    for (const b of settle.bookingsStore.data.bookings) for (const [pid, p] of Object.entries(b.payments)) if (p.orderId === token) return res.redirect(yes ? `/paypal/return?booking=${b.id}&player=${pid}` : `/paypal/cancel?booking=${b.id}&player=${pid}`);
    res.redirect("/");
  });
}

// ---- the website ----------------------------------------------------------------------------------------------------------
const WEB = path.join(HERE, "../../web/dist");
if (fs.existsSync(WEB)) { app.use(express.static(WEB)); app.get(/^\/(?!api|mcp|paypal|a2a|mock-paypal).*/, (req, res) => res.sendFile(path.join(WEB, "index.html"))); }

setInterval(() => settle.tick().catch((e) => console.error("tick", e.message)), +(process.env.TICK_MS || 5000)).unref();
app.listen(PORT, () => console.log(`Join on ${PUBLIC_URL}  (PayPal: ${pp.mode}; MCP: ${PUBLIC_URL}/mcp; receipts anchored on: ${anchor ? `Sepolia from ${anchor.address}` : "nothing yet (set ANCHOR_RPC_URL and ANCHOR_PRIVATE_KEY)"}; demo sign-in: ${DEMO ? "on" : "off"})`));

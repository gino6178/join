// Join's server: the MCP endpoint and the REST API for players' agents, the website's API for people, PayPal's return
// URLs and webhooks, the venue's A2A endpoint, and the built website. Configure with environment variables
// (api/.env.example). Without PayPal keys it runs against the PayPal stand-in (pay/mock.js) and says so everywhere.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import * as mcp from "./mcp.js";
import * as oauth from "./oauth.js";
import * as people from "./people.js";
import { geocode, places as osmPlaces, address as osmAddress } from "./osm.js";
import { REAL } from "./world.js";
import { agentGuide } from "./guide.js";
import * as ops from "./ops.js";
import * as a2a from "./a2a.js";
import * as settle from "./pay/settle.js";
import { paypal } from "./pay/paypal.js";
import { mockPaypal } from "./pay/mock.js";
import { configureToolkit, toolkitMode } from "./pay/toolkit.js";
import { invitePass, onInvitePass, passHolder } from "./auth.js";
import { agentOf, sessionOf, createSession, endSession, makeToken, tokensOf, revoke, can, scopeError, COOKIE, VENUE_COOKIE, createVenueSession, venueOf, endVenueSession } from "./auth.js";
import { getMandate, setMandate } from "./mandate.js";
import { forPlayer, onActivity, record as recordActivity, demoScope, demand as demandFor } from "./activity.js";
import { getWorld, player, venue, setPolicy, registerVenue, partnersStore } from "./world.js";
import { usd } from "./negotiate/policy.js";
import * as receipts from "./proof/receipts.js";
import * as scout from "./scout/understand.js";
import * as ap2 from "./proof/mandates.js";
import * as reviews from "./reviews.js";
import { negotiationsStore } from "./negotiate/engine.js";
import * as neg from "./negotiate/engine.js";
import { mandatesStore } from "./mandate.js";
import { activityStore } from "./activity.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// a small .env reader, so the server needs no package for it
for (const f of [path.join(HERE, "../.env")]) if (fs.existsSync(f)) for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) { const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/); if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }

const PORT = +(process.env.PORT || 8790);
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const DEMO = process.env.DEMO_SIGNIN !== "0";
const real = process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET && process.env.PAYPAL_MODE !== "mock";
const pp = real ? paypal({ clientId: process.env.PAYPAL_CLIENT_ID, secret: process.env.PAYPAL_CLIENT_SECRET, testCard: process.env.PAYPAL_TEST_CARD === "1" }) : mockPaypal({ publicUrl: PUBLIC_URL });
settle.configure({ paypal: pp, url: PUBLIC_URL });
settle.allowEarlyReviews(DEMO);
ap2.setIssuer(PUBLIC_URL);
receipts.setOrigin(process.env.LOG_ORIGIN || `${new URL(PUBLIC_URL).host}/join-receipts`);
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
// (the exact bytes are kept too, for a signed agent's Content-Digest)
app.use(express.json({ limit: "64kb", verify: (req, res, buf) => { req.rawBody = buf; } }));
// (who is around: their agent or their session, for matching strangers who will answer)
app.use((req, res, next) => { try { people.saw(sessionOf(req)?.player || (req.headers.authorization ? agentOf(req)?.player : null)); } catch {} next(); });

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
// an invite pass in the address, for MCP clients that can't set a header: /mcp/g/<pass>
// the person behind an invite pass, on the website: their agent gives them /me/<pass> to see their plans and set limits
app.get("/me/:pass", (req, res) => { const a = passHolder(req.params.pass, req); if (!a) return res.status(404).send("This link isn't valid."); res.set("Set-Cookie", `${COOKIE}=${createSession(a.player)}; HttpOnly; SameSite=Lax; Path=/`).redirect("/#/activity"); });
app.all("/mcp/g/:pass", (req, res, next) => { req.headers.authorization = `Bearer ${req.params.pass}`; req.url = "/mcp"; next(); });
app.all("/mcp", (req, res) => mcp.handle(req, res).catch((e) => { console.error("mcp", e); if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "internal error" }, id: null }); }));

// the same tools as plain REST, for agents and scripts that don't speak MCP: POST /api/agent/<tool> with JSON arguments
const TOOLS = { whoami: ops.whoami, list_activities: () => ops.listActivities(), list_venues: (a, x) => ops.listVenues(x), find_options: (a, x) => ops.findOptionsLive(a, x), set_home: (a, x) => ops.setHome(a, x), start_negotiation: ops.startNegotiation, make_offer: (a, x) => ops.afterDeal(a, ops.makeOffer(a, x)), accept_price: (a, x) => ops.afterDeal(a, ops.acceptPrice(a, x)),
  walk_away: ops.walkAway, find_alternatives: ops.findAlternatives, my_plans: (a, x) => ops.myGames(a, x), wait_for_news: (a, x) => ops.waitForNews(a, x), booking_status: ops.gameStatus, pay_my_share: ops.payMyShare, decline_invite: ops.declineGame, cancel_booking: ops.cancelBooking,
  propose_share: ops.proposeShare, answer_share: ops.answerShare, request_reimbursement: ops.requestReimbursement, venue_reviews: (a, x) => ops.venueReviews(a, x) };
app.post("/api/agent/:tool", async (req, res) => {
  const a = agentOf(req);
  if (!a) return res.status(401).json({ error: "unauthorized", message: "Send a player's agent token: Authorization: Bearer join_..." });
  const fn = TOOLS[req.params.tool];
  if (!fn) return res.status(404).json({ error: "unknown_tool", tools: Object.keys(TOOLS) });
  if (!can(a, req.params.tool)) return res.status(403).json(scopeError(req.params.tool));
  try { const r = await fn(a, req.body || {}); res.status(r?.error ? 400 : 200).json(r); } catch (e) { console.error(e); res.status(500).json({ error: "internal" }); }
});

app.get("/.well-known/mcp-tools.json", (req, res) => res.json({ ...mcp.toolsManifest(), about: "SHA-256 over the canonical JSON of the instructions and tools; the MCP server's version ends in its first 16 hex digits. Pin it." }));
app.get("/.well-known/agent-card.json", (req, res) => res.json(a2a.card(PUBLIC_URL)));
app.post("/a2a", (req, res) => a2a.handle(req, res));

// ---- people: the website's API ----------------------------------------------------------------------------------------
const signedIn = (req, res, next) => { const s = sessionOf(req); if (!s) return res.status(401).json({ error: "signed_out" }); req.player = s.player; req.sid = s.sid; next(); };
app.get("/api/info", (req, res) => res.json({ timeZone: getWorld().town.timeZone, demoSignin: DEMO, paypal: pp.mode, publicUrl: PUBLIC_URL, mcpUrl: `${PUBLIC_URL}/mcp`, scout: scout.qwenOn() ? scout.MODEL : "rules" }));
app.get("/api/world", (req, res) => {
  const w = getWorld(), me = sessionOf(req)?.player;
  // (in real mode, the people you may see: you, your crew, and whoever shares a plan with you; never everyone)
  const shown = REAL ? new Set([me, ...people.crewmates(player(me)).map((x) => x.id), ...settle.mine(me, { all: true }).flatMap((b) => b.players), ...neg.mine(me, { all: true }).flatMap((n) => n.players)].filter(Boolean)) : null;
  res.json({ town: w.town, currency: w.currency, note: w.note, real: REAL,
    activities: w.activities,
    venues: w.venues.map((v) => ({ id: v.id, name: v.name, area: v.area, x: v.x, y: v.y, ...(v.lat != null ? { lat: v.lat, lon: v.lon } : {}), open: v.open, offers: v.offers, style: v.policy.style, ...(v.partner ? { partner: true } : {}) })),
    players: w.players.filter((p) => !shown || shown.has(p.id)).map((p) => ({ id: p.id, name: p.name, level: p.level, area: p.area, interests: p.interests, ...(p.joined ? { joined: true } : {}) })), publicPlaces: w.publicPlaces });
});
// Real places near the signed-in person for an activity (OpenStreetMap), for the map: not on Join, suggestions only
app.get("/api/places", signedIn, async (req, res) => {
  const me = player(req.player);
  if (!me?.geo) return res.json({ places: [], note: "Set where you live to see real places near you." });
  res.json({ places: await osmPlaces(String(req.query.activity || "badminton"), me.geo, 4, { waitMs: 12e3 }), source: "OpenStreetMap (ODbL)", onJoin: false });
});
// A venue registers itself: its name, its real address (looked up) or location, hours, what it offers and prices. It
// becomes bookable on Join (haggling by the default rules, which it then changes in Venue view) and its staff are
// signed in. (Demo: anyone may register a venue; a real deployment would check the business.)
app.post("/api/venues/register", limit("signin", 30), async (req, res) => {
  const b = req.body || {};
  let { lat, lon } = b;
  if ((lat == null || lon == null) && b.address) { const g = await geocode(String(b.address)); if (!g) return res.status(400).json({ error: "not_found", message: "That address wasn't found on OpenStreetMap." }); ({ lat, lon } = g); }
  const v = registerVenue({ ...b, lat, lon, address: b.address || (await osmAddress(lat, lon)) || "" });
  if (v.error) return res.status(400).json(v);
  res.set("Set-Cookie", `${VENUE_COOKIE}=${createVenueSession(v.id)}; HttpOnly; SameSite=Lax; Path=/`).json({ ok: true, venue: { id: v.id, name: v.name, lat: v.lat, lon: v.lon, offers: v.offers } });
});
app.post("/api/session", (req, res) => {
  if (!DEMO) return res.status(403).json({ error: "demo sign-in is off" });
  const sid = createSession(String(req.body?.player || ""));
  if (!sid) return res.status(400).json({ error: "unknown player" });
  res.set("Set-Cookie", `${COOKIE}=${sid}; HttpOnly; SameSite=Lax; Path=/`).json({ ok: true });
});
// Sign-in with an account people have (Google, Facebook, LINE, PayPal: whichever has keys here, oauth.js), or a new
// demo account with just a name. Either way the person joins the town (people.js) and gets the usual session cookie.
app.get("/api/auth/providers", (req, res) => res.json({ providers: oauth.providers(), demo: DEMO, real: REAL, areas: REAL ? [] : people.districts() }));
// a place someone typed, looked up on OpenStreetMap (for the sign-up page, where a plain-http browser won't share its location)
app.get("/api/geocode", limit("signin", 30), async (req, res) => { const g = await geocode(String(req.query.q || "")); g ? res.json(g) : res.status(404).json({ error: "not_found" }); });
// the signed-in person sets their home, or whether people nearby may invite them
app.post("/api/home", signedIn, async (req, res) => { const r = await ops.setHome({ player: req.player }, req.body || {}); res.status(r.error ? 400 : 200).json(r); });
app.post("/api/auth/demo", limit("signin", 30), async (req, res) => {
  if (!DEMO) return res.status(403).json({ error: "demo accounts are off" });
  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "name", message: "Give a first name for the demo account." });
  let { lat, lon } = req.body || {}, label = req.body?.place || null;
  if ((lat == null || lon == null) && label) { const g = await geocode(String(label)); if (g) ({ lat, lon } = g); else return res.status(400).json({ error: "not_found", message: `No place called "${label}" found: try a neighbourhood, a station or a landmark.` }); }
  const p = people.demoPerson(name, { area: req.body?.area, crew: req.body?.crew, lat, lon, label, nearby: req.body?.nearby === true }), sid = createSession(p.id);
  res.set("Set-Cookie", `${COOKIE}=${sid}; HttpOnly; SameSite=Lax; Path=/`).json({ ok: true, player: { id: p.id, name: p.name, area: p.area.name, ...(p.crew ? { crew: p.crew, crewmates: people.crewmates(p).map((x) => ({ id: x.id, name: x.name })) } : {}) } });
});
// Crews, by invite link. Someone signed in (on the website, or their agent with a token) gets their crew's link,
// making a crew if they have none; a friend opens it. A browser gets the sign-up page with the crew filled in; an agent
// gets JSON saying how to join for its person. Someone already on Join joins with POST /api/crew/join.
const personOf = (req) => sessionOf(req)?.player || agentOf(req)?.player || null;
onInvitePass((crew, nonce, name) => people.personFor("invite", nonce, name || "Friend", { crew }));
const crewLink = (req, code) => `${req.protocol}://${req.headers.host}/j/${code}`;
app.post("/api/crew", (req, res) => {
  const me = personOf(req);
  if (!me) return res.status(401).json({ error: "sign_in", message: "Sign in (or send your person's agent token) to invite friends." });
  const code = people.crewOf(me, { create: true });
  if (!code) return res.status(400).json({ error: "resident", message: "The demo town's residents don't have crews: make your own account to invite friends." });
  res.json({ code, link: crewLink(req, code), members: people.crewNames(code), note: "Send this link to friends. Opening it on the website signs them up in your crew; an agent gets JSON saying how to join." });
});
app.post("/api/crew/join", (req, res) => {
  const me = personOf(req), code = String(req.body?.code || "").replace(/^.*\/j\//, "");
  if (!me) return res.status(401).json({ error: "sign_in", message: "Sign in, or send your person's agent token." });
  if (!people.crewSize(code)) return res.status(404).json({ error: "no_crew", message: "No crew with that code." });
  const p = people.joinCrew(me, code);
  if (!p) return res.status(400).json({ error: "resident", message: "The demo town's residents can't join crews." });
  res.json({ ok: true, crew: p.crew, members: people.crewNames(p.crew) });
});
app.get("/j/:code", (req, res) => {
  const code = String(req.params.code).toLowerCase().replace(/[^a-z0-9_-]/g, ""), n = people.crewSize(code);
  if (!n) return res.status(404).type(req.accepts(["html", "json"]) === "json" ? "json" : "html").send(req.accepts(["html", "json"]) === "json" ? { error: "no_crew" } : "This invite link isn't valid any more.");
  if (req.accepts(["html", "json"]) === "html") return res.redirect(`/#/?crew=${code}`);
  const u = `${req.protocol}://${req.headers.host}`, pass = invitePass(code);
  res.json({ crew: code, agent: { noSignUp: "Act for your person right away: no account, password or sign-up. Use this pass as your token; the first call adds your person to the crew (send X-Join-Name: <their first name>, or ?name= on the MCP address). It may read, negotiate and pay within your person's default limits, which only they can change.",
      mcp: `${u}/mcp/g/${pass}`, bearer: pass, rest: `POST ${u}/api/agent/<tool> with Authorization: Bearer <bearer>`, a2a: `${u}/a2a with the same bearer`, firstStep: "whoami, then my_plans for invitations" }, members: people.crewNames(code), about: `An invitation to a crew on Join (${u}): friends who plan together. Members are invited to each other's plans first, and each answers through their own agent.`,
    join: { newPerson: { method: "POST", url: `${u}/api/auth/demo`, body: { name: "<your person's first name>", crew: code, lat: "<optional>", lon: "<optional>" }, then: `POST ${u}/api/tokens for an agent token; see ${u}/llms.txt` },
      existingPerson: { method: "POST", url: `${u}/api/crew/join`, body: { code }, auth: "your person's session, or Authorization: Bearer <their agent token>" } }, guide: `${u}/llms.txt` });
});
app.get("/auth/:provider/start", (req, res) => {
  const r = oauth.start(req.params.provider, PUBLIC_URL);
  if (!r) return res.redirect("/#/?signin=off");
  res.set("Set-Cookie", `join_oauth=${r.state}; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=600`).redirect(r.url);
});
app.get("/auth/:provider/callback", async (req, res) => {
  const c = (req.headers.cookie || "").split(/;\s*/).map((x) => x.split("=")).find(([k]) => k === "join_oauth")?.[1];
  try {
    const r = await oauth.finish(req.params.provider, req.query, c, PUBLIC_URL);
    if (r.error) return res.redirect(`/#/?signin=${encodeURIComponent(r.error)}`);
    const p = people.personFor(req.params.provider, r.id, r.name), sid = createSession(p.id);
    res.set("Set-Cookie", [`${COOKIE}=${sid}; HttpOnly; SameSite=Lax; Path=/`, "join_oauth=; Path=/auth; Max-Age=0"]).redirect("/#/activity");
  } catch (e) { console.error(e); res.redirect("/#/?signin=error"); }
});
// The front door for agents: what Join is and how to get in with nothing but this address (llms.txt, as many sites
// now publish for language models), next to the machine-readable cards.
app.get("/llms.txt", (req, res) => res.type("text/plain").send(agentGuide(`${req.protocol}://${req.headers.host}`))); // (the address the agent used)
app.get("/.well-known/llms.txt", (req, res) => res.redirect("/llms.txt"));
// one-click demo sign-in for judges and screenshots: /demo?as=alex&go=activity (demo mode only)
// Demo only: the town back to its starting state, for a clean run (a judge's first look, a recording). Receipts and the
// transparency log stay: an append-only log that a button could wipe would prove nothing.
function resetDemo() {
  negotiationsStore.reset(); settle.bookingsStore.reset(); mandatesStore.reset(); activityStore.reset(); ap2.mandatesAp2Store.reset(); reviews.reviewsStore.reset();
}
app.post("/api/demo/reset", (req, res) => { if (!DEMO) return res.status(404).end(); resetDemo(); res.json({ ok: true, kept: ["receipts", "transparency log", "agent tokens"] }); });
app.get("/demo", (req, res) => {
  if (!DEMO) return res.status(403).end();
  if (req.query.reset === "1") resetDemo();
  const sid = createSession(String(req.query.as || "alex"));
  if (!sid) return res.status(400).send("unknown player");
  const go = String(req.query.go || "activity").replace(/[^\w/?=&.-]/g, "");
  res.set("Set-Cookie", `${COOKIE}=${sid}; HttpOnly; SameSite=Lax; Path=/`).redirect(`/#/${go}`);
});
app.delete("/api/session", signedIn, (req, res) => { endSession(req.sid); res.set("Set-Cookie", `${COOKIE}=; Max-Age=0; Path=/`).json({ ok: true }); });
app.get("/api/me", signedIn, (req, res) => { const p = player(req.player), m = getMandate(req.player); res.json({ player: { id: p.id, name: p.name, area: p.area, interests: p.interests, free: p.free }, mandate: { ...m, perGameUsd: usd(m.perGame), perWeekUsd: usd(m.perWeek) }, vault: settle.hasVault(req.player), tokens: tokensOf(req.player) }); });
app.put("/api/mandate", signedIn, (req, res) => { const r = setMandate(req.player, req.body || {}); res.status(r.error ? 400 : 200).json(r); });
app.post("/api/tokens", signedIn, (req, res) => res.json(makeToken(req.player, req.body?.label, { scopes: req.body?.scopes, days: req.body?.days, key: req.body?.key })));
app.delete("/api/tokens/:id", signedIn, (req, res) => res.json({ ok: revoke(req.player, req.params.id) }));
app.get("/api/activity", signedIn, (req, res) => res.json({ entries: forPlayer(req.player, { after: +req.query.after || 0 }) }));
app.get("/api/games", signedIn, (req, res) => res.json(ops.myGames({ player: req.player }, { all: true })));
// the person can do from the website what their agent can (approving payments is in PayPal itself)
app.post("/api/bookings/:id/:act", signedIn, async (req, res, next) => {
  const a = { player: req.player, client: null }, act = { pay: ops.payMyShare, decline: ops.declineGame, cancel: ops.cancelBooking, "propose-share": ops.proposeShare, "answer-share": ops.answerShare, "reimburse": ops.requestReimbursement }[req.params.act];
  if (!act) return next(); // (review, approved and ap2 have their own routes below)
  const r = await act(a, { ...(req.body || {}), booking: req.params.id }); res.status(r.error ? 400 : 200).json(r);
});
// Join's website agent, for people who don't bring one. It understands what they ask on Join's own server (Qwen2.5 0.5B
// through a local Ollama, or rules; scout/understand.js), then calls the same tools their own agent would, as them,
// under the same limits. It can search, negotiate and accept; paying stays with the person, in PayPal.
const SCOUT = ["whoami", "list_activities", "venue_reviews", "find_options", "start_negotiation", "make_offer", "accept_price", "walk_away", "find_alternatives", "booking_status", "my_plans"];
app.post("/api/scout/understand", limit("agent", +(process.env.AGENT_RPM || 120)), signedIn, async (req, res) => {
  const history = (Array.isArray(req.body?.history) ? req.body.history : []).slice(-8).map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || "").slice(0, 500) }));
  if (!history.length) return res.status(400).json({ error: "empty" });
  const w = getWorld();
  res.json(await scout.understand(history, req.body?.brief && typeof req.body.brief === "object" ? req.body.brief : {}, { activities: w.activities, people: w.players.filter((p) => p.id !== req.player), today: new Date(), lang: req.body?.lang === "zh" ? "zh" : "en" }));
});
app.post("/api/scout/:tool", limit("agent", +(process.env.AGENT_RPM || 120)), signedIn, async (req, res) => {
  if (!SCOUT.includes(req.params.tool)) return res.status(404).json({ error: "unknown_tool", tools: SCOUT });
  // (_model is what the page says is calling: "webmcp" for a browser's own agent, else Join's website agent. It only picks
  // the label and the mandate's binding; both act as the signed-in person, within their limits.)
  const via = String(req.body?._model || "rules");
  const { _model, ...args } = req.body || {};
  // (the person's own session is the trusted surface: Join presents that agent's current open mandate for it)
  const kid = via === "webmcp" ? "webmcp" : "website-agent";
  if (["make_offer", "accept_price", "pay_my_share"].includes(req.params.tool)) args.mandate = ops.openMandates({ player: req.player, token: kid }).payment;
  try { const r = await TOOLS[req.params.tool](via === "webmcp" ? { player: req.player, client: "Browser agent (WebMCP)", token: "webmcp" } : { player: req.player, client: "Join's website agent", token: "website-agent" }, args); res.status(r?.error ? 400 : 200).json(r); } catch (e) { console.error(e); res.status(500).json({ error: "internal" }); }
});
// the JS SDK v6 on the website: a browser-safe token, and the payer's own approval coming back from the PayPal popup
app.get("/api/paypal/sdk", signedIn, async (req, res) => {
  if (!pp.clientToken) return res.json({ mode: pp.mode, token: null });
  try { res.json({ mode: pp.mode, ...(await pp.clientToken()) }); } catch (e) { res.status(502).json({ error: "paypal", message: e.message }); }
});
// a booking's AP2 mandates (checkout, each payment, Join's mandate receipts), for the people in it
app.get("/api/bookings/:id/ap2", signedIn, (req, res) => { const b = settle.internal(req.params.id); if (!b || !b.players.includes(req.player)) return res.status(404).json({ error: "no such booking" }); res.json(ap2.forBooking(b.id)); });
// verified reviews: anyone may read a venue's; a person reviews a booking they were in and paid for (never an agent)
app.get("/api/venues/:id/reviews", (req, res) => { const r = ops.venueReviews({ player: sessionOf(req)?.player || null }, { venue: req.params.id, activity: req.query.activity || null }); res.status(r.error ? 404 : 200).json(r); });
app.post("/api/bookings/:id/review", signedIn, (req, res) => {
  const b = settle.internal(req.params.id), r = reviews.add(req.player, b, { stars: +req.body?.stars, liked: req.body?.liked, disliked: req.body?.disliked, text: req.body?.text }, { canReview: settle.canReview });
  if (!r.error) recordActivity({ actor: { kind: "player", player: req.player }, who: [req.player], action: "reviewed", ref: b.id, summary: `${player(req.player).name.split(" ")[0]} reviewed ${venue(b.venue).name}: ${r.review.stars}★.` });
  res.status(r.error ? 400 : 200).json(r);
});
app.get("/api/reviews/aspects", (req, res) => res.json({ liked: reviews.ASPECTS, complaints: reviews.COMPLAINTS }));
// balances with friends across plans, and settling up with one netted PayPal invoice
app.get("/api/ledger", signedIn, (req, res) => res.json(settle.ledger(req.player)));
app.post("/api/ledger/settle", signedIn, async (req, res) => { const r = await settle.settleUp(req.player, String(req.body?.friend || "")); res.status(r.error ? 400 : 200).json(r); });
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
app.get("/api/venues/:id/metrics", venueStaff, (req, res) => res.json(settle.venueMetrics(req.params.id)));
app.get("/api/venues/:id/demand", venueStaff, (req, res) => { const v = getWorld().venues.find((x) => x.id === req.params.id); if (!v) return res.status(404).json({ error: "no_venue" }); res.json({ venue: v.id, activities: Object.keys(v.offers || {}), days: 30, ...demandFor(Object.keys(v.offers || {})) }); });
app.get("/api/venues/:id/reconcile", venueStaff, async (req, res) => res.json(await settle.reconcileVenue(req.params.id)));
app.post("/api/venues/:id/bookings/:booking/extras", venueStaff, async (req, res) => { try { const r = await settle.billExtras(req.params.id, req.params.booking, req.body?.items); res.status(r.error ? 400 : 200).json(r); } catch (e) { res.status(502).json({ error: "paypal", message: e.message }); } });
app.get("/api/venues/:id/disputes", venueStaff, async (req, res) => { try { res.json({ toolkit: toolkitMode(), disputes: await settle.venueDisputes(req.params.id) }); } catch (e) { res.status(502).json({ error: "paypal", message: e.message }); } });
app.post("/api/venues/:id/disputes/:dispute/answer", venueStaff, async (req, res) => { try { const r = await settle.answerDispute(req.params.id, req.params.dispute); res.status(r.error ? 400 : 200).json(r); } catch (e) { res.status(502).json({ error: "paypal", message: e.message }); } });
// (stand-in only) open a dispute on a capture, as a buyer would, to try the flow
app.post("/api/demo/dispute", (req, res) => { if (pp.mode !== "mock") return res.status(404).end(); const d = pp.openDispute(String(req.body?.capture || "")); if (!d) return res.status(400).json({ error: "no such capture" }); settle.webhook({ event_type: "CUSTOMER.DISPUTE.CREATED", resource: d }).then(() => res.json(d)); });
// Demo only: the organizer plays the friends they invited, from one window (each step is logged as a demo step)
app.post("/api/demo/bookings/:id/:act", signedIn, async (req, res) => {
  if (!DEMO) return res.status(404).end();
  const b = settle.internal(req.params.id), who = String(req.body?.player || "");
  if (!b || b.organizer !== req.player) return res.status(403).json({ error: "not_organizer", message: "Only the organizer can play the others in the demo." });
  const other = (id) => b.players.includes(id) && id !== b.organizer;
  const said = (summary) => recordActivity({ actor: { kind: "platform" }, who: b.players, action: "demo_step", ref: b.id, summary: `Demo: ${summary}` });
  const nm = (id) => player(id)?.name.split(" ")[0] || id;
  await demoScope.run(true, async () => { try {
    if (req.params.act === "end") { said(`${nm(req.player)} ended the game early, so the venue is paid now.`); return res.json(await settle.endNow(b.id)); }
    if (req.params.act === "time-out") { said(`${nm(req.player)} ran the clock out for everyone who hadn't paid.`); return res.json(await settle.expireNow(b.id)); }
    if (!other(who)) return res.status(400).json({ error: "not_invited", message: "Pick someone invited to this booking." });
    if (player(who)?.joined) return res.status(403).json({ error: "real_person", message: `${nm(who)} joined Join themselves: only they (or their agent) can answer.` }); // (the demo panel plays only the made-up residents)
    if (req.params.act === "pay") {
      // on the stand-in, the friend has saved PayPal and lets their agent pay; on the sandbox, PayPal's test card stands in
      if (pp.mode === "mock" && !settle.hasVault(who)) { const s = await settle.vaultStart(who); pp.approve({ setup: s.setup }); await settle.vaultFinish(s.setup); setMandate(who, { autopay: true }); }
      said(`${nm(req.player)} played ${nm(who)}: joined and paid.`);
      const r = await settle.pay(b.id, who), p = b.payments[who];
      if (p?.status === "awaiting_approval" && pp.mode === "mock") { pp.approve({ token: p.orderId }); await settle.approved(b.id, who); }
      return res.json(r);
    }
    if (req.params.act === "ask-less") { said(`${nm(req.player)} played ${nm(who)}: asked to pay $1 less.`); return res.json(settle.proposeShare(b.id, who, Math.max(0, b.shares[who] - 100))); }
    if (req.params.act === "decline") { said(`${nm(req.player)} played ${nm(who)}: can't come.`); return res.json(await settle.decline(b.id, who)); }
    res.status(404).json({ error: "unknown_act" });
  } catch (e) { console.error(e); res.status(500).json({ error: "internal" }); } });
});
app.get("/api/venues/:id/schedule", (req, res) => res.json({ venue: req.params.id, bookings: settle.forVenue(req.params.id) }));
// live activity for the signed-in player (server-sent events)
app.get("/api/activity/stream", signedIn, (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" }).flushHeaders();
  const off = onActivity((e) => { if (e.who.includes(req.player)) res.write(`data: ${JSON.stringify(e)}\n\n`); });
  const ping = setInterval(() => res.write(": ping\n\n"), 25e3);
  req.on("close", () => { off(); clearInterval(ping); });
});

// ---- verifiable receipts ----------------------------------------------------------------------------------------------------
// Receipts: Join's public key and its audit log's signed head, a receipt, and the log from any entry on
app.get("/.well-known/join-receipts.json", (req, res) => res.json({ keys: [receipts.publicKey()], log: { ...receipts.logInfo(), checkpointUrl: `${PUBLIC_URL}/api/receipts/log/checkpoint`, proofs: `${PUBLIC_URL}/api/receipts/log/{proof?index=&size=, consistency?from=&to=, entries?from=&to=}`,
  about: "An RFC 6962 Merkle tree of receipt batches; the checkpoint is a C2SP signed note (c2sp.org/tlog-checkpoint) signed with the key above, with any witnesses' cosignatures (c2sp.org/tlog-cosignature)." } }));
app.get("/api/receipts/log/checkpoint", (req, res) => { const c = receipts.logInfo().checkpoint; c ? res.type("text/plain").send(c) : res.status(404).end(); });
app.get("/api/receipts/log/entries", (req, res) => res.json(receipts.entries(+req.query.from || 0, req.query.to != null ? +req.query.to : undefined)));
app.get("/api/receipts/log/proof", (req, res) => { const p = receipts.inclusion(+req.query.index, req.query.size != null ? +req.query.size : undefined); p ? res.json(p) : res.status(400).json({ error: "bad_range" }); });
app.get("/api/receipts/log/consistency", (req, res) => { const p = receipts.consistency(+req.query.from, req.query.to != null ? +req.query.to : undefined); p ? res.json(p) : res.status(400).json({ error: "bad_range" }); });
// witnesses: an operator adds one (demo mode, or ADMIN_TOKEN); a witness then sends its cosignature of the current checkpoint
app.post("/api/receipts/log/witnesses", (req, res) => { if (!admin(req)) return res.status(403).end(); const r = receipts.addWitness(String(req.body?.name || ""), req.body?.jwk); res.status(r.error ? 400 : 200).json(r); });
app.post("/api/receipts/log/cosign", (req, res) => { const r = receipts.cosign(String(req.body?.name || ""), String(req.body?.line || "")); res.status(r.error ? 400 : 200).json(r); });
app.get("/api/receipts/:id", (req, res) => { const r = receipts.show(req.params.id, sessionOf(req)?.player); r ? res.json(r) : res.status(404).json({ error: "no such receipt" }); });
// (closing a batch now instead of waiting for the next one: in demo mode, or with ADMIN_TOKEN as a bearer token)
const admin = (req) => DEMO || (process.env.ADMIN_TOKEN && req.headers.authorization === `Bearer ${process.env.ADMIN_TOKEN}`);
app.post("/api/receipts/batch", async (req, res) => { if (!admin(req)) return res.status(403).end(); res.json(await receipts.batch()); });
setInterval(() => receipts.batch().catch((e) => console.error("receipts", e.message)), +(process.env.RECEIPT_BATCH_MS || 2 * 60e3)).unref();

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
// an MCP server card, for clients that look for one, and a JSON 404 (not the website) for anything else agents probe
app.get("/.well-known/mcp.json", (req, res) => { const u = `${req.protocol}://${req.headers.host}`, t = mcp.toolsManifest(); res.json({ name: "Join", description: "A marketplace where AI agents get a group together and settle it with PayPal (sandbox).", url: `${u}/mcp`, transport: "streamable-http", authentication: { type: "bearer", howToGetOne: `${u}/llms.txt` }, guide: `${u}/llms.txt`, tools: t.tools.map((x) => x.name), toolsDigest: t.digest }); });
app.all(/^\/(\.well-known|api)\//, (req, res) => res.status(404).json({ error: "not_found", message: `Nothing at ${req.path}. Agents: start at /llms.txt.` }));
if (fs.existsSync(WEB)) { app.use(express.static(WEB)); app.get(/^\/(?!api|mcp|paypal|a2a|mock-paypal|\.well-known).*/, (req, res) => res.sendFile(path.join(WEB, "index.html"))); }

setInterval(() => settle.tick().catch((e) => console.error("tick", e.message)), +(process.env.TICK_MS || 5000)).unref();
// venues registered with coordinates only get an address from OpenStreetMap, once, in the background
if (REAL) (async () => { for (const v of partnersStore.data.venues.filter((x) => !x.area)) { const ad = await osmAddress(v.lat, v.lon); if (!ad) continue; v.area = ad; partnersStore.save(); const live = getWorld().venues.find((x) => x.id === v.id); if (live) live.area = ad; } })().catch(() => {});
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status === 413 ? "too_large" : status === 400 ? "bad_json" : "internal", message: status === 413 ? "The request body is too large." : status === 400 ? "The request body isn't valid JSON." : "Something went wrong." });
});
app.listen(PORT, () => console.log(`Join on ${PUBLIC_URL}  (PayPal: ${pp.mode}; MCP: ${PUBLIC_URL}/mcp; receipts: signed, batched, transparency log of ${receipts.logInfo().size} entries; demo sign-in: ${DEMO ? "on" : "off"})`));

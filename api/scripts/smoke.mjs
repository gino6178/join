// Smoke test of the demo's main path against a running Join, over HTTP, as a judge would walk it: the website agent
// understands a request, finds options with reviews, haggles, the organizer guarantees in PayPal, the friends pay (the
// demo panel), the booking locks, its receipt is in the log and verifies, and a review can be posted.
//   node scripts/smoke.mjs [base URL] [--reset]      (default http://localhost:8790; --reset starts the demo town fresh)
// Exits 1 at the first step that fails. Uses demo sign-in, so it needs DEMO_SIGNIN on (the default).
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = (process.argv.find((a) => a.startsWith("http")) || "http://localhost:8790").replace(/\/$/, "");
const WHO = process.env.SMOKE_AS || "noor";
let cookie = "";
const step = (ok, what, extra = "") => { console.log(`${ok ? "✔" : "✘"} ${what}${extra ? `  ${extra}` : ""}`); if (!ok) process.exit(1); };
const call = async (method, p, body) => {
  const r = await fetch(`${BASE}${p}`, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), cookie }, body: body ? JSON.stringify(body) : undefined, redirect: "manual" });
  return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
};
const scout = (tool, args) => call("POST", `/api/scout/${tool}`, args);
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));

// A server in real mode (no made-up town) is checked with real people: a sandbox test venue registered once near a
// fixed point, two people who live near it in one crew, the organizer's plan through Join's website agent, and the
// friend paying from their own session. Then the same lock, receipt and log checks as the demo town's.
const mode = (await call("GET", "/api/auth/providers")).body;
if (mode?.real) await realSmoke();
async function realSmoke() {
  if (process.argv.includes("--reset")) await call("POST", "/api/demo/reset");
  const at = { lat: 25.033, lon: 121.5435 }, name = "Join smoke-test badminton (sandbox)";
  const w0 = (await call("GET", "/api/world")).body;
  if (!w0.venues.some((v) => v.name === name)) { const r = await call("POST", "/api/venues/register", { name, ...at, open: ["07:00", "23:00"], offers: { badminton: { units: 6, per: "hour", price: 20 } } }); step(r.status === 200, "registered the sandbox test venue", r.body?.venue?.id); }
  const join = async (who, body) => { const r = await fetch(`${BASE}/api/auth/demo`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return { cookie: (r.headers.get("set-cookie") || "").split(";")[0], me: (await r.json()).player }; };
  const ana = await join("ana", { name: "Smoke Ana", lat: at.lat + 0.004, lon: at.lon });
  cookie = ana.cookie;
  const crew = (await call("POST", "/api/crew")).body.code;
  const bo = await join("bo", { name: "Smoke Bo", lat: at.lat - 0.004, lon: at.lon + 0.004, crew });
  step(!!ana.cookie && !!bo.cookie, "two real people near each other, in one crew", crew);
  const f = await scout("find_options", { activity: "badminton", players: 1 });
  const o = (f.body?.options || []).find((x) => x.onJoin && x.players.includes(bo.me.id));
  step(!!o, "found an option on Join with the friend", o ? `${o.venueName} ${o.date} ${o.start} $${o.askPrice}; nearby real places: ${(o.nearbyReal || []).length}` : JSON.stringify(f.body).slice(0, 160));
  let n = await scout("start_negotiation", { venue: o.venue, activity: "badminton", date: o.date, start: o.start, minutes: o.minutes, players: [bo.me.id] });
  step(n.body?.status === "open", "opened a negotiation", `ask $${n.body?.ask}`);
  while (n.body.status === "open" && !n.body.final && n.body.roundsLeft > 0) n = await scout("make_offer", { negotiation: n.body.id, amount: Math.ceil(+n.body.ask * 70 + 1) / 100 });
  const a = n.body.status === "agreed" ? n : await scout("accept_price", { negotiation: n.body.id });
  step(a.body?.status === "agreed" && !!a.body.booking, "deal", `$${a.body?.agreed?.amount}`);
  const id = a.body.booking.id;
  let b;
  // (on the PayPal stand-in, a payment waits for its approval page: approve it, as the payer would)
  const approve = async (bk) => { if (bk?.you?.approveUrl?.includes("/mock-paypal/") && bk.you.status === "awaiting_approval") { await fetch(bk.you.approveUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "a=yes", redirect: "manual" }); await call("POST", `/api/bookings/${bk.id}/approved`); } };
  for (let i = 0; i < 20; i++) { b = (await call("GET", "/api/games")).body.bookings.find((x) => x.id === id); await approve(b); if (b?.state === "held") break; await wait(700); }
  step(b?.state === "held", "the organizer guaranteed the booking in PayPal", `(${b?.you?.via})`);
  cookie = bo.cookie;
  const paid = await call("POST", `/api/bookings/${id}/pay`);
  for (let i = 0; i < 10; i++) { const mine = (await call("GET", "/api/games")).body.bookings.find((x) => x.id === id); await approve(mine); if (["authorized", "captured"].includes(mine?.you?.status)) break; await wait(700); }
  step(paid.status === 200, "the friend paid from their own session");
  cookie = ana.cookie;
  for (let i = 0; i < 20 && b.state !== "locked"; i++) { await wait(700); b = (await call("GET", "/api/games")).body.bookings.find((x) => x.id === id); }
  step(b.state === "locked", "everyone paid: the booking is locked");
  await call("POST", "/api/receipts/batch");
  b = (await call("GET", "/api/games")).body.bookings.find((x) => x.id === id);
  const rid = b.receipts?.[0]?.id;
  step(!!rid, "a receipt was issued", rid);
  const verifier = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../examples/verify-receipt.mjs");
  let verified = false;
  try { execFileSync(process.execPath, [verifier, rid], { env: { ...process.env, JOIN_URL: BASE }, stdio: "pipe" }); verified = true; } catch {}
  step(verified, "the receipt verifies independently (hash, signature, Merkle path, log inclusion, checkpoint)");
  console.log(`\nThe main path works on ${BASE} (real mode).`);
  process.exit(0);
}

const s = await call("GET", `/demo?as=${WHO}${process.argv.includes("--reset") ? "&reset=1" : ""}`);
cookie = (s.headers.get("set-cookie") || "").split(";")[0];
step(!!cookie, `signed in as ${WHO}`);

const u = await call("POST", "/api/scout/understand", { history: [{ role: "user", content: "karaoke saturday night, 4 of us, $15 each" }], brief: {} });
step(u.body?.brief?.activity === "karaoke" && u.body.missing.length === 0, "the website agent understood the request", `(${u.body?.model})`);

const f = await scout("find_options", { activity: "karaoke", dates: u.body.brief.dates, from: u.body.brief.from, to: u.body.brief.to, players: u.body.brief.players });
const o = f.body?.options?.[0];
step(!!o, "found options", o ? `${o.venueName} ${o.date} ${o.start} $${o.askPrice}` : "");
step(!!o.reviews && typeof o.reviews.score === "number", "the option carries verified reviews", o.reviews?.reason);

let n = await scout("start_negotiation", { venue: o.venue, activity: "karaoke", date: o.date, start: o.start, minutes: o.minutes, players: o.players.slice(1) });
step(n.body?.status === "open", "opened a negotiation", `ask $${n.body?.ask}`);
step(!!n.body.ifYouAccept, "the organizer is told what accepting means", n.body.ifYouAccept?.note?.slice(0, 60));
while (n.body.status === "open" && !n.body.final && n.body.roundsLeft > 0) n = await scout("make_offer", { negotiation: n.body.id, amount: Math.ceil(+n.body.ask * 70 + 1) / 100 });
const a = n.body.status === "agreed" ? n : await scout("accept_price", { negotiation: n.body.id });
step(a.body?.status === "agreed" && !!a.body.booking, "deal", `$${a.body?.agreed?.amount}`);
const id = a.body.booking.id;

// the organizer's guarantee: the sandbox test card or saved PayPal authorize at once; the stand-in's approval page approves
let b;
for (let i = 0; i < 15; i++) {
  b = (await call("GET", `/api/bookings/${id}/ap2`)).status === 200 ? (await call("GET", "/api/games")).body.bookings.find((x) => x.id === id) : null;
  // (the stand-in's PayPal page approves on "Agree and continue", a form post)
  if (b?.you?.approveUrl?.includes("/mock-paypal/") && b.you.status === "awaiting_approval") { await fetch(b.you.approveUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "a=yes", redirect: "manual" }); await call("POST", `/api/bookings/${id}/approved`); }
  if (b?.state === "held") break;
  await wait(700);
}
step(b?.state === "held", "the organizer guaranteed the booking in PayPal", `(${b?.you?.via})`);
const ap2 = (await call("GET", `/api/bookings/${id}/ap2`)).body;
step(ap2?.checkoutMandate?.payload?.vct === "mandate.checkout.1" && !!ap2.payments[WHO], "AP2 checkout and payment mandates exist");

for (const pid of b.players.filter((p) => p !== WHO)) { const r = await call("POST", `/api/demo/bookings/${id}/pay`, { player: pid }); step(r.status === 200, `played ${pid}: paid`); }
for (let i = 0; i < 15 && b.state !== "locked"; i++) { await wait(700); b = (await call("GET", "/api/games")).body.bookings.find((x) => x.id === id); }
step(b.state === "locked", "everyone paid: the booking is locked");

await call("POST", "/api/receipts/batch");
b = (await call("GET", "/api/games")).body.bookings.find((x) => x.id === id);
const rid = b.receipts?.[0]?.id;
step(!!rid, "a receipt was issued", rid);
const verifier = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../examples/verify-receipt.mjs");
let verified = false;
try { execFileSync(process.execPath, [verifier, rid], { env: { ...process.env, JOIN_URL: BASE }, stdio: "pipe" }); verified = true; } catch {}
step(verified, "the receipt verifies independently (hash, signature, Merkle path, log inclusion, checkpoint)");

const rv = await call("POST", `/api/bookings/${id}/review`, { stars: 5, liked: ["atmosphere"], text: "Smoke test." });
step(rv.status === 200 || rv.body?.error === "not_yet", "reviews: posted, or refused until the booking starts", rv.body?.error || `★${rv.body?.venue?.score}`);
console.log(`\nThe demo's main path works on ${BASE}.`);

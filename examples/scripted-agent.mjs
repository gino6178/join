// A scripted agent that uses Join over MCP, exactly as Claude or any MCP client would, but following a fixed script:
// no model and no API key, so anyone can run the whole flow. It plays four people's agents:
//   1. Alex's agent looks for a plan with three others (doubles badminton by default), asks the fairest venue, finds the share over Alex's budget, takes the
//      best alternative nearby, haggles, and agrees a price.
//   2. Alex guarantees the booking in PayPal; the others' agents are invited, one asks to pay less, and each pays.
//   3. The booking is locked.
// Approving in PayPal is a person's step. With JOIN_AUTO_APPROVE=1 and Join running on the PayPal stand-in, the script
// clicks "Agree" on the simulated PayPal page for them, so the demo runs end to end; with real sandbox keys it prints
// the approval links for you to open instead.
//
//   node scripted-agent.mjs            (Join on http://localhost:8790)
//   JOIN_URL=https://... node scripted-agent.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const URL0 = (process.env.JOIN_URL || "http://localhost:8790").replace(/\/$/, "");
const AUTO = process.env.JOIN_AUTO_APPROVE !== "0";
// what the group gets together for: badminton by default; JOIN_ACTIVITY=karaoke (or "escape room", "board games", ...) for
// another plan
const ACTIVITY = process.env.JOIN_ACTIVITY || "badminton";
const say = (who, text) => console.log(`${who.padEnd(14)} ${text}`);

// Sign in as a demo player on the website and make an agent token, the way a person does on "Connect your agent".
async function tokenFor(player, label) {
  const s = await fetch(`${URL0}/api/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ player }) });
  if (!s.ok) throw new Error(`sign-in as ${player} failed: ${s.status}`);
  const cookie = s.headers.get("set-cookie").split(";")[0];
  const t = await (await fetch(`${URL0}/api/tokens`, { method: "POST", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify({ label }) })).json();
  return { token: t.token, cookie };
}
async function agent(player, label) {
  const { token, cookie } = await tokenFor(player, label);
  const client = new Client({ name: label, version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${URL0}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const call = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); return r.structuredContent ?? JSON.parse(r.content[0].text); };
  return { call, cookie, close: () => client.close() };
}
// the person's click on the simulated PayPal page
// With real PayPal (sandbox), a person approves: the script prints the link and waits until the payment is authorized.
async function approve(url, who, check) {
  if (!url.includes("/mock-paypal/")) {
    say(who, `approve in PayPal (sign in with a sandbox buyer account): ${url}`);
    for (let i = 0; i < 120 && check; i++) { await new Promise((r) => setTimeout(r, 5000)); if ((await check())?.you?.status === "authorized") { say(who, "approved in PayPal"); return true; } }
    return false;
  }
  if (!AUTO) { say(who, `approve here: ${url}`); return false; }
  await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "a=yes", redirect: "follow" });
  say(who, "(simulated) approved in PayPal");
  return true;
}

const alex = await agent("you", "Scripted agent");
const me = await alex.call("whoami");
say("Alex's agent", `acting for ${me.player.name}; limit $${me.mandate.perGame} a booking (PayPal: ${me.paypal.mode})`);
// Alex sets a limit on the website (a person's step: agents can't change it). For badminton it is tight, so the first
// venue is over budget and the alternatives show; JOIN_BUDGET sets it in dollars for any plan.
const BUDGET = +(process.env.JOIN_BUDGET || (ACTIVITY === "badminton" ? 8 : 40));
await fetch(`${URL0}/api/mandate`, { method: "PUT", headers: { "Content-Type": "application/json", cookie: alex.cookie }, body: JSON.stringify({ perGame: Math.round(BUDGET * 100) }) });
say("Alex", `set the limit to $${BUDGET.toFixed(2)} a booking on the website`);

const found = await alex.call("find_options", { activity: ACTIVITY, players: 3 });
if (found.error) { say("Alex's agent", found.message); process.exit(1); }
const o = found.options[0];
if (!o) { say("Alex's agent", "nobody is free this week"); process.exit(0); }
say("Alex's agent", `${o.day} ${o.date} ${o.start}: ${o.names.join(", ")} are free; fairest venue ${o.venueName} (longest trip ${o.longestTrip} min), asks $${o.askPrice}`);

let n = await alex.call("start_negotiation", { venue: o.venue, activity: ACTIVITY, date: o.date, start: o.start, minutes: o.minutes, players: o.players.filter((p) => p !== "you") });
if (n.error) { say("Venue", n.message); }
else say("Venue", `${n.venueName} asks $${n.ask} ($${n.share} each)${n.overBudget ? `: over Alex's $${BUDGET.toFixed(2)} budget` : ""}`);
let pick = { venue: o.venue, start: o.start };
const alts = n.alternatives || (n.error ? n.alternatives : null);
if (alts?.length) {
  for (const a of alts.slice(0, 3)) say("  alternative", `${a.name} ${a.start}: ${a.why}`);
  const best = alts.find((a) => a.bookable && a.withinBudget) || alts.find((a) => a.bookable);
  if (best) {
    if (!n.error) await alex.call("walk_away", { negotiation: n.id });
    say("Alex's agent", `takes ${best.name} at ${best.start}`);
    pick = { venue: best.venue, start: best.start };
    n = await alex.call("start_negotiation", { venue: best.venue, activity: ACTIVITY, date: o.date, start: best.start, minutes: o.minutes, players: o.players.filter((p) => p !== "you") });
    say("Venue", `${n.venueName} asks $${n.ask} ($${n.share} each)`);
  }
}
// haggle: offer 80% of the ask, then meet the counter; a venue that says its price is final gets a yes or a walk-away
let r;
if (n.final) { say("Alex's agent", "the venue doesn't negotiate: accepts its price"); r = await alex.call("accept_price", { negotiation: n.id }); }
else { r = await alex.call("make_offer", { negotiation: n.id, amount: Math.floor(+n.ask * 0.8) }); say("Alex's agent", `offers $${Math.floor(+n.ask * 0.8)}.00`); }
while (r.status === "open") {
  say("Venue", `counters $${r.ask}${r.final ? " (best and final)" : ""}`);
  if (r.final || r.overBudget) { r = await alex.call("accept_price", { negotiation: n.id }); break; }
  r = await alex.call("make_offer", { negotiation: n.id, amount: +((+r.ask + Math.floor(+n.ask * 0.8)) / 2).toFixed(2) });
  say("Alex's agent", "offers halfway");
}
if (r.error || r.status !== "agreed") { say("Alex's agent", `no deal: ${r.message || r.status}`); process.exit(1); }
say("Venue", `deal: $${r.agreed.amount} ($${r.agreed.share} each)`);

const booking = r.booking.id;
let p = await alex.call("pay_my_share", { booking });
say("Alex's agent", `Alex guarantees the whole booking: $${p.you.authorized}`);
if (p.you?.approveUrl) await approve(p.you.approveUrl, "Alex", () => alex.call("booking_status", { booking }));
else say("Alex", `authorized (${p.you?.via})`);

// everyone else in the plan: each one's own agent, with its own token
const names = Object.fromEntries((await (await fetch(`${URL0}/api/world`)).json()).players.map((p) => [p.id, p.name.split(" ")[0]]));
for (const id of r.players.filter((p) => p !== "you")) {
  const label = `${names[id]}'s agent`;
  const a = await agent(id, `${names[id]}'s scripted agent`);
  const games = await a.call("my_plans");
  const b = games.bookings.find((x) => x.id === booking);
  say(label, `invited: ${b.activity} ${b.date} ${b.start}, share $${b.invite?.share}`);
  // the second person's agent haggles over their share with Alex's agent before joining
  if (id === r.players.filter((p) => p !== "you")[1] && b.invite && +b.invite.share > 1) {
    const ask = Math.max(0, +b.invite.share - 1).toFixed(2);
    await a.call("propose_share", { booking, amount: +ask });
    say(label, `asks to pay $${ask} instead`);
    const ans = await alex.call("answer_share", { booking, player: id, accept: true });
    say("Alex's agent", ans.error ? `can't cover it: ${ans.message}` : `agrees: Alex covers the $1.00`);
  }
  p = await a.call("pay_my_share", { booking: b.id });
  say(label, `pays the share: $${p.you?.authorized}`);
  if (p.you?.approveUrl) await approve(p.you.approveUrl, names[id], () => a.call("booking_status", { booking }));
  else say(names[id], `authorized (${p.you?.via})`);
  await a.close();
}
const s = await alex.call("booking_status", { booking });
say("Join", `booking ${s.id}: ${s.state}, ${s.unitName} at ${s.venueName}, ${s.date} ${s.start}; ${Object.entries(s.payments).map(([k, v]) => `${k} ${v.status}`).join(", ")}`);
await fetch(`${URL0}/api/mandate`, { method: "PUT", headers: { "Content-Type": "application/json", cookie: alex.cookie }, body: JSON.stringify({ perGame: 1500 }) });
await alex.close();

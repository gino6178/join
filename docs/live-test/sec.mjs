// Security checks of a running Join, as an outside agent that got in from the address alone (/llms.txt: demo accounts
// and tokens). Run against a test instance: it makes demo accounts and negotiations.
//   JOIN_URL=http://localhost:8790 node docs/live-test/sec.mjs
const B = (process.env.JOIN_URL || "http://localhost:8790").replace(/\/$/, "");
const out = [];
const rec = (what, ok, detail) => { out.push(`${ok ? "PASS" : "FAIL"}  ${what}  ${detail}`); };
const j = async (r) => { const t = await r.text(); try { return { s: r.status, b: JSON.parse(t) }; } catch { return { s: r.status, b: t.slice(0, 200) }; } };
const demo = async (name) => { const r = await fetch(`${B}/api/auth/demo`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) }); return { cookie: r.headers.get("set-cookie").split(";")[0], me: (await r.json()).player }; };
const token = async (cookie, scopes) => (await (await fetch(`${B}/api/tokens`, { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify({ label: "sec", scopes }) })).json()).token;
const rest = (tok, tool, body) => fetch(`${B}/api/agent/${tool}`, { method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(j);

const a = await demo("SecA"), b = await demo("SecB");
const ta = await token(a.cookie, ["read", "negotiate"]), tread = await token(a.cookie, ["read"]), tb = await token(b.cookie, ["read", "negotiate", "pay"]);

// 1. limits can't be changed with a token
let r = await j(await fetch(`${B}/api/mandate`, { method: "POST", headers: { Authorization: `Bearer ${ta}`, "Content-Type": "application/json" }, body: JSON.stringify({ perGame: 99999 }) }));
rec("token can't change limits (POST /api/mandate)", r.s >= 400, `${r.s}`);
r = await j(await fetch(`${B}/api/mandate`, { method: "PUT", headers: { Authorization: `Bearer ${ta}`, "Content-Type": "application/json" }, body: JSON.stringify({ perGame: 99999 }) }));
rec("token can't change limits (PUT)", r.s >= 400, `${r.s}`);
// 2. read-only token can't negotiate
const opts = await rest(ta, "find_options", { activity: "karaoke", people: 4 });
const o = opts.b.options?.[0];
r = await rest(tread, "start_negotiation", { venue: o.venue, activity: "karaoke", date: o.date, start: o.start, minutes: o.minutes, players: o.players.filter((p) => p !== a.me.id) });
rec("read-only token can't negotiate", r.s === 403 || r.b.error === "scope", `${r.s} ${r.b.error || ""}`);
// 3. A opens a negotiation; B tries to act on it
const n = await rest(ta, "start_negotiation", { venue: o.venue, activity: "karaoke", date: o.date, start: o.start, minutes: o.minutes, players: o.players.filter((p) => p !== a.me.id) });
const nid = n.b.id;
r = await rest(tb, "negotiation_status", { negotiation: nid }); // may not exist as a tool
const who = await rest(tb, "whoami", {});
r = await rest(tb, "make_offer", { negotiation: nid, amount: 1, mandate: who.b.ap2?.openPaymentMandate });
rec("B can't offer on A's negotiation", !!r.b.error, `${r.s} ${r.b.error || JSON.stringify(r.b).slice(0, 80)}`);
r = await rest(tb, "accept_price", { negotiation: nid, mandate: who.b.ap2?.openPaymentMandate });
rec("B can't accept A's negotiation", !!r.b.error, `${r.s} ${r.b.error || ""}`);
// 4. A's mandate: tampered, B's, missing
const wa = await rest(ta, "whoami", {}), m = wa.b.ap2.openPaymentMandate;
r = await rest(ta, "make_offer", { negotiation: nid, amount: 30 });
rec("offer without mandate refused", r.b.error === "mandate_required", r.b.error);
const [h, p, s] = m.split("."), pl = JSON.parse(Buffer.from(p, "base64url"));
pl.constraints = pl.constraints.map((c) => (c.max != null ? { ...c, max: 9999999 } : c));
r = await rest(ta, "make_offer", { negotiation: nid, amount: 30, mandate: `${h}.${Buffer.from(JSON.stringify(pl)).toString("base64url")}.${s}` });
rec("tampered mandate refused", r.b.error === "invalid_mandate", r.b.error);
r = await rest(ta, "make_offer", { negotiation: nid, amount: 30, mandate: who.b.ap2.openPaymentMandate });
rec("someone else's mandate refused", r.b.error === "invalid_mandate", `${r.b.error} ${r.b.message || ""}`);
// 5. A's plans and receipts from B's session/token
r = await j(await fetch(`${B}/api/games`, { headers: { cookie: b.cookie } }));
rec("B's /api/games doesn't show A's negotiation", !JSON.stringify(r.b).includes(nid), `${r.s}`);
// 6. over the limit: A's perGame is $15: offer a share above it
r = await rest(ta, "make_offer", { negotiation: nid, amount: 200, mandate: m });
rec("over-limit accept/offer refused or capped at ask", r.b.error || +r.b.agreed?.amount <= +n.b.ask, `${r.b.error || "agreed " + r.b.agreed?.amount + " (ask " + n.b.ask + ")"}`);
// 7. sign in as a resident through the demo route (by design in demo mode), and as a provider without keys
r = await j(await fetch(`${B}/auth/google/start`, { redirect: "manual" }));
rec("social start without keys doesn't log in", r.s === 302, `${r.s}`);
r = await j(await fetch(`${B}/auth/google/callback?code=x&state=y`, { redirect: "manual" }));
rec("forged social callback refused", r.s === 302, `${r.s}`);
// 8. stored text: a demo name with markup, a review text with an injected instruction
const x = await demo(`<img src=x onerror=alert(1)>Eve`);
rec("markup stripped from names", !/[<>]/.test(x.me.name), JSON.stringify(x.me.name));
// 9. malformed and huge bodies
r = await j(await fetch(`${B}/api/agent/whoami`, { method: "POST", headers: { Authorization: `Bearer ${ta}`, "Content-Type": "application/json" }, body: "{bad json" }));
rec("malformed JSON gives a JSON error, no stack", r.s === 400 && !String(JSON.stringify(r.b)).includes("at "), `${r.s} ${JSON.stringify(r.b).slice(0, 80)}`);
r = await j(await fetch(`${B}/api/auth/demo`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "x".repeat(3e6) }) }));
rec("huge body refused", r.s === 413 || r.s === 400, `${r.s}`);
// 10. demo account flood: rate limit
let codes = {}; for (let i = 0; i < 40; i++) { const rr = await fetch(`${B}/api/auth/demo`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Flood" }) }); codes[rr.status] = (codes[rr.status] || 0) + 1; }
rec("demo-account creation is rate-limited", !!codes[429], JSON.stringify(codes));
// 11. revoked token / bogus token
r = await rest("join_" + "A".repeat(32), "whoami", {});
rec("bogus token refused", r.s === 401, `${r.s}`);
// 12. receipts of someone else's booking: ids are public by design; check a receipt hides player ids
console.log(out.join("\n"));

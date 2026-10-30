// Red-team cases for peer gateways (src/peer.js, docs/a2a_two_gateways.md), in redteam.mjs's style: each case names
// the OWASP risk (Top 10 for LLM Applications 2025) and the layer that should stop it. Gateway A is this process's A2A
// server on a local port, with the real code on both sides of each call. Gateway B is an honest peer: its own key, its
// own signed cards, answers signed with its key. C is a third gateway, on A's allow-list for one member only, and D a
// gateway A has never heard of. B, C and D are small servers made here on the official SDK. No model is needed.
//   node test/peer_redteam.mjs        (also section 7 of test/redteam.mjs, which runs these with the rest)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const alone = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (alone) {
  const D = "data/peer-redteam";
  fs.rmSync(D, { recursive: true, force: true }); fs.mkdirSync(D, { recursive: true });
  Object.assign(process.env, { A2A_DATA: D, A2A_FILE: `${D}/a2a.json`, BOOKINGS_FILE: `${D}/bookings.json`, NEGOTIATIONS_FILE: `${D}/negotiations.json`, LEDGER_FILE: `${D}/ledger.jsonl`, TRACE_FILE: `${D}/traces.jsonl`,
    MATCH_RECORDS_FILE: `${D}/records.json`, MATCH_AUDIT_FILE: `${D}/audit.json`, MATCH_STATE_FILE: `${D}/match_state.json`, AGENT_TOKEN: "prt-" + crypto.randomUUID().slice(0, 8), A2A_TIMEOUT_MS: "8000" });
}

export async function peerCases() {
  const D = path.resolve(process.env.A2A_DATA || "data"), TOKEN = process.env.AGENT_TOKEN;
  const express = (await import("express")).default;
  const { DefaultRequestHandler, AgentEvent, InMemoryTaskStore } = await import("@a2a-js/sdk/server");
  const { agentCardHandler, jsonRpcHandler, UserBuilder } = await import("@a2a-js/sdk/server/express");
  const { TaskState, AGENT_CARD_PATH, A2A_PROTOCOL_VERSION, generateAgentCardSignature } = await import("@a2a-js/sdk");
  const peer = await import("../src/peer.js");
  const a2aServer = await import("../src/a2a_server.js");
  const { negotiate } = await import("../src/a2a.js");
  const play = await import("../src/play.js");
  const { readClub } = await import("../src/club.js");
  // (alone, each case is printed here; in redteam.mjs, by its own expect)
  const rows = [], expect = (id, risk, attack, layer, ok, detail = "") => { rows.push({ id, risk, attack, layer, ok: !!ok, detail }); if (alone) console.log(`  ${ok ? "PASS" : "FAIL"} [${risk}] ${attack}${detail ? ` (${detail})` : ""}`); };
  const listen = (app, port = 0) => new Promise((ok) => { const s = http.createServer(app).listen(port, "127.0.0.1", () => ok(s)); });
  const keyPair = () => { const { privateKey } = crypto.generateKeyPairSync("ed25519"), jwk = crypto.createPublicKey(privateKey).export({ format: "jwk" }); return { key: privateKey, kid: peer.kidOf(jwk.x), jwk: { ...jwk, kid: peer.kidOf(jwk.x), alg: "EdDSA", use: "sig" } }; };

  // gateway A: this process's members' agents, on a port of its own
  const gwA = await listen((req, res) => a2aServer.handle(req, res)), A = `http://127.0.0.1:${gwA.address().port}`;
  process.env.A2A_BASE = process.env.A2A_SELF = A;
  const Akid = peer.ownKey().kid;

  // A small Serve-like gateway: its own key at /a2a/keys.json, a signed card per member, an agent that says yes (and
  // holds), and its answers to signed requests signed with its own key. cardKey (optional) signs the cards instead.
  const seen = [];
  function fake(name, k, { cardKey = null, keysServed = null } = {}) {
    class Yes {
      constructor(id) { this.id = id; }
      cancelTask = async () => {};
      async execute(ctx, bus) {
        const part = (kind, value, mediaType) => ({ content: { $case: kind, value }, metadata: undefined, filename: "", mediaType });
        const d = ctx.userMessage.parts?.find((x) => x.content?.$case === "data")?.content.value || {};
        seen.push({ at: name, to: this.id, kind: d.kind });
        bus.publish(AgentEvent.task({ id: ctx.taskId, contextId: ctx.contextId, status: { state: TaskState.TASK_STATE_SUBMITTED, timestamp: new Date().toISOString() }, artifacts: [], history: [ctx.userMessage], metadata: {} }));
        const [aname, data] = d.kind === "serve.hold" ? ["hold", { held: d.action !== "release", ...(d.action === "book" ? { booked: true } : {}) }] : ["decision", { intent: "accept", works: [d.proposal?.id || "t1"], tier: "rules" }];
        bus.publish(AgentEvent.artifactUpdate({ taskId: ctx.taskId, contextId: ctx.contextId, artifact: { artifactId: aname, name: aname, description: "", parts: [part("data", data, "application/json"), part("text", "ok", "text/plain")], metadata: undefined, extensions: [] }, lastChunk: true, append: false, metadata: undefined }));
        bus.publish(AgentEvent.statusUpdate({ taskId: ctx.taskId, contextId: ctx.contextId, status: { state: TaskState.TASK_STATE_COMPLETED, timestamp: new Date().toISOString() }, metadata: undefined }));
      }
    }
    const app = express(), auth = [];
    app.use((req, res, next) => {
      if (req.headers.authorization) auth.push(req.path); // what this gateway is handed besides the signature
      // its answer to a signed request, signed with its own key for that request (as peer.js signAnswer does)
      const c = peer.claimsOf(req.headers[peer.HEADER]);
      if (c) { const send = res.send.bind(res); res.send = function (body) { if (body != null && typeof body === "object" && !Buffer.isBuffer(body)) return this.json(body); const b = Buffer.from(body == null ? "" : body); this.set(peer.HEADER, peer.signResponseToken({ key: k.key, kid: k.kid, aud: c.iss, status: this.statusCode, body: b, req: c.jti })); return send(b); }; }
      next();
    });
    app.get("/a2a/keys.json", (req, res) => res.json({ keys: [(keysServed || k).jwk] }));
    const handlers = new Map(), signer = generateAgentCardSignature((cardKey || k).key, { alg: "EdDSA", kid: (cardKey || k).kid, typ: "JOSE" });
    const handlerFor = async (id, origin) => {
      if (!handlers.has(id)) handlers.set(id, new DefaultRequestHandler(await signer({ name: `${id} at ${name}`, description: "a test peer", supportedInterfaces: [{ url: `${origin}/a2a/members/${id}/`, protocolBinding: "JSONRPC", tenant: "", protocolVersion: A2A_PROTOCOL_VERSION }], provider: undefined, version: "1",
        capabilities: { streaming: false, pushNotifications: false, extensions: [], extendedAgentCard: false }, securitySchemes: {}, securityRequirements: [], defaultInputModes: ["application/json"], defaultOutputModes: ["application/json"], skills: [], documentationUrl: "", signatures: [] }), new InMemoryTaskStore(), new Yes(id)));
      return handlers.get(id);
    };
    app.use("/a2a/members/:id", async (req, res, next) => {
      const h = await handlerFor(req.params.id, `http://${req.headers.host}`), r = express.Router();
      r.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: h }));
      r.use(jsonRpcHandler({ requestHandler: h, userBuilder: UserBuilder.noAuthentication }));
      r(req, res, next);
    });
    return { app, auth, k };
  }
  const kB = keyPair(), kC = keyPair(), kD = keyPair(), kX = keyPair();
  const B = fake("gwb", kB);
  let sB = await listen(B.app);
  const portB = sB.address().port, OB = `http://127.0.0.1:${portB}`;
  const C = fake("gwc", kC), sC = await listen(C.app), OC = `http://127.0.0.1:${sC.address().port}`;
  fs.writeFileSync(path.join(D, "peers.json"), JSON.stringify({ self: "gwa", peers: [
    { name: "gwb", origin: OB, serve: ["leo", "hana"], members: [{ id: "nb01", name: "Nia Berg" }, { id: "nb02", name: "Ola Berg" }] },
    { name: "gwc", origin: OC, serve: ["hana"], members: [] }] }));
  process.env.A2A_PEERS_FILE = path.join(D, "peers.json");
  process.env.A2A_PEER_PINS = path.join(D, "peer_pins.json");
  fs.rmSync(process.env.A2A_PEER_PINS, { force: true });

  const club = readClub(), venues = (await import("../src/play.js")).helpers.readVenues(), me = { id: "you", name: "You", area: club.you.area, free: club.you.free };
  const next = (() => { const d = new Date(); do d.setDate(d.getDate() + 1); while (d.getDay() !== 4); return play.helpers.ymd(d); })();
  const talk = (id) => negotiate({ me, members: [peer.member(id)], venues, format: "singles", minutes: 90, prefer: { day: "Thu", start: "19:00" } });
  const msg = (data, contextId = crypto.randomUUID()) => JSON.stringify({ jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: { messageId: crypto.randomUUID(), contextId, role: "ROLE_USER", parts: [{ data, mediaType: "application/json" }] } } });
  const rpcBody = (method, params) => JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const post = (member, body, h) => fetch(`${A}/a2a/members/${member}/`, { method: "POST", headers: { "content-type": "application/json", "A2A-Version": "1.0", ...h }, body }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  const signedBy = (k, member, body, extra = {}) => ({ [peer.HEADER]: peer.signToken({ key: k.key, kid: k.kid, aud: Akid, method: "POST", path: `/a2a/members/${member}/`, body, ...extra }) });
  const proposal = (start = "20:00") => ({ kind: "serve.proposal", sport: "badminton", format: "singles", minutes: 90, proposal: { id: "t1", date: next, start, venue: "riverside", court: 2 }, choices: [{ id: "t1", date: next, start, venue: "riverside", court: 2 }], from: "you" });
  const refusedBy = (why) => fs.readFileSync(path.join(D, "peer_log.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.why === why).length;

  // P0, the control: an honest peer, its key pinned on first use, its signed answers used
  {
    const r = await talk("nb01@gwb");
    expect("P0", "-", "a talk with a member of an honest peer gateway (its key pinned on first use, its answers signed)", "the peer protocol lets the legitimate through", !!r.agreed && peer.pinOf("gwb")?.kid === kB.kid, r.agreed ? `agreed ${r.agreed.day} ${r.agreed.start}; B's key pinned` : r.reason);
  }
  // P1: a forged card at B's address, signed by another key, with that key now in B's key set (someone on the path)
  {
    const kE = keyPair(), E = fake("gwb", kB, { cardKey: kE, keysServed: kE });
    sB.closeAllConnections(); await new Promise((ok) => sB.close(ok)); sB = await listen(E.app, portB);
    const before = seen.filter((x) => x.to === "nb02").length, r = await talk("nb02@gwb");
    expect("P1", "LLM06", "a forged Agent Card at a peer's own address (signed by another key, which its key set now serves too)", "the peer's key pinned on first use: only that key counts afterwards",
      !r.agreed && seen.filter((x) => x.to === "nb02").length === before && refusedBy("card-not-pinned-key") >= 1, `${r.reason}; no message sent; refusal logged`);
    sB.closeAllConnections(); await new Promise((ok) => sB.close(ok)); sB = await listen(B.app, portB);
  }
  // P2: a replayed request, the very same signed bytes sent again
  {
    const body = msg(proposal("20:00")), h = signedBy(kB, "leo", body);
    const first = await post("leo", body, h), again = await post("leo", body, h);
    expect("P2", "LLM06", "a replayed request from a peer (the same signed request sent twice)", "a nonce used once, kept on disk until it expires", first.status === 200 && again.status === 401 && /already received/.test(JSON.stringify(again.json)), `first HTTP ${first.status}, again HTTP ${again.status}`);
  }
  // P3: a gateway A has never heard of
  {
    const body = msg(proposal()), r = await post("leo", body, signedBy(kD, "leo", body));
    expect("P3", "LLM06", "a request signed by a gateway that is not on the allow-list", "only a pinned key of an allow-listed peer counts", r.status === 401 && refusedBy("unknown-peer") >= 1, `HTTP ${r.status}, logged`);
  }
  // P4: a third gateway impersonating B's member: it takes over B's address (B's tunnel down, its port free), with
  // its own key and cards, and answers yes for B's member; and it signs a request to A under B's key id
  {
    sB.closeAllConnections(); await new Promise((ok) => sB.close(ok));
    const X = fake("gwx", kX); sB = await listen(X.app, portB);
    const before = seen.filter((x) => x.at === "gwx").length, r = await talk("nb01@gwb");
    const heard = seen.filter((x) => x.at === "gwx").length - before;
    expect("P4", "LLM06", "a third gateway on a peer's address, answering yes for the peer's member (A's client already trusted that address)", "an answer counts only if the peer's pinned key signed it for that request",
      !r.agreed && refusedBy("answer-other-key") >= 1, `${heard} proposal(s) reached it, its answers refused: ${r.reason}`);
    const body = msg(proposal()), forged = await post("hana", body, signedBy({ key: kX.key, kid: kB.kid }, "hana", body));
    expect("P5", "LLM06", "a third gateway signing a request with its own key under the peer's key id", "the signature is checked against the pinned key the key id names", forged.status === 401 && refusedBy("bad-signature") >= 1, `HTTP ${forged.status}`);
    sB.closeAllConnections(); await new Promise((ok) => sB.close(ok)); sB = await listen(B.app, portB);
  }
  // P6: an allow-listed peer asking for a member that is not shared with it
  {
    const body = msg(proposal()), r = await post("leo", body, signedBy(kC, "leo", body));
    expect("P6", "LLM06", "an allow-listed gateway (C) asking a member shared only with another peer", "a member's agent answers only the peers the allow-list shares it with", r.status === 403 && refusedBy("member-not-shared") >= 1, `HTTP ${r.status}`);
  }
  // P7: a real player's agent, to a peer
  {
    const body = msg(proposal()), r = await post("you", body, signedBy(kB, "you", body));
    expect("P7", "LLM02", "a peer asking the gateway's real player's agent", "a real player's agent never answers a peer, whatever the allow-list says", r.status === 403, `HTTP ${r.status}`);
  }
  // P8: a peer reading A's own tasks, and touching A's own holds through a talk id it learned
  {
    const ctx = `neg-${crypto.randomUUID().slice(0, 13)}`;
    const mine = await post("leo", msg(proposal("19:30"), ctx), { authorization: `Bearer ${TOKEN}` });
    const hold = await post("leo", msg({ kind: "serve.hold", action: "hold", ref: ctx, date: next, start: "19:30", minutes: 90 }, ctx), { authorization: `Bearer ${TOKEN}` });
    const lb = rpcBody("ListTasks", {}), list = await post("leo", lb, signedBy(kB, "leo", lb));
    const theirs = list.json?.result?.tasks || [], ownIds = [mine.json?.result?.task?.id, hold.json?.result?.task?.id];
    expect("P8", "LLM02", "a peer listing a member's tasks (ListTasks), to read this gateway's own talks", "a peer sees only the tasks its own requests made", list.status === 200 && !theirs.some((t) => ownIds.includes(t.id)), `${theirs.length} of its own listed, none of A's ${ownIds.filter(Boolean).length}`);
    // the peer answers in the same talk id, then asks to let the hold go
    const p1 = msg(proposal("19:30"), ctx), r1 = await post("leo", p1, signedBy(kB, "leo", p1));
    const rel = msg({ kind: "serve.hold", action: "release", ref: ctx, date: next, start: "19:30", minutes: 90 }, ctx), r2 = await post("leo", rel, signedBy(kB, "leo", rel));
    const still = play.held("leo").some((l) => l.ref === ctx);
    expect("P9", "LLM06", "a peer reusing a talk id of this gateway's own to let that talk's hold go", "a peer's talks are kept under its own name (its holds are its own)", r1.status === 200 && r2.status === 200 && still, `Leo's hold for A's own talk: ${still ? "still held" : "released"}`);
  }
  // P11-P14: a peer booking one of A's members needs the player's signed mandate (peer.js), checked by A's member agent
  {
    // (Leo is free Saturdays 09-12; his Thursday evening is held by A's own talk above)
    const sat = (() => { const d = new Date(); do d.setDate(d.getDate() + 1); while (d.getDay() !== 6); return play.helpers.ymd(d); })();
    const ctx = `neg-${crypto.randomUUID().slice(0, 13)}`, at = { date: sat, start: "09:30", minutes: 90 };
    const one = { id: "t1", date: sat, start: "09:30", venue: "riverside", court: 2 };
    const p = msg({ ...proposal(), proposal: one, choices: [one] }, ctx), said = await post("leo", p, signedBy(kB, "leo", p)); // Leo's agent says it works
    const book = async (mandate) => { const b = msg({ kind: "serve.hold", action: "book", ref: ctx, ...at, ...(mandate ? { mandate } : {}) }, ctx); return (await post("leo", b, signedBy(kB, "leo", b))).json?.result?.task?.artifacts?.find((a) => a.name === "hold")?.parts?.map((x) => x.data).find(Boolean) || {}; };
    const mandate = (o = {}) => peer.signMandateToken({ key: kB.key, kid: kB.kid, who: "you", talk: ctx, court: 2, members: ["leo@gwa"], cap: 400, game: { sport: "badminton", format: "singles", venue: "riverside", ...at }, ...o });
    const none = await book(null);
    expect("P11", "LLM06", "a peer booking a member's time with no mandate from the player", "a booking needs the player's signed mandate", none.held === false && /mandate/.test(none.reason || ""), none.reason);
    const forged = await book(mandate({ key: kX.key })), altered = await book(mandate({ game: { sport: "badminton", format: "singles", venue: "riverside", ...at, start: "19:00" } }));
    expect("P12", "LLM06", "a forged mandate (another key under the peer's key id) and an altered one (another time)", "the mandate is checked against the peer's pinned key, for this talk, time and member", forged.held === false && altered.held === false, `${forged.reason}; ${altered.reason}`);
    const old = await book(mandate({ now: Date.now() - 20 * 60000 }));
    expect("P13", "LLM06", "an expired mandate (made 20 minutes ago, 5 to live)", "a mandate lives five minutes", old.held === false && /expired/.test(old.reason || ""), old.reason);
    const good = mandate(), ok = await book(good);
    const kept = fs.existsSync(path.join(D, "mandates.jsonl")) && fs.readFileSync(path.join(D, "mandates.jsonl"), "utf8").includes(good);
    const rel = msg({ kind: "serve.hold", action: "release", ref: ctx, ...at }, ctx); await post("leo", rel, signedBy(kB, "leo", rel)); // the game is let go
    const again = await book(good);
    expect("P14", "LLM06", "a valid mandate used, the game let go, then the same mandate replayed to book it again", "a mandate is used once per member, and kept as the receipt", ok.held === true && ok.booked === true && kept && again.held === false && /already used/.test(again.reason || ""), `first: ${ok.booked ? "booked, receipt kept" : ok.reason}; replay: ${again.reason}`);
  }
  expect("P10", "LLM02", "the gateway's token, sent along to a peer gateway", "a peer gets the signature, never the token (it goes to this gateway's own address only)", B.auth.length === 0 && C.auth.length === 0, `${B.auth.length + C.auth.length} requests carried a token`);
  sB.closeAllConnections(); sB.close(); sC.closeAllConnections(); sC.close(); gwA.closeAllConnections(); gwA.close();
  delete process.env.A2A_PEERS_FILE;
  return { rows };
}

if (alone) {
  const { rows } = await peerCases();
  const ok = rows.filter((r) => r.ok).length;
  console.log(`\n${ok} of ${rows.length} peer cases passed${ok === rows.length ? "\nALL PASSED" : ""}`);
  process.exit(ok === rows.length ? 0 : 1);
}

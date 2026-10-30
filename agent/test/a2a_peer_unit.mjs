// Unit tests for peer gateways (src/peer.js, docs/a2a_two_gateways.md): request signing and its checks, replay, the
// allow-list, pinning keys on first use, and what a peer's requests are kept under. No model, no network, no real data.
//   node --test test/a2a_peer_unit.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "serve-peer-unit-"));
const PEERS = `${tmp}/peers.json`;
Object.assign(process.env, { A2A_DATA: `${tmp}/a2a`, A2A_PEERS_FILE: PEERS, A2A_PEER_PINS: `${tmp}/pins.json`, A2A_PEER_QUIET: "1" });
const P = await import("../src/peer.js");

// a gateway: its key pair and key id, as peer.js makes them
const gateway = () => { const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519"); const jwk = publicKey.export({ format: "jwk" }); return { key: privateKey, jwk: { ...jwk, kid: P.kidOf(jwk.x) }, kid: P.kidOf(jwk.x) }; };
const B = gateway(), C = gateway(), A = P.ownKey();
const writePeers = (peers, self = "gwa") => { fs.writeFileSync(PEERS, JSON.stringify({ self, peers })); fs.utimesSync(PEERS, new Date(), new Date(Date.now() + Math.random() * 1e6)); };
const memSeen = () => P.createSeen(null);
// what the receiver (gateway A) checks a token from B against: B's pinned key
const keyForB = (kid) => (kid === B.kid ? { peer: "gwb", key: B.jwk } : null);
const req = { method: "POST", path: "/a2a/members/leo/", body: '{"jsonrpc":"2.0","id":1,"method":"SendMessage"}' };
const signB = (extra = {}) => P.signToken({ key: B.key, kid: B.kid, aud: A.kid, ...req, ...extra });
const check = (token, extra = {}, seen = memSeen()) => P.checkToken(token, { ...req, keyFor: keyForB, audience: A.kid, seen, ...extra });

test("a signed request from an allow-listed peer checks out, and names that peer", () => {
  const r = check(signB());
  assert.equal(r.ok, true); assert.equal(r.peer, "gwb"); assert.equal(r.kid, B.kid);
});

test("a body, a path or a method other than the one signed is refused", () => {
  assert.equal(check(signB(), { body: '{"jsonrpc":"2.0","id":1,"method":"SendMessage","x":1}' }).why, "wrong-body");
  assert.equal(check(signB(), { path: "/a2a/members/hana/" }).why, "wrong-request");
  assert.equal(check(signB(), { method: "PUT" }).why, "wrong-request");
  // the body is hashed as bytes: a Buffer of the same text is the same body
  assert.equal(check(signB(), { body: Buffer.from(req.body) }).ok, true);
});

test("a request meant for another gateway (aud) is refused", () => {
  assert.equal(check(P.signToken({ key: B.key, kid: B.kid, aud: C.kid, ...req })).why, "wrong-audience");
});

test("an expired request, one from the future, and one that lives too long are refused", () => {
  const now = Date.now();
  assert.equal(check(signB({ now: now - 200000 })).why, "expired"); // made 200 s ago, 60 s to live
  assert.equal(check(signB({ now: now + 120000 })).why, "expired"); // made two minutes from now
  assert.equal(check(signB({ ttl: 3600 })).why, "bad-claims"); // an hour to live
  // within the 30 s of clock skew it is accepted
  assert.equal(check(signB({ now: now + 20000 })).ok, true);
});

test("the same request twice is a replay, and the nonce is kept across a restart", () => {
  const seen = memSeen(), t = signB();
  assert.equal(check(t, {}, seen).ok, true);
  assert.equal(check(t, {}, seen).why, "replay");
  const file = `${tmp}/seen.json`, s1 = P.createSeen(file), t2 = signB();
  assert.equal(check(t2, {}, s1).ok, true); s1.flush();
  const s2 = P.createSeen(file); // a new process, the same file
  assert.equal(check(t2, {}, s2).why, "replay");
  // a fresh request (a new nonce) still goes through
  assert.equal(check(signB(), {}, s2).ok, true);
});

test("a key no allow-listed peer has, and a forged signature under a peer's key id, are refused", () => {
  assert.equal(check(P.signToken({ key: C.key, kid: C.kid, aud: A.kid, ...req })).why, "unknown-peer");
  // a third gateway signing with its own key but naming B's key id
  assert.equal(check(P.signToken({ key: C.key, kid: B.kid, aud: A.kid, ...req })).why, "bad-signature");
  // a signature with one byte changed
  const t = signB(), parts = t.split("."), sig = Buffer.from(parts[2], "base64url"); sig[5] ^= 1;
  assert.equal(check(`${parts[0]}.${parts[1]}.${sig.toString("base64url")}`).why, "bad-signature");
});

test("what is not a Serve request signature is refused before any key is looked up", () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  assert.equal(check("").why, "malformed");
  assert.equal(check("a.b").why, "malformed");
  assert.equal(check(`${b64({ alg: "none", typ: P.TYP, kid: B.kid })}.${b64({})}.`).why, "malformed");
  // an Agent Card's signature header (typ JOSE) is not a request signature, even signed by the right key
  const h = b64({ alg: "EdDSA", typ: "JOSE", kid: B.kid }), c = b64({ iss: B.kid });
  assert.equal(check(`${h}.${c}.${crypto.sign(null, Buffer.from(`${h}.${c}`), B.key).toString("base64url")}`).why, "malformed");
});

test("the allow-list: only well-formed peers, and a member's agent answers only the peers it is shared with", () => {
  writePeers([{ name: "gwb", origin: "http://127.0.0.1:23890/", serve: ["leo", "hana"], members: [{ id: "nb01", name: "Mira Okafor", level: "B", free: ["Mon 19-22"], rules: { maxTrip: 20 }, sports: ["badminton"] }] },
    { name: "gwc", origin: "http://127.0.0.1:23990", serve: "*" }, { name: "bad name!", origin: "http://x" }, { name: "gwd", origin: "file:///etc/passwd" }, { name: "gwb", origin: "http://evil.example" }]);
  assert.deepEqual(P.peers().map((p) => p.name), ["gwb", "gwc"]);
  assert.equal(P.byOrigin("http://127.0.0.1:23890/a2a/members/x/")?.name, "gwb");
  assert.equal(P.byOrigin("http://127.0.0.1:23891/"), null);
  assert.equal(P.serves("gwb", "leo"), true);
  assert.equal(P.serves("gwb", "kenji"), false);
  assert.equal(P.serves("gwc", "kenji"), true); // "*": every simulated or demo member
  assert.equal(P.serves("gwc", { id: "you", real: true }), false); // never a real player's agent
  assert.equal(P.serves("gwx", "leo"), false); // not on the list
});

test("a peer's members are <id>@<peer>, reached at the peer's origin, and carry no calendar or rule", () => {
  const m = P.member("nb01@gwb");
  assert.equal(m.name, "Mira Okafor"); assert.equal(m.remote, true);
  assert.equal(m.free, undefined); assert.equal(m.rules, undefined);
  assert.equal(P.baseFor(m), "http://127.0.0.1:23890/a2a/members/nb01");
  assert.equal(P.isRemote({ id: "leo" }), false);
  process.env.A2A_BASE = "http://127.0.0.1:8790";
  assert.equal(P.baseFor({ id: "leo" }), "http://127.0.0.1:8790/a2a/members/leo");
  assert.throws(() => P.baseFor({ id: "nb01@nowhere" }), /allow-list/);
  assert.equal(P.member("nb99@gwb"), null);
});

test("a peer's key is pinned on first use, once, and a key set that would not pin is refused", async () => {
  writePeers([{ name: "gwb", origin: "http://127.0.0.1:23890", serve: [] }, { name: "gwc", origin: "http://127.0.0.1:23990", serve: [] }, { name: "gwe", origin: "http://127.0.0.1:24090", serve: [] }]);
  let fetched = 0;
  const k1 = await P.keyOf(P.byName("gwb"), async () => { fetched++; return { keys: [B.jwk] }; });
  const k2 = await P.keyOf(P.byName("gwb"), async () => { fetched++; return { keys: [C.jwk] }; }); // the peer now serves another key
  assert.equal(k1.kid, B.kid); assert.equal(k2.kid, B.kid); assert.equal(fetched, 1);
  assert.equal(JSON.parse(fs.readFileSync(`${tmp}/pins.json`, "utf8")).gwb.key.kid, B.kid);
  // two keys, or a key id that is not the key's fingerprint: nothing is pinned
  await assert.rejects(P.keyOf(P.byName("gwc"), async () => ({ keys: [B.jwk, C.jwk] })));
  await assert.rejects(P.keyOf(P.byName("gwe"), async () => ({ keys: [{ ...C.jwk, kid: B.kid }] })));
  assert.equal(P.pinOf("gwc"), null); assert.equal(P.pinOf("gwe"), null);
  // a key written in config is the pin, whatever the peer serves
  writePeers([{ name: "gwc", origin: "http://127.0.0.1:23990", serve: [], key: C.jwk }]);
  assert.equal((await P.keyOf(P.byName("gwc"), async () => ({ keys: [B.jwk] }))).kid, C.kid);
});

test("sign(): no header for a GET or for an address that is not a peer; a POST to a peer checks out at the peer", async () => {
  writePeers([{ name: "gwb", origin: "http://127.0.0.1:23890", serve: [], key: B.jwk }]);
  const url = "http://127.0.0.1:23890/a2a/members/nb01/";
  assert.deepEqual(await P.sign(url, { method: "GET" }), {});
  assert.deepEqual(await P.sign("http://127.0.0.1:8790/a2a/members/leo/", { method: "POST", body: "{}" }), {});
  const h = await P.sign(url, { method: "POST", body: req.body });
  // at gateway B, A's key pinned for "gwa"
  const atB = P.checkToken(h[P.HEADER], { method: "POST", path: "/a2a/members/nb01/", body: req.body, keyFor: (kid) => (kid === A.kid ? { peer: "gwa", key: { x: A.jwk.x } } : null), audience: B.kid, seen: memSeen() });
  assert.equal(atB.ok, true); assert.equal(atB.peer, "gwa");
});

test("verify(): a request whose key id no pin has, from an unpinned peer, pins that peer first (at most once a minute)", async () => {
  writePeers([{ name: "gwf", origin: "http://127.0.0.1:24190", serve: ["leo"] }]);
  const F = gateway();
  let fetched = 0;
  const token = P.signToken({ key: F.key, kid: F.kid, aud: A.kid, ...req });
  const r = await P.verify({ method: "POST", path: req.path, headers: { [P.HEADER]: token }, body: req.body }, async () => { fetched++; return { keys: [F.jwk] }; });
  assert.equal(r.ok, true); assert.equal(r.peer, "gwf"); assert.equal(fetched, 1);
  // a stranger's key: refused, and the pinned peer is not fetched again
  const r2 = await P.verify({ method: "POST", path: req.path, headers: { [P.HEADER]: P.signToken({ key: C.key, kid: C.kid, aud: A.kid, ...req }) }, body: req.body }, async () => { fetched++; return { keys: [F.jwk] }; });
  assert.equal(r2.why, "unknown-peer"); assert.equal(fetched, 1);
  assert.ok(P.stats()["refused.unknown-peer"] >= 1);
  assert.match(fs.readFileSync(`${tmp}/a2a/peer_log.jsonl`, "utf8"), /unknown-peer/);
});

test("an answer counts only if the asked peer's pinned key signed it, for that very request", async () => {
  const jti = crypto.randomUUID(), body = '{"jsonrpc":"2.0","id":1,"result":{}}';
  const ans = (o = {}) => P.signResponseToken({ key: B.key, kid: B.kid, aud: A.kid, status: 200, body, req: jti, ...o });
  const chk = (t, o = {}) => P.checkResponse(t, { key: B.jwk, audience: A.kid, status: 200, body, req: jti, ...o });
  assert.equal(chk(ans()).ok, true);
  assert.equal(chk(P.signResponseToken({ key: C.key, kid: C.kid, aud: A.kid, status: 200, body, req: jti })).why, "other-key"); // a third gateway at B's address
  assert.equal(chk(P.signResponseToken({ key: C.key, kid: B.kid, aud: A.kid, status: 200, body, req: jti })).why, "bad-signature"); // ... naming B's key id
  assert.equal(chk(ans({ req: crypto.randomUUID() })).why, "other-request"); // an old answer, to another request
  assert.equal(chk(ans({ aud: C.kid })).why, "other-request");
  assert.equal(chk(ans(), { body: body.replace("{}", '{"x":1}') }).why, "wrong-body");
  assert.equal(chk(ans(), { status: 500 }).why, "wrong-body");
  assert.equal(chk(null).why, "unsigned");
  assert.equal(chk(ans(), { key: null }).why, "unknown-peer");
  // checkAnswer, on a fetch Response: a signed answer comes back whole; an unsigned one is refused; an unsigned
  // refusal says its status
  writePeers([{ name: "gwb", origin: "http://127.0.0.1:23890", serve: [], key: B.jwk }]);
  const ok = await P.checkAnswer(P.byName("gwb"), new Response(body, { status: 200, headers: { [P.HEADER]: ans() } }), jti);
  assert.equal(await ok.text(), body);
  await assert.rejects(P.checkAnswer(P.byName("gwb"), new Response(body, { status: 200 }), jti), /not signed/);
  await assert.rejects(P.checkAnswer(P.byName("gwb"), new Response("{}", { status: 401 }), jti), /HTTP 401/);
});

test("a mandate: the player's yes for one game, checked for its key, talk, time, member and age, used once per member", () => {
  const game = { sport: "badminton", format: "doubles", date: "2026-11-05", start: "19:00", minutes: 90, venue: "riverside" };
  const m = (o = {}) => P.signMandateToken({ key: A.key, kid: A.kid, who: "you", talk: "neg-1", court: 2, members: ["nb01@gwb", "nb02@gwb", "leo"], cap: 400, game, ...o });
  const seen = memSeen(), at = { key: { ...A.jwk, kid: A.kid }, ref: "neg-1", date: "2026-11-05", start: "19:00", minutes: 90, seen };
  const t = m();
  assert.equal(P.checkMandate(t, { ...at, member: "nb01@gwb" }).ok, true);
  assert.equal(P.checkMandate(t, { ...at, member: "nb02@gwb" }).ok, true); // the same mandate, another member it names
  assert.equal(P.checkMandate(t, { ...at, member: "nb01@gwb" }).why, "mandate-replay");
  assert.equal(P.checkMandate(t, { ...at, member: "nb03@gwb" }).why, "mandate-other-member");
  assert.equal(P.checkMandate(m(), { ...at, start: "20:00", member: "nb01@gwb" }).why, "mandate-other-game");
  assert.equal(P.checkMandate(m(), { ...at, ref: "neg-2", member: "nb01@gwb" }).why, "mandate-other-game");
  assert.equal(P.checkMandate(m({ now: Date.now() - 10 * 60000 }), { ...at, member: "nb01@gwb" }).why, "mandate-expired");
  assert.equal(P.checkMandate(m({ key: C.key }), { ...at, member: "nb01@gwb" }).why, "mandate-bad-signature");
  assert.equal(P.checkMandate(m(), { ...at, key: C.jwk, member: "nb01@gwb" }).why, "mandate-other-key");
  assert.equal(P.checkMandate(undefined, { ...at, member: "nb01@gwb" }).why, "no-mandate");
  // altered after signing: the claims changed, the signature kept
  const [h, c, s] = m().split("."), claims = JSON.parse(Buffer.from(c, "base64url")); claims.cap = 99999;
  assert.equal(P.checkMandate(`${h}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${s}`, { ...at, member: "nb01@gwb" }).why, "mandate-bad-signature");
});

test("a peer's message ids, talks and askers are its own, apart from this gateway's and from each other's", () => {
  const own = P.scoped(null), b = P.scoped("gwb"), c = P.scoped("gwc");
  assert.equal(own.ref("neg-1"), "neg-1");
  assert.notEqual(b.ref("neg-1"), own.ref("neg-1")); assert.notEqual(b.ref("neg-1"), c.ref("neg-1"));
  assert.notEqual(b.id("m1"), c.id("m1")); assert.equal(b.from("you"), "gwb:you");
  assert.equal(P.callerOf({ user: P.user("gwb") }), "gwb");
  assert.equal(P.callerOf({ user: { userName: "" } }), null);
  assert.equal(P.callerOf(undefined), null);
});

test("the outbox: a release is kept once, sent again until heard, and dropped when the hold has lapsed anyway", async () => {
  writePeers([{ name: "gwb", origin: "http://127.0.0.1:9", serve: [], key: B.jwk }]);
  const x = { member: "nb01@gwb", name: "Mira Okafor", ref: "neg-1", date: "2026-11-05", start: "19:00", minutes: 90 };
  P.outbox.add(x); P.outbox.add(x);
  assert.equal(P.outbox.items().length, 1);
  let sent = 0; P.outbox.handler = async () => { sent++; return true; };
  // the peer does not answer (port 9): kept
  assert.equal(await P.outbox.flush(), 0); assert.equal(sent, 0); assert.equal(P.outbox.items().length, 1);
  // lapsed: dropped without sending
  fs.writeFileSync(`${tmp}/a2a/peer_outbox.json`, JSON.stringify([{ ...x, until: Date.now() - 1 }]));
  assert.equal(await P.outbox.flush(), 1); assert.equal(sent, 0); assert.equal(P.outbox.items().length, 0);
  P.outbox.handler = null;
});

test("a peer that does not answer is not reachable, at once", async () => {
  const t0 = Date.now();
  assert.equal(await P.reachable("http://127.0.0.1:9"), false);
  assert.ok(Date.now() - t0 < 4000);
  assert.equal(await P.reachable(null), false);
});

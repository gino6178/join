// Agent tokens: scopes the person chose, an expiry, and (optionally) a key every request must be signed with
// (HTTP Message Signatures, RFC 9421, as Web Bot Auth uses them)
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { makeToken, agentOf, can, tokensStore } from "../src/auth.js";

const k = crypto.generateKeyPairSync("ed25519"), x = k.publicKey.export({ format: "jwk" }).x;
// what a signing agent sends (examples/signed-agent.mjs does the same)
function signed(token, { method = "POST", host = "join.test", path = "/api/agent/find_options", body = '{"activity":"karaoke"}', created = Math.floor(Date.now() / 1000), key = k.privateKey } = {}) {
  const raw = Buffer.from(body), digest = `sha-256=:${crypto.createHash("sha256").update(raw).digest("base64")}:`;
  const params = `("@method" "@authority" "@path" "content-digest");created=${created};keyid="agent";alg="ed25519"`;
  const base = [`"@method": ${method}`, `"@authority": ${host}`, `"@path": ${path}`, `"content-digest": ${digest}`, `"@signature-params": ${params}`].join("\n");
  const sig = crypto.sign(null, Buffer.from(base), key).toString("base64");
  return { method, originalUrl: path, rawBody: raw, headers: { host, authorization: `Bearer ${token}`, "content-digest": digest, "signature-input": `sig1=${params}`, signature: `sig1=:${sig}:` } };
}

test("scopes: a read-only token reads and can't negotiate or pay; an expired token is refused", () => {
  tokensStore.reset();
  const t = makeToken("you", "reader", { scopes: ["read"] }), a = agentOf({ headers: { authorization: `Bearer ${t.token}` } });
  assert.deepEqual(a.scopes, ["read"]);
  assert.equal(can(a, "find_options"), true);
  assert.equal(can(a, "make_offer"), false);
  assert.equal(can(a, "pay_my_share"), false);
  const old = makeToken("you", "old", { days: 1 });
  tokensStore.data.tokens.find((x) => x.id === old.id).expires = new Date(Date.now() - 1000).toISOString();
  assert.equal(agentOf({ headers: { authorization: `Bearer ${old.token}` } }), null);
});

test("a token tied to a key needs every request signed: a good signature passes; no signature, a changed body, an old one or another key fail", () => {
  tokensStore.reset();
  const t = makeToken("you", "signer", { key: x });
  assert.equal(agentOf({ headers: { authorization: `Bearer ${t.token}` } }), null); // the token alone is useless
  assert.match(agentOf(signed(t.token)).client, /signed/);
  const tampered = signed(t.token); tampered.rawBody = Buffer.from('{"activity":"bbq"}');
  assert.equal(agentOf(tampered), null);
  assert.equal(agentOf(signed(t.token, { created: Math.floor(Date.now() / 1000) - 3600 })), null);
  assert.equal(agentOf(signed(t.token, { key: crypto.generateKeyPairSync("ed25519").privateKey })), null);
  const elsewhere = signed(t.token); elsewhere.headers.host = "evil.test";
  assert.equal(agentOf(elsewhere), null);
});

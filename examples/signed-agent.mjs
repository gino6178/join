// An agent that signs every request (HTTP Message Signatures, RFC 9421, as Web Bot Auth uses them), so its token is
// useless to anyone without its private key.
//   node signed-agent.mjs --key               make a key pair (signed-agent-key.json); paste the printed public key into
//                                             "Public key" when you make the token on Join's website (Connect)
//   JOIN_TOKEN=join_... node signed-agent.mjs  find karaoke options, signed
// JOIN_URL defaults to http://localhost:8790.
import crypto from "node:crypto";
import fs from "node:fs";

const FILE = process.env.AGENT_KEY_FILE || "signed-agent-key.json", JOIN = (process.env.JOIN_URL || "http://localhost:8790").replace(/\/$/, "");
if (process.argv.includes("--key")) {
  const k = crypto.generateKeyPairSync("ed25519");
  fs.writeFileSync(FILE, JSON.stringify({ private: k.privateKey.export({ format: "jwk" }) }), { mode: 0o600 });
  console.log(`public key (paste it into Join): ${k.publicKey.export({ format: "jwk" }).x}`);
  process.exit(0);
}
const priv = crypto.createPrivateKey({ key: JSON.parse(fs.readFileSync(FILE, "utf8")).private, format: "jwk" });

// a signed POST: the method, host, path and a digest of the exact body, with the time it was signed
async function signedPost(path, body) {
  const raw = JSON.stringify(body), url = new URL(`${JOIN}${path}`), created = Math.floor(Date.now() / 1000);
  const digest = `sha-256=:${crypto.createHash("sha256").update(raw).digest("base64")}:`;
  const params = `("@method" "@authority" "@path" "content-digest");created=${created};nonce="${crypto.randomUUID()}";keyid="${FILE}";alg="ed25519"`;
  const base = [`"@method": POST`, `"@authority": ${url.host}`, `"@path": ${url.pathname}`, `"content-digest": ${digest}`, `"@signature-params": ${params}`].join("\n");
  const signature = crypto.sign(null, Buffer.from(base), priv).toString("base64");
  const r = await fetch(url, { method: "POST", body: raw, headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.JOIN_TOKEN}`, "Content-Digest": digest, "Signature-Input": `sig1=${params}`, Signature: `sig1=:${signature}:` } });
  return { status: r.status, body: await r.json().catch(() => null) };
}

const r = await signedPost("/api/agent/find_options", { activity: "karaoke", players: 3 });
console.log(r.status, r.status === 200 ? `${r.body.options.length} options, signed request accepted` : r.body);

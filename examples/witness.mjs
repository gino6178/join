// A witness for Join's receipt log (c2sp.org/tlog-witness, in spirit): run by someone other than Join (a venue, for
// instance). It remembers the last checkpoint it cosigned, and cosigns a new one only if Join proves the new tree
// extends the old one (an RFC 6962 consistency proof). So once a witness has cosigned, Join can't rewrite or fork its
// history without this witness refusing. Shares no code with Join.
//
//   node witness.mjs --register     print this witness's name and public key, and ask Join to add it (demo mode, or
//                                   with ADMIN_TOKEN); run once
//   node witness.mjs                check the latest checkpoint and cosign it (run it every few minutes)
// JOIN_URL (default http://localhost:8790), WITNESS_NAME (default <host>/witness), WITNESS_STATE (default ./witness.json)
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";

const JOIN = (process.env.JOIN_URL || "http://localhost:8790").replace(/\/$/, "");
const NAME = process.env.WITNESS_NAME || `${os.hostname().toLowerCase()}.local/witness`;
const STATE = process.env.WITNESS_STATE || "witness.json";
const sha = (...p) => crypto.createHash("sha256").update(Buffer.concat(p.map((x) => Buffer.from(x)))).digest();
const node = (l, r) => sha([0x01], l, r);
const keyId = (name, type, pub) => sha(name, "\n", [type], pub).subarray(0, 4);

// state: our key (made once), Join's log key (trusted on first use), the last checkpoint we cosigned
const st = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : {};
if (!st.key) { const k = crypto.generateKeyPairSync("ed25519"); st.key = { priv: k.privateKey.export({ format: "jwk" }), pub: k.publicKey.export({ format: "jwk" }) }; }
const save = () => fs.writeFileSync(STATE, JSON.stringify(st, null, 2), { mode: 0o600 });
const get = async (p) => { const r = await fetch(`${JOIN}${p}`); if (!r.ok) throw new Error(`${p}: ${r.status}`); return p.endsWith("checkpoint") ? r.text() : r.json(); };

function parse(note) {
  const i = note.lastIndexOf("\n\n"), text = note.slice(0, i + 1), [origin, size, root] = text.split("\n");
  return { text, origin, size: +size, root: Buffer.from(root, "base64"), sigs: note.slice(i + 2).split("\n").filter(Boolean).map((l) => l.match(/^— (\S+) (\S+)$/)).filter(Boolean).map((m) => ({ name: m[1], sig: Buffer.from(m[2], "base64") })) };
}
// RFC 9162 §2.1.4.2
function consistent(size1, size2, proof, root1, root2) {
  if (size1 === size2) return proof.length === 0 && root1.equals(root2);
  if (size1 === 0) return true;
  if (size1 > size2 || !proof.length) return false;
  const path = (size1 & (size1 - 1)) === 0 ? [root1, ...proof] : proof;
  let fn = size1 - 1, sn = size2 - 1;
  while (fn % 2 === 1) { fn >>= 1; sn >>= 1; }
  let fr = path[0], sr = path[0];
  for (const c of path.slice(1)) {
    if (sn === 0) return false;
    if (fn % 2 === 1 || fn === sn) { fr = node(c, fr); sr = node(c, sr); while (fn % 2 === 0 && fn !== 0) { fn >>= 1; sn >>= 1; } } else sr = node(sr, c);
    fn >>= 1; sn >>= 1;
  }
  return sn === 0 && fr.equals(root1) && sr.equals(root2);
}

process.exitCode = await (async () => {
  if (process.argv.includes("--register")) {
    const r = await fetch(`${JOIN}/api/receipts/log/witnesses`, { method: "POST", headers: { "Content-Type": "application/json", ...(process.env.ADMIN_TOKEN ? { Authorization: `Bearer ${process.env.ADMIN_TOKEN}` } : {}) }, body: JSON.stringify({ name: NAME, jwk: st.key.pub }) });
    save(); console.log(`witness ${NAME}, public key ${st.key.pub.x}: ${r.ok ? "added to Join's log" : `Join said ${r.status}`}`); return r.ok ? 0 : 1;
  }
  const info = (await get("/.well-known/join-receipts.json")).log;
  st.logKey ||= info.key.jwk; st.origin ||= info.origin; // trusted on first use; a later change of key is refused
  if (info.key.jwk.x !== st.logKey.x || info.origin !== st.origin) { console.error("✘ Join's log key or origin changed: not cosigning"); return 1; }
  const cp = parse(await get("/api/receipts/log/checkpoint"));
  const mine = cp.sigs.find((s) => s.name === st.origin && s.sig.subarray(0, 4).equals(keyId(st.origin, 0x01, Buffer.from(st.logKey.x, "base64url"))));
  const pub = crypto.createPublicKey({ key: st.logKey, format: "jwk" });
  if (!mine || !crypto.verify(null, Buffer.from(cp.text), pub, mine.sig.subarray(4))) { console.error("✘ the checkpoint isn't signed by Join's log key"); return 1; }
  const last = st.last || { size: 0, root: null };
  if (cp.size < last.size) { console.error(`✘ the log shrank (${last.size} -> ${cp.size}): not cosigning`); return 1; }
  if (last.size > 0) {
    const c = await get(`/api/receipts/log/consistency?from=${last.size}&to=${cp.size}`);
    if (!consistent(last.size, cp.size, c.proof.map((x) => Buffer.from(x, "base64")), Buffer.from(last.root, "base64"), cp.root)) { console.error(`✘ size ${cp.size} does not extend the size ${last.size} this witness cosigned: not cosigning`); return 1; }
  }
  // cosign (c2sp.org/tlog-cosignature, Ed25519, type 0x04: timestamp || signature)
  const time = Math.floor(Date.now() / 1000), ts = Buffer.alloc(8); ts.writeBigUInt64BE(BigInt(time));
  const sig = crypto.sign(null, Buffer.from(`cosignature/v1\ntime ${time}\n${cp.text}`), crypto.createPrivateKey({ key: st.key.priv, format: "jwk" }));
  const line = `— ${NAME} ${Buffer.concat([keyId(NAME, 0x04, Buffer.from(st.key.pub.x, "base64url")), ts, sig]).toString("base64")}`;
  const r = await fetch(`${JOIN}/api/receipts/log/cosign`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: NAME, line }) });
  st.last = { size: cp.size, root: cp.root.toString("base64"), at: new Date().toISOString() }; save();
  console.log(`${r.ok ? "✔" : "✘"} ${last.size ? `checked consistency ${last.size} -> ${cp.size}, ` : ""}cosigned checkpoint size ${cp.size} as ${NAME}${r.ok ? "" : ` (Join said ${r.status})`}`);
  return r.ok ? 0 : 1;
})();

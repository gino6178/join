// The small pieces receipts need, written out so a verifier can repeat them exactly:
//   canonical  JSON with object keys sorted at every level (so the same receipt always hashes the same)
//   merkle     a binary SHA-256 Merkle tree over hex hashes; each pair is hashed in sorted order, so a proof is just
//              the list of sibling hashes from the leaf up, and an odd node is carried up unchanged
import crypto from "node:crypto";

export const sha256 = (s) => crypto.createHash("sha256").update(typeof s === "string" ? s : Buffer.from(s)).digest("hex");
export const canonical = (v) => (v === null || typeof v !== "object" ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`);
const pair = (a, b) => sha256(Buffer.from(a < b ? a + b : b + a, "hex"));

export function merkle(leaves) {
  const levels = [leaves.slice()];
  while (levels.at(-1).length > 1) {
    const cur = levels.at(-1), next = [];
    for (let i = 0; i < cur.length; i += 2) next.push(i + 1 < cur.length ? pair(cur[i], cur[i + 1]) : cur[i]);
    levels.push(next);
  }
  return {
    root: levels.at(-1)[0],
    proof(index) {
      const path = [];
      for (let l = 0, i = index; l < levels.length - 1; l++, i = Math.floor(i / 2)) { const sib = i ^ 1; if (sib < levels[l].length) path.push(levels[l][sib]); }
      return path;
    },
  };
}
merkle.verify = (leaf, path, root) => path.reduce((h, sib) => pair(h, sib), leaf) === root;

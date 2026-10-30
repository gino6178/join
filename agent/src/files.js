// Files a player shares in Messenger (a photo, a voice note, a health export) are fetched only from Facebook's own file
// servers: a redirect is followed only to another of them, the download has a time limit, and the size cap is checked
// as the bytes arrive, not after the whole file is in memory.
//   MESSENGER_FILE_RX  the allowed URLs (default: https on *.fbcdn.net and *.fbsbx.com)
export const DEFAULT_FILES = "^https://[\\w.-]+\\.(fbcdn\\.net|fbsbx\\.com)/";
export const FILES = new RegExp(process.env.MESSENGER_FILE_RX || DEFAULT_FILES);

export async function fetchFile(url, max, { hops = 3, ms = 60000 } = {}) {
  const mb = `${Math.round(max / 1e6)} MB`;
  for (let i = 0; i <= hops; i++) {
    if (!FILES.test(url)) throw new Error("that link is not on Messenger's file servers");
    const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(ms) });
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) { url = new URL(r.headers.get("location"), url).href; continue; }
    if (!r.ok) throw new Error(`download failed (${r.status})`);
    if (+(r.headers.get("content-length") || 0) > max) throw new Error(`over ${mb}`);
    const parts = [];
    let n = 0;
    for await (const c of r.body) { n += c.length; if (n > max) throw new Error(`over ${mb}`); parts.push(c); }
    return Buffer.concat(parts);
  }
  throw new Error("too many redirects");
}

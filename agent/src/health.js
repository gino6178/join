// Your health app's data, organized by your agent. The app (or Messenger, when you share a file to the chat) sends an
// export to this gateway on your own server; health_import.py reads it (Apple Health, Google Fit Takeout, or one GPX,
// TCX or CSV file from any app) and the file is deleted as soon as it is read. What comes back is your workouts (with
// heart rate, energy, distance and GPS route) and your daily steps, resting heart rate and sleep; body.js then links
// the workouts to your booked games and works out your load. HEALTH_PYTHON (default python3) and HEALTH_MAX_MB
// (default 800) can be set.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "health_import.py");
const MAX = +(process.env.HEALTH_MAX_MB || 800) * 1e6;
const clean = (s) => String(s || "export").replace(/[^\w.\- ]/g, "").slice(0, 80) || "export";

// read a file already on disk (a Messenger attachment) or the request body (the app's upload)
export async function read(src, { name = "export", days = 120, tz = 480 } = {}) {
  const out = src + ".json";
  try {
    await new Promise((ok, bad) => {
      const p = spawn(process.env.HEALTH_PYTHON || "python3", ["-I", SCRIPT, src, out, clean(name), String(+days || 120), String(Math.round(+tz) || 0)]);
      let err = "";
      p.stderr.on("data", (c) => { err = (err + c).slice(-3000); });
      p.on("error", bad);
      p.on("close", (code) => (code === 0 ? ok() : bad(new Error(`The file could not be read (${err.trim().split("\n").pop() || `exit ${code}`}).`))));
    });
    return JSON.parse(fs.readFileSync(out, "utf8"));
  } finally { fs.rmSync(out, { force: true }); }
}

export async function upload(req, send, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "health-")), src = path.join(dir, "in");
  try {
    let n = 0;
    await new Promise((ok, bad) => {
      const f = fs.createWriteStream(src);
      req.on("data", (c) => { n += c.length; if (n > MAX) { req.destroy(); bad(new Error(`The file is over ${MAX / 1e6} MB.`)); } });
      req.on("error", bad); f.on("error", bad); f.on("finish", ok);
      req.pipe(f);
    });
    send({ type: "step", step: "Received your export", tool: "upload", detail: `${(n / 1e6).toFixed(1)} MB, on your own server only; deleted once read` });
    send({ type: "working", step: "Reading your workouts and daily numbers" });
    const r = await read(src, opts);
    send({ type: "step", step: `Read ${r.source}`, tool: "health", detail: `${r.counts.workouts} workouts (${r.counts.routes} with a GPS route) and ${r.counts.days} days of steps, heart rate and sleep` });
    return r;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// a file shared to the Messenger chat: Messenger gives a URL to download it from
export async function fromUrl(url, name, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "health-")), src = path.join(dir, "in");
  try {
    // the caller's downloader if it has one (Messenger's: its own file servers only, the cap checked as it streams)
    let buf;
    if (opts.fetchBytes) buf = await opts.fetchBytes(url, MAX, { ms: 120000 });
    else {
      const r = await fetch(url, { signal: AbortSignal.timeout(120000) });
      if (!r.ok) throw new Error(`download failed (${r.status})`);
      buf = Buffer.from(await r.arrayBuffer());
    }
    if (buf.length > MAX) throw new Error(`The file is over ${MAX / 1e6} MB.`);
    fs.writeFileSync(src, buf);
    return await read(src, { name, ...opts });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

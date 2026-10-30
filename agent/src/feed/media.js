// Photos and clips for the feed: what a file is (from its first bytes, not from what the sender says it is), and what
// leaves with it. A photo is kept as JPEG without its metadata (EXIF, XMP and the rest, where a phone writes the place
// it was taken); a clip is copied without its metadata, without sound, and with a cover frame, by ffmpeg when the
// server has it (FFMPEG, default "ffmpeg"), at the lowest CPU priority.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export const LIMITS = { photo: 6e6, clip: 40e6, seconds: 60, upload: 100e6, uploadSeconds: 90 };
export function sniff(b) {
  if (!b || b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  if (b.toString("latin1", 4, 8) === "ftyp") return "video/mp4";
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video/webm";
  return null;
}

// a JPEG without its application segments (APP1 to APP13: EXIF, XMP, ICC and the rest) or comments; the size read
// from its frame header. Returns null when it is not a JPEG it can read.
export function cleanJpeg(b) {
  if (sniff(b) !== "image/jpeg") return null;
  const keep = [b.subarray(0, 2)];
  let i = 2, w = null, h = null;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xff) { i++; continue; }
    if (marker === 0xd9) { keep.push(b.subarray(i, i + 2)); break; }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { keep.push(b.subarray(i, i + 2)); i += 2; continue; }
    const len = b.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > b.length) return null;
    const seg = b.subarray(i, i + 2 + len);
    if ([0xc0, 0xc1, 0xc2, 0xc3].includes(marker) && len >= 7) { h = b.readUInt16BE(i + 5); w = b.readUInt16BE(i + 7); }
    const app = marker >= 0xe1 && marker <= 0xed, comment = marker === 0xfe;
    if (!app && !comment) keep.push(seg);
    i += 2 + len;
    if (marker === 0xda) { keep.push(b.subarray(i)); break; } // the image data, to the end
  }
  return w && h ? { bytes: Buffer.concat(keep), w, h } : null;
}

const FFMPEG = () => process.env.FFMPEG || "ffmpeg";
function run(cmd, args, timeoutMs = 120000) {
  return new Promise((ok, no) => {
    const win = process.platform === "win32", p = spawn(win ? cmd : "nice", win ? args : ["-n", "19", cmd, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err = (err + d).slice(-3000)));
    p.on("error", (e) => { clearTimeout(t); no(e); });
    p.on("close", (code) => { clearTimeout(t); code === 0 ? ok(out) : no(new Error(`${path.basename(cmd)} stopped (${code}): ${err.trim().split("\n").pop() || ""}`)); });
  });
}
let hasFfmpeg = null;
export const resetFfmpeg = () => { hasFfmpeg = null; }; // (tests: FFMPEG changed)
export async function ffmpegReady() {
  if (hasFfmpeg != null) return hasFfmpeg;
  try { await run(FFMPEG(), ["-hide_banner", "-version"], 10000); hasFfmpeg = true; } catch { hasFfmpeg = false; }
  return hasFfmpeg;
}
// how long a video runs, in seconds (ffprobe), or null when it can't be read
export async function duration(bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feed-")), src = path.join(dir, "in");
  try {
    fs.writeFileSync(src, bytes);
    const out = await run(process.env.FFPROBE || "ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", src], 30000);
    const s = parseFloat(out);
    return Number.isFinite(s) ? s : null;
  } catch { return null; } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
// the GPU's free memory in MiB (nvidia-smi), or null when there is no GPU to ask
export async function gpuFree(index = process.env.REEL_GPU || "0") {
  try { const out = await run("nvidia-smi", ["--query-gpu=memory.free", "--format=csv,noheader,nounits", "-i", String(index)], 10000); const n = parseInt(out, 10); return Number.isFinite(n) ? n : null; } catch { return null; }
}
// a clip as the feed keeps it: MP4, no sound, no metadata, at most 720 px tall and LIMITS.seconds long, from `from`
// seconds for `seconds` (the whole clip when not given); and a JPEG cover frame `cover` seconds in
export async function clip(bytes, { from = null, seconds = null, cover = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feed-")), src = path.join(dir, "in"), out = path.join(dir, "out.mp4"), poster = path.join(dir, "poster.jpg");
  try {
    fs.writeFileSync(src, bytes);
    const len = Math.min(LIMITS.seconds, seconds || LIMITS.seconds);
    await run(FFMPEG(), ["-hide_banner", "-loglevel", "error", "-y", ...(from != null ? ["-ss", String(Math.max(0, from))] : []), "-i", src, "-t", String(len), "-an", "-map_metadata", "-1", "-map_chapters", "-1",
      "-vf", "scale=-2:'min(720,ih)'", "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out]);
    await run(FFMPEG(), ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(Math.max(0, cover ?? 0.5)), "-i", out, "-frames:v", "1", "-q:v", "4", "-map_metadata", "-1", poster]).catch(() => run(FFMPEG(), ["-hide_banner", "-loglevel", "error", "-y", "-i", out, "-frames:v", "1", "-q:v", "4", poster]));
    const c = cleanJpeg(fs.readFileSync(poster));
    return { bytes: fs.readFileSync(out), type: "video/mp4", poster: c?.bytes || null, w: c?.w ?? null, h: c?.h ?? null };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

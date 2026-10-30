// The gateway's JSON stores on disk. A write goes to a temporary file that is then renamed over the old one, so a
// crash mid-write (the resume test kills the gateway with SIGKILL) leaves the old file or the new one, never half of
// one. A file that still cannot be read (a disk fault, a hand edit) is moved aside as <file>.bad-<time> and the store
// starts empty, rather than the gateway failing to start.
import fs from "node:fs";
import path from "node:path";

export function readJSON(file, empty) {
  if (!fs.existsSync(file)) return empty;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) {
    const aside = `${file}.bad-${Date.now()}`;
    try { fs.renameSync(file, aside); } catch { /* leave it */ }
    console.error(`${path.basename(file)} could not be read (${e.message}); moved aside to ${path.basename(aside)}, starting empty`);
    return empty;
  }
}
export function writeJSON(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

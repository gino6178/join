// The platform's JSON stores on disk. A write goes to a temporary file that is renamed over the old one, so a crash
// mid-write leaves the old file or the new one, never half of one. A file that can't be read is moved aside as
// <file>.bad-<time> and the store starts from its default.
import fs from "node:fs";
import path from "node:path";

export function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) {
    if (e.code !== "ENOENT") try { fs.renameSync(file, `${file}.bad-${Date.now()}`); } catch {}
    return structuredClone(fallback);
  }
}

export function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try { fs.writeSync(fd, JSON.stringify(value, null, 1)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

// Where the stores live: api/data/state/<name>.json, so a restart keeps every negotiation, booking, token and payment.
// JOIN_STATE_DIR moves them; JOIN_STATE_DIR=memory (and the test runner) keeps them in memory only.
const STATE = process.env.JOIN_STATE_DIR || path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../data/state");
export const stateFile = (name) => (STATE === "memory" || process.env.NODE_TEST_CONTEXT ? null : path.join(STATE, `${name}.json`));

// One store: a JSON object kept in memory and written through on every change. Tests pass file = null to keep it in
// memory only.
export function store(file, fallback) {
  let data = file ? readJSON(file, fallback) : structuredClone(fallback);
  return {
    get data() { return data; },
    save() { if (file) writeJSON(file, data); },
    reset(value = fallback) { data = structuredClone(value); this.save(); },
  };
}

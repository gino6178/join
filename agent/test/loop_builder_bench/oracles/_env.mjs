// Shared by the oracles: they check a worktree (WT) the builder made, importing its modules by path, with every data
// file in a temp folder, the guards off and no model (an oracle that needs one starts a fake on loopback).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const WT = process.env.WT;
if (!WT) throw new Error("WT (the worktree to check) is not set");
export const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "serve-oracle-"));
for (const k of ["ASK_FILE", "AUTOPILOT_FILE", "BOOKINGS_FILE", "FEEDBACK_FILE", "KB_FILE", "LEDGER_FILE", "MEMORY_FILE", "MESSENGER_FILE", "MESSENGER_SEEN_FILE", "NEGOTIATIONS_FILE", "PLACES_FILE", "PLAYBOOK_FILE", "STORE_FILE", "TRACE_FILE", "A2A_FILE"])
  process.env[k] = path.join(tmpDir, `${k.toLowerCase()}.json`);
// (the loop's own files too: places.js reads its radius from loop/flags.js)
Object.assign(process.env, { A2A_DATA: path.join(tmpDir, "a2a"), LOOP_DIR: path.join(tmpDir, "loop"), GUARD: "off", PROMPT_GUARD: "off", MEMORY: "off", GOOGLE_MAPS_API_KEY: "" });
process.env.LLM_URL ||= "http://127.0.0.1:9/v1";
export const load = (rel) => import(pathToFileURL(path.join(WT, rel)).href);
export const source = (rel) => fs.readFileSync(path.join(WT, rel), "utf8");
// the text of one method or function, from its first line to the next definition at the same indent
export function body(src, start) {
  const i = src.indexOf(start);
  if (i < 0) return "";
  const indent = /^\s*/.exec(src.slice(src.lastIndexOf("\n", i) + 1, i + 1))[0].length;
  const lines = src.slice(i).split("\n"), out = [lines[0]];
  for (const l of lines.slice(1)) { const d = /^\s*/.exec(l)[0].length; if (l.trim() && d <= indent && /^\s*(async\s+)?[\w$]+\s*\(|^\s*(export\s+)?(async\s+)?function\b|^\s*\}[,;]?\s*$/.test(l)) { if (/^\s*\}/.test(l)) out.push(l); break; } out.push(l); }
  return out.join("\n");
}

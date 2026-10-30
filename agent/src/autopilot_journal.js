// The Autopilot's journal: one file per run (data/autopilot_runs/<run id>.jsonl, beside AUTOPILOT_FILE), one JSON line
// per durable step, each written and flushed to disk before the run goes on (write-ahead, as in durable execution).
//   start     what the run was asked (the week, the goal, the body log, the time it started): enough to run it again
//   memory    the notes found for the week (so a resumed run plans from the same notes)
//   turn      a model turn: the tool calls Muse Glimmer asked for (or none), before any of them runs
//   call      a tool call with a side effect, before it runs: a talk with its id (the A2A contextId), the approval
//   done      a tool call's result, and what it changed in the run (the games agreed, who was tried, ...)
//   summary   the run's last sentence, as checked
//   notifying / notified   the approval message, before and after it goes out
// A run cut off by a restart is run again from its start record (autopilot.js resumeRuns): every turn and tool call
// already in the journal comes back from it (the model is not asked again, the tool does not run again), a talk cut off
// mid-way is picked up by its id (a2a.js resumeNegotiation: the members' agents answer from their saved answers, and
// the holds are the same holds), and the approval message goes out once. A finished run's journal is removed.
// The journal holds what the run itself holds (the body log among it), so it stays on this machine, in data/, and goes
// with /forget.
import fs from "node:fs";
import path from "node:path";

export const dir = () => path.resolve(process.env.AUTOPILOT_RUNS_DIR || (process.env.AUTOPILOT_FILE || "data/autopilot.json").replace(/\.json$/, "") + "_runs");
const fileOf = (id) => path.join(dir(), `${String(id).replace(/[^\w-]/g, "")}.jsonl`);

// the lines of one journal; a last line cut off mid-write (a crash) is left out
export function read(id) {
  let text = "";
  try { text = fs.readFileSync(fileOf(id), "utf8"); } catch { return null; }
  const out = [];
  for (const l of text.split("\n")) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch { break; } }
  return out;
}

// a journal to write to, with what an earlier process wrote in it, indexed for replay
export function open(id, entries = null) {
  const file = fileOf(id), old = entries || read(id) || [];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const turns = {}, calls = {}, once = {};
  for (const e of old) {
    if (e.k === "turn") turns[e.i] = e;
    else if (e.k === "call") (calls[e.seq] ||= {}).intent = e;
    else if (e.k === "done") (calls[e.seq] ||= {}).done = e;
    else once[e.k] = e;
  }
  return {
    id, file, resumed: old.length > 0, start: once.start || null, turns, calls, once,
    rec(k, data = {}) {
      const e = { k, at: Date.now(), ...data };
      const fd = fs.openSync(file, "a");
      try { fs.writeSync(fd, JSON.stringify(e) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      if (k === "turn") turns[e.i] = e; else if (k === "call") (calls[e.seq] ||= {}).intent = e; else if (k === "done") (calls[e.seq] ||= {}).done = e; else once[k] = e;
      return e;
    },
    close() { if (process.env.AUTOPILOT_KEEP_JOURNAL !== "1") fs.rmSync(file, { force: true }); },
  };
}

// the runs whose journal has no end: cut off by a restart
export function unfinished() {
  let names = [];
  try { names = fs.readdirSync(dir()).filter((f) => f.endsWith(".jsonl")); } catch { return []; }
  return names.map((f) => f.slice(0, -6)).map((id) => ({ id, entries: read(id) || [] })).filter((r) => r.entries[0]?.k === "start" && !r.entries.some((e) => e.k === "end"));
}
export const remove = (id) => fs.rmSync(fileOf(id), { force: true });
// how far a run has got, for the app (its stream ended with the gateway): the steps done, the last one
export function progress(id) {
  const es = read(id);
  if (!es) return null;
  const done = es.filter((e) => e.k === "done");
  return { steps: done.length, turns: es.filter((e) => e.k === "turn").length, last: done.at(-1)?.step || null, resumed: es.filter((e) => e.k === "resumed").length, ended: es.some((e) => e.k === "end") };
}

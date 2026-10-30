// The student: a cheaper tier for a member's agent's one real choice (A2A_STUDENT, on by default; A2A_STUDENT=off to
// compare). When the proposed time breaks the member's calendar or a hard rule and two or more listed times keep them,
// a small Meta model (Llama 3.2 1B or 3B Instruct, distilled from Muse Glimmer's answers, int4 on the GPU server's CPU:
// jev/worker.py on port 11447) picks the time in one forward pass, with no text written: a probability for each declared
// option (ask for one of the times that work, or can't play this week) and, for every time shown, whether it works.
//   - Code keeps every hard rule (a2a.js breaks): the options are only the times that keep them, so the student can only
//     choose among times that work, and never breaks a member's rules.
//   - It answers when its pick's probability reaches A2A_STUDENT_SURE and its own reading of which times work matches
//     code's. Otherwise, or when the worker is down, busy with others (A2A_STUDENT_MAX_WAIT_MS) or slower than
//     A2A_STUDENT_TIMEOUT_MS, Muse Glimmer answers as before, so the talk never stops on it.
//   - Only for a member whose hard limits are all in code (rulesComplete, as for routing): a limit only in the member's
//     words is Glimmer's to keep.
// Every call goes in the token ledger (site a2a.student), so what it saves is counted. docs/decision_model.md.
import { record } from "./ledger.js";
import { helpers } from "./play.js";

const { hm } = helpers;
export const studentOn = () => process.env.A2A_STUDENT !== "off";
const URL_ = () => (process.env.A2A_STUDENT_URL || "http://127.0.0.1:11447").replace(/\/$/, "");
// 0.6, for the 1B student the worker serves by default: the point on the curve that saves the most Glimmer calls while
// its agreement with Glimmer stays within about 5 points of Glimmer's own, and the member's stated preference holds
// (0.5 for the 3B student). docs/decision_model.md has the curve.
const SURE = () => +(process.env.A2A_STUDENT_SURE || 0.6);
// how long a decision may take on the worker in all, and how long it may wait there for the one before it (the worker
// answers one at a time; one that would wait longer is turned away at once, and Glimmer answers it)
const WAIT = () => +(process.env.A2A_STUDENT_TIMEOUT_MS || 20000), QUEUE = () => +(process.env.A2A_STUDENT_MAX_WAIT_MS || 8000);
const tripOf = (x, m) => x.trip ?? x.c?.travel?.find((t) => t.id === m.id)?.min ?? null;
// a worker that could not be reached is not asked again for a minute (each try would only add its connect time)
let downUntil = 0;
export const studentStats = { asked: 0, answered: 0, unsure: 0, mismatch: 0, errors: 0 };

// m: the member; cur: the proposed time; ok: the listed times that keep the member's calendar and rules (by code);
// all: every listed time; profile: what the member's agent reads about its member. Returns a decision in fullAnswer's
// shape (without its sentence), or null for Muse Glimmer.
export async function studentAnswer(m, cur, ok, all, { minutes = 90, format, sport, profile }) {
  if (!m.rulesComplete || !cur?.id || all.some((x) => !x.id) || Date.now() < downUntil) return null;
  const alts = ok.filter((x) => x !== cur);
  if (alts.length < 2) return null;
  const them = m.name.split(" ")[0];
  // (the worker answers one decision at a time on a shared CPU, so several at once queue there; it skips a request
  // whose deadline has passed, so a decision this side stopped waiting for costs it nothing)
  const offers = [cur, ...all.filter((x) => x !== cur)].map((x) => ({ id: x.id, text: x.text, trip: tripOf(x, m), date: x.slot.date, start: hm(x.start) }));
  const body = { profile, name: them, sport, format, minutes, cur: cur.id, offers, works: alts.map((x) => x.id), deadline: Date.now() + WAIT(), max_wait_ms: QUEUE() };
  studentStats.asked++;
  const t0 = Date.now();
  let r;
  try {
    const res = await fetch(`${URL_()}/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(WAIT()) });
    r = await res.json();
    if (!res.ok || !r.pick) throw new Error(r.error || `worker ${res.status}`);
  } catch (e) {
    studentStats.errors++;
    if (/ECONNREFUSED|fetch failed/.test(String(e.cause?.code || e.message))) downUntil = Date.now() + 60000;
    record({ site: "a2a.student", model: "student", prompt: 0, cached: 0, output: 0, reasoning: 0, seconds: +((Date.now() - t0) / 1000).toFixed(3), error: String(e.message || e).slice(0, 120) });
    return null;
  }
  // its own reading of which listed times work, against code's
  const said = new Set(Object.entries(r.works_p || {}).filter(([, p]) => p >= 0.5).map(([t]) => t)), truth = new Set(body.works);
  const read = said.size === truth.size && [...truth].every((t) => said.has(t));
  const sure = r.pick.p >= SURE();
  record({ site: "a2a.student", model: r.model || "student", prompt: r.tokens || 0, cached: r.reused || 0, output: 0, reasoning: 0, seconds: +((Date.now() - t0) / 1000).toFixed(3), workerMs: r.ms, workerQueuedMs: r.queued_ms, confidence: r.pick.p, used: sure && read });
  if (!read) { studentStats.mismatch++; return null; }
  if (!sure) { studentStats.unsure++; return null; }
  studentStats.answered++;
  const tier = { tier: "student", confidence: +r.pick.p.toFixed(3) };
  if (r.pick.kind === "decline") return { intent: "decline", date: "", start: "", works: [], ...tier };
  const x = alts.find((y) => y.id === r.pick.id);
  if (!x) return null;
  return { intent: "counter", date: x.slot.date, start: hm(x.start), works: alts.map((y) => y.id), ...tier };
}

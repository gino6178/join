// Notes that can be updated and partly forgotten (memory.js; docs/privacy_budget.md, "Forgetting"). When the player
// tells their agent something new, it is checked against the older notes it may change, in the manner of Mem0's
// add / update / no-op on write (Chhikara et al., 2025) and Zep's facts that stop being valid without being deleted
// (Rasmussen et al., 2025):
//   1. Code finds the older notes it may be about: the closest by meaning (DRAMA), and every live note that names the
//      same club member or weekday. A note with none of those, and no weekday, person or date in it, is simply added
//      (no model call).
//   2. Muse Glimmer reads the new note and those (labelled n1..n6, with the day each was said; no tools) and answers in
//      a JSON Schema: add, update (which older notes it makes untrue) or same; the rule the new note asks for (leave a
//      member out, no games on a weekday, or none); and the last day it holds, if the player said one.
//   3. Code checks it: a note it replaces must share a subject with the new one (the same member, the same weekday, the
//      same place, or close in meaning); a rule's member must be a club member named in the new note's own words, its
//      weekday one the note names; a last day must be a real date, after today, within a year, and only from a note
//      that speaks of a time. What fails a check is dropped, and said so (refused).
// A replaced note is kept, marked replaced (when, and by which note), and never recalled again; the Memory page shows
// it struck through. A note past its last day has expired the same way. The rules of live notes are compiled into the
// Autopilot's plan by code (autopilot.js: a member left out, a weekday off), so a rule can only take options away.
// The notes are the player's own words; nothing another agent wrote is a note (no memory injection: MINJA, Dong et
// al., 2025).
import { chatJSON } from "./llm.js";
import { readClub } from "./club.js";

export const norm = (t) => String(t || "").toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "");
const DAY_RE = [["Sun", /\bsun(day)?s?\b/], ["Mon", /\bmon(day)?s?\b/], ["Tue", /\btue(s|sday)?s?\b/], ["Wed", /\bwed(nesday)?s?\b/], ["Thu", /\bthu(rs?|rsday)?s?\b/], ["Fri", /\bfri(day)?s?\b/], ["Sat", /\bsat(urday)?s?\b/]];
export const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = "jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t|tember)?|oct(ober)?|nov(ember)?|dec(ember)?";
// a note that speaks of a time: a date, a month, "until", "this month", "for two weeks"...
const TIMEISH = new RegExp(`\\b(\\d{1,2}(st|nd|rd|th)?|${MONTHS}|until|till|through|end of|this (week|month|season|weekend)|next (week|month)|for (a|one|two|three|four|a few|\\d+) (days?|weeks?|months?)|tomorrow|tonight|today)\\b`);
const club = () => { try { return readClub(); } catch { return { members: [] }; } };
// the club members a text names (first name, or full name), as ids
export function people(text, members = club().members) {
  const t = ` ${norm(text).replace(/[^\p{L}\p{N}]+/gu, " ")} `;
  return members.filter((m) => [m.name, m.name.split(" ")[0]].some((n) => t.includes(` ${norm(n)} `))).map((m) => m.id);
}
export function daysIn(text) {
  const t = norm(text), out = DAY_RE.filter(([, re]) => re.test(t)).map(([d]) => d);
  if (/\bweekends?\b/.test(t)) out.push("Sat", "Sun");
  return [...new Set(out)];
}
export const timeish = (text) => TIMEISH.test(norm(text));
// the places a text names (the club's venues, by a word of their name)
const placeWords = (text, venues) => { const t = norm(text); return venues.filter((v) => t.includes(norm(v.split(" ")[0]))).map((v) => v); };
const ymd = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

export const UPDATE = {
  type: "object", additionalProperties: false, required: ["op", "replaces", "rule", "until"],
  properties: {
    op: { enum: ["add", "update", "same"] },
    replaces: { type: "array", maxItems: 6, items: { type: "string", pattern: "^n[1-6]$" } },
    rule: { type: "object", additionalProperties: false, required: ["kind"], properties: { kind: { enum: ["none", "avoid_person", "avoid_day"] }, who: { type: "string", maxLength: 40 }, day: { type: "string", maxLength: 9 } } },
    until: { type: "string", maxLength: 10, pattern: "^(\\d{4}-\\d{2}-\\d{2})?$" },
  },
};
// does the new note ask code anything (a member, a weekday, a time), or sit near older notes?
export const worthAsking = (note, cands) => cands.length > 0 || people(note.text).length > 0 || daysIn(note.text).length > 0 || timeish(note.text);

// note: { text, at, about }; cands: [{ id, text, at, about, rule, cos }] (live notes, closest first). Returns
// { op, replaces: [ids], rule, until, by, refused: [reasons] }
// (the unit tests stand in for the model: useAsk(fn), fn(messages, schema, opts) -> { value })
let askModel = chatJSON;
export const useAsk = (fn) => { askModel = fn || chatJSON; };
export async function decide(note, cands, { venues = [], ask = askModel } = {}) {
  const today = ymd(note.at || Date.now()), members = club().members, by = "Muse Glimmer, checked by code";
  const out = { op: "add", replaces: [], rule: null, until: null, by: "code", refused: [] };
  if (!worthAsking(note, cands)) return out;
  const labelled = cands.slice(0, 6).map((c, i) => ({ ...c, label: `n${i + 1}` }));
  const sys = `You keep the notes a player's sports agent works from. Today is ${today} (${DAYS[new Date(note.at || Date.now()).getDay()]}). Club members: ${members.map((m) => m.name.split(" ")[0]).join(", ")}.
A new note from the player: "${note.text}"
${labelled.length ? `Older notes that may be about the same thing:\n${labelled.map((c) => `${c.label} (said ${ymd(c.at)}): "${c.text}"`).join("\n")}` : "There are no older notes about it."}
Answer in JSON:
- "op": "update" if the new note makes one or more older notes no longer true (list their labels in "replaces"); "same" if it only says again what an older note says; otherwise "add" (and "replaces": []).
- "rule": what the agent must do because of the NEW note itself: {"kind": "avoid_person", "who": first name} if the player asks to leave a club member out or not to play with them; {"kind": "avoid_day", "day": "Mon".."Sun"} if they ask for no games on a weekday; otherwise {"kind": "none"}.
- "until": the last day (YYYY-MM-DD) the new note holds, only if the player said when it ends (a date, "until the end of the month", "this week", a trip's last day); otherwise "".`;
  let r;
  try { r = await ask([{ role: "system", content: sys }, { role: "user", content: "Return the JSON." }], UPDATE, { site: "memory.update", maxTokens: 160, temperature: 0, timeoutMs: +(process.env.MEMORY_UPDATE_TIMEOUT_MS || 90000) }); } catch { r = null; }
  if (!r?.value) return { ...out, refused: ["the model gave no answer in the format: the note is added as it is"] };
  const v = r.value, mine = new Set(note.about || people(note.text, members)), days = daysIn(note.text);
  out.by = by;
  // the notes it replaces: offered ones that share a subject with the new note
  for (const l of [...new Set(v.replaces || [])]) {
    const c = labelled.find((x) => x.label === l);
    if (!c) { out.refused.push(`${l} was not offered`); continue; }
    const shares = (c.about || []).some((id) => mine.has(id)) || daysIn(c.text).some((d) => days.includes(d)) || placeWords(c.text, venues).some((p) => placeWords(note.text, venues).includes(p)) || (c.cos ?? 0) >= 0.6;
    if (shares) out.replaces.push(c.id); else out.refused.push(`"${c.text.slice(0, 60)}" shares no subject with the new note`);
  }
  out.op = v.op === "update" ? (out.replaces.length ? "update" : "add") : v.op === "same" ? (labelled.some((c) => (c.cos ?? 0) >= 0.75) ? "same" : "add") : "add";
  if (v.op === "same" && out.op === "add") out.refused.push("not close enough to an older note to be the same");
  if (out.op === "same") out.replaces = [];
  // the rule: a member named in the note's own words, a weekday it names
  const k = v.rule?.kind;
  if (k === "avoid_person") {
    const m = members.find((x) => norm(x.name.split(" ")[0]) === norm(v.rule.who) || norm(x.name) === norm(v.rule.who));
    if (m && mine.has(m.id)) out.rule = { kind: k, who: m.id, name: m.name.split(" ")[0] };
    else out.refused.push(`a rule for "${String(v.rule.who || "").slice(0, 30)}", who is not a club member the note names`);
  } else if (k === "avoid_day") {
    const d = DAYS.find((x) => norm(x) === norm(String(v.rule.day || "")).slice(0, 3));
    if (d && days.includes(d)) out.rule = { kind: k, day: d };
    else out.refused.push(`a rule for "${String(v.rule.day || "").slice(0, 9)}", a weekday the note does not name`);
  }
  // the last day: a real date, after today, within a year, from a note that speaks of a time
  if (v.until) {
    const t = Date.parse(`${v.until}T23:59:59`), now = note.at || Date.now();
    if (!Number.isFinite(t) || ymd(t) !== v.until) out.refused.push(`${v.until} is not a date`);
    else if (t < now || t > now + 366 * 864e5) out.refused.push(`${v.until} is not between today and a year from now`);
    else if (!timeish(note.text)) out.refused.push(`a last day (${v.until}) from a note that names no time`);
    else out.until = v.until;
  }
  return out;
}

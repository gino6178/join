// Body log: you tell your agent what hurts, in the app or in Messenger ("my right knee is sore after jumping"), and it
// keeps the record: which part, which side, how bad (0 to 5), and what set it off. Muse Glimmer reads the words (one
// tool call, checked by code: the part must be one of PARTS, the level 0 to 5); without the model a word list does the
// same. From that record, your games and the workouts from your health app, code works out:
//   - your training load (minutes x effort, per day) and this week against your last four: a week over 1.5 times your
//     usual load is when soreness tends to follow, so the Autopilot plans one game fewer
//   - a limit for the Autopilot while something is sore: lower body, doubles first and no jump sports; upper body,
//     doubles first; back, shorter games; sore after long games, games kept to 90 minutes
//   - when to ask again ("How is your right knee today?"), and when to say it is worth seeing a physio: the same part
//     at 4 or 5 twice in two weeks, or logged on three days in two weeks without getting better
// It records what you tell it and plans your games around it. It does not diagnose or treat anything.
import { chat, chatTools } from "./llm.js";
import { okNums, allowedIn } from "./a2a.js";

export const PARTS = {
  neck: { name: "Neck", region: "traps", at: "top", group: "back" },
  shoulder: { name: "Shoulder", region: "deltoid", at: "center", group: "upper", sided: true },
  elbow: { name: "Elbow", region: "forearm", at: "top", group: "upper", sided: true },
  wrist: { name: "Wrist", region: "forearm", at: "bottom", group: "upper", sided: true },
  upperback: { name: "Upper back", region: "traps", at: "center", group: "back" },
  lowerback: { name: "Lower back", region: "lowback", at: "center", group: "back" },
  chest: { name: "Chest", region: "pecs", at: "center", group: "upper" },
  core: { name: "Side and core", region: "obliques", at: "center", group: "back" },
  hip: { name: "Hip and groin", region: "hipflex", at: "center", group: "lower", sided: true },
  glute: { name: "Glute", region: "glutes", at: "center", group: "lower", sided: true },
  thigh: { name: "Thigh", region: "quads", at: "center", group: "lower", sided: true },
  hamstring: { name: "Hamstring", region: "hams", at: "center", group: "lower", sided: true },
  knee: { name: "Knee", region: "quads", at: "bottom", group: "lower", sided: true },
  shin: { name: "Shin", region: "shin", at: "center", group: "lower", sided: true },
  calf: { name: "Calf", region: "calves", at: "center", group: "lower", sided: true },
  achilles: { name: "Achilles", region: "calves", at: "bottom", group: "lower", sided: true },
  ankle: { name: "Ankle", region: "shin", at: "bottom", group: "lower", sided: true },
  foot: { name: "Foot", region: "shin", at: "bottom", group: "lower", sided: true },
};
const KINDS = ["pain", "sore", "tight", "injury", "fine"];
const WORDS = [
  [/\bknees?\b|\bkneecap|\bpatell/i, "knee"], [/\bankles?\b/i, "ankle"], [/\bachilles\b/i, "achilles"], [/\bcal(f|ves)\b/i, "calf"],
  [/\bshins?\b/i, "shin"], [/\bfoot\b|\bfeet\b|\bheels?\b|\barch\b|\bplantar\b|\btoes?\b/i, "foot"], [/\bhamstrings?\b|\bhammies\b/i, "hamstring"],
  [/\bthighs?\b|\bquads?\b|\bquadriceps\b/i, "thigh"], [/\bhips?\b|\bgroin\b|\badductors?\b/i, "hip"], [/\bglutes?\b|\bbutt(ocks?)?\b/i, "glute"],
  [/\blow(er)? back\b|\blumbar\b/i, "lowerback"], [/\bupper back\b|\bshoulder blades?\b/i, "upperback"], [/\bneck\b/i, "neck"],
  [/\bshoulders?\b|\brotator\b/i, "shoulder"], [/\belbows?\b/i, "elbow"], [/\bwrists?\b|\bforearms?\b/i, "wrist"], [/\bchest\b|\bpecs?\b/i, "chest"],
  [/\babs\b|\bobliques?\b|\bcore\b|\bribs?\b|\bside stitch\b/i, "core"], [/\bback\b/i, "lowerback"],
];
const SAID_FINE = /\b(fine|feels? (good|great|ok|okay|normal)|no (pain|soreness)|all good|better now|recovered|healed|back to normal)\b/i;
const kindOf = (t) => SAID_FINE.test(t) && !/\bnot (fine|ok|okay|better)\b/i.test(t) ? "fine"
  : /\b(twist|rolled|sprain|pulled|strain|tore|torn|popped|swollen)/i.test(t) ? "injury" : /\b(tight|stiff)/i.test(t) ? "tight" : /\b(sore|aching|achy)\b/i.test(t) ? "sore" : "pain";
// a level the player stated ("3 out of 5", "four out of five", "7/10"), on the 0 to 5 scale, or null
const NUM = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const num = (w) => (/^\d+$/.test(w) ? +w : NUM[w.toLowerCase()]);
// (not a score or a count: "3 out of 5 games", "10/10 game"; not a date: "since 3/5", "3/5/2026")
export function statedLevel(t) {
  t = String(t);
  const rx = /\b(\d{1,2}|zero|one|two|three|four|five|six|seven|eight|nine|ten)\s*(\/|out of|outta)\s*(5|five|10|ten)\b(?![\/\d])(?!\s*(?:games?|sets?|points?|matches|rallies|people|players|courts?|days?|nights?|mornings?|evenings?|weeks?|times|sessions?|serves?|shots?|smashes|drills?|reps?|tries|runs?|hours?|minutes?|mins?|km|miles?)\b)/gi;
  for (const m of t.matchAll(rx)) {
    // a date: "since 3/5", "on Tuesday 4/5"
    if (m[2] === "/" && /\b(since|on|from|until|by|before|after|date|mon|tues?|wed|thu|thur|thurs|fri|sat|sun)(day)?\.?,?\s*$/i.test(t.slice(0, m.index))) continue;
    const n = num(m[1]), of = num(m[3]);
    if (n <= of) return of === 5 ? n : Math.min(5, Math.round(n / 2));
  }
  return null;
}
// the words of a message about one body part, where its level is said: the clause that names it, with the clauses
// around it that name no other part ("my knee is sore after jumping, about 3 out of 5"; "shoulder 2/5 and knee 4/5")
const partsIn = (c) => WORDS.filter(([rx]) => rx.test(c)).map(([, p]) => p);
export const clauseOf = (text, part) => {
  const cs = text.split(/(?:\.|;|,|\bbut\b|\band\b)/i), i = cs.findIndex((c) => partsIn(c).includes(part));
  if (i < 0) return text;
  let a = i, b = i + 1;
  while (a > 0 && !partsIn(cs[a - 1]).length) a--;
  while (b < cs.length && !partsIn(cs[b]).some((p) => p !== part)) b++;
  return cs.slice(a, b).join(",");
};
function levelOf(t, kind) {
  if (kind === "fine") return 0;
  const said = statedLevel(t);
  if (said != null) return said;
  if (/\b(can'?t (walk|play|run|lift|move)|unbearable|limping|swollen)\b/i.test(t)) return 5;
  if (/\b(really|very|a lot|badly|bad|sharp|worse|stabbing)\b/i.test(t)) return 4;
  if (/\b(a (little|bit)|slight(ly)?|mild|minor|bit of)\b/i.test(t)) return 2;
  return kind === "tight" || kind === "sore" ? 2 : 3;
}
const sideOf = (t) => /\bboth\b/i.test(t) ? "both" : /\bleft\b/i.test(t) ? "left" : /\bright\b/i.test(t) ? "right" : null;
const triggerOf = (t) => (t.match(/\b(?:after|when|from|since|during)\s+([^,.;!?]{3,40})/i) || [])[1]?.trim() || null;

// does this message talk about the body? (a part, and how it feels)
export const about = (t) => WORDS.some(([rx]) => rx.test(t)) && /\b(hurt|hurts|pain|painful|sore|ache|aching|achy|tight|stiff|twist|rolled|sprain|pulled|strain|swollen|tender|injur|niggle|fine|better|recovered|feels?)\b/i.test(t);

// the word-list reading, one entry per part named
function byWords(text) {
  const parts = text.split(/(?:\.|;|,\s*(?:and|but)\s+|\bbut\b|\band my\b)/i), out = [];
  for (const p of parts) for (const [rx, part] of WORDS) if (rx.test(p) && !out.some((e) => e.part === part && e.side === sideOf(p))) {
    if (part === "lowerback" && out.some((e) => e.part === "upperback")) continue;
    const kind = kindOf(p);
    out.push({ part, side: PARTS[part].sided ? sideOf(p) || sideOf(text) : null, kind, level: levelOf(p, kind), trigger: triggerOf(p) || triggerOf(text) });
    break;
  }
  return out;
}

const LOG_TOOL = [{ type: "function", function: { name: "log_body", description: "File what the player says about their body.", parameters: { type: "object", properties: { entries: { type: "array", items: { type: "object", properties: {
  part: { type: "string", enum: Object.keys(PARTS) }, side: { type: "string", enum: ["left", "right", "both", "none"] }, kind: { type: "string", enum: KINDS },
  level: { type: "integer", description: "0 fine, 1 barely, 2 a bit, 3 hurts, 4 bad, 5 cannot play" }, trigger: { type: "string", description: "what set it off, in the player's words, or empty" } },
  required: ["part", "kind", "level"] } } }, required: ["entries"] } } }];

// what the player said, as log entries: Muse Glimmer's reading if it checks out, otherwise the word list's
export async function read(text, now = new Date()) {
  const words = byWords(text);
  let entries = [], by = "rules";
  try {
    const out = await chatTools([
      { role: "system", content: "You file what a player tells their sports agent about their body. Call log_body once, one entry per body part they mention. Use only what they said: no guesses about causes, no advice. Level: 0 fine, 1 barely, 2 a bit, 3 hurts, 4 bad, 5 cannot play." },
      { role: "user", content: text },
    ], LOG_TOOL, { maxTokens: 300, temperature: 0 });
    const got = out.calls.find((c) => c.name === "log_body")?.args?.entries || [];
    entries = got.filter((e) => PARTS[e.part] && KINDS.includes(e.kind)).map((e) => ({
      part: e.part, side: PARTS[e.part].sided && ["left", "right", "both"].includes(e.side) ? e.side : null, kind: e.kind,
      // a level the player stated is a fact, and wins over the model's reading
      // (from the clause that names this part, so each part keeps its own; a pain is at least 1)
      level: e.kind === "fine" ? 0 : Math.max(1, statedLevel(clauseOf(text, e.part)) ?? Math.min(5, Math.round(+e.level || 0) || levelOf(text, e.kind))),
      // a trigger must be words the player wrote
      trigger: e.trigger && text.toLowerCase().includes(String(e.trigger).toLowerCase().slice(0, 40)) ? String(e.trigger).slice(0, 40) : null,
    }));
    // the model named a part the player did not: keep only parts the words also find, when the words find any
    if (words.length) entries = entries.filter((e) => words.some((w) => w.part === e.part) || !WORDS.some(([, p]) => p === e.part));
    if (entries.length) by = "model";
  } catch { /* the model is down: the word list reads it */ }
  if (!entries.length) entries = words;
  const at = now.toISOString();
  return { by, entries: entries.map((e, i) => ({ id: `b${now.getTime().toString(36)}${i}`, at, ...e, note: text.slice(0, 200) })) };
}

// ---- organizing: sessions, load, parts, and what the agent does about them ---------------------------------------
const DAY_MS = 864e5;
const ymd = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
const dayOf = (s) => new Date(`${s}T12:00:00`);
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const EFFORT = { badminton: 7, tennis: 6, squash: 8, basketball: 7, soccer: 7, volleyball: 6, pickleball: 5, "table tennis": 4, running: 7, cycling: 6, hiit: 8, strength: 6, swimming: 6, hiking: 5, walking: 3, yoga: 3 };
const GAME = new Set(["badminton", "tennis", "squash", "basketball", "soccer", "volleyball", "pickleball", "table tennis"]);
const effortOf = (s) => s.avgHr ? Math.max(3, Math.min(9, (s.avgHr - 60) / 12)) : EFFORT[s.sport] ?? 5;
export const keyOf = (e) => `${e.part}${e.side ? ":" + e.side : ""}`;
export const nameOf = (e) => `${e.side && e.side !== "both" ? e.side + " " : e.side === "both" ? "both " : ""}${PARTS[e.part]?.name.toLowerCase() || e.part}${e.side === "both" && !/s$/.test(e.part) ? "s" : ""}`;
const KIND_WORD = { pain: "pain", sore: "sore", tight: "tight", injury: "injured", fine: "fine" };

// games (from the club and the app) and workouts (from a health app), one list: a workout that starts within an hour of
// a booked game is that game, so the game takes the watch's minutes and heart rate
export function sessions(games = [], workouts = []) {
  const out = games.map((g) => ({ date: g.date, start: g.start || null, minutes: g.played || g.booked || 90, booked: g.booked || null, sport: g.sport || "badminton", with: g.with || [], format: g.format || null, source: "Serve game" }));
  const linked = [];
  for (const w of workouts) {
    const g = out.find((s) => s.source === "Serve game" && s.date === w.date && (!s.start || !w.start || Math.abs(toMin(s.start) - toMin(w.start)) <= 60) && (s.sport === w.sport || !GAME.has(w.sport) && w.sport === "other"));
    if (g) {
      const was = g.minutes;
      Object.assign(g, { minutes: w.minutes || g.minutes, avgHr: w.avgHr ?? g.avgHr, maxHr: w.maxHr ?? g.maxHr, kcal: w.kcal ?? g.kcal, from: w.source });
      linked.push({ date: g.date, start: g.start, sport: g.sport, with: g.with, booked: g.booked, was, minutes: g.minutes, source: w.source });
      continue;
    }
    if (out.some((s) => s.date === w.date && s.start && w.start && Math.abs(toMin(s.start) - toMin(w.start)) <= 10 && s.sport === w.sport)) continue; // the same workout twice
    out.push({ ...w });
  }
  return { list: out.sort((a, b) => (b.date + (b.start || "")).localeCompare(a.date + (a.start || ""))), linked };
}
const toMin = (s) => { const [h, m] = String(s).split(":").map(Number); return h * 60 + (m || 0); };

export function organize({ log = [], games = [], workouts = [], days = [], now = new Date() } = {}) {
  const today = ymd(now), since = (n) => ymd(new Date(now.getTime() - n * DAY_MS));
  const { list, linked } = sessions(games, workouts);
  const recent = list.filter((s) => s.date >= since(120) && s.date <= today);
  // load: minutes x effort (the session-RPE method), per day; this week against the average week of the last four
  const daily = {};
  for (const s of recent) daily[s.date] = (daily[s.date] || 0) + Math.round((s.minutes || 0) * effortOf(s));
  const sum = (from, to) => Object.entries(daily).filter(([d]) => d > from && d <= to).reduce((a, [, v]) => a + v, 0);
  const acute = sum(since(7), today), chronic = sum(since(28), today) / 4;
  const acwr = chronic > 0 ? +(acute / chronic).toFixed(2) : null;
  // weeks, Monday first, last eight: minutes by sport and load
  const monday = (d) => { const x = dayOf(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return ymd(x); };
  const weeks = {};
  for (let i = 7; i >= 0; i--) weeks[monday(since(i * 7))] = { week: monday(since(i * 7)), minutes: 0, load: 0, sessions: 0, sports: {} };
  for (const s of recent) { const w = weeks[monday(s.date)]; if (!w) continue; w.minutes += s.minutes || 0; w.load += Math.round((s.minutes || 0) * effortOf(s)); w.sessions++; w.sports[s.sport] = (w.sports[s.sport] || 0) + (s.minutes || 0); }

  // parts: every entry for one part and side, newest last
  const groups = {};
  for (const e of [...log].sort((a, b) => a.at.localeCompare(b.at))) (groups[keyOf(e)] ||= []).push(e);
  const parts = Object.entries(groups).map(([key, es]) => {
    const latest = es.at(-1), before = es.filter((e) => e.at.slice(0, 10) >= since(14)).slice(0, -1);
    const prev = before.at(-1), trend = !prev ? "new" : latest.level < prev.level ? "better" : latest.level > prev.level ? "worse" : "same";
    const ageDays = (now - new Date(latest.at)) / DAY_MS;
    return { key, part: latest.part, side: latest.side, name: nameOf(latest), group: PARTS[latest.part]?.group, latest, trend, entries: es, active: latest.kind !== "fine" && latest.level >= 2 && ageDays <= 10, ageDays };
  }).sort((a, b) => b.latest.at.localeCompare(a.latest.at));

  // what the agent does, and why: every number here is from the log or the sessions
  const actions = [], plan = { limit: null, avoid: [], format: null, capMinutes: null, perWeekDelta: 0, pause: [] };
  const active = parts.filter((p) => p.active);
  const lower = active.filter((p) => p.group === "lower"), upper = active.filter((p) => p.group === "upper"), back = active.filter((p) => p.group === "back");
  const list3 = (ps) => ps.map((p) => `your ${p.name}`).join(" and ");
  if (lower.length) {
    plan.avoid.push("basketball", "volleyball"); plan.format = "doubles";
    actions.push({ kind: "limit", text: `While ${list3(lower)} settle${lower.length > 1 ? "" : "s"}: doubles first and no jump sports in the games I line up.`, why: lower.map((p) => `${p.name} ${p.latest.level}/5 on ${DOW[new Date(p.latest.at).getDay()]}`).join(", ") });
  }
  if (upper.length) {
    plan.format = "doubles";
    if (!plan.avoid.includes("volleyball")) plan.avoid.push("volleyball");
    actions.push({ kind: "limit", text: `While ${list3(upper)} settle${upper.length > 1 ? "" : "s"}: doubles first, so there is less overhead hitting.`, why: upper.map((p) => `${p.name} ${p.latest.level}/5`).join(", ") });
  }
  if (back.length) {
    plan.capMinutes = 60;
    actions.push({ kind: "cap", text: `While ${list3(back)} settle${back.length > 1 ? "" : "s"}, I'll keep games to 60 minutes.`, why: back.map((p) => `${p.name} ${p.latest.level}/5`).join(", ") });
  }
  // sore the day after long games: the same part, twice, within 36 hours of a session over 100 minutes
  for (const p of active) {
    const afterLong = p.entries.filter((e) => e.kind !== "fine" && recent.some((s) => s.minutes >= 100 && (new Date(e.at) - dayOf(s.date)) / 36e5 >= 0 && (new Date(e.at) - dayOf(s.date)) / 36e5 <= 36));
    if (afterLong.length >= 2 && !plan.capMinutes) {
      plan.capMinutes = 90;
      actions.push({ kind: "cap", text: `Your ${p.name} was sore after ${afterLong.length} games that ran past 100 minutes: I'll keep games to 90 minutes for now.`, why: `${afterLong.length} entries the day after a long game` });
    }
  }
  // worth seeing a physio: twice at 4 or 5 in two weeks, or three days in two weeks without getting better
  for (const p of parts) {
    const two = p.entries.filter((e) => e.at.slice(0, 10) >= since(14) && e.kind !== "fine");
    const bad = two.filter((e) => e.level >= 4).length, days3 = new Set(two.filter((e) => e.level >= 2).map((e) => e.at.slice(0, 10))).size;
    if (p.latest.kind !== "fine" && (bad >= 2 || (days3 >= 3 && p.trend !== "better"))) {
      p.physio = true;
      const sports = p.group === "lower" ? ["basketball", "volleyball", "badminton singles"] : p.group === "upper" ? ["volleyball", "tennis"] : [];
      plan.pause.push(...sports.filter((s) => !plan.pause.includes(s)));
      actions.push({ kind: "physio", text: `Your ${p.name} has ${bad >= 2 ? `been bad (4 or 5) ${bad} times` : `been sore on ${days3} days`} in two weeks${p.trend === "better" ? "" : " and isn't getting better"}. It is worth seeing a physio${sports.length ? `; until you tell me it's fine I'll keep ${sports.join(", ")} off your week` : ""}.`, why: `${two.length} entries in 14 days` });
    }
  }
  // a load spike: this week is over 1.5 times the average week of the last four, judged only with enough sessions to
  // know the usual week (eight in four weeks: a watch's workouts, not just two club games a week)
  const n28 = recent.filter((s) => s.date > since(28)).length;
  if (acwr != null && acwr > 1.5 && acute >= 300 && n28 >= 8) {
    plan.perWeekDelta = -1;
    actions.push({ kind: "load", text: `This week's load is ${acwr} times your four-week average: I'll line up one game fewer.`, why: `${acute} this week vs ${Math.round(chronic)} a week on average (minutes x effort)` });
  }
  // only what the watch adds: a game that ran longer than the club's record of it
  for (const l of linked.filter((x) => x.booked && x.minutes - x.booked >= 15 && x.minutes - x.was >= 10))
    actions.push({ kind: "learned", text: `Your ${l.source} data says ${DOW[dayOf(l.date).getDay()]}'s ${l.sport} game ran ${l.minutes} minutes (booked ${l.booked}): that group goes first next time.`, why: `matched to the booked game at ${l.start} on ${l.date}` });
  // when to ask again: two days after the latest entry of each part still sore
  const followUps = active.map((p) => { const d = new Date(new Date(p.latest.at).getTime() + 2 * DAY_MS); return { key: p.key, name: p.name, date: ymd(d), due: ymd(d) <= today, text: `How is your ${p.name} today?` }; });
  for (const f of followUps.filter((x) => !x.due)) actions.push({ kind: "follow", text: `I'll ask about your ${f.name} on ${DOW[dayOf(f.date).getDay()]}.`, why: "two days after you logged it" });
  plan.limit = [lower.length && "no jump landings", upper.length && "easy on overhead", back.length && "short games"].filter(Boolean).join(", ") || null;

  const metrics = days.filter((d) => d.date >= since(56)).sort((a, b) => a.date.localeCompare(b.date));
  return { today, sessions: recent, weeks: Object.values(weeks), load: { acute, chronic: Math.round(chronic), acwr, daily: Object.entries(daily).filter(([d]) => d > since(42)).sort().map(([date, load]) => ({ date, load })) },
    parts, actions, plan, followUps, linked, days: metrics };
}

// the reply when something is logged: what was filed and what changes, from code
export function said(entries, org) {
  const filed = entries.map((e) => e.kind === "fine" ? `${nameOf(e)}, fine` : `${nameOf(e)}, ${KIND_WORD[e.kind]} ${e.level}/5${e.trigger ? ` (${e.trigger})` : ""}`);
  const keys = new Set(entries.map(keyOf)), changes = org.actions.filter((a) => a.kind !== "learned" && (a.kind === "load" || org.parts.some((p) => keys.has(p.key) && a.text.includes(p.name))));
  const cleared = entries.filter((e) => e.kind === "fine");
  return [`Logged: ${filed.join("; ")}.`, ...changes.map((a) => a.text), cleared.length && !changes.length ? "Good to hear. Nothing held back on that any more." : null].filter(Boolean).join("\n");
}

// the report's summary, written by Muse Glimmer from the facts only; every number in it must be in the facts
export async function summary(org) {
  const facts = [
    `Period: the last 4 weeks to ${org.today}.`,
    `Sessions: ${org.weeks.slice(-4).reduce((a, w) => a + w.sessions, 0)}, ${org.weeks.slice(-4).reduce((a, w) => a + w.minutes, 0)} minutes.`,
    org.load.acwr != null ? `This week's load is ${org.load.acwr} times the four-week average.` : "",
    ...org.parts.slice(0, 4).map((p) => `${p.name}: latest ${p.latest.kind === "fine" ? "fine" : `${KIND_WORD[p.latest.kind]} ${p.latest.level}/5`}, ${p.entries.length} entr${p.entries.length > 1 ? "ies" : "y"}, ${{ new: "first time logged", better: "getting better", worse: "getting worse", same: "about the same" }[p.trend]}.`),
    ...org.actions.map((a) => `Agent: ${a.text}`),
  ].filter(Boolean).join("\n");
  const rules = `${org.parts.filter((p) => p.active).length ? `Still sore: ${org.parts.filter((p) => p.active).map((p) => p.name).join(", ")}. ` : "Nothing sore right now. "}${org.actions.filter((a) => a.kind !== "follow").map((a) => a.text).slice(0, 2).join(" ")}`.trim();
  // two drafts at most; one that uses a number not in the facts, or names a condition or a treatment, is thrown away
  for (const temperature of [0.3, 0.1]) {
    try {
      const { text } = await chat([
        { role: "system", content: "Write the summary at the top of a player's body report for their sports club app, from the facts only: two or three short sentences, under 60 words in all, plain English, second person; call the agent \"your agent\". Say what was logged, the trend, and what your agent changed. No advice beyond the facts, no diagnosis, no causes. Use only numbers that appear in the facts, written as digits." },
        { role: "user", content: facts },
      ], { maxTokens: 160, temperature });
      const t = text.replace(/\s+/g, " ").trim();
      if (t && okNums(t, allowedIn(facts)) && !/\b(diagnos|tendinitis|tendonitis|fracture|tear|strain|sprain|ibuprofen|ice it|physiotherapy exercise)\w*/i.test(t)) return { text: t, by: "model", facts };
    } catch { break; }
  }
  return { text: rules, by: "rules", facts };
}

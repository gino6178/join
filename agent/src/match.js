// Best match, and your agent talking to theirs.
// best(): your agent ranks every member for a game this week. Code scores what has to be exact: a fair game by club
//   rating (a win chance near 50%), a shared free time, the trip to the venue in the middle, format and health limits,
//   and history.
//   Muse Glimmer explains the top pick, and every number it uses must come from the scores.
// talk(): your agent proposes a game to the other member's agent. Each side's message is written by Muse Glimmer: yours
//   from your calendar and the courts, theirs from what that member shares with their agent (free times, preferences,
//   limits). Every time a side proposes is checked by code against both calendars and the venues' free courts; a
//   proposal that does not fit is answered with the facts, never booked. When both agents agree, the result is an
//   option the player can book, and the other member's agent has already said yes.
// The demo club's members and their agents are made up (web/public/data/club.json).
import { chat } from "./llm.js";
import { readClub } from "./club.js";
import { demoVenues, helpers } from "./play.js";
import { negotiate, okNums, PRONOUN } from "./a2a.js";

const { windows, travelMin, kmBetween, ymd, hm, toMin, dateOf, readVenues, DAYS } = helpers;
const first = (n) => n.split(" ")[0];
const expect = (a, b) => 1 / (1 + 10 ** ((b - a) / 400));
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const when = (date, start) => { const d = dateOf(date); return `${DAYS[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]} ${start}`; };

// the times two people are both free in the next week, at least 90 minutes, earliest first
function shared(a, b, now = new Date()) {
  const out = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(now); d.setDate(d.getDate() + i);
    const wa = windows(a).filter((w) => w.day === d.getDay()), wb = windows(b).filter((w) => w.day === d.getDay());
    for (const x of wa) for (const y of wb) {
      const f = Math.max(x.from, y.from, i === 0 ? Math.ceil((now.getHours() * 60 + now.getMinutes() + 60) / 30) * 30 : 0), t = Math.min(x.to, y.to);
      if (t - f >= 90) out.push({ date: ymd(d), day: DAYS[d.getDay()], from: f, to: t });
    }
  }
  return out;
}
// for one time: the venue with a free court where the longer of the two trips is shortest
function court(slot, start, minutes, people, venues) {
  const date = dateOf(slot.date), out = [];
  for (const v of venues.venues) {
    const courts = demoVenues.freeCourts(v, date, start, minutes);
    if (!courts.length) continue;
    const travel = people.filter((p) => p.area).map((p) => ({ id: p.id, name: p.name, min: travelMin(p.area, v), km: +kmBetween(p.area, v).toFixed(1) }));
    out.push({ v, court: courts[0], courtsFree: courts.length, travel, longest: Math.max(0, ...travel.map((t) => t.min)) });
  }
  return out.sort((a, b) => a.longest - b.longest)[0] || null;
}

// ---- best match -------------------------------------------------------------------------------------------------
export async function best({ you = {}, ratings = {}, played = {}, format = "singles", onStep } = {}) {
  const tell = (s) => onStep?.({ type: "step", ...s }), work = (step) => onStep?.({ type: "working", step });
  const club = readClub(), venues = readVenues(), me = { id: "you", name: "You", area: club.you.area, free: club.you.free };
  const r = (id) => ratings[id] ?? (id === "you" ? club.you.rating : club.members.find((m) => m.id === id)?.rating ?? 1500);
  const limit = you.limit || null;
  tell({ step: "Read your profile", tool: "profile", detail: `club rating ${r("you")}${limit ? `, health limit: ${limit}` : ""}` });
  work(`Scoring ${club.members.length} members`);
  const rows = [];
  for (const m of club.members) {
    const plays = m.prefers === "any" || m.prefers === format;
    const times = shared(club.you.free, m.free);
    if (!times.length) { rows.push({ m, out: "no shared free time this week" }); continue; }
    const t0 = times[0], c = court(t0, t0.from, 90, [me, m], venues);
    const p = expect(r("you"), r(m.id)), fair = 1 - Math.abs(0.5 - p) * 2;
    const n = played[m.id] || 0;
    const parts = [
      { k: "fair", w: 3 * fair, text: `win chance ${Math.round(p * 100)}%` },
      { k: "time", w: Math.min(1, times.length / 3), text: `both free ${t0.day} ${hm(t0.from)}–${hm(t0.to)}${times.length > 1 ? ` and ${times.length - 1} more` : ""}` },
      { k: "trip", w: c ? -0.04 * c.longest : -1, text: c ? `${c.v.name}: you ${c.travel.find((x) => x.id === "you")?.min} min, ${first(m.name)} ${c.travel.find((x) => x.id === m.id)?.min} min` : "no free court then" },
      { k: "format", w: plays ? 0.5 : -2, text: plays ? `likes ${format}` : `prefers ${m.prefers}` },
      limit && m.limit && { k: "health", w: 0.3, text: `also plays with a limit (${m.limit})` },
      { k: "history", w: n ? (n >= 3 ? -0.3 : 0.2) : 0.3, text: n ? `you have played ${n} time${n > 1 ? "s" : ""}` : "a new opponent for you" },
    ].filter(Boolean);
    const score = parts.reduce((a, x) => a + x.w, 0);
    rows.push({ m, score, parts, slot: t0, chance: Math.round(p * 100) });
  }
  const ranked = rows.filter((x) => x.score != null).sort((a, b) => b.score - a.score);
  const max = ranked[0]?.score ?? 1, min = ranked.at(-1)?.score ?? 0;
  const top = ranked.slice(0, 3).map((x) => ({ id: x.m.id, name: x.m.name, level: x.m.level, rating: r(x.m.id), chance: x.chance,
    fit: Math.round(60 + 40 * ((x.score - min) / Math.max(0.01, max - min))), parts: x.parts.sort((a, b) => b.w - a.w).map(({ k, text, w }) => ({ k, text, good: w > 0 })) }));
  tell({ step: "Scored every member", tool: "score", detail: `${ranked.length} of ${club.members.length} share a free time with you; scored on a fair game by rating, the trip, format, health and history` });
  if (!top.length) return { top, why: "Nobody shares a free time with you this week.", by: "rules" };
  // Muse Glimmer says why, in two sentences, with only the numbers in the scores
  work("Muse Glimmer is explaining the pick");
  const t = top[0], facts = t.parts.map((p) => p.text);
  const allowed = new Set(facts.join(" ").match(/\d+(?:[.:]\d+)?/g) || []);
  let why = `${first(t.name)}: ${facts.slice(0, 3).join(", ")}.`, by = "rules";
  const pct = facts.flatMap((f) => f.match(/\d+%/g) || []);
  try {
    const res = await chat([{ role: "system", content: `You are a badminton player's agent. Tell the player why ${first(t.name)} is their best match this week, in at most two short, natural sentences and 40 words, from the three strongest of these facts (keep each number exactly as given):
${facts.map((f) => `- ${f}`).join("\n")}
Speak to the player as "you"; call the other player "${first(t.name)}", never "he" or "she". Keep every % sign. Do not combine two facts into a new claim. English only. Plain text.` }, { role: "user", content: "Why?" }], { maxTokens: 160, temperature: 0.3 });
    const text = res.text.trim().replace(/^"|"$/g, "");
    const good = text && okNums(text.replace(/%/g, ""), allowed) && !PRONOUN.test(text) && pct.every((p) => !text.includes(p.slice(0, -1)) || text.includes(p)) && text.split(/\s+/).length <= 55;
    if (good) { why = text; by = "model"; }
  } catch { /* the rule-based sentence */ }
  tell({ step: by === "model" ? "Muse Glimmer explained the pick" : "Explained the pick", tool: "verify", detail: by === "model" ? "every number in it checked against the scores" : "checked template text" });
  return { top, why, by, format };
}

// ---- agent to agent ---------------------------------------------------------------------------------------------
// one member's agent, through the same engine the Autopilot uses for a doubles four (a2a.js)
export async function talk({ with: id, format = "singles", sport = "badminton", you = {}, onStep } = {}) {
  const say = (m) => onStep?.({ type: "a2a", ...m, to: Array.isArray(m.to) ? m.to[0] : m.to }), tell = (s) => onStep?.({ type: "step", ...s }), work = (step) => onStep?.({ type: "working", step });
  const club = readClub(), venues = readVenues(), m = club.members.find((x) => x.id === id);
  if (!m) throw new Error("unknown member");
  const me = { id: "you", name: "You", area: club.you.area, free: club.you.free };
  tell({ step: `Opened a channel to ${first(m.name)}'s agent`, tool: "a2a", detail: "agent to agent over A2A: only the times, the court and the trip cross; your limits stay with your agent" });
  const r = await negotiate({ me, members: [m], venues, format, sport, limit: you.limit, say, tell, work, who: "app" });
  if (!r.agreed && !r.rounds) throw new Error(r.reason.replace(/^./, (c) => c.toUpperCase()) + ".");
  return { agreed: r.agreed, log: r.log, with: { id: m.id, name: m.name }, reason: r.agreed ? undefined : r.reason, calendars: r.calendars, cards: r.cards };
}

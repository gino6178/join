// Your agent's answer to a message that is not a command, a calendar entry, a finished session or something that
// hurts: a question about your week, your games, the club or what Serve can do. It answers from what it knows about
// you and nothing else: your calendar and booked games, the games you played, your body log, what you told it, and the
// club. Those facts are numbered for the model; every number in its answer must be one of theirs (or one you wrote).
// A draft that fails the check is written again once, and then the agent says the facts it has instead.
// It is your agent, not a coach: it plans games, it does not analyse technique or prescribe training.
import { chat } from "./llm.js";
import { readClub } from "./club.js";
import { organize } from "./body.js";
import * as life from "./life.js";
import * as store from "./store.js";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_MS = 864e5;
const dateOf = (s) => { const [y, m, d] = String(s).split("-").map(Number); return new Date(y, m - 1, d); };
const monday = (d) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const list = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}` : xs[0] || "");

// what the agent knows: a Messenger player's record (store.js), or what the app sends with the club's record of you
function knownOf({ player = null, app = null }) {
  const club = readClub();
  const goal = +(player?.prefs?.goal?.perWeek || app?.goal?.perWeek || club.you?.goal?.perWeek || 2);
  if (player) {
    const games = (player.events || []).filter((e) => e.kind === "match");
    return { club, goal, played: player.games || [], logs: player.logs || [], booked: games, calendar: (player.events || []).filter((e) => e.kind !== "match"), body: player.body || {}, notes: (player.memories || []).map((m) => m.text), player };
  }
  const booked = (app?.upcoming || []).filter((u) => u?.date).map((u) => ({ date: String(u.date), start: String(u.start || ""), with: (u.with || []).map(String), title: "" }));
  return { club, goal, played: [...(club.you?.history || []), ...(app?.history || [])], logs: [], booked, calendar: [], body: app?.body || {}, notes: [], player: null };
}

// the facts, each one sentence; the numbers in them are the only numbers the answer may use
export function factsFor({ player = null, app = null, now = new Date() } = {}) {
  const k = knownOf({ player, app }), { club } = k, F = [];
  const name = (id) => club.members.find((m) => m.id === id)?.name.split(" ")[0] || id;
  const when = (e) => `${DAYS[dateOf(e.date).getDay()]} ${e.date}${e.start ? ` at ${e.start}` : ""}`;
  const add = (key, text) => F.push({ id: `F${F.length + 1}`, key, text });
  add("today", `Today is ${DAYS[now.getDay()]} ${life.ymd(now)}.`);
  const soon = k.booked.filter((e) => new Date(`${e.date}T${e.start || "23:59"}`) >= now && dateOf(e.date) < new Date(now.getTime() + 7 * DAY_MS))
    .sort((a, b) => `${a.date} ${a.start}`.localeCompare(`${b.date} ${b.start}`));
  if (soon.length) {
    const n = soon[0];
    add("next", `Your next game: ${when(n)}${n.title ? `, ${n.title}` : n.with?.length ? `, with ${list(n.with.map(name))}` : ""}.`);
    add("booked", `Games booked in the next 7 days: ${soon.length}.`);
  } else add("next", "No game is booked in the next 7 days.");
  const cal = k.calendar.filter((e) => new Date(`${e.date}T${e.start || "23:59"}`) >= now && dateOf(e.date) < new Date(now.getTime() + 7 * DAY_MS));
  if (cal.length) add("calendar", `Also in your calendar this week: ${cal.slice(0, 5).map((e) => `${e.title} ${when(e)}`).join("; ")}.`);
  add("goal", `Your goal: ${plural(k.goal, "game")} a week.`);
  // played: the record of games, by week (this week is week 0)
  const weekOf = (d) => Math.round((monday(now) - monday(dateOf(d))) / (7 * DAY_MS));
  const per = Array(9).fill(0);
  for (const g of k.played) { const w = weekOf(g.date); if (w >= 0 && w <= 8) per[w]++; }
  add("week", `Games played so far this week: ${per[0]}.`);
  let streak = 0;
  for (let w = 1; w <= 8 && per[w] > 0; w++) streak++;
  if (per[0] > 0) streak++;
  add("streak", `Weeks in a row with at least one game: ${streak}.`);
  const recent = k.played.filter((g) => weekOf(g.date) >= 0 && weekOf(g.date) <= 8);
  if (recent.length) {
    const by = {};
    for (const g of recent) for (const id of g.with || []) by[id] = (by[id] || 0) + 1;
    const top = Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 3);
    add("played", `Games in the last 8 weeks: ${recent.length}${top.length ? `; played most with ${list(top.map(([id, n]) => `${name(id)} (${n})`))}` : ""}.`);
  }
  const w7 = k.logs.filter((l) => l.date >= life.ymd(new Date(now.getTime() - 6 * DAY_MS)));
  if (w7.length) add("logged", `Sessions you logged in the last 7 days: ${w7.length}, ${w7.reduce((a, l) => a + (l.minutes || 0), 0)} minutes in all.`);
  const org = organize({ log: k.body.log || [], workouts: k.body.workouts || [], days: k.body.days || [], games: k.played, now });
  const sore = org.parts.filter((p) => p.active);
  if (sore.length) add("body", `In your body log: ${sore.slice(0, 3).map((p) => `${p.name} ${p.latest.kind} ${p.latest.level}/5`).join(", ")}${org.plan.limit ? `; until it settles, the games I line up are ${org.plan.format === "doubles" ? "doubles first" : org.plan.limit}` : ""}.`);
  else add("body", "Nothing in your body log is sore right now.");
  add("club", `Your club: ${club.name}, ${club.members.length} other members; club night is ${club.night?.day} at ${club.night?.start}.`);
  if (club.challenge) add("challenge", `The club challenge, "${club.challenge.title}": the members have played ${club.members.reduce((a, m) => a + (m.games || 0), 0)} of ${club.challenge.target} games.`);
  return { facts: F, notes: k.notes, numbers: new Set(F.flatMap((f) => nums(f.text))) };
}

const nums = (t) => (String(t).match(/\d+/g) || []).map(Number);
// every number in the answer: in a fact, in what the player wrote or told the agent before, or a small count (0-10)
export function check(text, sheet, extra = "") {
  const ok = new Set([...sheet.numbers, ...nums(extra)]);
  const found = nums(String(text).replace(/\[F\d+\]/g, ""));
  const bad = [...new Set(found.filter((n) => n > 10 && !ok.has(n)))];
  return { ok: bad.length === 0, numbers: found.length, bad };
}

const CAN = `/game a game at your usual times · /autopilot the whole week lined up · /courts courts near a place · /body your body log · /report your body report · /week your calendar · /idea an idea for the club · /forget delete everything`;
function prompt(sheet) {
  return `You are the player's own agent in Serve, a sports social app. You get people playing: you line up games with the people they play best with, agree them with the other players' agents, keep their body log and find courts. You are not a coach: you don't analyse how anyone plays or prescribe training.
Answer the player's message in one to three short sentences, under 70 words, warm and direct, in the language they write in.
For anything about their games, calendar, body or club, use only these facts. Every number, date and time you write must appear in a fact or in what the player wrote.
FACTS:
${sheet.facts.map((f) => `[${f.id}] ${f.text}`).join("\n")}
WHAT THEY TOLD YOU BEFORE:
${sheet.notes.slice(-10).map((t) => `- ${t}`).join("\n") || "- (nothing yet)"}
WHAT YOU CAN DO FOR THEM (offer the right one when the facts don't answer it): ${CAN}
Never diagnose; for pain that lasts, suggest seeing a physio. Never give medical, diet or betting advice. Plain text, no markdown, no fact ids.`;
}

// the facts that fit the question best, when the model's answer cannot be used
const PICK = [[/next|when|booked|tomorrow|tonight|game/i, ["next", "booked"]], [/how many|this week|goal|streak|in a row/i, ["week", "goal", "streak"]], [/who|with|partner|most/i, ["played"]],
  [/hurt|sore|knee|ankle|back|body|pain/i, ["body"]], [/club|challenge|members|night/i, ["club", "challenge"]], [/calendar|schedule|exam|training/i, ["calendar", "next"]]];
function fallback(sheet, text) {
  const keys = PICK.find(([rx]) => rx.test(text))?.[1] || ["next", "week"];
  const facts = keys.map((k) => sheet.facts.find((f) => f.key === k)).filter(Boolean);
  return `Here is what I know: ${facts.map((f) => f.text).join(" ")}`;
}

// one answer; history is the conversation so far ({ role, content }), for a Messenger player taken from the store
export async function answer({ text, playerId = null, app = null, history = [], now = new Date() } = {}) {
  const player = playerId ? store.get(playerId) : null;
  const sheet = factsFor({ player, app, now });
  const extra = `${text} ${sheet.notes.join(" ")}`;
  const past = (player ? player.history || [] : history).slice(-6).map((h) => ({ role: h.role, content: String(h.content) }));
  const msgs = [{ role: "system", content: prompt(sheet) }, ...past, { role: "user", content: String(text) }];
  let out = "", verdict = null, timing = null, tries = 0;
  try {
    for (; tries < 2; tries++) {
      const r = await chat(msgs, { temperature: tries ? 0.1 : 0.3, maxTokens: 220, site: "answer" });
      out = String(r.text || "").replace(/\s*\[F\d+(?:,\s*F?\d+)*\]/g, "").trim(); timing = r.timing; verdict = check(out, sheet, extra);
      if (out && verdict.ok) break;
      msgs.push({ role: "assistant", content: r.text || "" }, { role: "user", content: `${out ? `These numbers are not in the facts: ${verdict.bad.join(", ")}.` : "That was empty."} Answer again, using only numbers, dates and times from the facts.` });
    }
    if (!out || !verdict.ok) { const draft = out, bad = verdict?.bad || []; out = fallback(sheet, text); verdict = { ...check(out, sheet), rejected: bad, draft }; }
  } catch (e) {
    out = fallback(sheet, text); verdict = { ...check(out, sheet), offline: String(e.message || e) };
  }
  return { text: out, verified: verdict, facts: sheet.facts.length, tries: Math.min(tries + 1, 2), timing };
}

// after a message: what is worth remembering about the player (what hurts, goals, when they can play, preferences).
// Something that hurts is kept at once, without waiting for the model.
const PART = /\b(knee|ankle|shoulder|back|wrist|elbow|hip|calf|hamstring|neck|foot)\b/i, HURT = /\b(sore|pain|hurts?|injur\w*|strain\w*|sprain\w*|tight|stiff)\b/i;
export async function learn(playerId, text) {
  const quick = String(text).split(/(?<=[.!?])\s+/).filter((x) => PART.test(x) && HURT.test(x)).map((x) => `Player said: ${x.trim().replace(/[.]$/, "")}`);
  const saved = quick.length ? store.remember(playerId, quick) : [];
  if (!/\b(i|i'm|im|my|me|we)\b/i.test(text)) return saved;
  try {
    const r = await chat([
      { role: "system", content: "List what a player's sports agent should remember from their message: an injury or pain, a goal, when they can or can't play, who or what they like to play. Return a JSON array of short English sentences, or [] if there is nothing. JSON only." },
      { role: "user", content: String(text) },
    ], { maxTokens: 120, temperature: 0, site: "answer.learn" });
    const arr = JSON.parse((String(r.text).match(/\[[\s\S]*\]/) || ["[]"])[0]);
    return [...saved, ...store.remember(playerId, arr.filter((x) => typeof x === "string" && x.length < 160).slice(0, 3))];
  } catch { return saved; }
}

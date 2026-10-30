// Your agent in Messenger: the player's schedule and their training log. Free text is read by the local model into a
// small JSON action ("I have club training Wed 19:00-21:00" -> an event); the agent then sees the week and the recent
// sessions in every answer, and the gateway sends reminders before a session and a check-in in the evening.
import { chatJSON } from "./llm.js";
import { FILED, EVENTS } from "./schema.js";
import * as store from "./store.js"; // a player's calendar and log live on their entry there
// Days and times the way the calendar stores them, in this machine's time zone: "2026-10-28", "19:00", "Wed".
const DAYS = "Sun Mon Tue Wed Thu Fri Sat".split(" ");
const two = (n) => `${n}`.padStart(2, "0");
export const ymd = (d) => [d.getFullYear(), two(d.getMonth() + 1), two(d.getDate())].join("-");
export const hm = (d) => `${two(d.getHours())}:${two(d.getMinutes())}`;
// when an entry begins; one without a time counts from midnight
export const at = (e) => new Date(e.date + "T" + (e.start || "00:00"));
const ISO_DAY = /^\d{4}-\d\d-\d\d$/;
// The next 8 days spelled out ("today = Wed 2026-10-28; tomorrow = Thu 2026-10-29; Fri = Fri 2026-10-30; ..."): the
// model looks "Friday" or "tomorrow" up in the list rather than counting days itself.
const calendar = (now = new Date()) => {
  const days = [];
  for (let k = 0; k < 8; k++) {
    const d = new Date(now);
    d.setDate(now.getDate() + k);
    days.push(`${["today", "tomorrow"][k] ?? DAYS[d.getDay()]} = ${DAYS[d.getDay()]} ${ymd(d)}`);
  }
  return days.join("; ");
};
// What the model writes for one calendar entry, in both prompts below; the kinds are the ones the calendar files.
const KINDS = ["training", "match", "exam", "travel", "other"];
const ENTRY = `{"date": "YYYY-MM-DD", "start": "HH:MM", "end": "HH:MM or empty", "title": "short", "kind": ${KINDS.map((k) => `"${k}"`).join(" | ")}}`;
const PROMPT = (now) => `You file messages from a player for their sports agent. Now: ${DAYS[now.getDay()]} ${ymd(now)} ${hm(now)}. Dates: ${calendar(now)}.
Answer with a single JSON object and nothing else:
{"intent": "event" | "log" | "chat",
 "events": [${ENTRY}],
 "log": {"date": "YYYY-MM-DD", "minutes": number or 0, "what": "the training they did", "pain": "pain or soreness they mention, or empty"}}
event = a plan in their calendar (training, match, exam, trip). log = a training session or game they already did. chat = anything else.
Examples: "club training Wednesday 19:00-21:00" -> event; "exam on Friday" -> event; "did 1 hour of smash practice" -> log; "when is my next game?" -> chat.
Times are 24-hour. Fields that do not apply stay empty.`;
// Second thoughts on a "chat" from the model, which a 4B model gives now and then to a plain statement. Words for a
// finished session plus a length make it a log; a day or a time plus something that goes in a calendar make it an
// event, and the entry is then asked for on its own. A question stays chat.
const anyOf = (...alts) => new RegExp(alts.join("|"), "i");
const raw = String.raw;
const WHEN = anyOf(raw`\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b`, "tomorrow", "tonight", "next week", raw`\b\d{1,2}(:\d\d)?\s*(am|pm)\b`, raw`\b\d{1,2}:\d\d\b`,
  "明天", "今晚", "後天", "下週", "星期", "週[一二三四五六日]", "禮拜", raw`\d+點`);
const SESSION = anyOf("training", "practice", "session", "match", "tournament", "game", "exam", "test", "trip", "flight", "travel", "class", "gym",
  "訓練", "練球", "比賽", "考試", "出國", "旅行", "課");
const PAST = anyOf(raw`\b(did|done|finished|trained|played|completed|ran|had)\b`, "just (did|finished|trained)", "練了", "做了", "打了", "剛練", "今天練");
const DURATION = anyOf(raw`\d+\s*(min|minute|hour|hr|h\b)`, "分鐘", "小時");
const ASKING = anyOf(raw`\?`, "？", "嗎", "什麼", "怎麼", "how", "what", "should", "can i");
const cue = (text) => (PAST.test(text) && DURATION.test(text) ? "log" : WHEN.test(text) && SESSION.test(text) ? "event" : "chat");
// the length a message gives, in minutes: hours first ("1.5 hours", "2h", 2小時), then minutes ("45 min", 90分鐘); else 0
const UNITS = [[/(\d+(?:\.\d+)?)\s*(hours?|hrs?|h\b|小時)/i, 60], [/(\d+)\s*(min|minutes?|分鐘)/i, 1]];
const minutesIn = (text) => {
  for (const [re, per] of UNITS) {
    const m = re.exec(text);
    if (m) return Math.round(+m[1] * per);
  }
  return 0;
};
// What a message is (a calendar entry, a finished session, or anything else: chat) and what to file from it.
export const read = async (text, now = new Date()) => {
  const { value } = await chatJSON([{ role: "system", content: PROMPT(now) }, { role: "user", content: text }], FILED, { maxTokens: 220, temperature: 0, site: "life.read" });
  const j = value || {};
  const out = { intent: ["event", "log", "chat"].includes(j.intent) ? j.intent : "chat",
    events: (j.events || []).filter((e) => ISO_DAY.test(e?.date || "")), log: j.log || {} };
  if (out.intent === "chat" && !ASKING.test(text)) out.intent = cue(text);
  if (out.intent === "event" && !out.events.length) {
    out.events = await entriesIn(text, now);
    // nothing to put in the calendar after all: answer it as a message
    if (!out.events.length) out.intent = "chat";
  }
  if (out.intent !== "log" || out.log.minutes > 0) return out;
  return { ...out, log: { ...out.log, minutes: minutesIn(text) } };
};
// The narrow ask, for a message that looks like a calendar entry: the entries alone, as an array.
const entriesIn = async (text, now) => {
  const r = await chatJSON([{ role: "system", content: `Now: ${DAYS[now.getDay()]} ${ymd(now)} ${hm(now)}. Dates: ${calendar(now)}.
Write the calendar entries in the message as a JSON array and nothing else: [${ENTRY}]. Times are 24-hour ("7pm" is "19:00"). A weekday is the next date it has in the list.` },
    { role: "user", content: text }], EVENTS, { maxTokens: 200, temperature: 0, site: "life.events" });
  return (r.value || []).filter((e) => /^\d{4}-\d\d-\d\d$/.test(e?.date || ""));
};
// The calendar. Entries keep the model's date, a time only in HH:MM, a short title and a known kind; the file keeps
// them in order, drops what ended over two weeks ago and holds at most 80.
const newId = () => Math.random().toString(36).slice(2, 8);
const clock = (t) => (/^\d\d:\d\d$/.test(t) ? t : "");
export const addEvents = (id, events) => {
  const clean = events.map((e) => ({ id: newId(), date: e.date, start: clock(e.start), end: clock(e.end),
    title: String(e.title || e.kind || "event").slice(0, 60), kind: ["training", "match", "exam", "travel"].includes(e.kind) ? e.kind : "other", at: Date.now(),
    // a game the Autopilot booked: who it is with and how long the court is booked, to learn from how long it ran
    ...(Array.isArray(e.with) ? { with: e.with.slice(0, 4).map(String), booked: +e.booked || 90 } : {}),
    // an outdoor court: where it is, so the agent can check the weather before the game
    ...(e.place?.lat != null ? { place: { lat: +e.place.lat, lon: +e.place.lon, name: String(e.place.name || "").slice(0, 80), outdoor: !!e.place.outdoor }, sport: String(e.sport || "").slice(0, 20) } : {}) }));
  // the same game twice (booked again after a crash) is one event
  const key = (e) => `${e.date} ${e.start} ${e.kind} ${e.title}`;
  store.update(id, (q) => { const have = new Set(q.events.map(key)); q.events.push(...clean.filter((e) => !have.has(key(e)))); q.events.sort((a, b) => at(a) - at(b)); q.events = q.events.filter((e) => at(e) > Date.now() - 14 * 864e5).slice(-80); });
  return clean; // as filed, each with the id it was given
};
// from the start of today until `days` days from now
export const upcoming = (p, days = 7, now = new Date()) => {
  const from = new Date(`${ymd(now)}T00:00`), until = new Date(+now + days * 864e5);
  return p.events.filter((e) => at(e) >= from && at(e) < until);
};
export const today = (p, now = new Date()) => {
  const day = ymd(now);
  return p.events.filter((e) => e.date === day);
};
// The training log: sessions the player says they did, the latest 120 kept.
const whole = (x) => Math.max(0, Math.round(+x || 0));
const cut = (s, n) => String(s).slice(0, n);
export const addLog = (id, log, text, now = new Date()) => {
  const logged = {
    date: ISO_DAY.test(log.date || "") ? log.date : ymd(now),
    minutes: whole(log.minutes),
    what: cut(log.what || text, 120),
    pain: cut(log.pain || "", 80),
    text,
    at: Date.now(),
  };
  store.update(id, (p) => { p.logs = [...p.logs, logged].slice(-120); });
  return logged;
};
// the past 7 days with today: the sessions, their minutes added up, and the ones where pain was noted
export const week = (p, now = new Date()) => {
  const start = new Date(now);
  start.setDate(now.getDate() - 6);
  const since = ymd(start), logs = p.logs.filter((l) => l.date >= since);
  let minutes = 0;
  for (const l of logs) minutes += l.minutes;
  return { logs, sessions: logs.length, minutes, pain: logs.filter((l) => l.pain) };
};
// --- text for your agent's answers and for Messenger ----------------------------------------------------------------
// one entry as the player reads it: "Wed 2026-10-28 19:00-21:00 Club training (training)"
export const evText = (e) => {
  let when = `${DAYS[at(e).getDay()]} ${e.date}`;
  if (e.start) when += ` ${e.start}${e.end ? `-${e.end}` : ""}`;
  return `${when} ${e.title} (${e.kind})`;
};
// The player's week as their agent reads it: the calendar ahead and the sessions behind.
export const context = (p, now = new Date()) => {
  if (!p) return ""; // no player linked yet: nothing to tell
  const ahead = upcoming(p, 7, now).map((e) => `- ${evText(e)}`);
  const behind = week(p, now).logs.map((l) => `- ${l.date}: ${l.what}${l.minutes ? `, ${l.minutes} min` : ""}${l.pain ? `, pain: ${l.pain}` : ""}`);
  return [
    `NOW: ${DAYS[now.getDay()]} ${ymd(now)} ${hm(now)}`,
    "THE PLAYER'S CALENDAR, THE NEXT 7 DAYS:", ...(ahead.length ? ahead : ["- (empty)"]),
    "THE TRAINING THEY LOGGED, THE PAST 7 DAYS:", ...(behind.length ? behind : ["- (empty)"]),
  ].join("\n");
};
// /week in Messenger: the coming 7 days, then what was logged in the past 7.
export const weekText = (p, now = new Date()) => {
  const entries = upcoming(p, 7, now).map((e) => `• ${evText(e)}`);
  const { sessions, minutes, pain } = week(p, now);
  let logged = `Logged in the last 7 days: ${sessions} session${sessions === 1 ? "" : "s"}`;
  if (minutes) logged += `, ${minutes} min`;
  if (pain.length) logged += ` · pain noted: ${pain.map((l) => l.pain).join("; ")}`;
  const empty = "• Nothing in your calendar. Tell me your sessions, matches and exams, e.g. \"club training Wed 19:00-21:00\".";
  return ["This week", entries.join("\n") || empty, "", logged].join("\n");
};

// What the person wants, as a brief Join's tools can act on: { activity, dates, from, to, players, with, budget }.
// Two readers, the same output:
//   rules   keywords, weekdays, times, numbers and "$", in English and Chinese. Always run; they decide days, times,
//           group size and budget.
//   Qwen    Qwen2.5 0.5B on Join's own server (Ollama, SCOUT_LLM_URL). Only one job, the one rules are bad at: which
//           activity a free-form sentence means ("something with singing" is karaoke, "grill some meat" is bbq), or none.
//           Held to a JSON schema and used only when the rules found no activity. A model this small makes up days and
//           numbers when asked for them, so it isn't. No AI service, no key.
// The questions back are written by code, in Chinese when the person writes Chinese.
export const MODEL = process.env.SCOUT_MODEL || "qwen2.5:0.5b";
const URL_ = () => (process.env.SCOUT_LLM_URL || "").replace(/\/$/, "");
export const qwenOn = () => !!URL_();

// Numbers written out -> digits: "four of us", "a party of ten", "四個人", "十二位", "兩百塊", "下午兩點"
const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const ZD = { 零: 0, 一: 1, 兩: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function zhNumber(s) {
  let total = 0, cur = 0;
  for (const c of s) {
    if (c in ZD) cur = ZD[c];
    else { const u = { 十: 10, 百: 100, 千: 1000 }[c]; total += (cur || (u === 10 ? 1 : 0)) * u; cur = 0; }
  }
  return total + cur;
}
// (only numerals followed by a counter or unit, so 週一, 一起 and 星期二 stay as they are)
const numbers = (t) => t.replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/g, (w) => WORDS[w])
  .replace(/[零一兩二三四五六七八九十百千]+(?=\s*(?:個|位|人|塊|元|美金|台幣|點|天|號|日|月|分|$))/g, zhNumber);

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const FULL = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const ZH = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const plus = (today, n) => { const d = new Date(today); d.setDate(d.getDate() + n); return ymd(d); };
// this week's (or today's) weekday, and next week's (weeks start on Monday)
const nextDay = (today, wd) => plus(today, (wd - today.getDay() + 7) % 7);
const nextWeek = (today, wd) => plus(today, (((8 - today.getDay()) % 7) || 7) + ((wd + 6) % 7));
// a month and day, this year or, once it has passed, next year
function onDay(today, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  let x = new Date(today.getFullYear(), m - 1, d);
  if (x.getMonth() !== m - 1) return null;
  if (ymd(x) < ymd(today)) x = new Date(today.getFullYear() + 1, m - 1, d);
  return ymd(x);
}
const hhmm = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;

// clock times in a message, in minutes: "7pm", "8:30 pm", "noon", "10am to noon", "晚上七點", "下午兩點半", "19:00"
function times(n) {
  const out = [];
  for (const m of n.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\b(noon)\b|\b([01]?\d|2[0-3]):([0-5]\d)\b|(早上|上午|中午|下午|晚上)?\s*(\d{1,2})\s*點\s*(半|(\d{1,2})\s*分)?/g)) {
    let h, min = 0;
    if (m[3]) { h = +m[1] % 12 + (m[3] === "pm" ? 12 : 0); min = +(m[2] || 0); }
    else if (m[4]) h = 12;
    else if (m[5] != null) { h = +m[5]; min = +m[6]; }
    else { h = +m[8]; min = m[9] === "半" ? 30 : +(m[10] || 0); if ((m[7] === "下午" || m[7] === "晚上") && h < 12) h += 12; else if (!m[7] && h < 8) h += 12; }
    if (h <= 23 && min <= 59) out.push({ at: h * 60 + min, i: m.index });
  }
  return out.sort((a, b) => a.i - b.i).map((x) => x.at);
}

// The rules reader: "karaoke friday night for 4, $10 each", "badminton next Friday 7pm, me plus 3",
// "週五晚上七點 四個人唱歌 每人十塊"
export function byRules(text, brief, { activities, people, today }) {
  const t = text.toLowerCase(), n = numbers(t), out = { ...brief };
  const syn = { karaoke: /karaoke|kareoke|karoke|karaoki|ktv|\bsing|唱歌|唱k|卡拉/, "escape room": /escape|密室|解謎/, "board games": /board ?game|桌遊|桌上遊戲|桌上游戏/, bbq: /bbq|barbecue|烤肉/,
    "hot pot": /hot ?pot|soup pot|shabu|火鍋|麻辣鍋/, badminton: /badminton|羽球|羽毛球/, tennis: /(?<!table )tennis|網球/, pickleball: /pickleball|匹克球/, basketball: /basketball|\bhoops\b|籃球/,
    volleyball: /volleyball|排球/, "table tennis": /table tennis|ping ?pong|桌球|乒乓/ };
  for (const a of activities) if ((syn[a.id] || new RegExp(a.id)).test(t)) { out.activity = a.id; break; }

  const dates = [];
  if (/today|tonight|今天|今晚/.test(t)) dates.push(ymd(today));
  if (/tomorrow|\btmrw?\b|\btomm?orr?ow\b|明天|明晚/.test(t) && !/day after tomorrow/.test(t)) dates.push(plus(today, 1));
  if (/day after tomorrow|後天|后天/.test(t)) dates.push(plus(today, 2));
  const inDays = n.match(/\bin (\d{1,2}) days?\b|(\d{1,2})\s*天(?:後|后|之後)/);
  if (inDays) dates.push(plus(today, +(inDays[1] || inDays[2])));
  // next week's weekdays first, then what's left is this week's
  let rest = t.replace(/\bnext (sun|mon|tue|wed|thu|fri|sat)[a-z]*/g, (_, d) => { dates.push(nextWeek(today, DAYS.indexOf(d))); return " "; })
    .replace(/下(?:週|周|星期|禮拜|个星期|個星期)([一二三四五六日天])/g, (_, d) => { dates.push(nextWeek(today, ZH[d])); return " "; });
  DAYS.forEach((d, i) => { if (new RegExp(`\\b(${d}|${FULL[i]})\\b`).test(rest)) dates.push(nextDay(today, i)); });
  for (const m of rest.matchAll(/(?:週|周|星期|禮拜)([一二三四五六日天])/g)) dates.push(nextDay(today, ZH[m[1]]));
  if (/weekend|週末|周末/.test(rest)) dates.push(nextDay(today, 6), nextDay(today, 0));
  // "11/7", "Nov 3", "3rd of November", "11月7日"
  for (const m of n.matchAll(/\b(\d{1,2})\/(\d{1,2})\b(?!\s*(?:am|pm))/g)) dates.push(onDay(today, +m[1], +m[2]));
  for (const m of n.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/g)) dates.push(onDay(today, MONTHS.indexOf(m[1]) + 1, +m[2]));
  for (const m of n.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*/g)) dates.push(onDay(today, MONTHS.indexOf(m[2]) + 1, +m[1]));
  for (const m of n.matchAll(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日號号]/g)) dates.push(onDay(today, +m[1], +m[2]));
  if (dates.filter(Boolean).length) out.dates = [...new Set(dates.filter(Boolean))].sort();

  // a clock time wins over a part of the day; one time is a start ("around 7pm"), two are a window
  const at = times(n);
  if (at.length >= 2 && at[1] > at[0]) Object.assign(out, { from: hhmm(at[0]), to: hhmm(at[1]) });
  else if (at.length) Object.assign(out, { from: hhmm(at[0]), to: hhmm(Math.min(at[0] + 180, 23 * 60 + 59)) });
  else if (/morning|早上|上午/.test(t)) Object.assign(out, { from: "08:00", to: "12:00" });
  else if (/afternoon|下午/.test(t)) Object.assign(out, { from: "13:00", to: "18:00" });
  else if (/evening|night|tonight|晚上|今晚|明晚/.test(t)) Object.assign(out, { from: "17:00", to: "23:00" });

  // group size: the others are counted ("3 friends", "me plus 2", "me and 1 friend"); the whole group isn't
  // ("4 of us", "a party of 6", "四個人", "我們五個", or a bare "5" answering "how many?")
  const others = n.match(/(\d+)\s*(?:friends?|others|cousins?|colleagues?|co-?workers?|classmates?|個?朋友|位?朋友|個?同事|個?同學)/) || n.match(/\bme (?:and|plus|\+)\s*(\d+)\b/);
  const whole = n.match(/(\d+)\s*(?:people|persons|of us|人|個人|位|個)/) || n.match(/\b(?:party|group) of (\d+)/) || n.match(/(?:\bfor|we're|we are|共|總共|我們)\s*(\d+)/) || n.match(/^\s*(\d+)\s*$/);
  if (others) out.players = Math.max(1, +others[1]);
  else if (whole) out.players = Math.max(1, +whole[1] - 1);

  // budget per person, in dollars; "200 total" / "總共200" is split over the group once its size is known
  const money = n.match(/\$\s*(\d+(?:\.\d+)?)/) || n.match(/(\d+(?:\.\d+)?)\s*(?:dollars|bucks|usd|塊|元|美金)/) || n.match(/budget\s*(?:is|of)?\s*(\d+(?:\.\d+)?)/);
  if (money && +money[1] > 0) {
    const total = /total|in all|altogether|總共|一共|全部/.test(n) && !/each|apiece|per person|每人|每個人/.test(n);
    if (!total) out.budget = +money[1];
    else if (out.players != null) out.budget = Math.round((+money[1] / (out.players + 1)) * 100) / 100;
  }

  const named = people.filter((p) => t.includes(p.name.split(" ")[0].toLowerCase()) || text.includes(p.name.split(" ")[0])).map((p) => p.id);
  if (named.length) out.with = [...new Set([...(out.with || []), ...named])];
  // (friends named: the group is at least the organizer and them)
  if (out.with?.length && (out.players == null || out.players < out.with.length)) out.players = out.with.length;
  return out;
}

// A brief from the browser is checked before use: known activity, real dates and times, sane numbers, known people
export function clean(b, { activities, people }) {
  const o = {}, x = b && typeof b === "object" && !Array.isArray(b) ? b : {};
  if (activities.some((a) => a.id === x.activity)) o.activity = x.activity;
  if (Array.isArray(x.dates)) { const d = x.dates.filter((s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(`${s}T12:00:00Z`)) && new Date(`${s}T12:00:00Z`).toISOString().startsWith(s)).slice(0, 7); if (d.length) o.dates = d; }
  for (const k of ["from", "to"]) if (typeof x[k] === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(x[k])) o[k] = x[k];
  if (Number.isInteger(x.players) && x.players >= 1 && x.players <= 50) o.players = x.players;
  if (Array.isArray(x.with)) { const w = x.with.filter((id) => typeof id === "string" && people.some((p) => p.id === id)); if (w.length) o.with = [...new Set(w)]; }
  if (typeof x.budget === "number" && x.budget > 0 && x.budget < 1000) o.budget = x.budget;
  return o;
}

// what each activity sounds like, for the model
const HINTS = { badminton: "shuttlecock, racket sport", tennis: "tennis court", pickleball: "paddle and wiffle ball", basketball: "hoops, shooting baskets", volleyball: "volleyball net",
  "table tennis": "ping pong", karaoke: "singing songs, KTV", "escape room": "solving puzzles to get out of a locked room", "board games": "playing tabletop games, cards, dice",
  bbq: "grilling meat outdoors, barbecue", "hot pot": "eating hot pot, spicy soup pot, cooking food in a shared boiling pot" };

// Qwen on Join's server: which activity the person's latest message means, or "none"
async function activityByQwen(text, activities) {
  const ids = activities.map((a) => a.id);
  const sys = `Classify which group activity the message asks for. Options:\n${ids.map((id) => `- ${id}: ${HINTS[id] || id}`).join("\n")}\n- none: no activity is mentioned
Answer "none" unless the message clearly points to one of them.`;
  const shots = [["我想跟朋友出去玩", "none"], ["let's go sing somewhere", "karaoke"], ["四個人", "none"], ["想吃點熱的鍋", "hot pot"]];
  const r = await fetch(`${URL_()}/api/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(20e3),
    body: JSON.stringify({ model: MODEL, stream: false, keep_alive: "24h", options: { temperature: 0, num_predict: 30 },
      format: { type: "object", properties: { activity: { type: "string", enum: ["none", ...ids] } }, required: ["activity"] },
      messages: [{ role: "system", content: sys }, ...shots.flatMap(([u, a]) => [{ role: "user", content: u }, { role: "assistant", content: JSON.stringify({ activity: a }) }]), { role: "user", content: text.slice(0, 300) }] }),
  });
  if (!r.ok) throw new Error(`model ${r.status}`);
  const a = JSON.parse((await r.json()).message.content).activity;
  return ids.includes(a) ? a : null;
}

// One message in: the brief so far, updated; what's still missing; and what to say back.
export async function understand(history, brief, ctx) {
  const last = String(history.at(-1)?.content || "").slice(0, 500);
  const next = byRules(last, clean(brief, ctx), ctx);
  let model = "rules";
  if (!next.activity && qwenOn()) {
    try { const a = await activityByQwen(last, ctx.activities); model = MODEL; if (a) next.activity = a; } catch {}
  } // (when the rules found the activity, Qwen wasn't asked, and the message is credited to the rules)
  // the reply's language: Chinese if the message has Chinese, English if it has letters, else the conversation's
  const gap = missing(next), zh = /[\u4e00-\u9fff]/.test(last) || (!/[a-z]/i.test(last) && ctx.lang === "zh");
  const names = (next.with || []).map((id) => ctx.people.find((p) => p.id === id)?.name.split(" ")[0]).filter(Boolean);
  const reply = gap.length ? (zh ? ASK_ZH : ASK)[gap[0]]
    : zh ? `好，幫你找${next.players + 1}個人的${ZH_NAME[next.activity] || next.activity}${names.length ? `（你、${names.join("、")}${next.players > names.length ? " 和其他朋友" : ""}）` : ""}${next.budget ? `，每人約 $${next.budget}` : ""}…`
      : `Looking for ${next.activity} for ${next.players + 1}${names.length ? ` (you, ${names.join(", ")}${next.players > names.length ? " and others" : ""})` : ""}${next.budget ? `, about $${next.budget} each` : ""}…`;
  return { brief: next, missing: gap, reply, model, lang: zh ? "zh" : "en" };
}

// What is still missing before the agent can search (the question comes from code when Qwen isn't there)
export function missing(brief) {
  const m = [];
  if (!brief.activity) m.push("activity");
  if (!brief.dates?.length) m.push("day");
  if (brief.players == null) m.push("people");
  return m;
}
export const ASK = {
  activity: "What would you like to do? Badminton, karaoke, an escape room, board games, a barbecue, hot pot…",
  day: "Which day works for you? (today, tomorrow, Friday, this weekend…)",
  people: "How many people, you included?",
};
const ASK_ZH = { activity: "想做什麼呢？羽球、唱歌、密室逃脫、桌遊、烤肉、火鍋……", day: "哪一天方便？（今天、明天、週五、這個週末……）", people: "總共幾個人（包括你）？" };
const ZH_NAME = { badminton: "羽球", tennis: "網球", pickleball: "匹克球", basketball: "籃球", volleyball: "排球", "table tennis": "桌球", karaoke: "唱歌", "escape room": "密室逃脫", "board games": "桌遊", bbq: "烤肉", "hot pot": "火鍋" };

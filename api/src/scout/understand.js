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

// "four of us", "四個人", "十二位" -> digits, for the group size
const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const ZHN = { 一: 1, 兩: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function numbers(t) {
  return t.replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/g, (w) => WORDS[w])
    .replace(/十([一二三四五六七八九])/g, (_, d) => 10 + ZHN[d]).replace(/([一兩二三四五六七八九十])(?=\s*(?:個|位|人|$))/g, (d) => ZHN[d]);
}

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const ZH = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const nextDay = (today, wd) => { const d = new Date(today); d.setDate(d.getDate() + ((wd - d.getDay() + 7) % 7)); return ymd(d); };

// The rules reader: enough for "karaoke friday night for 4, $10 each" or "週五晚上 4 個人唱歌 每人 10 塊"
export function byRules(text, brief, { activities, people, today }) {
  const t = text.toLowerCase(), out = { ...brief };
  const syn = { karaoke: /karaoke|ktv|\bsing|唱歌|卡拉/, "escape room": /escape|密室|解謎/, "board games": /board ?game|桌遊/, bbq: /bbq|barbecue|烤肉/, "hot pot": /hot ?pot|火鍋/, badminton: /badminton|羽球|羽毛球/, tennis: /tennis|網球/, pickleball: /pickleball|匹克球/, basketball: /basketball|籃球/, volleyball: /volleyball|排球/, "table tennis": /table tennis|ping ?pong|桌球|乒乓/ };
  for (const a of activities) if ((syn[a.id] || new RegExp(a.id)).test(t)) { out.activity = a.id; break; }
  const dates = [];
  if (/today|今天|今晚/.test(t)) dates.push(ymd(today));
  if (/tomorrow|明天|明晚/.test(t) && !/day after tomorrow/.test(t)) { const d = new Date(today); d.setDate(d.getDate() + 1); dates.push(ymd(d)); }
  if (/day after tomorrow|後天|后天/.test(t)) { const d = new Date(today); d.setDate(d.getDate() + 2); dates.push(ymd(d)); }
  const FULL = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  DAYS.forEach((d, i) => { if (new RegExp(`\\b(${d}|${FULL[i]})\\b`).test(t)) dates.push(nextDay(today, i)); });
  for (const m of text.matchAll(/(?:週|周|星期|禮拜)([一二三四五六日天])/g)) dates.push(nextDay(today, ZH[m[1]]));
  if (/weekend|週末|周末/.test(t)) dates.push(nextDay(today, 6), nextDay(today, 0));
  if (dates.length) out.dates = [...new Set(dates)];
  if (/morning|早上|上午/.test(t)) Object.assign(out, { from: "08:00", to: "12:00" });
  else if (/afternoon|下午/.test(t)) Object.assign(out, { from: "13:00", to: "18:00" });
  else if (/evening|night|tonight|晚上|今晚|明晚/.test(t)) Object.assign(out, { from: "17:00", to: "23:00" });
  const n = numbers(t);
  const ppl = n.match(/(\d+)\s*(?:people|persons|of us|人|個人|位|個)/) || n.match(/(?:for|we're|we are|共|總共|我們)\s*(\d+)/) || n.match(/^\s*(\d+)\s*$/), others = n.match(/(\d+)\s*(?:friends|others|朋友|個朋友)/);
  if (others) out.players = Math.max(1, +others[1]);
  else if (ppl) out.players = Math.max(1, +ppl[1] - 1);
  const money = t.match(/\$\s*(\d+(?:\.\d+)?)/) || t.match(/(\d+(?:\.\d+)?)\s*(?:dollars|usd|塊|元|美金)/);
  if (money) out.budget = +money[1];
  const named = people.filter((p) => t.includes(p.name.split(" ")[0].toLowerCase()) || text.includes(p.name.split(" ")[0])).map((p) => p.id);
  if (named.length) out.with = [...new Set([...(out.with || []), ...named])];
  // (friends named and no count given: the group is the organizer and them)
  if (out.players == null && out.with?.length) out.players = out.with.length;
  return out;
}

// what each activity sounds like, for the model
const HINTS = { badminton: "shuttlecock, racket sport", tennis: "tennis court", pickleball: "paddle and wiffle ball", basketball: "hoops, shooting baskets", volleyball: "volleyball net",
  "table tennis": "ping pong", karaoke: "singing songs, KTV", "escape room": "solving puzzles to get out of a locked room", "board games": "playing tabletop games, cards, dice",
  bbq: "grilling meat outdoors, barbecue", "hot pot": "eating hot pot, cooking food in a shared boiling pot" };

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
  const last = String(history.at(-1)?.content || "");
  const next = byRules(last, brief, ctx);
  let model = "rules";
  if (!next.activity && qwenOn()) {
    try { const a = await activityByQwen(last, ctx.activities); model = MODEL; if (a) next.activity = a; } catch {}
  } else if (qwenOn()) model = MODEL;
  const gap = missing(next), zh = /[\u4e00-\u9fff]/.test(last);
  const reply = gap.length ? (zh ? ASK_ZH : ASK)[gap[0]] : zh ? `好，幫你找${next.players + 1}個人的${ZH_NAME[next.activity] || next.activity}…` : `Looking for ${next.activity} for ${next.players + 1}${next.budget ? `, about $${next.budget} each` : ""}…`;
  return { brief: next, missing: gap, reply, model };
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

// What the person wants, as a brief Join's tools can act on: { activity, dates, from, to, players, with, budget }.
// Two readers, the same output:
//   Qwen    Qwen2.5-1.5B-Instruct running in this browser (WebLLM on WebGPU): reads free text in any language,
//           updates the brief and writes the next question. Its answer is held to a JSON schema, then checked by code.
//   rules   no model: keywords, weekdays, times, numbers and "$". Used without WebGPU, or until the person chooses to
//           download the model.
// Nothing leaves the browser for this step.
export const MODEL = "Qwen2.5-1.5B-Instruct";
let engine = null, loading = null;

export const webgpu = () => typeof navigator !== "undefined" && !!navigator.gpu;
// the 16-bit build is smaller, but only GPUs with shader-f16 can run it; others get the 32-bit one
async function build() {
  const adapter = await navigator.gpu.requestAdapter().catch(() => null);
  return `${MODEL}-${adapter?.features.has("shader-f16") ? "q4f16_1" : "q4f32_1"}-MLC`;
}
export async function loadQwen(onProgress) {
  if (engine) return engine;
  loading ||= (async () => {
    const { CreateMLCEngine } = await import("@mlc-ai/web-llm");
    engine = await CreateMLCEngine(await build(), { initProgressCallback: (p) => onProgress?.(p) });
    return engine;
  })().catch((e) => { loading = null; throw e; });
  return loading;
}
export const qwenReady = () => !!engine;

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const ZH = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const nextDay = (today, wd) => { const d = new Date(today); d.setDate(d.getDate() + ((wd - d.getDay() + 7) % 7)); return ymd(d); };

// The rules reader: enough for "karaoke friday night for 4, $10 each" or "週五晚上 4 個人唱歌 每人 10 塊"
export function byRules(text, brief, { activities, people, today }) {
  const t = text.toLowerCase(), out = { ...brief };
  const syn = { karaoke: /karaoke|ktv|唱歌|卡拉/, "escape room": /escape|密室/, "board games": /board ?game|桌遊/, bbq: /bbq|barbecue|烤肉/, "hot pot": /hot ?pot|火鍋/, badminton: /badminton|羽球|羽毛球/, tennis: /tennis|網球/, pickleball: /pickleball|匹克球/, basketball: /basketball|籃球/, volleyball: /volleyball|排球/, "table tennis": /table tennis|ping ?pong|桌球|乒乓/ };
  for (const a of activities) if ((syn[a.id] || new RegExp(a.id)).test(t)) { out.activity = a.id; break; }
  const dates = [];
  if (/today|今天|今晚/.test(t)) dates.push(ymd(today));
  if (/tomorrow|明天|明晚/.test(t)) { const d = new Date(today); d.setDate(d.getDate() + 1); dates.push(ymd(d)); }
  const FULL = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  DAYS.forEach((d, i) => { if (new RegExp(`\\b(${d}|${FULL[i]})\\b`).test(t)) dates.push(nextDay(today, i)); });
  for (const m of text.matchAll(/(?:週|周|星期|禮拜)([一二三四五六日天])/g)) dates.push(nextDay(today, ZH[m[1]]));
  if (/weekend|週末|周末/.test(t)) dates.push(nextDay(today, 6), nextDay(today, 0));
  if (dates.length) out.dates = [...new Set(dates)];
  if (/morning|早上|上午/.test(t)) Object.assign(out, { from: "08:00", to: "12:00" });
  else if (/afternoon|下午/.test(t)) Object.assign(out, { from: "13:00", to: "18:00" });
  else if (/evening|night|tonight|晚上|今晚|明晚/.test(t)) Object.assign(out, { from: "17:00", to: "23:00" });
  const ppl = t.match(/(\d+)\s*(?:people|persons|of us|人|個人|位)/) || t.match(/for\s+(\d+)/), others = t.match(/(\d+)\s*(?:friends|others|朋友)/);
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

const SCHEMA = (activities) => ({
  type: "object",
  properties: {
    activity: { type: ["string", "null"], enum: [...activities.map((a) => a.id), null] },
    weekdays: { type: "array", items: { type: "string", enum: ["today", "tomorrow", "mon", "tue", "wed", "thu", "fri", "sat", "sun", "weekend"] } },
    part_of_day: { type: ["string", "null"], enum: ["morning", "afternoon", "evening", null] },
    group_size: { type: ["integer", "null"] },
    budget_per_person: { type: ["number", "null"] },
    friends: { type: "array", items: { type: "string" } },
    reply: { type: "string" },
  },
  required: ["activity", "weekdays", "part_of_day", "group_size", "budget_per_person", "friends", "reply"],
});

// The Qwen reader: the conversation so far and the brief in, an updated brief and the next thing to say out
export async function byQwen(history, brief, ctx) {
  const { activities, people, today, me } = ctx;
  const sys = `You are Join's assistant. Join books group activities: ${activities.map((a) => a.id).join(", ")}. Today is ${DAYS[today.getDay()]} ${ymd(today)}. You help ${me} get friends together.
From the conversation, fill in what the user wants: the activity (one of the list, or null), the days (weekdays, "today", "tomorrow" or "weekend"), part of the day, the group size including the user, the budget per person in USD, and any friends they name (known friends: ${people.map((p) => p.name.split(" ")[0]).join(", ")}).
Keep what was already known unless the user changes it: ${JSON.stringify({ activity: brief.activity, dates: brief.dates, from: brief.from, people: brief.players != null ? brief.players + 1 : null, budget: brief.budget })}.
In "reply", answer in the user's language in one or two short sentences: if something important is missing (activity, day, or group size), ask for it; otherwise say you'll look for options. Never invent prices, places or times.`;
  const r = await engine.chat.completions.create({
    messages: [{ role: "system", content: sys }, ...history.slice(-6)],
    temperature: 0.2, max_tokens: 220,
    response_format: { type: "json_object", schema: JSON.stringify(SCHEMA(activities)) },
  });
  const j = JSON.parse(r.choices[0].message.content);
  const out = { ...brief };
  if (activities.some((a) => a.id === j.activity)) out.activity = j.activity;
  const dates = [];
  for (const w of j.weekdays || []) {
    if (w === "today") dates.push(ymd(today));
    else if (w === "tomorrow") { const d = new Date(today); d.setDate(d.getDate() + 1); dates.push(ymd(d)); }
    else if (w === "weekend") dates.push(nextDay(today, 6), nextDay(today, 0));
    else if (DAYS.includes(w)) dates.push(nextDay(today, DAYS.indexOf(w)));
  }
  if (dates.length) out.dates = [...new Set(dates)];
  const part = { morning: ["08:00", "12:00"], afternoon: ["13:00", "18:00"], evening: ["17:00", "23:00"] }[j.part_of_day];
  if (part) [out.from, out.to] = part;
  if (Number.isInteger(j.group_size) && j.group_size >= 2 && j.group_size <= 12) out.players = j.group_size - 1;
  if (typeof j.budget_per_person === "number" && j.budget_per_person > 0 && j.budget_per_person < 1000) out.budget = j.budget_per_person;
  const ids = (j.friends || []).map((f) => people.find((p) => p.name.toLowerCase().startsWith(String(f).toLowerCase()))?.id).filter(Boolean);
  if (ids.length) out.with = [...new Set([...(out.with || []), ...ids])];
  return { brief: out, reply: typeof j.reply === "string" ? j.reply.slice(0, 300) : "" };
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

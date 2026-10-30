// The persona model: Muse Glimmer writes what a simulated person says, in their own voice, from their persona and what
// happened so far. It decides nothing that costs effort (inertia.mjs does): it is told what the person wants to do,
// and writes the text. On a separate endpoint from the gateway's agents (PERSONA_LLM_URL; the A100 test endpoint
// http://127.0.0.1:11448 by default), never the live 11435, with a few calls at once at most.
const URL_ = () => (process.env.PERSONA_LLM_URL || "http://127.0.0.1:11448").replace(/\/+$/, "").replace(/\/v1$/, "");
const MODEL = () => process.env.PERSONA_LLM_MODEL || "muse-glimmer";
const SLOTS = () => Math.max(1, +(process.env.PERSONA_LLM_SLOTS || 3));
let running = 0;
const queue = [];
export const stats = { calls: 0, failed: 0, seconds: 0, tokens: 0 };
const acquire = () => new Promise((ok) => { const go = () => { running++; ok(() => { running--; queue.shift()?.(); }); }; running < SLOTS() ? go() : queue.push(go); });

export async function chatJSON(messages, schema, { maxTokens = 160, temperature = 0.8, timeoutMs = 90000 } = {}) {
  const release = await acquire(), t0 = Date.now();
  try {
    for (let k = 0; k < 2; k++) {
      try {
        const r = await fetch(`${URL_()}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(timeoutMs),
          body: JSON.stringify({ model: MODEL(), messages, stream: false, think: "low", keep_alive: "24h", format: schema, options: { num_predict: maxTokens + 700, temperature } }) });
        if (!r.ok) throw new Error(`persona model ${r.status}`);
        const j = await r.json();
        stats.calls++; stats.tokens += j.eval_count || 0;
        const v = JSON.parse((j.message?.content || "").trim());
        if (v && typeof v === "object") return v;
      } catch (e) { if (k) { stats.failed++; return null; } }
    }
    return null;
  } finally { stats.seconds += (Date.now() - t0) / 1000; release(); }
}

const LANG = { en: "English", zh: "Traditional Chinese, as people in Taiwan text", mix: "English mixed with some Traditional Chinese, as people in Taiwan text" };
// who they are, for the model: everything here is made up (personas.json)
export function card(p) {
  return `You are role-playing ${p.name}, a simulated person (not a real one) in a test of a sports app. ${p.age}, ${p.job}; ${p.hours}. Plays ${p.sports.join(" and ")}, level ${p.level} of A to D, prefers ${p.prefers === "any" ? "singles or doubles" : p.prefers}. Usually free: ${p.free.join(", ")}.
How you text: ${p.voice}. Write in ${LANG[p.lang]}. Real people text briefly: usually under 15 words, no greeting or sign-off unless it fits, never like a formal letter, never mention being simulated or an AI.`;
}
const TEXT = { type: "object", properties: { text: { type: "string" } }, required: ["text"] };
const clean = (t, max = 280) => String(t || "").replace(/\s+/g, " ").replace(/^["“]|["”]$/g, "").trim().slice(0, max);

// what they write to their Serve agent (Messenger), for one purpose
const PURPOSE = {
  hello: () => "You just added your club's new sports agent on Messenger, because a friend asked the group to try it. Write your first message to it (often just a hello).",
  request: (x) => x.informed
    ? `You want a ${x.sport} ${x.format} game ${x.when}. Write the message you would send your sports agent to get one. A friend who uses it told you it understands "anyone up for ${x.format} on <day>?" or "I want to play ${x.format} <when>", and that /autopilot plans your whole week; use one of those, in your own voice.`
    : `You want a ${x.sport} ${x.format} game ${x.when}. Write the message you would send your sports agent to get one. Mention what you want in your own words; you don't know any special commands.`,
  retry: (x) => `You asked your sports agent for a ${x.sport} ${x.format} game ${x.when}, and it didn't set one up. Its reply was: "${x.said}". Try once more to get that game, the way you naturally would after reading that. If its reply told you to send a command (like /game or /autopilot), most people send just that command on its own.`,
  question: (x) => `Ask your sports agent one short question you'd actually have about it (${x.topic}).`,
  niggle: (x) => `Tell your sports agent your ${x.part} is a bit sore since your last game (mild, about 2 out of 5).`,
  bail: (x) => `Your agent agreed a game for you (${x.game}) without asking you, and you can't or don't want to go. Tell your agent.`,
  checkin: (x) => `Your agent asked how today's game went. ${x.played ? `You played ${x.minutes} minutes of ${x.format} with ${x.with}${x.felt ? `; ${x.felt}` : ""}.` : `The game didn't happen: ${x.why}.`} Answer it.`,
  log: (x) => `Tell your agent you just played: ${x.minutes} minutes of ${x.format} with ${x.with}${x.felt ? `, ${x.felt}` : ""}.`,
  confused: (x) => `Your agent's last message to you was: "${x.said}". Reply the way you naturally would${x.need ? "; you still want a game this week" : ""}.`,
  idea: (x) => `You've used the club's sports agent for ${x.days} day${x.days > 1 ? "s" : ""}. ${x.experience} Suggest one improvement, roughly about ${x.theme}. Write only the suggestion, as a short sentence, no names or numbers.`,
  post: (x) => `Write a short post for your club's feed about the game you just played: ${x.format} with ${x.with} at ${x.venue}. Friendly, no private details.`,
  comment: (x) => `A clubmate posted in the club feed: "${x.post}". Write a short friendly comment.`,
  trash: (x) => `You're hyped for your next game (${x.game}). Write a short cocky trash-talk message about it to your agent, the kind friends joke with (nothing truly violent).`,
};
const TOPICS = ["what it can do", "whether it can find a court near home", "how it picks who to play with", "whether it costs anything", "how to cancel a game", "whether the other people get asked too"];
export const topicFor = (r) => TOPICS[Math.floor(r * TOPICS.length) % TOPICS.length];

export async function write(p, purpose, x = {}, recent = []) {
  const ctx = recent.length ? `\nThe last messages in your chat with the agent (newest last):\n${recent.slice(-4).map((m) => `${m.from === "agent" ? "Agent" : "You"}: ${String(m.text).slice(0, 220)}`).join("\n")}` : "";
  const v = await chatJSON([{ role: "system", content: card(p) }, { role: "user", content: `${PURPOSE[purpose](x)}${ctx}\nReturn JSON: {"text": "<your message>"}` }], TEXT);
  const t = clean(v?.text, purpose === "post" ? 280 : 200);
  return t || fallback(p, purpose, x);
}
// when the persona model does not answer: a plain line, so the run goes on (counted in stats.failed)
function fallback(p, purpose, x) {
  const zh = p.lang === "zh";
  switch (purpose) {
    case "hello": return zh ? "嗨" : "hi";
    case "request": return zh ? `${x.when}有人要打${x.format === "doubles" ? "雙打" : "單打"}嗎？` : `anyone for ${x.format} ${x.when}?`;
    case "checkin": return x.played ? (zh ? `打了${x.minutes}分鐘，不錯` : `played ${x.minutes} min with ${x.with}, good`) : (zh ? "沒打成" : "didn't happen");
    case "log": return zh ? `剛打了${x.minutes}分鐘${x.format === "doubles" ? "雙打" : "單打"}` : `played ${x.minutes} min ${x.format} with ${x.with}`;
    case "bail": return zh ? "抱歉那天不行" : "sorry, can't make that one";
    case "idea": return "let me choose the court myself";
    default: return zh ? "好" : "ok";
  }
}

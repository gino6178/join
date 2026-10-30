// The caption for a highlight reel of the player's own video, for Instagram and Facebook, written by Muse Glimmer.
// It is checked like every reply: no number in it (the reel has none to stand on), or it is written again, then
// replaced by the template.
import { chat } from "./llm.js";

const clean = (s, n) => String(s || "").replace(/[^\p{L}\p{N} ,.'-]/gu, "").slice(0, n).trim();
const template = (sport, kind) => ({ text: `My ${kind}, slowed right down: Serve found me, read my pose and cut me out of the video.\n\n#${sport.replace(/\s+/g, "")} #${kind.replace(/\s+/g, "")} #ServeApp`, by: "rules" });

// own: { what: "my smash in badminton, replayed in slow motion", sport, kind }
export async function caption({ own = {} } = {}) {
  const sport = clean(own.sport, 20) || "badminton", kind = clean(own.kind, 20) || "smash", what = clean(own.what, 120) || `my ${kind} in ${sport}, replayed in slow motion`;
  const msgs = [{ role: "system", content: `You write the caption for a player's highlight reel of their own ${sport} game, for Instagram and Facebook. The reel: ${what}.
Return JSON only: {"caption": string, "hashtags": [3 to 5 words without #]}
- "caption": one or two short sentences in the player's voice ("my"), upbeat. At most one emoji. No numbers.
- English only.` }, { role: "user", content: "Write it." }];
  try {
    for (let tries = 0; tries < 2; tries++) {
      const r = await chat(msgs, { maxTokens: 200, temperature: tries ? 0.2 : 0.7 });
      const j = JSON.parse((r.text.match(/\{[\s\S]*\}/) || ["null"])[0] || "null");
      const text = typeof j?.caption === "string" ? j.caption.trim() : "";
      const tags = (Array.isArray(j?.hashtags) ? j.hashtags : []).map((x) => String(x).replace(/[^\p{L}\p{N}_]/gu, "")).filter(Boolean).slice(0, 5);
      if (text && !/\d/.test(text)) return { text: `${text}\n\n${[...new Set([...tags, "ServeApp"])].map((x) => `#${x}`).join(" ")}`, by: "model", timing: r.timing };
      msgs.push({ role: "assistant", content: r.text }, { role: "user", content: "No numbers in the caption. Return the JSON again." });
    }
  } catch { /* the model is unavailable: the template below */ }
  return template(sport, kind);
}

// The one-pass decider (A2A_DECIDER=raw in a2a.js): a member's choice between listed times, read from Muse Glimmer's
// probabilities in one pass instead of from a reasoned answer. The same facts the full answer reads (the member's
// profile, the proposed time and why it does not work, the listed times that do) are written as plain text that ends
// in an answer cue, each time one letter (A to L) and Z not this week. Sent raw (no chat template, so no reasoning
// channel) for one token at temperature 0 (llm.js nextToken), the next token's probabilities are the options'
// probabilities: the pick is the most likely letter, and its probability against the other letters is the confidence.
// Nothing is generated, so there is nothing to parse and no format to check: the answer is one of the options.
// test/decider_eval.mjs measures it against the full answer on the same cases (docs/decider.md).
import { nextToken } from "./llm.js";

export const LETTERS = "ABCDEFGHIJKL";
// the prompt, by variant. The default, habits, agreed most with the full answer on the dev members (population seed 11,
// not the members it was then measured on): test/decider_eval.mjs, docs/decider.md
const PROMPTS = {
  // the facts, the rule, and the cue
  cue: ({ profile, rule, them, sport, format, cur, why, opts }) => `${profile}
Another player's agent proposes ${sport} ${format} for ${them} at ${cur}. That time does not work for ${them} (${why}).
These listed times fit everyone's calendar and ${them}'s rules:
${opts.map((o) => `${o.id}. ${o.text}`).join("\n")}
${rule}
Answer with one letter.
Answer:`,
  // the same, closing on the choice itself
  best: ({ profile, rule, them, sport, format, cur, why, opts }) => `${profile}
Another player's agent proposes ${sport} ${format} for ${them} at ${cur}. That time does not work for ${them} (${why}).
These listed times fit everyone's calendar and ${them}'s rules:
${opts.map((o) => `${o.id}. ${o.text}`).join("\n")}
${rule}
Of the options above, the one ${them}'s agent picks is option`,
  // the same, saying the order is not a preference and pointing back at the member's habits
  habits: ({ profile, rule, them, sport, format, cur, why, opts }) => `${profile}
Another player's agent proposes ${sport} ${format} for ${them} at ${cur}. That time does not work for ${them} (${why}).
These listed times fit everyone's calendar and ${them}'s rules, in the order the other agent listed them (the order is not a preference):
${opts.map((o) => `${o.id}. ${o.text}`).join("\n")}
${rule} Judge by what ${them}'s agent knows of ${them} above: their habits and their week.
The time ${them} likes best is option`,
};
export const VARIANTS = Object.keys(PROMPTS);

// the options and the prompt for one question: `times` are the listed times that work ({ text } each, at most 12)
export function decisionPrompt({ profile, rule, them, sport, format, cur, why, times, variant = process.env.A2A_DECIDER_PROMPT || "habits" }) {
  const opts = [...times.slice(0, LETTERS.length).map((x, i) => ({ id: LETTERS[i], x, text: x.text })), { id: "Z", x: null, text: `${them} can't play this week` }];
  return { text: (PROMPTS[variant] || PROMPTS.habits)({ profile, rule, them, sport, format, cur, why, opts }), opts };
}

// a next token as an option letter: " B", "B", "B." and "(B" are B; "Be" or "All" are not a letter
const letterOf = (t) => (/^\s*\(?([A-Z])[).:,]?\s*$/.exec(String(t)) || [])[1] || null;
// the options' probabilities from the next token's top alternatives: each letter's mass, summed over its spellings, then
// shared out over the options (`mass` is how much of the whole next-token probability the options had)
export function readOptions(top, opts) {
  const ids = new Set(opts.map((o) => o.id)), m = {};
  for (const t of top || []) { const k = letterOf(t.token); if (k && ids.has(k)) m[k] = (m[k] || 0) + Math.exp(t.logprob); }
  const mass = Object.values(m).reduce((a, b) => a + b, 0);
  if (!mass) return { pick: null, p: null, mass: 0, dist: {} };
  const dist = Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, +(v / mass).toFixed(4)]));
  const id = Object.keys(dist)[0];
  return { pick: opts.find((o) => o.id === id), p: dist[id], mass: +mass.toFixed(4), dist };
}

// one question, one pass: { pick (an option: x is the time, null for Z), p, mass, dist, prompt tokens, seconds }.
// With orders 2 (A2A_DECIDER_ORDERS), the times are also read in the reverse order, in a second pass at the same time,
// and each time's probability is the mean of the two (a letter's place in the list moves its probability).
export async function decideRaw(q, { site = "a2a.decide", timeoutMs = +(process.env.A2A_DECIDER_TIMEOUT_MS || 30000) } = {}) {
  const orders = Math.min(2, Math.max(1, +(q.orders || process.env.A2A_DECIDER_ORDERS || 1)));
  const runs = await Promise.all(Array.from({ length: orders }, async (_, k) => {
    const { text, opts } = decisionPrompt(k ? { ...q, times: [...q.times].reverse() } : q);
    const r = await nextToken(text, { site, timeoutMs });
    return r && { r, opts, read: readOptions(r.top, opts) };
  }));
  if (runs.some((x) => !x)) return { pick: null, p: null, mass: 0, dist: {}, error: "no token probabilities from this server" };
  const cost = { token: runs[0].r.token, prompt: runs.reduce((a, x) => a + x.r.prompt, 0), output: runs.reduce((a, x) => a + x.r.output, 0), seconds: Math.max(...runs.map((x) => x.r.seconds)), compute: +runs.reduce((a, x) => a + (x.r.compute || 0), 0).toFixed(3) };
  if (orders === 1) return { ...runs[0].read, ...cost };
  // the two passes' probabilities, per time (Z is Z in both)
  const key = (o) => (o.x ? o.x.text : "Z"), p = new Map(), first = runs[0].opts;
  for (const { opts, read } of runs) for (const o of opts) p.set(key(o), (p.get(key(o)) || 0) + (read.dist[o.id] || 0) / orders);
  const best = [...first].sort((a, b) => p.get(key(b)) - p.get(key(a)))[0];
  if (!runs.every((x) => x.read.mass)) return { pick: null, p: null, mass: 0, dist: {}, ...cost };
  return { pick: best, p: +p.get(key(best)).toFixed(4), mass: +(runs.reduce((a, x) => a + x.read.mass, 0) / orders).toFixed(4), dist: Object.fromEntries(first.map((o) => [o.id, +p.get(key(o)).toFixed(4)]).filter(([, v]) => v)), ...cost };
}

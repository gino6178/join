// JSON Schemas for what the model returns, and a small validator for the subset of JSON Schema (2020-12) they use:
// type, enum, const, required, properties, additionalProperties, items, minItems, maxItems, minLength, maxLength,
// pattern, minimum, maximum. The same schema goes to the model server as the output format (Ollama's `format`
// constrains decoding to it; an OpenAI-compatible server gets it as response_format), and code checks the result again,
// so a reply that does not fit is caught here rather than half-used.
export function validate(schema, v, at = "$") {
  const errs = [], type = Array.isArray(v) ? "array" : v === null ? "null" : typeof v;
  const types = [].concat(schema.type || []);
  if (types.length && !types.some((t) => t === type || (t === "integer" && Number.isInteger(v)) || (t === "number" && type === "number"))) return [`${at}: expected ${types.join(" or ")}, got ${type}`];
  if (schema.enum && !schema.enum.includes(v)) errs.push(`${at}: must be one of ${schema.enum.join(", ")}`);
  if ("const" in schema && v !== schema.const) errs.push(`${at}: must be ${schema.const}`);
  if (type === "string") {
    if (schema.minLength != null && v.length < schema.minLength) errs.push(`${at}: shorter than ${schema.minLength}`);
    if (schema.maxLength != null && v.length > schema.maxLength) errs.push(`${at}: longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(v)) errs.push(`${at}: does not match ${schema.pattern}`);
  }
  if (type === "number") {
    if (schema.minimum != null && v < schema.minimum) errs.push(`${at}: below ${schema.minimum}`);
    if (schema.maximum != null && v > schema.maximum) errs.push(`${at}: above ${schema.maximum}`);
  }
  if (type === "array") {
    if (schema.minItems != null && v.length < schema.minItems) errs.push(`${at}: fewer than ${schema.minItems} items`);
    if (schema.maxItems != null && v.length > schema.maxItems) errs.push(`${at}: more than ${schema.maxItems} items`);
    if (schema.items) v.forEach((x, i) => errs.push(...validate(schema.items, x, `${at}[${i}]`)));
  }
  if (type === "object") {
    for (const k of schema.required || []) if (!(k in v)) errs.push(`${at}.${k}: missing`);
    for (const [k, x] of Object.entries(v)) {
      if (schema.properties?.[k]) errs.push(...validate(schema.properties[k], x, `${at}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${at}.${k}: not allowed`);
      else if (typeof schema.additionalProperties === "object") errs.push(...validate(schema.additionalProperties, x, `${at}.${k}`));
    }
  }
  return errs;
}

const str = (maxLength, extra = {}) => ({ type: "string", maxLength, ...extra });
const DATE = "^\\d{4}-\\d{2}-\\d{2}$", TIME = "^([01]\\d|2[0-3]):[0-5]\\d$";
const optional = (p) => `^(${p.slice(1, -1)})?$`; // the same pattern, or nothing

// a member's agent answering a proposed time (a2a.js): the decision only. What it says to the other agent is a
// sentence made by code from the decision, so nothing from the member's private profile crosses to another agent and
// nothing can be made up on the way
export const MEMBER_REPLY = {
  type: "object", additionalProperties: false, required: ["intent"],
  properties: {
    intent: { enum: ["accept", "counter", "decline"] },
    // a date and a start only mean something with a counter: with a yes or a no the model leaves them empty, which
    // fits (it used to cost a second call to say so)
    date: str(10, { pattern: optional(DATE) }), start: str(5, { pattern: optional(TIME) }),
    // every listed time that works for the member (the acceptable-set protocol, a2a.js), by its id
    works: { type: "array", maxItems: 12, items: { type: "string", pattern: "^t\\d{1,2}$" } },
  },
};
// the decision artifact a member's agent returns over A2A (a2a_server.js): the reply, which tier made it, and what it
// cost. Your agent checks it against this before using any of it, since the other agent may be anyone's.
export const DECISION = {
  type: "object", additionalProperties: false, required: ["intent"],
  properties: {
    ...MEMBER_REPLY.properties,
    tier: { enum: ["quick", "draft", "agent", "rules", "student", "decider"] }, confidence: { type: "number", minimum: 0, maximum: 1 },
    // the listed times it does not answer about (its member's disclosure budget, disclosure.js): neither a yes nor a no
    withheld: { type: "array", maxItems: 12, items: { type: "string", pattern: "^t\\d{1,2}$" } },
    usage: { type: "object", additionalProperties: { type: "number", minimum: 0 } },
  },
};
// what a Serve proposal carries over A2A (a2a.js sends it, a2a_server.js reads it): facts only, nothing in free text,
// so a sentence from another agent has no way to the receiving agent's model. `say`, the sending agent's own sentence,
// is kept in the task's history and never shown to it.
export const GAME_SPORTS = ["badminton", "tennis", "pickleball", "table tennis", "basketball", "volleyball", "soccer", "football"];
const OFFER = { type: "object", additionalProperties: false, required: ["date", "start"], properties: { id: { type: "string", pattern: "^t\\d{1,2}$" }, date: str(10, { pattern: DATE }), start: str(5, { pattern: TIME }),
  venue: { type: "string", pattern: "^[A-Za-z0-9_:./-]{1,128}$" }, court: { type: "integer", minimum: 1, maximum: 99 }, trip: { type: "integer", minimum: 0, maximum: 600 } } };
// who asks: an id on the gateway (a member's, or "you" for the gateway's own player), never free text
const ASKER = { type: "string", pattern: "^[A-Za-z0-9_.:-]{1,64}$" };
export const PROPOSAL = { type: "object", additionalProperties: false, required: ["kind", "sport", "format", "proposal", "choices"], properties: { kind: { const: "serve.proposal" }, sport: { enum: GAME_SPORTS }, format: { enum: ["singles", "doubles"] },
  minutes: { type: "integer", minimum: 30, maximum: 240 }, proposal: OFFER, choices: { type: "array", minItems: 1, maxItems: 12, items: OFFER }, say: { type: "string", maxLength: 400 }, from: ASKER } };
// "how likely is a yes" (docs/agent_matchmaking_plan.md, section 5): the asker, the game and up to twelve times, facts
// only; the answer is a band, nothing else (match/likely.js answers it, match/ask.js sends it)
export const BANDS = ["unlikely", "maybe", "likely", "very likely"];
const WHEN = { type: "object", additionalProperties: false, required: ["date", "start"], properties: { date: str(10, { pattern: DATE }), start: str(5, { pattern: TIME }), venue: { type: "string", pattern: "^[A-Za-z0-9_:./-]{1,128}$" } } };
export const LIKELY = { type: "object", additionalProperties: false, required: ["kind", "from", "sport", "format", "times"], properties: { kind: { const: "serve.likely" }, from: ASKER, sport: { enum: GAME_SPORTS }, format: { enum: ["singles", "doubles"] },
  minutes: { type: "integer", minimum: 30, maximum: 240 }, times: { type: "array", minItems: 1, maxItems: 12, items: WHEN } } };
// (p: the exact chance, rounded to 0.05, only from a member whose card declares it; the asking side checks the step)
export const LIKELY_ANSWER = { type: "object", additionalProperties: false, required: ["band"], properties: { band: { enum: BANDS }, model: { type: "string", pattern: "^[A-Za-z0-9_.-]{1,40}$" }, until: { type: "integer", minimum: 0 }, p: { type: "number", minimum: 0.15, maximum: 1 } } };
// a hold over A2A (a2a.js sends it once a talk agrees a time, a2a_server.js answers it): which talk, which time, and
// whether to hold it or let it go; the answer says whether it is held. A release may say why: the asker dropped the
// game, or (two at a time) another member took it; `say` is the sending agent's own sentence, made by code, kept and
// never shown to a model. "book" comes from a peer gateway that is booking the game: the hold becomes the member's
// game on the member's side (peer.js), and the answer says booked.
export const HOLD = { type: "object", additionalProperties: false, required: ["kind", "action", "ref", "date", "start", "minutes"], properties: { kind: { const: "serve.hold" }, action: { enum: ["hold", "release", "book"] },
  ref: { type: "string", pattern: "^[A-Za-z0-9_.:-]{1,80}$" }, date: str(10, { pattern: DATE }), start: str(5, { pattern: TIME }), minutes: { type: "integer", minimum: 30, maximum: 240 },
  why: { enum: ["dropped", "taken"] }, say: { type: "string", maxLength: 300 },
  // (with "book": the player's signed mandate, peer.js)
  mandate: { type: "string", maxLength: 4000, pattern: "^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$" } } };
export const HELD = { type: "object", additionalProperties: false, required: ["held"], properties: { held: { type: "boolean" }, booked: { type: "boolean" }, until: { type: "integer", minimum: 0 }, reason: str(120) } };
// one calendar entry read from a message (life.js)
const EVENT = {
  type: "object", additionalProperties: false, required: ["date", "title", "kind"],
  properties: { date: str(10, { pattern: DATE }), start: { type: "string", maxLength: 5 }, end: { type: "string", maxLength: 5 }, title: str(80), kind: { enum: ["training", "match", "exam", "travel", "other"] } },
};
// what a message to the agent is: a calendar entry, a finished session, or anything else (life.js)
export const FILED = {
  type: "object", additionalProperties: false, required: ["intent"],
  properties: {
    intent: { enum: ["event", "log", "chat"] },
    events: { type: "array", maxItems: 8, items: EVENT },
    log: { type: "object", additionalProperties: false, properties: { date: { type: "string", maxLength: 10 }, minutes: { type: "number", minimum: 0, maximum: 600 }, what: str(160), pain: str(160) } },
  },
};
export const EVENTS = { type: "array", maxItems: 8, items: EVENT };
// a court judged for a game (places.js)
export const VERDICT = {
  type: "object", additionalProperties: false, required: ["verdict", "reasons"],
  properties: {
    verdict: { enum: ["good", "maybe", "no"] },
    reasons: { type: "array", minItems: 1, maxItems: 4, items: { type: "object", additionalProperties: false, required: ["text", "cite"], properties: { text: str(200), cite: { type: "string", pattern: "^(map|weather|review [1-9])$" }, quote: str(160) } } },
  },
};
// place names in English, by number (places.js)
export const NAMES = { type: "object", additionalProperties: str(80) };
// (a tool call's arguments are checked against the tool's own parameters schema: see chatTools in llm.js)

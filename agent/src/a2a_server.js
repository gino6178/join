// The club members' agents as A2A agents (Agent2Agent protocol v1.0, JSON-RPC binding), on the official A2A SDK
// (@a2a-js/sdk, Apache 2.0) and served by the gateway:
//   GET  /a2a/agents                                     the club's agents and their cards (Serve's own directory)
//   GET  /a2a/members/<id>/.well-known/agent-card.json   one agent's Agent Card
//   POST /a2a/members/<id>/                              JSON-RPC: SendMessage, GetTask, CancelTask, ListTasks
// Each member's agent is the SDK's DefaultRequestHandler with its own card, a task store on disk (FileTaskStore,
// written whole to a temporary file and renamed) and an AgentExecutor (MemberExecutor). Your agent proposes a game time
// with SendMessage: one data part, a Serve proposal (facts only: the time, the other times that fit everyone, and the
// sentence your agent's code made, which this side keeps but never shows its model). The executor answers by the member's decision rule (a2a.js decide) inside a task: SUBMITTED, WORKING, then
// COMPLETED with a "decision" artifact (accept, counter with a time, or decline, and its sentence), or FAILED. One
// negotiation is one contextId, and an agent reads what was said earlier in the same context. A message is answered
// once: the same messageId sent again (after a crash, say) gets the answer already given, from disk, without the
// model; that is what lets a negotiation resume without anyone answering twice. (Only for the same proposal: a message
// id that comes back with other times is refused, so an old yes can never be applied to a new list.)
// The proposal carries facts only (dates, starts, a venue id, a court, the member's trip): the agent writes each time out
// itself, so nothing another agent wrote reaches its model. With AGENT_TOKEN set, JSON-RPC needs the bearer token, and
// the card says so (securitySchemes); a member's agent answers only this machine unless A2A_PUBLIC=1 (auth.js).
// Another Serve gateway (a peer, peer.js) signs each request with its own key instead of a token. A member's agent
// answers a peer only if the allow-list shares that member with it, and the peer's tasks, talks, holds and asker ids are
// kept apart from this gateway's own (docs/a2a_two_gateways.md).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import express from "express";
import { A2A_PROTOCOL_VERSION, AGENT_CARD_PATH, TaskState, Role, generateAgentCardSignature } from "@a2a-js/sdk";
import { DefaultRequestHandler, AgentEvent, UnauthenticatedUser } from "@a2a-js/sdk/server";
import { agentCardHandler, jsonRpcHandler, UserBuilder } from "@a2a-js/sdk/server/express";
import { readClub } from "./club.js";
import { decide, first, when, holdAnswer, inTalk, breaks, budgeted } from "./a2a.js";
import { validate, PROPOSAL, HOLD, LIKELY } from "./schema.js";
import * as likely from "./match/likely.js";
import { decided as noteAnswer } from "./match/hooks.js";
import { ensureDemo } from "./match/records.js";
import { memberById } from "./match/players.js";
import { job, totals } from "./ledger.js";
import { readJSON, writeJSON } from "./jsonfile.js";
import { authorized, loopback, required } from "./auth.js";
import { crashPoint } from "./crash.js";
import { span, within, agentAttrs } from "./trace.js";
import { withPriority } from "./llm.js";
import { helpers, held as heldNow } from "./play.js";
import { placeById, toTown } from "./places.js";
import * as peer from "./peer.js";

const { toMin, hm, dateOf, readVenues, travelMin, DAYS } = helpers;
const DATA = path.resolve(process.env.A2A_DATA || "data");
const atomic = writeJSON, load = readJSON;

// the SDK's TaskStore, on disk: every task of every member's agent, kept across restarts (the newest 600)
class FileTaskStore {
  constructor(file) {
    this.file = file; this.tasks = load(file, {});
    // a task still submitted or working was cut off when the last process stopped: it will not finish, so it fails
    // (the message it answered is sent again by the resumed negotiation, and gets a task of its own)
    let cut = 0;
    for (const t of Object.values(this.tasks)) if ([TaskState.TASK_STATE_SUBMITTED, TaskState.TASK_STATE_WORKING].includes(t.status?.state)) { t.status = { state: TaskState.TASK_STATE_FAILED, timestamp: new Date().toISOString() }; cut++; }
    if (cut) atomic(file, this.tasks);
  }
  async save(task) {
    this.tasks[task.id] = { ...task, savedAt: Date.now() };
    const ids = Object.keys(this.tasks);
    if (ids.length > 600) for (const id of ids.sort((a, b) => this.tasks[a].savedAt - this.tasks[b].savedAt).slice(0, ids.length - 600)) delete this.tasks[id];
    atomic(this.file, this.tasks);
  }
  async load(id) { const t = this.tasks[id]; if (!t) return undefined; const { savedAt, ...task } = t; return task; }
  async list(p = {}) {
    const all = Object.values(this.tasks).filter((t) => (!p.agent || t.metadata?.agent === p.agent) && (p.owner === undefined || (t.metadata?.owner || null) === p.owner) && (!p.contextId || t.contextId === p.contextId) && (!p.status || t.status?.state === p.status)).sort((a, b) => b.savedAt - a.savedAt);
    const size = Math.min(100, p.pageSize || 50), from = +(p.pageToken || 0);
    return { tasks: all.slice(from, from + size).map(({ savedAt, ...t }) => t), nextPageToken: from + size < all.length ? String(from + size) : "", pageSize: size, totalSize: all.length };
  }
}
const store = new FileTaskStore(path.join(DATA, "a2a_tasks.json"));
// one agent's view of the store: it sees (GetTask, ListTasks, CancelTask) and saves only its own tasks, and of those
// only the ones its caller made (this gateway's own, or one peer gateway's, which the SDK's call context names)
class AgentTaskStore {
  constructor(shared, agent) { this.shared = shared; this.agent = agent; }
  async save(task, ctx) {
    const owner = peer.callerOf(ctx) ?? (await this.shared.load(task.id))?.metadata?.owner ?? null;
    return this.shared.save({ ...task, metadata: { ...(task.metadata || {}), agent: this.agent, ...(owner ? { owner } : {}) } });
  }
  async load(id, ctx) { const t = await this.shared.load(id); return t && t.metadata?.agent === this.agent && (t.metadata?.owner || null) === peer.callerOf(ctx) ? t : undefined; }
  list(p = {}, ctx) { return this.shared.list({ ...p, agent: this.agent, owner: peer.callerOf(ctx) }); }
}
// the answers given, by messageId: replayed when the same message comes again, and read back as the talk so far
const ANSWERS = path.join(DATA, "a2a_answers.json");
let answers = load(ANSWERS, {});
const remember = (id, a) => { answers[id] = a; const ks = Object.keys(answers); if (ks.length > 1500) for (const k of ks.sort((x, y) => answers[x].at - answers[y].at).slice(0, ks.length - 1500)) delete answers[k]; atomic(ANSWERS, answers); };

// a hold is only for a time this agent said works in that talk (its contextId), so another agent can't use holds to
// block a member's week
// (an answer saved before holds existed has no list: any time it answered about counts)
const agreedIn = (ref, agent, date, start) => Object.values(answers).some((a) => a.contextId === ref && a.agent === agent && (!a.oks || a.oks.includes(`${date} ${start}`)));
const answeredIn = (ref, agent) => Object.values(answers).some((a) => a.contextId === ref && a.agent === agent);
const heldArtifact = (ctx, data) => AgentEvent.artifactUpdate({ taskId: ctx.taskId, contextId: ctx.contextId, artifact: { artifactId: "hold", name: "hold", description: "whether the agreed time is held", parts: [part("data", data, "application/json")], metadata: undefined, extensions: [] }, lastChunk: true, append: false, metadata: undefined });

// a proposal (the data part of the message) fits PROPOSAL in schema.js: facts only. The agent writes each time out
// itself (spell)
// a time in words, made here from its facts (the venue's name from this server's own list)
const venueName = (id) => { try { return readVenues().venues.find((v) => v.id === id)?.name || null; } catch { return null; } };
export const spell = (x, minutes, them) => `${when(x.date, x.start)}–${hm(toMin(x.start) + minutes)}${x.venue ? ` at ${venueName(x.venue) || "the proposed venue"}` : ""}${x.court ? `, court ${x.court}` : ""}${x.trip != null ? ` (${them}'s trip ${x.trip} min)` : ""}`;
// what makes two proposals the same: the facts, in a fixed order (a message id is answered again only for these)
const fingerprint = (p) => crypto.createHash("sha256").update(JSON.stringify([p.sport, p.format, p.minutes || 90, [p.proposal, ...p.choices].map((x) => [x.id || "", x.date, x.start, x.venue || "", x.court || 0])])).digest("hex").slice(0, 32);

const part = (kind, value, mediaType) => ({ content: { $case: kind, value }, metadata: undefined, filename: "", mediaType });
const agentMessage = (ctx, text) => ({ role: Role.ROLE_AGENT, messageId: crypto.randomUUID(), parts: [part("text", text, "text/plain")], taskId: ctx.taskId, contextId: ctx.contextId, extensions: [], metadata: {}, referenceTaskIds: [] });
const status = (ctx, state, text) => AgentEvent.statusUpdate({ taskId: ctx.taskId, contextId: ctx.contextId, status: { state, timestamp: new Date().toISOString(), message: text ? agentMessage(ctx, text) : undefined }, metadata: undefined });
const decision = (ctx, data, text) => AgentEvent.artifactUpdate({ taskId: ctx.taskId, contextId: ctx.contextId, artifact: { artifactId: "decision", name: "decision", description: "accept, counter or decline, and the agent's sentence", parts: [part("data", data, "application/json"), part("text", text, "text/plain")], metadata: undefined, extensions: [] }, lastChunk: true, append: false, metadata: undefined });

// what this agent heard and said earlier in the same negotiation, in the shape decide() reads
const earlier = (contextId, agent) => Object.values(answers).filter((a) => a.contextId === contextId && a.agent === agent).sort((a, b) => a.at - b.at)
  .flatMap((a, i) => [{ from: "you", intent: "propose", when: a.when || "", round: i + 1 }, { from: agent, intent: a.decision.intent, when: a.decision.intent === "counter" ? `${a.decision.date} ${a.decision.start}` : undefined, round: i + 1 }]);

// the messages being answered now, by message id: one sent again meanwhile waits for that answer (in this process)
const answering = new Map();
class MemberExecutor {
  constructor(m) { this.m = m; this.running = new Map(); }
  // CancelTask: the task ends CANCELED at once (the model call it started is left to finish, and its answer is dropped)
  cancelTask = async (taskId, bus) => { const ctx = this.running.get(taskId); if (!ctx) return; this.running.delete(taskId); bus.publish(status(ctx, TaskState.TASK_STATE_CANCELED, `${first(this.m.name)}'s agent stopped.`)); };
  async execute(ctx, bus) {
    const m = this.m, msg = ctx.userMessage;
    // a peer gateway's request is kept under its own names: message ids, the talk (and so its holds), the asker
    const caller = peer.callerOf(ctx.context), sc = peer.scoped(caller), ref = sc.ref(ctx.contextId);
    let settled = null; // (this message's answer while it is being made: answering, below)
    bus.publish(AgentEvent.task(ctx.task ?? { id: ctx.taskId, contextId: ctx.contextId, status: { state: TaskState.TASK_STATE_SUBMITTED, timestamp: new Date().toISOString() }, artifacts: [], history: [msg], metadata: { agent: m.id } }));
    try {
      const p = msg.parts.find((x) => x.content?.$case === "data")?.content.value;
      if (p?.kind === "serve.hold") {
        const bad = validate(HOLD, p);
        if (bad.length) { bus.publish(status(ctx, TaskState.TASK_STATE_FAILED, `${first(m.name)}'s agent reads a serve.hold: ${bad.slice(0, 2).join("; ")}`)); return; }
        // (a hold, or its release, comes from its own talk: the talk's id is what lets an agent touch it)
        // ("book": a peer gateway books the game, and the hold becomes the member's game here; this gateway's own
        // bookings are play.js's)
        let mandateOk = null;
        const d = p.ref !== ctx.contextId ? { held: false, reason: "a hold belongs to its own talk" }
          : p.action === "book" && !caller ? { held: false, reason: "this gateway books its own games" }
          : ["hold", "book"].includes(p.action) && !agreedIn(ref, m.id, p.date, p.start) ? { held: false, reason: "not a time this agent said works in that talk" }
          : p.action === "release" && !answeredIn(ref, m.id) ? { held: false, reason: "not a talk this agent answered in" }
          // (a booking needs the player's signed mandate, for this talk, this time and this member, used once)
          // (the same booking sent again on a broken connection, already made with this mandate, is the same booking)
          : p.action === "book" && !(mandateOk = peer.acceptMandate(p.mandate, { caller, ref: p.ref, date: p.date, start: p.start, minutes: p.minutes, member: m.id })).ok
            && !(mandateOk.why === "mandate-replay" && heldNow(m.id).some((l) => l.ref === ref && l.booked)) ? { held: false, reason: mandateOk.message }
          : holdAnswer(m, { ...p, ref });
        bus.publish(heldArtifact(ctx, d)); bus.publish(status(ctx, TaskState.TASK_STATE_COMPLETED)); return;
      }
      // "how likely is a yes" (match/likely.js): a band from this member's own records, in code; a refusal is
      // REJECTED with one fixed sentence, whatever the reason
      if (p?.kind === "serve.likely") {
        const bad = validate(LIKELY, p);
        if (bad.length) { bus.publish(status(ctx, TaskState.TASK_STATE_FAILED, `${first(m.name)}'s agent reads a serve.likely: ${bad.slice(0, 2).join("; ")}`)); return; }
        const club = readClub(); await ensureDemo(club).catch(() => 0);
        // (an asker on another gateway is an asker of its own here, with no rating this side knows)
        const r = likely.answer(m, { ...p, from: sc.from(p.from) }, { club: caller ? { ...club, you: { ...club.you, rating: 1500 } } : club, venues: readVenues(), breaks, travelMin });
        // the extension, when the request named it (A2A-Extensions) as this card declares it: said back in the response
        const uri = likely.extension(process.env.A2A_BASE || "http://127.0.0.1:8790", m).uri;
        if (ctx.context?.requestedExtensions?.includes?.(uri)) ctx.context.addActivatedExtension(uri);
        if (r.refused) { bus.publish(status(ctx, TaskState.TASK_STATE_REJECTED, likely.REFUSAL)); return; }
        bus.publish(AgentEvent.artifactUpdate({ taskId: ctx.taskId, contextId: ctx.contextId, artifact: { artifactId: "likely", name: "likely", description: "how likely this member is to say yes, as a band", parts: [part("data", r, "application/json")], metadata: undefined, extensions: [] }, lastChunk: true, append: false, metadata: undefined }));
        bus.publish(status(ctx, TaskState.TASK_STATE_COMPLETED)); return;
      }
      const errors = p ? validate(PROPOSAL, p) : ["no data part"];
      if (errors.length) { bus.publish(status(ctx, TaskState.TASK_STATE_FAILED, `${first(m.name)}'s agent reads a serve.proposal: ${errors.slice(0, 2).join("; ")}`)); return; }
      // answered once: the same message gets the same answer, if it is the same proposal; a known id with other times
      // is refused (an old yes must not be read against new times)
      const fp = fingerprint(p), mid = sc.id(msg.messageId), prior = answers[mid];
      if (prior && prior.agent === m.id) {
        if (prior.fp !== fp) { bus.publish(status(ctx, TaskState.TASK_STATE_FAILED, `${first(m.name)}'s agent already answered message ${msg.messageId}, about other times; send the new times in a new message.`)); return; }
        bus.publish(decision(ctx, prior.decision, prior.text)); bus.publish(status(ctx, TaskState.TASK_STATE_COMPLETED)); return;
      }
      // the same message while it is still being answered (sent again on a connection that broke): that answer, once
      const still = answering.get(mid);
      if (still) { const a = await still; if (a?.fp === fp) { bus.publish(decision(ctx, a.decision, a.text)); bus.publish(status(ctx, TaskState.TASK_STATE_COMPLETED)); return; } }
      let settle; answering.set(mid, new Promise((ok) => { settle = ok; }));
      settled = { mid, settle };
      this.running.set(ctx.taskId, ctx);
      bus.publish(status(ctx, TaskState.TASK_STATE_WORKING, `${first(m.name)}'s agent is looking at ${first(m.name)}'s week`));
      const minutes = p.minutes || 90, them = first(m.name);
      // the member's own trip, from its own home to a club venue or a public place a search found, never the one the
      // proposer says (which could be low to get past a longest-trip rule). A venue this side can't place has no trip,
      // and a longest-trip rule then says no (a2a.js breaks).
      const own = (x) => { try {
        const vs = readVenues(), v = vs.venues.find((y) => y.id === x.venue), p = !v && placeById(x.venue);
        return !m.area ? null : v ? travelMin(m.area, v) : p && vs.map?.geo ? travelMin(m.area, toTown(vs.map.geo, p)) : null;
      } catch { return null; } };
      const offer = (x) => { const t = own(x); const y = t != null ? { ...x, trip: t } : x; return { id: x.id, slot: { date: x.date, day: DAYS[dateOf(x.date).getDay()] }, start: toMin(x.start), ...(t != null ? { trip: t } : x.venue ? { unplaced: true } : {}), text: spell(y, minutes, them) }; };
      const choices = p.choices.map(offer);
      let cur = choices.find((c) => c.slot.date === p.proposal.date && c.start === toMin(p.proposal.start));
      if (!cur) { cur = offer(p.proposal); choices.unshift(cur); }
      // the sender's own sentence (say) is kept in the task's history but never put in front of the model: only the
      // validated fields of the proposal reach it (an injected instruction in free text has nowhere to go)
      const log = [...earlier(ref, m.id), { from: "you", intent: "propose", when: cur.text, round: 0 }];
      // the trace context comes in the message's metadata (and the request's traceparent header), so this answer sits
      // under the talk that asked for it
      const j0 = await withPriority(msg.metadata?.["serve.priority"], () => within(msg.metadata || {}, () => span(`invoke_agent member:${m.id}`, { ...agentAttrs(`member:${m.id}`, ctx.contextId), "gen_ai.agent.id": `serve.member.${m.id}`, "a2a.task.id": ctx.taskId, "serve.a2a.context_id": ctx.contextId, "serve.a2a.task_id": ctx.taskId }, (s) =>
        job(`agent:${m.id}`, async (jb) => {
          const d = await inTalk(ref, () => decide(m, cur, choices, log, p.format, p.sport, minutes));
          // what answering cost, reported in the decision (the asking agent's ledger cannot see this request's calls)
          const t = totals(jb.calls); d.usage = { calls: t.calls, prompt: t.prompt, cached: t.cached, output: t.output, reasoning: t.reasoning, seconds: t.seconds };
          s.setAttributes({ "serve.decision": d.intent, "serve.works": (d.works || []).length, "serve.tier": d.tier || "agent", ...(d.overruled ? { "serve.overruled": true } : {}), ...(d.intent === "none" ? { "error.type": "no_answer" } : {}) }); return d;
        }))));
      if (!this.running.has(ctx.taskId)) return; // cancelled meanwhile
      if (j0.intent === "none") { bus.publish(status(ctx, TaskState.TASK_STATE_FAILED, j0.text)); return; }
      // what the member's disclosure budget lets this asker learn (disclosure.js): a time over it is withheld
      const j = budgeted(m, p.from || "you", cur, choices, j0);
      const data = { intent: j.intent, ...(j.intent === "counter" ? { date: j.date, start: j.start } : {}), ...(Array.isArray(j.works) ? { works: j.works } : {}), ...(j.withheld?.length ? { withheld: j.withheld } : {}), tier: j.tier, ...(j.confidence != null ? { confidence: j.confidence } : {}), ...(j.usage ? { usage: j.usage } : {}) };
      // the times it said work, so a hold for one of them can be checked later
      const key = (x) => `${x.slot.date} ${hm(x.start)}`, works = new Set(data.works || []);
      const oks = [...choices.filter((x) => x.id && works.has(x.id)).map(key), ...(data.intent === "accept" ? [key(cur)] : []), ...(data.intent === "counter" ? [`${data.date} ${data.start}`] : [])];
      remember(mid, { agent: m.id, contextId: ref, fp, when: cur.text, decision: data, oks, text: j.text, at: Date.now() });
      settle({ fp, decision: data, text: j.text });
      noteAnswer(m.id, { from: sc.from(p.from || "you"), date: cur.slot.date, start: hm(cur.start), intent: data.intent, works: data.works, ref }); // the member's own records
      crashPoint("answer-saved");
      bus.publish(decision(ctx, data, j.text));
      bus.publish(status(ctx, TaskState.TASK_STATE_COMPLETED));
    } catch (e) {
      bus.publish(status(ctx, TaskState.TASK_STATE_FAILED, `${first(m.name)}'s agent could not answer (${e.message}).`));
    } finally { this.running.delete(ctx.taskId); if (settled) { settled.settle(null); answering.delete(settled.mid); } }
  }
}

export function cardFor(base, m, club) {
  return {
    name: `${m.name}'s agent`,
    // (a real player's agent says so, and gives estimates only after they said yes; the others are simulated)
    description: m.real ? `Agrees games for ${first(m.name)}, a player of ${club.name} on Serve: answers a proposed time with yes, another time that suits ${first(m.name)}, or not this week. A real player's agent.`
      : `Agrees games for ${first(m.name)}, a member of ${club.name} on Serve: answers a proposed time with yes, another time that suits ${first(m.name)}, or not this week. A simulated member of the demo club.`,
    supportedInterfaces: [{ url: `${base}/`, protocolBinding: "JSONRPC", tenant: "", protocolVersion: A2A_PROTOCOL_VERSION }],
    provider: { organization: m.real ? "Serve" : "Serve demo club (simulated members)", url: `${process.env.A2A_BASE || ""}/a2a/agents` },
    version: "1.0.0",
    // serve.likely, declared as an A2A extension (a member who opted out declares none and has no such skill)
    capabilities: { streaming: false, pushNotifications: false, extensions: m.shares?.likely === false ? [] : [likely.extension(process.env.A2A_BASE || "http://127.0.0.1:8790", m)], extendedAgentCard: false },
    // (in the A2A JSON form a client reads: the SDK serves the card as it is given)
    ...(required() || peer.on() ? {
      securitySchemes: { ...(required() ? { bearer: { httpAuthSecurityScheme: { description: "The gateway's token (AGENT_TOKEN), as Authorization: Bearer <token>.", scheme: "Bearer", bearerFormat: "" } } } : {}),
        // another Serve gateway on the allow-list signs each request with its own key (peer.js)
        ...(peer.on() ? { peer: { apiKeySecurityScheme: { description: "For an allow-listed peer gateway: Serve-Signature, a compact JWS (EdDSA, typ serve-request+jwt) by the peer's pinned key over the method, the path, the SHA-256 of the body, this gateway's key id, a lifetime of 60 seconds at most and a nonce used once.", location: "header", name: "Serve-Signature" } } } : {}) },
      securityRequirements: [...(required() ? [{ schemes: { bearer: { list: [] } } }] : []), ...(peer.on() ? [{ schemes: { peer: { list: [] } } }] : [])] } : { securitySchemes: {}, securityRequirements: [] }),
    defaultInputModes: ["application/json", "text/plain"], defaultOutputModes: ["application/json", "text/plain"],
    skills: [{ id: "agree-game-time", name: "Agree a game time", description: `Answers a Serve proposal (a data part of kind "serve.proposal") for a ${(m.sports || ["badminton"]).join(" or ")} game: accept, counter with one of the listed times, or decline.`,
      tags: ["scheduling", "sports", "negotiation"], examples: ["Proposing badminton singles Thu 5 Nov 19:00–20:30 at Riverside Sports Centre, court 4"], inputModes: ["application/json"], outputModes: ["application/json", "text/plain"], securityRequirements: [] },
    { id: "hold-game-time", name: "Hold an agreed time", description: `Holds a time this agent said works in a talk, while the player decides (a data part of kind "serve.hold", in the same A2A context): held for 30 minutes, released on request, given way to the booking.`,
      tags: ["scheduling", "lease"], examples: ["Hold Thu 5 Nov 19:00 for 90 minutes"], inputModes: ["application/json"], outputModes: ["application/json"], securityRequirements: [] },
    ...(m.shares?.likely === false ? [] : [{ id: "estimate-yes", name: "How likely is a yes", description: `Answers a data part of kind "serve.likely" (up to 12 times) with a band: unlikely, maybe, likely or very likely${m.shares?.exact ? ", and the exact chance in steps of 0.05 from 0.15 up" : ""}, worked out on this side from ${first(m.name)}'s own records, which never leave it. A few estimates a day per asker; a refusal is REJECTED.`,
      tags: ["scheduling", "matchmaking"], examples: ["How likely is a yes to singles Thu 5 Nov 19:00?"], inputModes: ["application/json"], outputModes: ["application/json"], securityRequirements: [] }])],
    documentationUrl: "", signatures: [],
  };
}

// Signed Agent Cards (A2A v1.0, spec 8.4: a JWS over the card in JCS form, the SDK's generateAgentCardSignature). The
// gateway keeps one Ed25519 key (A2A_DATA/card-key.pem, made when there is none) and publishes its public half at
// /a2a/keys.json. Your agent checks a member's card against the key published at the card's own address, and that the
// card names that same address for its messages, before it talks to that agent (a2a_client.js). That shows whoever
// answers at the address endorsed the card; over plain HTTP someone on the path could replace both, so for agents on
// other servers it is worth as much as their TLS.
// (the key is A2A_DATA/card-key.pem, made once, never silently replaced: peer.js ownKey, which also signs this
// gateway's requests to its peers)
let keyState = null;
function cardKey() {
  if (keyState) return keyState;
  const { key, jwk, kid } = peer.ownKey(DATA);
  keyState = { kid, jwk, sign: generateAgentCardSignature(key, { alg: "EdDSA", kid, typ: "JOSE" }) };
  return keyState;
}
export const jwks = () => { const k = cardKey(); return { keys: [{ ...k.jwk, kid: k.kid, alg: "EdDSA", use: "sig" }] }; };
export const signCard = (card) => cardKey().sign(card);

// one SDK request handler (and router) per member's agent, made the first time it is called (its card signed once)
const routers = new Map();
function routerFor(m) {
  // (a card says what the member shares: a new choice is a new card)
  const k = `${m.id}|${m.shares?.likely !== false}|${!!m.shares?.exact}|${peer.on()}`;
  if (!routers.has(k)) routers.set(k, (async () => {
    const base = `${process.env.A2A_BASE || "http://127.0.0.1:8790"}/a2a/members/${m.id}`;
    const handler = new DefaultRequestHandler(await signCard(cardFor(base, m, readClub())), new AgentTaskStore(store, m.id), new MemberExecutor(m));
    const r = express.Router();
    r.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: handler }));
    // (a peer gateway's request is its own user: the task store and the executor keep its tasks and talks apart)
    r.use(jsonRpcHandler({ requestHandler: handler, userBuilder: (req) => Promise.resolve(req.servePeer ? peer.user(req.servePeer.peer) : new UnauthenticatedUser()) }));
    return r;
  })().catch((e) => { routers.delete(k); throw e; })); // (a card that could not be made is tried again next time)
  return routers.get(k);
}
const app = express();
// the key members' cards are signed with (public, like the cards)
app.get("/a2a/keys.json", (req, res) => { try { res.json(jwks()); } catch (e) { res.status(500).json({ error: "no signing key" }); } });
// what serve.likely is and what its bands mean (the extension's URI in each card)
app.get(likely.EXT_PATH, (req, res) => res.json(likely.describe()));
app.get("/a2a/agents", (req, res) => { const club = readClub(), base = process.env.A2A_BASE || ""; res.json({ club: club.name, agents: club.members.map((m) => ({ id: m.id, name: `${m.name}'s agent`, card: `${base}/a2a/members/${m.id}/${AGENT_CARD_PATH}` })) }); });
const rpcError = (message) => ({ jsonrpc: "2.0", id: null, error: { code: -32600, message } });
const serveMember = (m, req, res, next) => routerFor(m).then((r) => r(req, res, next)).catch(() => res.status(500).json({ error: "this agent's card could not be made" }));
// a peer's key set, fetched to pin it on first use (peer.js): from the peer's own origin, no redirects
const peerKeys = (origin) => fetch(`${origin}/a2a/keys.json`, { redirect: "error", signal: AbortSignal.timeout(10000) }).then((r) => { if (!r.ok) throw new Error(`keys: HTTP ${r.status}`); return r.json(); });
// A request from another Serve gateway: the body is read here (its hash is in the signature), the signature is checked
// against that peer's pinned key, and the member must be one the allow-list shares with that peer.
const rawJson = express.json({ limit: "256kb", verify: (req, res, buf) => { req.rawBody = buf; } });
function fromPeer(m, req, res, next) {
  rawJson(req, res, async (e) => {
    if (e) return res.status(400).json(rpcError("not a JSON body"));
    const v = await peer.verify({ method: req.method, path: req.originalUrl, headers: req.headers, body: req.rawBody, from: req.socket?.remoteAddress }, peerKeys).catch(() => ({ ok: false, message: "the signature could not be checked" }));
    if (!v.ok) return res.status(401).json(rpcError(`refused: ${v.message}`));
    if (!peer.serves(v.peer, m)) { peer.note("refused", { why: "member-not-shared", peer: v.peer, member: m.id, path: req.originalUrl }); return res.status(403).json(rpcError("this agent does not answer that gateway")); }
    req.servePeer = v;
    // the answer is signed for that request (peer.js signAnswer): its status, its body and the request's nonce
    const send = res.send.bind(res);
    res.send = function (body) {
      if (body != null && typeof body === "object" && !Buffer.isBuffer(body)) return this.json(body); // (json comes back here as a string)
      const b = Buffer.from(body == null ? "" : body);
      this.set(peer.HEADER, peer.signAnswer(v, this.statusCode, b));
      return send(b);
    };
    serveMember(m, req, res, next);
  });
}
app.use("/a2a/members/:id", (req, res, next) => {
  const m = memberById(req.params.id); if (!m) return res.status(404).json({ error: "no such agent" }); // (a club member, or a real player: match/players.js)
  // the card is public; JSON-RPC needs the token and comes from this machine (unless the agents are made public), or
  // carries an allow-listed peer gateway's signature (peer.js)
  if (req.method !== "GET") {
    if (req.headers[peer.HEADER]) return fromPeer(m, req, res, next);
    if (!loopback(req) && process.env.A2A_PUBLIC !== "1") return res.status(403).json(rpcError("this agent answers requests from its own server only"));
    if (!authorized(req)) return res.status(401).set("www-authenticate", "Bearer").json(rpcError("this agent needs its bearer token (see securitySchemes in its card)"));
  }
  serveMember(m, req, res, next);
});
// a request continues the caller's trace (its traceparent header), so a member's answer sits under the talk that asked
export const handle = (req, res) => within(req.headers, () => app(req, res));

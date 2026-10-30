// The venues' side as an A2A agent (Agent2Agent, JSON-RPC binding): another agent that speaks A2A rather than MCP can
// negotiate a court with Join's venue desk. The Agent Card is at /.well-known/agent-card.json. A request is one
// message with one data part, { "action": ..., ...arguments }, the same actions as the MCP tools; the answer is a
// message with one data part. Only structured data crosses: free text in a request is ignored, so nothing a model wrote
// on one side is read as an instruction on the other. The caller's player token goes in Authorization: Bearer.
import crypto from "node:crypto";
import * as ops from "./ops.js";
import { agentOf } from "./auth.js";

const ACTIONS = { whoami: ops.whoami, list_venues: (a, x) => ops.listVenues(x), find_options: ops.findOptions, start_negotiation: ops.startNegotiation, make_offer: ops.makeOffer, accept_price: ops.acceptPrice,
  walk_away: ops.walkAway, find_alternatives: ops.findAlternatives, my_games: ops.myGames, game_status: ops.gameStatus, pay_my_share: ops.payMyShare, decline_game: ops.declineGame, cancel_booking: ops.cancelBooking, propose_share: ops.proposeShare, answer_share: ops.answerShare };

export const card = (base) => ({
  protocolVersion: "0.3.0", name: "Join venue desk", version: "0.1.0",
  description: "Negotiates courts at Join's venues for a player's agent and settles the price with PayPal. Venue policies (discounts, a concession schedule, a floor that is never revealed) and each player's spending mandate are enforced in code. Send one data part: {\"action\": \"start_negotiation\" | \"make_offer\" | \"accept_price\" | \"find_alternatives\" | \"pay_my_share\" | ..., ...arguments}.",
  url: `${base}/a2a`, preferredTransport: "JSONRPC", capabilities: { streaming: false, pushNotifications: false },
  defaultInputModes: ["application/json"], defaultOutputModes: ["application/json"],
  securitySchemes: { player: { type: "http", scheme: "bearer", description: "A player's agent token from the Join website" } }, security: [{ player: [] }],
  skills: [
    { id: "negotiate_court", name: "Negotiate a court", description: "start_negotiation, make_offer, accept_price, walk_away: alternating offers on one court's price", tags: ["negotiation", "booking", "sports"], examples: ['{"action":"start_negotiation","venue":"north","sport":"badminton","date":"2026-11-05","start":"19:00","players":["leo","hana","tomas"]}'] },
    { id: "alternatives", name: "Alternatives nearby", description: "find_alternatives: other venues and public courts within a budget, ranked by trip and time", tags: ["map", "budget"] },
    { id: "settle", name: "Split and pay", description: "pay_my_share, game_status, decline_game, cancel_booking: the fee split per player and settled with PayPal", tags: ["payments", "paypal"] },
  ],
});

export async function handle(req, res) {
  const { id = null, method, params } = req.body || {};
  const reply = (result) => res.json({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => res.json({ jsonrpc: "2.0", id, error: { code, message } });
  if (!["message/send", "SendMessage"].includes(method)) return fail(-32601, "Only message/send is supported.");
  const a = agentOf(req);
  if (!a) return fail(-32001, "Unauthorized: send a player's agent token as Authorization: Bearer join_...");
  const part = (params?.message?.parts || []).find((p) => p.kind === "data" || p.data);
  const { action, ...args } = part?.data || {};
  const fn = ACTIONS[action];
  if (!fn) return fail(-32602, `data.action is one of ${Object.keys(ACTIONS).join(", ")}.`);
  const result = await fn({ ...a, client: `${a.client} via A2A` }, args);
  reply({ kind: "message", role: "agent", messageId: crypto.randomUUID(), contextId: params?.message?.contextId, parts: [{ kind: "data", data: result }] });
}

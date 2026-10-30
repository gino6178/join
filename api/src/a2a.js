// The venues' side as an A2A agent (Agent2Agent, JSON-RPC binding): another agent that speaks A2A rather than MCP can
// negotiate a unit with Join's venue desk. The Agent Card is at /.well-known/agent-card.json. A request is one
// message with one data part, { "action": ..., ...arguments }, the same actions as the MCP tools; the answer is a
// message with one data part. Only structured data crosses: free text in a request is ignored, so nothing a model wrote
// on one side is read as an instruction on the other. The caller's player token goes in Authorization: Bearer.
import crypto from "node:crypto";
import * as ops from "./ops.js";
import { agentOf, can, scopeError } from "./auth.js";

const ACTIONS = { whoami: ops.whoami, venue_reviews: (a, x) => ops.venueReviews(a, x), list_activities: () => ops.listActivities(), list_venues: (a, x) => ops.listVenues(x), find_options: ops.findOptions, start_negotiation: ops.startNegotiation, make_offer: ops.makeOffer, accept_price: ops.acceptPrice,
  walk_away: ops.walkAway, find_alternatives: ops.findAlternatives, my_plans: (a, x) => ops.myGames(a, x), booking_status: ops.gameStatus, pay_my_share: ops.payMyShare, decline_invite: ops.declineGame, cancel_booking: ops.cancelBooking, propose_share: ops.proposeShare, answer_share: ops.answerShare, request_reimbursement: ops.requestReimbursement };

export const card = (base) => ({
  protocolVersion: "0.3.0", name: "Join venue desk", version: "0.1.0",
  description: "Negotiates bookings at Join's venues (courts, karaoke rooms, escape rooms, tables, barbecue pits) for a person's agent and settles the price with PayPal. Venue policies (discounts, a concession schedule, a floor that is never revealed) and each person's spending mandate are enforced in code. Send one data part: {\"action\": \"start_negotiation\" | \"make_offer\" | \"accept_price\" | \"find_alternatives\" | \"pay_my_share\" | ..., ...arguments}.",
  url: `${base}/a2a`, preferredTransport: "JSONRPC", capabilities: { streaming: false, pushNotifications: false },
  defaultInputModes: ["application/json"], defaultOutputModes: ["application/json"],
  securitySchemes: { player: { type: "http", scheme: "bearer", description: "A player's agent token from the Join website" } }, security: [{ player: [] }],
  skills: [
    { id: "negotiate_booking", name: "Negotiate a booking", description: "start_negotiation, make_offer, accept_price, walk_away: alternating offers on one booking's price", tags: ["negotiation", "booking", "group plans"], examples: ['{"action":"start_negotiation","venue":"echo","activity":"karaoke","date":"2026-11-06","start":"20:00","minutes":120,"players":["leo","hana","tomas"]}'] },
    { id: "alternatives", name: "Alternatives nearby", description: "find_alternatives: other venues and free public places within a budget, ranked by trip and time", tags: ["map", "budget"] },
    { id: "settle", name: "Split and pay", description: "pay_my_share, propose_share, answer_share, booking_status, decline_invite, cancel_booking: the cost split per person, negotiated, and settled with PayPal", tags: ["payments", "paypal"] },
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
  const result = can(a, action) ? await fn({ ...a, client: `${a.client} via A2A` }, args) : scopeError(action);
  reply({ kind: "message", role: "agent", messageId: crypto.randomUUID(), contextId: params?.message?.contextId, parts: [{ kind: "data", data: result }] });
}

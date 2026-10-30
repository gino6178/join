// Join as an MCP server (Streamable HTTP, stateless): the way a player's own agent (Claude Code, Claude Desktop, any MCP
// client) uses Join. Each request carries the player's token (Authorization: Bearer join_...); the tools act for that
// player only. Tool descriptions are written for the model that reads them: what the tool does, what comes back, and
// the rules the platform enforces whatever the agent does.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import * as ops from "./ops.js";
import { agentOf } from "./auth.js";

const SPORT = z.enum(["badminton", "tennis", "pickleball", "table tennis", "basketball", "volleyball"]);
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("YYYY-MM-DD, the town's local date");
const TIME = z.string().regex(/^\d{2}:\d{2}$/).describe("HH:MM, 24-hour local time");
const MINUTES = z.union([z.literal(60), z.literal(90), z.literal(120)]).default(90);
const READ = { readOnlyHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

const INSTRUCTIONS = `Join is a marketplace for pickup games. You act for one player (whoami). You can find who is free, negotiate a court's price with a venue, and pay the player's share with PayPal.
Rules the platform enforces, whatever you do: the player's mandate (per-game and weekly limits, allowed venues) can't be exceeded and only the player can change it on the website; only the organizer's agent negotiates; a venue's last counter is its best and final; nothing is charged until a person approves in PayPal, unless the player saved PayPal for you and the amount is within their mandate.
Typical flow: find_options -> start_negotiation -> make_offer (or accept_price) -> pay_my_share (the organizer guarantees the whole court first) -> game_status. When a price is over budget or refused, the reply includes alternatives nearby; offer them to your user. Always tell your user what you agreed and show them any approveUrl.`;

function build(agent) {
  const s = new McpServer({ name: "join", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  const out = (r) => ({ content: [{ type: "text", text: JSON.stringify(r, null, 1) }], structuredContent: r, isError: !!r?.error });
  const tool = (name, title, description, inputSchema, annotations, fn) => s.registerTool(name, { title, description, inputSchema, annotations: { title, ...annotations } }, async (args) => out(await fn(agent, args)));

  tool("whoami", "Who you act for", "The player you act for, their usual free times, and their mandate: the limits on what you may commit them to (read-only).", {}, READ, (a) => ops.whoami(a));
  tool("list_venues", "Venues", "Venues in town with their sports, courts, hourly prices, discounts and how far they negotiate; plus free public courts (not bookable).", { sport: SPORT.optional() }, READ, (a, x) => ops.listVenues(x));
  tool("find_options", "Find people and times", "Times in the next week (or the given dates) when your player and enough other players are free, each with the fairest venue (shortest longest trip) that has a court, and its opening price. Does not contact anyone.",
    { sport: SPORT.default("badminton"), dates: z.array(DATE).max(7).default([]), from: TIME.optional(), to: TIME.optional(), minutes: MINUTES, players: z.number().int().min(1).max(11).default(3).describe("how many others: 1 for singles, 3 for doubles"), with: z.array(z.string()).default([]).describe("player ids your user asked for") }, READ, (a, x) => ops.findOptions(a, x));
  tool("start_negotiation", "Ask a venue for a price", "Open a negotiation with a venue for one court. Returns the venue's ask, its discounts, cheaper terms at the same venue, each player's share, and alternatives if the share is over your player's per-game limit. Expires in 15 minutes. At most 5 per venue per day.",
    { venue: z.string(), sport: SPORT, date: DATE, start: TIME, minutes: MINUTES, players: z.array(z.string()).max(11).default([]).describe("the other players' ids") }, WRITE, (a, x) => ops.startNegotiation(a, x));
  tool("make_offer", "Offer a price", "Offer a total price for the court, in USD. At or above the venue's current ask: deal at the ask. Below: the venue counters on its schedule; its last counter is best and final, and offering below that ends the negotiation (alternatives included). A deal is binding: the organizer then guarantees the court in PayPal.",
    { negotiation: z.string(), amount: z.number().positive().describe("total for the court, USD") }, WRITE, (a, x) => ops.makeOffer(a, x));
  tool("accept_price", "Accept the venue's price", "Accept the venue's current ask. Binding: creates the booking, and the organizer must guarantee the whole court in PayPal within 10 minutes (pay_my_share).", { negotiation: z.string() }, WRITE, (a, x) => ops.acceptPrice(a, x));
  tool("walk_away", "Walk away", "Close an open negotiation without a deal.", { negotiation: z.string() }, WRITE, (a, x) => ops.walkAway(a, x));
  tool("find_alternatives", "Other places nearby", "Other venues (and free public courts) for the same game, ranked: within the budget per person, same start time, shortest longest trip, price. Each with a reason.",
    { sport: SPORT, date: DATE, start: TIME, minutes: MINUTES, players: z.array(z.string()).default([]), budget: z.number().positive().optional().describe("USD per person; defaults to the per-game limit"), exclude: z.string().optional().describe("a venue id to leave out") }, READ, (a, x) => ops.findAlternatives(a, x));
  tool("my_games", "Your negotiations and bookings", "Every negotiation and booking your player is in, with each one's state.", {}, READ, (a) => ops.myGames(a));
  tool("game_status", "A booking's state", "One booking: its state, who has paid, your player's payment and any approveUrl.", { booking: z.string() }, READ, (a, x) => ops.gameStatus(a, x));
  tool("pay_my_share", "Pay your player's share", "Start or check your player's payment for a booking. The organizer authorizes the whole price first (it guarantees the court); then each player authorizes their share. With saved PayPal and within the mandate it is authorized at once; otherwise returns approveUrl (PAYER_ACTION_REQUIRED): show it to your user. Money is captured only when the court is locked.",
    { booking: z.string() }, WRITE, (a, x) => ops.payMyShare(a, x));
  tool("decline_game", "Decline a game", "Your player won't play in a booking someone else organized. Any authorization of theirs is voided.", { booking: z.string() }, { ...WRITE, destructiveHint: true }, (a, x) => ops.declineGame(a, x));
  tool("cancel_booking", "Cancel a booking (organizer)", "Before the court is locked: voids every authorization, nobody is charged. Once locked, until 24 hours before the game: refunds everyone in full.", { booking: z.string() }, { ...WRITE, destructiveHint: true }, (a, x) => ops.cancelBooking(a, x));
  return s;
}

export async function handle(req, res) {
  const agent = agentOf(req);
  if (!agent) {
    res.status(401).set("WWW-Authenticate", 'Bearer realm="join"').json({ jsonrpc: "2.0", error: { code: -32001, message: "Join needs a player's agent token: make one on the website (Connect your agent) and send it as Authorization: Bearer join_..." }, id: null });
    return;
  }
  if (req.method !== "POST") { res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Stateless server: POST only." }, id: null }); return; }
  const server = build(agent), transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

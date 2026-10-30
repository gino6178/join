// WebMCP (github.com/webmachinelearning/webmcp): Join's page offers its actions as tools to an AI agent built into the
// browser (Chrome, Edge, the ChatGPT browser), so a person's browser agent can plan with Join without screen-scraping.
// The tools run as the signed-in person, through the same endpoints and limits as Join's website agent, and say so in
// the activity log ("Browser agent (WebMCP)"). Accepting a price is binding, so the person confirms it on the page;
// paying stays in PayPal. Registered only when the browser has document.modelContext, and unregistered on sign-out.
import { api } from "./api.js";

const call = (tool, args) => api(`/api/scout/${tool}`, { method: "POST", body: { ...args, _model: "webmcp" } }).catch((e) => e.body || { error: "failed", message: e.message });
const text = (x) => ({ content: [{ type: "text", text: typeof x === "string" ? x : JSON.stringify(x) }] });

const TOOLS = [
  { name: "join-find-options", description: "Find times, friends who are free, and the fairest venue for a group activity, for the signed-in person. Returns up to five options with the venue's opening price and each person's share.",
    inputSchema: { type: "object", properties: {
      activity: { type: "string", description: "badminton, tennis, pickleball, basketball, volleyball, table tennis, karaoke, escape room, board games, bbq or hot pot" },
      dates: { type: "array", items: { type: "string", description: "YYYY-MM-DD" } }, from: { type: "string", description: "HH:MM" }, to: { type: "string", description: "HH:MM" },
      others: { type: "integer", description: "how many people besides the person" }, with: { type: "array", items: { type: "string" }, description: "friends' ids to include" } }, required: ["activity"] },
    readOnly: true,
    execute: async ({ activity, dates = [], from, to, others = 3, with: w = [] }) => text(await call("find_options", { activity, dates, from, to, players: others, with: w })) },
  { name: "join-negotiate", description: "Negotiate one option with its venue, patiently (an offer just over 70% of the ask each round, which is what moves Join's venues), and return the venue's final price. Does not accept: use join-accept for that.",
    inputSchema: { type: "object", properties: { venue: { type: "string" }, activity: { type: "string" }, date: { type: "string" }, start: { type: "string" }, minutes: { type: "integer" }, players: { type: "array", items: { type: "string" }, description: "the other people's ids" } }, required: ["venue", "activity", "date", "start", "players"] },
    execute: async (o) => {
      let n = await call("start_negotiation", o);
      while (!n.error && n.status === "open" && !n.final && n.roundsLeft > 0) n = await call("make_offer", { negotiation: n.id, amount: Math.ceil(+n.ask * 70 + 1) / 100 });
      return text(n.error ? n : { negotiation: n.id, status: n.status, venue: n.venueName, price: n.agreed?.amount || n.ask, each: n.share, final: n.final, ifYouAccept: n.ifYouAccept || n.youGuarantee });
    } },
  { name: "join-accept", description: "Accept a negotiated price. Binding: the person is asked to confirm on the page, then guarantees the whole booking in PayPal until their friends pay.",
    inputSchema: { type: "object", properties: { negotiation: { type: "string" } }, required: ["negotiation"] },
    execute: async ({ negotiation }) => {
      const plans = await api("/api/games").catch(() => null), n = plans?.negotiations?.find((x) => x.id === negotiation);
      if (!n) return text({ error: "unknown_negotiation" });
      if (!window.confirm(`Your browser's agent wants to accept ${n.venueName}, ${n.activity} on ${n.date} at ${n.start}, for $${n.ask}.\n\nYou guarantee the whole $${n.ask} in PayPal until your friends pay; you pay your own share unless someone doesn't. Accept?`)) return text({ error: "declined_by_person" });
      const r = await call("accept_price", { negotiation });
      if (!r.error && r.booking) location.hash = `/games?booking=${r.booking.id}`;
      return text(r);
    } },
  { name: "join-my-plans", description: "The signed-in person's open negotiations and bookings, with who has paid.", inputSchema: { type: "object", properties: {} }, readOnly: true,
    execute: async () => text(await call("my_plans", { all: false })) },
];

let controller = null;
export async function registerWebMcp() {
  const mc = document.modelContext;
  if (!mc?.registerTool || controller) return false;
  controller = new AbortController();
  for (const { readOnly, ...t } of TOOLS) {
    try { await mc.registerTool({ ...t, ...(readOnly ? { annotations: { readOnlyHint: true } } : {}) }, { signal: controller.signal }); } catch (e) { console.warn("WebMCP", t.name, e.message); }
  }
  return true;
}
export function unregisterWebMcp() { controller?.abort(); controller = null; }
export const webMcpAvailable = () => !!document.modelContext?.registerTool;

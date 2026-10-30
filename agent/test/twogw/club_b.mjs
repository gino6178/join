// Gateway B's club (docs/a2a_two_gateways.md): a second club for the peer gateway on the cloud VM, made by code from a
// seed (population.js), so every member is simulated and no real player's data is in it. Writes:
//   <dir>/club.json    gateway B's club: its members with their calendars, rules and habits (this stays on B)
//   <dir>/roster.json  what gateway A may know of them, for A's peers file: id, name, level, sports, prefers
//   node test/twogw/club_b.mjs <dir> [members=10] [seed=31]
import fs from "node:fs";
import path from "node:path";
import { member } from "../../src/population.js";

const [dir = "data/twogw-b", n = "10", seed = "31"] = process.argv.slice(2);
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"));
const base = JSON.parse(fs.readFileSync(path.join(HERE, "../../../web/public/data/club.json"), "utf8"));
const used = new Set();
const members = Array.from({ length: +n }, (_, i) => {
  const m = member(i, +seed);
  if (used.has(m.name)) m.name = `${m.name} ${i + 1}`; // (names are unique in the club)
  used.add(m.name);
  return { ...m, id: `nb${String(i + 1).padStart(2, "0")}`, agent: m.agent.replace("A simulated member.", "A simulated member of Northside.") };
});
// gateway B's own player (for its own talks): simulated too
const me = member(99, +seed);
const club = {
  name: "Northside Club (simulated)", demo: true, note: "A second club for the two-gateway test: every member is simulated, made by code from a seed.",
  night: base.night, challenge: base.challenge, levels: base.levels, badges: base.badges, sports: base.sports,
  members, feed: [], incoming: [], results: [],
  you: { free: me.free, venue: me.venue, area: me.area, rating: me.rating, w: 0, l: 0, form: [], history: [], level: me.level, sports: me.sports },
};
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "club.json"), JSON.stringify(club, null, 1));
fs.writeFileSync(path.join(dir, "roster.json"), JSON.stringify(members.map((m) => ({ id: m.id, name: m.name, level: m.level, sports: m.sports, prefers: m.prefers })), null, 1));
console.log(`${members.length} simulated members for gateway B in ${dir}: ${members.map((m) => `${m.id} ${m.name} (${m.free.join(", ")}${Object.keys(m.rules).length ? `; ${JSON.stringify(m.rules)}` : ""})`).join(" | ")}`);

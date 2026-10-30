// A game recap's one line, as code writes it from the booking's facts, for one reader: the players' first names ("You"
// for the reader), singles or doubles, the day and the venue. Nothing a model wrote, nothing the players said.
import { deps } from "./deps.js";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export function lineFor({ players = [], game = {} }, viewer) {
  const names = players.map((p) => (p.id === viewer ? "you" : p.member ? String(p.name).split(" ")[0] : deps.nameOf(p.id)?.split(" ")[0] || "a member"));
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0] || "Members";
  const day = game.date ? DAY_NAMES[new Date(`${game.date}T12:00:00`).getDay()] : null;
  return `${list} played ${game.format || game.sport || "a game"}${day ? ` on ${day}` : ""}${game.venue ? ` at ${game.venue}` : ""}.`.replace(/^./, (c) => c.toUpperCase());
}

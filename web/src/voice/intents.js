// What a spoken (or typed) question means, and the answer the app can give straight away from the club and your
// bookings, with the page that shows it. Rules, not a model: every number is counted from your own games. Anything
// else goes to your agent (ask: true), which answers on Muse Glimmer.
import { week, challenge } from "../club/week.js";
import { ratings } from "../club/arena.js";

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const DAY = { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday" };

export function answer(raw, { club, tasks = [], results = [], goal = 2 }) {
  const t = raw.toLowerCase().replace(/[.,!?]/g, " "), has = (re) => re.test(t);
  if (has(/highlight|reel|instagram|slow ?mo/)) return { say: "Opening Film a highlight: choose a video of your game and it comes back as a reel.", go: "highlights" };
  if (has(/autopilot|plan my week|line up/)) return { say: "Starting the Autopilot: it lines up your week with the people you play best with.", go: "autopilot?run=1" };
  if (has(/\b(hurts?|sore|pain|knee|ankle|back|shoulder|body log)\b/)) return { say: "Opening your body log: tell me what hurts and I'll plan around it.", go: `body?say=${encodeURIComponent(raw)}` };
  if (has(/courts? near|where can (i|we) play/)) return { say: "Looking for courts near you.", go: "courts" };
  if (has(/remember|memory|forget/)) return { say: "Opening what your agent remembers.", go: "memory" };
  if (!club) return { ask: true };
  const w = week(club, { results, tasks, goal });
  if (has(/next game|when (do|am) i (play|playing)|what'?s (booked|on)/)) {
    const n = w.booked[0];
    return n ? { say: `Your next game: ${DAY[n.day] || n.day} ${n.start}, ${n.format} at ${n.venue?.name}.`, go: "goals" } : { say: "Nothing is booked this week yet. Say when you'd like to play and I'll find a game.", go: "play" };
  }
  if (has(/streak|in a row/)) return { say: `${plural(w.streak, "week")} in a row with a game. Your goal was met ${w.met} of the last eight weeks.`, go: "goals" };
  if (has(/challenge/) && has(/club/)) { const c = challenge(club, w); return c ? { say: `${c.title}: ${c.total} of ${c.target} club games so far, ${plural(c.yours, "game")} yours.`, go: "goals" } : { ask: true }; }
  if (has(/how many games|games (this|a) week|my goal|this week/)) return { say: `${w.played} played and ${w.booked.length} booked this week, of your goal of ${goal}.${w.left ? ` ${plural(w.left, "game")} to go.` : ""}`, go: "goals" };
  if (has(/rating|rank|leaderboard/)) return { say: `Your club rating is ${ratings(club, results).you}.`, go: "club?tab=ranks" };
  if (has(/want to play|book|find (me )?a game|play (on|this|next|tomorrow|tonight|with)|doubles|singles/)) return { say: "Opening Play: your agent finds the court and the people.", go: `play?q=${encodeURIComponent(raw)}` };
  return { ask: true };
}

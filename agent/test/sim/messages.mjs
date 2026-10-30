// Labeled messages for the two calls that file what a player writes: life.read (a calendar entry, a finished session,
// or anything else) and body.read (which part hurts, which side, how much). Made from templates with known answers,
// in the ways players write them; seeded.
//   node test/sim/messages.mjs [seed=5] > test/sim/messages.json
let s = +(process.argv[2] || 5) >>> 0;
const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const any = (xs) => xs[Math.floor(rnd() * xs.length)];
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const ACT = ["club training", "badminton practice", "a singles match", "doubles with the club", "a tennis lesson", "basketball run", "a league match"];
const NAMES = ["Leo", "Hana", "Kenji", "Noor", "Sam", "Priya"];
const H = (h) => `${String(h).padStart(2, "0")}:00`, ampm = (h) => (h > 12 ? `${h - 12}pm` : `${h}am`);

const filing = [];
for (let i = 0; i < 16; i++) { // calendar entries, with the start time the entry must have
  const d = any(DAYS), h = any([7, 9, 10, 18, 19, 20]), a = any(ACT), f = any([0, 1, 2, 3]);
  const text = [`${a} on ${d} at ${H(h)}`, `I have ${a} ${d} ${H(h)}-${H(h + 2)}`, `${d} ${ampm(h)}: ${a}`, `Put ${a} in my calendar for ${d} at ${ampm(h)}`][f];
  filing.push({ id: `f${i}`, text, intent: "event", start: H(h) });
}
for (let i = 0; i < 14; i++) { // finished sessions, with how long they lasted
  const n = any([45, 60, 90, 120]), who = any(NAMES), f = any([0, 1, 2, 3]);
  const dur = n >= 60 && n % 60 === 0 ? `${n / 60} hour${n > 60 ? "s" : ""}` : `${n} minutes`;
  const text = [`played ${dur} with ${who}`, `just finished ${dur} of smash practice`, `did a ${n} min session at the club`, `trained for ${dur} today, felt good`][f];
  filing.push({ id: `l${i}`, text, intent: "log", minutes: n });
}
for (let i = 0; i < 10; i++) { // questions and other chat
  filing.push({ id: `c${i}`, text: any(["when is my next game?", "who have I played most this month?", "can I bring a friend to club night?", "is Leo free on Thursday?", "thanks!", "can you explain the leaderboard?", "what's my win rate this month?", "how many games did I play this week?"]), intent: "chat" });
}

const PART = [["knee", "knee", true], ["ankle", "ankle", true], ["shoulder", "shoulder", true], ["calf", "calf", true], ["wrist", "wrist", true], ["lower back", "lowerback", false], ["elbow", "elbow", true]];
const LEVEL = [[1, ["barely", "a tiny bit"]], [2, ["a bit", "slightly"]], [3, ["3 out of 5", "it hurts"]], [4, ["really bad", "4 out of 5"]]];
const body = [];
for (let i = 0; i < 24; i++) {
  const [word, part, sided] = any(PART), side = sided ? any(["left", "right"]) : null, [level, says] = any(LEVEL), say = any(says), f = any([0, 1, 2]);
  const where = side ? `${side} ${word}` : word, kind = any(["sore", "hurts", "aches"]);
  const text = [`My ${where} is ${kind === "hurts" ? "hurting" : kind}, ${say}`, `${where[0].toUpperCase() + where.slice(1)} ${kind} after the game, ${say}`, `Got a ${say === "it hurts" ? "painful" : "sore"} ${where} this morning (${say})`][f];
  body.push({ id: `b${i}`, text, part, side, level });
}
console.log(JSON.stringify({ filing, body }, null, 1));

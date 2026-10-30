// How well memory.js finds what the player said, scored on retrieval alone (as LongMemEval does for indexing and
// retrieval, before any model reads the notes): 20 questions an agent asks while planning, each with the one note that
// answers it, worded differently from the question, among 40 other notes. DRAMA (meaning) against BM25 (words).
//   node test/memory_eval.mjs [out.json]
import fs from "node:fs";

process.env.MEMORY_FILE ||= "data/memory-eval.json";
const memory = await import("../src/memory.js");
const OUT = process.argv[2] || "data/memory_eval.json";

// [question the agent asks, the note that answers it]
const PAIRS = [
  ["Is there anyone the player does not want to play with right now?", "Please leave Tomás out of my games for a few weeks. We had a falling out after the league match."],
  ["Which weekend in December can't the player play?", "My sister's wedding is on 12 December, so that weekend is out."],
  ["Should we avoid any courts when the weather is bad?", "Riverside's courts get slippery when it rains, I'd rather not play there on wet days."],
  ["What part of their game is the player working on?", "I'm trying to fix my backhand clears this month, so drills that make me hit them are good."],
  ["Who does the player enjoy doubles with?", "Doubles with Hana went really well last time, we should team up again."],
  ["How late can the player stay out on weeknights?", "I need to be home by 22:00 on work nights, my train is early."],
  ["Does the player have a preference for indoor or outdoor?", "I'd take a hall with air conditioning over an outdoor court any day in summer."],
  ["Is the player willing to travel far for a game?", "Anything more than half an hour away is too far for me after work."],
  ["Has the player mentioned a budget for court fees?", "I don't want to pay more than 300 dollars for a court."],
  ["What day does the player have a regular commitment?", "Every Wednesday I pick my daughter up from swimming, so no games then."],
  ["Is the player up for competitive matches or casual games?", "I'm keen to play some proper matches with scoring, not just rallying."],
  ["Did the player say anything about early mornings?", "Saturdays before nine are too early for me, I'm not a morning person."],
  ["Is there a partner the player wants to see more often?", "Kenji always pushes me, I'd like to play him more."],
  ["Did the player ask to keep games short?", "My knee feels better if I stop after an hour."],
  ["Has the player said how many games a week they want?", "Three games a week is my target this season."],
  ["Is the player away on a trip soon?", "I'm in Tokyo for work from the 3rd to the 7th of November."],
  ["Does the player prefer a particular venue?", "The courts at Da'an Sports Center have the best lighting."],
  ["Has the player said anything about playing with beginners?", "I don't mind helping newer players, mixed levels are fine with me."],
  ["Did the player want to try another sport?", "I'd like to try pickleball with a few club people sometime."],
  ["Is there a time the player is free at short notice?", "Sunday afternoons are usually open if someone cancels."],
];
const DISTRACT = ["Got a new racket, the Astrox 88S. Feels great on smashes.", "The club barbecue last month was fun.", "My phone battery dies fast, so reply quickly.", "I watched the world championships final on Sunday.",
  "Strings broke again, need to restring.", "The parking near the stadium is terrible.", "I ate too much at dinner yesterday.", "My shoes are getting worn out.", "The new club logo looks nice.",
  "I've been reading about footwork patterns.", "My cousin plays tennis in Kaohsiung.", "The weather app was wrong again today.", "I lost my water bottle at the hall.", "Our team chat is too noisy.",
  "I like watching old badminton videos at night.", "The vending machine at the hall is broken.", "My train was late this morning.", "I started stretching before bed.", "The shuttlecocks we used were slow.",
  "My grip tape needs replacing.", "Someone left a towel at court 3.", "I signed up for the newsletter.", "My laptop is being repaired.", "I tried a new energy drink.", "The hall's music was loud.",
  "I posted a photo from the tournament.", "My neighbour asked about joining the club.", "The bus route changed.", "I bought a new bag for my gear.", "The scoreboard app crashed once.",
  "I prefer blue grips.", "The coffee near the courts is good.", "I've been sleeping better lately.", "My brother visited last weekend.", "The club website is slow.",
  "I found a cheaper shop for shuttles.", "The changing rooms were cold.", "I like the new lights in hall B.", "My watch counts steps wrong.", "The league table is out."];

const notes = [...PAIRS.map(([, a], i) => ({ text: a, at: Date.parse("2026-10-01") + i * 864e5 })), ...DISTRACT.map((t, i) => ({ text: t, at: Date.parse("2026-09-01") + i * 864e5 }))];
async function score(name, find) {
  const ranks = [];
  for (const [q, a] of PAIRS) { const hits = await find(q); const r = hits.findIndex((h) => (h.note ?? h.text) === a); ranks.push(r < 0 ? null : r + 1); }
  const n = ranks.length, at = (k) => ranks.filter((r) => r && r <= k).length;
  return { name, questions: n, recallAt1: +(at(1) / n).toFixed(3), recallAt3: +(at(3) / n).toFixed(3), mrr: +(ranks.reduce((s, r) => s + (r ? 1 / r : 0), 0) / n).toFixed(3), ranks };
}
const t0 = Date.now();
const drama = await score(`DRAMA (facebook/drama-base, ${process.env.MEMORY_DIM || 768} dims${process.env.MEMORY_RANK === "hybrid" ? ", fused with BM25" : ""})`, async (q) => (await memory.recallIn(notes, q, { k: notes.length, min: -1 })).notes);
const dramaSeconds = (Date.now() - t0) / 1000;
const bm = await score("BM25 (words)", async (q) => memory.bm25(notes, q, notes.length));
const out = { at: new Date().toISOString(), notes: notes.length, questions: PAIRS.length, drama: { ...drama, seconds: +dramaSeconds.toFixed(1), by: (await memory.recallIn(notes, PAIRS[0][0])).by }, bm25: bm };
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log(`${notes.length} notes, ${PAIRS.length} questions\n` + [out.drama, out.bm25].map((x) => `${x.name}: recall@1 ${x.recallAt1}, recall@3 ${x.recallAt3}, MRR ${x.mrr}`).join("\n") + `\n(DRAMA ran as ${out.drama.by}, ${out.drama.seconds} s)`);
process.exit(0);

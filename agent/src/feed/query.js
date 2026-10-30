// What the reading agent searches for, and the fence around it. A query is a sport the club plays and one of a fixed
// list of topics, nothing else: no player's name, words, games, body log or anything from the store ever goes into a
// request to OpenAlex, arXiv or Semantic Scholar. sources.js refuses any query whose words are not all from this
// file's vocabulary, so even a wrong caller cannot send player data out.
export const SPORTS = ["badminton", "tennis", "basketball", "pickleball", "table tennis", "volleyball", "soccer", "squash", "padel", "futsal", "netball", "handball", "running", "swimming", "cycling"];
// the club's sports first (badminton, tennis and basketball always), in the order the club lists them
export const ALWAYS = ["badminton", "tennis", "basketball"];
// fixed topics: what a club's members might like to read about, never about one person
export const TOPICS = ["injury epidemiology", "match physical demands", "motor skill learning", "recreational participation", "performance analysis", "biomechanics", "fatigue recovery"];
// words a query may hold (the search syntax around them is the clients' own)
export const VOCAB = new Set([...SPORTS, ...TOPICS].flatMap((s) => s.split(" ")));

export function sportsOf(club = {}) {
  const listed = [...(club.sports || []), ...(club.members || []).flatMap((m) => m.sports || [])].map((s) => String(s).toLowerCase().trim());
  return [...new Set([...ALWAYS, ...listed])].filter((s) => SPORTS.includes(s));
}
// the queries for one run: pairs of sport and topic, taken in turn so every sport and topic comes round
export function plan(club, { turn = 0, n = 2 } = {}) {
  const sports = sportsOf(club), out = [];
  for (let k = 0; k < n; k++) {
    const i = turn + k, sport = sports[i % sports.length], topic = TOPICS[Math.floor(i / sports.length) % TOPICS.length];
    out.push({ sport, topic, q: clean(`${sport} ${topic}`) });
  }
  return { queries: out, turn: turn + n };
}
// a query as it may leave this server, or an error: lowercase words from the vocabulary only
export function clean(q) {
  const t = String(q ?? "").trim().replace(/\s+/g, " ");
  if (!/^[a-z ]{3,80}$/.test(t)) throw new Error("a query is lowercase words only");
  const bad = t.split(" ").filter((w) => !VOCAB.has(w));
  if (bad.length) throw new Error(`a query holds only sports and the fixed topics (not "${bad[0]}")`);
  return t;
}

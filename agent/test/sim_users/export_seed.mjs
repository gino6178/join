// What the simulated users made in one run, as a seed the demo can load (the cold start: a club that already has
// people, games, posts and ideas). Every row is marked simulated, and nothing in it is anyone real's.
//   node test/sim_users/export_seed.mjs <run folder> [--out test/sim_users/seed]
// The seed (load_seed.mjs loads it, into a data folder named explicitly, and never on its own):
//   members.json   the twenty as club members (SIM_USERS=<seed folder> adds them to the gateway's club)
//   records.json   their own matchmaking records from the run (match_records.json rows: what their agents answered,
//                  the games they played), so their agents' bands start from something
//   games.json     the games booked in the run: when, who, where, and whether everyone turned up
//   feed.json      their Club feed posts, likes and comments (when the run had the feed)
//   loop.json      the ideas they shared with the club (the sentences, never who: the loader makes the HMAC with the
//                  target's own secret), their votes, and what the loop made of them
//   manifest.json  the run, the seed, the counts, the dates, and how to load it
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { trialClub } from "./personas.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const write = (f, x) => fs.writeFileSync(f, JSON.stringify(x, null, 1) + "\n");

export function exportSeed(runDir, out = path.join(HERE, "seed")) {
  const data = path.join(runDir, "agent/data"), personas = read(path.join(runDir, "personas.json"), null)?.personas;
  if (!personas) throw new Error(`no personas.json in ${runDir}`);
  const result = Object.values(Object.fromEntries(fs.readdirSync(runDir).filter((f) => /^sim_users_.*\.json$/.test(f)).map((f) => [f, read(path.join(runDir, f), null)])))[0];
  const ids = new Set(personas.map((p) => p.id)), first = (id) => personas.find((p) => p.id === id)?.name;
  fs.mkdirSync(out, { recursive: true });
  const dates = result?.days?.map((d) => d.date) || [];
  const note = "Simulated: made by Serve's user simulation (agent/test/sim_users), by simulated people. None of it is a real person's.";
  // the members
  write(path.join(out, "members.json"), { simulated: true, note, members: trialClub(personas).members });
  // their own records (only theirs, and only rows about them and each other)
  const rec = read(path.join(data, "match_records.json"), { members: {} }).members || {};
  write(path.join(out, "records.json"), { simulated: true, note, members: Object.fromEntries(Object.entries(rec).filter(([id]) => ids.has(id)).map(([id, r]) => [id, { ...r, asked: (r.asked || []).filter((a) => a.from === "you" || ids.has(a.from)), simulated: true }])) });
  // the games
  const bookings = read(path.join(data, "bookings.json"), { bookings: [] }).bookings || [];
  const games = (result?.serveGames || []).map((g) => ({ simulated: true, ...g, names: [g.by, ...g.with].map(first) }));
  write(path.join(out, "games.json"), { simulated: true, note, trial: { first: dates[0] || null, last: dates.at(-1) || null },
    games, bookings: bookings.filter((b) => ids.has(b.option?.by)).map((b) => ({ simulated: true, id: `SIM-${b.id}`, created: b.created, option: { ...b.option }, invites: b.invites || [], need: b.need, log: (b.log || []).map((l) => ({ at: l.at, text: l.text })), cancelled: !!b.cancelled })) });
  // the feed: what they posted, liked and commented
  const feed = read(path.join(data, "feed.json"), null);
  const mine = (x) => ids.has(x?.by?.player) || ids.has(x?.by?.agentOf);
  write(path.join(out, "feed.json"), { simulated: true, note, on: !!feed, posts: (feed?.posts || []).filter(mine).filter((x) => !x.held && !x.hidden).map((x) => ({ ...x, id: `sim-u-${x.id}`, simulated: true, likes: (x.likes || []).filter((l) => ids.has(l)), comments: (x.comments || []).filter(mine).map((c) => ({ ...c, simulated: true })), reports: [] })) });
  // the loop: the shared sentences, by player id (the run's HMACs are made with the run's own secret)
  const secret = fs.existsSync(path.join(data, "loop/secret")) ? fs.readFileSync(path.join(data, "loop/secret"), "utf8").trim() : null;
  const whoMap = secret ? Object.fromEntries(personas.map((p) => [crypto.createHmac("sha256", secret).update(p.id).digest("hex"), p.id])) : {};
  const sig = read(path.join(data, "loop/signals.json"), { items: [] }), state = read(path.join(data, "loop/ideas.json"), { clusters: [], votes: {} });
  const items = (sig.items || []).filter((x) => whoMap[x.who]).map(({ who, guard, vec, ...x }) => ({ ...x, player: whoMap[who], simulated: true }));
  const votes = Object.entries(state.votes || {}).flatMap(([month, byWho]) => Object.entries(byWho).filter(([w]) => whoMap[w]).flatMap(([w, mine]) => Object.entries(mine).map(([proposal, n]) => ({ month, player: whoMap[w], proposal, votes: n }))));
  write(path.join(out, "loop.json"), { simulated: true, note, items, votes, clusters: (result?.loop?.clusters || []), proposals: (result?.loop?.proposals || []), outcome: result?.loop?.outcome || null });
  const manifest = { simulated: true, note, run: result?.headline?.run || path.basename(runDir), seed: result?.headline?.seed ?? null, made: new Date().toISOString(), trial: { first: dates[0] || null, last: dates.at(-1) || null },
    counts: { members: personas.length, records: Object.keys(rec).filter((id) => ids.has(id)).length, games: games.length, played: games.filter((g) => g.played).length, posts: (feed?.posts || []).filter(mine).length, items: items.length, votes: votes.length },
    load: "node test/sim_users/load_seed.mjs --into <the demo gateway's data folder> --yes, then start that gateway with SIM_USERS=test/sim_users/seed LOOP_SIMULATED=1 SIM_SEED=<seed> (docs/simulated_users.md)" };
  write(path.join(out, "manifest.json"), manifest);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [run] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const i = process.argv.indexOf("--out");
  if (!run) { console.error("usage: export_seed.mjs <run folder> [--out dir]"); process.exit(2); }
  console.log(JSON.stringify(exportSeed(path.resolve(run), i > 0 ? path.resolve(process.argv[i + 1]) : undefined), null, 1));
}

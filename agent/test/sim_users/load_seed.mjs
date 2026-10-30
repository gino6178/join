// Loads the simulated users' seed (export_seed.mjs) into a gateway's data folder, for the demo's cold start. A separate,
// explicit step: it writes only into the folder named with --into, only with --yes, and keeps a copy of every file it
// changes (<file>.before-sim-seed-<time>). Every row it adds is marked simulated; --remove takes them out again.
//   node test/sim_users/load_seed.mjs --into <data folder> [--seed test/sim_users/seed] [--yes] [--remove]
// Then start that gateway with SIM_USERS=<seed folder> (the twenty join the club, as simulated members) and
// LOOP_SIMULATED=1 SIM_SEED=<the run's seed> (the Ideas tab says the club is simulated).
// What it loads (the dates moved so that the trial's last day is yesterday):
//   match_records.json   the members' own records (their agents' bands)
//   bookings.json        the games they booked, in the past
//   feed.json            their posts, likes and comments
//   loop/signals.json    the ideas they shared, under HMACs made with this folder's own loop secret
// It never touches players.json (nobody is linked on Messenger) or anything of a real player.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const DAY = 864e5;

export function plan({ into, seed = path.join(HERE, "seed"), now = Date.now(), remove = false } = {}) {
  if (!into) throw new Error("--into <data folder> is required: the seed is loaded only where it is told to go");
  const S = (f) => read(path.join(seed, f), null), manifest = S("manifest.json");
  if (!manifest?.simulated) throw new Error(`${seed} is not a simulated users' seed (no manifest marked simulated)`);
  const ids = new Set((S("members.json")?.members || []).filter((m) => m.simulated).map((m) => m.id));
  // the dates move so that the trial's last day is yesterday
  const last = manifest.trial?.last ? Date.parse(`${manifest.trial.last}T12:00:00`) : now - DAY, today = new Date(now); today.setHours(12, 0, 0, 0);
  const shift = Math.round((today.getTime() - DAY - last) / DAY) * DAY;
  const day = (s) => { const d = new Date(Date.parse(`${s}T12:00:00`) + shift); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const changes = [];
  // the members' records
  const recF = path.join(into, "match_records.json"), rec = read(recF, { members: {} });
  rec.members ||= {};
  for (const id of Object.keys(rec.members)) if (ids.has(id) && rec.members[id]?.simulated) delete rec.members[id];
  if (!remove) for (const [id, r] of Object.entries(S("records.json")?.members || {})) {
    if (rec.members[id] && !rec.members[id].simulated) throw new Error(`${recF} already has a member ${id} that is not simulated: not overwriting it`);
    const t = (x) => (typeof x === "number" ? x + shift : x);
    rec.members[id] = { ...r, simulated: true, asked: (r.asked || []).map((a) => ({ ...a, t: t(a.t), date: a.date && day(a.date) })), own: (r.own || []).map((o) => ({ ...o, t: t(o.t) })), games: (r.games || []).map((g) => ({ ...g, t: t(g.t), date: g.date && day(g.date) })) };
  }
  changes.push([recF, rec]);
  // the games, as past bookings
  const bkF = path.join(into, "bookings.json"), bk = read(bkF, { bookings: [] });
  bk.bookings = (bk.bookings || []).filter((b) => !(b.simulated && String(b.id).startsWith("SIM-")));
  if (!remove) bk.bookings = [...bk.bookings, ...(S("games.json")?.bookings || []).map((b) => ({ ...b, simulated: true, created: b.created + shift, option: { ...b.option, date: day(b.option.date) }, log: (b.log || []).map((l) => ({ ...l, at: l.at + shift })) }))];
  changes.push([bkF, bk]);
  // the feed
  const fdF = path.join(into, "feed.json"), fd = read(fdF, null), posts = S("feed.json")?.posts || [];
  if (fd || posts.length) {
    const f = fd || { version: 1, posts: [], drafts: [], uploads: [], papers: { seen: {}, runs: [], turn: 0 }, rate: {}, seeded: false };
    f.posts = (f.posts || []).filter((x) => !(x.simulated && String(x.id).startsWith("sim-u-")));
    if (!remove) f.posts = [...f.posts, ...posts.map((x) => ({ ...x, simulated: true, at: x.at + shift, comments: (x.comments || []).map((c) => ({ ...c, at: c.at + shift })) }))];
    changes.push([fdF, f]);
  }
  // the loop's shared items, under this folder's own secret
  const loopDir = path.join(into, "loop"), secF = path.join(loopDir, "secret"), sigF = path.join(loopDir, "signals.json");
  const secret = process.env.LOOP_SECRET || (fs.existsSync(secF) ? fs.readFileSync(secF, "utf8").trim() : null);
  const sig = read(sigF, { consent: {}, rows: {}, pending: {}, items: [], held: [], blocked: 0 });
  sig.items = (sig.items || []).filter((x) => !x.simulated);
  const items = S("loop.json")?.items || [];
  if (!remove && items.length) {
    const s = secret || crypto.randomBytes(32).toString("hex");
    if (!secret) changes.push([secF, s, { mode: 0o600 }]);
    sig.items.push(...items.map(({ player, ...x }) => ({ ...x, who: crypto.createHmac("sha256", s).update(String(player)).digest("hex"), at: x.at + shift, ok: true, guard: { safe: true, seeded: true }, simulated: true })));
  }
  changes.push([sigF, sig]);
  return { manifest, shift: shift / DAY, changes, counts: { records: Object.values(rec.members).filter((m) => m.simulated).length, bookings: bk.bookings.filter((b) => b.simulated).length, posts: posts.length, items: items.length } };
}

export function apply(p, { now = Date.now() } = {}) {
  for (const [f, x, opt] of p.changes) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    if (fs.existsSync(f)) fs.copyFileSync(f, `${f}.before-sim-seed-${now}`);
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, typeof x === "string" ? x : JSON.stringify(x), opt || {});
    fs.renameSync(tmp, f);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
  const into = a("into") && path.resolve(a("into")), seed = path.resolve(a("seed") || path.join(HERE, "seed")), remove = process.argv.includes("--remove");
  try {
    const p = plan({ into, seed, remove });
    console.log(`${remove ? "Removing" : "Loading"} the simulated users' seed (run ${p.manifest.run}, seed ${p.manifest.seed}) ${remove ? "from" : "into"} ${into}; dates moved ${p.shift} days.`);
    for (const [f] of p.changes) console.log(`  ${path.relative(process.cwd(), f)}`);
    console.log(`  simulated rows after: ${JSON.stringify(p.counts)}`);
    if (!process.argv.includes("--yes")) { console.log("Nothing written: add --yes to write (a copy of each file is kept)."); process.exit(0); }
    apply(p);
    console.log(`Written. Start the gateway with SIM_USERS=${seed} LOOP_SIMULATED=1 SIM_SEED=${p.manifest.seed ?? 1}.`);
  } catch (e) { console.error(String(e.message || e)); process.exit(1); }
}

// Two gateways on two machines (docs/a2a_two_gateways.md). This process is gateway A, on the GPU server: its A2A server
// (the demo club's members' agents, on 127.0.0.1:23790, which gateway B reaches through the tunnel's reverse forward)
// and your agent's Talk code. Gateway B is the systemd service on the cloud VM serve-api-a100b (us-central1-b): ten
// simulated members of its own club, their calendars, rules, records and holds on that machine, its own key and token,
// reached at 127.0.0.1:23890 through the SSH tunnel (twogw/gw_tunnel.sh). Nothing is shared but what crosses the wire.
//   1. Trust and the hop: B's key pinned on first use, A's pinned by B on A's first request; bands from B's members
//      (serve.likely, with A2A-Extensions); the latency the hop to us-central1 adds (a key-set GET, a proposal answered by
//      code, an estimate: at A's own gateway and at B).
//   2. Talks: N talks where 1 to 3 members are on B (singles and doubles, with A's members), run two at a time with a B
//      member in common. An agreed time is held on both gateways (all or nothing), then booked (B's agents confirm and
//      their hold becomes the game there) or let go. Probes check B's side afterwards: a booked time is refused there, a
//      time let go is free again. Then a booking whose hold was let go and taken by another talk meanwhile: B refuses it
//      when the booking checks again, and nothing is booked on either side.
//   3. Forged requests to B: unsigned, an unknown key, a replay, a changed body, another member's path, an old request,
//      one meant for another gateway, a third gateway using A's key id, a member B does not share with A.
//   4. B stopped mid-run (the PC's driver, test/twogw/drive.sh, acts on the MARK lines): B frozen while a request is in
//      flight (the request is given up on missed probes); B's service stopped (talks with its members end "not
//      reachable now" at once, A's talks go on); a release that B could not hear while it was down is delivered once B
//      is back, and B has no stray hold.
//   cd ~/shuttlecoach-meta/twogw/agent && LLM_URL=http://127.0.0.1:11445/v1 LLM_SLOTS=8 EMBED_URL=http://127.0.0.1:11445 \
//     ~/shuttlecoach/node/bin/node test/a2a_two_gateways.mjs [N=12] > /tmp/serve_twogw_eval.log 2>&1
// Results: data/twogw-a/result.json.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const N = +(process.argv[2] || 12), A_PORT = +(process.env.A_PORT || 23790), B = process.env.B_ORIGIN || "http://127.0.0.1:23890";
const DIR = path.resolve("data/twogw-a"), RUN = path.join(DIR, "run");
// gateway A's identity (its key, and the peer key it pinned) is kept across runs; everything else starts empty
fs.mkdirSync(DIR, { recursive: true });
for (const f of fs.readdirSync(DIR)) if (!["card-key.pem", "peer_pins.json", "peers.json", "clubb"].includes(f)) fs.rmSync(path.join(DIR, f), { recursive: true, force: true });
fs.mkdirSync(RUN, { recursive: true });
// B's roster, as A may know it (id, name, level, sports, prefers), and B's club as made from its seed: A's talks never
// read it, it is only here to grade what B's agents said against their calendars and rules
spawnSync(process.execPath, ["test/twogw/club_b.mjs", path.join(DIR, "clubb"), "10", "31"], { stdio: "ignore" });
const roster = JSON.parse(fs.readFileSync(path.join(DIR, "clubb/roster.json"), "utf8")), clubB = JSON.parse(fs.readFileSync(path.join(DIR, "clubb/club.json"), "utf8"));
const demo = JSON.parse(fs.readFileSync("../web/public/data/club.json", "utf8"));
fs.writeFileSync(path.join(DIR, "peers.json"), JSON.stringify({ self: "gwa", peers: [{ name: "gwb", origin: B, serve: demo.members.map((m) => m.id), members: roster }] }, null, 1));
Object.assign(process.env, { A2A_DATA: DIR, A2A_PEERS_FILE: path.join(DIR, "peers.json"), AGENT_TOKEN: crypto.randomBytes(24).toString("hex"), A2A_TRANSPORT: "",
  A2A_FILE: `${RUN}/a2a.json`, NEGOTIATIONS_FILE: `${RUN}/negotiations.json`, BOOKINGS_FILE: `${RUN}/bookings.json`, LEDGER_FILE: `${RUN}/ledger.jsonl`, TRACE_FILE: `${RUN}/traces.jsonl`,
  MATCH_RECORDS_FILE: `${RUN}/records.json`, MATCH_AUDIT_FILE: `${RUN}/audit.json`, MATCH_STATE_FILE: `${RUN}/match_state.json`, ASK_FILE: `${RUN}/asks.json`, STORE_FILE: `${RUN}/players.json`, MEMORY: "off", GUARD: "off",
  A2A_PEER_RETRY_MS: "5000", A2A_PEER_WATCH_MS: process.env.A2A_PEER_WATCH_MS || "5000" });

const a2aServer = await import("../src/a2a_server.js");
const { negotiate, releaseHolds } = await import("../src/a2a.js");
const play = await import("../src/play.js");
const client = await import("../src/a2a_client.js");
const peer = await import("../src/peer.js");
const { estimate } = await import("../src/match/ask.js");
const { EXT_PATH } = await import("../src/match/likely.js");
const { readClub } = await import("../src/club.js");
const { helpers } = await import("../src/play.js");

const out = { at: new Date().toISOString(), n: N, b: B, hardware: "gateway A: GPU server (Taipei), its members' model on a cloud A100 (11445); gateway B: serve-api-a100b, us-central1-b, its own A100", phases: {} };
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const mark = (m) => console.log(`MARK ${m}`);
const fails = [], expect = (ok, what) => { log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) fails.push(what); return ok; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1) : null; };
const timed = async (fn) => { const t = performance.now(); const r = await fn(); return [performance.now() - t, r]; };
const probeB = (ms = 3000) => fetch(`${B}/a2a/keys.json`, { signal: AbortSignal.timeout(ms) }).then((r) => r.ok, () => false);
const until = async (want, maxMs) => { const t0 = Date.now(); while (Date.now() - t0 < maxMs) { if ((await probeB()) === want) return (Date.now() - t0) / 1000; await wait(1000); } return null; };

// gateway A: the A2A server for its own members, on localhost (gateway B reaches it through the reverse forward)
const gw = await new Promise((ok) => { const s = http.createServer((req, res) => a2aServer.handle(req, res)).listen(A_PORT, "127.0.0.1", () => ok(s)); });
process.env.A2A_BASE = process.env.A2A_SELF = `http://127.0.0.1:${A_PORT}`;
const A = `http://127.0.0.1:${A_PORT}`, club = readClub(), venues = helpers.readVenues();
const me = { id: "you", name: "You", area: club.you.area, free: club.you.free };
const local = (id) => club.members.find((m) => m.id === id), far = (id) => peer.member(`${id}@gwb`);
log(`gateway A on ${A} (${club.members.length} demo members), gateway B at ${B} (${roster.length} simulated members, ${roster.length - 2} shared with A)`);
expect(await probeB(), "gateway B answers through the tunnel");

// ---- 1. trust and the hop ----------------------------------------------------------------------------------------
const day = (dow) => { const d = new Date(); do d.setDate(d.getDate() + 1); while (d.getDay() !== dow); return helpers.ymd(d); };
const times = [{ date: day(4), start: "19:00", venue: "riverside" }, { date: day(2), start: "19:00", venue: "midtown" }, { date: day(0), start: "09:00", venue: "riverside" }];
const lk = { kind: "serve.likely", from: "you", sport: "badminton", format: "singles", minutes: 90, times };
{
  const fresh = !peer.pinOf("gwb");
  const [t, first] = await timed(() => estimate(far("nb01"), lk));
  const pin = peer.pinOf("gwb");
  expect(!!pin && pin.kid.startsWith("serve-"), `B's key pinned ${fresh ? "on first use" : "(from an earlier run)"}: ${pin?.kid}`);
  expect(!!first.band, `B's member answers an estimate over the wire: ${first.band || JSON.stringify(first)} (${t.toFixed(0)} ms, the first one${fresh ? ", pinning both keys" : ""})`);
  const bands = {};
  for (const r of roster) bands[r.id] = (await estimate(far(r.id), lk)).band || "unknown";
  out.phases.bands = bands;
  expect(roster.filter((r) => !["nb09", "nb10"].includes(r.id)).every((r) => bands[r.id] !== "unknown") && bands.nb09 === "unknown" && bands.nb10 === "unknown",
    `bands from B's eight shared members (${Object.entries(bands).map(([k, v]) => `${k} ${v}`).join(", ")}); nb09 and nb10 are not shared with A`);
  // A2A-Extensions: the request names serve.likely as B's card declares it, and B says it back
  const url = `${B}/a2a/members/nb02/`, uri = client.declared(url, EXT_PATH)[0];
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: { messageId: crypto.randomUUID(), contextId: crypto.randomUUID(), role: "ROLE_USER", parts: [{ data: lk, mediaType: "application/json" }] } } });
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "A2A-Version": "1.0", "A2A-Extensions": uri, ...(await peer.sign(url, { method: "POST", body })) }, body });
  expect(r.status === 200 && r.headers.get("a2a-extensions") === uri, `A2A-Extensions: sent ${uri}, B activated ${r.headers.get("a2a-extensions")}`);
}
// the hop: the same small requests at A's own gateway (loopback) and at B (through the tunnel to us-central1)
const rpc = async (base, member, data, sign, contextId = `probe-${crypto.randomUUID().slice(0, 13)}`) => {
  const url = `${base}/a2a/members/${member}/`, body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: { messageId: crypto.randomUUID(), contextId, role: "ROLE_USER", parts: [{ data, mediaType: "application/json" }] } } });
  const h = { "content-type": "application/json", "A2A-Version": "1.0", ...(sign ? await peer.sign(url, { method: "POST", body }) : { authorization: `Bearer ${process.env.AGENT_TOKEN}` }) };
  const r = await fetch(url, { method: "POST", headers: h, body, signal: AbortSignal.timeout(60000) });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const decisionOf = (j) => j?.result?.task?.artifacts?.find((a) => a.name === "decision")?.parts?.map((p) => p.data).find(Boolean) || null;
// a proposal of one time, at one venue: the member's agent answers it by code (its calendar and rules, no model)
const oneTime = (date, start, venue, court = 1) => ({ kind: "serve.proposal", sport: "badminton", format: "singles", minutes: 90, proposal: { id: "t1", date, start, venue, court }, choices: [{ id: "t1", date, start, venue, court }], from: "you" });
{
  const lat = { keysGet: { a: [], b: [] }, proposalByCode: { a: [], b: [] }, estimate: { a: [], b: [] } };
  for (let i = 0; i < 15; i++) {
    lat.keysGet.a.push((await timed(() => fetch(`${A}/a2a/keys.json`).then((r) => r.json())))[0]);
    lat.keysGet.b.push((await timed(() => fetch(`${B}/a2a/keys.json`).then((r) => r.json())))[0]);
    // (a time the member is not free: declined by its rules, in code, on each side)
    lat.proposalByCode.a.push((await timed(() => rpc(A, "leo", oneTime(day(1), "07:00", "riverside"), false)))[0]);
    lat.proposalByCode.b.push((await timed(() => rpc(B, "nb01", oneTime(day(1), "07:00", "riverside"), true)))[0]);
    lat.estimate.a.push((await timed(() => estimate(local("hana"), lk)))[0]);
    lat.estimate.b.push((await timed(() => estimate(far("nb02"), lk)))[0]);
  }
  out.phases.latency = Object.fromEntries(Object.entries(lat).map(([k, v]) => [k, { aMedianMs: pct(v.a, 0.5), aP95Ms: pct(v.a, 0.95), bMedianMs: pct(v.b, 0.5), bP95Ms: pct(v.b, 0.95), addedMs: +(pct(v.b, 0.5) - pct(v.a, 0.5)).toFixed(1) }]));
  log("latency (ms, median / p95):", Object.entries(out.phases.latency).map(([k, v]) => `${k}: A ${v.aMedianMs}/${v.aP95Ms}, B ${v.bMedianMs}/${v.bP95Ms} (+${v.addedMs})`).join("; "));
  // what the player's mandate costs: signing it here, and checking it (as B's agent does), 500 times
  const own = peer.ownKey(), o = { talk: "neg-bench", date: day(4), start: "19:00", minutes: 90, court: 2, total: 400, venue: { id: "riverside" }, partners: [{ id: "nb01@gwb" }, { id: "leo" }] }, sTimes = [], cTimes = [];
  for (let i = 0; i < 500; i++) {
    const [ts, tok] = await timed(async () => peer.mandateFor(o)); sTimes.push(ts);
    cTimes.push((await timed(async () => peer.checkMandate(tok, { key: { ...own.jwk, kid: own.kid }, ref: "neg-bench", date: o.date, start: "19:00", minutes: 90, member: "nb01@gwb", seen: peer.createSeen(null) })))[0]);
  }
  out.phases.mandateCost = { signMedianMs: pct(sTimes, 0.5), checkMedianMs: pct(cTimes, 0.5) };
  log(`the player's mandate: signed in ${pct(sTimes, 0.5)} ms, checked in ${pct(cTimes, 0.5)} ms (median of 500)`);
}

// ---- 2. talks ----------------------------------------------------------------------------------------------------
// For grading and for choosing who talks, never for the talk itself: when each member is free, from its own calendar
// and rules (A's demo club, B's seed), and the games this run has booked or holds. A talk with a member on B is a
// private-calendar talk: your agent lists every hour a game fits in your own week, and each agent checks its own.
const profileOf = (id) => (peer.isRemote(id) ? clubB.members.find((x) => x.id === peer.remoteOf(id).id) : club.members.find((x) => x.id === id));
const fits = (m, date, s, minutes = 90) => {
  const dd = helpers.DAYS[helpers.dateOf(date).getDay()], r = m.rules || {}, from = r.notBefore && (["Sat", "Sun"].includes(dd) ? r.notBefore.weekend : r.notBefore.weekday);
  return helpers.windows(m.free).some((w) => helpers.DAYS[w.day] === dd && w.from <= s && s + minutes <= w.to) && !(r.noDays || []).includes(dd) && !(r.endBy && s + minutes > helpers.toMin(r.endBy)) && !(from && s < helpers.toMin(from));
};
const mine = (() => { const o = [], now = new Date(); for (let i = 0; i < 7; i++) { const d = new Date(now); d.setDate(d.getDate() + i); for (const w of helpers.windows(me.free).filter((x) => x.day === d.getDay())) for (let s = w.from; s + 90 <= w.to; s += 60) if (i > 0 || s >= now.getHours() * 60 + now.getMinutes() + 90) o.push({ date: helpers.ymd(d), s }); } return o; })();
const taken = []; // [{ id, date, from, k }]: this run's games and holds
const busy = (id, date, s) => taken.some((t) => t.id === id && t.date === date && t.from < s + 90 && s < t.from + 90);
const feasible = (ids) => mine.filter((x) => ids.every((id) => fits(profileOf(id), x.date, x.s) && !busy(id, x.date, x.s))).length;
const SPECS = [{ format: "singles", a: 0, b: 1 }, { format: "doubles", a: 2, b: 1 }, { format: "doubles", a: 1, b: 2 }, { format: "doubles", a: 0, b: 3 }];
const shared = roster.map((r) => r.id).filter((id) => !["nb09", "nb10"].includes(id)).map((id) => `${id}@gwb`), demoIds = club.members.map((m) => m.id);
let rot = 0;
const combos = (xs, n) => (n === 0 ? [[]] : xs.flatMap((x, i) => combos(xs.slice(i + 1), n - 1).map((c) => [x, ...c])));
// the next members for a spec, in turn, that have a time in common with you (with must among them)
const pick = (k, must = null) => {
  const s = SPECS[k % SPECS.length], as = combos(demoIds, s.a);
  const all = combos(shared.filter((id) => id !== must), s.b - (must ? 1 : 0)).flatMap((b) => as.map((a) => [...a, ...(must ? [must] : []), ...b]));
  for (let i = 0; i < all.length; i++) {
    const ids = all[(rot + i) % all.length];
    if (feasible(ids) > 0) { rot += 13; return { format: s.format, members: ids.map((id) => (peer.isRemote(id) ? far(peer.remoteOf(id).id) : local(id))) }; }
  }
  return null;
};
const talks = [], stats0 = peer.stats();
const runTalk = async (k, spec, extra = {}) => {
  const t0 = Date.now(), steps = [], ids = spec.members.map((m) => m.id), open = feasible(ids);
  const r = await negotiate({ me, members: spec.members, venues, format: spec.format, minutes: 90, tell: (x) => steps.push(x.step), ...extra });
  const t = { k, format: spec.format, members: ids, onB: spec.members.filter((m) => peer.isRemote(m)).length, feasible: open, agreed: !!r.agreed, reason: r.reason || null, errors: r.errors || null, rounds: r.rounds, seconds: +((Date.now() - t0) / 1000).toFixed(1), option: r.agreed || null, steps: steps.filter((s) => /hold|agreed/i.test(s)) };
  if (r.agreed) {
    // B's agents said yes only to times their own calendars and rules allow (graded against B's seed)
    t.withinB = spec.members.filter((m) => peer.isRemote(m)).every((m) => fits(profileOf(m.id), r.agreed.date, helpers.toMin(r.agreed.start)));
    ids.forEach((id) => taken.push({ id, date: r.agreed.date, from: helpers.toMin(r.agreed.start), k }));
  }
  return t;
};
const letGo = async (t) => { await releaseHolds(t.option); for (let i = taken.length - 1; i >= 0; i--) if (taken[i].k === t.k) taken.splice(i, 1); };
for (let k = 0; k < N; k += 2) {
  const s1 = pick(k), common = s1?.members.find((m) => peer.isRemote(m)), s2 = s1 && k + 1 < N ? pick(k + 1, common.id) || pick(k + 1) : null;
  if (!s1) { log(`talk ${k}: no members left with a time in common with you`); continue; }
  const both = s2?.members.some((m) => m.id === common.id);
  log(`talks ${k}${s2 ? ` and ${k + 1} at once` : ""}: [${s1.members.map((m) => m.id).join(", ")}]${s2 ? ` and [${s2.members.map((m) => m.id).join(", ")}]${both ? `, ${common.id} in both` : ""}` : ""}`);
  const pair = await Promise.all([runTalk(k, s1), ...(s2 ? [runTalk(k + 1, s2)] : [])]);
  // the player books two of every three agreed games and lets the third go
  for (const t of pair) {
    if (!t.agreed) { log(`  talk ${t.k}: no game (${t.reason}${t.errors?.some(Boolean) ? `; ${t.errors.filter(Boolean).join("; ")}` : ""}), ${t.seconds} s`); talks.push(t); continue; }
    t.action = t.k % 3 === 2 ? "drop" : "book";
    if (t.action === "book") { const b = await play.book({ option: t.option, invites: {}, you: {} }); t.booked = !b.error; t.bookError = b.error || null; if (b.error) await letGo(t); }
    else await letGo(t);
    log(`  talk ${t.k}: ${t.option.day} ${t.option.start} at ${t.option.venue.name} in round ${t.rounds}, ${t.seconds} s; ${t.action}${t.action === "book" ? (t.booked ? "ed on both gateways" : ` refused: ${t.bookError}`) : " (let go)"}`);
    talks.push(t);
  }
}
// and two doubles with no time in common, though each of the three has times with you: they must end without a game
{
  const none = [];
  for (const b of shared) for (const a of demoIds) for (const c of demoIds) if (none.length < 2 && a < c && !none.some((x) => x.includes(b)) && [a, b, c].every((id) => feasible([id]) > 0) && feasible([a, b, c]) === 0) none.push([a, b, c]);
  for (const [i, ids] of none.entries()) {
    const t = await runTalk(N + i, { format: "doubles", members: ids.map((id) => (peer.isRemote(id) ? far(peer.remoteOf(id).id) : local(id))) });
    talks.push(t); log(`  talk ${t.k} [${ids.join(", ")}], no time in common: ${t.agreed ? `AGREED ${t.option.day} ${t.option.start}` : `no game (${t.reason})`}, ${t.seconds} s`);
    if (t.agreed) await letGo(t);
  }
}
const agreed = talks.filter((t) => t.agreed);
const open = talks.filter((t) => t.feasible > 0), closed = talks.filter((t) => t.feasible === 0);
expect(closed.every((t) => !t.agreed), `the talks with no time in common end without a game (${closed.filter((t) => !t.agreed).length} of ${closed.length})`);
log(`agreed in ${open.filter((t) => t.agreed).length} of ${open.length} talks that had a time in common by the calendars (courts and longest-trip rules not counted)`);
// two talks at once never put one member in two games: no two games booked, and no two talks held at the same time
// (the pairs), overlap for the same member
const clash = (x, y) => x.option.date === y.option.date && x.members.some((m) => y.members.includes(m)) && Math.abs(helpers.toMin(x.option.start) - helpers.toMin(y.option.start)) < 90;
const together = (x, y) => (x.booked && y.booked) || Math.floor(x.k / 2) === Math.floor(y.k / 2);
const overlap = agreed.some((x, i) => agreed.some((y, j) => j > i && together(x, y) && clash(x, y)));
expect(!overlap, `no member is in two games at once across ${agreed.length} agreed talks (pairs run at the same time, a member of B in common)`);
expect(agreed.every((t) => t.withinB), "every time B's agents agreed to is in their own calendars and rules (graded against B's seed)");
// probes from A: what B's agents say now about each agreed time
const probes = [];
for (const t of agreed) for (const id of t.members.filter((x) => x.endsWith("@gwb"))) {
  const r = await rpc(B, peer.remoteOf(id).id, oneTime(t.option.date, t.option.start, t.option.venue.id, t.option.court), true), d = decisionOf(r.json);
  probes.push({ k: t.k, member: id, action: t.action, booked: !!t.booked, now: d?.intent || r.status });
}
const bookedP = probes.filter((p) => p.action === "book" && p.booked), droppedP = probes.filter((p) => p.action === "drop");
expect(bookedP.every((p) => p.now === "decline"), `a time booked here is the member's game on B: ${bookedP.filter((p) => p.now === "decline").length} of ${bookedP.length} probes refused there`);
// (a time let go is free again on B, unless a later talk booked that member then)
const talkOf = (k) => talks.find((t) => t.k === k);
const takenLater = (p) => bookedP.some((q) => q.member === p.member && q.k > p.k && clash(talkOf(q.k), talkOf(p.k)));
expect(droppedP.filter((p) => !takenLater(p)).every((p) => p.now === "accept"), `a time let go is free again on B: ${droppedP.filter((p) => p.now === "accept").length} of ${droppedP.length} probes said yes`);
// A's own side: no hold left for any talk (booked ones gave way to the booking, the others were let go)
const strayA = club.members.flatMap((m) => play.held(m.id)).filter((l) => !l.booked);
expect(strayA.length === 0, `no hold left on gateway A after the talks (${strayA.length})`);
// A booking checks again on B: a talk whose time was let go, and held since on B's member by another talk (which A's own
// records can't see: B's holds are on B), is refused by B's agent when it is booked after all, and nothing is booked on
// either side; once the other talk lets the time go, the same booking goes through.
{
  // (up to three doubles, until one agrees)
  let s = null, t1 = { agreed: false, reason: "no members with a time in common" };
  for (let i = 0; i < 3 && !t1.agreed; i++) { s = pick(1); if (s) t1 = await runTalk(100 + 2 * i, s); }
  const bm = s?.members.find((m) => peer.isRemote(m)), locals = (s?.members || []).filter((m) => !peer.isRemote(m)).map((m) => m.id);
  let recheck = { agreed: t1.agreed, members: t1.members };
  if (t1.agreed) {
    await letGo(t1); // the player let it go
    // another talk takes that very time on B's member meanwhile: it proposes it (B's agent says it works, by code) and
    // holds it, over the wire, in a talk of its own
    const X = `neg-${crypto.randomUUID().slice(0, 13)}`, who = peer.remoteOf(bm.id).id, o = t1.option;
    const said = decisionOf((await rpc(B, who, oneTime(o.date, o.start, o.venue.id, o.court), true, X)).json)?.intent;
    const heldX = (await rpc(B, who, { kind: "serve.hold", action: "hold", ref: X, date: o.date, start: o.start, minutes: 90 }, true, X)).json?.result?.task?.artifacts?.find((a) => a.name === "hold")?.parts?.map((p) => p.data).find(Boolean);
    const b1 = await play.book({ option: o, invites: {}, you: {} }); // and now the first game after all
    const left = locals.flatMap((id) => play.playing(id, o.date).filter((g) => g.ref === o.hold || g.ref === o.talk));
    const none = !play.bookings().some((b) => b.option?.talk === o.talk);
    // the other talk lets it go, and the first game books
    await rpc(B, who, { kind: "serve.hold", action: "release", ref: X, date: o.date, start: o.start, minutes: 90 }, true, X);
    const b2 = await play.book({ option: o, invites: {}, you: {} });
    recheck = { first: `${o.day} ${o.start}`, member: bm.id, otherTalk: { said, held: !!heldX?.held }, firstBooking: b1.error || "booked", leftOnA: left.length, afterRelease: b2.error || "booked" };
    expect(said === "accept" && heldX?.held && !!b1.error && /could not confirm/.test(b1.error), `a booking whose time another talk now holds on B is refused by B's agent when the booking checks again (${b1.error})`);
    expect(left.length === 0 && none, "and nothing of it is left on A (no booking, no hold)");
    expect(!b2.error, `once the other talk lets the time go, the same booking goes through on both gateways (${b2.error || "booked"})`);
    if (!b2.error) taken.push(...t1.members.map((id) => ({ id, date: o.date, from: helpers.toMin(o.start), k: t1.k })));
  }
  out.phases.recheck = recheck;
}
const s1 = peer.stats(), diff = Object.fromEntries(Object.keys(s1).filter((k) => /^(hold|release|book)\./.test(k)).map((k) => [k, (s1[k] || 0) - (stats0[k] || 0)]));
out.phases.talks = { n: talks.length, agreed: agreed.length, booked: talks.filter((t) => t.booked).length, dropped: talks.filter((t) => t.action === "drop").length, medianSeconds: pct(talks.map((t) => t.seconds), 0.5),
  byOnB: Object.fromEntries([1, 2, 3].map((n) => [n, `${talks.filter((t) => t.onB === n && t.agreed).length}/${talks.filter((t) => t.onB === n).length}`])), overWire: diff, probes, talks: talks.map(({ option, ...t }) => ({ ...t, when: option ? `${option.day} ${option.start}` : null })) };
log(`talks: ${agreed.length} of ${talks.length} agreed (by members on B: ${JSON.stringify(out.phases.talks.byOnB)}), ${out.phases.talks.booked} booked, ${out.phases.talks.dropped} let go; median ${out.phases.talks.medianSeconds} s; over the wire: ${JSON.stringify(diff)}`);

// ---- 3. forged requests to B --------------------------------------------------------------------------------------
{
  const Bkid = peer.pinOf("gwb").kid, own = peer.ownKey(), C = crypto.generateKeyPairSync("ed25519"), Ckid = peer.kidOf(C.publicKey.export({ format: "jwk" }).x);
  const msg = (data = lk) => JSON.stringify({ jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: { messageId: crypto.randomUUID(), contextId: crypto.randomUUID(), role: "ROLE_USER", parts: [{ data, mediaType: "application/json" }] } } });
  const post = (member, body, h) => fetch(`${B}/a2a/members/${member}/`, { method: "POST", headers: { "content-type": "application/json", "A2A-Version": "1.0", ...h }, body }).then((r) => r.status);
  const tok = (o) => ({ [peer.HEADER]: peer.signToken({ key: own.key, kid: own.kid, aud: Bkid, method: "POST", path: "/a2a/members/nb01/", ...o }) });
  const cases = [];
  const run = async (id, what, fn, want) => { const got = await fn(); cases.push({ id, what, status: got, refused: got === want }); log(`  ${got === want ? "refused" : "NOT REFUSED"} ${id} ${what}: HTTP ${got}`); };
  { const b = msg(); await run("F1", "no signature and no token", () => post("nb01", b, {}), 401); }
  { const b = msg(); await run("F2", "signed by a key B has not pinned (an unknown gateway)", () => post("nb01", b, { [peer.HEADER]: peer.signToken({ key: C.privateKey, kid: Ckid, aud: Bkid, method: "POST", path: "/a2a/members/nb01/", body: b }) }), 401); }
  { const b = msg(), h = tok({ body: b }); const firstStatus = await post("nb01", b, h); await run("F3", `a replayed request (the first copy: HTTP ${firstStatus})`, () => post("nb01", b, h), 401); }
  { const b = msg(), h = tok({ body: b }); await run("F4", "a body changed after signing", () => post("nb01", b.replace('"singles"', '"doubles"'), h), 401); }
  { const b = msg(), h = tok({ body: b }); await run("F5", "a request signed for nb01, sent to nb02", () => post("nb02", b, h), 401); }
  { const b = msg(); await run("F6", "a request made five minutes ago", () => post("nb01", b, tok({ body: b, now: Date.now() - 300000 })), 401); }
  { const b = msg(); await run("F7", "a request signed for another gateway (aud)", () => post("nb01", b, { [peer.HEADER]: peer.signToken({ key: own.key, kid: own.kid, aud: Ckid, method: "POST", path: "/a2a/members/nb01/", body: b }) }), 401); }
  { const b = msg(); await run("F8", "a third gateway signing with its own key under A's key id", () => post("nb01", b, { [peer.HEADER]: peer.signToken({ key: C.privateKey, kid: own.kid, aud: Bkid, method: "POST", path: "/a2a/members/nb01/", body: b }) }), 401); }
  { const b = msg(); await run("F9", "a valid signature for a member B does not share with A (nb09)", () => post("nb09", b, { [peer.HEADER]: peer.signToken({ key: own.key, kid: own.kid, aud: Bkid, method: "POST", path: "/a2a/members/nb09/", body: b }) }), 403); }
  // and B's own API, which the tunnel also reaches, needs B's token, which A does not have
  { await run("F10", "gateway B's own API through the tunnel, without B's token", () => fetch(`${B}/api/players`).then((r) => r.status), 401); }
  // a booking on B needs the player's signed mandate: none, an expired one, and a valid one replayed after the game
  // was let go (a talk of its own, at a time a member of B said works)
  {
    let X = null, who = null, at = null;
    for (const id of shared) {
      const x = mine.find((y) => fits(profileOf(id), y.date, y.s) && !busy(id, y.date, y.s)); if (!x) continue;
      const ctx = `neg-${crypto.randomUUID().slice(0, 13)}`, start = helpers.hm(x.s);
      if (decisionOf((await rpc(B, peer.remoteOf(id).id, oneTime(x.date, start, "riverside", 1), true, ctx)).json)?.intent === "accept") { X = ctx; who = id; at = { date: x.date, start, minutes: 90 }; break; }
    }
    if (X) {
      const heldOf = (j) => j?.result?.task?.artifacts?.find((a) => a.name === "hold")?.parts?.map((p) => p.data).find(Boolean) || {};
      const book = async (mandate) => heldOf((await rpc(B, peer.remoteOf(who).id, { kind: "serve.hold", action: "book", ref: X, ...at, ...(mandate ? { mandate } : {}) }, true, X)).json);
      const mandate = (o = {}) => peer.signMandateToken({ key: own.key, kid: own.kid, who: "you", talk: X, court: 1, members: [who], cap: 400, game: { sport: "badminton", format: "singles", venue: "riverside", ...at }, ...o });
      const runH = async (id, what, fn) => { const h = await fn(); cases.push({ id, what, status: h.held ? "booked" : h.reason, refused: !h.held }); log(`  ${!h.held ? "refused" : "NOT REFUSED"} ${id} ${what}: ${h.reason || "booked"}`); };
      await runH("F11", "a booking with no mandate from the player", () => book(null));
      await runH("F12", "a booking with a mandate made 20 minutes ago (5 to live)", () => book(mandate({ now: Date.now() - 20 * 60000 })));
      const good = mandate(), first = await book(good);
      await rpc(B, peer.remoteOf(who).id, { kind: "serve.hold", action: "release", ref: X, ...at }, true, X);
      log(`  (the valid mandate booked: ${first.booked ? "yes" : first.reason}; then the game was let go)`);
      await runH("F13", "the same valid mandate replayed to book the game again", () => book(good));
      if (!first.booked) cases.push({ id: "F13b", what: "a valid mandate books", status: first.reason, refused: false });
    } else log("  no member of B had a free time left for the mandate cases");
  }
  out.phases.forged = cases;
  expect(cases.every((c) => c.refused), `${cases.filter((c) => c.refused).length} of ${cases.length} forged requests refused by B (each logged in B's peer_log.jsonl)`);
}

// ---- 4. B stopped mid-run -----------------------------------------------------------------------------------------
const down = {};
if (process.env.TWOGW_SKIP_DOWN === "1") log("phase 4 skipped (TWOGW_SKIP_DOWN=1)");
else {
  // (a) frozen while a request is in flight: the request is given up on missed probes, not at the A2A timeout
  mark("FREEZE_B");
  const frozeIn = await until(false, 120000);
  if (frozeIn == null) { log("  B was not frozen (no driver): skipping the frozen-peer case"); down.frozen = "skipped"; }
  else {
    const [t, r] = await timed(() => client.send(`${B}/a2a/members/nb03`, { messageId: crypto.randomUUID(), contextId: crypto.randomUUID(), role: "ROLE_USER", parts: [{ data: lk, mediaType: "application/json" }] }).then(() => "answered", (e) => String(e.message || e).slice(0, 80)));
    down.frozen = { givenUpAfterS: +(t / 1000).toFixed(1), error: r, a2aTimeoutS: +(process.env.A2A_TIMEOUT_MS || 270000) / 1000 };
    expect(r !== "answered" && t < 60000, `a request in flight to a frozen B is given up after ${(t / 1000).toFixed(1)} s (missed probes), not at the ${down.frozen.a2aTimeoutS} s A2A timeout`);
  }
  mark("THAW_B");
  down.thawedAfterS = await until(true, 120000);
  // (b) talks agreed and held on both sides just before B goes down, and (c) talks still running when it stops
  const spec = (k) => [k, 0, 1, 2, 3].map((j) => pick(j)).find(Boolean) || { format: "singles", members: [far("nb01")] };
  const held = await runTalk(200, spec(2));
  log(`  held before the stop: [${held.members.join(", ")}] ${held.agreed ? `${held.option.day} ${held.option.start}` : `no game (${held.reason}${held.errors?.some(Boolean) ? `; ${held.errors.filter(Boolean).join("; ")}` : ""})`}`);
  const inflight = [runTalk(201, spec(0)), runTalk(202, spec(1))];
  mark("STOP_B");
  const stoppedIn = await until(false, 120000);
  const cut = await Promise.all(inflight);
  down.inflight = cut.map((t) => ({ k: t.k, members: t.members, agreed: t.agreed, reason: t.reason, errors: t.errors, seconds: t.seconds }));
  log(`  running when B stopped: ${cut.map((t) => `talk ${t.k} ${t.agreed ? `agreed ${t.option.day} ${t.option.start}` : `no game (${t.reason})`} in ${t.seconds} s`).join("; ")}`);
  const awaiting = [held, ...cut].filter((t) => t.agreed); // agreed, held, the player not asked yet
  if (stoppedIn == null) { log("  B was not stopped (no driver): skipping the stopped-gateway cases"); down.stopped = "skipped"; }
  else {
    const after = [];
    for (const [k, s] of [[203, { format: "singles", members: [far("nb01")] }], [204, { format: "doubles", members: [local("sam"), local("yuki"), far("nb03")] }], [205, { format: "doubles", members: [far("nb02"), far("nb04"), far("nb06")] }]]) after.push(await runTalk(k, s));
    down.whileDown = after.map((t) => ({ k: t.k, reason: t.reason, seconds: t.seconds }));
    expect(after.every((t) => !t.agreed && /not reachable now/.test(t.reason || "")), `with B stopped, talks with its members end "not reachable now": ${after.map((t) => `${t.seconds} s`).join(", ")}`);
    expect(after.every((t) => t.seconds < 10), "and at once (under 10 s each, no other agent asked), with no hang");
    const control = await runTalk(206, { format: "singles", members: [local("tomas")] });
    down.control = { agreed: control.agreed, seconds: control.seconds, reason: control.reason };
    expect(control.agreed || /can't play|no time/.test(control.reason || ""), `A's own talks go on meanwhile (${control.agreed ? `agreed in ${control.seconds} s` : control.reason})`);
    if (control.agreed) await letGo(control);
    // (the talks agreed before the stop still hold their times on A, as they should until the player answers)
    const strayNow = club.members.flatMap((m) => play.held(m.id)).filter((l) => !l.booked && !awaiting.some((t) => t.option.hold === l.ref));
    expect(strayNow.length === 0, `no hold left on A by the talks that could not reach B (${strayNow.length})`);
    // the player lets those games go while B is down: B can't hear it, so each release waits in the outbox
    for (const t of awaiting) await letGo(t);
    const want = awaiting.reduce((n, t) => n + t.members.filter((id) => peer.isRemote(id)).length, 0), queued = peer.outbox.items().filter((x) => awaiting.some((t) => t.option.hold === x.ref));
    down.queued = { want, queued: queued.length };
    if (awaiting.length) expect(queued.length === want, `the releases B could not hear are kept to send again (${queued.length} of ${want} in the outbox)`);
  }
  mark("START_B");
  const backIn = await until(true, 180000);
  down.backAfterS = backIn;
  // once B is back, the outbox (sent again every A2A_PEER_RETRY_MS, 5 s here) delivers what B could not hear; then B's
  // members are free again at every one of those times (each was a time they had said works)
  const pending = peer.outbox.items();
  if (backIn != null && stoppedIn != null && pending.length) {
    const t0 = Date.now();
    while (peer.outbox.items().length && Date.now() - t0 < 60000) { await peer.outbox.flush(); if (peer.outbox.items().length) await wait(2000); }
    const left = peer.outbox.items().length, p = [];
    for (const x of pending) { const t = [...awaiting, ...cut].find((y) => y.option?.hold === x.ref) || null; p.push(`${x.member} ${decisionOf((await rpc(B, peer.remoteOf(x.member).id, oneTime(x.date, x.start, t?.option?.venue.id || "riverside", t?.option?.court || 1), true)).json)?.intent || "none"}`); }
    down.afterRestart = { pending: pending.length, deliveredInS: +((Date.now() - t0) / 1000).toFixed(1), outboxLeft: left, probes: p };
    expect(left === 0 && p.every((x) => / accept$/.test(x)), `once B is back the ${pending.length} release(s) it could not hear are delivered in ${down.afterRestart.deliveredInS} s, and B's members are free at those times again (no stray hold): ${p.join(", ")}`);
  }
  out.phases.down = down;
}

out.stats = peer.stats();
out.fails = fails;
fs.writeFileSync(path.join(DIR, "result.json"), JSON.stringify(out, null, 1));
log(fails.length ? `${fails.length} FAILED:\n  ${fails.join("\n  ")}` : "ALL PASSED");
console.log("DONE");
gw.close();
process.exit(fails.length ? 1 : 0);

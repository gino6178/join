// The measures of one run, with Serve against the baseline, and their intervals (a bootstrap over the twenty users,
// paired: each resample takes the same users in both worlds). Pure, apart from reading the run's own data folder
// for what the gateway kept (the loop's clusters, the members' records). report.mjs puts runs side by side.
import fs from "node:fs";
import path from "node:path";
import { stream } from "./rng.mjs";

const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => (xs.length ? sum(xs) / xs.length : null);
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
// a percentile bootstrap interval of stat(sample) over resampled units; paired when stat reads both worlds of a unit
export function bootstrap(units, stat, { n = 2000, seed = 1, level = 0.95 } = {}) {
  if (!units.length) return null;
  const r = stream(seed, "bootstrap"), vals = [];
  for (let k = 0; k < n; k++) { const s = Array.from({ length: units.length }, () => units[Math.floor(r() * units.length)]); const v = stat(s); if (v != null && Number.isFinite(v)) vals.push(v); }
  vals.sort((a, b) => a - b);
  const lo = vals[Math.floor(((1 - level) / 2) * vals.length)], hi = vals[Math.min(vals.length - 1, Math.floor((1 - (1 - level) / 2) * vals.length))];
  return [r2(lo), r2(hi)];
}
// a Wilson interval for a proportion
export function wilson(k, n, z = 1.96) {
  if (!n) return null;
  const p = k / n, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [r2(c - h), r2(c + h)];
}

// what users sent: the messages and taps that reach the gateway (the feed's API calls are counted apart)
const USER = new Set(["hello", "message", "request", "question", "niggle", "trash-talk", "idea", "ideas", "bail", "checkin-reply", "log", "tap", "answer-ask", "answer-plan", "answer-confirm", "share-answer", "vote", "body-answer", "weather-answer", "thumb", "choice:improve", "choice:bands", "choice:beta"]);
const REFUSAL = /^I can't help with that\. I'm here for your games|^I'm sorry you're going through this/;

export function measure({ run, seed, arm = "natural", dates, personas, serve, base, dataDir }) {
  const ids = personas.map((p) => p.id), D = new Set(dates);
  // ---- games ----
  const sg = serve.games.filter((g) => D.has(g.date)), splayed = sg.filter((g) => g.played), after = serve.games.filter((g) => !D.has(g.date));
  const bg = base.games.filter((g) => D.has(g.date)), bplayed = bg.filter((g) => g.played);
  const playedBy = (gs, id) => gs.filter((g) => g.played && (g.by === id || g.with.includes(id))).length;
  const per = Object.fromEntries(ids.map((id) => [id, { serve: playedBy(sg, id), base: playedBy(bg, id) }]));
  const units = ids.map((id) => per[id]);
  const actionsOf = (id) => (serve.st[id]?.actions || []).filter((a) => USER.has(a.what) || a.what.startsWith("choice:"));
  const sActs = Object.fromEntries(ids.map((id) => [id, actionsOf(id).length])), bActs = Object.fromEntries(ids.map((id) => [id, base.perUser[id]?.actions || 0]));
  // the messages and taps that were about getting a game (not the loop, the feed, questions or the body log)
  const GAME = new Set(["request", "answer-ask", "answer-plan", "answer-confirm", "bail", "tap"]);
  const sGameActs = sum(ids.map((id) => actionsOf(id).filter((a) => GAME.has(a.what)).length));
  // ---- want -> booked ----
  const waits = [];
  for (const g of sg) {
    const s = serve.st[g.by], eps = (s?.episodes || []).filter((e) => e.at <= g.created).sort((a, b) => b.at - a.at);
    const asked = (s?.decisions || []).filter((d) => d.at <= g.created && d.tapped).sort((a, b) => b.at - a.at)[0];
    const onset = eps[0]?.at ?? null;
    if (onset != null) waits.push({ game: g.key, by: g.by, minutes: Math.round((g.created - onset) / 6e4), from: "their request" });
    else if (asked) waits.push({ game: g.key, by: g.by, minutes: null, from: "an ask they said yes to" });
  }
  const bwaits = bg.map((g) => g.waitMin).filter((x) => x != null);
  // ---- activation and retention ----
  const days = dates.map((date, i) => {
    const active = ids.filter((id) => actionsOf(id).some((a) => dayOf(a.at) === date));
    const activated = ids.filter((id) => serve.st[id]?.activated && serve.st[id].activated <= date);
    const bActive = ids.filter((id) => base.log.some((l) => l.who === id && dayOf(new Date(l.at).getTime()) === date));
    return { day: i + 1, date, newUsers: ids.filter((id) => serve.st[id]?.activated === date).length, activated: activated.length, active: active.length, activeOfActivated: activated.length ? r2(active.filter((x) => activated.includes(x)).length / activated.length) : null, baselineActive: bActive.length };
  });
  // ---- asks, answers, turnout ----
  const msgs = Object.entries(serve.inbox || {}).flatMap(([to, ms]) => ms.map((m) => ({ ...m, to })));
  const isAsk = (m) => m.payloads?.some((p) => /^gm:[\w-]+:yes$/.test(p)), isOffer = (m) => m.payloads?.some((p) => /^gm:[\w-]+:book$/.test(p)), isPlan = (m) => m.payloads?.some((p) => /^ap:/.test(p));
  const decided = ids.flatMap((id) => serve.st[id]?.decisions || []);
  const taps = (rx) => decided.filter((d) => rx.test(d.tapped || "")).length;
  const answered = new Set(ids.flatMap((id) => actionsOf(id).filter((a) => a.on).map((a) => a.on)));
  const turnout = (gs) => { const t = gs.flatMap((g) => g.turnout || []), why = {}; for (const x of t.filter((x) => !x.shows)) why[x.why] = (why[x.why] || 0) + 1; return { places: t.length, missing: t.filter((x) => !x.shows).length, why }; };
  // ---- bands: calibration on these users ----
  const records = read(path.join(dataDir, "match_records.json"), { members: {} }).members || {};
  const est = Object.values(serve.audit || {}).flat().filter((a) => a.band && !a.cached);
  const byBand = {};
  for (const e of est) {
    const rows = (records[e.member]?.asked || []).filter((r) => r.t >= e.at && r.t <= e.at + 30 * 6e4 && r.src === "talk");
    const played = sg.some((g) => (g.with.includes(e.member) || g.by === e.member) && g.created >= e.at && g.created <= e.at + 60 * 6e4 && g.played);
    const b = (byBand[e.band] ||= { estimates: 0, talked: 0, agentYes: 0, played: 0 });
    b.estimates++; if (rows.length) { b.talked++; if (rows.some((r) => r.yes)) b.agentYes++; } if (played) b.played++;
  }
  for (const b of Object.values(byBand)) { b.agentYesRate = b.talked ? r2(b.agentYes / b.talked) : null; b.agentYesCI = wilson(b.agentYes, b.talked); b.playedRate = r2(b.played / b.estimates); }
  const refusedEst = Object.values(serve.audit || {}).flat().filter((a) => a.refused).length;
  // ---- the community loop ----
  const loopState = read(path.join(dataDir, "loop/ideas.json"), {}), signals = read(path.join(dataDir, "loop/signals.json"), {});
  const clusters = (loopState.clusters || []).map((c) => ({ id: c.id, text: c.text, members: c.members, groups: c.groups, shown: c.shown, eligible: c.eligible, exists: !!c.exists, why: c.why || [], proposal: c.proposal || null })).sort((a, b) => b.members - a.members);
  const specs = serve.proposals?.proposals || [];
  const uacts = ids.flatMap((id) => actionsOf(id).map((a) => ({ ...a, who: id })));
  const agentSaid = (rx) => msgs.filter((m) => rx.test(m.text)).length;
  const loop = {
    improveOn: uacts.filter((a) => a.what === "choice:improve").length, betaOn: uacts.filter((a) => a.what === "choice:beta").length, bandsOn: uacts.filter((a) => a.what === "choice:bands").length,
    ideasSent: uacts.filter((a) => a.what === "idea").length, offers: agentSaid(/Share with the club as “/), shareTaps: uacts.filter((a) => a.what === "share-answer" && a.button === "Share").length, dontTaps: uacts.filter((a) => a.what === "share-answer" && a.button === "Don't").length,
    shared: agentSaid(/^Shared with the club as/), held: agentSaid(/safety check is not answering/), notShared: agentSaid(/^Not shared:/), notSharedWhy: msgs.filter((m) => /^Not shared:/.test(m.text)).map((m) => m.text.slice(0, 120)),
    sharedTexts: msgs.filter((m) => /^Shared with the club as/.test(m.text)).map((m) => (m.text.match(/“([^”]*)”/) || [])[1]).filter(Boolean), cantPhrase: agentSaid(/couldn't put that into a short sentence/), unmetOffers: agentSaid(/^I couldn't really help with that\. Share/),
    items: (signals.items || []).length, voteTaps: uacts.filter((a) => a.what === "vote").length, voted: agentSaid(/^Voted:/),
    clusters: clusters.slice(0, 6), ideasShown: (serve.ideas?.ideas || []).length,
    proposals: specs.map((s) => ({ id: s.id, title: s.title, status: s.status, class: s.review?.class || s.change?.class || null, change: s.change ? { key: s.change.key, value: s.change.value } : null, reasons: s.reasons || [], gates: s.gates?.results?.map((x) => ({ gate: x.gate, ok: x.ok })) || null, shipped: s.shipped || null })),
    flags: serve.flags?.flags || {}, stubs: serve.proposals?.stubs || [],
  };
  loop.outcome = loop.proposals.some((p) => p.status === "shipped") ? "a change shipped to the beta canary"
    : loop.proposals.length ? `a proposal formed (${loop.proposals.map((p) => `${p.id} ${p.status}`).join(", ")}) but nothing shipped`
    : clusters.length ? `no proposal: the largest idea had ${clusters[0].members} member${clusters[0].members === 1 ? "" : "s"} (5 are needed, from weekday and weekend players)${clusters[0].why?.length ? `; ${clusters[0].why.join("; ")}` : ""}`
    : loop.items ? "no proposal: the shared items did not cluster" : "no proposal: nothing was shared";
  // ---- the feed ----
  const fposts = serve.feed?.posts || [];
  const feed = serve.feed ? { on: true, posts: fposts.length, byPeople: fposts.filter((x) => x.by?.type === "person").length, byAgents: fposts.filter((x) => x.by?.type === "agent").length,
    postTries: uacts.filter((a) => a.what === "feed-post").length, posted: uacts.filter((a) => a.what === "feed-post" && a.ok).length, postsRefused: uacts.filter((a) => a.what === "feed-post" && a.refused).map((a) => a.refused), postsHeld: uacts.filter((a) => a.what === "feed-post" && a.held).length,
    likes: uacts.filter((a) => a.what === "feed-like" && a.ok).length, likesOnPapers: uacts.filter((a) => a.what === "feed-like" && a.ok && a.kind === "paper").length, comments: uacts.filter((a) => a.what === "feed-comment" && a.ok).length, commentsRefused: uacts.filter((a) => a.what === "feed-comment" && a.refused).map((a) => a.refused), opens: uacts.filter((a) => a.what === "feed-open").length,
    note: "Feed refusals are false positives too: every post and comment the users wrote was benign." }
    : { on: false, why: "the Club feed (agent/src/feed) is not on this branch yet; the simulation skips it" };
  // ---- guard ----
  const refusals = msgs.filter((m) => REFUSAL.test(m.text));
  const guard = { refusals: refusals.length, helpline: refusals.filter((m) => /helpline/.test(m.text)).length, refusedKinds: Object.fromEntries(Object.entries(refusals.reduce((o, m) => { const prev = uacts.filter((a) => a.who === m.to && a.at <= m.at).at(-1)?.what || "?"; o[prev] = (o[prev] || 0) + 1; return o; }, {}))),
    note: "Every simulated user's message is benign by construction (trash talk included), so every refusal here is a false positive.", unsafeVerdicts: serve.flight?.guardUnsafe ?? null, guardCalls: serve.flight?.guardCalls ?? null, fallbacks: agentSaid(/^I can't answer that one here/) };
  // ---- who never got a game, and why ----
  const never = ids.filter((id) => per[id].serve === 0).map((id) => {
    const s = serve.st[id] || {}, acts = actionsOf(id), mineG = sg.filter((g) => g.by === id || g.with.includes(id)), ms = serve.inbox?.[id] || [];
    const noDeal = ms.filter((m) => /No deal|No other opening|No game to suggest|wasn't booked|couldn't look/.test(m.text)).map((m) => m.text.split("\n").find((l) => /No deal|No other|No game|wasn't|couldn't/.test(l))?.slice(0, 160));
    const why = !s.activated ? "never opened the chat" : mineG.length ? `booked ${mineG.length}, but ${mineG.map((g) => (g.turnout || []).filter((x) => !x.shows).map((x) => `${x.id === id ? "they" : x.id} ${x.why}`).join(", ") || "not played").join("; ")}`
      : !acts.some((a) => a.what === "request") && !s.decisions?.length ? "opened the chat but never asked for a game (and nothing was offered)"
      : s.decisions?.some((d) => d.tapped && /Not this week|Drop it/.test(d.tapped)) ? "turned the offers down" : noDeal.length ? `asked, no game came of it (${noDeal.at(-1)})` : "asked, nothing came back they took up";
    return { id, name: personas.find((p) => p.id === id).name, laziness: personas.find((p) => p.id === id).inertia.laziness, why, baselineGames: per[id].base };
  });
  const T = (gs) => gs.length;
  const headline = {
    run, seed, arm, days: dates.length, users: ids.length,
    gamesPlayed: { serve: T(splayed), baseline: T(bplayed) },
    playerGames: { serve: sum(units.map((x) => x.serve)), baseline: sum(units.map((x) => x.base)), perUserServe: r2(mean(units.map((x) => x.serve))), perUserBaseline: r2(mean(units.map((x) => x.base))),
      perUserDiff: r2(mean(units.map((x) => x.serve - x.base))), perUserDiffCI: bootstrap(units, (s) => mean(s.map((x) => x.serve - x.base)), { seed }), perUserServeCI: bootstrap(units, (s) => mean(s.map((x) => x.serve)), { seed }), perUserBaselineCI: bootstrap(units, (s) => mean(s.map((x) => x.base)), { seed }) },
    usersWithAGame: { serve: units.filter((x) => x.serve > 0).length, baseline: units.filter((x) => x.base > 0).length, serveCI: wilson(units.filter((x) => x.serve > 0).length, units.length), baselineCI: wilson(units.filter((x) => x.base > 0).length, units.length) },
    booked: { serve: T(sg), baseline: T(bg), serveAfterTrial: after.length },
    actionsPerGame: { serve: T(splayed) ? r2(sum(Object.values(sActs)) / T(splayed)) : null, serveGameOnly: T(splayed) ? r2(sGameActs / T(splayed)) : null, baseline: T(bplayed) ? r2(sum(Object.values(bActs)) / T(bplayed)) : null, serveTotal: sum(Object.values(sActs)), serveGameTotal: sGameActs, baselineTotal: sum(Object.values(bActs)) },
    wantToBookedMin: { serveMedian: median(waits.filter((w) => w.minutes != null).map((w) => w.minutes)), baselineMedian: median(bwaits), serveN: waits.filter((w) => w.minutes != null).length, baselineN: bwaits.length },
  };
  return {
    simulated: true, note: "Simulated users (agent/test/sim_users/personas.json): none is a real person. The gateway, its agents, the guards and the loop ran for real; the people were a model.",
    headline, perUser: per, days,
    asks: { matchHelperAsks: msgs.filter(isAsk).length, offersAfterARequest: msgs.filter(isOffer).length, autopilotPlans: msgs.filter(isPlan).length, unanswered: msgs.filter((m) => (isAsk(m) || isOffer(m) || isPlan(m)) && !answered.has(m.id)).length,
      yes: taps(/^(Yes, set it up|Book it|Book both|Only the first)$/), another: taps(/^Another time$/), notThisWeek: taps(/^Not this week$/), drop: taps(/^Drop it$/), ignored: decided.filter((d) => !d.tapped).length,
      noDeal: msgs.filter((m) => /No deal:/.test(m.text)).length, noGame: msgs.filter((m) => /^No game to suggest right now/.test(m.text)).length, partnerNotices: msgs.filter((m) => /^Your agent said yes for you:/.test(m.text)).length, partnerAsked: msgs.filter((m) => m.payloads?.some((p) => /^pc:/.test(p))).length, partnerIn: uacts.filter((a) => a.what === "answer-confirm" && a.button === "I'm in").length, partnerOut: uacts.filter((a) => a.what === "answer-confirm" && a.button === "Can't make it").length, triedNext: agentSaid(/after all, so nothing is booked. Looking for someone else/),
      requests: uacts.filter((a) => a.what === "request").length, readAsPlay: msgs.filter((m) => /^On it: asking the agents/.test(m.text)).length, readAsAutopilot: msgs.filter((m) => /^On it\. I'm checking your week/.test(m.text)).length, filedAsEvent: msgs.filter((m) => /^In your calendar:/.test(m.text)).length },
    turnout: { serve: turnout(sg), baseline: turnout(bg) },
    waits: { serve: waits, baseline: bg.map((g) => ({ game: g.id, by: g.by, minutes: g.waitMin })) },
    bands: { estimates: est.length, refused: refusedEst, byBand, note: "agentYes: the member's agent said a listed time works in a talk within 30 minutes of the estimate; played: a game with them was booked within the hour and played." },
    loop, feed, guard, never,
    baseline: { attempts: base.attempts.length, failed: Object.entries(base.attempts.filter((a) => a.failed).reduce((o, a) => { const k = a.failed.replace(/\d+/g, "n"); o[k] = (o[k] || 0) + 1; return o; }, {})).map(([why, n]) => ({ why, n })), games: base.games.map((g) => ({ date: g.date, start: g.start, format: g.format, by: g.by, with: g.with, played: g.played, waitMin: g.waitMin })) },
    serveGames: sg.map((g) => ({ key: g.key, date: g.date, start: g.start, format: g.format, by: g.by, with: g.with, venue: g.venue, played: g.played, turnout: g.turnout })),
    cost: { gatewayModelCalls: serve.flight?.llmCalls ?? null, gatewayModelErrors: serve.flight?.llmErrors ?? 0, guardCalls: serve.flight?.guardCalls ?? null, guardErrors: serve.flight?.guardErrors ?? 0, personaModelCalls: serve.persona?.calls ?? null, personaFailed: serve.persona?.failed ?? null, realMinutes: serve.realMinutes, bySite: serve.ledger },
  };
}
const dayOf = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

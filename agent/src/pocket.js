// Your agent in the player's pocket, whichever messaging app carries it (messenger.js is the transport). One agent with
// three helpers: Body keeps the body log and checks in on what hurts; Match notices when the player could play and asks
// "want a game?"; Talk agrees games with the other players' agents. The local model files what the player says (the
// calendar, finished sessions, what hurts) and answers anything else from the player's own facts (answer.js); reminders
// before each game and the evening check-in are pushed. A transport gives send(id, text, { feedback, tag, buttons })
// and, optionally, typing(id).
import * as memory from "./memory.js";
import * as guard from "./guard.js";
import * as store from "./store.js";
import { readClub } from "./club.js";
import { answer as answerOf, learn } from "./answer.js";
import * as life from "./life.js";
import * as bodylog from "./body.js";
import * as health from "./health.js";
import * as places from "./places.js";
import { helpers } from "./play.js";
import { forget as forgetAsks } from "./ask.js";
import * as vision from "./vision.js";
import * as asr from "./asr.js";
import { fetchFile } from "./files.js";
import { isPlayRequest, forget as forgetMatch, command as matchCommand } from "./match/index.js";
import * as signals from "./loop/signals.js";
import * as proposals from "./loop/proposals.js";
import { load as loadParts } from "./loop/parts.js";
import { forget as forgetFeed } from "./feed/index.js";

export const HELP = `I'm your Serve agent, here 24 hours a day, with three helpers:
• Body keeps your body log. Tell me what hurts ("my right knee is sore after jumping"); I check in on it a couple of days later and plan your games around it.
• Match watches your usual play times. When one is open and the people you play best with are free, I ask you: want a game?
• Talk takes your yes to the other players' agents and agrees the time and the court.
Just write to me: your schedule ("club training Wed 19:00-21:00"), how a game went ("played two hours with Leo"), or what hurts. Send a photo of the scoreboard after a game and I'll file the result. Share your health app's export (Apple Health, Google Fit) or a GPX, TCX or CSV file and I'll file your workouts.
/game ask me for a game now · /autopilot plan the whole week · /courts basketball near Da'an Park · /body your body log · /report your body report · /week calendar · /log a session · /improve on help improve Serve · /idea share an idea with the club · /ideas what the club asks for · /beta on try changes first · /forget delete everything I stored about you`;
// what /improve on says it will and won't count (loop/signals.js)
const IMPROVE_ON = "Thanks. From now on I count, with no words: your 👍 and 👎, your answers to \"want a game?\", and requests I couldn't meet. Nothing from your body log or health data. When I can't help with something, I may ask whether to share it with the club, in a short sentence with no names; it's shared only if you tap Share. /improve off stops it, /forget deletes it all.";
const IDEA_STATUS = { new: "new", waiting: "waiting for more support", open: "being looked at", review: "with the maintainer", approved: "approved", building: "being built", gated: "being tested", shipped: "shipped to beta members", rolledBack: "rolled back", refused: "not something Serve may do", exists: "Serve does this already" };
// a message that asks the agent to do something (when the answer that follows is not about doing it, no tool covered it)
const REQUEST = /^(can|could|would|will) (you|serve)\b|\b(i wish|wish (you|serve|it) (could|would)|it would be (nice|great|good|handy)|why (can't|cannot|doesn't|don't) (you|serve|it)|is there (a|any) way|please (add|let|make)|can (i|we) (get|have))\b/i;

// speech to text writes a spoken number on a scale the way it sounds ("for out of five", "to out of ten"): before a
// voice note is filed, the homophones in front of "out of" are read as the numbers they are (the player sees the result
// in "I heard: …")
const SOUNDS = { for: "four", fore: "four", to: "two", too: "two", ate: "eight", won: "one", free: "three", tree: "three" };
// and the same for a side in front of a body part ("my ripe shoulder")
const PART = "(?:shoulder|knee|ankle|elbow|wrist|hip|hand|foot|leg|arm|calf|hamstring|quad|thigh|heel|shin)s?";
// (sides only in a note about something that hurts, so "I write hand notes" stays as it is; "lift" is a word of its own)
const PAIN = /\b(sore|hurts?|hurting|pain|painful|aches?|aching|achy|tight|stiff|twist(ed)?|sprain(ed)?|pulled|rolled|strain(ed)?|swollen|tender|injur(ed|y)|tweaked|niggle|twinge|throbbing)\b/i;
export const spokenScale = (t) => {
  let s = String(t).replace(/\b(for|fore|to|too|ate|won|free|tree)\s+(out of|outta)\s+(five|ten|5|10)\b/gi, (_, w, o, n) => `${SOUNDS[w.toLowerCase()]} ${o} ${n}`);
  if (PAIN.test(s)) s = s.replace(new RegExp(`\\b(ripe|write|rite|wright)\\s+(?=${PART}\\b)`, "gi"), "right ").replace(new RegExp(`\\b(laughed)\\s+(?=${PART}\\b)`, "gi"), "left ");
  return s;
};
// a greeting on its own, in English or Chinese (a CJK word has no \b after it, so the end is spelled out)
const GREETING = /^(hi|hello|hey|yo|hiya|good (morning|afternoon|evening)|get started|你好|您好|嗨|哈囉|哈啰|安安|早安|午安|晚安)(\s*(there|serve))?[\s!！.。,，~～]*$/i;
// the fact tags an answer carries ([F3], [E1]) are for checking; a chat shows the sentence without them
const untag = (t) => String(t).replace(/\s*\[(?:F|E)\d+(?:,\s*(?:F|E)?\d+)*\]/g, "");

export function todayText(p, now = new Date()) {
  const ev = life.today(p, now);
  return ev.length ? `In your calendar today:\n${ev.map((e) => `• ${life.evText(e)}`).join("\n")}` : "Nothing in your calendar today. Send /autopilot and I'll line up a game.";
}

// the body log, the player's games and their health-app workouts, organized (body.js)
export const organizeFor = (p, now = new Date()) => bodylog.organize({ log: p.body?.log || [], workouts: p.body?.workouts || [], days: p.body?.days || [], games: p.games || [], now });
export function bodyText(p) {
  const org = organizeFor(p);
  if (!org.parts.length) return "Your body log is empty. Tell me when something hurts (\"my right knee is sore after jumping\") and I'll keep the record and plan your games around it.";
  const TREND = { new: "new", better: "getting better", worse: "getting worse", same: "about the same" };
  return `Your body log:\n${org.parts.slice(0, 8).map((x) => `• ${x.name[0].toUpperCase() + x.name.slice(1)}: ${x.latest.kind === "fine" ? "fine" : `${x.latest.kind} ${x.latest.level}/5`} (${x.entries.length} entr${x.entries.length > 1 ? "ies" : "y"}, ${TREND[x.trend]})`).join("\n")}${org.actions.length ? `\n\nWhat I'm doing about it:\n${org.actions.map((a) => `• ${a.text}`).join("\n")}` : ""}\n\nThis records what you tell me; it is not a diagnosis.`;
}
export async function reportText(p) {
  const org = organizeFor(p), s = await bodylog.summary(org);
  const w4 = org.weeks.slice(-4), mins = w4.reduce((a, w) => a + w.minutes, 0), n = w4.reduce((a, w) => a + w.sessions, 0);
  const sports = Object.entries(w4.reduce((a, w) => { for (const [k, v] of Object.entries(w.sports)) a[k] = (a[k] || 0) + v; return a; }, {})).sort((a, b) => b[1] - a[1]);
  const d = org.days.slice(-28), avg = (k) => { const v = d.map((x) => x[k]).filter((x) => x != null); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length * 10) / 10 : null; };
  return `Body report, last 4 weeks\n${s.text}\n\n${n} sessions, ${mins} minutes${sports.length ? `: ${sports.map(([k, v]) => `${k} ${v} min`).join(", ")}` : ""}.${org.load.acwr != null ? `\nLoad this week: ${org.load.acwr} times your usual week.` : ""}${avg("restingHr") ? `\nResting heart rate: ${avg("restingHr")} bpm on average.` : ""}${avg("sleepH") ? `\nSleep: ${avg("sleepH")} h a night.` : ""}${avg("steps") ? `\nSteps: ${Math.round(avg("steps"))} a day.` : ""}\n\n${bodyText(p)}`;
}

export function createPocket({ name: app, send: post, typing = async () => {}, onAutopilot = null, onGame = null, onPlay = null }) {
  // every message to the player goes out through here; with /improve on, a refusal or the "can't answer" fallback that
  // answers the player's last message is counted as an unmet request (the community loop, loop/signals.js)
  const lastIn = new Map();
  const send = async (id, text, opts) => {
    const r = await post(id, text, opts), e = lastIn.get(id), t = String(text);
    if (e && !e.sent) {
      e.sent = true;
      const source = t === guard.refusal([]) ? "guard" : /^(I can't answer that one here|Here is what I know:)/.test(t) ? "fallback" : null;
      if (source) { e.unmet = true; unmet(id, source, e.text).catch(() => {}); }
    }
    return r;
  };
  const welcome = (name) => {
    return `Hi ${name}, you're linked to Serve, your sports agent.\n\nOnly these messages pass through ${app}; your videos and health data stay on your own server.\n\n${HELP}`;
  };

  async function handle(id, name, raw) {
    const text = String(raw || "").trim();
    if (!text) return;
    lastIn.set(id, { text, sent: false });
    if (text.startsWith("/start")) { store.link(id, name); return send(id, welcome(name)); }
    // the first message links the chat: no command needed
    if (!store.get(id)) { store.link(id, name); await send(id, welcome(name)); if (GREETING.test(text)) return; }
    const p = store.get(id);
    // a hello is a hello, not a question
    if (GREETING.test(text)) return send(id, "Hi! Send /game and I'll look for a game at your usual times, /autopilot to plan the whole week, or just tell me what hurts. /help lists everything.");
    // what the player writes goes past Llama Guard first (commands are code's): a message about violence, crime, weapons,
    // hate, sexual content or self-harm is not acted on. Asking about an injury is not refused ("specialized advice" is
    // for what the agent says, checked on the way out).
    if (!text.startsWith("/")) { const stop = guard.stopsIn(await guard.screen([{ role: "user", content: text }]), text); if (stop) return send(id, guard.refusal(stop)); }
    // "forget what I said about Tomás", or /forget Tomás: only the notes about that member or topic (memory.js
    // forgetAbout; the words are not kept as a note); /forget alone still deletes everything
    const about = text.match(/^\/forget\s+(?!(?:everything|all|me|it all|all of it)\s*$)(.+)$/i)?.[1] || text.match(/^(?:please\s+)?forget\s+(?:what|everything|anything)\s+i\s+(?:said|told\s+you)\s+about\s+(.+?)[.!]*$/i)?.[1];
    if (about) {
      const r = await memory.forgetAbout(id, about);
      return send(id, r.deleted.length ? `Forgotten: ${r.deleted.length} note${r.deleted.length > 1 ? "s" : ""} about ${about.slice(0, 60)}, deleted from the server. Everything else you told me stays.` : `I have no notes about ${about.slice(0, 60)}.`);
    }
    // what the player says is kept as a note their agent can recall later (memory.js; /forget deletes it)
    if (!text.startsWith("/")) memory.remember(id, [{ text: text.slice(0, 400), kind: "said" }]).catch(() => {});
    if (text.startsWith("/forget")) { store.forget(id); forgetAsks(id); memory.forget(id); await signals.forget(id).catch(() => {}); forgetMatch(id); forgetFeed(id); return send(id, "Done: your memories, messages, calendar, games, body log, health data and club posts are deleted from the server. Send /start to begin again."); }
    // helping improve Serve: count-only signals (/improve on), one idea shared with a yes (/idea), the club's ideas (/ideas)
    if (/^\/improve\b/.test(text)) return improve(id, text);
    if (/^\/ideas\b/.test(text)) return ideasList(id);
    if (/^\/idea\b/.test(text)) return idea(id, text.replace(/^\/idea\S*\s*/, ""));
    if (/^\/beta\b/.test(text)) return beta(id, text);
    // the Autopilot, asked for in so many words: it plans the week and comes back with games to approve
    if (text.startsWith("/autopilot") || /\b(line up|find me|get me|book me)\b.{0,20}\b(games?|matches)\b|\bplan my week\b/i.test(text)) {
      if (/\b(off|stop)\b/i.test(text)) { store.setPref(id, "autopilot", false); return send(id, "Autopilot is off. I won't line up games until you send /autopilot again."); }
      store.setPref(id, "autopilot", true);
      await send(id, "On it. I'm checking your week, finding the people you play best with at your usual times, and agreeing the games with their agents. I'll come back with them to approve.");
      onAutopilot?.(id).catch((e) => send(id, `I couldn't finish the plan (${e.message}).`));
      return;
    }
    // "I want to play", "anyone for doubles Thursday?": the agents of the people likeliest to say yes are asked first,
    // and the game they agree waits for the player's yes (match/flow.js)
    if (onPlay && isPlayRequest(text)) { await typing(id).catch(() => {}); return onPlay(id, text).catch((e) => send(id, `I couldn't look right now (${e.message}).`)); }
    // "want a game?" asked for: the Match helper looks at the next week now
    if (text.startsWith("/game") || /^(any|want|up for|fancy) (a )?(game|match)\b|\bgame (this|tomorrow|tonight)\b.*\?$/i.test(text)) {
      if (/\b(off|stop)\b/i.test(text)) { store.setPref(id, "ask", false); return send(id, "OK, I'll stop asking. Send /game when you want one."); }
      store.setPref(id, "ask", true);
      await typing(id).catch(() => {});
      return onGame?.(id).catch((e) => send(id, `I couldn't look right now (${e.message}).`));
    }
    if (text.startsWith("/help")) return send(id, HELP);
    if (/^\/(bands|learn|confirm)\b/i.test(text)) return send(id, matchCommand(id, text)); // matchmaking choices (match/commands.js)
    if (text.startsWith("/body")) return send(id, bodyText(store.get(id)));
    if (text.startsWith("/report")) return send(id, await reportText(store.get(id)));
    if (text.startsWith("/courts")) return courts(id, text.replace(/^\/courts\S*\s*/, ""));
    // what hurts (and nothing about a finished session): filed in the body log, and the games planned around it
    if (bodylog.about(text) && !/\b(played|trained|ran|did|session|game|match|minutes?|min|hours?)\b/i.test(text) && !text.startsWith("/")) return bodyLog(id, text);
    if (text.startsWith("/week") || text.startsWith("/schedule")) return send(id, life.weekText(p));
    if (text.startsWith("/today")) return send(id, todayText(p));
    await typing(id).catch(() => {});

    // free text (or /log): the local model files it as a calendar entry, a finished session, or a question
    const body = text.replace(/^\/log\S*\s*/, "");
    // (FILING_NOW, for the end-to-end test only: the day and hour a message is read against, so "on Wednesday" is one date)
    const now = process.env.FILING_NOW ? new Date(process.env.FILING_NOW) : new Date();
    const r = await life.read(body, now).catch(() => ({ intent: "chat", items: [], events: [], log: {} }));
    if (text.startsWith("/log")) r.intent = "log";
    if (r.intent === "event" && r.events.length) {
      const evs = life.addEvents(id, r.events);
      const sessions = evs.filter((e) => ["training", "match"].includes(e.kind) && e.start);
      await send(id, `In your calendar:\n${evs.map((e) => `• ${life.evText(e)}`).join("\n")}${sessions.length ? "\nI'll message you an hour before." : ""}\nSee the week with /week.`);
      return learnFrom(id, text);
    }
    if (r.intent === "log") {
      const l = life.addLog(id, r.log, body);
      await send(id, `Logged for ${l.date}: ${l.what}${l.minutes ? `, ${l.minutes} min` : ""}${l.pain ? ` · pain: ${l.pain}` : ""}.`);
      // a booked game that ran past its booking: the players clicked, so the Autopilot pairs them up again
      // the game is the one on that day, or the booked one with the partners the player names ("with Leo")
      const names = Object.fromEntries(readClub().members.map((m) => [m.id, m.name.split(" ")[0].toLowerCase()]));
      const said = body.toLowerCase(), near = (e) => Math.abs(new Date(e.date) - new Date(l.date)) <= 7 * 864e5;
      const g = (store.get(id).events || []).find((e) => e.date === l.date && e.with?.length) || (store.get(id).events || []).find((e) => e.with?.length && near(e) && e.with.some((w) => names[w] && said.includes(names[w])));
      if (g && l.minutes) {
        store.update(id, (q) => { q.games.push({ date: g.date, start: g.start, sport: "badminton", format: g.with.length > 1 ? "doubles" : "singles", with: g.with, booked: g.booked, played: l.minutes }); q.games = q.games.slice(-60); });
        const over = l.minutes - g.booked;
        if (over >= 15) await send(id, `You played ${over} minutes past the booking. Good sign: I'll put this group first the next time I line up games.`);
      }
      // "knee felt fine": the body log hears it too
      if (bodylog.about(text)) { const b = await bodylog.read(text); if (b.entries.length) { store.update(id, (q) => { q.body.log.push(...b.entries); }); await send(id, bodylog.said(b.entries, organizeFor(store.get(id)))); } }
      return learnFrom(id, text);
    }
    const out = await answer(id, text, text);
    // a request no tool covers: answered, but not done (unless the answer was the fallback, counted already)
    const e = lastIn.get(id);
    if (e && !e.unmet && REQUEST.test(text)) unmet(id, "no-tool", text).catch(() => {});
    lastIn.delete(id);
    return out;
  }

  // ---- the community loop (loop/signals.js, loop/proposals.js) ----
  // an unmet request: counted with no words; then, unless a guard refused it, the player is asked whether to share it
  async function unmet(id, source, text) {
    if (!text || !signals.consented(id)) return;
    const r = signals.record(id, { kind: "unmet", source, text });
    if (!r.recorded || source === "guard") return;
    const offer = await signals.offerShare(id, { kind: "unmet", source, text }).catch(() => null);
    if (offer?.id) await post(id, `I couldn't really help with that. ${offer.prompt}`, { buttons: offer.buttons });
  }
  async function improve(id, text) {
    const arg = text.replace(/^\/improve\S*\s*/, "").trim().toLowerCase();
    if (arg === "on") { signals.consent(id, true); return post(id, IMPROVE_ON); }
    if (arg === "off") { signals.consent(id, false); return post(id, "Done: I've stopped counting, and the counts are deleted. Ideas you shared stay with the club until you send /forget."); }
    return post(id, signals.consented(id) ? "Helping improve Serve is on: I count your 👍 and 👎 and the requests I couldn't meet, with no words. /improve off stops it." : "Helping improve Serve is off. /improve on lets me count, with no words, your 👍 and 👎 and the requests I couldn't meet. /idea and your idea shares one idea with the club.");
  }
  async function idea(id, wish) {
    if (!wish) return post(id, "Tell me your idea after /idea, like: /idea ask me about games in the evening");
    await typing(id).catch(() => {});
    const offer = await signals.offerShare(id, { kind: "wish", text: wish }).catch((e) => ({ offered: false, why: String(e.message || e) }));
    if (!offer?.id) return post(id, offer?.why === "about the body or health" ? "I keep anything about your body or health out of the club's ideas, so I won't share that one." : offer?.why === "an offer is already waiting" ? "Answer the last Share question first." : "I couldn't put that into a short sentence the club can see without names or numbers. Try saying what you'd like Serve to do.");
    return post(id, offer.prompt, { buttons: offer.buttons });
  }
  async function ideasList(id) {
    const list = proposals.ideas({ who: signals.whoOf(id) }).slice(0, 5), left = proposals.credits(signals.whoOf(id));
    if (!list.length) return post(id, "No idea has five members behind it yet. /idea and your idea shares one with the club.");
    const lines = list.map((x, i) => `${i + 1}. ${x.title} (${x.members} members${x.votes.total ? `, ${x.votes.total} vote${x.votes.total === 1 ? "" : "s"}` : ""}${x.votes.mine ? `, ${x.votes.mine} yours` : ""}): ${IDEA_STATUS[x.status] || x.status}${x.exists ? `. ${x.exists.how}` : ""}`);
    const buttons = list.map((x, i) => [x, i]).filter(([x]) => x.proposal && ["open", "review", "approved", "rolledBack"].includes(x.status)).slice(0, 3).map(([x, i]) => ({ title: `Vote for ${i + 1}`, payload: `qv:${x.proposal}:1` }));
    return post(id, `Ideas from the club:\n${lines.join("\n")}\n\nYou have ${left} of 9 vote credits this month. More votes on one idea cost more: 1 credit for one vote, 4 for two, 9 for three.`, buttons.length ? { buttons } : {});
  }
  // beta members get a change the club asked for first (a canary), and it turns itself off if it goes wrong (loop/flags.js)
  async function beta(id, text) {
    const arg = text.replace(/^\/beta\S*\s*/, "").trim().toLowerCase();
    if (arg !== "on" && arg !== "off") return post(id, "Beta members try a change the club asked for before everyone else, and the change turns itself off if it goes wrong. /beta on to join, /beta off to leave.");
    try { const { flags } = await loadParts(); await flags.beta(id, arg === "on"); }
    catch { return post(id, "Beta isn't open on this server yet."); }
    return post(id, arg === "on" ? "You're a beta member: you may get a change the club asked for before everyone else. /beta off to leave." : "You've left beta: you get what everyone gets.");
  }
  // the Share and Don't buttons (sh:<item>:yes|no) and a vote (qv:<proposal>:1, one vote more)
  async function loopAnswer(id, payload) {
    let m = /^sh:([\w-]+):(yes|no)$/.exec(payload);
    if (m) {
      const r = await signals.share(id, m[1], m[2] === "yes");
      if (r.shared) return post(id, `Shared with the club as “${r.item.text}”. Nobody sees who said it. /ideas shows what the club asks for.`);
      if (r.held) return post(id, "Thanks. The safety check is not answering right now, so it waits, unshared, and goes to the club once the check passes it.");
      return post(id, r.why === "the player said no" ? "OK, not shared." : r.why === "no such offer" ? "That question has gone, so nothing was shared." : `Not shared: ${r.why}.`);
    }
    m = /^qv:(P-\d+):1$/.exec(payload);
    if (!m) return;
    const who = signals.whoOf(id), r = proposals.vote(who, m[1], proposals.myVotes(who, m[1]) + 1);
    return post(id, r.ok ? `Voted: ${r.votes} vote${r.votes === 1 ? "" : "s"} for that idea. ${r.credits} credit${r.credits === 1 ? "" : "s"} left this month.` : `Not voted: ${r.why}.`);
  }

  // an answer from the player's agent, from their own facts, with 👍 / 👎; then learn anything durable they said
  async function answer(id, ask, original, learnAfter = true, extra = {}) {
    store.addTurn(id, "user", ask);
    const r = await answerOf({ text: ask, playerId: id });
    // the answer is a model's, so it goes past Llama Guard before the player reads it (no diagnosis, no hazard)
    const out = await guard.checkOut(r.text, { ask, fallback: "I can't answer that one here. Ask me about your games, your week or what hurts, and I'll plan around it." });
    if (out.flagged) r.text = out.text;
    store.addTurn(id, "assistant", r.text, { verified: r.verified.ok });
    const turn = store.get(id).history.length - 1;
    // 👍 / 👎 under every reply, kept with the answer
    await send(id, untag(r.text), { feedback: turn, ...extra });
    if (learnAfter) await learnFrom(id, original);
    return r;
  }
  async function learnFrom(id, text) {
    if (text.startsWith("/")) return;
    const learned = await learn(id, text);
    if (learned.length) await send(id, `(Noted: ${learned.join("; ")}. Send /forget to delete.)`);
  }
  // a 👍 or 👎 on an answer: kept on that turn (and counted for the community loop with /improve on: messenger.js)
  function feedback(id, turnIndex, value) {
    const turn = store.get(id)?.history[turnIndex];
    if (!turn || turn.role !== "assistant") return false;
    store.update(id, (q) => { q.history[turnIndex].feedback = value; });
    return true;
  }

  // ---- a voice note: Omnilingual ASR on this server, the words shown back, then handled as if typed ----
  async function voice(id, url) {
    if (!asr.available()) return send(id, "I can't listen to voice notes on this server yet. Type it and I'll file it.");
    let audio;
    try { audio = await fetchFile(url, 10e6); }
    catch (e) { return send(id, `I couldn't open that voice note (${e.message}).`); }
    await typing(id).catch(() => {});
    let text;
    try { ({ text } = await asr.transcribe(audio)); } catch (e) { return send(id, `I couldn't make out that voice note (${e.message}). Type it and I'll file it.`); }
    if (!text || text.length < 2) return send(id, "I couldn't make out any words in that voice note. Try again, a little closer to the phone.");
    text = spokenScale(text);
    await send(id, `I heard: “${text.slice(0, 400)}”`);
    return handle(id, "there", text.slice(0, 600));
  }

  // ---- a result from a photo of the scoreboard ----
  // Muse Glimmer reads each game's score from the photo (no tools, a JSON Schema for the answer), the rules of the
  // sport check it, and the player says which side they were before it is filed
  async function photo(id, url) {
    await send(id, "Got your photo. Reading the score on your own server…");
    let img;
    try { img = await fetchFile(url, 8e6); }
    catch (e) { return send(id, `I couldn't open that photo (${e.message}).`); }
    const p = store.get(id), club = readClub();
    const names = [...new Set((p?.events || []).filter((e) => e.with?.length).slice(-3).flatMap((e) => e.with).map((w) => club.members.find((m) => m.id === w)?.name.split(" ")[0]).filter(Boolean))];
    const r = await vision.readScore(img.toString("base64"), { players: names });
    if (!r.read) return send(id, `I couldn't read a score in that photo (${r.why}). Try a straighter photo, or type it: "won 21-17 19-21 21-15 against Leo".`);
    const read = r.games.map((g) => `${g.first}–${g.second}`).join(", ");
    if (!r.valid) return send(id, `I read ${read}, but that can't be a final score: ${r.problems.join("; ")}. Send a clearer photo, or type the score.`);
    const nonce = Math.random().toString(36).slice(2, 8);
    store.update(id, (q) => { q.prefs.pendingScore = { games: r.games, names: r.names || null, winner: r.winner, at: Date.now(), nonce }; });
    const n1 = r.names?.first || "the first player", n2 = r.names?.second || "the second player", w = Math.max(r.won.first, r.won.second), l = Math.min(r.won.first, r.won.second);
    return send(id, `I read ${read}: ${r.winner === "first" ? n1 : n2} won ${w}–${l}. That fits the rules of the game. Which one are you?`,
      { buttons: [{ title: `I'm ${n1}`, payload: `sc:${nonce}:first` }, { title: `I'm ${n2}`, payload: `sc:${nonce}:second` }, { title: "Not right", payload: `sc:${nonce}:no` }] });
  }
  async function scoreAnswer(id, payload) {
    const s = store.get(id)?.prefs.pendingScore, [, nonce, side] = payload.split(":");
    if (!s) return send(id, "I have no score waiting to be filed. Send the photo again.");
    if (s.nonce !== nonce || !["first", "second", "no"].includes(side)) return send(id, "Those buttons were for an earlier photo. Use the ones under the latest score.");
    store.update(id, (q) => { delete q.prefs.pendingScore; });
    if (side === "no") return send(id, "OK, nothing filed. Type the score, or send a clearer photo.");
    const won = s.winner === side, mine = s.games.map((g) => (side === "first" ? `${g.first}–${g.second}` : `${g.second}–${g.first}`)).join(" "), against = side === "first" ? s.names?.second : s.names?.first;
    store.update(id, (q) => { (q.results ||= []).push({ date: life.ymd(new Date()), sport: "badminton", won, score: mine, against: against || null, from: "photo", at: Date.now() }); q.results = q.results.slice(-60); });
    return send(id, `Filed: you ${won ? "won" : "lost"} ${mine}${against ? ` against ${against}` : ""}.`);
  }

  // ---- the body log, the health app and courts nearby ----
  async function bodyLog(id, text) {
    await typing(id).catch(() => {});
    const b = await bodylog.read(text);
    if (!b.entries.length) return answer(id, text, text);
    store.update(id, (q) => { q.body.log.push(...b.entries); q.body.log = q.body.log.slice(-300); });
    await send(id, bodylog.said(b.entries, organizeFor(store.get(id))));
  }
  // the answer to "How is your right knee today?": fine now, the same, or worse
  async function bodyAnswer(id, payload) {
    const m = /^bd:([\w:]+):(fine|same|worse)$/.exec(payload), p = store.get(id);
    if (!m || !p) return;
    const last = [...p.body.log].reverse().find((e) => bodylog.keyOf(e) === m[1]);
    if (!last) return send(id, "I have nothing logged for that any more.");
    const e = { ...last, id: `b${Date.now().toString(36)}`, at: new Date().toISOString(), kind: m[2] === "fine" ? "fine" : last.kind, level: m[2] === "fine" ? 0 : Math.min(5, last.level + (m[2] === "worse" ? 1 : 0)), trigger: null, note: `answered the check-in: ${m[2]}` };
    store.update(id, (q) => { q.body.log.push(e); });
    await send(id, bodylog.said([e], organizeFor(store.get(id))));
  }
  // a file shared to the chat: a health app's export, or one workout
  async function file(id, url, name) {
    await send(id, "Got your file. Reading it on your own server (it is deleted once read)…");
    let r;
    try { r = await health.fromUrl(url, name, { fetchBytes: fetchFile }); } catch (e) { return send(id, `I couldn't read that file (${e.message}). I read Apple Health's export.zip, a Google Fit Takeout zip, and GPX, TCX or CSV files.`); }
    if (!r.workouts.length && !r.days.length) return send(id, "I found no workouts or daily numbers in that file.");
    store.update(id, (q) => {
      const key = (w) => `${w.date} ${w.start} ${w.sport}`, have = new Set(q.body.workouts.map(key));
      q.body.workouts.push(...r.workouts.filter((w) => !have.has(key(w))).map((w) => ({ ...w, route: w.route?.slice(0, 80) || null })));
      q.body.workouts = q.body.workouts.slice(-400);
      const days = Object.fromEntries(q.body.days.map((d) => [d.date, d])); r.days.forEach((d) => { days[d.date] = { ...days[d.date], ...d }; }); q.body.days = Object.values(days).sort((a, b) => a.date.localeCompare(b.date)).slice(-180);
    });
    const org = organizeFor(store.get(id));
    const learned = org.actions.filter((a) => a.kind === "learned" || a.kind === "load");
    // the watch's minutes for a booked game teach the Autopilot who you click with
    for (const l of org.linked) store.update(id, (q) => { const g = q.games.find((x) => x.date === l.date && x.start === l.start); if (g) g.played = l.minutes; });
    await send(id, `Read your ${r.source} file: ${r.counts.workouts} workout${r.counts.workouts === 1 ? "" : "s"}${r.counts.routes ? ` (${r.counts.routes} with a GPS route)` : ""} and ${r.counts.days} day${r.counts.days === 1 ? "" : "s"} of steps, heart rate and sleep.${org.load.acwr != null && !learned.some((a) => a.kind === "load") ? ` This week's load is ${org.load.acwr} times your usual week.` : ""}${learned.length ? "\n" + learned.map((a) => a.text).join("\n") : ""}\nSend /report for your body report.`);
  }
  async function courts(id, arg) {
    const sport = (arg.match(/\b(badminton|tennis|pickleball|table tennis|basketball|volleyball|soccer|football)\b/i) || [, "basketball"])[1].toLowerCase();
    const nearQ = (arg.match(/\bnear\s+(.+)$/i) || [])[1];
    await send(id, `Looking for ${sport} courts${nearQ ? ` near ${nearQ}` : " near you"}: the map, their reviews and tonight's forecast…`);
    try {
      const geo = helpers.readVenues().map?.geo;
      const here = nearQ ? await places.where(nearQ) : geo ? { ...places.toGeo(geo, readClub().you.area), name: "your area" } : null;
      if (!here) return send(id, "Tell me where: /courts basketball near Da'an Park");
      const r = await places.search({ lat: here.lat, lon: here.lon, sport, start: "19:00", limit: 5 });
      const top = r.places.slice(0, 4);
      if (!top.length) return send(id, `No ${sport} courts found within 2.5 km of ${here.name}.`);
      await send(id, `${sport[0].toUpperCase() + sport.slice(1)} near ${here.name}, tonight at 19:00${r.weather ? ` (rain ${r.weather.rain}%)` : ""}:\n${top.map((p) => `${{ good: "✅", maybe: "🤔", no: "❌" }[p.verdict]} ${p.name}, ${p.dist} m ${p.dir}: ${p.reasons.slice(0, 2).map((x) => x.text).join(" ")}${p.url ? `\n   ${p.url}` : ""}`).join("\n")}${r.reviews ? "\nReviews from Google Maps." : ""}`);
    } catch (e) { await send(id, `I couldn't search right now (${e.message}).`); }
  }

  return { handle, feedback, send, bodyAnswer, file, photo, scoreAnswer, voice, loopAnswer };
}

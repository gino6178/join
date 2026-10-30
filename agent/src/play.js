// Play: say you want to play, and the agent does the tedious part, for any sport the club's venues have (badminton,
// tennis, pickleball, table tennis, basketball, volleyball). Muse Glimmer reads the request ("doubles on Thursday
// evening", "tennis with Ines on Saturday", "我週六早上想打球", "challenge Kenji") into a structured intent; code then searches the venues'
// free courts and the club members who are free then, scores partners (requested friends, format, level, how far they
// live from the court), lines up everyone's calendars and picks the
// venue in the middle: the one where the longest trip is shortest. It keeps the three best different options.
// Glimmer writes the proposal and one invite per partner; every time, price and count in them must match the option.
// Nothing is booked until the player confirms; then the court is held, invites go out, and a partner who declines is
// replaced by the next best one.
import fs from "node:fs";
import path from "node:path";
import { chat } from "./llm.js";
import { readClub } from "./club.js";
import { readJSON, writeJSON } from "./jsonfile.js";

// hooks the matchmaker installs (match/index.js): the options' partners ordered by their agents' bands, and an invite's
// in or out noted for that member (and the ledger of the bands). a2a.js installs confirm and unbook: partners whose
// agents are on a peer gateway confirm a booking there, and hear when it is cancelled (peer.js).
export const hooks = { rerank: null, invite: null, cancel: null, inviteAnswer: null, confirm: null, unbook: null };
const DATA = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), "../../web/public/data");
const FILE = path.resolve(process.env.BOOKINGS_FILE || "data/bookings.json");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const LEVEL = { A: 3, B: 2, C: 1 };
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const toMin = (s) => { const [h, m] = String(s).split(":").map(Number); return h * 60 + (m || 0); };
const dateOf = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const readVenues = () => JSON.parse(fs.readFileSync(path.join(DATA, "venues.json"), "utf8"));
// FNV-1a with a final mix, so similar keys (same venue, next hour) still spread evenly over 0..1
const hash = (s) => {
  let h = 2166136261;
  for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
};

// Venue adapter. The demo venues answer from a fixed pseudo-random timetable, so the same question gives the same
// courts; a real venue implements the same two calls against its booking system.
export const demoVenues = {
  hours(v, date) { return ([0, 6].includes(date.getDay()) && v.weekendOpen) || v.open; },
  freeCourts(v, date, start, minutes) {
    const [o, c] = this.hours(v, date).map(toMin);
    if (start < o || start + minutes > c) return [];
    const peak = (start >= 18 * 60 && start < 21 * 60) || [0, 6].includes(date.getDay());
    const busy = (peak ? v.peakBusy : v.offBusy) * 0.6, out = [];
    // a court already booked through Serve at an overlapping time is not free either
    const booked = new Set(db.bookings.filter((b) => !b.cancelled && b.option?.venue?.id === v.id && b.option.date === ymd(date) && toMin(b.option.start) < start + minutes && start < toMin(b.option.start) + (b.option.minutes || 90)).map((b) => b.option.court));
    for (let k = 1; k <= v.courts; k++) {
      let free = !booked.has(k);
      for (let t = Math.floor(start / 60) * 60; t < start + minutes; t += 60) if (hash(`${v.id}|${ymd(date)}|${t}|${k}`) < busy) { free = false; break; }
      if (free) out.push(k);
    }
    return out;
  },
  hold(v, date, start, minutes, court) { return { ok: this.freeCourts(v, date, start, minutes).includes(court), ref: `${v.id.slice(0, 2).toUpperCase()}-${Math.floor(hash(`${v.id}${ymd(date)}${start}${court}${Date.now()}`) * 1e6).toString(36).toUpperCase()}` }; },
};

// Where people are: members share an approximate home area on the club map (km from its top-left corner), never an
// address. Streets are not straight lines, so a trip is 1.25x the straight distance, at about 20 km/h through town
// plus 5 minutes to get going.
const kmBetween = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) * 1.25;
const travelMin = (a, b) => Math.round(5 + 3 * kmBetween(a, b));
const first = (n) => n.split(" ")[0];
const span = ([f, t]) => `${hm(f)}–${hm(t)}`;
// the times that suit everyone: the intersection of each person's free windows, day by day
function calendar(people, dates) {
  const cut = (a, b) => a.flatMap(([f1, t1]) => b.map(([f2, t2]) => [Math.max(f1, f2), Math.min(t1, t2)])).filter(([f, t]) => t - f >= 60);
  return {
    people: people.map((x) => ({ id: x.id, name: x.name })),
    days: dates.map((ds) => {
      const d = dateOf(ds), rows = people.map((x) => windows(x.free).filter((w) => w.day === d.getDay()).map((w) => [w.from, w.to]));
      return { date: ds, day: DAYS[d.getDay()], rows, all: rows.reduce(cut) };
    }),
  };
}
const windows = (list) => (list || []).map((w) => { const m = w.match(/^(\w{3})\s+(\d{1,2})-(\d{1,2})$/); return m ? { day: DAYS.indexOf(m[1]), from: +m[2] * 60, to: +m[3] * 60 } : null; }).filter(Boolean);
const freeAt = (wins, date, start, minutes) => wins.some((w) => w.day === date.getDay() && w.from <= start && start + minutes <= w.to);

// ---- reading the request --------------------------------------------------------------------------------------
const PARTS = { morning: ["08:00", "12:00"], afternoon: ["13:00", "18:00"], evening: ["18:00", "22:00"], tonight: ["18:00", "22:00"] };
export const SPORTS = ["badminton", "tennis", "pickleball", "table tennis", "basketball", "volleyball"];
const SPORT_RX = [["table tennis", /table tennis|ping ?pong|桌球|乒乓/i], ["tennis", /tennis|網球/i], ["pickleball", /pickleball|匹克球/i], ["basketball", /basketball|hoops|籃球/i], ["volleyball", /volleyball|排球/i], ["badminton", /badminton|羽球|羽毛球/i]];
const sportIn = (text) => SPORT_RX.find(([, rx]) => rx.test(text))?.[0] || null;
// a venue's courts and price for one sport (venues list theirs under `sports`; a venue without the sport is skipped)
const forSport = (v, sport) => (v.sports ? (v.sports[sport] ? { ...v, courts: v.sports[sport].courts, price: v.sports[sport].price } : null) : sport === "badminton" ? v : null);
const plays = (m, sport) => (m.sports || ["badminton"]).includes(sport);
function ruleIntent(text, members, now) {
  const t = text.toLowerCase(), days = [];
  const zh = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
  DAYS.forEach((d, i) => { if (new RegExp(`\\b${d.toLowerCase()}`).test(t)) days.push(i); });
  for (const m of text.matchAll(/(?:週|周|星期|禮拜)([一二三四五六日天])/g)) days.push(zh[m[1]]);
  const dates = [];
  if (/tonight|today|今天|今晚/.test(t)) dates.push(ymd(now));
  if (/tomorrow|明天|明晚/.test(t)) { const d = new Date(now); d.setDate(d.getDate() + 1); dates.push(ymd(d)); }
  for (const wd of days) { const d = new Date(now); d.setDate(d.getDate() + ((wd - d.getDay() + 7) % 7 || (d.getHours() >= 21 ? 7 : 0))); dates.push(ymd(d)); }
  const part = /morning|早上|上午/.test(t) ? "morning" : /afternoon|下午/.test(t) ? "afternoon" : /evening|night|tonight|晚上|今晚|明晚/.test(t) ? "evening" : null;
  const format = /single|單打/.test(t) ? "singles" : /double|雙打/.test(t) ? "doubles" : "any";
  const withIds = members.filter((m) => t.includes(m.name.split(" ")[0].toLowerCase()) || text.includes(m.name)).map((m) => m.id);
  const minutes = /2\s*(h|hours?|小時)|兩小時|120/.test(t) ? 120 : /1\s*(h|hour)|一小時|60\s*min/.test(t) ? 60 : 90;
  const challenge = /challenge|rematch|\bvs\.?\b|versus|約戰|挑戰|單挑|對打/i.test(text);
  return { days: [...new Set(dates)], from: part ? PARTS[part][0] : null, to: part ? PARTS[part][1] : null, minutes, format, with: withIds, focus: null, challenge, note: "", sport: sportIn(text) || "badminton" };
}

export async function readIntent(text, members, now) {
  const sys = `Turn a player's request to play a sport into JSON. Now: ${DAYS[now.getDay()]} ${ymd(now)} ${hm(now.getHours() * 60 + now.getMinutes())}.
Club members (id: name): ${members.map((m) => `${m.id}: ${m.name}`).join("; ")}.
Return JSON only: {"sport": ${SPORTS.map((s) => `"${s}"`).join(" | ")}, "days": ["YYYY-MM-DD", ...], "from": "HH:MM" or null, "to": "HH:MM" or null, "minutes": 60 | 90 | 120, "format": "doubles" | "singles" | "any", "with": [member ids], "focus": string or null, "challenge": true | false, "note": string}
- "sport": the sport they name; "badminton" if they do not name one. For basketball and volleyball, "doubles" means two against two.
- "days": the dates the player means, within the next 14 days; [] if they did not say (any day this week).
- Morning 08:00-12:00, afternoon 13:00-18:00, evening or tonight 18:00-22:00. null if they did not say.
- "minutes": 90 unless they say how long. "with": members they name. "focus": what they want to practise, if they say it.
- "challenge": true if they want to challenge someone to a match (約戰, 挑戰, 單挑, "a match against Kenji"), else false.
- The request may be in English or Chinese.`;
  try {
    const r = await chat([{ role: "system", content: sys }, { role: "user", content: text }], { maxTokens: 260, temperature: 0 });
    const j = JSON.parse((r.text.match(/\{[\s\S]*\}/) || ["null"])[0]);
    const today = ymd(now), last = (() => { const d = new Date(now); d.setDate(d.getDate() + 14); return ymd(d); })();
    const hhmm = (x) => (/^\d{2}:\d{2}$/.test(x || "") ? x : null);
    // a window no longer than the game itself leaves one start time; "evening" means the whole evening
    if (hhmm(j.from) && hhmm(j.to) && toMin(j.to) - toMin(j.from) <= (+j.minutes || 90)) j.to = hm(Math.min(22 * 60, toMin(j.from) + 4 * 60));
    const intent = {
      days: (Array.isArray(j.days) ? j.days : []).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= today && d <= last),
      from: hhmm(j.from), to: hhmm(j.to), minutes: [60, 90, 120].includes(+j.minutes) ? +j.minutes : 90,
      format: ["doubles", "singles"].includes(j.format) ? j.format : "any",
      with: (Array.isArray(j.with) ? j.with : []).filter((id) => members.some((m) => m.id === id)),
      focus: typeof j.focus === "string" && j.focus.length < 80 ? j.focus : null, challenge: j.challenge === true, note: typeof j.note === "string" ? j.note.slice(0, 160) : "",
      // the sport named in the words wins over the model's guess (it defaults to badminton)
      sport: sportIn(text) || (SPORTS.includes(j.sport) ? j.sport : "badminton"),
    };
    return { intent, by: "model", timing: r.timing };
  } catch (e) {
    return { intent: ruleIntent(text, members, now), by: "rules", error: String(e.message || e) };
  }
}

// ---- searching ---------------------------------------------------------------------------------------------------
export function partnerScore(m, ctx) {
  const why = [];
  let s = 0;
  if (ctx.intent.with.includes(m.id)) { s += 6; why.push("you asked for them"); }
  if (ctx.format !== "any" && (m.prefers === ctx.format || m.prefers === "any")) { s += 1; why.push(`likes ${ctx.format}`); }
  const gap = Math.abs((LEVEL[m.level] || 2) - (LEVEL[ctx.you.level] || 2));
  s -= gap; if (!gap) why.push(`same level (${m.level})`);
  if (m.area) { const t = travelMin(m.area, ctx.venue); s -= 0.06 * t; if (t <= 12) why.push(`lives ${t} min away`); }
  return { s, why };
}

export function search({ intent, you, club, venues, now }) {
  const sport = intent.sport || "badminton", members = club.members.filter((m) => plays(m, sport)), myWins = windows(club.you?.free), me = { id: "you", name: "You", area: club.you?.area, free: club.you?.free };
  const dates = intent.days.length ? intent.days : Array.from({ length: 7 }, (_, i) => { const d = new Date(now); d.setDate(d.getDate() + i); return ymd(d); });
  // a challenge is singles (doubles with three named); with a sore knee, doubles first
  const want = intent.format !== "any" ? intent.format : intent.challenge ? (intent.with.length >= 3 ? "doubles" : "singles") : you.limit ? "doubles" : "any";
  const opts = [], openBy = {};
  let looked = 0, open = 0;
  for (const ds of dates) {
    const date = dateOf(ds), isToday = ds === ymd(now), nowMin = now.getHours() * 60 + now.getMinutes();
    for (const v0 of venues.venues) {
      const v = forSport(v0, sport);
      if (!v) continue;
      const [o, c] = demoVenues.hours(v, date).map(toMin);
      const from = Math.max(o, intent.from ? toMin(intent.from) : o, isToday ? Math.ceil((nowMin + 60) / 30) * 30 : 0);
      const to = Math.min(c, intent.to ? toMin(intent.to) : c);
      for (let start = from; start + intent.minutes <= to; start += 30) {
        // without a time in the request, keep to the times the player is usually free
        if (!intent.from && myWins.length && !freeAt(myWins, date, start, intent.minutes)) continue;
        looked++;
        const courts = demoVenues.freeCourts(v, date, start, intent.minutes);
        if (!courts.length) continue;
        open++; openBy[v.id] = (openBy[v.id] || 0) + 1;
        const ctx = { intent, you, format: want, venue: v };
        const free = members.filter((m) => freeAt(windows(m.free), date, start, intent.minutes)).map((m) => ({ m, ...partnerScore(m, ctx) })).sort((a, b) => b.s - a.s);
        const need = want === "singles" ? 1 : want === "doubles" ? 3 : free.length >= 3 ? 3 : 1;
        if (free.length < need) continue;
        const pick = free.slice(0, need), asked = intent.with.filter((id) => pick.some((p) => p.m.id === id)).length;
        const players = need + 1, total = Math.round((v.price * intent.minutes) / 60);
        // the venue in the middle: the longest trip in the group counts, so nobody crosses town for everyone else
        const travel = [me, ...pick.map((p) => p.m)].filter((x) => x.area).map((x) => ({ id: x.id, name: x.name, min: travelMin(x.area, v), km: +kmBetween(x.area, v).toFixed(1) }));
        const longest = Math.max(0, ...travel.map((t) => t.min));
        const score = pick.reduce((a, p) => a + p.s, 0) + (asked === intent.with.length ? 4 : -4 * (intent.with.length - asked)) - 0.18 * longest - total / 400 - dates.indexOf(ds) * 0.15;
        opts.push({
          id: `${v.id}-${ds}-${hm(start)}`, date: ds, day: DAYS[date.getDay()], start: hm(start), end: hm(start + intent.minutes), minutes: intent.minutes,
          venue: { id: v.id, name: v.name, area: v.area, km: travel.find((t) => t.id === "you")?.km ?? null, x: v.x, y: v.y }, court: courts[0], courtsFree: courts.length, travel, longest,
          format: need === 1 ? "singles" : "doubles", sport, players, price: v.price, total, each: Math.round(total / players),
          partners: pick.map((p) => ({ id: p.m.id, name: p.m.name, level: p.m.level, why: p.why.slice(0, 2) })),
          spare: free.slice(need, need + 4).map((p) => p.m.id), asked: intent.with.filter((id) => pick.some((p) => p.m.id === id)), score: +score.toFixed(2),
        });
      }
    }
  }
  // three different options: best overall, then the best on another day, then the best at another venue or time
  opts.sort((a, b) => b.score - a.score);
  const out = [];
  for (const o of opts) {
    if (out.length >= 3) break;
    if (out.some((x) => x.date === o.date && x.venue.id === o.venue.id && Math.abs(toMin(x.start) - toMin(o.start)) < 90)) continue;
    if (out.length === 1 && o.date === out[0].date && opts.some((x) => x.date !== out[0].date)) continue;
    out.push(o);
  }
  // for the best option: everyone's week side by side, and how it compares with the other venues at that time
  let cal = null, middle = null;
  const best = out[0];
  if (best) {
    const people = [me, ...best.partners.map((p) => members.find((m) => m.id === p.id))];
    const week = Array.from({ length: 7 }, (_, i) => { const d = new Date(now); d.setDate(d.getDate() + i); return ymd(d); });
    cal = { ...calendar(people, week.includes(best.date) ? week : [...week.slice(1), best.date]), pick: { date: best.date, from: toMin(best.start), to: toMin(best.end) } };
    const date = dateOf(best.date);
    middle = venues.venues.map((v0) => forSport(v0, sport)).filter(Boolean).map((v) => {
      const longest = Math.max(0, ...people.filter((x) => x.area).map((x) => travelMin(x.area, v)));
      return { id: v.id, name: v.name, longest, free: demoVenues.freeCourts(v, date, toMin(best.start), best.minutes).length > 0 };
    }).sort((a, b) => a.longest - b.longest);
  }
  return { options: out, looked, open, openBy, dates: dates.length, want, calendar: cal, middle, sport, venues: venues.venues.filter((v) => forSport(v, sport)).length };
}

// ---- the words: proposal and invites ------------------------------------------------------------------------
const numbersOk = (text, allowed) => (String(text).match(/\d+(?:[.:]\d+)?/g) || []).every((n) => allowed.has(n) || (+n <= 4 && /^\d$/.test(n)));
function allowedNumbers(o) {
  const nums = [o.date, o.start, o.end, String(o.minutes), String(o.court), String(o.players), String(o.each), String(o.total), String(o.price), String(o.venue.km)];
  const set = new Set();
  for (const p of o.partners) for (const w of p.why) nums.push(...(w.match(/\d+(?= min away)/g) || []));
  for (const t of o.travel || []) nums.push(String(t.min), String(t.km));
  if (o.longest != null) nums.push(String(o.longest));
  for (const s of nums) for (const n of String(s).match(/\d+(?:[.:]\d+)?/g) || []) set.add(n);
  for (const t of [o.start, o.end]) { const [h, m] = t.split(":"); set.add(String(+h)); set.add(h); set.add(m); set.add(String(+h > 12 ? +h - 12 : +h)); }
  const [y, mo, d] = o.date.split("-"); set.add(y); set.add(String(+mo)); set.add(mo); set.add(String(+d)); set.add(d);
  return set;
}
function templateWords(o, you) {
  const names = o.partners.map((p) => p.name.split(" ")[0]);
  const trip = (o.travel || []).length > 1 ? ` It is in the middle: ${o.travel.map((t) => `${t.id === "you" ? "you" : first(t.name)} ${t.min} min`).join(", ")}.` : "";
  return {
    message: `${o.format === "doubles" ? "Doubles" : "Singles"} on ${o.day} ${o.start}–${o.end} at ${o.venue.name}, court ${o.court}, with ${names.join(", ")}: NT$${o.each} each.${trip}${you.limit && o.format === "doubles" ? " Doubles keeps the load on your knee down." : ""}`,
    invites: Object.fromEntries(o.partners.map((p) => [p.id, `Hi ${p.name.split(" ")[0]}! ${o.format === "doubles" ? "Doubles" : "Singles"} on ${o.day} ${o.start}–${o.end} at ${o.venue.name}? Court ${o.court} is held, NT$${o.each} each. In?`])),
  };
}
async function words(o, you, challenge = false) {
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], d = dateOf(o.date), when = `${o.day} ${d.getDate()} ${MON[d.getMonth()]}`;
  const mine = (o.travel || []).find((t) => t.id === "you"), trip = (id) => (o.travel || []).find((t) => t.id === id);
  const sys = `You write for Serve, a sports club app whose agent books courts and invites friends.
The game: ${o.sport || "badminton"} ${o.format}, ${when}, ${o.start}-${o.end}, ${o.venue.name}, court ${o.court}, NT$${o.each} each, pay at the venue.${mine ? ` The player's trip there: ${mine.min} min. The venue was picked so the longest trip (${o.longest} min) is as short as possible.` : ""}
Partners: ${o.partners.map((p) => `${p.id} (${p.name}): ${p.why.join("; ") || "free at that time"}${trip(p.id) ? `; their own trip: ${trip(p.id).min} min` : ""}`).join(" | ")}
${you.limit ? `The player has a health limit (${you.limit}); doubles is easier on it.` : ""}
Return JSON only: {"message": string, "invites": {"<partner id>": string}}
- "message": to the player, 1-2 short sentences, like a friend: what you found and why these partners (by first name)${mine && o.travel.length > 1 ? ", and that the venue is in the middle" : ""}.
- "invites": one casual text message per partner, written AS THE PLAYER ("I" is the player, "you" is the partner), using their first name: the day, time, venue and the cost each. If you mention travel, give the partner their own trip time. Mention why you thought of them if it is a nice reason.
- Write the day as "${when}" and times like ${o.start}. Do not write the year, "2 players" or "for ${o.minutes} minutes".
- The only numbers allowed: the day, the times, court ${o.court}, NT$${o.each}, the trip minutes. English only. No emojis.
${challenge ? "- This is a challenge match: each invite is a friendly challenge to a game." : ""}`;
  try {
    const r = await chat([{ role: "system", content: sys }, { role: "user", content: "Write it." }], { maxTokens: 420, temperature: 0.5 });
    const j = JSON.parse((r.text.match(/\{[\s\S]*\}/) || ["null"])[0]);
    const allowed = allowedNumbers(o), t = templateWords(o, you);
    const okMsg = typeof j.message === "string" && numbersOk(j.message, allowed);
    const okInv = o.partners.map((p) => typeof j.invites?.[p.id] === "string" && numbersOk(j.invites[p.id], allowed));
    const message = okMsg ? j.message : t.message;
    const invites = Object.fromEntries(o.partners.map((p, k) => [p.id, okInv[k] ? j.invites[p.id] : t.invites[p.id]]));
    return { message, invites, by: okMsg ? "model" : "rules", checks: { n: 1 + okInv.length, ok: [okMsg, ...okInv].filter(Boolean).length }, timing: r.timing };
  } catch { return { ...templateWords(o, you), by: "rules", checks: null }; }
}

// onStep, when given, hears each step the moment it is done ({type: "step"}) and what is being worked on next
// ({type: "working"}), so the app can show the agent's trail live.
export async function plan({ text = "", you = {}, onStep } = {}) {
  const t0 = Date.now(), now = new Date(), club = readClub(), venues = readVenues();
  const me = { level: you.level || "B", limit: you.limit || null };
  const steps = [];
  const tell = (s) => { steps.push(s); onStep?.({ type: "step", ...s }); };
  const work = (step) => onStep?.({ type: "working", step });
  work("Reading your request on Muse Glimmer");
  const it = await readIntent(String(text).slice(0, 300), club.members, now);
  tell({ step: "Read your request", tool: "read_request", detail: it.by === "model" ? "Muse Glimmer turned it into a search" : "read with simple rules (the model was unavailable)", intent: it.intent, seconds: it.timing?.seconds });
  tell({ step: "Opened the map", tool: "open_map", detail: `${venues.venues.length} venues and the home areas of ${club.members.length} members (areas only, never addresses)`,
    map: { you: club.you?.area, people: club.members.filter((m) => m.area).map((m) => ({ id: m.id, name: m.name, x: m.area.x, y: m.area.y })), venues: venues.venues.map((v) => ({ id: v.id, name: v.name, x: v.x, y: v.y, courts: v.courts })) } });
  work(`Checking courts at ${venues.venues.length} venues`);
  const s = search({ intent: it.intent, you: me, club, venues, now });
  tell({ step: "Checked the courts", tool: "search_courts", detail: `${s.sport !== "badminton" ? `${s.sport}: ` : ""}${s.looked} court times at ${s.venues} venue${s.venues === 1 ? "" : "s"} over ${s.dates} day${s.dates > 1 ? "s" : ""}; ${s.open} had a free court`, free: s.openBy });
  tell({ step: "Found people who are free", tool: "find_players", detail: s.options.length ? `${s.want === "any" ? "best format" : s.want} with club members who are free then, matched on level, format and how far they live` : "nobody fits those times yet" });
  if (hooks.rerank) {
    work("Asking their agents how likely a yes is"); await hooks.rerank(s, { intent: it.intent, tell }).catch(() => {});
    // (the week side by side is for the people now in the best option)
    const b = s.options[0];
    if (b && s.calendar && b.partners.some((p) => !s.calendar.people.some((x) => x.id === p.id))) s.calendar = { ...calendar([{ id: "you", name: "You", free: club.you?.free }, ...b.partners.map((p) => club.members.find((m) => m.id === p.id))], s.calendar.days.map((d) => d.date)), pick: s.calendar.pick };
  }
  const b0 = s.options[0];
  if (b0 && s.calendar) {
    const names = s.calendar.people.map((x) => (x.id === "you" ? "you" : first(x.name)));
    const both = s.calendar.days.filter((d) => d.all.length).map((d) => `${d.day} ${d.all.map(span).join(", ")}`);
    tell({ step: "Lined up everyone's calendar", tool: "calendar", detail: `${names.length > 2 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names.join(" and ")} are all free ${both.slice(0, 2).join("; ")}${both.length > 2 ? ` (+${both.length - 2} more)` : ""}; picked ${b0.day} ${b0.start}–${b0.end}`.replace(/^you/, "You"), calendar: s.calendar });
  }
  if (b0 && s.middle) {
    const open = s.middle.filter((v) => v.free), rank = open.findIndex((v) => v.id === b0.venue.id);
    tell({ step: "Picked the venue in the middle", tool: "travel", detail: `${b0.venue.name}: ${b0.travel.map((t) => `${t.id === "you" ? "you" : first(t.name)} ${t.min} min`).join(", ")}; ${rank === 0 ? (open.length > 1 ? `the fairest of the ${open.length} venues with a court free then (longest trip ${b0.longest} min)` : "the only venue with a court free then") : `longest trip ${b0.longest} min`}`,
      pick: { venue: b0.venue.id, travel: b0.travel, venues: s.middle } });
  }
  if (me.limit) tell({ step: "Kept your health limit", tool: "health_limit", detail: s.want === "singles" ? `${me.limit}: you asked for singles, so your agent keeps the game short` : `${me.limit}: doubles first, less court to cover` });
  let w = null;
  if (s.options[0]) {
    work(it.intent.challenge ? "Writing the challenge on Muse Glimmer" : "Writing the invites on Muse Glimmer");
    w = await words(s.options[0], me, it.intent.challenge);
    tell({ step: it.intent.challenge ? "Wrote the challenge" : "Wrote the invites", tool: "write_invites", detail: w.by === "model" ? "Muse Glimmer wrote the message and one invite per player" : w.checks === null ? "checked template text: Muse Glimmer's draft could not be read" : "checked template text: Muse Glimmer's draft did not pass", seconds: w.timing?.seconds });
    if (w.checks) tell({ step: "Checked every time and price", tool: "verify", detail: w.checks.ok === w.checks.n ? `all ${w.checks.n} lines match the booking` : `${w.checks.ok} of ${w.checks.n} lines passed; the rest were replaced with checked text` });
  }
  const fromTalk = /^[\w.:-]{1,80}$/.test(you.from || "") ? [you.from] : null;
  return { intent: it.intent, calendar: s.calendar, middle: s.middle, options: fromTalk ? s.options.map((o) => ({ ...o, from: fromTalk })) : s.options, message: w?.message ?? "No court and partners fit that yet. Try another day or a wider time.", invites: w?.invites ?? {}, steps, demo: venues.note, seconds: +((Date.now() - t0) / 1000).toFixed(1) };
}

// ---- booking --------------------------------------------------------------------------------------------------
let db = readJSON(FILE, { bookings: [] });
const save = () => { writeJSON(FILE, db); };

// the games a member is already in on a date (one they turned down is not theirs). Their agent counts these as their
// calendar (a2a.js breaks), and a booking checks them again: a yes holds nothing, so two talks at once could otherwise
// put one member into two games.
// (and, unless holds is false, the times their agent is holding for another talk: `except` is the talk asking, whose
// own hold does not count)
// (a booking made for one of a club's Messenger players names them in option.by, CLUB_PLAYERS=1: they play in it too)
export function playing(id, date, except = null, { holds = true } = {}) {
  const games = db.bookings.filter((b) => !b.cancelled && b.option?.date === date && [...(b.option.partners || []).map((p) => p.id), ...b.invites.map((i) => i.id), ...(b.option.by ? [b.option.by] : [])].includes(id)
    && !b.invites.some((i) => i.id === id && i.answered && !i.accept))
    .map((b) => ({ from: toMin(b.option.start), to: toMin(b.option.start) + (b.option.minutes || 90), ref: b.id }));
  // (a hold that became a game booked on a peer gateway, commit below, is a game: it counts even without holds)
  const kept = leases().filter((l) => l.member === id && l.date === date && l.ref !== except && (holds || l.booked)).map((l) => ({ from: l.from, to: l.to, ref: l.ref, held: !l.booked }));
  return [...games, ...kept];
}

// Holds. Once a talk agrees a time, each member's agent holds it while the player decides: a lease (Gray and Cheriton,
// 1989) that lapses by itself after A2A_LEASE_MS (30 minutes), is released when the player says no, and gives way to
// the booking. A second talk meanwhile hears "already playing then" and takes another time, instead of agreeing a time
// that fails when it is booked. A hold is not renewed by asking again, and a member's agent holds at most six times for
// other talks at once (a week of games), so holds can't keep a member's week. A2A_LEASE=off turns holds off.
export const leasesOn = () => process.env.A2A_LEASE !== "off";
const LEASE_MS = () => +(process.env.A2A_LEASE_MS || 30 * 60000), MAX_LEASES = 6;
const leases = () => { const now = Date.now(); return (db.leases ||= []).filter((l) => l.until > now); };
export function lease(member, ref, date, start, minutes) {
  const from = toMin(start), to = from + minutes;
  if (playing(member, date, ref).some((g) => g.from < to && from < g.to)) return { error: "already playing then" };
  const live = leases();
  if (live.filter((l) => l.member === member && l.ref !== ref && !l.booked).length >= MAX_LEASES) return { error: "holding too many times already" };
  const prior = live.find((x) => x.member === member && x.ref === ref);
  const l = { member, ref, date, from, to, until: prior ? prior.until : Date.now() + LEASE_MS(), ...(prior?.booked ? { booked: true } : {}) };
  db.leases = [...live.filter((x) => !(x.member === member && x.ref === ref)), l]; save();
  return { ok: true, until: l.until };
}
// A hold that became a game booked on another gateway (a peer asked its talk's members to confirm, a2a.js holdAnswer):
// it stays until the game is over, as the member's game, and no longer counts toward the holds a member may have.
export function commit(member, ref) {
  const l = leases().find((x) => x.member === member && x.ref === ref);
  if (!l) return { error: "no hold for that talk" };
  l.booked = true; l.until = Math.max(l.until, dateOf(l.date).getTime() + l.to * 60000); save();
  return { ok: true, until: l.until };
}
export function release(ref, member = null) {
  const before = (db.leases ||= []).length;
  db.leases = db.leases.filter((l) => !(l.ref === ref && (!member || l.member === member)));
  if (db.leases.length !== before) save();
}
export const held = (member) => leases().filter((l) => l.member === member);
export const clearLeases = () => { db.leases = []; save(); };

export async function book({ option, invites = {}, you = {} } = {}) {
  // (option may move to another free court below)
  const venues = readVenues(), v = venues.venues.find((x) => x.id === option?.venue?.id);
  // the same game booked again (an outbox sent again after a crash, a second tap) is the booking already made. A game
  // the agents agreed is known by its talk: another talk for the same court and time is another game (which the
  // partners check below catches), not this one again
  const same = (x) => (x.option?.talk || option?.talk ? x.option?.talk === option?.talk : x.option?.id === option?.id && x.option?.date === option?.date && x.option?.court === option?.court);
  const again = db.bookings.find((x) => !x.cancelled && same(x));
  if (again) return { ...status(again.id), again: true };
  // validated when it is booked, not only in the talk: a partner booked into another game, or held for another talk, at
  // an overlapping time since their agent said yes is not booked twice (the player is told and asks again). The talks
  // this game came from don't count: its own (hold), and the one a game planned from a talk names (from: the Arena's
  // "find our opponents" after a talk agreed the partner).
  const mine = new Set([option?.hold, ...(option?.from || [])].filter(Boolean));
  const from = toMin(option?.start || "00:00"), to = from + (option?.minutes || 90);
  const clash = (option?.partners || []).map((p) => [p, playing(p.id, option.date).find((g) => !mine.has(g.ref) && g.from < to && from < g.to)]).find(([, g]) => g);
  // (a game that can't be booked lets its holds go)
  if (clash) { mine.forEach((r) => release(r)); return { error: `${clash[0].name.split(" ")[0]} ${clash[1].held ? "is held for another game" : "was booked into another game"} at that time meanwhile. Ask again for a fresh option.`, clash: clash[0].id }; }
  // partners whose agents are on a peer gateway confirm there, all or nothing, just before the game is booked here (and
  // a refusal lets this talk's holds go): hooks.confirm, a2a.js
  const remote = async () => { const r = hooks.confirm ? await hooks.confirm(option) : null; if (r?.error) mine.forEach((x) => release(x)); return r?.error ? r : null; };
  // a public court from find_places: free and first come, so there is nothing to hold; the game is set for everyone
  if (!v && option?.venue?.public) {
    const no = await remote(); if (no) return no;
    const t0 = Date.now(), b = { id: `PUB-${t0.toString(36).toUpperCase()}`, created: t0, option, need: 0, invites: [], spare: [], public: true, cancelled: false,
      log: [{ at: t0, text: `${option.venue.name} is a public court: free and first come, so there is nothing to reserve. Everyone's agent agreed ${option.day} ${option.start}.` }] };
    db.bookings = [b, ...db.bookings].slice(0, 200); mine.forEach((r) => release(r)); save();
    return status(b.id);
  }
  if (!v) return { error: "unknown venue" };
  const date = dateOf(option.date);
  let hold = demoVenues.hold(v, date, toMin(option.start), option.minutes, option.court);
  // the agreed court was taken (another game booked it since): another free court at the same venue and time will do
  if (!hold.ok) { const k = demoVenues.freeCourts(v, date, toMin(option.start), option.minutes)[0]; if (k) { option = { ...option, court: k }; hold = demoVenues.hold(v, date, toMin(option.start), option.minutes, k); } }
  if (!hold.ok) { mine.forEach((r) => release(r)); return { error: "That court was just taken. Ask again for a fresh option." }; }
  const no = await remote(); if (no) return no;
  const t0 = Date.now(), club = readClub();
  // demo members answer by themselves a few seconds later; whether they accept is fixed per booking. Someone the
  // player asked for by name, and who is free then, says yes more often.
  const asked = new Set(option.asked || []);
  // (with the matchmaker loaded, a demo or simulated member answers by its own agent's chance of a yes, seeded by the
  // booking, so the demo is the same every time: match/rank.js inviteAnswer; without it, the fixed draw below)
  const answerOf = (id) => hooks.inviteAnswer?.(id, option, hold.ref) ?? ((option.agreed || []).includes(id) || hash(`${hold.ref}|${id}|yes`) > (asked.has(id) ? 0.1 : 0.22));
  const invite = (id, k, text) => { const m = club.members.find((x) => x.id === id); return { id, name: m?.name ?? option.partners.find((p) => p.id === id)?.name ?? id, text, asked: asked.has(id), sentAt: t0 + k * 400, answerAt: t0 + 2500 + Math.floor(hash(`${hold.ref}${id}`) * 5000) + k * 600, accept: answerOf(id) }; };
  const b = { id: hold.ref, created: t0, option, need: option.players - 1, invites: option.partners.map((p, k) => invite(p.id, k, invites[p.id] || `Hi ${p.name.split(" ")[0]}, ${option.format} on ${option.day} ${option.start} at ${option.venue.name}? NT$${option.each} each.`)),
    spare: option.spare || [], log: [{ at: t0, text: `Held court ${option.court} at ${option.venue.name}, ${option.day} ${option.start}–${option.end} (ref ${hold.ref}). Pay at the venue.` }], cancelled: false };
  // the booking is now everyone's commitment: the talk's holds give way to it
  db.bookings = [b, ...db.bookings].slice(0, 200); mine.forEach((r) => release(r)); save();
  return status(b.id);
}

// what has happened so far: answers that are due, and a replacement for anyone who declined
export function status(id) {
  const b = db.bookings.find((x) => x.id === id);
  if (!b) return { error: "no such booking" };
  const now = Date.now(), club = readClub();
  for (const inv of b.invites) {
    if (!inv.answered && now >= inv.answerAt) {
      inv.answered = true;
      hooks.invite?.(inv.id, b.option, inv.accept);
      b.log.push({ at: inv.answerAt, text: inv.accept ? `${inv.name.split(" ")[0]} is in.` : `${inv.name.split(" ")[0]} can't make it${inv.asked ? ` on ${b.option.day} ${b.option.start}` : ""}.` });
      // someone the player asked for by name is not swapped for someone else: the player picks another time instead
      if (!inv.accept && inv.asked) b.log.push({ at: inv.answerAt, text: `Not inviting anyone else in ${inv.name.split(" ")[0]}'s place: you asked for them. Pick another time that suits you both.` });
      if (!inv.accept && !inv.asked) {
        const used = new Set(b.invites.map((x) => x.id)), next = b.spare.find((x) => !used.has(x));
        if (next) {
          const m = club.members.find((x) => x.id === next);
          b.invites.push({ id: next, name: m.name, text: `Hi ${m.name.split(" ")[0]}! A spot opened up: ${b.option.format} on ${b.option.day} ${b.option.start}–${b.option.end} at ${b.option.venue.name}, NT$${b.option.each} each. In?`,
            sentAt: now, answerAt: now + 3000, accept: hooks.inviteAnswer?.(next, b.option, `${b.id}|${next}`) ?? true, replaces: inv.id });
          b.log.push({ at: now, text: `Invited ${m.name.split(" ")[0]} instead.` });
        }
      }
    }
  }
  const yes = b.invites.filter((x) => x.answered && x.accept).length;
  const pending = b.invites.filter((x) => !x.answered).length;
  b.state = b.cancelled ? "cancelled" : yes >= b.need ? "confirmed" : pending ? "waiting" : "short";
  // (a public court's game was agreed by everyone's agent in the talk: there is no invite round to count)
  if (b.state === "confirmed" && !b.public && !b.log.some((l) => l.text.startsWith("Game on"))) b.log.push({ at: now, text: `Game on: ${yes + 1} players confirmed.` });
  save();
  return { ...b, yes, pending, invites: b.invites.map(({ accept, ...x }) => ({ ...x, status: x.answered ? (accept ? "in" : "out") : "sent" })) };
}

// the games on the book (for the Autopilot: what this week already has)
export const bookings = () => db.bookings.filter((b) => !b.cancelled).map((b) => status(b.id));

// for the best-match agent and agent-to-agent scheduling (match.js)
export const helpers = { windows, travelMin, kmBetween, ymd, hm, toMin, dateOf, readVenues, DAYS };

export function cancel(id) {
  const b = db.bookings.find((x) => x.id === id);
  if (!b) return { error: "no such booking" };
  b.cancelled = true; b.log.push({ at: Date.now(), text: b.public ? "Cancelled. Nothing was reserved at the public court; everyone is told." : "Cancelled. The court is released and everyone is told." }); save();
  hooks.cancel?.(b.option); // (each partner's own record of it: match/records.js)
  Promise.resolve(hooks.unbook?.(b.option)).catch(() => {}); // (partners on a peer gateway are told there)
  return status(id);
}

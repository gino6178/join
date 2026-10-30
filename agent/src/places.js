// Courts near you: public courts, school fields, sports centres and parks where a game can happen, in any ball sport.
//   1. OpenStreetMap (Overpass) finds them around a point, with what the map knows: the sport, hoops or nets, lights,
//      a roof, the surface, who may use it, opening hours. Results are kept for a week (data/places_cache.json).
//   2. With GOOGLE_MAPS_API_KEY set, each place's Google Maps rating and reviews are read (Places API, in English).
//   3. For an outdoor place, the forecast for that hour (Open-Meteo): rain, temperature, wind.
//   4. Muse Glimmer judges each place at once (four in parallel): can you play your sport there at that time? Every
//      reason must cite a review, a map tag or the forecast; a quoted review must be in that review word for word, and
//      every number must be in the facts. A reason that fails the check is dropped; with none left, rules judge it.
// Google's terms: reviews are shown with their author and a link to the place on Google Maps, never on another map,
// and they are not stored.
import * as guard from "./guard.js";
import fs from "node:fs";
import path from "node:path";
import { chatJSON } from "./llm.js";
import { VERDICT, NAMES } from "./schema.js";
import { okNums, allowedIn } from "./a2a.js";
import { readJSON, writeJSON } from "./jsonfile.js";
import * as flags from "./loop/flags.js";

const FILE = path.resolve(process.env.PLACES_FILE || "data/places_cache.json");
const KEY = process.env.GOOGLE_MAPS_API_KEY || "";
const UA = "Serve/0.1 (sports club app; hackathon demo)";
const OVERPASS = (process.env.OVERPASS_URLS || "https://z.overpass-api.de/api/interpreter,https://lz4.overpass-api.de/api/interpreter,https://overpass-api.de/api/interpreter,https://maps.mail.ru/osm/tools/overpass/api/interpreter").split(",");
let cache = readJSON(FILE, {});
const save = () => { writeJSON(FILE, cache); };
export const ready = () => ({ map: true, google: !!KEY, googleLeft: googleLeft(), weather: true });

// the OpenStreetMap sport tag for each sport, and whether a park is somewhere it is often played
const OSM = { badminton: "badminton", tennis: "tennis", pickleball: "pickleball", "table tennis": "table_tennis", basketball: "basketball", volleyball: "volleyball|beachvolleyball", soccer: "soccer", football: "soccer" };
const PARK_OK = new Set(["soccer", "football", "badminton", "volleyball"]);
const GOOGLE_Q = { badminton: "badminton court", tennis: "tennis court", pickleball: "pickleball court", "table tennis": "table tennis", basketball: "basketball court", volleyball: "volleyball court", soccer: "football field", football: "football field" };

const rad = (d) => (d * Math.PI) / 180;
export const meters = (a, b) => { const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2; return Math.round(12742e3 * Math.asin(Math.sqrt(h))); };
const bearing = (a, b) => ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"][Math.round(((Math.atan2(Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat)), Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon))) * 180) / Math.PI + 360) % 360 / 45) % 8];

// the public Overpass servers are often busy: every server in turn, in rounds, waiting longer each round
async function overpass(q, rounds = 4) {
  let last;
  for (let k = 0; k < rounds; k++) {
    for (const url of OVERPASS) {
      try {
        const r = await fetch(url, { method: "POST", headers: { "user-agent": UA, "content-type": "application/x-www-form-urlencoded" }, body: "data=" + encodeURIComponent(q), signal: AbortSignal.timeout(70000) });
        if (r.ok) return await r.json();
        last = new Error(`OpenStreetMap is busy (${r.status})`);
      } catch (e) { last = new Error(`OpenStreetMap is not reachable (${e.cause?.code || e.message})`); }
    }
    await new Promise((ok) => setTimeout(ok, 2000 * 2 ** k));
  }
  throw last;
}

// 1: the map
async function fromMap({ lat, lon, sport, radius }) {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)},${radius},${sport}`;
  if (cache[key] && Date.now() - cache[key].at < 30 * 864e5) return cache[key].places;
  const tag = OSM[sport] || sport.replace(/\s+/g, "_");
  const q = `[out:json][timeout:25];(nwr[leisure=pitch][sport~"(^|;)(${tag}|multi)(;|$)"](around:${radius},${lat},${lon});nwr[leisure=sports_centre][sport~"(^|;)(${tag}|multi)(;|$)"](around:${radius},${lat},${lon});nwr[leisure=sports_hall][sport~"(^|;)(${tag})(;|$)"](around:${radius},${lat},${lon});nwr[leisure=park][name](around:${radius},${lat},${lon}););out center tags 150;`;
  const j = await overpass(q);
  const parks = [], pitches = [];
  for (const e of j.elements || []) {
    const t = e.tags || {}, at = e.center ? { lat: e.center.lat, lon: e.center.lon } : { lat: e.lat, lon: e.lon };
    if (at.lat == null) continue;
    const p = { id: `osm:${e.type}/${e.id}`, ...at, name: t.name || t["name:en"] || null, nameEn: t["name:en"] || null, kind: t.leisure, tags: Object.fromEntries(Object.entries(t).filter(([k]) => /^(sport|surface|lit|covered|indoor|access|fee|opening_hours|hoops|operator|building|capacity|wheelchair)$/.test(k))) };
    (t.leisure === "park" ? parks : pitches).push(p);
  }
  // an unnamed court takes the name of the park it is in (or next to)
  for (const p of pitches) if (!p.name) {
    const park = parks.map((k) => ({ k, d: meters(p, k) })).sort((a, b) => a.d - b.d)[0];
    p.name = `${sport[0].toUpperCase() + sport.slice(1)} court${park && park.d < 450 ? `, ${park.k.nameEn || park.k.name}` : ""}`;
    p.inPark = park && park.d < 450 ? park.k.nameEn || park.k.name : null;
  }
  const places = [...pitches, ...(PARK_OK.has(sport) ? parks.map((p) => ({ ...p, kind: "park" })) : [])];
  cache[key] = { at: Date.now(), places }; save();
  return places;
}

// 2: Google Maps ratings and, where the key's plan includes them, reviews (only with a key; nothing is stored). A
// Maps demo key has a small daily quota and returns no reviews: one call per search, and a daily cap
// (GOOGLE_DAILY_LIMIT, default 90) after which the search carries on from the map and the forecast alone.
const memo = new Map(), LIMIT = +(process.env.GOOGLE_DAILY_LIMIT || 90), used = { day: "", n: 0 };
export const googleLeft = () => { const d = new Date().toISOString().slice(0, 10); if (used.day !== d) Object.assign(used, { day: d, n: 0 }); return KEY ? LIMIT - used.n : 0; };
async function google(body) {
  const k = JSON.stringify(body);
  if (memo.has(k) && Date.now() - memo.get(k).at < 36e5) return memo.get(k).v;
  if (googleLeft() <= 0) throw new Error("today's Google Maps quota is used up");
  used.n++;
  const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST", signal: AbortSignal.timeout(20000),
    headers: { "content-type": "application/json", "X-Goog-Api-Key": KEY, "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.reviews,places.googleMapsUri,places.regularOpeningHours.weekdayDescriptions,places.types" },
    body: k,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Google Places ${r.status}: ${j.error?.message || ""}`.trim());
  memo.set(k, { at: Date.now(), v: j.places || [] });
  return j.places || [];
}
const fromGoogle = (g) => ({ placeId: g.id, gname: g.displayName?.text, address: g.formattedAddress, rating: g.rating ?? null, ratings: g.userRatingCount ?? 0, url: g.googleMapsUri, hours: g.regularOpeningHours?.weekdayDescriptions || null,
  reviews: (g.reviews || []).slice(0, 5).map((r, i) => ({ n: i + 1, stars: r.rating, when: r.relativePublishTimeDescription, text: String(r.text?.text || r.originalText?.text || "").replace(/\s+/g, " ").slice(0, 600), author: r.authorAttribution?.displayName || "A Google user", authorUrl: r.authorAttribution?.uri || null })).filter((r) => r.text) });

// 3: the weather at that hour
export async function forecast(lat, lon, date, start) {
  try {
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}&hourly=precipitation_probability,precipitation,temperature_2m,wind_speed_10m&timezone=auto&start_date=${date}&end_date=${date}`, { signal: AbortSignal.timeout(15000) });
    const j = await r.json(), i = (j.hourly?.time || []).findIndex((t) => t.endsWith(`T${start.slice(0, 2)}:00`));
    if (i < 0) return null;
    return { rain: j.hourly.precipitation_probability[i], mm: j.hourly.precipitation[i], temp: Math.round(j.hourly.temperature_2m[i]), wind: Math.round(j.hourly.wind_speed_10m[i]) };
  } catch { return null; }
}

const outdoor = (p) => !(p.kind === "sports_centre" || p.kind === "sports_hall" || p.tags.indoor === "yes" || p.tags.covered === "yes" || p.tags.building);
const tagWords = (p) => p.id.startsWith("google:") ? ["listed on Google Maps for this sport; OpenStreetMap has no tags for it"] : [p.tags.sport && `sport: ${p.tags.sport.replace(/;/g, ", ")}`, p.tags.hoops && `hoops: ${p.tags.hoops}`, p.tags.lit && `lights: ${p.tags.lit}`, p.tags.covered && `covered: ${p.tags.covered}`, p.tags.indoor && `indoor: ${p.tags.indoor}`,
  p.tags.surface && `surface: ${p.tags.surface}`, p.tags.access && `access: ${p.tags.access}`, p.tags.fee && `fee: ${p.tags.fee}`, p.tags.opening_hours && `opening hours: ${p.tags.opening_hours}`, `type: ${p.kind === "pitch" ? "outdoor court or field" : p.kind.replace("_", " ")}`].filter(Boolean);

// rules: the judgement when the model is down or its reasons fail the check (and the code-made reasons the Autopilot
// reads, whoever judged)
export function rules(p, sport, start, w) {
  const ev = +start.slice(0, 2) >= 18, rs = [];
  let s = 0;
  if (p.tags.sport && new RegExp(OSM[sport] || sport).test(p.tags.sport)) { s += 2; rs.push({ text: `The map marks it for ${sport}.`, cite: "map" }); }
  else if (p.kind === "park") { rs.push({ text: `A park: there may be open space for ${sport}, but no marked court.`, cite: "map" }); }
  if (/^(private|no|customers)$/.test(p.tags.access || "")) { s -= 3; rs.push({ text: `The map says access is ${p.tags.access}.`, cite: "map" }); }
  if (ev && outdoor(p)) { if (p.tags.lit === "yes") { s += 1; rs.push({ text: "It has lights for an evening game.", cite: "map" }); } else if (p.tags.lit === "no") { s -= 2; rs.push({ text: "No lights: too dark for an evening game.", cite: "map" }); } }
  if (w && outdoor(p)) { if (w.rain >= 60) { s -= 2; rs.push({ text: `Rain is ${w.rain}% likely at ${start}.`, cite: "weather" }); } else if (w.rain <= 20) { s += 1; rs.push({ text: w.rain < 5 ? `No rain in the forecast at ${start}.` : `Rain only ${w.rain}% likely at ${start}.`, cite: "weather" }); } }
  if (w && !outdoor(p) && w.rain >= 60) { s += 1; rs.push({ text: `Indoors, so the ${w.rain}% chance of rain does not matter.`, cite: "weather" }); }
  if (p.rating != null) { if (p.rating >= 4.2) s += 1; if (p.rating < 3.5) s -= 1; rs.push({ text: `Rated ${p.rating} from ${p.ratings} Google reviews.`, cite: "google" }); }
  const all = (p.reviews || []).map((r) => r.text).join(" ");
  if (/\b(broken|cracked|no nets?|no hoops?|locked|closed for|under construction|demolish)/i.test(all)) { s -= 2; rs.push({ text: "Reviews mention something broken, missing or closed.", cite: "google" }); }
  if (/\b(crowded|always busy|hard to get a court|queue|wait for a court)/i.test(all)) { s -= 1; rs.push({ text: "Reviews say it gets crowded.", cite: "google" }); }
  return { verdict: s >= 3 ? "good" : s >= 1 ? "maybe" : "no", reasons: rs.slice(0, 4), by: "rules" };
}

const norm = (t) => String(t).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
export async function judge(p, sport, date, start, w) {
  // Prompt Guard 2 first: a review written to instruct a model is left out, and the judge never reads it
  if (p.reviews?.length) { const g = await guard.injected(p.reviews.map((r) => r.text)); const kept = p.reviews.filter((r, k) => !g[k].injected); if (kept.length < p.reviews.length) p = { ...p, reviews: kept, reviewsLeftOut: p.reviews.length - kept.length }; }
  const facts = [`Place: ${p.name}${p.count > 1 ? ` (${p.count} courts)` : ""}${p.address ? `, ${p.address}` : ""}, ${p.dist} m away.`, `Wanted: ${sport} on ${date} at ${start}.`, `Map tags: ${tagWords(p).join("; ")}.`,
    p.rating != null ? `Google rating: ${p.rating} from ${p.ratings} reviews.` : "No Google reviews read.", w && outdoor(p) ? `Forecast at ${start}: rain ${w.rain}%, ${w.temp} C, wind ${w.wind} km/h.` : w ? "Indoors, so the weather does not matter." : "No forecast.",
    ...(p.reviews || []).map((r) => `Review ${r.n} (${r.stars} stars, ${r.when}): ${r.text}`)].join("\n");
  try {
    const { value: j } = await chatJSON([
      { role: "system", content: `You check whether a group can play ${sport} at a place, for a sports club app. From the facts only, answer JSON: {"verdict":"good"|"maybe"|"no","reasons":[{"text":"one short sentence","cite":"review N"|"map"|"weather","quote":"words copied exactly from that review, or empty"}]}. Two to four reasons. Look for: is there a court, hoops or nets for ${sport}; lights for an evening game; a roof if rain is likely; crowds; broken or closed; fees or members only. Say "maybe" when the facts do not say. Never write he or she.` },
      { role: "user", content: facts },
    ], VERDICT, { maxTokens: 320, temperature: 0.1, site: "places.judge" });
    if (!j) throw new Error("no verdict in the format");
    const ok = (j.reasons || []).filter((r) => {
      const m = /^review (\d)$/i.exec(r.cite || ""), rev = m && p.reviews?.find((x) => x.n === +m[1]);
      if (m && !rev) return false;
      if (r.quote && !(rev && norm(rev.text).includes(norm(r.quote)))) return false; // the quote is in that review, word for word
      if (r.cite === "weather" && !(w && outdoor(p))) return false;
      // no links, addresses or handles: a review is anyone's text, and a reason is shown to the player
      if (/https?:|www\.|\S+@\S+|\.(com|net|org|io|me|ly)\b/i.test(`${r.text} ${r.quote || ""}`)) return false;
      return okNums(r.text, allowedIn(facts)) && !/\b(he|she|him|his|her)\b/i.test(r.text);
    }).map((r) => ({ text: String(r.text).slice(0, 200), cite: /^review/i.test(r.cite) ? "google" : r.cite, quote: r.quote ? String(r.quote).slice(0, 160) : null, review: /^review (\d)$/i.exec(r.cite || "")?.[1] ? +/^review (\d)$/i.exec(r.cite)[1] : null }));
    if (["good", "maybe", "no"].includes(j.verdict) && ok.length) return { verdict: j.verdict, reasons: ok.slice(0, 4), by: "model", dropped: (j.reasons || []).length - ok.length };
  } catch { /* rules */ }
  return rules(p, sport, start, w);
}

// names on the map are in the local language: one Muse Glimmer call gives every one in English (the map's own
// English name wins when it has one; the original is kept beside it)
async function english(list) {
  const todo = list.filter((p) => /[^\x00-\x7F]/.test(p.name));
  if (!todo.length) return;
  try {
    const { value: j } = await chatJSON([
      { role: "system", content: 'Give each place name in English: translate the meaning of generic words (park, court, riverside, school) and romanize proper names (Hanyu Pinyin for Chinese). Keep it short. Return JSON only: {"1": "...", "2": "..."}' },
      { role: "user", content: todo.map((p, i) => `${i + 1}: ${p.name}`).join("\n") },
    ], NAMES, { maxTokens: 300, temperature: 0, site: "places.english" });
    if (!j) return;
    todo.forEach((p, i) => { const e = String(j[i + 1] || "").trim(); if (e && !/[^\x00-\x7F]/.test(e)) { p.local = p.name; p.name = e.slice(0, 80); } });
  } catch { /* names stay as mapped */ }
}

// near a point, for a sport, at a time: the places, nearest first, each judged
export async function search({ lat, lon, sport = "basketball", date, start = "19:00", radius = flags.get("places.radius"), limit = 6, onStep = () => {} } = {}) {
  const tell = (s) => onStep({ type: "step", ...s }), work = (step) => onStep({ type: "working", step });
  const here = { lat: +lat, lon: +lon };
  if (!isFinite(here.lat) || !isFinite(here.lon)) throw new Error("No location to search around.");
  date ||= new Date().toISOString().slice(0, 10);
  work("Searching OpenStreetMap for courts and parks");
  let mapped;
  try { mapped = await fromMap({ ...here, sport, radius }); } catch (e) {
    if (!KEY) throw new Error(`${e.message}. Try again in a minute.`);
    mapped = []; tell({ step: "OpenStreetMap is busy", tool: "map", detail: `${e.message}: using Google Maps only` });
  }
  let places = mapped.map((p) => ({ ...p, dist: meters(here, p), dir: bearing(here, p) })).sort((a, b) => a.dist - b.dist);
  // the same court mapped twice (a node and an area): keep one; several courts in one park: one place, "2 courts"
  places = places.filter((p, i) => !places.slice(0, i).some((q) => meters(p, q) < 40 && q.kind === p.kind));
  const byName = {};
  places = places.filter((p) => { const q = byName[p.name]; if (q && meters(p, q) < 600) { q.count = (q.count || 1) + 1; return false; } byName[p.name] = p; return true; });
  tell({ step: "Found places on the map", tool: "map", detail: `${places.filter((p) => p.kind !== "park").length} ${sport} courts or centres and ${places.filter((p) => p.kind === "park").length} parks within ${(radius / 1000).toFixed(1)} km (OpenStreetMap)` });
  const courts = places.filter((p) => p.kind !== "park"), parks = places.filter((p) => p.kind === "park");
  let pick = [...courts.slice(0, limit - Math.min(2, parks.length)), ...parks.slice(0, 2)].slice(0, limit);
  if (KEY && googleLeft() > 0) {
    work("Reading Google Maps");
    let found = 0, err = null;
    // one call: Google's list for the sport nearby, each matched to a place on the map within 150 m; the ones the map
    // does not have are added
    const near = await google({ textQuery: GOOGLE_Q[sport] || `${sport} court`, languageCode: "en", maxResultCount: 20, locationBias: { circle: { center: { latitude: here.lat, longitude: here.lon }, radius: Math.min(radius, 5000) } } }).catch((e) => { err = e.message; return []; });
    for (const p of pick) {
      const g = near.find((x) => x.location && meters(p, { lat: x.location.latitude, lon: x.location.longitude }) < 150);
      if (g) { Object.assign(p, fromGoogle(g)); found++; }
    }
    for (const g of near) {
      if (!g.location || pick.length >= limit + 2) continue;
      const at = { lat: g.location.latitude, lon: g.location.longitude };
      if (pick.some((p) => meters(p, at) < 150) || meters(here, at) > radius) continue;
      pick.push({ id: `google:${g.id}`, ...at, name: g.displayName?.text, kind: "pitch", tags: {}, dist: meters(here, at), dir: bearing(here, at), ...fromGoogle(g) }); found++;
    }
    const nrev = pick.reduce((a, p) => a + (p.reviews?.length || 0), 0);
    tell({ step: err ? "Google Maps did not answer" : "Read Google Maps", tool: "reviews", detail: err || `${found} places with a Google rating${nrev ? `, ${nrev} reviews read` : " (this key's plan has no review text)"}` });
  } else tell({ step: "No Google Maps", tool: "reviews", detail: KEY ? "today's Google Maps quota is used up: judging from the map tags and the weather" : "GOOGLE_MAPS_API_KEY is not set on the server: judging from the map tags and the weather" });
  await english(pick);
  work("Checking the weather at that hour");
  const w = await forecast(here.lat, here.lon, date, start);
  if (w) tell({ step: "Checked the forecast", tool: "weather", detail: `${date} ${start}: rain ${w.rain}%, ${w.temp} °C, wind ${w.wind} km/h (Open-Meteo)` });
  work(`Muse Glimmer is judging ${pick.length} places`);
  const judged = await Promise.all(pick.map(async (p) => ({ ...p, outdoor: outdoor(p), weather: outdoor(p) ? w : null, ...(await judge(p, sport, date, start, w)) })));
  const order = { good: 0, maybe: 1, no: 2 };
  judged.sort((a, b) => order[a.verdict] - order[b.verdict] || a.dist - b.dist);
  const g = judged.filter((p) => p.verdict === "good").length;
  tell({ step: "Judged every place", tool: "verify", detail: `${g} good, ${judged.filter((p) => p.verdict === "maybe").length} maybe, ${judged.filter((p) => p.verdict === "no").length} no · ${judged.filter((p) => p.by === "model").length} by Muse Glimmer, every reason checked against its source` });
  // reviews go back with their author and the link to Google Maps; only the ones a reason quotes
  return { here, sport, date, start, weather: w, google: judged.some((p) => p.rating != null), reviews: judged.some((p) => p.reviews?.length), places: judged.map((p) => ({ ...p, reviews: (p.reviews || []).filter((r) => p.reasons.some((x) => x.review === r.n)).map(({ n, stars, when, text, author, authorUrl }) => ({ n, stars, when, text, author, authorUrl })) })) };
}

// the map under a route, drawn by the app in its own style: roads, rivers and parks from OpenStreetMap, no labels
// (so the map reads the same in any language). Kept for 30 days per area.
export async function basemap({ s, w, n, e }) {
  const r3 = (v) => (+v).toFixed(3), key = `base:${r3(s)},${r3(w)},${r3(n)},${r3(e)}`;
  if (cache[key] && Date.now() - cache[key].at < 30 * 864e5) return cache[key].map;
  if (!(n > s && e > w) || (n - s) * (e - w) > 0.02) throw new Error("That area is too large to draw.");
  const bb = `${s},${w},${n},${e}`;
  const j = await overpass(`[out:json][timeout:40];(way[highway~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street|cycleway|footway|path|pedestrian)$"](${bb});way[waterway~"^(river|stream|canal)$"](${bb});way[natural=water](${bb});way[leisure~"^(park|pitch|garden)$"](${bb});way[landuse~"^(grass|recreation_ground)$"](${bb}););out geom;`);
  const thin = (g) => { const o = []; for (const p of g) { const q = o.at(-1); if (!q || Math.abs(q[0] - p.lat) + Math.abs(q[1] - p.lon) > 0.00004) o.push([+p.lat.toFixed(5), +p.lon.toFixed(5)]); } return o; };
  const map = { roads: [], water: [], rivers: [], green: [] };
  for (const x of j.elements || []) {
    if (!x.geometry) continue;
    const t = x.tags || {}, g = thin(x.geometry);
    if (g.length < 2) continue;
    if (t.highway) map.roads.push({ k: /motorway|trunk|primary|secondary/.test(t.highway) ? "major" : /cycleway|footway|path|pedestrian/.test(t.highway) ? "path" : "minor", g });
    else if (t.waterway) map.rivers.push({ k: t.waterway, g });
    else if (t.natural === "water") map.water.push(g);
    else map.green.push(g);
  }
  cache[key] = { at: Date.now(), map }; save();
  return map;
}

// a place name -> a point (OpenStreetMap's geocoder, one request at a time)
let lastGeo = 0;
export async function where(q) {
  const wait = Math.max(0, lastGeo + 1100 - Date.now()); if (wait) await new Promise((ok) => setTimeout(ok, wait)); lastGeo = Date.now();
  const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(String(q).slice(0, 120))}`, { headers: { "user-agent": UA, "accept-language": "en" }, signal: AbortSignal.timeout(15000) });
  const j = await r.json(); if (!j[0]) throw new Error(`No place called "${q}" found`);
  return { lat: +j[0].lat, lon: +j[0].lon, name: j[0].display_name.split(",").slice(0, 2).join(",") };
}

// the demo town sits on a real map (venues.json map.geo): a point in the town (x east, y south, in map units) and back
export const toGeo = (geo, a) => ({ lat: geo.lat - (a.y * geo.unitKm) / 110.57, lon: geo.lon + (a.x * geo.unitKm) / (111.32 * Math.cos(rad(geo.lat))) });
// the public places a search returned, by the id their court gets in a talk ("osm:way/1" is "osm-way-1"), so a
// member's agent can work out its own trip to one instead of taking the proposer's figure
const seen = new Map();
const talkId = (id) => String(id).replace(/[^\w]+/g, "-");
export const note = (p) => { if (p?.lat != null && p?.lon != null) seen.set(talkId(p.id), { lat: +p.lat, lon: +p.lon }); };
export function placeById(id) {
  if (seen.has(id)) return seen.get(id);
  for (const e of Object.values(cache)) for (const p of e?.places || []) if (talkId(p.id) === id && p.lat != null) return { lat: +p.lat, lon: +p.lon };
  return null;
}
export const toTown = (geo, p) => ({ x: +(((p.lon - geo.lon) * 111.32 * Math.cos(rad(geo.lat))) / geo.unitKm).toFixed(2), y: +(((geo.lat - p.lat) * 110.57) / geo.unitKm).toFixed(2) });

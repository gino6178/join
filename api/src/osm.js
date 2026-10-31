// Real places, from OpenStreetMap (ODbL, © OpenStreetMap contributors).
//   geocode("大安森林公園")      a place someone typed -> { lat, lon, label } (Nominatim), for people whose browser
//                                won't share its location (plain http) and for agents
//   places("badminton", {lat, lon}, km)   real places for an activity near a point (Overpass): name, location, a link
// These places aren't on Join: Join can suggest them, but can't haggle or take payment there. Both answers are cached
// (an hour), and both services are asked politely: an identifying User-Agent, one request at a time.
import { store, stateFile } from "./store.js";

const UA = "Join (PayPal AI Hackathon demo; https://github.com/gino6178/join)";
const cache = new Map();
const cached = async (key, ms, fn) => { const c = cache.get(key); if (c && Date.now() - c.at < ms) return c.v; const v = await fn(); cache.set(key, { v, at: Date.now() }); return v; };
let queue = Promise.resolve(), slowQueue = Promise.resolve();
const polite = (fn) => (queue = queue.then(fn, fn)); // (one at a time, for Nominatim)
const slow = (fn) => (slowQueue = slowQueue.then(fn, fn)); // (Overpass, on its own line, so its long waits never hold up the quick searches)

export function address(lat, lon) {
  return cached(`r:${(+lat).toFixed(4)}:${(+lon).toFixed(4)}`, 30 * 864e5, () => polite(async () => {
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&accept-language=zh-TW,en&lat=${lat}&lon=${lon}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10e3) });
      const j = r.ok ? await r.json() : null;
      await new Promise((ok) => setTimeout(ok, 1100));
      const a = j?.address || {};
      return [a.city || a.county, a.suburb || a.city_district, a.road, a.house_number].filter(Boolean).join(" ") || j?.display_name || null;
    } catch { return null; }
  }));
}
// text that was mangled on its way here (a shell that didn't send UTF-8): replacement characters, or Latin-1 runs
export const garbled = (t) => /\uFFFD/.test(t) || /[\u0080-\u00ff]{3,}/.test(t);
export function geocode(q) {
  const text = String(q || "").trim().slice(0, 120);
  if (!text) return Promise.resolve(null);
  return cached(`g:${text}`, 24 * 3600e3, () => polite(async () => {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&accept-language=zh-TW,en&q=${encodeURIComponent(text)}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10e3) });
    const j = r.ok ? await r.json() : [];
    return j[0] ? { lat: +(+j[0].lat).toFixed(5), lon: +(+j[0].lon).toFixed(5), label: j[0].display_name.split(",").slice(0, 3).join(",").trim() } : null;
  }));
}

// what an activity is called in OpenStreetMap's tags
const TAGS = {
  badminton: ['nwr["sport"~"badminton"]'], tennis: ['nwr["sport"="tennis"]["leisure"~"pitch|sports_centre"]'], pickleball: ['nwr["sport"~"pickleball"]'],
  basketball: ['nwr["sport"="basketball"]["leisure"~"pitch|sports_centre"]'], volleyball: ['nwr["sport"~"volleyball"]'], "table tennis": ['nwr["sport"~"table_tennis"]'],
  karaoke: ['nwr["amenity"="karaoke_box"]', 'nwr["name"~"KTV|卡拉OK|好樂迪|錢櫃"]["amenity"]'], "escape room": ['nwr["leisure"="escape_game"]', 'nwr["name"~"密室"]'],
  "board games": ['nwr["shop"="games"]', 'nwr["name"~"桌遊|board game",i]'], bbq: ['nwr["amenity"="bbq"]', 'nwr["cuisine"~"barbecue|bbq"]', 'nwr["name"~"燒肉|烤肉"]["amenity"="restaurant"]'],
  "hot pot": ['nwr["cuisine"~"hot_pot|hotpot|shabu"]', 'nwr["name"~"火鍋|鍋"]["amenity"="restaurant"]'],
};
// Overpass's public servers are often busy (502, 429): try each, backing off, before giving up
const SERVERS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter"];
async function overpass(q) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const url = SERVERS[attempt % SERVERS.length];
    try {
      const res = await fetch(url, { method: "POST", body: `data=${encodeURIComponent(q)}`, headers: { "User-Agent": UA, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(25e3) });
      if (res.ok) return await res.json();
    } catch {}
    await new Promise((ok) => setTimeout(ok, 500 * 2 ** Math.floor(attempt / SERVERS.length)));
  }
  return { elements: [] };
}
// Places for an activity near a point: first a keyword search in the area (Nominatim: quick, "KTV", "桌遊", "羽球"...),
// then OpenStreetMap's tags (Overpass, slower and often busy) in the background to add more. Kept on disk for a day,
// per activity and area (two decimals of a degree), so a second ask is instant.
const WORDS = { badminton: ["羽球", "badminton"], tennis: ["網球場", "tennis court"], pickleball: ["匹克球", "pickleball"], basketball: ["籃球場", "basketball court"],
  volleyball: ["排球場", "volleyball"], "table tennis": ["桌球", "table tennis"], karaoke: ["KTV", "karaoke"], "escape room": ["密室逃脫", "密室", "escape room"],
  "board games": ["桌遊", "board game"], bbq: ["燒肉", "烤肉", "bbq"], "hot pot": ["火鍋", "鍋物", "hot pot"] };
const disk = store(stateFile("osm-places"), { areas: {} });
const inflight = new Map();
async function byWords(activity, lat, lon, km) {
  const d = km / 111, out = [];
  for (const w of WORDS[activity] || []) {
    const j = await polite(async () => {
      try {
        const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=15&bounded=1&viewbox=${lon - d},${lat + d},${lon + d},${lat - d}&accept-language=zh-TW,en&q=${encodeURIComponent(w)}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10e3) });
        await new Promise((ok) => setTimeout(ok, 1100)); // (Nominatim asks for one request a second)
        return r.ok ? r.json() : [];
      } catch { return []; }
    });
    for (const e of j) out.push({ id: `osm:${e.osm_type}/${e.osm_id}`, name: e.name || e.display_name.split(",")[0], lat: +e.lat, lon: +e.lon, address: e.display_name.split(",").slice(1, 3).join(",").trim(), hours: null, phone: null, website: null, url: `https://www.openstreetmap.org/${e.osm_type}/${e.osm_id}` });
  }
  return out;
}
// a name has to say it is the place, not a shop that sells for it or a school club about it
const NAMES = { badminton: /羽球|羽毛球|badminton/i, tennis: /網球|tennis/i, pickleball: /匹克球|pickleball/i, basketball: /籃球|basketball/i, volleyball: /排球|volleyball/i,
  "table tennis": /桌球|乒乓|table tennis/i, karaoke: /KTV|卡拉|karaoke|好樂迪|錢櫃|星聚點/i, "escape room": /密室|escape/i, "board games": /桌遊|board ?game/i,
  bbq: /燒肉|烤肉|燒烤|bbq|barbecue/i, "hot pot": /鍋|shabu|hot ?pot/i };
const NOT = /專賣|用品|器材|商店|百貨|社$|協會|學會|公司$/;
const fitsName = (activity) => (p) => !p.name || (NAMES[activity]?.test(p.name) ?? true) && !NOT.test(p.name);
const merge = (...lists) => { const seen = new Set(); return lists.flat().filter((p) => p.name && Number.isFinite(p.lat) && !seen.has(p.name) && seen.add(p.name)); };
export async function places(activity, at, km = 5, { waitMs = 15e3 } = {}) {
  if (!WORDS[activity] || !at) return [];
  const lat = +(+at.lat).toFixed(2), lon = +(+at.lon).toFixed(2), key = `${activity}:${lat}:${lon}:${km}`, hit = disk.data.areas[key];
  if (hit && Date.now() - hit.at < 24 * 3600e3) return hit.places;
  if (!inflight.has(key)) inflight.set(key, (async () => {
    const quick = (await byWords(activity, lat, lon, km)).filter(fitsName(activity));
    disk.data.areas[key] = { at: Date.now(), places: merge(quick) }; disk.save();
    overpassPlaces(activity, { lat, lon }, km).then((all) => all.filter(fitsName(activity))).then((more) => { disk.data.areas[key] = { at: Date.now(), places: merge(disk.data.areas[key].places, more) }; disk.save(); }).catch(() => {});
    return disk.data.areas[key].places;
  })().finally(() => inflight.delete(key)));
  return Promise.race([inflight.get(key), new Promise((ok) => setTimeout(() => ok(hit?.places || []), waitMs))]);
}
function overpassPlaces(activity, at, km = 5) {
  const tags = TAGS[activity];
  if (!tags || !at) return Promise.resolve([]);
  const lat = +at.lat.toFixed(2), lon = +at.lon.toFixed(2), r = Math.round(km * 1000);
  return cached(`p:${activity}:${lat}:${lon}:${r}`, 3600e3, () => slow(async () => {
    const q = `[out:json][timeout:20];(${tags.map((t) => `${t}(around:${r},${lat},${lon});`).join("")});out center 40;`;
    try {
      const j = await overpass(q), seen = new Set();
      return (j.elements || []).map((e) => ({ id: `osm:${e.type}/${e.id}`, name: e.tags?.name || e.tags?.["name:en"], lat: e.lat ?? e.center?.lat, lon: e.lon ?? e.center?.lon, address: [e.tags?.["addr:street"], e.tags?.["addr:housenumber"]].filter(Boolean).join(" "), hours: e.tags?.opening_hours || null, phone: e.tags?.phone || e.tags?.["contact:phone"] || null, website: e.tags?.website || e.tags?.["contact:website"] || null, url: `https://www.openstreetmap.org/${e.type}/${e.id}` }))
        .filter((p) => p.name && Number.isFinite(p.lat) && !seen.has(p.name) && seen.add(p.name));
    } catch { return []; }
  }));
}

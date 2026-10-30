// The reading agent's three paper sources, each called the way its public API documentation asks:
//   OpenAlex           GET api.openalex.org/works?search=…&filter=from_publication_date:…,has_abstract:true
//                      (the abstract comes as an inverted index of word positions)
//   arXiv              GET export.arxiv.org/api/query?search_query=all:…&sortBy=submittedDate (an Atom feed; one
//                      request every three seconds at most)
//   Semantic Scholar   GET api.semanticscholar.org/graph/v1/paper/search?query=…&year=…- (no key: a shared rate limit,
//                      so a 429 is a source skipped this time, not an error)
// Politeness: one request at a time per service, spaced (OpenAlex 1 s, arXiv 3.1 s, Semantic Scholar 1.2 s), a plain
// User-Agent with no contact details, a 20-second time limit, and every answer cached for a day (data/feed_cache.json,
// FEED_CACHE_FILE) so a run asks again only for what it has not seen today. Only a query from query.js may leave:
// each client checks it with clean() before it builds a URL. Every request is logged (requests()) for the run log and
// for the tests that check what went out.
import fs from "node:fs";
import path from "node:path";
import { deps } from "./deps.js";
import { clean } from "./query.js";

const UA = "Serve-club-feed/1.0 (the reading agent of a sports club app)";
const GAP = { "api.openalex.org": 1000, "export.arxiv.org": 3100, "api.semanticscholar.org": 1200 };
const cacheFile = () => path.resolve(process.env.FEED_CACHE_FILE || path.join(path.dirname(path.resolve(process.env.FEED_FILE || "data/feed.json")), "feed_cache.json"));
const TTL = () => +(process.env.FEED_CACHE_HOURS ?? 24) * 36e5;
const polite = () => +(process.env.FEED_POLITE ?? 1); // 0 in the unit tests

// ---- the request log ----
let log = [];
export const requests = () => log.slice();
export const clearRequests = () => { log = []; };

// ---- the cache ----
let cache = null, cacheAt = null;
function cached() {
  if (cache && cacheAt === cacheFile()) return cache;
  try { cache = JSON.parse(fs.readFileSync(cacheFile(), "utf8")); } catch { cache = {}; }
  cacheAt = cacheFile();
  return cache;
}
function keep(url, items) {
  const c = cached(), now = deps.now();
  c[url] = { at: now, items };
  const keys = Object.keys(c).sort((a, b) => c[a].at - c[b].at);
  for (const k of keys.slice(0, Math.max(0, keys.length - 300))) delete c[k];
  try { fs.mkdirSync(path.dirname(cacheFile()), { recursive: true }); fs.writeFileSync(`${cacheFile()}.tmp`, JSON.stringify(c)); fs.renameSync(`${cacheFile()}.tmp`, cacheFile()); } catch { /* kept in memory */ }
}
export function clearCache() { cache = {}; cacheAt = cacheFile(); fs.rmSync(cacheFile(), { force: true }); }

// ---- one request at a time per host, spaced ----
const lanes = new Map();
function lane(host) {
  const prev = lanes.get(host) || Promise.resolve(), gap = (GAP[host] || 1000) * polite();
  let release;
  const mine = new Promise((r) => { release = r; });
  lanes.set(host, prev.then(() => mine));
  return prev.then(() => () => setTimeout(release, gap));
}
async function get(url, parse) {
  const hit = cached()[url], host = new URL(url).host;
  if (hit && deps.now() - hit.at < TTL()) { log.push({ host, url, cached: true }); return hit.items; }
  const done = await lane(host);
  try {
    log.push({ host, url, cached: false });
    const ask = () => deps.fetch(url, { headers: { "user-agent": UA, accept: url.includes("arxiv") ? "application/atom+xml" : "application/json" }, signal: AbortSignal.timeout(20000) });
    let r = await ask();
    // rate-limited (Semantic Scholar without a key often is): once more after a pause, then skipped
    if (r.status === 429) { await new Promise((ok) => setTimeout(ok, 4000 * polite())); log.push({ host, url, cached: false, retry: true }); r = await ask(); }
    if (r.status === 429) return { skipped: "rate-limited" };
    if (!r.ok) throw new Error(`${host} answered ${r.status}`);
    const items = parse(await r.text());
    keep(url, items);
    return items;
  } finally { done(); }
}

// ---- one shape for every source ----
const ws = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const doiOf = (s) => { const m = String(s || "").match(/10\.\d{4,9}\/\S+/); return m ? m[0].replace(/[.,;)]+$/, "").toLowerCase() : null; };
const arxivOf = (s) => { const m = String(s || "").match(/(\d{4}\.\d{4,5})(v\d+)?/); return m ? m[1] : null; };
function paper(x) {
  const doi = doiOf(x.doi), arxiv = arxivOf(x.arxiv);
  return {
    source: x.source, title: ws(x.title).replace(/\.$/, ""), authors: (x.authors || []).map(ws).filter(Boolean).slice(0, 8), more: Math.max(0, (x.authors || []).length - 8),
    year: Number.isInteger(x.year) ? x.year : x.date ? +String(x.date).slice(0, 4) : null, date: x.date ? String(x.date).slice(0, 10) : null, venue: ws(x.venue) || null,
    doi, arxiv, link: doi ? `https://doi.org/${doi}` : arxiv ? `https://arxiv.org/abs/${arxiv}` : null, abstract: ws(x.abstract),
  };
}

// OpenAlex keeps an abstract as { word: [positions] }: put each word back at its places
export function fromInverted(index) {
  if (!index || typeof index !== "object") return "";
  const at = [];
  for (const [word, places] of Object.entries(index)) for (const p of Array.isArray(places) ? places : []) if (Number.isInteger(p) && p >= 0 && p < 20000) at[p] = word;
  return at.filter((w) => w != null).join(" ");
}
export async function openAlex(query, { since, n = 8 } = {}) {
  const q = clean(query);
  const filter = [`from_publication_date:${since}`, "has_abstract:true", "language:en"].join(",");
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(q)}&filter=${encodeURIComponent(filter)}&per_page=${n}&select=${["id", "doi", "display_name", "publication_year", "publication_date", "authorships", "primary_location", "abstract_inverted_index"].join(",")}`;
  return get(url, (body) => (JSON.parse(body).results || []).map((w) => paper({
    source: "OpenAlex", title: w.display_name, doi: w.doi, year: w.publication_year, date: w.publication_date, venue: w.primary_location?.source?.display_name,
    authors: (w.authorships || []).map((a) => a.author?.display_name), abstract: fromInverted(w.abstract_inverted_index),
  })));
}

// the few XML entities an Atom feed uses
const unxml = (s) => String(s ?? "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const one = (xml, tag) => { const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`)); return m ? unxml(m[1]) : null; };
const STOP = new Set(["and", "of", "the", "in", "for"]);
export async function arxiv(query, { since, n = 5 } = {}) {
  const q = clean(query), terms = q.split(" ").filter((w) => !STOP.has(w)).map((w) => `all:${w}`).join(" AND ");
  const url = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(terms)}&start=0&max_results=${n}&sortBy=submittedDate&sortOrder=descending`;
  return get(url, (xml) => (xml.match(/<entry>[\s\S]*?<\/entry>/g) || []).map((e) => paper({
    source: "arXiv", title: one(e, "title"), arxiv: one(e, "id"), doi: one(e, "arxiv:doi"), date: one(e, "published"), venue: one(e, "arxiv:journal_ref") || "arXiv",
    authors: (e.match(/<author>[\s\S]*?<\/author>/g) || []).map((a) => one(a, "name")), abstract: one(e, "summary"),
  })).filter((p) => !since || !p.date || p.date >= since));
}

export async function semanticScholar(query, { since, n = 6 } = {}) {
  const q = clean(query), year = String(since || "").slice(0, 4);
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(q)}&limit=${n}&fields=${["title", "abstract", "year", "venue", "publicationDate", "authors", "externalIds"].join(",")}${year ? `&year=${year}-` : ""}`;
  return get(url, (body) => (JSON.parse(body).data || []).filter((p) => p.abstract).map((p) => paper({
    source: "Semantic Scholar", title: p.title, doi: p.externalIds?.DOI, arxiv: p.externalIds?.ArXiv, year: p.year, date: p.publicationDate, venue: p.venue,
    authors: (p.authors || []).map((a) => a.name), abstract: p.abstract,
  })));
}

// one query to all three; a source that fails or is rate-limited is noted and the others still count
export async function search(query, { since } = {}) {
  const names = ["OpenAlex", "arXiv", "Semantic Scholar"];
  const got = await Promise.allSettled([openAlex(query, { since }), arxiv(query, { since }), semanticScholar(query, { since })]);
  const papers = [], errors = [];
  got.forEach((r, i) => {
    if (r.status === "rejected") errors.push(`${names[i]}: ${String(r.reason?.message || r.reason).slice(0, 120)}`);
    else if (r.value?.skipped) errors.push(`${names[i]}: ${r.value.skipped}`);
    else papers.push(...r.value);
  });
  return { papers, errors };
}

// the same paper from two sources, or found twice: one key per DOI, arXiv id or title
export const titleKey = (t) => String(t || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim().slice(0, 140);
export const keysOf = (p) => [doiOf(p.doi) && `doi:${doiOf(p.doi)}`, arxivOf(p.arxiv) && `arxiv:${arxivOf(p.arxiv)}`, titleKey(p.title) && `title:${titleKey(p.title)}`].filter(Boolean);
export function dedupe(papers, seen = {}) {
  const out = [], have = new Set(Object.keys(seen));
  let dropped = 0;
  // a version with a DOI first, so it is the one kept
  for (const p of [...papers].sort((a, b) => (b.doi ? 1 : 0) - (a.doi ? 1 : 0))) {
    const ks = keysOf(p);
    if (!ks.length || ks.some((k) => have.has(k))) { dropped++; continue; }
    ks.forEach((k) => have.add(k));
    out.push(p);
  }
  return { papers: out, dropped };
}

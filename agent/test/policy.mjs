// The never-list in code (docs/never.md says what each rule protects): a unified diff in, a verdict out.
//   node test/policy.mjs <diff file>     (or - for stdin)
// Exit 0: allowed. Exit 1: refused, and also when the file can't be read or isn't a diff (it fails closed). stdout is
// JSON: { allowed, refused: [{ rule, file, line, why, text }], warnings: [...], files, added, removed }.
//
// A diff is refused when it touches a never-list path (the agents' messages, auth, the guard, booking and the player's
// yes, body and health rules, the loop itself, the tests, this file, dependencies, secrets, deploy scripts), or when a
// line it adds or removes:
//   - names an outbound host that is not on the fixed list (HOSTS), or adds a network call whose address isn't a listed
//     literal;
//   - adds a shell, eval or Function, or a secret-like string;
//   - adds non-English text to the app's strings, or a paper's name to the app UI;
//   - adds analytics or tracking, a dependency, a medical diagnosis or dosage, or a new data file;
//   - touches /forget, booking or the approval, a flag's value or a safety setting.
// The pattern scan follows CodeShield (LlamaFirewall, arXiv 2505.03574): its language-agnostic regex rules (secrets)
// and its JavaScript rules (child-process, eval-usage, non-literal-require, unencrypted-fetch, post-message-origin,
// unchecked-origin-onmessage, dangerously-set-inner-html, Buffer and random-number rules), here as patterns on the lines
// a diff adds. CodeShield's own package runs those JavaScript rules through semgrep, a dependency this does not add.
//
// import { policy } from "./policy.mjs" gives the same verdict as an object (loop/review.js uses it).
import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.env.POLICY_ROOT || path.join(HERE, "../.."));

// ---- the fixed list of hosts the app may reach, or link to ----
export const HOSTS = {
  // this machine (and a placeholder base for parsing a request's path)
  local: ["127.0.0.1", "localhost", "::1", "0.0.0.0", "x"],
  // what the gateway calls: Messenger, its file servers, maps, weather, place search, Meta's API
  server: ["graph.facebook.com", "*.fbcdn.net", "*.fbsbx.com", "overpass-api.de", "z.overpass-api.de", "lz4.overpass-api.de", "maps.mail.ru",
    "places.googleapis.com", "api.open-meteo.com", "nominatim.openstreetmap.org", "api.meta.ai"],
  // what the web app loads (its fonts)
  web: ["fonts.googleapis.com", "fonts.gstatic.com"],
  // links the player opens from the web app (sharing, the map), and the placeholder shown for a tunnel address
  links: ["wa.me", "www.threads.net", "www.facebook.com", "www.instagram.com", "www.openstreetmap.org", "your-tunnel"],
};
const ALL_HOSTS = Object.values(HOSTS).flat();
export function hostAllowed(h) {
  let x = String(h || "").toLowerCase().replace(/^[^@]*@/, "");
  x = x.startsWith("[") ? x.replace(/^\[([^\]]*)\].*$/, "$1") : (x.match(/:/g) || []).length === 1 ? x.replace(/:.*$/, "") : x; // the port goes
  x = x.replace(/\.$/, "");
  return ALL_HOSTS.some((a) => (a.startsWith("*.") ? x.endsWith(a.slice(1)) && x.length > a.length - 1 : x === a));
}

// ---- paths a diff from the loop may never touch (a maintainer changes them by hand, outside the loop) ----
export const NEVER_PATHS = [
  [/^agent\/src\/schema\.js$/, "the schemas that keep what agents send each other, and what models return, to facts"],
  [/^agent\/src\/a2a[^/]*\.js$/, "agent-to-agent messages: facts only, never a model's prose"],
  [/^agent\/src\/auth\.js$/, "who may use the gateway (the token, origins)"],
  [/^agent\/src\/guard(\.js|_worker\.py)$/, "the guard models"],
  [/^agent\/src\/play\.js$/, "booking: nothing is booked without the player's yes"],
  [/^agent\/src\/ask\.js$/, "the player's yes to a game, and the booking that follows it"],
  [/^agent\/src\/(body\.js|health\.js|health_import\.py)$/, "body and health rules"],
  [/^agent\/src\/files\.js$/, "the hosts a shared file may come from"],
  [/^agent\/src\/loop\//, "the community loop itself: the review, flags and their ranges, gates, consent, thresholds"],
  [/^agent\/data\//, "player data and runtime state"],
  [/^agent\/test\//, "the tests (this policy included)"],
  [/^docs\/never\.md$/, "the never-list"],
  [/(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|requirements[^/]*\.txt|pyproject\.toml|setup\.py|setup\.cfg|pipfile(\.lock)?)$/, "dependencies"],
  [/(^|\/)\.env($|\.)/, "secrets and settings"],
  [/^server\//, "deploy scripts: code a maintainer runs deploys, not the loop"],
  [/(^|\/)\.git(ignore|attributes|modules)$|^\.git\//, "what the repository keeps out of itself (data, secrets)"],
  [/^\.claude\/|(^|\/)(claude|agents)\.md$/, "the coding agents' own settings and instructions"],
];
// paths written from inside agent/ (src/x.js) are read as both agent/src/x.js and web/src/x.js: the stricter wins
const aliases = (p) => (/^(src|test|data)\/|^package(-lock)?\.json$|^\.env/.test(p) ? [p, `agent/${p}`, `web/${p}`] : [p]);
export function neverPath(p) {
  for (const a of aliases(String(p || "").toLowerCase())) for (const [rx, why] of NEVER_PATHS) if (rx.test(a)) return why;
  return null;
}

// ---- parsing ----
// files: [{ path, old, new, created, deleted, binary, symlink, hunks: [{ header, context, lines: [{ kind, text, line }] }] }]
export function parseDiff(text) {
  const files = [], L = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  let f = null, h = null, oldLeft = 0, newLeft = 0, oldNo = 0, newNo = 0;
  const unq = (s) => { s = s.replace(/\t.*$/, "").trim(); if (/^".*"$/.test(s)) s = s.slice(1, -1).replace(/\\(["\\])/g, "$1"); return s; };
  const strip = (s) => (s === "/dev/null" ? null : s.replace(/^[ab]\//, ""));
  const start = (o = null, n = null) => { f = { path: n || o, old: o, new: n, created: false, deleted: false, binary: false, symlink: false, mode: null, hunks: [] }; files.push(f); h = null; };
  for (const raw of L) {
    if (h && (oldLeft > 0 || newLeft > 0)) {
      const k = raw[0];
      if (k === "\\") continue;
      if (k === "+") { h.lines.push({ kind: "+", text: raw.slice(1), line: newNo++ }); newLeft--; continue; }
      if (k === "-") { h.lines.push({ kind: "-", text: raw.slice(1), line: oldNo++ }); oldLeft--; continue; }
      if (k === " " || raw === "") { h.lines.push({ kind: " ", text: raw.slice(1), line: newNo++ }); oldNo++; oldLeft--; newLeft--; continue; }
      h = null; // a line that is not part of the hunk: the hunk was shorter than it said
    }
    let m;
    if ((m = /^diff --git (\S+|"[^"]+") (\S+|"[^"]+")\s*$/.exec(raw))) { start(strip(unq(m[1])), strip(unq(m[2]))); continue; }
    if (raw.startsWith("--- ")) { const o = strip(unq(raw.slice(4))); if (!f || f.hunks.length || f.sawOld) start(o, null); f.old = o; f.sawOld = true; continue; }
    if (raw.startsWith("+++ ") && f) { const n = strip(unq(raw.slice(4))); f.new = n; f.path = n || f.old; continue; }
    if (!f) continue;
    if (raw.startsWith("new file mode")) { f.created = true; f.mode = raw.split(" ").pop(); }
    else if (raw.startsWith("deleted file mode")) f.deleted = true;
    else if (/^(new|old) mode /.test(raw)) f.mode = raw.split(" ").pop();
    else if (raw.startsWith("rename from ") || raw.startsWith("copy from ")) f.old = raw.replace(/^(rename|copy) from /, "");
    else if (raw.startsWith("rename to ") || raw.startsWith("copy to ")) { f.new = raw.replace(/^(rename|copy) to /, ""); f.path = f.new; }
    else if (/^Binary files |^GIT binary patch/.test(raw)) f.binary = true;
    else if ((m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(raw))) {
      oldNo = +m[1]; oldLeft = m[2] == null ? 1 : +m[2]; newNo = +m[3]; newLeft = m[4] == null ? 1 : +m[4];
      h = { header: raw, context: m[5] || "", lines: [] }; f.hunks.push(h);
    }
    if (f && /^120000$/.test(f.mode || "")) f.symlink = true;
  }
  for (const x of files) { x.path = x.path || x.old || ""; delete x.sawOld; }
  return files;
}

// ---- a line of code: comments dropped, regex literals blanked, strings collected ----
// st carries a block comment or a template literal across the lines of a hunk. Returns { code, skel, strings }:
// code keeps strings and drops comments (regex bodies become /R/), skel is code with every string's text replaced by S.
const langOf = (p) => (/\.(m?js|cjs|jsx|tsx?|vue|svelte)$/i.test(p) ? "js" : /\.(py|sh|bash|ya?ml|toml|ps1)$/i.test(p) ? "hash" : /\.(html?|xml|svg)$/i.test(p) ? "html" : /\.css$/i.test(p) ? "css" : /\.json$/i.test(p) ? "json" : "text");
const KEYWORD_BEFORE_REGEX = /(^|[^\w$])(return|typeof|case|in|of|new|delete|void|throw|else|do|yield|await)$/;
export function lex(line, st = {}, lang = "js") {
  let code = "", skel = "", i = 0;
  const strings = [], n = line.length;
  if (lang === "text") return { code: line, skel: line, strings: [line] };
  if (lang === "html") {
    let s = line;
    if (st.block) { const j = s.indexOf("-->"); if (j < 0) return { code: "", skel: "", strings: [] }; s = s.slice(j + 3); st.block = false; }
    s = s.replace(/<!--.*?-->/g, "");
    const j = s.indexOf("<!--"); if (j >= 0) { st.block = true; s = s.slice(0, j); }
    return { code: s, skel: s.replace(/"[^"]*"|'[^']*'/g, '"S"'), strings: [s] };
  }
  const readQuoted = (q) => { let s = ""; i++; while (i < n && line[i] !== q) { if (line[i] === "\\" && i + 1 < n) { s += line[i] + line[i + 1]; i += 2; } else s += line[i++]; } i++; return s; };
  const readTemplate = () => { // from inside a template literal: its text up to ` or ${ (an expression is code)
    let s = "";
    while (i < n) {
      if (line[i] === "\\" && i + 1 < n) { s += line[i] + line[i + 1]; i += 2; continue; }
      if (line[i] === "`") { i++; st.tpl = false; break; }
      if (line[i] === "$" && line[i + 1] === "{") {
        strings.push(s); code += s + "${"; skel += "S${"; s = ""; i += 2;
        let depth = 1; while (i < n && depth) { const c = line[i]; if (c === "{") depth++; else if (c === "}") depth--; if (depth) { code += c; skel += c; } i++; }
        code += "}"; skel += "}"; continue;
      }
      s += line[i++];
    }
    strings.push(s); code += s; skel += "S"; if (!st.tpl) { code += "`"; skel += "`"; }
  };
  // a hunk can start inside a block comment: a line that starts with "*" is read as one
  if (lang === "js" && !st.tpl && !st.block && /^\s*\*(\s|\/|$)/.test(line)) { const j = line.indexOf("*/"); if (j < 0) return { code: "", skel: "", strings: [] }; i = j + 2; }
  if (st.tpl) readTemplate();
  while (i < n) {
    const c = line[i], d = line[i + 1];
    if (st.block) { const j = line.indexOf("*/", i); if (j < 0) { i = n; break; } i = j + 2; st.block = false; continue; }
    if (lang === "hash" && c === "#") break;
    if ((lang === "js" || lang === "css") && c === "/" && d === "*") { st.block = true; i += 2; continue; }
    if (lang === "js" && c === "/" && d === "/") break;
    if (c === '"' || c === "'") { const s = readQuoted(c); strings.push(s); code += c + s + c; skel += c + "S" + c; continue; }
    if (c === "`" && lang === "js") { code += "`"; skel += "`"; i++; st.tpl = true; readTemplate(); continue; }
    if (lang === "js" && c === "/") {
      const before = code.replace(/\s+$/, ""), p = before.slice(-1);
      if (!before || "(,=:[!&|?{};+-*%~^".includes(p) || before.endsWith("=>") || KEYWORD_BEFORE_REGEX.test(before)) {
        let j = i + 1, cls = false, ok = false;
        if (line[j] !== "*" && line[j] !== "/") for (; j < n; j++) { const x = line[j]; if (x === "\\") { j++; continue; } if (x === "[") cls = true; else if (x === "]") cls = false; else if (x === "/" && !cls) { ok = true; break; } }
        if (ok) { j++; while (j < n && /[a-z]/i.test(line[j])) j++; code += "/R/"; skel += "/R/"; i = j; continue; }
      }
    }
    code += c; skel += c; i++;
  }
  return { code, skel, strings };
}

// ---- the rules ----
const isCode = (p) => /\.(m?js|cjs|jsx|tsx?|vue|svelte|py|sh|bash|ps1|bat|cmd|html?|css|json|ya?ml|toml|svg)$/i.test(p);
const isUI = (p) => aliases(p).some((a) => /^web\/(src\/|index\.html$|public\/.*\.html?$)/.test(a));
const isApp = (p) => aliases(p).some((a) => /^(agent|web)\/src\//.test(a) || /^web\/(index\.html$|public\/.*\.html?$)/.test(a));
const isAgent = (p) => aliases(p).some((a) => /^agent\/src\//.test(a));
const isShell = (p) => /\.(sh|bash|ps1|bat|cmd)$/i.test(p);
// the gateway's files whose strings go to the player as they are (Messenger replies), the app UI's other half
const SAYS_TO_PLAYER = /^(agent\/)?src\/(pocket|messenger|server)\.js$/;

const URL_RX = /\b(?:https?|wss?|ftp):\/\/(\[[0-9a-f:.]+\](?::\d+)?|[a-z0-9$_%-][^\s"'`\/?#)\]<>\\,;|]*)/gi;
const PROTO_REL = /["'`(]\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi;
const TLD = "com|net|org|io|ai|app|dev|co|me|ly|gg|xyz|info|biz|us|uk|de|ru|cn|tw|hk|jp|kr|sg";
const BARE_DOMAIN = new RegExp(`["'\`]((?:[a-z0-9-]+\\.)+(?:${TLD}))(?::\\d+)?(?:\\/[^"'\`]*)?["'\`]`, "gi");
const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IP_RX = new RegExp(`(?<![\\d.])(${OCTET}(?:\\.${OCTET}){3})(?![\\d.])`, "g");
// strings that are not words: SVG path data, long numbers
const NOT_WORDS = /(["'`])[MmLlHhVvCcSsQqTtAaZz\d.,\s-]{40,}\1/g;
// a network call: its target is what follows the parenthesis
const NET_JS = /(?<![\w$])(fetch|tracingFetch|fetchFile|fetchBytes|https?\.(?:request|get)|http2\.connect|net\.(?:connect|createConnection)|tls\.connect|new\s+WebSocket|new\s+EventSource|axios(?:\.\w+)?|got(?:\.\w+)?|undici\.\w+|navigator\.sendBeacon|dns\.(?:lookup|resolve\w*))\s*\(/g;
const NET_OTHER = /\bnew\s+XMLHttpRequest\b|\bnet\.Socket\b|\bdgram\b|\brequire\s*\(\s*["'](undici|axios|got|node-fetch|ws)["']\s*\)|\bfrom\s+["'](undici|axios|got|node-fetch|ws|node:net|node:dgram|node:tls|net|dgram|tls)["']/;
const NET_PY = /\b(requests|httpx|urllib\.request|urllib3|aiohttp|socket)\b\s*\.|\bfrom\s+(requests|httpx|urllib|aiohttp|socket)\b|\bimport\s+(requests|httpx|urllib|aiohttp|socket)\b/;

// CodeShield's rules for JavaScript (its semgrep rules, as patterns), and for Python
const CODESHIELD = [
  { id: "child-process", cwe: "CWE-78", level: "refuse", why: "runs a shell or another program", rx: /\bchild_process\b|(?<![\w$.])(exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)\s*\(|\.(execSync|execFile|execFileSync|spawnSync|spawn)\s*\(|\b(cp|child|proc|childProcess|shell)\.exec\s*\(/ },
  { id: "eval-usage", cwe: "CWE-95", level: "refuse", why: "evaluates code built at run time", rx: /(?<![\w$.])eval\s*\(|\bnew\s+Function\s*\(|(?<![\w$.])Function\s*\(|\bset(Timeout|Interval|Immediate)\s*\(\s*["'`]|["'](node:)?vm["']|\bvm\.(run\w*|Script|compileFunction|SourceTextModule)\b|\.constructor\s*\.\s*constructor\b|\[\s*["'`]constructor["'`]\s*\]|\bprocess\.(binding|dlopen)\b|\bWebAssembly\.(instantiate|compile)\w*\b|\beval\s*:\s*true\b/ },
  { id: "non-literal-require", cwe: "CWE-95", level: "refuse", why: "loads a module whose name is computed", rx: /(?<![\w$.])require\s*\(\s*(?!["'][^"'`$]*["']\s*\))|(?<![\w$.])import\s*\(\s*(?!["'][^"'`$]*["']\s*\))/ },
  { id: "unencrypted-fetch", cwe: "CWE-319", level: "refuse", why: "fetches over plain HTTP from another machine", rx: /fetch\(\s*['"`]http:\/\/(?!127\.0\.0\.1|localhost|\[::1\])[^\s'"`]+['"`]/ },
  { id: "post-message-origin", cwe: "CWE-345", level: "refuse", why: "posts a message to any origin", rx: /\.postMessage\s*\([^)]*,\s*["'`]\*["'`]/ },
  { id: "dangerously-set-inner-html", cwe: "CWE-79", level: "refuse", why: "writes markup into the page", rx: /dangerouslySetInnerHTML|\.(inner|outer)HTML\s*\+?=(?!=)|document\.write(ln)?\s*\(|insertAdjacentHTML\s*\(/ },
  { id: "pseudo-random-bytes", cwe: "CWE-338", level: "refuse", why: "pseudoRandomBytes is not random enough for anything secret", rx: /pseudoRandomBytes\s*\(/ },
  { id: "unchecked-origin-onmessage", cwe: "CWE-345", level: "warn", why: "reads window messages: check event.origin", rx: /addEventListener\s*\(\s*["'`]message["'`]|\bonmessage\s*=/ },
  { id: "detect-new-buffer", cwe: "CWE-770", level: "warn", why: "new Buffer() is deprecated (Buffer.from, Buffer.alloc)", rx: /\bnew\s+Buffer\s*\(/ },
  { id: "unsafe-alloc", cwe: "CWE-908", level: "warn", why: "Buffer.allocUnsafe returns memory that is not cleared", rx: /Buffer\.allocUnsafe(Slow)?\s*\(/ },
  { id: "buffer-noassert", cwe: "CWE-119", level: "warn", why: "a Buffer read or write without its bounds check", rx: /\.(read|write)(U?Int(8|16|32)|Float|Double|BigU?Int64)(LE|BE)?\s*\([^)]*,\s*true\s*\)/ },
  { id: "insecure-random", cwe: "CWE-338", level: "warn", why: "Math.random is not for ids or tokens someone could guess", rx: /Math\.random\s*\(/ },
  { id: "weak-hash", cwe: "CWE-328", level: "warn", why: "a weak hash", rx: /createHash\s*\(\s*["'`](md4|md5|sha1)["'`]/i },
  { id: "non-literal-fs-filename", cwe: "CWE-22", level: "warn", why: "a file path from a variable (check it can't leave its folder)", rx: /\bfs\.(read|write|append|unlink|rm|open|createReadStream|createWriteStream|copyFile|rename)\w*\s*\(\s*(?!["'`])/ },
  { id: "non-literal-regexp", cwe: "CWE-1333", level: "warn", why: "a regular expression built from a variable", rx: /new\s+RegExp\s*\(\s*(?!["'`\/])/ },
  { id: "possible-timing-attacks", cwe: "CWE-208", level: "warn", why: "a secret compared with === (use crypto.timingSafeEqual)", rx: /\b\w*(password|secret|token|apikey|api_key|hmac|signature)\w*\s*[!=]==?\s*[\w"'`]/i },
  { id: "mustache-escape", cwe: "CWE-79", level: "warn", why: "unescaped template output", rx: /\{\{\{[^}]*\}\}\}/ },
];
const CODESHIELD_PY = [
  { id: "py-shell", cwe: "CWE-78", level: "refuse", why: "runs a shell or another program", rx: /\bsubprocess\b|\bos\.(system|popen|exec\w*|spawn\w*)\s*\(|\bshell\s*=\s*True\b|\bpty\.spawn\b/ },
  { id: "py-eval", cwe: "CWE-95", level: "refuse", why: "evaluates code built at run time", rx: /(?<![\w.])(eval|exec|compile)\s*\(|\b__import__\s*\(|\bimportlib\.import_module\s*\(/ },
  { id: "py-deserialize", cwe: "CWE-502", level: "refuse", why: "loads objects that can run code", rx: /\b(pickle|cPickle|marshal|shelve|dill)\.loads?\s*\(|\byaml\.load\s*\((?![^)]*SafeLoader)|\btorch\.load\s*\((?![^)]*weights_only\s*=\s*True)/ },
];
// CodeShield's language-agnostic regex rules (ALL-R-008 to 015), and the other key shapes this project could hold
const SECRETS = [
  ["ALL-R-008", "a Graph API access token", /(?:[^a-zA-Z0-9]|^)(?:AR|ANA|AMA|BUL|CP|DL|EAA|EP|EX|XWF|FRL|HACK|HW|IG|LPT|LIBRA|MLY|MDC|MINT|MO|NPE|OC|ON|OB|PLC|PL|SC|SPK|ST|TI|UN|WAWIT)[a-zA-Z0-9]{90,400}/],
  ["ALL-R-009", "a private key", /-{3,}\s*BEGIN[A-Z ]*PRIVATE KEY/],
  ["ALL-R-010", "a GitHub token", /gh[posur]_[0-9a-zA-Z]{36}/],
  ["ALL-R-011", "a Google API key", /AIza[0-9A-Za-z\-_]{35}/],
  ["ALL-R-012", "a Google OAuth token", /ya29\.[A-Za-z0-9_-]{20,}/],
  ["ALL-R-013", "a Stripe key", /sk_live_[0-9a-zA-Z]{24}/],
  ["ALL-R-014", "a Twilio key", /\bSK[0-9a-fA-F]{32}\b/],
  ["ALL-R-015", "a Heroku key", /HEROKU_API_KEY=[0-9a-f]{40}/],
  ["aws-key", "an AWS access key", /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["slack-token", "a Slack token", /\bxox[abprs]-[0-9A-Za-z-]{10,}/],
  ["sk-key", "an API secret key", /\bsk-(ant-|proj-)?[A-Za-z0-9_-]{20,}/],
  ["hf-token", "a Hugging Face token", /\bhf_[A-Za-z0-9]{30,}/],
  ["jwt", "a JSON Web Token", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["assigned-secret", "a secret written into the code", /\b[\w-]*(secret|token|passw(or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)[\w-]*["']?\s*[:=]\s*["'`][^"'`\s$]{12,}["'`]/i],
];
const entropy = (s) => { const m = new Map(); for (const c of s) m.set(c, (m.get(c) || 0) + 1); let e = 0; for (const v of m.values()) { const p = v / s.length; e -= p * Math.log2(p); } return e; };
function secretIn(raw) {
  for (const [id, what, rx] of SECRETS) { const m = rx.exec(raw); if (m) return { id, what, sample: m[0].replace(/^[^A-Za-z0-9-]/, "") }; }
  for (const m of raw.matchAll(/["'`]([A-Za-z0-9+/=_-]{32,})["'`]/g)) {
    const s = m[1];
    if (/[A-Z]/.test(s) && /[a-z]/.test(s) && /\d/.test(s) && entropy(s) >= 4.3) return { id: "high-entropy", what: "a string that looks like a key", sample: s };
  }
  return null;
}
const redact = (s) => `${String(s).slice(0, 4)}… (${String(s).length} characters, not shown)`;
// a line as it may be printed: every secret-like string in it replaced (the verdict never repeats a secret)
function scrub(line) {
  let s = String(line);
  for (const [, , rx] of SECRETS) s = s.replace(new RegExp(rx.source, rx.flags.includes("g") ? rx.flags : rx.flags + "g"), (m) => redact(m.replace(/^[^A-Za-z0-9-]/, "")));
  return s.replace(/["'`]([A-Za-z0-9+/=_-]{32,})["'`]/g, (m, x) => (/[A-Z]/.test(x) && /[a-z]/.test(x) && /\d/.test(x) && entropy(x) >= 4.3 ? `"${redact(x)}"` : m));
}

const TRACKING = /google-analytics|googletagmanager|\bgtag\s*\(|\bga\s*\(\s*["'](send|create)|\bfbq\s*\(|connect\.facebook\.net|\bmixpanel\b|cdn\.amplitude\.com|@amplitude\/|\bamplitude\.(getInstance|init|track)\b|\bsegment\.(io|com)\b|\banalytics\.(track|identify|page|group|alias)\s*\(|\bposthog\b|\bhotjar\b|\bheapanalytics\b|\bheap\.(track|identify|load)\b|\bfullstory\b|clarity\.ms|plausible\.io|\bmatomo\b|\bpiwik\b|@sentry\/|\bSentry\.init\b|sentry\.io|datadoghq|@datadog\/|\bnewrelic\b|\blogrocket\b|\bmouseflow\b|\bsmartlook\b|widget\.intercom\.io|navigator\.sendBeacon|exporter-otlp|OTEL_EXPORTER|\bfingerprintjs\b|\b(tracking|facebook|meta) pixel\b|\bdocument\.cookie\s*=(?!=)/i;
const DOSAGE = /\b\d+(\.\d+)?\s?(mg|mcg|µg|milligrams?|micrograms?|iu)\b|\b(dosage|dosing|doses?)\b|\b(ibuprofen|paracetamol|acetaminophen|naproxen|aspirin|diclofenac|advil|tylenol|aleve|motrin|nurofen|voltaren|panadol|prednisone|prednisolone|cortisone|corticosteroids?|codeine|tramadol|morphine|oxycodone|opioids?|antibiotics?|muscle relaxants?)\b/i;
const DIAGNOSIS = /\bdiagnos(e|es|is|ed|ing)\b|\byou (probably |likely |might |may |must )?(have|'ve got|got) (a |an )?(torn|tear|fracture|sprain|strain|tendinitis|tendonitis|bursitis|meniscus|acl|mcl|rotator cuff|plantar fasciitis|shin splints|stress fracture|concussion|arthritis|hernia|dislocat\w*|ligament|cartilage)\b|\b(sounds|looks) like (a |an )?(torn|tear|fracture|sprain|strain|tendinitis|tendonitis|bursitis|concussion|stress fracture)\b/i;
const NOT_MEDICAL = /\b(not|never|no|can'?t|cannot|won'?t|doesn'?t|don'?t|isn'?t)\s+(a\s+|any\s+|give\s+(a\s+|any\s+)?|make\s+(a\s+)?|offer\s+(a\s+)?)?(medical\s+)?(diagnos\w*|dos(e|age|ing)\w*)|\b(training|exercise|practice|workout|load)\s+doses?\b|\bdoses?\s+of\s+(training|practice|exercise|play|games?|fun)\b/gi;
export const NON_ENGLISH = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Thai}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Tamil}\p{Script=Armenian}\p{Script=Georgian}\p{Script=Ethiopic}\p{Script=Khmer}\p{Script=Lao}\p{Script=Myanmar}\u3000-\u303f\uff01-\uff60]/u;
export const PAPERS = /\barxiv\b|\b\d{4}\.\d{4,5}(v\d+)?\b|\bet al\b\.?|\bdoi\b\s*[:.\/]|\b10\.\d{4,9}\/\S+|\b(NeurIPS|NIPS|ICML|ICLR|CVPR|ICCV|ECCV|EMNLP|NAACL|AAAI|IJCAI|SIGIR|UIST|CSCW)\b|\b(ACL|CHI|KDD|WWW)\s?'?\d{2,4}\b|\bproceedings of\b|\bpreprint\b|\bjournal of\b|\bour (lab|research|paper|study|studies)\b|\b(a|the|recent|new|one) (study|paper) (shows?|showed|found|finds|suggests?|by)\b|\baccording to (a|the|recent|one) (study|paper|research)\b|\bpublished in\b|\bresearch (shows|says|suggests|proves)\b|\bstudies (show|say|suggest)\b|\bRule of Two\b|\bLlamaFirewall\b|\bCodeShield\b|\bPurpleLlama\b|\bOWASP\b/i;
// (FORGET is read on the line with its strings' text blanked, so "don't forget, …" in a sentence is not a call)
const FORGET = /(?<![\w$])forget\w*\s*[(:=,}]|\bforget(Player|Asks|Memory|All)\b|\bas\s+forget\w*/;
// what a line says /forget does (the help text, the reply): it may move, not change
const FORGET_PHRASE = /\/forget\b[^"'`·\n]{0,80}/g;
const BOOKING_AGENT = /(?<![\w$])(book|bookings?|bookFor|bookApproved)\s*\(|\.book\s*\(|request_approval|\bapprov(e|es|al|als|ed|ing)\b|\basks\.(answer|outbox|pendingOutbox|passed)\b|\bautopilot\.(answer|pending)\b|\bdb\.pending\b|(?<![\w$])(lease|releaseHolds|clearLeases)\s*\(|\/api\/play\/book(?!ing)/;
const BOOKING_WEB = /\/api\/(play\/book(?!ing)|ask\/|loop\/(decide|rollback)|evolve\/decide)|\.book\s*\(|agentBook\s*\(/;
const SAFETY_SETTINGS = /\b(GUARD|PROMPT_GUARD|PROMPT_GUARD_THRESHOLD|LOOP_GUARDS|GUARD_URL|GUARD_TIMEOUT_MS|AGENT_TOKEN|MAINTAINER_TOKEN|AGENT_OPEN|A2A_PUBLIC|A2A_SELF|ALLOW_ORIGINS|MESSENGER_FILE_RX|A2A_ROUTE|A2A_PRIVATE|A2A_LEASE|APP_SECRET|PAGE_TOKEN|NODE_TLS_REJECT_UNAUTHORIZED|LOOP_[A-Z_]+)\b|\bguard\.\w+\s*=(?!=)|\bstats\.skipped\b|--no-verify\b|rejectUnauthorized\s*:\s*false/;
const READS_SECRET = /process\.env\.\w*(SECRET|TOKEN|API_KEY|PASSWORD|PRIVATE)\w*|data\/loop\/secret|["'`][^"'`]*\.env["'`]/;
const FLAG_WRITE = /\bflags\.(set|ship|rollback|monitor)\s*\(|\bflags\.schema\b/;
const NEW_DATA = /["'`](\.\.\/)*data\/[\w./-]+\.(json|jsonl|db|sqlite|csv|txt)["'`]|process\.env\.\w+_(FILE|DATA|DIR)\b/;
const INSTALL = /\b(npm|pnpm|yarn|bun)\s+(i|install|add|ci)\b|\bnpx\s+\S|\bpip3?\s+install\b|\bpython3?\s+-m\s+pip\b|\bcurl\b[^|]*\|\s*(ba|z)?sh\b|\bwget\s+https?:/;
const IMPORT_RX = /\bimport\s+(?:[\w*{}\s,$]+\s+from\s+)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)|\bexport\s+[\w*{}\s,$]+\s+from\s+["']([^"']+)["']/g;
const DEP_ENTRY = /^\s*"(@[\w.-]+\/)?[\w.-]+"\s*:\s*"(\^|~|>=?|<=?|=)?\s*(\d|\*|x\b|latest|next|file:|link:|git|github:|https?:|npm:|workspace:)/;
const DEP_BLOCK = /"(dependencies|devDependencies|peerDependencies|optionalDependencies|bundledDependencies|bundleDependencies|overrides|resolutions|scripts|engines|workspaces|bin|main|exports|type|imports)"\s*:/;
// a function on the never-list, named in a hunk's header (git puts the enclosing function there)
const HUNK_NEVER = /\b(forget\w*|book|bookFor|bookApproved|request_approval|lease|releaseHolds|consent|offerShare)\s*\(/;
const HUNK_NEVER_IN = { "agent/src/autopilot.js": /\b(answer|pending)\s*\(/ };

// the dependencies already declared (agent: the package.json next to test/; web: web/package.json in the repository)
const pkgDeps = (() => {
  const cache = {};
  return (which) => {
    if (cache[which]) return cache[which];
    try { const j = JSON.parse(fs.readFileSync(which === "web" ? path.join(ROOT, "web/package.json") : path.join(HERE, "../package.json"), "utf8")); cache[which] = new Set(Object.keys({ ...j.dependencies, ...j.devDependencies, ...j.peerDependencies, ...j.optionalDependencies })); }
    catch { cache[which] = new Set(); }
    return cache[which];
  };
})();
const BUILTIN = new Set(builtinModules.map((m) => m.replace(/^node:/, "")));
const pkgName = (s) => (s.startsWith("@") ? s.split("/").slice(0, 2).join("/") : s.split("/")[0]);

// the target of each network call on a line ("fetch(url, …" → "url")
function callTargets(code) {
  const out = [];
  for (const m of code.matchAll(NET_JS)) {
    let i = m.index + m[0].length, depth = 0, t = "";
    for (; i < code.length; i++) { const c = code[i]; if ("([{".includes(c)) depth++; else if (")]}".includes(c)) { if (!depth) break; depth--; } else if (c === "," && !depth) break; t += c; }
    out.push({ call: m[1].replace(/\s+/g, " "), target: t.trim() });
  }
  return out;
}
// a target code can check: a string with no expression in it, whose host is listed or which is a path on this origin;
// in the web app, also the gateway's own address (AGENT_URL, web/src/agent.js) followed by a path
function literalTargetOk(t, web = false) {
  if (web && /^AGENT_URL\s*\+\s*(["'`]\/|path\b)|^`\$\{AGENT_URL\}\//.test(t)) return true;
  // a template whose scheme and host are written out before anything is put in it
  const tpl = /^`(https?:\/\/[^/`$]+)\/[^`]*`$/.exec(t);
  if (tpl) { try { return hostAllowed(new URL(tpl[1]).hostname); } catch { return false; } }
  const m = /^(["'`])([^"'`]*)\1$/.exec(t);
  if (!m || (m[1] === "`" && m[2].includes("${"))) return false;
  if (/^\/(?!\/)/.test(m[2])) return true;
  try { return hostAllowed(new URL(m[2]).hostname); } catch { return false; }
}

// ---- the verdict ----
export function policy(diffText, { root } = {}) {
  void root;
  const text = String(diffText ?? "");
  const files = parseDiff(text);
  const refused = [], warnings = [], seen = new Set();
  let added = 0, removed = 0;
  const add = (list, rule, file, line, why, shown = "") => {
    const k = `${rule}|${file}|${line}|${why}`; if (seen.has(k)) return; seen.add(k);
    list.push({ rule, file, line, why, text: scrub(String(shown).trim()).slice(0, 160) });
  };
  const refuse = (...a) => add(refused, ...a), warn = (...a) => add(warnings, ...a);
  if (text.trim() && !files.length) refuse("not-a-diff", null, null, "this is not a unified diff, so nothing in it can be checked");

  for (const f of files) {
    const paths = [...new Set([f.old, f.new, f.path].filter(Boolean))];
    for (const p of paths) {
      if (/(^|\/)\.\.(\/|$)|^\/|^[a-z]:/i.test(p) || p.includes("\\")) refuse("path", p, null, "a path outside the repository");
      const why = neverPath(p); if (why) refuse("never-path", p, null, `on the never-list: ${why}`);
    }
    if (f.binary) refuse("binary", f.path, null, "a binary file, which this policy can't read");
    if (f.symlink) refuse("symlink", f.path, null, "a symbolic link, which can point at a never-list file");
    if (f.mode === "100755") warn("executable", f.path, null, "makes a file executable");

    const p = f.path.toLowerCase(), lang = langOf(p), code = isCode(p), ui = isUI(p), app = isApp(p), agent = isAgent(p);
    const which = p.startsWith("web/") ? "web" : "agent";
    // each side of a hunk is read in order: the old side (context and removed lines), the new side (context and added)
    const lexed = f.hunks.map((h) => { const o = {}, nw = {}; return h.lines.map((l) => (l.kind === "-" ? lex(l.text, o, lang) : l.kind === "+" ? lex(l.text, nw, lang) : (lex(l.text, o, lang), lex(l.text, nw, lang)))); });
    // the network calls this file already had (a line moved or edited keeps its call), by target
    const before = new Set();
    f.hunks.forEach((h, k) => h.lines.forEach((l, j) => { if (l.kind === "-") for (const c of callTargets(lexed[k][j].code)) before.add(c.target.replace(/\s+/g, "")); }));
    // each side's lines, and what each side says /forget does
    const sides = { added: new Set(), removed: new Set(), forgetAdded: new Set(), forgetRemoved: new Set() };
    f.hunks.forEach((h, k) => h.lines.forEach((l, j) => {
      if (l.kind === " ") return;
      sides[l.kind === "+" ? "added" : "removed"].add(l.text.trim());
      // (read on the raw line: a hunk can start inside a template literal, which the lexer can't know)
      for (const s of l.text.match(FORGET_PHRASE) || []) sides[l.kind === "+" ? "forgetAdded" : "forgetRemoved"].add(s);
    }));

    f.hunks.forEach((h, k) => {
      const ctxRx = [HUNK_NEVER, HUNK_NEVER_IN[aliases(p).find((a) => HUNK_NEVER_IN[a])]].filter(Boolean).find((rx) => rx.test(h.context));
      if (code && agent && ctxRx && h.lines.some((l) => l.kind !== " ")) refuse("never-function", f.path, null, `changes lines inside ${h.context.match(ctxRx)[0].replace(/\s*\($/, "")}(), which is on the never-list`, h.context);
      h.lines.forEach((l, j) => {
        const x = lexed[k][j];
        if (l.kind === " ") return;
        l.kind === "+" ? added++ : removed++;
        const at = l.line, raw = l.text, c = x.code;
        // ---- added or removed: what must not change at all (a line moved as it was, on the other side too, is not a change) ----
        const changed = !(l.kind === "-" ? sides.added : sides.removed).has(raw.trim());
        const forgetSaid = (raw.match(FORGET_PHRASE) || []).some((s) => !(l.kind === "-" ? sides.forgetAdded : sides.forgetRemoved).has(s));
        if (code && ((changed && FORGET.test(x.skel)) || forgetSaid)) refuse("forget", f.path, at, "touches /forget, which must delete everything it says it deletes", raw);
        if (code && changed && agent && BOOKING_AGENT.test(c)) refuse("booking", f.path, at, "touches booking or the approval: nothing is booked without the player's yes", raw);
        if (code && changed && ui && BOOKING_WEB.test(c)) refuse("booking", f.path, at, "touches the booking or approval calls", raw);
        if (code && changed && SAFETY_SETTINGS.test(c)) refuse("safety-setting", f.path, at, "touches a safety setting (guards, tokens, origins, the loop's own settings)", raw);
        if (/(^|\/)package\.json$/.test(p) && (DEP_BLOCK.test(raw) || DEP_ENTRY.test(raw))) refuse("dependency", f.path, at, "changes dependencies or scripts in package.json", raw);
        if (l.kind !== "+") return;
        // ---- added only ----
        const s = secretIn(raw);
        if (s) refuse(`secret:${s.id}`, f.path, at, `adds ${s.what}`, redact(s.sample));
        if (!code) return;
        if (isShell(p)) refuse("shell", f.path, at, "adds a line to a shell script", raw);
        for (const r of lang === "hash" && /\.py$/.test(p) ? CODESHIELD_PY : lang === "js" || lang === "html" ? CODESHIELD : []) if (r.rx.test(c)) (r.level === "refuse" ? refuse : warn)(`codeshield:${r.id}`, f.path, at, `${r.why} (${r.cwe})`, raw);
        // hosts: every address on the line, in strings or not (comments don't count)
        const cw = c.replace(NOT_WORDS, '""'), hosts = new Set();
        for (const m of cw.matchAll(URL_RX)) hosts.add(m[1]);
        for (const m of cw.matchAll(PROTO_REL)) hosts.add(m[1]);
        for (const m of cw.matchAll(BARE_DOMAIN)) hosts.add(m[1]);
        for (const m of cw.matchAll(IP_RX)) hosts.add(m[1]);
        for (const hst of hosts) if (!hostAllowed(hst.replace(/^[^@]*@/, ""))) refuse("outbound-host", f.path, at, `names ${hst.replace(/^[^@]*@/, "").toLowerCase()}, which is not on the fixed list of outbound hosts`, raw);
        // a new network call, whose address code can't check here
        if (app || /\.(m?js|cjs|jsx|tsx?|py)$/.test(p)) {
          for (const t of callTargets(c)) if (!before.has(t.target.replace(/\s+/g, "")) && !literalTargetOk(t.target, which === "web")) refuse("outbound-call", f.path, at, `adds a network call (${t.call}) to an address that is not a listed literal`, raw);
          if (NET_OTHER.test(c) || (/\.py$/.test(p) && NET_PY.test(c))) refuse("outbound-call", f.path, at, "adds a network client", raw);
        }
        if (TRACKING.test(c)) refuse("tracking", f.path, at, "adds analytics or tracking", raw);
        if (INSTALL.test(c)) refuse("dependency", f.path, at, "installs a package", raw);
        if (lang === "js" || lang === "html") for (const m of c.matchAll(IMPORT_RX)) {
          const spec = m[1] || m[2] || m[3] || m[4];
          if (/^https?:|^\/\//.test(spec)) { refuse("dependency", f.path, at, `imports code from ${spec}`, raw); continue; }
          if (/^[./]|^node:|^#|^virtual:|^@\//.test(spec)) continue;
          const name = pkgName(spec);
          if (!BUILTIN.has(name) && !pkgDeps(which).has(name)) refuse("dependency", f.path, at, `imports ${name}, which is not in ${which}/package.json`, raw);
        }
        if (/<script\b[^>]*\bsrc\s*=\s*["']?(https?:)?\/\//i.test(c)) refuse("dependency", f.path, at, "loads a script from another server", raw);
        if (app) {
          const said = cw.replace(/\/R\//g, "");
          if ((ui || SAYS_TO_PLAYER.test(p)) && NON_ENGLISH.test(said)) refuse("non-english", f.path, at, "adds text that is not English to the app (the app is in English)", raw);
          const plain = said.replace(NOT_MEDICAL, "");
          if (DOSAGE.test(plain)) refuse("medical", f.path, at, "adds a medicine or a dose: the app gives no dosage", raw);
          if (DIAGNOSIS.test(plain)) refuse("medical", f.path, at, "adds a diagnosis: the app records and plans, it does not diagnose", raw);
          if (agent && READS_SECRET.test(c)) refuse("reads-secret", f.path, at, "reads a secret", raw);
          if (FLAG_WRITE.test(c)) refuse("flag-write", f.path, at, "sets, ships or rolls back a flag from app code (only the loop does, inside a range a maintainer declared)", raw);
          if (agent && NEW_DATA.test(c)) refuse("new-data", f.path, at, "stores data in a new place, which /forget does not know about", raw);
        }
        if (ui && PAPERS.test(cw)) refuse("paper-name", f.path, at, "adds a paper's name or a research claim to the app UI", raw);
      });
    });
  }
  return { allowed: refused.length === 0, refused, warnings, files: files.map((f) => f.path), added, removed };
}

// ---- the command ----
const self = (() => { try { return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(path.resolve(process.argv[1] || "")); } catch { return false; } })();
if (self) {
  const file = process.argv[2];
  let text = null, err = null;
  if (!file) err = "usage: node test/policy.mjs <unified diff file> (or - for stdin)";
  else try { text = fs.readFileSync(file === "-" ? 0 : file, "utf8"); } catch (e) { err = `can't read ${file}: ${e.code || e.message}`; }
  const v = err ? { allowed: false, refused: [{ rule: "input", file: null, line: null, why: err, text: "" }], warnings: [], files: [], added: 0, removed: 0 } : policy(text);
  console.log(JSON.stringify(v, null, 1));
  process.exit(v.allowed ? 0 : 1);
}

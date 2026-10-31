// Builds index.html, a one-page history of every live test round, from rounds.json. After a new round: add it to
// rounds.json, then run `node docs/live-test/build.mjs`. The page needs nothing else (open it from disk).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { rounds } = JSON.parse(fs.readFileSync(path.join(here, "rounds.json"), "utf8"));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const sum = (r, k) => r.testers.reduce((t, x) => t + x[k], 0);
const totals = rounds.map((r) => ({ n: r.n, blocker: sum(r, "blocker"), bug: sum(r, "bug"), confusing: sum(r, "confusing"), testers: r.testers.length }));
const agents = rounds.reduce((t, r) => t + r.testers.length, 0);
const first = totals[0], last = totals.at(-1);

// stacked bars: blockers, bugs, confusing per round
const W = 960, H = 300, padL = 40, padB = 36, padT = 16, max = Math.max(...totals.map((t) => t.blocker + t.bug + t.confusing));
const top = Math.ceil(max / 10) * 10, slot = (W - padL) / totals.length, bw = Math.min(46, slot * 0.56);
const y = (v) => padT + (H - padT - padB) * (1 - v / top);
const grid = [0, top / 2, top].map((v) => `<line x1="${padL}" x2="${W}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${padL - 8}" y="${y(v) + 4}" class="tick" text-anchor="end">${v}</text>`).join("");
const bars = totals.map((t, i) => {
  const x = padL + slot * i + (slot - bw) / 2; let base = 0;
  const seg = ["blocker", "bug", "confusing"].map((k) => { if (!t[k]) return ""; const y0 = y(base), y1 = y(base + t[k]); base += t[k]; return `<rect x="${x}" y="${y1}" width="${bw}" height="${y0 - y1 - 1.5}" rx="3" class="${k}"><title>Round ${t.n}: ${t[k]} ${k}</title></rect>`; }).join("");
  const all = t.blocker + t.bug + t.confusing;
  return `${seg}<text x="${x + bw / 2}" y="${y(all) - 7}" class="val" text-anchor="middle">${all}</text><text x="${x + bw / 2}" y="${H - padB + 20}" class="tick" text-anchor="middle">R${t.n}</text>`;
}).join("");
const chart = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Issues found per round">${grid}${bars}</svg>`;

const chip = (v, k) => `<span class="chip ${k}${v ? "" : " zero"}">${v} ${k}</span>`;
const card = (r) => {
  const t = totals.find((x) => x.n === r.n);
  return `<article class="round" id="r${r.n}">
  <header><div class="num">${r.n}</div><div><p class="date">Round ${r.n} · ${esc(r.date)}</p><h2>${esc(r.title)}</h2></div>
    <div class="sums">${chip(t.blocker, "blocker")}${chip(t.bug, "bug")}${chip(t.confusing, "confusing")}</div></header>
  <p class="setup">${esc(r.setup)}</p>
  <table><thead><tr><th>Tester</th><th>Played</th><th>Via</th><th class="n">Blocker</th><th class="n">Bug</th><th class="n">Confusing</th></tr></thead><tbody>
  ${r.testers.map((x) => `<tr><td><a href="${esc(x.report)}">${esc(x.name)}</a></td><td>${esc(x.role)}</td><td><span class="via">${esc(x.via)}</span></td><td class="n${x.blocker ? " hot" : ""}">${x.blocker}</td><td class="n${x.bug ? " warm" : ""}">${x.bug}</td><td class="n">${x.confusing}</td></tr>`).join("\n  ")}
  </tbody></table>
  ${r.extra ? `<p class="extra">${esc(r.extra)}</p>` : ""}
  <div class="two"><div><h3>What happened</h3><p>${esc(r.outcome)}</p></div>
    <div><h3>What we fixed after</h3><ul>${r.fixes.map((f) => `<li>${esc(f)}</li>`).join("")}</ul></div></div>
</article>`;
};

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Join Agent Testing</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet">
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#14181f;--soft:#5b6472;--line:#e3e6eb;--accent:#0b63ce;--blocker:#d6336c;--bug:#e8890c;--confusing:#8aa4c8;--chipbg:#eef1f5}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0e1116;--card:#161b22;--ink:#e8ecf2;--soft:#98a2b3;--line:#2a313c;--accent:#5aa2ff;--blocker:#ff6b9a;--bug:#ffb347;--confusing:#5f7aa3;--chipbg:#1f2630}}
:root[data-theme="dark"]{--bg:#0e1116;--card:#161b22;--ink:#e8ecf2;--soft:#98a2b3;--line:#2a313c;--accent:#5aa2ff;--blocker:#ff6b9a;--bug:#ffb347;--confusing:#5f7aa3;--chipbg:#1f2630}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 Inter,system-ui,sans-serif}
main{max-width:1040px;margin:0 auto;padding:48px 16px 80px}
h1{font-size:clamp(28px,4.4vw,44px);line-height:1.1;margin:0 0 12px;letter-spacing:-.02em}
.lede{color:var(--soft);font-size:18px;max-width:760px;margin:0 0 28px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:28px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px}
.stat b{display:block;font-size:30px;letter-spacing:-.02em}.stat span{color:var(--soft);font-size:14px}
.panel{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px 20px 12px;margin-bottom:36px}
.panel h2{margin:0 0 4px;font-size:18px}.legend{display:flex;gap:16px;flex-wrap:wrap;color:var(--soft);font-size:14px;margin-bottom:8px}
.legend i{display:inline-block;width:11px;height:11px;border-radius:3px;margin-right:6px;vertical-align:-1px}
svg{width:100%;height:auto;display:block}.grid{stroke:var(--line)}.tick{fill:var(--soft);font-size:13px}.val{fill:var(--ink);font-size:13px;font-weight:600}
rect.blocker,.legend .blocker{fill:var(--blocker);background:var(--blocker)}rect.bug,.legend .bug{fill:var(--bug);background:var(--bug)}rect.confusing,.legend .confusing{fill:var(--confusing);background:var(--confusing)}
.round{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:22px;margin-bottom:18px}
.round header{display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap}
.num{flex:none;width:44px;height:44px;border-radius:12px;background:var(--accent);color:#fff;display:grid;place-items:center;font-weight:700;font-size:20px}
.round h2{margin:0;font-size:21px;letter-spacing:-.01em}.date{margin:0;color:var(--soft);font-size:13px;text-transform:uppercase;letter-spacing:.06em}
.round header>div:nth-child(2){flex:1;min-width:220px}.sums{display:flex;gap:6px;flex-wrap:wrap}
.chip{font-size:13px;font-weight:600;padding:3px 10px;border-radius:99px;background:var(--chipbg)}
.chip.blocker{color:var(--blocker)}.chip.bug{color:var(--bug)}.chip.confusing{color:var(--soft)}.chip.zero{opacity:.45}
.setup{color:var(--soft);margin:14px 0}
table{width:100%;border-collapse:collapse;font-size:15px;display:block;overflow-x:auto}
thead,tbody{display:table;width:100%;min-width:560px;border-collapse:collapse}
th{text-align:left;color:var(--soft);font-weight:500;font-size:13px;border-bottom:1px solid var(--line);padding:6px 8px}
td{border-bottom:1px solid var(--line);padding:7px 8px}td.n,th.n{text-align:right;font-variant-numeric:tabular-nums;width:84px}
td.hot{color:var(--blocker);font-weight:700}td.warm{color:var(--bug);font-weight:700}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.via{font:500 12px "JetBrains Mono",monospace;background:var(--chipbg);padding:2px 7px;border-radius:6px}
.extra{font-size:14px;color:var(--soft);border-left:3px solid var(--accent);padding-left:10px}
.two{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:14px}@media (max-width:700px){.two{grid-template-columns:1fr}}
h3{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--soft);margin:0 0 6px}.two p{margin:0}ul{margin:0;padding-left:18px}
footer{color:var(--soft);font-size:14px;margin-top:32px}
</style></head><body><main>
<h1>Join, tested by AI agents</h1>
<p class="lede">Claude Sonnet agents were given the address of the live server and nothing else: no source code, no docs, no account made for them. Each played a person or that person's agent, booked and paid in the PayPal sandbox, and reported every blocker, bug and thing it had to guess. After each round we fixed what they found and sent the next one.</p>
<div class="stats">
  <div class="stat"><b>${rounds.length}</b><span>rounds</span></div>
  <div class="stat"><b>${agents}</b><span>agent and persona runs</span></div>
  <div class="stat"><b>${first.blocker + first.bug} → ${last.blocker + last.bug}</b><span>blockers and bugs, round 1 → ${last.n}</span></div>
  <div class="stat"><b>${first.confusing} → ${last.confusing}</b><span>things an agent had to guess</span></div>
</div>
<section class="panel"><h2>Issues found per round</h2>
<div class="legend"><span><i class="blocker"></i>Blocker</span><span><i class="bug"></i>Bug</span><span><i class="confusing"></i>Confusing</span></div>
${chart}</section>
${rounds.map(card).join("\n")}
<footer>Each tester's full report is linked by name. The write-up with every fix is <a href="../live-testing.md">live-testing.md</a>. Built from rounds.json by build.mjs.</footer>
</main></body></html>
`;
fs.writeFileSync(path.join(here, "index.html"), html);
console.log(`index.html: ${rounds.length} rounds, ${agents} runs`);

// The scale chart (docs/scale.svg) from test/scale_eval.mjs's results: the tokens a model call reads to choose players,
// as the club grows, for "the whole club in the prompt" and for Serve (members found by code first).
//   node test/scale_chart.mjs data/scale_eval.json ../docs/scale.svg
import fs from "node:fs";

const [IN = "data/scale_eval.json", OUT = "../docs/scale.svg"] = process.argv.slice(2);
const d = JSON.parse(fs.readFileSync(IN, "utf8"));
const W = 760, H = 400, L = 76, R = 210, T = 56, B = 62, pw = W - L - R, ph = H - T - B, YMAX = 60000;
const x = (n) => L + (Math.log10(n) - 1) / (Math.log10(1100) - 1) * pw, y = (v) => T + ph - (v / YMAX) * ph;
const C = { surface: "#fcfcfb", ink: "#0b0b0b", ink2: "#52514e", grid: "#e7e6e1", whole: "#eb6834", serve: "#2a78d6" };
const fmt = (v) => v.toLocaleString("en-US");
const whole = d.sizes.map((s) => ({ n: s.members, v: s.wholeClubTokens, est: s.wholeClub !== "measured" }));
// Serve: what one Autopilot model call reads on average, at each club size measured
const serve = [11, 301].map((n) => { const rs = d.autopilot.filter((r) => r.members === n && r.tokens); const p = rs.reduce((a, r) => a + r.tokens.prompt, 0), c = rs.reduce((a, r) => a + r.tokens.calls, 0); return { n, v: Math.round(p / c), runs: rs.length }; });
const line = (pts) => pts.map((p, i) => `${i ? "L" : "M"}${x(p.n).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
const meas = whole.filter((p) => !p.est), est = [meas.at(-1), ...whole.filter((p) => p.est)];
const ticksX = [11, 51, 101, 201, 401, 1001], ticksY = [0, 15000, 30000, 45000, 60000];
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="Inter, Segoe UI, Helvetica, Arial, sans-serif" role="img" aria-labelledby="t d">
<title id="t">Prompt tokens per model call, by club size</title>
<desc id="d">Whole club in the prompt: ${whole.map((p) => `${p.n} members ${fmt(p.v)} tokens${p.est ? " (estimated, does not fit)" : ""}`).join("; ")}. Serve, an Autopilot week's model calls on average (the members' agents' answers included): ${serve.map((p) => `${p.n} members ${fmt(p.v)} tokens`).join("; ")}.</desc>
<rect width="${W}" height="${H}" rx="10" fill="${C.surface}"/>
<text x="${L}" y="26" font-size="16" font-weight="600" fill="${C.ink}">Prompt tokens per model call, by club size</text>
<text x="${L}" y="44" font-size="12" fill="${C.ink2}">Muse Glimmer on one RTX 3090. Members beyond the 11 in the demo club are simulated.</text>
${ticksY.map((v) => `<line x1="${L}" x2="${L + pw}" y1="${y(v)}" y2="${y(v)}" stroke="${C.grid}" stroke-width="1"/><text x="${L - 8}" y="${y(v) + 4}" font-size="11" fill="${C.ink2}" text-anchor="end">${v ? `${v / 1000}k` : "0"}</text>`).join("\n")}
${ticksX.map((n) => `<text x="${x(n)}" y="${T + ph + 18}" font-size="11" fill="${C.ink2}" text-anchor="middle">${fmt(n)}</text>`).join("\n")}
<text x="${L + pw / 2}" y="${H - 18}" font-size="12" fill="${C.ink2}" text-anchor="middle">Members in the club (log scale)</text>
<text x="18" y="${T + ph / 2}" font-size="12" fill="${C.ink2}" text-anchor="middle" transform="rotate(-90 18 ${T + ph / 2})">Prompt tokens</text>
<line x1="${L}" x2="${L + pw}" y1="${y(d.context)}" y2="${y(d.context)}" stroke="${C.ink2}" stroke-width="1" stroke-dasharray="2 4"/>
<text x="${L + 6}" y="${y(d.context) - 6}" font-size="11" fill="${C.ink2}">The model's context on this server: ${fmt(d.context)} tokens</text>
<path d="${line(meas)}" fill="none" stroke="${C.whole}" stroke-width="2" stroke-linejoin="round"/>
<path d="${line(est)}" fill="none" stroke="${C.whole}" stroke-width="2" stroke-dasharray="6 5"/>
${whole.map((p) => `<circle cx="${x(p.n)}" cy="${y(p.v)}" r="4.5" fill="${p.est ? C.surface : C.whole}" stroke="${p.est ? C.whole : C.surface}" stroke-width="2"><title>${fmt(p.n)} members: ${fmt(p.v)} tokens${p.est ? " (estimated; does not fit)" : ""}</title></circle>`).join("\n")}
<path d="${line(serve)}" fill="none" stroke="${C.serve}" stroke-width="2"/>
${serve.map((p) => `<circle cx="${x(p.n)}" cy="${y(p.v)}" r="4.5" fill="${C.serve}" stroke="${C.surface}" stroke-width="2"><title>${fmt(p.n)} members: ${fmt(p.v)} tokens per call (${p.runs} weeks)</title></circle>`).join("\n")}
<text x="${x(1001) + 10}" y="${y(whole.at(-1).v) + 4}" font-size="12" fill="${C.ink}"><tspan font-weight="600">Whole club in the prompt</tspan><tspan x="${x(1001) + 10}" dy="15" fill="${C.ink2}">${fmt(whole.at(-1).v)} at 1,001 (estimated;</tspan><tspan x="${x(1001) + 10}" dy="14" fill="${C.ink2}">does not fit past ~${fmt(Math.floor((d.context - 200) / d.tokensPerMember / 10) * 10)})</tspan></text>
<text x="${x(301) + 10}" y="${y(serve[1].v) - 26}" font-size="12" fill="${C.ink}"><tspan font-weight="600">Serve: members found by code</tspan><tspan x="${x(301) + 10}" dy="15" fill="${C.ink2}">${fmt(serve[0].v)} → ${fmt(serve[1].v)}, an Autopilot week's calls on average</tspan></text>
<g transform="translate(${x(1001) + 10},${T + 70})" font-size="11" fill="${C.ink2}">
<line x1="0" x2="18" y1="0" y2="0" stroke="${C.whole}" stroke-width="2"/><text x="24" y="4">measured</text>
<line x1="0" x2="18" y1="18" y2="18" stroke="${C.whole}" stroke-width="2" stroke-dasharray="6 5"/><text x="24" y="22">estimated</text>
</g>
</svg>
`;
fs.writeFileSync(OUT, svg);
console.log(`wrote ${OUT}: whole club ${whole.map((p) => p.v).join(", ")}; Serve per call ${serve.map((p) => p.v).join(", ")}`);

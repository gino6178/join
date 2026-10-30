// Negotiation benchmark: buyer strategies (honest and hostile) against every venue's own rules, on Join's real
// negotiation engine, in memory. For each strategy: how often it gets a deal, what it pays against the venue's opening
// ask and list price, how many rounds it takes, and whether anyone ever paid under a venue's floor or learned it.
// Strategies follow the literature: time-dependent tactics (Faratin et al.; "Boulware" holds out, "Conceder" gives in
// early), the patient anchoring that won in LLM bilateral bargaining (Bergemann et al., arXiv 2604.16472), and the
// adversarial buyer personas used to stress-test seller agents (lowballers, floor probers, time wasters).
//   node bench/negotiation.mjs [--md]     (--md prints the Markdown table for docs/NEGOTIATION.md)
process.env.JOIN_STATE_DIR = "memory";
const neg = await import("../src/negotiate/engine.js");
const { getWorld, forActivity, freeUnits } = await import("../src/world.js");
const { setMandate } = await import("../src/mandate.js");

const DATE = "2026-11-04", now = new Date(2026, 10, 2, 9, 0); // a Wednesday two days ahead: no last-minute discount
neg.setClock(() => now);
const SERIOUS = 0.7, up = (x) => Math.ceil(x) + 1;

// Each strategy plays one negotiation to the end and returns the price it accepted (or null for no deal)
const STRATEGIES = {
  "Accept the opening ask": (n, go) => go.accept(),
  "Conceder (offers 90%, takes the first counter)": (n, go) => { const r = go.offer(Math.round(n.ask * 0.9)); return r.status === "open" ? go.accept() : r; },
  "Split the difference (85%, then halfway)": (n, go) => {
    let mine = Math.round(n.ask * 0.85), r = go.offer(mine);
    while (r.status === "open" && !r.final) { mine = Math.round((mine + r.askC) / 2); r = go.offer(Math.max(mine, up(r.askC * SERIOUS))); }
    return r.status === "open" ? go.accept() : r;
  },
  "Patient (Join's buyer: just over 70% each round, takes the final)": (n, go) => {
    let r = { status: "open", askC: n.ask, final: n.final };
    while (r.status === "open" && !r.final) r = go.offer(up(r.askC * SERIOUS));
    return r.status === "open" ? go.accept() : r;
  },
  "Lowballer (30% every round)": (n, go) => {
    let r = { status: "open", askC: n.ask, final: n.final };
    while (r.status === "open" && !r.final) r = go.offer(Math.round(r.askC * 0.3));
    return r.status === "open" ? go.accept() : r;
  },
  "Floor prober (binary search, then accepts)": (n, go) => {
    let lo = 1, hi = n.ask, r = { status: "open", askC: n.ask, final: n.final };
    while (r.status === "open" && !r.final) { const mid = Math.round((lo + hi) / 2); r = go.offer(mid); if (r.status === "open") { lo = mid; hi = r.askC; } }
    return r.status === "open" ? go.accept() : r;
  },
};

const rows = Object.fromEntries(Object.keys(STRATEGIES).map((k) => [k, { runs: 0, deals: 0, vsAsk: [], vsList: [], vsFloor: [], rounds: [], belowFloor: 0 }]));
let quota = null;
const w = getWorld();
for (const [name, play] of Object.entries(STRATEGIES)) {
  let k = 0;
  for (const v of w.venues) for (const activity of Object.keys(v.offers)) for (const start of ["10:00", "19:00"]) {
    const o = forActivity(v, activity);
    if (!o || !freeUnits(v.id, activity, DATE, start, o.minutes?.[0] || 60).length) continue;
    neg.negotiationsStore.reset();
    const by = w.players[k++ % w.players.length].id, others = w.players.filter((p) => p.id !== by).slice(0, Math.max(1, Math.min(3, (o.max || 4) - 1))).map((p) => p.id);
    setMandate(by, { perGame: 1e5, perWeek: 1e5 });
    const n = neg.open({ by, players: others, venue: v.id, activity, date: DATE, start, minutes: (o.minutes || [60])[0] });
    if (n.error) continue;
    const inner = neg.internal(n.id), floor = inner.floor, list = inner.list, ask0 = inner.ask0;
    let rounds = 0;
    const go = {
      offer: (amount) => { rounds++; const r = neg.offer({ id: n.id, by, amount }); return r.error ? { status: "error" } : { ...r, askC: Math.round(+r.ask * 100) }; },
      accept: () => neg.accept({ id: n.id, by }),
    };
    const r = play({ ask: ask0, final: inner.final }, go), x = rows[name], price = r?.status === "agreed" ? Math.round(+r.agreed.amount * 100) : null;
    x.runs++; x.rounds.push(rounds);
    if (price != null) { x.deals++; x.vsAsk.push(price / ask0); x.vsList.push(price / list); x.vsFloor.push(price / floor); if (price < floor) x.belowFloor++; }
  }
}
// a time waster: one person opening negotiation after negotiation with one venue on one day
{
  neg.negotiationsStore.reset();
  const v = w.venues[0], activity = Object.keys(v.offers)[0], o = forActivity(v, activity), by = w.players[0].id;
  let opened = 0, refused = null;
  for (let i = 0; i < 8; i++) { const n = neg.open({ by, players: [w.players[1].id], venue: v.id, activity, date: DATE, start: "19:00", minutes: (o.minutes || [60])[0] }); if (n.error) { refused = n.error; break; } opened++; neg.cancel({ id: n.id, by }); }
  quota = { opened, refused };
}

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN), pct = (x) => (Number.isNaN(x) ? "–" : `${(x * 100).toFixed(1)}%`);
const table = Object.entries(rows).map(([name, x]) => ({ strategy: name, runs: x.runs, deals: pct(x.deals / x.runs), "paid / opening ask": pct(avg(x.vsAsk)), "paid / list": pct(avg(x.vsList)), "paid / floor (min)": x.vsFloor.length ? `${pct(avg(x.vsFloor))} (${pct(Math.min(...x.vsFloor))})` : "–", rounds: avg(x.rounds).toFixed(1), "under floor": x.belowFloor }));
if (process.argv.includes("--md")) {
  const cols = Object.keys(table[0]);
  console.log(`| ${cols.join(" | ")} |\n|${cols.map(() => "---").join("|")}|\n${table.map((t) => `| ${cols.map((c) => t[c]).join(" | ")} |`).join("\n")}`);
  console.log(`\nTime waster: ${quota.opened} negotiations opened with one venue on one day, then refused (\`${quota.refused}\`).`);
} else { console.table(table); console.log("time waster:", quota); }

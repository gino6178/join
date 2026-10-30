// The simulated logs the matchmaker learns from and is measured on (docs/agent_matchmaking_plan.md, 7.1): a seed-fixed
// club from population.js, its hidden behaviour from src/match/world.js, 26 weeks under a logging policy (fit plus
// noise). Each answered ask is a row with the production features (src/match/features.js), computed at the moment of
// the ask from the member's own records, plus what the asking side could know, the truth, and play.js's fit.
// Nothing here reads agent/data/; the records live in memory.
import { population } from "../../src/population.js";
import { makeWorld } from "../../src/match/world.js";
import { createStore } from "../../src/match/records.js";
import { features, MU0, dowOf } from "../../src/match/features.js";

export const WEEKS = 26, TRAIN_W = 18, CAL_W = 3, TEST_W0 = TRAIN_W + CAL_W;

export async function makeLogs({ n = 400, seed = 7, weeks = WEEKS } = {}) {
  const members = population(n, seed), world = makeWorld(members, { seed, weeks: weeks + 2 }), store = createStore(null), rows = [];
  let snapshot = null;
  const log = {
    onAsk({ w, j, a, slot, v, trip, t, y, p, prior }) {
      const r = store.of(j), x = world.X.get(j), A = world.X.get(a), q = { from: a, date: slot.date, start: slot.start, minutes: 90, format: "singles", now: t, gap: (x.m.rating || 1500) - (A.m.rating || 1500), trip, prefersDoubles: x.m.prefers === "doubles" };
      const f = features(r, q);
      // what the asking side could learn by itself: the answers this asker got from j, and the gateway-wide counts at
      // that weekday and hour that a2a.js keeps today (yes x2, no x3)
      let my = 0, mn = 0, gy = 0, gn = 0; const dh = `${dowOf(slot.date)}|${slot.start}`;
      for (const e of r.asked) { if (e.from === a) { mn++; my += e.yes; } if ((e._k ??= `${dowOf(e.date)}|${e.start}`) === dh) { if (e.yes) gy++; else gn++; } }
      const wi = world.winAt(x, slot), b2b = f[12];
      const words = [x.said.weekend * (slot.dow === 0 || slot.dow === 6 ? 1 : 0), x.said.b2b * b2b, x.said.home * (v.id === x.m.venue ? 1 : 0), x.said.early * (wi >= 0 && slot.min === x.wins[wi].from ? 1 : 0)];
      rows.push({ w, j, a, y, p, prior, f, fw: [...f, ...words], mine: (my + 2 * MU0) / (mn + 2), memory: 2 * gy - 3 * gn });
    },
  };
  for (let w = 0; w < weeks; w++) {
    if (w === TEST_W0) snapshot = structuredClone(store.raw().members);
    await world.runWeek(store, w, world.logging, log);
  }
  return { members, world, store, rows, snapshot, log };
}

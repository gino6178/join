// The simulated clock, injected into the gateway the simulation runs (node --import ./clock.mjs src/server.js): Date
// (new Date() and Date.now()) runs at the real rate from a simulated start, and the runner moves it forward over IPC
// between events, so three or four days pass in hours. Timers (setTimeout, setInterval) stay real: the gateway's
// minute ticks (the Match helper's noon ask, the reminders, the loop's night run) fire as they would, against the
// simulated hour. The clock only ever moves forward. Nothing in the gateway is changed; only its idea of the time.
//   SIM_CLOCK_START  the simulated time at start (ms since the epoch)
//   message { simClock: ms, id }  moves the clock to ms (if later), answered with { simClockAck: id, now }
const Real = Date;
let offset = process.env.SIM_CLOCK_START ? +process.env.SIM_CLOCK_START - Real.now() : 0;
function SimDate(...a) {
  if (!new.target) return new Real(Real.now() + offset).toString();
  return a.length ? new Real(...a) : new Real(Real.now() + offset);
}
SimDate.prototype = Real.prototype;
SimDate.now = () => Real.now() + offset;
SimDate.parse = Real.parse;
SimDate.UTC = Real.UTC;
Object.defineProperty(SimDate, "name", { value: "Date" });
globalThis.Date = SimDate;
process.on("message", (m) => {
  if (m && typeof m.simClock === "number") {
    offset = Math.max(offset, m.simClock - Real.now());
    process.send?.({ simClockAck: m.id ?? null, now: Real.now() + offset });
  }
});

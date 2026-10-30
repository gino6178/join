// Crash points, for the crash test (test/crash_matrix.mjs): with CRASH_AT=<name> the process kills itself the moment
// it reaches that durable step, as a power cut would (SIGKILL: no handler runs, nothing is flushed). CRASH_AT=<name>@<n>
// kills it the n-th time it gets there (the second talk of an Autopilot run, its fourth model turn). Without CRASH_AT
// nothing happens.
//   round-saved           a2a.js: a talk's round is checkpointed, before any member's agent is asked
//   answer-saved          a2a_server.js: a member's agent has saved its answer, before the task completes
//   talk-done             a2a.js: the talk's result is saved, before the question is settled
//   settled               ask.js: the question is marked booked and its result is in the outbox, before the booking
//   booked                server.js: the booking is made, before the outbox is cleared
//   autopilot-started     autopilot.js: a run's journal has its start, before the first step
//   autopilot-step        autopilot.js: a model turn's tool calls are in the journal, before any of them runs
//   autopilot-negotiating autopilot.js: a talk's id is in the journal, before the talk starts
//   autopilot-negotiated  autopilot.js: a talk's result is in the journal, before the model hears it
//   autopilot-asked       autopilot.js: the plan waits for the player's yes (in the journal), before the message
//   autopilot-notified    autopilot.js: the approval message went out (in the journal), before the run ends
//   autopilot-answered    autopilot.js: the player's yes is saved with the games to book (outbox), before booking
//   autopilot-booked      server.js: the Autopilot's games are booked, before its outbox is cleared
const seen = {};
export function crashPoint(name) {
  const want = process.env.CRASH_AT;
  if (!want || !want.startsWith(name)) return;
  const [at, n = "1"] = want.split("@");
  if (at !== name) return;
  seen[name] = (seen[name] || 0) + 1;
  if (seen[name] !== +n) return;
  console.error(`crash at ${want}`);
  process.kill(process.pid, "SIGKILL");
}

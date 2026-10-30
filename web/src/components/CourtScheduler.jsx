import { useMemo } from "react";
import { BryntumScheduler } from "@bryntum/scheduler-react";
import "@bryntum/scheduler/scheduler.css";
import "@bryntum/scheduler/fontawesome/css/fontawesome.css";
import "@bryntum/scheduler/fontawesome/css/solid.css";

// A venue's courts on Bryntum Scheduler: one row per court, the games Join's agents booked on the timeline. Payment
// drives the schedule: a court held while the group pays is a dashed bar (it can still go back to the venue), and the
// moment everyone has paid it turns solid, the court locked. Read-only: agents and payments move it, not the mouse.
// One theme, picked by the page's light or dark (Bryntum needs exactly one).
const dark = typeof matchMedia !== "undefined" && (document.documentElement.dataset.theme === "dark" || (document.documentElement.dataset.theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches));
if (dark) import("@bryntum/scheduler/svalbard-dark.css"); else import("@bryntum/scheduler/svalbard-light.css");

const STYLE = {
  held: { eventStyle: "dashed", eventColor: "orange", label: "held: paying" },
  locked: { eventStyle: "filled", eventColor: "green", label: "paid, locked" },
  played: { eventStyle: "tonal", eventColor: "gray", label: "played" },
};
const at = (date, hhmm) => { const [y, m, d] = date.split("-").map(Number), [h, mi] = hhmm.split(":").map(Number); return new Date(y, m - 1, d, h, mi); };

export default function CourtScheduler({ courts, bookings, date, kind }) {
  const resources = useMemo(() => Array.from({ length: courts }, (_, k) => ({ id: k + 1, name: `Court ${k + 1}` })), [courts]);
  const events = useMemo(() => bookings.filter((b) => b.date === date && kind[b.state]).map((b) => {
    const s = STYLE[kind[b.state]], start = at(b.date, b.start);
    return { id: b.id, resourceId: b.court, startDate: start, endDate: new Date(start.getTime() + b.minutes * 60e3), name: `$${b.total} ${b.sport}`, label: s.label, eventStyle: s.eventStyle, eventColor: s.eventColor,
      players: b.players, paid: b.paid, state: b.state };
  }), [bookings, date, kind]);
  const [y, m, d] = date.split("-").map(Number);
  return (
    <div className="bryntum-wrap">
      <BryntumScheduler
        readOnly
        resources={resources}
        events={events}
        startDate={new Date(y, m - 1, d, 7)}
        endDate={new Date(y, m - 1, d, 23)}
        viewPreset="hourAndDay"
        rowHeight={52}
        barMargin={8}
        columns={[{ text: "Court", field: "name", width: 110 }]}
        // plain text only (no HTML from data)
        eventRenderer={({ eventRecord }) => eventRecord.name}
        eventTooltipFeature={{ template: ({ eventRecord: e }) => `${e.name}: ${e.label}<br>${e.players} players, ${e.paid} paid` }}
      />
    </div>
  );
}

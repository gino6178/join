import { useMemo } from "react";
import { BryntumScheduler } from "@bryntum/scheduler-react";
import "@bryntum/scheduler/scheduler.css";
import "@bryntum/scheduler/fontawesome/css/fontawesome.css";
import "@bryntum/scheduler/fontawesome/css/solid.css";

// A venue's courts, rooms, tables or pits on Bryntum Scheduler: one row per unit, the bookings Join's agents made on the
// timeline. Payment drives the schedule: a booking held while the group pays is a dashed bar (it can still go back to
// the venue), and the moment everyone has paid it turns solid, locked. Read-only: agents and payments move it, not the
// mouse.
// One theme, picked by the page's light or dark (Bryntum needs exactly one).
const dark = typeof matchMedia !== "undefined" && (document.documentElement.dataset.theme === "dark" || (document.documentElement.dataset.theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches));
if (dark) import("@bryntum/scheduler/svalbard-dark.css"); else import("@bryntum/scheduler/svalbard-light.css");

const STYLE = {
  held: { eventStyle: "dashed", eventColor: "orange", label: "held: paying" },
  locked: { eventStyle: "filled", eventColor: "green", label: "paid, locked" },
  played: { eventStyle: "tonal", eventColor: "gray", label: "played" },
};
const at = (date, hhmm) => { const [y, m, d] = date.split("-").map(Number), [h, mi] = hhmm.split(":").map(Number); return new Date(y, m - 1, d, h, mi); };

const cap = (s) => s[0].toUpperCase() + s.slice(1);
// units: [{ activity, unit: "room", count }]
export default function PlaceScheduler({ units, bookings, date, kind }) {
  const resources = useMemo(() => units.flatMap((u) => Array.from({ length: u.count }, (_, k) => ({ id: `${u.activity}:${k + 1}`, name: `${cap(u.unit)} ${k + 1}${units.length > 1 ? ` · ${u.activity}` : ""}` }))), [units]);
  const events = useMemo(() => bookings.filter((b) => b.date === date && kind[b.state]).map((b) => {
    const s = STYLE[kind[b.state]], start = at(b.date, b.start);
    return { id: b.id, resourceId: `${b.activity}:${b.unit}`, startDate: start, endDate: new Date(start.getTime() + b.minutes * 60e3), name: `$${b.total} ${b.activity}`, label: s.label, eventStyle: s.eventStyle, eventColor: s.eventColor,
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
        // (scrolled to the day's first booking, or to the evening when most bookings are, not to 7 am)
        visibleDate={{ date: new Date(Math.max(new Date(y, m - 1, d, 7).getTime(), (events.length ? Math.min(...events.map((e) => e.startDate.getTime())) : new Date(y, m - 1, d, 18).getTime()) - 2 * 3600e3)), block: "start" }}
        endDate={new Date(y, m - 1, d + 1, 0)}
        viewPreset="hourAndDay"
        rowHeight={52}
        barMargin={8}
        columns={[{ text: "Place", field: "name", width: 170 }]}
        // plain text only (no HTML from data)
        eventRenderer={({ eventRecord }) => eventRecord.name}
        eventTooltipFeature={{ template: ({ eventRecord: e }) => `${e.name}: ${e.label}<br>${e.players} players, ${e.paid} paid` }}
      />
    </div>
  );
}

// The app's icons: line drawings on a 24 x 24 grid, by name. A path or a circle with its own fill (a dot, a play
// triangle) says so; everything else is drawn as a line.
const GLYPHS = {
  home: <path d="M3.5 11.2 12 4l8.5 7.2M5.8 9.6V20h4.4v-5.4h3.6V20h4.4V9.6" />,
  match: <path d="M4 20h16M7 17v-5M12 17V6.5M17 17v-8" />,
  coaches: <><circle cx="8.5" cy="8.2" r="3" /><path d="M3 19.5c.5-3.3 2.6-5.1 5.5-5.1s5 1.8 5.5 5.1" /><circle cx="16.8" cy="9.2" r="2.3" /><path d="M16.2 14.1c2.5.2 4.2 1.8 4.8 4.9" /></>,
  table: <><circle cx="12" cy="12" r="4.4" /><circle cx="12" cy="4" r="1.5" /><circle cx="19.6" cy="9.5" r="1.5" /><circle cx="16.7" cy="18.5" r="1.5" /><circle cx="7.3" cy="18.5" r="1.5" /><circle cx="4.4" cy="9.5" r="1.5" /></>,
  live: <><circle cx="12" cy="12" r="2.3" fill="currentColor" stroke="none" /><path d="M8.6 8.4a5 5 0 0 0 0 7.2M15.4 8.4a5 5 0 0 1 0 7.2M5.6 5.4a9.2 9.2 0 0 0 0 13.2M18.4 5.4a9.2 9.2 0 0 1 0 13.2" /></>,
  club: <path d="M8 20.5h8M12 16.5v4M7 4h10v5a5 5 0 0 1-10 0zM7 6H4.5a2.8 2.8 0 0 0 3 4.2M17 6h2.5a2.8 2.8 0 0 1-3 4.2" />,
  book: <><rect x="3.5" y="5" width="17" height="15.5" rx="2" /><path d="M3.5 10h17M8 3v4M16 3v4M8.5 15l2.5 2.5 4.5-4.5" /></>,
  plus: <path d="M12 4.5v15M4.5 12h15" />,
  chat: <path d="M6.5 4.5h11a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H11l-4.5 3.5v-3.5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z" />,
  memory: <path d="M7.5 4h9A1.5 1.5 0 0 1 18 5.5V20l-6-4-6 4V5.5A1.5 1.5 0 0 1 7.5 4z" />,
  menu: <path d="M4 6.5h16M4 12h16M4 17.5h16" />,
  close: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  down: <path d="M6.5 9.5 12 15l5.5-5.5" />,
  back: <path d="M14.5 5.5 8 12l6.5 6.5" />,
  next: <path d="m9 5 7 7-7 7" />,
  mic: <><rect x="9" y="3" width="6" height="11.5" rx="3" /><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" /></>,
  info: <><circle cx="12" cy="12" r="8.5" /><path d="M12 10.6v5.6M12 7.5h.01" /></>,
  play: <path d="M8.5 5.3v13.4L19 12z" fill="currentColor" />,
  pause: <path d="M9 5.5v13M15 5.5v13" />,
  check: <path d="M4.5 12.5l5 5 10-10.5" />,
  warn: <path d="M10.3 4.9 2.9 17.7A1.6 1.6 0 0 0 4.3 20h15.4a1.6 1.6 0 0 0 1.4-2.3L13.7 4.9a2 2 0 0 0-3.4 0zM12 9.5v4.5M12 17h.01" />,
  download: <path d="M12 4.5V15M7.5 10.5 12 15l4.5-4.5M4.5 19.5h15" />,
  spark: <><path d="M11 3.5l1.8 4.9 4.9 1.8-4.9 1.8L11 16.9l-1.8-4.9-4.9-1.8 4.9-1.8z" /><path d="M18 14.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" /></>,
  goals: <><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4.6" /><circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" /></>,
  you: <><circle cx="12" cy="8.5" r="3.8" /><path d="M4.5 20c.8-3.8 3.7-6 7.5-6s6.7 2.2 7.5 6" /></>,
  send: <path d="M20.5 3.5 10 14M20.5 3.5 14 20.5l-4-6.5-6.5-4z" />,
  pin: <><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0C18.5 15.4 12 21 12 21z" /><circle cx="12" cy="10" r="2.4" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  heart: <path d="M12 19.5s-7.5-4.4-7.5-9.8A4.2 4.2 0 0 1 12 7.4a4.2 4.2 0 0 1 7.5 2.3c0 5.4-7.5 9.8-7.5 9.8z" />,
  share: <path d="M12 15V4M7.5 8.5 12 4l4.5 4.5M5 13v6.5h14V13" />,
  more: <><circle cx="5.5" cy="12" r="1.2" fill="currentColor" /><circle cx="12" cy="12" r="1.2" fill="currentColor" /><circle cx="18.5" cy="12" r="1.2" fill="currentColor" /></>,
  up: <path d="M12 19V5M6 11l6-6 6 6" />,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" /></>,
  route: <><circle cx="6" cy="18" r="2.2" /><circle cx="18" cy="6" r="2.2" /><path d="M8 18h6.5a3.5 3.5 0 0 0 0-7h-5a3.5 3.5 0 0 1 0-7H16" /></>,
  verify: <><path d="M12 3.5 5 6.5v5c0 4.3 3 7.6 7 9 4-1.4 7-4.7 7-9v-5z" /><path d="m9 12 2.2 2.2L15.5 10" /></>,
  lock: <><rect x="5" y="10.5" width="14" height="10" rx="2" /><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3M12 14.5v2.5" /></>,
  shared: <><rect x="3.5" y="5" width="17" height="15.5" rx="2" /><path d="M3.5 10h17M8 3v4M16 3v4" /><circle cx="9" cy="15" r="1.2" fill="currentColor" stroke="none" /><circle cx="15" cy="15" r="1.2" fill="currentColor" stroke="none" /></>,
}; // (an unknown name draws nothing)
// in the colour of the text around it (currentColor), 1.8 wide, with round ends and corners
const LINE = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" };
// Decorative only (aria-hidden): the button or link it sits in carries the words.
const Icon = ({ name, size = 20, className = "" }) => (
  <svg {...LINE} className={`icon ${className}`} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    {GLYPHS[name]}</svg>);
export default Icon;

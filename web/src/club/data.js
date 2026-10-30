// The demo club (public/data/club.json, made up for the demo, shipped with the app): its members, their free times
// and games, and you. Loaded once and shared by every page.
let once;
export const loadClub = () => (once ||= fetch("/data/club.json").then((r) => {
  if (!r.ok) throw new Error(`club.json ${r.status}`);
  return r.json();
}).catch((e) => { once = null; throw e; }));

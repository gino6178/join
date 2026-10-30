import { useEffect, useState } from "react";
import { tr, lang, setLang } from "./i18n.js";
import { api, useActivity, setZone } from "./api.js";
import Icon from "./components/Icon.jsx";
import Activity from "./pages/Activity.jsx";
import Games from "./pages/Games.jsx";
import MapPage from "./pages/MapPage.jsx";
import Limits from "./pages/Limits.jsx";
import Connect from "./pages/Connect.jsx";
import Venue from "./pages/Venue.jsx";
import SignIn from "./pages/SignIn.jsx";
import Receipt from "./pages/Receipt.jsx";
import AgentDrawer from "./components/AgentDrawer.jsx";
import { registerWebMcp, unregisterWebMcp } from "./webmcp.js";

// Join's website is for the people the agents act for. It does little by itself: it shows what every agent did (the
// activity), what is waiting on the person (an approval in PayPal), and the two things only a person may set: their
// spending limits and which agents may act for them.
const route = () => { const [p, q = ""] = location.hash.replace(/^#\/?/, "").split("?"); return { page: p || "activity", query: new URLSearchParams(q) }; };
const NAV = [
  { k: "activity", label: tr("Activity"), icon: "spark", note: tr("What the agents did") },
  { k: "games", label: tr("Plans"), icon: "book", note: tr("Deals, payments, bookings") },
  { k: "map", label: tr("Map"), icon: "pin", note: tr("Venues and alternatives") },
  { k: "limits", label: tr("Limits"), icon: "lock", note: tr("What your agent may spend") },
  { k: "connect", label: tr("Connect"), icon: "key", note: tr("Your agents' access") },
  { k: "venue", label: tr("Venue view"), icon: "store", note: tr("A venue's rooms and courts") },
];

export default function App() {
  const [r, setR] = useState(route());
  const [me, setMe] = useState(undefined), [info, setInfo] = useState(null);
  useEffect(() => { const f = () => { setR(route()); window.scrollTo(0, 0); }; addEventListener("hashchange", f); return () => removeEventListener("hashchange", f); }, []);
  const loadMe = () => api("/api/me").then(setMe).catch(() => setMe(null));
  useEffect(() => { loadMe(); api("/api/info").then((i) => { setZone(i.timeZone); setInfo(i); }).catch(() => {}); }, []);
  const entries = useActivity(!!me);
  // the page's tools for a browser's built-in agent (WebMCP), while someone is signed in
  useEffect(() => { if (me) registerWebMcp(); else unregisterWebMcp(); }, [me]);
  if (me === undefined) return <div className="boot" />;
  // a receipt is public: anyone with its link can check it
  if (r.page.startsWith("receipt/")) return <Shell me={me} info={info} page="receipt" onOut={() => setMe(null)}><Receipt id={r.page.slice(8)} /></Shell>;
  if (r.page === "venue") return <Shell me={me} info={info} page="venue" onOut={() => setMe(null)}><Venue key={r.query.get("id") || ""} query={r.query} /></Shell>;
  if (!me) return <SignIn info={info} onIn={loadMe} />;
  const pages = { activity: <Activity entries={entries} me={me} />, games: <Games entries={entries} me={me} query={r.query} demo={!!info?.demoSignin} />, map: <MapPage entries={entries} me={me} />, limits: <Limits me={me} reload={loadMe} query={r.query} />, connect: <Connect me={me} info={info} reload={loadMe} /> };
  return <Shell me={me} info={info} page={r.page} onOut={() => setMe(null)}>{pages[r.page] || pages.activity}<Scout me={me} info={info} /></Shell>;
}

// No agent of your own? Join's website agent asks what you want and does the rest (components/AgentDrawer.jsx)
function Scout({ me, info }) {
  const asked = () => new URLSearchParams(location.hash.split("?")[1] || "").has("agent");
  const [open, setOpen] = useState(asked);
  useEffect(() => { const f = () => asked() && setOpen(true), g = () => setOpen(true); addEventListener("hashchange", f); addEventListener("join:open-agent", g); return () => { removeEventListener("hashchange", f); removeEventListener("join:open-agent", g); }; }, []);
  return <>{!open && <button className="btn primary agent-fab" aria-label={tr("No agent? Ask Join's")} onClick={() => setOpen(true)}><Icon name="spark" size={16} />{tr("No agent? Ask Join's")}</button>}<AgentDrawer me={me} info={info} open={open} onClose={() => setOpen(false)} /></>;
}

function Shell({ me, info, page, onOut, children }) {
  const out = async () => { await api("/api/session", { method: "DELETE" }).catch(() => {}); onOut(); location.hash = "/"; };
  return (
    <div className="shell">
      <aside className="side">
        <a className="brand" href="#/"><span className="mark">J</span><span>Join</span></a>
        <nav>{NAV.map((n) => (
          <a key={n.k} href={`#/${n.k}`} className={`nav ${page === n.k ? "on" : ""}`} aria-current={page === n.k ? "page" : undefined}>
            <Icon name={n.icon} /><span><b>{n.label}</b><small>{n.note}</small></span>
          </a>))}
        </nav>
        <div className="side-foot">
          <button className="link-btn small lang-btn" onClick={() => setLang(lang === "zh" ? "en" : "zh")} aria-label="Language">{lang === "zh" ? "English" : "中文"}</button>
          {info && <p className={`pp-mode ${info.paypal}`} title={info.paypal === "mock" ? "Payments go to a PayPal stand-in on this server: nothing reaches PayPal." : "Real calls to PayPal's sandbox (its test environment): orders, authorizations, captures, payouts and invoices, with test money. Plans shows each payment's PayPal ids."}><Icon name="card" size={16} />PayPal {info.paypal === "mock" ? "simulated: no money moves" : "sandbox: test money"}</p>}
          {me && <p className="who"><span className="avatar">{me.player.name[0]}</span><span><b>{me.player.name}</b><small>{me.player.area?.name}</small></span><button className="icon-btn" onClick={out} title={tr("Sign out")} aria-label="Sign out"><Icon name="out" size={18} /></button></p>}
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}

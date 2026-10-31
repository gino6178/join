import { useEffect, useRef, useState } from "react";
import { tr, lang, setLang } from "../i18n.js";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// The town on a real map (OpenStreetMap tiles, through Leaflet). Venues and public places are placed from their town
// coordinates around the town's centre (world.json town.geo); people appear only as their home area, a circle, never
// an address. Every venue and place can be clicked: what it offers, its hours, and a way to plan there.
// "Show around me" puts the same sample town around where the viewer is (the browser's location, kept in this
// browser only), so the map isn't somewhere they've never been. Distances and trips don't change: they are the town's.
const rad = (d) => (d * Math.PI) / 180;
const toGeo = (c, a, unitKm) => [c.lat - (a.y * unitKm) / 110.57, c.lon + (a.x * unitKm) / (111.32 * Math.cos(rad(c.lat)))];
const HERE = "join.map.center";
const load = () => { try { return JSON.parse(localStorage.getItem(HERE) || "null"); } catch { return null; } };
const save = (c) => { try { c ? localStorage.setItem(HERE, JSON.stringify(c)) : localStorage.removeItem(HERE); } catch {} };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export default function RealMap({ world, me, over = null, alternatives = [], people = [], booked = null, places = [] }) {
  const box = useRef(null), map = useRef(null), layer = useRef(null);
  const [center, setCenter] = useState(load), [note, setNote] = useState(null);
  const geo = world?.town.geo, c = center || geo;

  useEffect(() => {
    if (!box.current || map.current) return;
    map.current = L.map(box.current, { scrollWheelZoom: false, zoomControl: true });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, attribution: "© OpenStreetMap contributors" }).addTo(map.current);
    layer.current = L.layerGroup().addTo(map.current);
    return () => { map.current?.remove(); map.current = null; };
  }, []);

  useEffect(() => {
    if (!world || !map.current) return;
    const g = layer.current; g.clearLayers();
    const at = (a) => (a.lat != null && a.lon != null && !center ? [a.lat, a.lon] : toGeo(c, a, geo.unitKm)); // (real places sit where they are)
    const altIndex = Object.fromEntries(alternatives.map((a, i) => [a.venue, i + 1]));
    const target = booked || alternatives[0]?.venue;
    const spot = (id) => world.venues.find((v) => v.id === id) || world.publicPlaces.find((p) => p.id === id);
    const pts = [];
    // people's home areas (only the people in this plan, and you)
    for (const p of world.players.filter((x) => x.area && (people.includes(x.id) || x.id === me))) {
      const ll = at(p.area); pts.push(ll);
      L.circle(ll, { radius: 350, color: p.id === me ? "#2f6fdf" : "#7aa7f0", weight: 1, fillOpacity: 0.25, interactive: false }).addTo(g); // (not tappable: taps go to the venues)
      const t = target && spot(target);
      if (t) L.polyline([ll, at(t)], { color: p.id === me ? "#2f6fdf" : "#7aa7f0", weight: 2, dashArray: "4 6", interactive: false }).addTo(g);
    }
    for (const v of world.venues) {
      const ll = at(v), n = altIndex[v.id], red = v.id === over, here = v.id === booked; pts.push(ll);
      const offers = Object.entries(v.offers || {}).map(([k, o]) => `${esc(k)}: $${o.price} per ${esc(o.per)}`).join("<br>");
      const touch = matchMedia("(pointer: coarse)").matches;
      const m = L.circleMarker(ll, { radius: (here || n ? 11 : 8) + (touch ? 4 : 0), color: "#111", weight: 2, fillColor: red ? "#e5484d" : here ? "#7c3aed" : n ? "#2da44e" : "#fff", fillOpacity: 1 }).addTo(g);
      if (n) m.bindTooltip(String(n), { permanent: true, direction: "center", className: "rm-num" });
      else m.bindTooltip(esc(v.name), { direction: "top" });
      m.bindPopup(`<b>${esc(v.name)}</b><br><small>${esc(v.area)} · open ${esc(v.open?.[0] || "")}-${esc(v.open?.[1] || "")}</small><br>${offers}<div class="rm-acts"><button data-plan="${esc(Object.keys(v.offers || {})[0] || "")}" data-venue="${esc(v.name)}">Plan here with Join's agent</button><a href="#/venue?id=${esc(v.id)}">Its rooms and courts</a></div>`);
    }
    // real places from OpenStreetMap: grey, not on Join (no haggling or payment there)
    for (const p of places) {
      const ll = [p.lat, p.lon]; pts.push(ll);
      L.circleMarker(ll, { radius: 6, color: "#888", weight: 1, fillColor: "#ddd", fillOpacity: 1 }).addTo(g)
        .bindPopup(`<b>${esc(p.name)}</b><br><small>${esc(p.address || "")}</small><br><small>Not on Join: book with them directly.</small><br><a href="${esc(p.url)}" target="_blank" rel="noreferrer">OpenStreetMap</a>`);
    }
    for (const p of world.publicPlaces) {
      const ll = at(p), n = altIndex[p.id]; pts.push(ll);
      const m = L.marker(ll, { icon: L.divIcon({ className: `rm-pub ${n ? "alt" : ""}`, html: n ? String(n) : "", iconSize: [16, 16] }) }).addTo(g);
      m.bindPopup(`<b>${esc(p.name)}</b><br><small>Free public place: first come, not bookable</small>`);
    }
    if (pts.length) map.current.fitBounds(L.latLngBounds(pts).pad(0.15));
  }, [world, c?.lat, c?.lon, over, booked, alternatives.map((a) => a.venue).join(), people.join(), places.length]);

  // "Plan here" in a popup opens Join's agent with a sentence to start from
  useEffect(() => {
    const f = (e) => { const b = e.target.closest?.("button[data-venue]"); if (!b) return; dispatchEvent(new Event("join:open-agent")); setTimeout(() => dispatchEvent(new CustomEvent("join:prefill", { detail: `${b.dataset.plan || "something"} at ${b.dataset.venue} this weekend, 4 of us` })), 50); };
    box.current?.addEventListener("click", f); return () => box.current?.removeEventListener("click", f);
  }, []);

  const aroundMe = () => {
    if (center) { setCenter(null); save(null); setNote(null); return; }
    if (!navigator.geolocation || !window.isSecureContext) { setNote("Your browser only shares your location with secure (https) sites, and this demo server isn't one, so the map stays where the sample town is."); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => { const x = { lat: p.coords.latitude, lon: p.coords.longitude }; setCenter(x); save(x); setNote("The sample town's venues are placed around you. They are made up: only the map underneath is real."); },
      () => setNote("Your location wasn't shared, so the map stays where the sample town is."), { timeout: 8000 });
  };
  return (
    <div className="rmap-wrap">
      <div ref={box} className="rmap" role="application" aria-label="Map of the venues" />
      <div className="rmap-bar">
        {!world?.real && <button className="btn small" onClick={aroundMe}>{center ? tr("Back to the sample town") : tr("Show around me")}</button>}
        <small className="muted">{world?.real ? "Black pins are venues on Join (bookable); grey pins are real places from OpenStreetMap, not on Join." : note || (center ? "Placed around you (made-up venues on a real map)." : `${world?.town.name || ""}. Tap or click a venue for what it offers.`)}</small>
      </div>
    </div>
  );
}

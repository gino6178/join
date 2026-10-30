// Where things are. Players share an approximate home area on the town map (km-ish map units from its top-left
// corner), never an address. Streets are not straight lines, so a trip is 1.25x the straight distance, at about 20 km/h
// through town plus 5 minutes to get going.
export const kmBetween = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) * 1.25;
export const travelMin = (a, b) => Math.round(5 + 3 * kmBetween(a, b));

// the town map and a real map: geo is where the town's top-left corner sits ({lat, lon, unitKm})
const rad = (d) => (d * Math.PI) / 180;
export const toGeo = (geo, a) => ({ lat: +(geo.lat - (a.y * geo.unitKm) / 110.57).toFixed(5), lon: +(geo.lon + (a.x * geo.unitKm) / (111.32 * Math.cos(rad(geo.lat)))).toFixed(5) });
export const toTown = (geo, p) => ({ x: +(((p.lon - geo.lon) * 111.32 * Math.cos(rad(geo.lat))) / geo.unitKm).toFixed(2), y: +(((geo.lat - p.lat) * 110.57) / geo.unitKm).toFixed(2) });

// each person's trip to a place, and the longest of them: the fair place is the one whose longest trip is shortest
export function trips(people, place) {
  const list = people.filter((p) => p.area).map((p) => ({ id: p.id, min: travelMin(p.area, place) }));
  return { list, longest: Math.max(0, ...list.map((t) => t.min)) };
}

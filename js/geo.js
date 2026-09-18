/* geo.js — finding out where the user is, and how far things are apart. */

const PHOTON = 'https://photon.komoot.io/api/';

/** Great-circle distance in metres. */
export function haversine(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Search for a place by name. Photon is the OSM-based geocoder behind Komoot;
 *  it allows browser calls and is built for as-you-type search. */
export async function searchPlaces(query, { limit = 6, signal } = {}) {
  const q = query.trim();
  if (q.length < 2) return [];

  const url = `${PHOTON}?q=${encodeURIComponent(q)}&limit=${limit}&lang=en`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error('Search is unavailable right now');
  const data = await res.json();

  return (data.features || [])
    .map((f) => {
      const p = f.properties || {};
      const [lon, lat] = f.geometry.coordinates;
      const context = [p.city && p.city !== p.name ? p.city : null, p.state, p.country]
        .filter(Boolean)
        .join(', ');
      return {
        name: p.name || p.street || 'Unnamed place',
        context,
        lat,
        lon,
        kind: p.osm_value || p.type || '',
      };
    })
    .filter((p) => p.name);
}

/** Reverse geocode a coordinate so "use my location" can show a place name. */
export async function describeCoords({ lat, lon }) {
  try {
    const res = await fetch(`${PHOTON}reverse?lat=${lat}&lon=${lon}&lang=en`);
    if (!res.ok) throw new Error();
    const data = await res.json();
    const p = data.features?.[0]?.properties;
    if (!p) throw new Error();
    return {
      name: p.city || p.name || p.district || 'Your location',
      context: [p.district && p.district !== p.city ? p.district : null, p.country]
        .filter(Boolean)
        .join(', '),
      lat,
      lon,
    };
  } catch {
    return { name: 'Your location', context: '', lat, lon };
  }
}

/** Ask the browser where we are. Wrapped because the callback API is awkward
 *  and because the error codes deserve human sentences. */
export function currentPosition({ timeout = 12000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('This browser has no location support'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      (err) => {
        const messages = {
          1: 'Location permission was denied — you can still search for a city by name',
          2: 'Your position could not be determined right now',
          3: 'Looking for your position took too long',
        };
        reject(new Error(messages[err.code] || 'Could not get your location'));
      },
      { enableHighAccuracy: true, timeout, maximumAge: 60000 }
    );
  });
}

/** Bounding box (in degrees) around a point, for map fitting. */
export function boundsOf(points, padding = 0.004) {
  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);
  return [
    [Math.min(...lats) - padding, Math.min(...lons) - padding],
    [Math.max(...lats) + padding, Math.max(...lons) + padding],
  ];
}

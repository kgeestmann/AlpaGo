/* map.js — a thin wrapper over Leaflet so the rest of the app never has to
 * think about tile layers or marker lifecycles. */

import { boundsOf } from './geo.js';
import { FOOD_CATEGORIES } from './places.js';

let map = null;
let layer = null;
let lastFit = [];

function ensureMap() {
  if (map) return map;

  map = L.map('map', {
    zoomControl: false,
    attributionControl: true,
    tap: true,
  }).setView([52.52, 13.405], 13);

  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    // The OSM tile policy asks for visible attribution. It stays.
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);

  L.control.zoom({ position: 'bottomright' }).addTo(map);
  layer = L.layerGroup().addTo(map);
  return map;
}

function numberedPin(n, place) {
  const food = place && FOOD_CATEGORIES.has(place.category);
  return L.divIcon({
    className: '',
    html: `<div class="pin${food ? ' is-food' : ''}">${n}</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

function startPin() {
  return L.divIcon({
    className: '',
    html: '<div class="pin is-start">●</div>',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

/**
 * Draw a whole plan. `onStop` fires when a marker is tapped.
 */
export function drawRoute({ origin, stops, geometry }, onStop) {
  const m = ensureMap();
  layer.clearLayers();

  if (origin) {
    L.marker([origin.lat, origin.lon], { icon: startPin(), title: 'Start' }).addTo(layer);
  }

  stops.forEach((stop, i) => {
    const marker = L.marker([stop.lat, stop.lon], {
      icon: numberedPin(i + 1, stop),
      title: stop.name,
    }).addTo(layer);
    marker.on('click', () => onStop?.(stop, i));
  });

  if (geometry && geometry.length > 1) {
    L.polyline(geometry, { color: '#147a82', weight: 4, opacity: 0.85 }).addTo(layer);
  } else if (stops.length) {
    // No real path available — a dashed straight line makes it obvious that
    // this is the order of stops, not the actual walking route.
    const pts = [origin, ...stops].filter(Boolean).map((p) => [p.lat, p.lon]);
    L.polyline(pts, { color: '#147a82', weight: 3, opacity: 0.6, dashArray: '6 8' }).addTo(layer);
  }

  lastFit = [origin, ...stops].filter(Boolean);

  // Order matters. The map is built while the Route screen is still
  // display:none, so Leaflet measures the container as 0x0. Fitting bounds
  // against that gives a nonsense centre and zoom, and the pins end up off
  // screen even though they are in the DOM. Re-measure first, fit second, and
  // do it again on the next frame for when the screen has only just appeared.
  fit();
  setTimeout(fit, 80);
}

function fit() {
  if (!map || !lastFit.length) return;
  map.invalidateSize();
  if (lastFit.length === 1) map.setView([lastFit[0].lat, lastFit[0].lon], 15);
  else map.fitBounds(boundsOf(lastFit), { padding: [28, 28] });
}

export function focusStop(stop) {
  if (!map) return;
  map.setView([stop.lat, stop.lon], Math.max(map.getZoom(), 16), { animate: true });
}

export function refresh() {
  if (!map) return;
  fit();
  setTimeout(fit, 80);
}

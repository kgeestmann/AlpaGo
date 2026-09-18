/* sw.js — offline support.
 *
 * Two caches with different rules:
 *   shell   — the app's own files. Cache-first, refreshed on version bump.
 *   tiles   — OpenStreetMap map tiles. Cache-first with a hard cap, so a route
 *             you looked at yesterday still shows a map in a dead zone today.
 *
 * API calls (Overpass, Photon, OSRM, Wikipedia, Anthropic) are deliberately
 * never cached here — they are cached in localStorage by state.js, where the
 * app can reason about freshness. */

const VERSION = 'alpago-v1.0.0';
const SHELL = VERSION + '-shell';
const TILES = 'alpago-tiles-v1';
const TILE_CAP = 320;

const SHELL_FILES = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './js/app.js',
  './js/state.js',
  './js/geo.js',
  './js/places.js',
  './js/route.js',
  './js/enrich.js',
  './js/map.js',
  './js/ui.js',
  './vendor/leaflet.js',
  './vendor/leaflet.css',
  './vendor/images/marker-icon.png',
  './vendor/images/marker-icon-2x.png',
  './vendor/images/marker-shadow.png',
  './vendor/images/layers.png',
  './vendor/images/layers-2x.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((k) => k !== SHELL && k !== TILES)
          .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

async function trimTiles() {
  const cache = await caches.open(TILES);
  const keys = await cache.keys();
  if (keys.length <= TILE_CAP) return;
  // Oldest-first is close enough; Cache API keeps insertion order.
  await Promise.all(keys.slice(0, keys.length - TILE_CAP).map((k) => cache.delete(k)));
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Map tiles: serve from cache, fill in behind.
  if (/tile\.openstreetmap\.org$/.test(url.hostname)) {
    event.respondWith(
      caches.open(TILES).then(async (cache) => {
        const hit = await cache.match(request);
        if (hit) return hit;
        try {
          const res = await fetch(request);
          if (res.ok || res.type === 'opaque') {
            cache.put(request, res.clone());
            trimTiles();
          }
          return res;
        } catch {
          return hit || Response.error();
        }
      })
    );
    return;
  }

  // Anything else on another origin is a live API call — straight through.
  if (url.origin !== location.origin) return;

  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) {
        // Refresh in the background so the next launch is current.
        fetch(request)
          .then((res) => res.ok && caches.open(SHELL).then((c) => c.put(request, res)))
          .catch(() => {});
        return hit;
      }
      return fetch(request).catch(() => caches.match('./index.html'));
    })
  );
});

/* places.js — pulling real places out of OpenStreetMap via Overpass,
 * then deciding which of them are worth a tourist's afternoon.
 *
 * Overpass returns everything: every bench, every postbox. The interesting
 * work is the scoring below, which is what separates "here are 400 nodes"
 * from "here are the twelve things you actually came for". */

import { haversine } from './geo.js';
import { cache } from './state.js';

/* Measured from a phone in Sweden, September 2026: overpass-api.de answered a
 * Malmo query in 0.5 s, then 504'd a trivial one a minute later, then took 34 s
 * on a third. The public instances are healthy and overloaded by turns, which
 * is why this file fans out rather than trusting any single one.
 *
 * overpass.osm.ch is deliberately absent: it answers fast with 200 OK and zero
 * elements outside Switzerland, which is worse than failing. overpass.osm.jp
 * sends no CORS headers, so a browser can never read it. */
const PRIMARY = 'https://overpass-api.de/api/interpreter';
const BACKUPS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

/* Each interest maps to a set of Overpass tag filters, plus how long a
 * visit realistically takes and how much of a detour it justifies. */
export const CATEGORIES = {
  sights: {
    label: 'Landmarks',
    icon: '🏛',
    minutes: 25,
    weight: 1.0,
    filters: [
      '["tourism"="attraction"]',
      '["tourism"="viewpoint"]',
      '["historic"~"^(monument|memorial|castle|fort|ruins|city_gate|tower|archaeological_site)$"]',
      '["man_made"="tower"]["tourism"]',
      '["amenity"="place_of_worship"]["heritage"]',
      '["building"~"^(cathedral|church)$"]["heritage"]',
    ],
  },
  museums: {
    label: 'Museums',
    icon: '🖼',
    minutes: 75,
    weight: 1.0,
    filters: ['["tourism"="museum"]', '["tourism"="gallery"]'],
  },
  parks: {
    label: 'Parks & green',
    icon: '🌳',
    minutes: 30,
    weight: 0.85,
    filters: [
      '["leisure"="park"]',
      '["leisure"="garden"]["access"!="private"]',
      '["natural"="beach"]',
      '["leisure"="nature_reserve"]',
    ],
  },
  food: {
    label: 'Food & coffee',
    icon: '☕',
    minutes: 45,
    weight: 0.8,
    filters: [
      '["amenity"="cafe"]',
      '["amenity"="restaurant"]',
      '["amenity"="ice_cream"]',
      '["amenity"="marketplace"]',
    ],
  },
  views: {
    label: 'Views & water',
    icon: '🌉',
    minutes: 20,
    weight: 0.9,
    filters: [
      '["tourism"="viewpoint"]',
      '["man_made"="bridge"]',
      '["man_made"="pier"]',
      '["man_made"="lighthouse"]',
    ],
  },
  shopping: {
    label: 'Shopping',
    icon: '🛍',
    minutes: 40,
    weight: 0.6,
    filters: [
      '["shop"="mall"]',
      '["shop"="department_store"]',
      '["amenity"="marketplace"]',
      '["shop"="books"]',
    ],
  },
  nightlife: {
    label: 'Bars',
    icon: '🍺',
    minutes: 50,
    weight: 0.7,
    filters: ['["amenity"="bar"]', '["amenity"="pub"]', '["amenity"="biergarten"]'],
  },
  art: {
    label: 'Street art',
    icon: '🎨',
    minutes: 15,
    weight: 0.75,
    filters: [
      '["tourism"="artwork"]',
      '["artwork_type"]',
      '["historic"="memorial"]["memorial"="statue"]',
    ],
  },
};

export const FOOD_CATEGORIES = new Set(['food', 'nightlife']);

/* ── Overpass ─────────────────────────────── */

function buildQuery(center, radiusM, interests) {
  // Three things keep this query cheap, which matters because Overpass is a
  // shared, donation-funded service and a fat query can take a minute:
  //   `nwr`      one statement for nodes, ways and relations instead of two
  //              or three ("center" still gives each one a single coordinate);
  //   ["name"]   we discard unnamed objects anyway, and this throws away the
  //              overwhelming majority of matches server-side rather than
  //              shipping them over a phone connection first;
  //   the Set    categories overlap (viewpoints are in both Landmarks and
  //              Views; markets in both Food and Shopping) and a duplicated
  //              filter is a duplicated scan.
  const around = `(around:${radiusM},${center.lat.toFixed(5)},${center.lon.toFixed(5)})`;
  const filters = new Set();
  for (const key of interests) {
    for (const f of CATEGORIES[key]?.filters || []) filters.add(f);
  }
  const parts = [...filters].map((f) => `nwr${f}["name"]${around};`);
  return `[out:json][timeout:25];(${parts.join('')});out center 350;`;
}

/* A server that stops answering must not hang the app, and a server that
 * answers "" must not be mistaken for "there is nothing here". Both were real
 * failures: a silent 25-second stall, and an empty result set that was actually
 * an Overpass timeout carrying a `remark` this code used to ignore. */
const PRIMARY_TIMEOUT_MS = 9000;
const BACKUP_TIMEOUT_MS = 16000;

const hostOf = (url) => new URL(url).hostname;

function askOverpass(url, query, signal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const relay = () => controller.abort();
  signal?.addEventListener('abort', relay, { once: true });

  const promise = fetch(url, {
    method: 'POST',
    body: 'data=' + encodeURIComponent(query),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    signal: controller.signal,
  })
    .then(async (res) => {
      if (!res.ok) throw new Error(`${hostOf(url)} returned ${res.status}`);
      const data = await res.json();
      // Overpass reports its own timeouts and rate limits in-band, with a 200
      // and an empty element list. Without this check that reads as "this city
      // has nothing in it".
      if (data.remark) throw new Error(`${hostOf(url)}: ${data.remark}`);
      return data;
    })
    .catch((err) => {
      // Our own deadline and the user pressing Cancel both arrive as an
      // AbortError. Only the second one may stay an AbortError — otherwise a
      // timed-out server is mistaken for a cancellation and the app gives up
      // without saying anything, which is exactly how a silent failure looks.
      if (signal?.aborted) throw err;
      if (err.name === 'AbortError') throw new Error(`${hostOf(url)} stopped responding`);
      throw err;
    })
    .finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', relay);
    });

  return { promise, abort: () => controller.abort() };
}

/** Resolve with the first answer that actually has places in it. An empty but
 *  valid answer is held as a fallback rather than winning the race, because a
 *  regional mirror outside its own region answers empty in milliseconds. */
function firstUsable(attempts, signal) {
  return new Promise((resolve, reject) => {
    let outstanding = attempts.length;
    let empty = null;
    let lastError = null;
    let done = false;

    const finish = (fn, value) => {
      if (done) return;
      done = true;
      for (const a of attempts) a.abort();
      fn(value);
    };

    for (const attempt of attempts) {
      attempt.promise
        .then((data) => {
          if (data.elements?.length) finish(resolve, data);
          else empty = empty || data;
        })
        .catch((err) => { lastError = err; })
        .finally(() => {
          if (--outstanding > 0 || done) return;
          if (signal?.aborted) finish(reject, new DOMException('cancelled', 'AbortError'));
          else if (empty) finish(resolve, empty);
          else finish(reject, lastError || new Error('No map data server answered'));
        });
    }
  });
}

async function runOverpass(query, signal, onProgress) {
  if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');

  // Happy path: one request to one server. Only when that is slow or unwell do
  // we bother the others — fanning out on every lookup would be rude to
  // services that run on donations.
  try {
    return await firstUsable([askOverpass(PRIMARY, query, signal, PRIMARY_TIMEOUT_MS)], signal);
  } catch (err) {
    if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');

    onProgress?.(err);

    // All of them at once, not one after another. Sequential fallbacks were the
    // bug the user saw: two dead mirrors at 22 seconds each meant a minute of
    // spinner before the third was even tried.
    const attempts = [PRIMARY, ...BACKUPS].map((url) =>
      askOverpass(url, query, signal, BACKUP_TIMEOUT_MS)
    );
    try {
      return await firstUsable(attempts, signal);
    } catch (err2) {
      if (signal?.aborted || err2.name === 'AbortError') throw err2;
      throw new Error(
        "OpenStreetMap's data servers are all busy right now. " +
        'This happens; give it a minute and try again.'
      );
    }
  }
}

/* ── normalising ──────────────────────────── */

function categoryOf(tags) {
  const t = tags || {};
  if (t.tourism === 'museum' || t.tourism === 'gallery') return 'museums';
  if (t.amenity === 'cafe' || t.amenity === 'restaurant' || t.amenity === 'ice_cream') return 'food';
  if (t.amenity === 'bar' || t.amenity === 'pub' || t.amenity === 'biergarten') return 'nightlife';
  if (t.leisure === 'park' || t.leisure === 'garden' || t.leisure === 'nature_reserve' || t.natural === 'beach') return 'parks';
  if (t.tourism === 'artwork' || t.artwork_type) return 'art';
  if (t.tourism === 'viewpoint' || t.man_made === 'lighthouse' || t.man_made === 'pier') return 'views';
  if (t.shop || t.amenity === 'marketplace') return 'shopping';
  return 'sights';
}

function kindLabel(tags) {
  const t = tags || {};
  const named = {
    museum: 'Museum', gallery: 'Gallery', attraction: 'Attraction',
    viewpoint: 'Viewpoint', artwork: 'Artwork',
    cafe: 'Café', restaurant: 'Restaurant', ice_cream: 'Ice cream',
    bar: 'Bar', pub: 'Pub', biergarten: 'Beer garden',
    park: 'Park', garden: 'Garden', nature_reserve: 'Nature reserve',
    monument: 'Monument', memorial: 'Memorial', castle: 'Castle',
    ruins: 'Ruins', fort: 'Fort', city_gate: 'City gate', tower: 'Tower',
    archaeological_site: 'Archaeological site',
    place_of_worship: 'Place of worship', marketplace: 'Market',
    mall: 'Shopping centre', department_store: 'Department store', books: 'Bookshop',
    beach: 'Beach', lighthouse: 'Lighthouse', pier: 'Pier', bridge: 'Bridge',
  };
  for (const key of ['tourism', 'historic', 'leisure', 'amenity', 'shop', 'natural', 'man_made']) {
    if (t[key] && named[t[key]]) return named[t[key]];
  }
  if (t.cuisine) return t.cuisine.split(';')[0].replace(/_/g, ' ');
  return 'Place';
}

function normalise(el) {
  const tags = el.tags || {};
  const name = tags.name || tags['name:en'];
  if (!name) return null; // an unnamed node is not somewhere you can "go"

  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (lat == null || lon == null) return null;

  return {
    id: `${el.type}/${el.id}`,
    name,
    lat,
    lon,
    category: categoryOf(tags),
    kind: kindLabel(tags),
    wikidata: tags.wikidata || null,
    wikipedia: tags.wikipedia || null,
    website: tags.website || tags['contact:website'] || null,
    openingHours: tags.opening_hours || null,
    cuisine: tags.cuisine ? tags.cuisine.split(';')[0].replace(/_/g, ' ') : null,
    fee: tags.fee === 'yes' ? 'Entry fee' : tags.fee === 'no' ? 'Free entry' : null,
    wheelchair: tags.wheelchair || null,
    heritage: !!(tags.heritage || tags['heritage:operator']),
    address: [tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(' ') || null,
  };
}

/* ── scoring ──────────────────────────────────
 * The single most useful signal in OSM for "is this worth seeing" is whether
 * somebody bothered to link it to Wikidata or Wikipedia. Locals tag the
 * cathedral; nobody tags the third-best bench. */

function score(place, center, interests, mobility) {
  const cat = CATEGORIES[place.category];
  let s = (cat?.weight ?? 0.5) * 100;

  if (interests.includes(place.category)) s += 55;
  else s -= 25; // still allowed in, but has to earn its place

  if (place.wikidata) s += 45;
  if (place.wikipedia) s += 30;
  if (place.heritage) s += 25;
  if (place.website) s += 8;
  if (place.openingHours) s += 6;

  // Distance from the centre of the search, gently discouraged.
  const d = haversine(center, place);
  s -= Math.min(60, (d / 1000) * 22);

  if (mobility === 'accessible') {
    if (place.wheelchair === 'yes') s += 35;
    else if (place.wheelchair === 'limited') s += 8;
    else if (place.wheelchair === 'no') s -= 500; // effectively excluded
  }

  return s;
}

/** Two cafés 25 m apart are one decision, not two. Also kills the classic
 *  OSM duplicate where a building and its node both carry the same name. */
function dedupe(places) {
  const out = [];
  for (const p of places) {
    const clash = out.find(
      (q) =>
        haversine(p, q) < 60 &&
        (q.name === p.name || q.category === p.category)
    );
    if (!clash) out.push(p);
    else if ((clash.wikidata ? 1 : 0) < (p.wikidata ? 1 : 0)) {
      out[out.indexOf(clash)] = p; // keep the better-documented twin
    }
  }
  return out;
}

/** Radius that roughly matches how far someone will actually stray. */
export function searchRadius(hours, mobility) {
  const base = 700 + hours * 260;
  const factor = mobility === 'transit' ? 2.4 : mobility === 'accessible' ? 0.8 : 1;
  return Math.round(Math.min(9000, base * factor));
}

/**
 * Fetch and rank candidate stops around a centre point.
 * Returns places sorted best-first, already deduped and scored.
 */
export async function findPlaces(center, { interests, hours, mobility, signal, onProgress }) {
  const radius = searchRadius(hours, mobility);

  // Always query a slightly wider net than the user's interests, so the
  // optimiser has something to fall back on when an interest is thin.
  const queryCats = Array.from(new Set([...interests, 'sights']));
  const cacheKey = [
    'places',
    center.lat.toFixed(3),
    center.lon.toFixed(3),
    radius,
    queryCats.slice().sort().join('+'),
  ].join(':');

  let elements = cache.get(cacheKey);
  if (!elements) {
    const data = await runOverpass(buildQuery(center, radius, queryCats), signal, onProgress);
    elements = (data.elements || []).map((el) => ({
      type: el.type, id: el.id, lat: el.lat, lon: el.lon, center: el.center, tags: el.tags,
    }));
    cache.set(cacheKey, elements);
  }

  const places = dedupe(
    elements
      .map(normalise)
      .filter(Boolean)
      .filter((p) => haversine(center, p) <= radius * 1.15)
  );

  for (const p of places) p.score = score(p, center, interests, mobility);

  return places
    .filter((p) => p.score > -100)
    .sort((a, b) => b.score - a.score);
}

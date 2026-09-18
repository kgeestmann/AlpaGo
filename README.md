# AlpaGo

**Pick a city, say how long you've got, get a day.**

AlpaGo builds an optimised walking route through any city in the world from real
OpenStreetMap data — actual landmarks, museums, parks and cafés, ordered so you
don't zigzag, timed so it fits the hours you actually have.

It's a single-page web app with no build step, no backend and no account. Host
the folder anywhere static and it installs on an Android phone like a normal app.

---

## Running it

### On your phone (the point of the whole thing)

1. Push this repo to GitHub.
2. **Settings → Pages → Source: Deploy from a branch → `main` / `(root)` → Save.**
3. Wait a minute, then open `https://<your-username>.github.io/AlpaGo/` in Chrome on Android.
4. Menu (⋮) → **Add to Home screen**.

It now has its own icon, opens fullscreen with no browser bar, and launches
offline (saved routes and previously viewed map tiles work with no signal —
building a *new* route needs a connection, since that's where the map data
comes from).

### On your laptop

Any static server will do. Opening `index.html` as a `file://` URL will **not**
work — ES modules and the service worker both need a real origin.

```bash
python -m http.server 8080
# then http://localhost:8080
```

---

## How it actually works

There are four network services behind it, all free, none requiring a key:

| What | Service | Used for |
|---|---|---|
| City search | [Photon](https://photon.komoot.io) | as-you-type search and reverse geocoding |
| Place data | [Overpass API](https://overpass-api.de) | every museum, park, café and monument near you |
| Walking times | [OSRM](https://routing.openstreetmap.de) | real footpath distances and the line on the map |
| Descriptions | Wikipedia REST API | what a place actually is |
| Map tiles | OpenStreetMap | the map |

### Picking the stops

Overpass hands back everything, which for a city centre means several hundred
objects, most of which nobody would cross the road for. The interesting work is
in `js/places.js`, which scores each candidate on:

- whether it matches what you said you're into,
- **whether it's linked to Wikidata or Wikipedia** — by far the strongest
  available signal for "is this worth seeing", because locals bother to tag the
  cathedral and nobody bothers to tag the third-best bench,
- heritage listing, having a website, having opening hours,
- distance from where you are,
- step-free access, when you've asked for that.

Near-duplicates get merged (OSM routinely has the same place as both a node and
a building outline).

### Ordering them

Choosing *which* stops and *in what order* under a time budget is an
orienteering problem — NP-hard, so `js/route.js` uses the standard practical
approach:

1. **Greedy cheapest insertion.** Repeatedly add the stop with the best
   value-per-added-minute, trying every position in the current route, until the
   budget runs out. Category caps stop it handing you four museums.
2. **2-opt.** Repeatedly reverse route segments while that shortens the trip.
   This is what removes the crossings you'd otherwise see on the map.
3. **Meal placement.** If a food stop is in the route, slide it to wherever it
   lands closest to 13:00 (or 19:00 for a bar), then 2-opt again.
4. **Real distances.** OSRM is asked for the actual footpath legs and the
   geometry to draw. If it's unreachable, straight-line distance × 1.32 at
   4.6 km/h is used instead, and the app labels those legs *(estimated)*.

### Optional: Claude

Everything above works with no API key. Add an Anthropic API key under **More**
and two extra things light up:

- a short intro paragraph framing the day, and
- the free-text wish box — *"somewhere quiet with good coffee, no museums"* gets
  turned into interest and pace settings before the route is built.

The key is stored in `localStorage` on that device only and is sent only to
`api.anthropic.com`. Cost is roughly a tenth of a cent per route on Haiku. This
is **separate from a Claude.ai subscription** — subscriptions don't cover API
calls; you need credit on an [Anthropic API account](https://console.anthropic.com).

If you'd rather not, ignore it. The route quality doesn't depend on it.

---

## Layout

```
index.html                 app shell, all four screens
styles.css                 phone-first, dark mode included
manifest.webmanifest       makes it installable
sw.js                      offline: app shell + map tile cache
js/
  app.js                   wiring, session state
  state.js                 localStorage: settings, saved routes, lookup cache
  geo.js                   geocoding, geolocation, distance
  places.js                Overpass queries, categories, scoring
  route.js                 the optimiser, scheduling, Google Maps hand-off
  enrich.js                Wikipedia, and the optional Claude calls
  map.js                   Leaflet wrapper
  ui.js                    rendering only
vendor/                    Leaflet 1.9.4, vendored so it works offline
icons/                     app icons
```

No dependencies to install. Leaflet is the only third-party code and it's
committed here on purpose, so the app has no CDN to fail.

---

## Known limits

- **"Public transport" is an approximation.** There's no timetable data behind
  it — it widens the search radius and assumes a faster average speed. Treat the
  times as indicative.
- **Opening hours are shown, not enforced.** OSM's `opening_hours` syntax is its
  own small language; the route won't currently avoid sending you to a museum on
  a Monday.
- **Place coverage is as good as OSM is locally.** Excellent across Europe,
  patchier elsewhere.
- Overpass and OSRM are donation-funded public instances. Lookups are cached for
  a week in `localStorage` partly to be polite to them.
- **First lookup in a new city takes 5–20 seconds.** The query asks Overpass for
  every named landmark, museum, park and café in a radius, and that is simply
  not instant. Repeat visits to the same city are served from cache and are
  immediate. If the main server hasn't answered within 9 seconds, AlpaGo asks
  it and three backup servers at once and takes the first useful answer; the
  loader shows the elapsed time and a Cancel button throughout, so it can never
  hang silently.

---

## Attribution

Place and map data © [OpenStreetMap](https://www.openstreetmap.org/copyright)
contributors, [ODbL](https://opendatacommons.org/licenses/odbl/). Descriptions
from Wikipedia (CC BY-SA). Geocoding by Photon, routing by the OSRM demo server.
Leaflet is BSD-2-Clause.

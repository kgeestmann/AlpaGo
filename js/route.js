/* route.js — turning a pile of candidate places into one day.
 *
 * This is an orienteering problem: every stop has a value and a cost, the
 * budget is the hours the user has, and the goal is the most worthwhile
 * subset *in the best order*. Exact solutions are NP-hard; a greedy
 * cheapest-insertion pass followed by 2-opt gets within a few percent and
 * runs in milliseconds on a phone. */

import { haversine } from './geo.js';
import { CATEGORIES, FOOD_CATEGORIES } from './places.js';

const PACE = { relaxed: 1.3, normal: 1.0, packed: 0.78 };

const MOBILITY = {
  foot:       { kmh: 4.6, detour: 1.32, overheadMin: 0, profile: 'foot' },
  transit:    { kmh: 11,  detour: 1.25, overheadMin: 5, profile: 'foot' },
  accessible: { kmh: 3.6, detour: 1.40, overheadMin: 2, profile: 'foot' },
};

/* How many of one kind of thing anyone actually wants in a day. */
function categoryCaps(hours) {
  return {
    museums:   hours >= 7 ? 2 : 1,
    food:      hours >= 8 ? 2 : 1,
    nightlife: 1,
    shopping:  1,
    sights:    hours >= 8 ? 5 : 4,
    parks:     2,
    views:     2,
    art:       3,
  };
}

/* ── travel-time estimation ───────────────── */

function estimateMinutes(a, b, mobility) {
  const m = MOBILITY[mobility] || MOBILITY.foot;
  const metres = haversine(a, b) * m.detour;
  return (metres / 1000 / m.kmh) * 60 + (metres > 400 ? m.overheadMin : 0);
}

function visitMinutes(place, pace) {
  const base = CATEGORIES[place.category]?.minutes ?? 25;
  return Math.round(base * (PACE[pace] ?? 1));
}

/* ── selection: greedy cheapest insertion ── */

function routeCost(order, origin, mobility) {
  let total = 0;
  let prev = origin;
  for (const stop of order) {
    total += estimateMinutes(prev, stop, mobility);
    prev = stop;
  }
  return total;
}

function pickStops(candidates, origin, opts) {
  const { budgetMin, mobility, pace, loop, jitter = 0, interests = [] } = opts;
  const caps = categoryCaps(budgetMin / 60);
  const counts = {};
  const chosen = [];

  let travelMin = 0;
  let visitMin = 0;

  // Leave a little slack — nobody enjoys a schedule with zero give.
  const usable = budgetMin * 0.94;

  const pool = candidates.map((p) => ({
    ...p,
    value: p.score + (jitter ? (Math.random() - 0.5) * jitter : 0),
  }));

  /* Insert one place at its cheapest position, if it fits in `ceiling`. */
  const tryInsert = (cand, ceiling) => {
    if (chosen.includes(cand)) return false;
    if ((counts[cand.category] || 0) >= (caps[cand.category] ?? 3)) return false;

    const stay = visitMinutes(cand, pace);
    let best = null;
    for (let i = 0; i <= chosen.length; i++) {
      const trial = chosen.slice();
      trial.splice(i, 0, cand);
      let cost = routeCost(trial, origin, mobility);
      if (loop && trial.length) cost += estimateMinutes(trial[trial.length - 1], origin, mobility);
      const delta = cost - travelMin + stay;
      if (travelMin + visitMin + delta > ceiling) continue;
      if (!best || cost < best.cost) best = { index: i, cost, stay, delta };
    }
    if (!best) return false;

    chosen.splice(best.index, 0, cand);
    counts[cand.category] = (counts[cand.category] || 0) + 1;
    travelMin = best.cost;
    visitMin += best.stay;
    return true;
  };

  /* Coverage pass. Greedy value-per-minute alone will happily fill a day with
   * cheap 25-minute landmarks and never spend 75 minutes on a museum, so the
   * user ticks "Museums" and gets none. Seed the best candidate of each chosen
   * interest first, inside a reduced ceiling so there is still room to fill in
   * around them. Expensive categories go first — they need the space. */
  const seedOrder = interests
    .slice()
    .sort((a, b) => (CATEGORIES[b]?.minutes ?? 0) - (CATEGORIES[a]?.minutes ?? 0));

  for (const key of seedOrder) {
    const best = pool.find((p) => p.category === key && !chosen.includes(p));
    if (best) tryInsert(best, usable * 0.8);
  }

  while (true) {
    let best = null;

    for (const cand of pool) {
      if (chosen.includes(cand)) continue;
      if ((counts[cand.category] || 0) >= (caps[cand.category] ?? 3)) continue;

      const stay = visitMinutes(cand, pace);

      // Try every insertion slot and keep the cheapest one.
      for (let i = 0; i <= chosen.length; i++) {
        const trial = chosen.slice();
        trial.splice(i, 0, cand);
        let cost = routeCost(trial, origin, mobility);
        if (loop && trial.length) cost += estimateMinutes(trial[trial.length - 1], origin, mobility);

        const deltaTravel = cost - travelMin;
        const deltaTotal = deltaTravel + stay;
        if (travelMin + visitMin + deltaTotal > usable) continue;

        const ratio = cand.value / Math.max(6, deltaTotal);
        if (!best || ratio > best.ratio) {
          best = { cand, index: i, ratio, cost, stay };
        }
      }
    }

    if (!best) break;

    chosen.splice(best.index, 0, best.cand);
    counts[best.cand.category] = (counts[best.cand.category] || 0) + 1;
    travelMin = best.cost;
    visitMin += best.stay;

    if (chosen.length >= 12) break;
  }

  return chosen;
}

/* ── 2-opt: untangle the route ────────────── */

function twoOpt(order, origin, mobility, loop) {
  if (order.length < 4) return order;

  const cost = (arr) => {
    let c = routeCost(arr, origin, mobility);
    if (loop && arr.length) c += estimateMinutes(arr[arr.length - 1], origin, mobility);
    return c;
  };

  let best = order.slice();
  let bestCost = cost(best);
  let improved = true;
  let guard = 0;

  while (improved && guard++ < 60) {
    improved = false;
    for (let i = 0; i < best.length - 1; i++) {
      for (let k = i + 1; k < best.length; k++) {
        const trial = best.slice(0, i).concat(best.slice(i, k + 1).reverse(), best.slice(k + 1));
        const c = cost(trial);
        if (c < bestCost - 0.01) {
          best = trial;
          bestCost = c;
          improved = true;
        }
      }
    }
  }
  return best;
}

/* A meal in the middle beats a meal at the end. If the day covers a mealtime
 * and the user asked for food, nudge the food stop towards that slot. */
function placeMealSensibly(order, startMinutes, pace, mobility, origin) {
  const foodIdx = order.findIndex((p) => FOOD_CATEGORIES.has(p.category));
  if (foodIdx === -1) return order;

  const food = order[foodIdx];
  const rest = order.filter((_, i) => i !== foodIdx);

  let bestOrder = order;
  let bestGap = Infinity;

  for (let i = 0; i <= rest.length; i++) {
    const trial = rest.slice();
    trial.splice(i, 0, food);
    // When would we arrive at the food stop in this arrangement?
    let t = startMinutes;
    let prev = origin;
    for (const stop of trial) {
      t += estimateMinutes(prev, stop, mobility);
      if (stop === food) break;
      t += visitMinutes(stop, pace);
      prev = stop;
    }
    // Target 13:00 for a meal, 19:00 for a bar.
    const target = food.category === 'nightlife' ? 19 * 60 : 13 * 60;
    const gap = Math.abs(t - target);
    if (gap < bestGap) {
      bestGap = gap;
      bestOrder = trial;
    }
  }
  return bestOrder;
}

/* ── real walking geometry from OSRM ──────── */

const OSRM = 'https://routing.openstreetmap.de/routed-foot/route/v1/foot/';

async function fetchLegs(points, signal) {
  if (points.length < 2) return null;
  // OSRM's public instance is generous but not infinite; a dozen waypoints
  // is well inside what it will answer in one request.
  const coords = points.map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  const url = `${OSRM}${coords}?overview=full&geometries=geojson&annotations=false`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  signal?.addEventListener('abort', () => controller.abort(), { once: true });

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json();
    const route = data.routes?.[0];
    if (!route) return null;
    return {
      legs: route.legs.map((l) => ({
        minutes: Math.round(l.duration / 60),
        metres: Math.round(l.distance),
      })),
      geometry: route.geometry?.coordinates?.map(([lon, lat]) => [lat, lon]) || null,
      real: true,
    };
  } catch {
    return null; // offline, blocked, or slow — the estimate below is fine
  } finally {
    clearTimeout(timer);
  }
}

/* ── the schedule ─────────────────────────── */

function parseTime(hhmm) {
  const [h, m] = (hhmm || '10:00').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

export function formatTime(minutes) {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`;
}

export function formatDuration(minutes) {
  const m = Math.round(minutes);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h} h ${rem} min` : `${h} h`;
}

export function formatDistance(metres) {
  return metres < 1000 ? `${Math.round(metres / 10) * 10} m` : `${(metres / 1000).toFixed(1)} km`;
}

/**
 * Build a full day plan.
 *
 * @returns {{stops:Array, legs:Array, geometry:Array|null, totals:Object}}
 */
export async function buildRoute(candidates, origin, opts) {
  const {
    hours, pace = 'normal', mobility = 'foot',
    startTime = '10:00', loop = false, jitter = 0, interests = [], signal,
  } = opts;

  const budgetMin = hours * 60;
  const startMinutes = parseTime(startTime);

  let order = pickStops(candidates.slice(0, 90), origin, {
    budgetMin, mobility, pace, loop, jitter, interests,
  });

  if (!order.length) {
    return { stops: [], legs: [], geometry: null, totals: null, empty: true };
  }

  order = twoOpt(order, origin, mobility, loop);
  order = placeMealSensibly(order, startMinutes, pace, mobility, origin);
  order = twoOpt(order, origin, mobility, loop);

  // Ask OSRM for the real footpath distances and the line to draw.
  const waypoints = loop ? [origin, ...order, origin] : [origin, ...order];
  const routed = await fetchLegs(waypoints, signal);

  const legs = [];
  const stops = [];
  let clock = startMinutes;
  let prev = origin;
  let totalWalkM = 0;

  order.forEach((place, i) => {
    const measured = routed?.legs?.[i];
    const travel = measured ? Math.max(1, measured.minutes) : Math.round(estimateMinutes(prev, place, mobility));
    const metres = measured ? measured.metres : Math.round(haversine(prev, place) * (MOBILITY[mobility]?.detour ?? 1.3));

    legs.push({ minutes: travel, metres, estimated: !measured });
    totalWalkM += metres;
    clock += travel;

    const stay = visitMinutes(place, pace);
    stops.push({
      ...place,
      arrive: clock,
      depart: clock + stay,
      stay,
      order: i + 1,
    });
    clock += stay;
    prev = place;
  });

  let returnLeg = null;
  if (loop) {
    const measured = routed?.legs?.[order.length];
    const travel = measured ? Math.max(1, measured.minutes) : Math.round(estimateMinutes(prev, origin, mobility));
    const metres = measured ? measured.metres : Math.round(haversine(prev, origin) * 1.3);
    returnLeg = { minutes: travel, metres, estimated: !measured };
    totalWalkM += metres;
    clock += travel;
  }

  return {
    stops,
    legs,
    returnLeg,
    geometry: routed?.geometry || null,
    routedForReal: !!routed,
    totals: {
      start: startMinutes,
      end: clock,
      durationMin: clock - startMinutes,
      walkMetres: totalWalkM,
      walkMin: legs.reduce((s, l) => s + l.minutes, 0) + (returnLeg?.minutes || 0),
      stopCount: stops.length,
    },
  };
}

/** A Google Maps directions link with every stop as a waypoint — this is how
 *  the route escapes the app and becomes actual navigation. */
export function googleMapsUrl(origin, stops) {
  if (!stops.length) return null;
  const pt = (p) => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`;
  const destination = stops[stops.length - 1];
  const waypoints = stops.slice(0, -1).map(pt).join('|');
  const params = new URLSearchParams({
    api: '1',
    origin: pt(origin),
    destination: pt(destination),
    travelmode: 'walking',
  });
  if (waypoints) params.set('waypoints', waypoints);
  return `https://www.google.com/maps/dir/?${params}`;
}

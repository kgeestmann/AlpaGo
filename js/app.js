/* app.js — wiring. Owns the session state and connects the modules. */

import { settings, saved, cache, lastPlan } from './state.js';
import { searchPlaces, describeCoords, currentPosition } from './geo.js';
import { findPlaces, CATEGORIES } from './places.js';
import { buildRoute, googleMapsUrl, formatDuration, formatDistance } from './route.js';
import { describePlace, routeIntro, interpretWish, hasKey, testKey } from './enrich.js';
import * as map from './map.js';
import * as ui from './ui.js';

const APP_VERSION = '1.0.2';
const $ = (sel) => document.querySelector(sel);

/* Everything about the current, unsaved plan lives here. */
const session = {
  origin: null,      // {lat, lon}
  cityName: '',
  candidates: [],    // scored places from Overpass
  plan: null,        // output of buildRoute
  intro: null,
  excluded: new Set(),
  lastQuery: null,   // the options that produced `candidates`
  controller: null,  // aborts the in-flight lookup
};

/* ════════════════ navigation ════════════════ */

function showScreen(name) {
  for (const s of document.querySelectorAll('.screen')) {
    s.classList.toggle('is-active', s.id === 'screen-' + name);
  }
  for (const t of document.querySelectorAll('.tab')) {
    t.classList.toggle('is-on', t.dataset.screen === name);
  }
  if (name === 'route') map.refresh();
  if (name === 'saved') drawSaved();
}

/* ════════════════ plan screen ═══════════════ */

function loadSettingsIntoForm() {
  const s = settings.all();

  $('#hours').value = s.hours;
  $('#hours-out').textContent = `${s.hours} h`;
  $('#start-time').value = s.startTime;
  $('#pace').value = s.pace;
  $('#loop-route').checked = s.loopRoute;
  $('#api-key').value = s.apiKey;
  $('#api-model').value = s.apiModel;
  $('#app-version').textContent = 'v' + APP_VERSION;

  for (const b of document.querySelectorAll('[data-mobility]')) {
    b.classList.toggle('is-on', b.dataset.mobility === s.mobility);
  }

  ui.renderInterests($('#interests'), s.interests, (interests) => settings.set({ interests }));

  if (s.city) {
    session.origin = { lat: s.city.lat, lon: s.city.lon };
    session.cityName = s.city.name;
    showChosenCity(s.city);
  }

  updateWishAvailability();
}

function updateWishAvailability() {
  const enabled = hasKey(settings.all());
  $('#wish').disabled = !enabled;
  $('#wish-tag').hidden = enabled;
  $('#wish').placeholder = enabled
    ? 'e.g. somewhere quiet with good coffee, avoid crowds'
    : 'Add a Claude API key under More to use this';
}

function showChosenCity(city) {
  const node = $('#city-chosen');
  node.textContent = `📍 ${city.name}${city.context ? ' · ' + city.context : ''}`;
  node.hidden = false;
}

/* ── city autocomplete ────────────────────── */

let acTimer = null;
let acController = null;

function wireCitySearch() {
  const input = $('#city-input');
  const list = $('#city-results');

  const hide = () => { list.hidden = true; list.replaceChildren(); };

  input.addEventListener('input', () => {
    clearTimeout(acTimer);
    acController?.abort();
    const q = input.value.trim();
    if (q.length < 2) { hide(); return; }

    acTimer = setTimeout(async () => {
      acController = new AbortController();
      try {
        const results = await searchPlaces(q, { signal: acController.signal });
        if (!results.length) { hide(); return; }
        list.replaceChildren();
        for (const r of results) {
          const li = ui.el('li');
          li.append(ui.el('span', null, r.name));
          if (r.context) li.append(ui.el('small', null, r.context));
          li.addEventListener('click', () => {
            session.origin = { lat: r.lat, lon: r.lon };
            session.cityName = r.name;
            settings.set({ city: r });
            showChosenCity(r);
            input.value = '';
            hide();
          });
          list.append(li);
        }
        list.hidden = false;
      } catch (err) {
        if (err.name !== 'AbortError') ui.toast(err.message);
      }
    }, 280);
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.autocomplete')) hide();
  });

  $('#locate-btn').addEventListener('click', async () => {
    ui.loading(true, 'Finding you…');
    try {
      const pos = await currentPosition();
      const described = await describeCoords(pos);
      session.origin = { lat: pos.lat, lon: pos.lon };
      session.cityName = described.name;
      settings.set({ city: described });
      showChosenCity(described);
      $('#city-input').value = '';
    } catch (err) {
      ui.toast(err.message);
    } finally {
      ui.loading(false);
    }
  });
}

/* ════════════════ building a day ════════════ */

async function ensureCandidates(opts) {
  const key = JSON.stringify({
    lat: +session.origin.lat.toFixed(3),
    lon: +session.origin.lon.toFixed(3),
    interests: opts.interests.slice().sort(),
    hours: opts.hours,
    mobility: opts.mobility,
  });
  if (session.lastQuery === key && session.candidates.length) return session.candidates;

  session.candidates = await findPlaces(session.origin, opts);
  session.lastQuery = key;
  return session.candidates;
}

async function generate({ jitter = 0, keepCandidates = false } = {}) {
  if (!session.origin) {
    ui.toast('Pick a city or use your location first');
    return;
  }

  // One lookup at a time; a second tap replaces the first rather than racing it.
  session.controller?.abort();
  const controller = new AbortController();
  session.controller = controller;

  const s = settings.all();
  const opts = {
    interests: s.interests.length ? s.interests : ['sights'],
    hours: Number(s.hours),
    mobility: s.mobility,
    pace: s.pace,
    startTime: s.startTime,
    loop: s.loopRoute,
    signal: controller.signal,
    onProgress: () =>
      ui.loadingNote('the main map server is slow — asking the backups too'),
  };

  ui.loading(true, 'Reading the map…', () => controller.abort());

  try {
    // A free-text wish can override the chips, but only when a key is set.
    let wishNote = null;
    const wish = $('#wish').value.trim();
    if (wish && hasKey(s)) {
      ui.loadingText('Making sense of your wish…');
      const parsed = await interpretWish(s, wish);
      if (parsed) {
        if (parsed.interests.length) opts.interests = parsed.interests;
        if (parsed.avoid.length) {
          opts.interests = opts.interests.filter((k) => !parsed.avoid.includes(k));
          if (!opts.interests.length) opts.interests = ['sights'];
        }
        if (parsed.pace) opts.pace = parsed.pace;
        wishNote = parsed.note;
      }
    }

    if (!keepCandidates) session.lastQuery = null;
    ui.loadingText('Finding places worth your time…');
    const candidates = await ensureCandidates(opts);

    const usable = candidates.filter((p) => !session.excluded.has(p.id));
    if (!usable.length) {
      ui.renderEmptyRoute(
        'No mapped places matched around here. Try a wider time budget, more interests, or a spot closer to a town centre.'
      );
      showScreen('route');
      return;
    }

    ui.loadingText('Working out the best order…');
    const plan = await buildRoute(usable, session.origin, { ...opts, jitter });

    if (plan.empty) {
      ui.renderEmptyRoute('Everything nearby needs more time than you have. Try adding an hour.');
      showScreen('route');
      return;
    }

    session.plan = plan;
    session.intro = wishNote;

    paintRoute();
    showScreen('route');
    persistLast();

    // The Claude intro arrives late and quietly — the route is already usable.
    if (hasKey(s)) {
      routeIntro(s, {
        cityName: session.cityName,
        stops: plan.stops,
        totals: plan.totals,
        mobility: opts.mobility,
      }).then((text) => {
        if (!text || session.plan !== plan) return;
        session.intro = wishNote ? `${wishNote} ${text}` : text;
        paintRoute();
        persistLast();
      });
    }
  } catch (err) {
    if (err.name === 'AbortError') return; // the user pressed Cancel
    console.error(err);
    ui.toast(err.message || 'Something went wrong building the route');
  } finally {
    if (session.controller === controller) session.controller = null;
    ui.loading(false);
  }
}

function paintRoute() {
  const plan = session.plan;
  if (!plan) return;

  ui.renderRoute(plan, { origin: session.origin, cityName: session.cityName, intro: session.intro }, {
    onOpen: openStop,
    onSwap: swapStop,
  });

  map.drawRoute({ origin: session.origin, stops: plan.stops, geometry: plan.geometry }, (stop) => {
    openStop(stop);
  });

  const url = googleMapsUrl(session.origin, plan.stops);
  $('#maps-btn').disabled = !url;
  $('#maps-btn').onclick = () => url && window.open(url, '_blank', 'noopener');
}

async function openStop(stop) {
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${stop.lat},${stop.lon}`;
  ui.openSheet(stop, { description: null, mapsUrl });
  const description = await describePlace(stop);
  if (description && !$('#sheet').hidden) {
    ui.openSheet(stop, { description, mapsUrl });
  }
}

async function swapStop(stop) {
  session.excluded.add(stop.id);
  await generate({ keepCandidates: true, jitter: 0 });
  ui.toast(`Swapped out ${stop.name}`);
}

/* ════════════════ saving ════════════════════ */

function planSummary(plan) {
  return `${formatDuration(plan.totals.durationMin)} · ${formatDistance(plan.totals.walkMetres)}`;
}

function persistLast() {
  if (!session.plan) return;
  lastPlan.set({
    origin: session.origin,
    cityName: session.cityName,
    intro: session.intro,
    plan: session.plan,
  });
}

function restoreLast() {
  const stored = lastPlan.get();
  if (!stored?.plan?.stops?.length) return false;
  session.origin = stored.origin;
  session.cityName = stored.cityName;
  session.intro = stored.intro;
  session.plan = stored.plan;
  paintRoute();
  return true;
}

function drawSaved() {
  ui.renderSaved(saved.all(), {
    onOpen: (route) => {
      session.origin = route.origin;
      session.cityName = route.cityName;
      session.intro = route.intro;
      session.plan = route.plan;
      session.excluded = new Set();
      paintRoute();
      persistLast();
      showScreen('route');
    },
    onDelete: (route) => {
      saved.remove(route.id);
      drawSaved();
      ui.toast('Deleted');
    },
  });
}

/* ════════════════ settings ══════════════════ */

function wireSettings() {
  $('#save-key-btn').addEventListener('click', () => {
    settings.set({
      apiKey: $('#api-key').value.trim(),
      apiModel: $('#api-model').value.trim() || 'claude-haiku-4-5',
    });
    updateWishAvailability();
    $('#key-status').textContent = $('#api-key').value.trim()
      ? 'Saved on this device.'
      : 'Key cleared.';
    ui.toast('Settings saved');
  });

  $('#test-key-btn').addEventListener('click', async () => {
    const s = settings.set({
      apiKey: $('#api-key').value.trim(),
      apiModel: $('#api-model').value.trim() || 'claude-haiku-4-5',
    });
    if (!hasKey(s)) { $('#key-status').textContent = 'Enter a key first.'; return; }
    $('#key-status').textContent = 'Testing…';
    try {
      $('#key-status').textContent = await testKey(s);
      updateWishAvailability();
    } catch (err) {
      $('#key-status').textContent = err.message;
    }
  });

  $('#loop-route').addEventListener('change', (e) => settings.set({ loopRoute: e.target.checked }));

  $('#clear-cache-btn').addEventListener('click', () => {
    cache.clear();
    session.candidates = [];
    session.lastQuery = null;
    ui.toast('Cached lookups cleared');
  });

  $('#clear-saved-btn').addEventListener('click', () => {
    saved.clear();
    drawSaved();
    ui.toast('Saved routes deleted');
  });
}

/* ════════════════ boot ══════════════════════ */

function wire() {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => showScreen(tab.dataset.screen));
  }

  $('#hours').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    $('#hours-out').textContent = `${v} h`;
    settings.set({ hours: v });
  });

  $('#start-time').addEventListener('change', (e) => settings.set({ startTime: e.target.value }));
  $('#pace').addEventListener('change', (e) => settings.set({ pace: e.target.value }));

  for (const b of document.querySelectorAll('[data-mobility]')) {
    b.addEventListener('click', () => {
      for (const o of document.querySelectorAll('[data-mobility]')) o.classList.remove('is-on');
      b.classList.add('is-on');
      settings.set({ mobility: b.dataset.mobility });
    });
  }

  $('#generate-btn').addEventListener('click', () => {
    session.excluded = new Set();
    generate();
  });

  $('#regen-btn').addEventListener('click', () => generate({ keepCandidates: true, jitter: 200 }));
  $('#new-plan-btn').addEventListener('click', () => showScreen('plan'));

  $('#save-btn').addEventListener('click', () => {
    if (!session.plan) { ui.toast('Nothing to save yet'); return; }
    saved.add({
      title: `${session.cityName || 'Day'} · ${session.plan.totals.stopCount} stops`,
      meta: planSummary(session.plan),
      cityName: session.cityName,
      origin: session.origin,
      intro: session.intro,
      plan: session.plan,
      stops: session.plan.stops,
    });
    ui.toast('Saved');
    drawSaved();
  });

  $('#sheet-close').addEventListener('click', ui.closeSheet);
  $('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') ui.closeSheet(); });

  wireCitySearch();
  wireSettings();
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol === 'file:') return; // no SW from the filesystem
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {
      /* offline support is a bonus, not a requirement */
    });
  });
}

loadSettingsIntoForm();
wire();
restoreLast();
registerServiceWorker();

// Expose a little for debugging from the phone's remote console.
window.AlpaGo = { session, settings, saved, cache, CATEGORIES };

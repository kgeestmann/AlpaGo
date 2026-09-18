/* ui.js — rendering. No fetching, no routing logic; just turning data into DOM.
 *
 * Everything user-supplied or OSM-supplied goes in via textContent, never
 * innerHTML — OSM place names are crowd-sourced strings and should be treated
 * as such. */

import { CATEGORIES, FOOD_CATEGORIES } from './places.js';
import { formatTime, formatDuration, formatDistance } from './route.js';

const $ = (sel, root = document) => root.querySelector(sel);

/* ── small helpers ────────────────────────── */

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

let toastTimer = null;
export function toast(message, ms = 2600) {
  const node = $('#toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, ms);
}

/* The loader counts seconds out loud. A spinner that has been going for
 * twenty seconds with no other signal is indistinguishable from a hang, and
 * the honest answer — "this is slow, here is how slow, here is the way out" —
 * is better than pretending everything is fine. */
let elapsedTimer = null;
let stickyNote = '';

export function loading(on, message = 'Looking around…', onCancel = null) {
  const node = $('#loader');
  const cancel = $('#loader-cancel');
  const note = $('#loader-note');

  clearInterval(elapsedTimer);
  stickyNote = '';
  note.hidden = true;
  note.textContent = '';

  if (!on) {
    node.hidden = true;
    cancel.hidden = true;
    cancel.onclick = null;
    return;
  }

  $('#loader-text').textContent = message;
  node.hidden = false;

  if (onCancel) {
    cancel.hidden = false;
    cancel.onclick = onCancel;
  } else {
    cancel.hidden = true;
    cancel.onclick = null;
  }

  const started = Date.now();
  elapsedTimer = setInterval(() => {
    const seconds = Math.round((Date.now() - started) / 1000);
    if (seconds < 6 && !stickyNote) return;
    const detail = stickyNote
      || (seconds < 20
        ? 'first lookup in a city takes a moment'
        : 'the map data service is slow right now');
    note.hidden = false;
    note.textContent = `${seconds}s — ${detail}`;
  }, 1000);
}

export function loadingText(message) {
  $('#loader-text').textContent = message;
}

/* A note that outranks the generic "this is taking a while" text until the
 * next loading() call clears it. */
export function loadingNote(message) {
  stickyNote = message || '';
  const note = $('#loader-note');
  if (stickyNote) {
    note.textContent = stickyNote;
    note.hidden = false;
  }
}

/* ── interest chips ───────────────────────── */

export function renderInterests(container, selected, onChange) {
  container.replaceChildren();
  for (const [key, cat] of Object.entries(CATEGORIES)) {
    const chip = el('button', 'chip');
    chip.type = 'button';
    chip.dataset.key = key;
    chip.append(el('span', null, cat.icon), el('span', null, cat.label));
    if (selected.includes(key)) chip.classList.add('is-on');
    chip.addEventListener('click', () => {
      chip.classList.toggle('is-on');
      const now = [...container.querySelectorAll('.chip.is-on')].map((c) => c.dataset.key);
      onChange(now);
    });
    container.append(chip);
  }
}

/* ── the day itself ───────────────────────── */

const walkIcon = () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.innerHTML =
    '<circle cx="13" cy="4" r="2" fill="currentColor"/>' +
    '<path d="M11 21l2-6-2-3V8l4 2 3-1M11 12l-3 3-1 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>';
  return svg;
};

export function renderRoute(plan, { origin, cityName, intro }, handlers) {
  $('#route-title').textContent = cityName ? `${cityName} in ${formatDuration(plan.totals.durationMin)}` : 'Your day';

  const meta = [
    `${plan.totals.stopCount} stops`,
    `${formatTime(plan.totals.start)}–${formatTime(plan.totals.end)}`,
    `${formatDistance(plan.totals.walkMetres)} on foot`,
  ].join(' · ');
  $('#route-meta').textContent = meta;

  const introNode = $('#route-intro');
  if (intro) {
    introNode.textContent = intro;
    introNode.hidden = false;
  } else {
    introNode.hidden = true;
  }

  const list = $('#timeline');
  list.replaceChildren();

  plan.stops.forEach((stop, i) => {
    const leg = plan.legs[i];
    if (leg) {
      const legNode = el('li', 'leg');
      legNode.append(walkIcon());
      legNode.append(
        el('span', null,
          `${leg.minutes} min · ${formatDistance(leg.metres)}${leg.estimated ? ' (estimated)' : ''}`)
      );
      list.append(legNode);
    }

    const item = el('li', 'stop');

    const rail = el('div', 'stop-rail');
    const num = el('div', 'stop-num' + (FOOD_CATEGORIES.has(stop.category) ? ' is-food' : ''), String(i + 1));
    rail.append(num);
    if (i < plan.stops.length - 1) rail.append(el('div', 'stop-line'));

    const body = el('div', 'stop-body');
    body.append(el('div', 'stop-time', `${formatTime(stop.arrive)} – ${formatTime(stop.depart)}`));

    const nameRow = el('div', 'stop-name');
    const nameBtn = el('button', null, stop.name);
    nameBtn.type = 'button';
    nameBtn.addEventListener('click', () => handlers.onOpen(stop, i));
    nameRow.append(nameBtn);

    const swap = el('button', 'stop-swap', 'swap');
    swap.type = 'button';
    swap.addEventListener('click', (e) => { e.stopPropagation(); handlers.onSwap(stop, i); });
    nameRow.append(swap);
    body.append(nameRow);

    const bits = [stop.kind, `${stop.stay} min`];
    if (stop.cuisine) bits.splice(1, 0, stop.cuisine);
    body.append(el('div', 'stop-sub', bits.join(' · ')));

    item.append(rail, body);
    list.append(item);
  });

  if (plan.returnLeg) {
    const legNode = el('li', 'leg');
    legNode.append(walkIcon());
    legNode.append(el('span', null,
      `${plan.returnLeg.minutes} min · ${formatDistance(plan.returnLeg.metres)} back to the start`));
    list.append(legNode);
  }
}

export function renderEmptyRoute(message) {
  $('#route-title').textContent = 'Nothing to show yet';
  $('#route-meta').textContent = '';
  $('#route-intro').hidden = true;
  const list = $('#timeline');
  list.replaceChildren();
  const note = el('li', 'empty', message);
  list.append(note);
}

/* ── place detail sheet ───────────────────── */

export function openSheet(stop, { description, mapsUrl }) {
  const body = $('#sheet-body');
  body.replaceChildren();

  body.append(el('div', 'kind', stop.kind));
  body.append(el('h3', null, stop.name));

  if (description?.thumbnail) {
    const img = el('img');
    img.src = description.thumbnail;
    img.alt = '';
    img.loading = 'lazy';
    body.append(img);
  }

  if (description?.extract) {
    body.append(el('p', null, description.extract));
  } else {
    body.append(el('p', 'hint', 'No description available for this one — Wikipedia does not cover it.'));
  }

  const facts = el('ul', 'facts');
  const add = (label, value) => {
    if (!value) return;
    const li = el('li');
    li.append(el('b', null, label), el('span', null, value));
    facts.append(li);
  };
  add('Time here', `${stop.stay} min`);
  add('Arrive', formatTime(stop.arrive));
  add('Address', stop.address);
  add('Opening', stop.openingHours);
  add('Entry', stop.fee);
  add('Step-free', stop.wheelchair === 'yes' ? 'Yes' : stop.wheelchair === 'limited' ? 'Partly' : stop.wheelchair === 'no' ? 'No' : null);
  if (facts.children.length) body.append(facts);

  const actions = el('div', 'sheet-actions');

  const maps = el('a', 'secondary-btn', 'Directions');
  maps.href = mapsUrl;
  maps.target = '_blank';
  maps.rel = 'noopener';
  actions.append(maps);

  if (description?.url) {
    const wiki = el('a', 'ghost-btn', 'Wikipedia');
    wiki.href = description.url;
    wiki.target = '_blank';
    wiki.rel = 'noopener';
    actions.append(wiki);
  } else if (stop.website) {
    const site = el('a', 'ghost-btn', 'Website');
    site.href = stop.website;
    site.target = '_blank';
    site.rel = 'noopener';
    actions.append(site);
  }

  body.append(actions);
  $('#sheet').hidden = false;
}

export function closeSheet() {
  $('#sheet').hidden = true;
}

/* ── saved routes ─────────────────────────── */

export function renderSaved(routes, handlers) {
  const list = $('#saved-list');
  list.replaceChildren();

  if (!routes.length) {
    list.append(el('div', 'empty',
      'Nothing saved yet.\nBuild a day you like, then tap Save on the route.'));
    return;
  }

  for (const route of routes) {
    const card = el('div', 'saved-card');
    const left = el('div');
    left.append(el('h3', null, route.title || 'Saved route'));
    const when = new Date(route.savedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    left.append(el('p', null, `${route.stops.length} stops · ${route.meta || ''} · saved ${when}`));

    const row = el('div', 'row');
    const open = el('button', 'ghost-btn', 'Open');
    open.addEventListener('click', () => handlers.onOpen(route));
    const del = el('button', 'ghost-btn danger', '×');
    del.title = 'Delete';
    del.addEventListener('click', () => handlers.onDelete(route));
    row.append(open, del);

    card.append(left, row);
    list.append(card);
  }
}

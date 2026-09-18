/* state.js — everything AlpaGo keeps on the device.
 * Nothing here ever leaves the phone. */

const K = {
  settings: 'alpago.settings.v1',
  saved:    'alpago.saved.v1',
  cache:    'alpago.cache.v1',
  lastPlan: 'alpago.lastplan.v1',
};

const DEFAULTS = {
  interests: ['sights', 'parks', 'food'],
  mobility: 'foot',
  pace: 'normal',
  hours: 5,
  startTime: '10:00',
  loopRoute: false,
  apiKey: '',
  apiModel: 'claude-haiku-4-5',
  city: null,
};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false; // private mode / quota — the app keeps working, it just forgets
  }
}

/* ── settings ─────────────────────────────── */

export const settings = {
  all() {
    return { ...DEFAULTS, ...read(K.settings, {}) };
  },
  get(name) {
    return this.all()[name];
  },
  set(patch) {
    const next = { ...this.all(), ...patch };
    write(K.settings, next);
    return next;
  },
};

/* ── saved routes ─────────────────────────── */

export const saved = {
  all() {
    return read(K.saved, []);
  },
  add(route) {
    const list = this.all();
    const entry = {
      id: 'r' + Date.now().toString(36),
      savedAt: Date.now(),
      ...route,
    };
    list.unshift(entry);
    write(K.saved, list.slice(0, 60));
    return entry;
  },
  remove(id) {
    write(K.saved, this.all().filter((r) => r.id !== id));
  },
  get(id) {
    return this.all().find((r) => r.id === id) || null;
  },
  clear() {
    write(K.saved, []);
  },
};

/* ── last generated route (so the Route tab survives a reload) ── */

export const lastPlan = {
  get() { return read(K.lastPlan, null); },
  set(plan) { write(K.lastPlan, plan); },
  clear() { try { localStorage.removeItem(K.lastPlan); } catch {} },
};

/* ── network cache ────────────────────────────
 * Overpass and Wikipedia are free services run on donations. Caching is
 * not an optimisation here, it is basic manners — and it makes a second
 * look at the same city instant, and possible with no signal at all. */

const TTL = 1000 * 60 * 60 * 24 * 7; // one week

export const cache = {
  get(key) {
    const store = read(K.cache, {});
    const hit = store[key];
    if (!hit) return null;
    if (Date.now() - hit.t > TTL) return null;
    return hit.v;
  },
  set(key, value) {
    const store = read(K.cache, {});
    store[key] = { t: Date.now(), v: value };
    // Keep the newest ~40 entries so we never blow the 5 MB localStorage budget.
    const keys = Object.keys(store).sort((a, b) => store[b].t - store[a].t);
    const trimmed = {};
    for (const k of keys.slice(0, 40)) trimmed[k] = store[k];
    if (!write(K.cache, trimmed)) {
      // Over quota even after trimming — start fresh rather than fail silently.
      write(K.cache, { [key]: { t: Date.now(), v: value } });
    }
  },
  clear() {
    write(K.cache, {});
  },
  size() {
    return Object.keys(read(K.cache, {})).length;
  },
};

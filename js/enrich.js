/* enrich.js — the words around the route.
 *
 * Two independent sources, in this order of preference:
 *   1. Wikipedia, for what a place actually is. Free, factual, no key.
 *   2. Claude, optional, for the connective tissue: a one-paragraph intro to
 *      the day, and turning a free-text wish into route settings.
 *
 * Everything here is allowed to fail. A route with no prose is still a route. */

import { cache } from './state.js';
import { CATEGORIES } from './places.js';

/* ── Wikipedia ────────────────────────────── */

async function wikidataToTitle(qid) {
  const key = 'wd:' + qid;
  const hit = cache.get(key);
  if (hit !== null && hit !== undefined) return hit;

  try {
    const url = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${qid}` +
                `&props=sitelinks&format=json&origin=*`;
    const res = await fetch(url);
    if (!res.ok) throw new Error();
    const data = await res.json();
    const links = data.entities?.[qid]?.sitelinks || {};
    const pick = links.enwiki || links.dewiki || links.svwiki || Object.values(links)[0];
    const value = pick ? { lang: (pick.site || 'enwiki').replace('wiki', ''), title: pick.title } : false;
    cache.set(key, value);
    return value;
  } catch {
    return false;
  }
}

/**
 * Short factual description for a place, using whatever the OSM tags point at.
 * Returns null when the place simply is not in Wikipedia — most cafés are not.
 */
export async function describePlace(place) {
  let lang = null;
  let title = null;

  if (place.wikipedia && place.wikipedia.includes(':')) {
    [lang, title] = place.wikipedia.split(/:(.+)/);
  } else if (place.wikidata) {
    const resolved = await wikidataToTitle(place.wikidata);
    if (resolved) ({ lang, title } = resolved);
  }
  if (!title) return null;

  const key = `wp:${lang}:${title}`;
  const cached = cache.get(key);
  if (cached !== null && cached !== undefined) return cached || null;

  try {
    const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error();
    const data = await res.json();
    const out = {
      extract: data.extract || null,
      thumbnail: data.thumbnail?.source || null,
      url: data.content_urls?.mobile?.page || null,
      lang,
    };
    cache.set(key, out);
    return out.extract ? out : null;
  } catch {
    cache.set(key, false);
    return null;
  }
}

/* ── Claude (optional) ────────────────────── */

const API_URL = 'https://api.anthropic.com/v1/messages';

export function hasKey(settings) {
  return !!(settings.apiKey && settings.apiKey.trim().startsWith('sk-'));
}

async function askClaude(settings, { system, prompt, maxTokens = 500 }) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': settings.apiKey.trim(),
      'anthropic-version': '2023-06-01',
      // Required for calls made straight from a browser rather than a server.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: (settings.apiModel || 'claude-haiku-4-5').trim(),
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    let detail = '';
    try {
      const err = await res.json();
      detail = err?.error?.message || '';
    } catch {}
    if (res.status === 401) throw new Error('That API key was rejected');
    if (res.status === 429) throw new Error('Rate limited — try again in a moment');
    if (res.status === 400 && /model/i.test(detail)) throw new Error('That model name is not valid');
    throw new Error(detail || `Claude returned ${res.status}`);
  }

  const data = await res.json();
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

/** A sentence or two framing the day. Purely decorative — never blocks. */
export async function routeIntro(settings, { cityName, stops, totals, mobility }) {
  if (!hasKey(settings)) return null;

  const list = stops
    .map((s, i) => `${i + 1}. ${s.name} (${s.kind})`)
    .join('\n');

  try {
    return await askClaude(settings, {
      system:
        'You write short, warm intros for walking routes in a travel app. ' +
        'Two sentences, maximum 45 words. No bullet points, no headings, no emoji. ' +
        'Describe the character and arc of the day, not a list of the stops. ' +
        'Never invent facts about a place you are unsure of.',
      prompt:
        `City: ${cityName}\n` +
        `Getting around: ${mobility}\n` +
        `Roughly ${Math.round(totals.durationMin / 60)} hours, ${stops.length} stops.\n\n` +
        `Stops in order:\n${list}`,
      maxTokens: 200,
    });
  } catch {
    return null;
  }
}

/** Turn "somewhere quiet with good coffee, no museums" into settings. */
export async function interpretWish(settings, wish) {
  if (!hasKey(settings) || !wish.trim()) return null;

  const names = Object.entries(CATEGORIES)
    .map(([k, v]) => `${k} (${v.label})`)
    .join(', ');

  try {
    const raw = await askClaude(settings, {
      system:
        'You convert a traveller\'s free-text wish into route settings for a city-walk app. ' +
        'Reply with JSON only, no prose and no code fences.',
      prompt:
        `Available interest keys: ${names}\n\n` +
        `Wish: "${wish.trim()}"\n\n` +
        'Return exactly this shape:\n' +
        '{"interests":["key",...],"avoid":["key",...],"pace":"relaxed|normal|packed"|null,' +
        '"note":"one short sentence restating the wish"}\n' +
        'Only use keys from the list. Leave arrays empty when the wish says nothing about them.',
      maxTokens: 300,
    });

    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);

    const valid = (arr) => (Array.isArray(arr) ? arr.filter((k) => k in CATEGORIES) : []);
    return {
      interests: valid(parsed.interests),
      avoid: valid(parsed.avoid),
      pace: ['relaxed', 'normal', 'packed'].includes(parsed.pace) ? parsed.pace : null,
      note: typeof parsed.note === 'string' ? parsed.note.slice(0, 160) : null,
    };
  } catch {
    return null;
  }
}

/** Used by the Test button in settings. Throws with a readable message. */
export async function testKey(settings) {
  const reply = await askClaude(settings, {
    system: 'Reply with the single word: ready',
    prompt: 'Say ready.',
    maxTokens: 12,
  });
  return reply.toLowerCase().includes('ready') ? 'Key works.' : 'Key works (unexpected reply, but the call went through).';
}

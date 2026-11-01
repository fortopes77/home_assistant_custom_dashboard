// TV home screen (?tv): helpers for app tiles, weather icons, picking readings, and moving focus with a
// TV remote's arrow keys. The screen itself is drawn in main.js, which has the Home Assistant state.

import { domainOf, isUnavailable } from './entities.js';

/** One app per line, "Name = Android package". Edited in Settings → TV. */
export const TV_APPS_DEFAULT = [
  'YouTube = com.google.android.youtube.tv',
  'Netflix = com.netflix.ninja',
  'Prime Video = com.amazon.amazonvideo.livingroom',
  'Disney+ = com.disney.disneyplus',
  'Plex = com.plexapp.android',
].join('\n');

// Tile colours for apps people often add; anything else gets the plain card colour.
const APP_COLORS = {
  'com.google.android.youtube.tv': ['#ffffff', '#e62117'],
  'com.netflix.ninja': ['#141414', '#e50914'],
  'com.amazon.amazonvideo.livingroom': ['#1a98ff', '#ffffff'],
  'com.disney.disneyplus': ['#0b1a4a', '#ffffff'],
  'com.plexapp.android': ['#1f1f1f', '#e5a00d'],
  'org.jellyfin.androidtv': ['#101322', '#aa5cc3'],
  'com.wbd.stream': ['#002be7', '#ffffff'],
  'com.hbo.hbonow': ['#000000', '#ffffff'],
  'com.apple.atve.androidtv.appletv': ['#000000', '#ffffff'],
  'com.spotify.tv.android': ['#121212', '#1ed760'],
  'au.com.stan.and': ['#0a0a0a', '#00a8e1'],
  'au.net.abc.iview': ['#000000', '#ffffff'],
  'com.google.android.apps.youtube.unplugged': ['#ffffff', '#e62117'],
};

export function parseApps(text) {
  return String(text || '').split('\n').map((line) => {
    const m = line.match(/^\s*(.+?)\s*=\s*([\w.]+)\s*$/);
    return m ? { name: m[1], pkg: m[2], colors: APP_COLORS[m[2]] || null } : null;
  }).filter(Boolean);
}

/** Home Assistant weather condition → icon name. */
export function weatherIcon(condition, night = false) {
  switch (condition) {
    case 'clear-night': return 'wxNight';
    case 'sunny': return night ? 'wxNight' : 'wxSunny';
    case 'partlycloudy': return night ? 'wxNightPartly' : 'wxPartly';
    case 'cloudy': return 'wxCloudy';
    case 'fog': return 'wxFog';
    case 'hail': return 'wxHail';
    case 'lightning': case 'lightning-rainy': return 'wxLightning';
    case 'pouring': return 'wxPouring';
    case 'rainy': return 'wxRainy';
    case 'snowy': case 'snowy-rainy': return 'wxSnowy';
    case 'windy': case 'windy-variant': return 'wxWindy';
    case 'exceptional': return 'alert';
    default: return 'weather';
  }
}

// Readings worth a glance from the couch, used until some are picked in Settings.
const GLANCE_CLASSES = ['temperature', 'humidity', 'pm25', 'pm10', 'pm1', 'carbon_dioxide', 'aqi', 'volatile_organic_compounds'];

export const isReading = (s) => domainOf(s.entity_id) === 'sensor' && !isUnavailable(s) && s.state !== '' && Number.isFinite(Number(s.state));

/** A handful of temperature / humidity / air readings from the shown devices. */
export function autoReadings(states, listed, max = 6) {
  return [...states.values()]
    .filter((s) => isReading(s) && listed(s.entity_id) && GLANCE_CLASSES.includes(s.attributes?.device_class))
    .sort((a, b) => GLANCE_CLASSES.indexOf(a.attributes.device_class) - GLANCE_CLASSES.indexOf(b.attributes.device_class))
    .slice(0, max)
    .map((s) => s.entity_id);
}

// ---------- moving focus with the remote ----------

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea, summary, [tabindex="0"]';

function visible(el) {
  if (el.closest('[hidden], [inert]')) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/**
 * Moves focus to the nearest focusable thing in `dir` ('up' | 'down' | 'left' | 'right') inside `root`.
 * Returns false when nothing lies that way, so the caller can leave the key alone.
 */
export function moveFocus(dir, root) {
  const cur = document.activeElement;
  const items = [...root.querySelectorAll(FOCUSABLE)].filter(visible);
  if (!items.length) return false;
  if (!cur || !root.contains(cur) || cur === root) {
    const first = root.querySelector('[data-tv-start]') || items[0];
    first.focus();
    return true;
  }
  const a = cur.getBoundingClientRect();
  let best = null;
  let bestScore = Infinity;
  for (const el of items) {
    if (el === cur || el.contains(cur) || cur.contains(el)) continue;
    const b = el.getBoundingClientRect();
    let along; let across;
    if (dir === 'right') { along = b.left - a.right; across = overlap(a.top, a.bottom, b.top, b.bottom); }
    else if (dir === 'left') { along = a.left - b.right; across = overlap(a.top, a.bottom, b.top, b.bottom); }
    else if (dir === 'down') { along = b.top - a.bottom; across = overlap(a.left, a.right, b.left, b.right); }
    else { along = a.top - b.bottom; across = overlap(a.left, a.right, b.left, b.right); }
    if (along < -4) continue; // behind us, or mostly beside
    const score = Math.max(0, along) + across * 2;
    if (score < bestScore) { bestScore = score; best = el; }
  }
  if (!best) return false;
  best.focus({ preventScroll: true });
  best.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  return true;
}

/** How far apart two spans are sideways: 0 when they overlap, else the gap between them. */
function overlap(a1, a2, b1, b2) {
  if (b2 >= a1 && b1 <= a2) return 0;
  return b1 > a2 ? b1 - a2 : a1 - b2;
}

export const TV_KEYS = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
};
export const isBackKey = (e) => e.key === 'Escape' || e.key === 'GoBack' || e.key === 'BrowserBack' || e.keyCode === 4;

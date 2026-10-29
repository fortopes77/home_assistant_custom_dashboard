// Where everyone is: Home Assistant's person entities (fed by the Companion app's GPS) and zones,
// on a Leaflet map. Leaflet and the map pictures come from the internet; the positions never
// leave Home Assistant except as the map area the tiles are fetched for.

import { domainOf, nameOf, isUnavailable } from './entities.js';
import { icon } from './icons.js';
import { esc } from './controls.js';

const LEAFLET_URL = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist';
const LEAFLET_FILES = {
  js: ['leaflet.js', 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo='],
  css: ['leaflet.css', 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY='],
};
// OpenStreetMap's own map pictures: free, no key. Dark mode inverts them in CSS.
const MAP_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const MAP_CREDIT = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';
const PERSON_COLORS = ['#2f6fde', '#d0475c', '#1f8a4c', '#8a4fd8', '#d27a12', '#0f8f9a', '#b8478f', '#5a6b84'];

// ---------- reading Home Assistant's states ----------

function personFrom(s) {
  const a = s.attributes || {};
  const lat = Number(a.latitude);
  const lon = Number(a.longitude);
  const tracker = domainOf(s.entity_id) === 'device_tracker';
  return {
    id: s.entity_id,
    name: nameOf(s),
    state: s.state,
    located: Number.isFinite(lat) && Number.isFinite(lon) && !(lat === 0 && lon === 0),
    lat,
    lon,
    acc: Number(a.gps_accuracy) || 0,
    pic: a.entity_picture || '',
    source: tracker ? s.entity_id : a.source || '',
    changed: s.last_changed,
    unavailable: isUnavailable(s),
  };
}

/** Everyone to show: each person, plus GPS trackers (a car, a spare phone) no person uses. */
export function peopleOf(states) {
  const all = [...states.values()];
  const persons = all.filter((s) => domainOf(s.entity_id) === 'person');
  const claimed = new Set(persons.flatMap((p) => p.attributes?.device_trackers || []));
  const loose = all.filter((s) => domainOf(s.entity_id) === 'device_tracker' && !claimed.has(s.entity_id)
    && s.attributes?.source_type === 'gps' && Number.isFinite(Number(s.attributes?.latitude)));
  return [...persons, ...loose].map(personFrom).sort((a, b) => a.name.localeCompare(b.name));
}

export function zonesOf(states) {
  return [...states.values()]
    .filter((s) => domainOf(s.entity_id) === 'zone' && Number.isFinite(Number(s.attributes?.latitude)))
    .map((s) => ({
      id: s.entity_id,
      name: nameOf(s),
      lat: Number(s.attributes.latitude),
      lon: Number(s.attributes.longitude),
      radius: Number(s.attributes.radius) || 100,
      passive: !!s.attributes.passive,
      home: s.entity_id === 'zone.home',
      shop: s.attributes.icon === 'mdi:cart', // the supermarket zones the shopping reminder uses
    }));
}

/** "Home", "Away", or the zone they are in (Home Assistant puts the zone's name in the state). */
export function placeLabel(p) {
  if (p.state === 'home') return 'Home';
  if (p.state === 'not_home') return 'Away';
  if (p.unavailable) return 'Unknown';
  return p.state;
}

export function distanceKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

export function formatDistance(km, unit = 'km') {
  if (unit === 'mi') {
    const mi = km * 0.621371;
    return `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`;
  }
  if (km < 1) return `${Math.max(10, Math.round(km * 100) * 10)} m`;
  return `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
}

function personColor(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PERSON_COLORS[h % PERSON_COLORS.length];
}

/** A round picture of the person (their Home Assistant picture, or initials). */
export function avatarHtml(p, base, cls = 'pavatar') {
  const initials = p.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
  let src = '';
  try { src = p.pic ? new URL(p.pic, `${base}/`).href : ''; } catch { /* no picture */ }
  return `<span class="${cls}" style="--pc:${personColor(p.name)}" aria-hidden="true">${esc(initials)}${src
    ? `<img src="${esc(src)}" alt="" loading="lazy" onerror="this.remove()">` : ''}</span>`;
}

// ---------- loading Leaflet ----------

let leafletLoading = null;
function loadLeaflet() {
  if (window.L?.map) return Promise.resolve(window.L);
  const add = (tag, attrs) => new Promise((resolve, reject) => {
    const el = Object.assign(document.createElement(tag), attrs, { crossOrigin: 'anonymous' });
    el.onload = resolve;
    el.onerror = () => { el.remove(); reject(new Error('The map could not load')); };
    document.head.append(el);
  });
  leafletLoading ||= Promise.all([
    add('link', { rel: 'stylesheet', href: `${LEAFLET_URL}/${LEAFLET_FILES.css[0]}`, integrity: LEAFLET_FILES.css[1] }),
    add('script', { src: `${LEAFLET_URL}/${LEAFLET_FILES.js[0]}`, integrity: LEAFLET_FILES.js[1] }),
  ]).then(() => {
    if (!window.L?.map) throw new Error('The map could not load');
    return window.L;
  }).catch((err) => {
    leafletLoading = null;
    throw err;
  });
  return leafletLoading;
}

function prefersDark() {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
}

// ---------- the map ----------

/**
 * One map kept alive across redraws of Home: `el` is moved into each new page's slot.
 * On touch screens a finger scrolls the page past the map; pinch zooms it, and full screen
 * lets one finger pan too.
 */
export class PeopleMap {
  constructor({ onPick }) {
    this.onPick = onPick;
    this.people = [];
    this.zones = [];
    this.base = '';
    this.markers = new Map();  // id -> { marker, ring, key }
    this.zoneLayers = new Map(); // id -> { circle, label, key }
    this.auto = true;          // keep everyone in view until the map is moved by hand
    this.fitKey = '';
    this.expanded = false;
    this.map = null;
    this.loading = null;
    this.fine = matchMedia('(hover: hover) and (pointer: fine)').matches;

    this.el = document.createElement('div');
    this.el.className = 'pmap';
    this.el.innerHTML = `
      <div class="pmap-canvas" role="region" aria-label="Map of where everyone is"></div>
      <div class="pmap-tools">
        <button type="button" class="pmap-btn" data-pmap="fit" aria-label="Show everyone">${icon('people')}</button>
        <button type="button" class="pmap-btn" data-pmap="expand" aria-label="Full screen map">${icon('fullscreen')}</button>
      </div>
      <p class="pmap-msg" hidden></p>`;
    this.canvas = this.el.querySelector('.pmap-canvas');
    this.msg = this.el.querySelector('.pmap-msg');

    this.el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-pmap]');
      if (b?.dataset.pmap === 'fit') this.fitAll({ force: true });
      else if (b?.dataset.pmap === 'expand') this.setExpanded(!this.expanded);
      else if (e.target.closest('.leaflet-control-zoom')) this.auto = false;
    });
    // Moving the map by hand stops it following everyone, until "Show everyone".
    const manual = () => { this.auto = false; };
    this.canvas.addEventListener('wheel', manual, { passive: true });
    this.canvas.addEventListener('dblclick', manual);
    this.canvas.addEventListener('touchmove', (e) => { if (e.touches.length > 1) manual(); }, { passive: true });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.expanded) this.setExpanded(false); });

    const retheme = () => this.applyTiles();
    new MutationObserver(retheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', retheme);
  }

  /** Put the map into `slot` (a fresh page from a redraw), loading Leaflet the first time. */
  attach(slot) {
    if (!slot) return;
    this.slot = slot;
    if (!this.expanded && this.el.parentNode !== slot) slot.append(this.el);
    if (!this.loading) {
      this.msg.hidden = false;
      this.msg.textContent = 'Loading map…';
      this.loading = loadLeaflet().then((L) => this.create(L), () => {
        this.loading = null; // try again on the next redraw
        this.msg.hidden = false;
        this.msg.textContent = 'The map could not load. It needs an internet connection; the list below still shows where everyone is.';
      });
    }
    if (this.map) requestAnimationFrame(() => this.map?.invalidateSize(false));
  }

  create(L) {
    this.L = L;
    this.msg.hidden = true;
    this.map = L.map(this.canvas, {
      zoomControl: this.fine,
      dragging: this.fine,
      scrollWheelZoom: false,
      keyboard: this.fine,
      zoomSnap: 0.5,
      worldCopyJump: true,
    });
    this.map.attributionControl.setPrefix(false);
    this.map.on('dragstart', () => { this.auto = false; });
    this.applyTiles();
    this.sync();
  }

  applyTiles() {
    this.el.classList.toggle('dark', prefersDark());
    if (!this.map || this.tiles) return;
    // Home Assistant serves pages with "Referrer-Policy: no-referrer", and OpenStreetMap refuses
    // tiles asked for by an unnamed site. Send just the address of Home Assistant, as its own map does.
    this.tiles = this.L.tileLayer(MAP_TILES, { maxZoom: 19, attribution: MAP_CREDIT, referrerPolicy: 'origin' }).addTo(this.map);
  }

  update({ people, zones, base }) {
    this.people = people;
    this.zones = zones;
    this.base = base;
    this.sync();
  }

  sync() {
    if (!this.map) return;
    const L = this.L;

    const zoneSeen = new Set();
    for (const z of this.zones) {
      zoneSeen.add(z.id);
      const key = `${z.lat},${z.lon},${z.radius},${z.name},${z.passive},${z.shop}`;
      let entry = this.zoneLayers.get(z.id);
      if (entry?.key === key) continue;
      if (entry) { entry.circle.remove(); entry.label.remove(); }
      const cls = `pmap-zone${z.home ? ' home' : ''}${z.passive ? ' passive' : ''}${z.shop ? ' shop' : ''}`;
      const circle = L.circle([z.lat, z.lon], { radius: z.radius, className: cls, interactive: false }).addTo(this.map);
      // The name sits on the zone's top edge, clear of anyone standing in the middle.
      const top = z.shop ? [z.lat, z.lon] : [z.lat + z.radius / 111_320, z.lon];
      const label = L.marker(top, {
        interactive: false,
        keyboard: false,
        // Shops are many and small, so they get a cart instead of a name.
        icon: L.divIcon({ className: `pmap-zone-label${z.shop ? ' shop' : ''}`, html: z.shop ? `<span title="${esc(z.name)}">${icon('cart')}</span>` : `<span>${z.home ? icon('home') : ''}${esc(z.name)}</span>`, iconSize: null }),
      }).addTo(this.map);
      this.zoneLayers.set(z.id, { circle, label, key });
    }
    for (const [id, entry] of this.zoneLayers) {
      if (zoneSeen.has(id)) continue;
      entry.circle.remove();
      entry.label.remove();
      this.zoneLayers.delete(id);
    }

    // People in the same spot (everyone at home) stand side by side instead of on top of each other.
    const located = this.people.filter((p) => p.located);
    const spots = new Map();
    for (const p of located) {
      const k = `${p.lat.toFixed(3)},${p.lon.toFixed(3)}`;
      spots.set(k, [...(spots.get(k) || []), p.id]);
    }
    const seen = new Set();
    for (const p of located) {
      seen.add(p.id);
      const group = spots.get(`${p.lat.toFixed(3)},${p.lon.toFixed(3)}`);
      const shift = (group.indexOf(p.id) - (group.length - 1) / 2) * 46;
      const away = p.state !== 'home';
      const key = `${p.name}|${p.pic}|${away}|${shift}|${this.base}`;
      let entry = this.markers.get(p.id);
      if (!entry) {
        const marker = L.marker([p.lat, p.lon], { title: p.name, riseOnHover: true, keyboard: true })
          .on('click', () => this.onPick?.(p.id))
          .addTo(this.map);
        const ring = L.circle([p.lat, p.lon], { radius: p.acc, className: 'pmap-acc', interactive: false }).addTo(this.map);
        entry = { marker, ring, key: '' };
        this.markers.set(p.id, entry);
      }
      entry.marker.setLatLng([p.lat, p.lon]);
      entry.ring.setLatLng([p.lat, p.lon]).setRadius(p.acc);
      if (entry.key !== key) {
        entry.key = key;
        entry.marker.setIcon(L.divIcon({
          className: 'pmap-pin-wrap',
          iconSize: [44, 60],
          iconAnchor: [22 - shift, 22],
          html: `<span class="pmap-pin${away ? ' away' : ''}">${avatarHtml(p, this.base)}<span class="pmap-name">${esc(p.name.split(/\s+/)[0])}</span></span>`,
        }));
      }
    }
    for (const [id, entry] of this.markers) {
      if (seen.has(id)) continue;
      entry.marker.remove();
      entry.ring.remove();
      this.markers.delete(id);
    }

    if (this.pendingFocus) {
      const id = this.pendingFocus;
      this.pendingFocus = null;
      this.focus(id);
    } else if (this.auto) this.fitAll();
  }

  /** Frame everyone who shares a location, and home. */
  fitAll({ force = false } = {}) {
    if (force) this.auto = true;
    if (!this.map) return;
    const pts = this.people.filter((p) => p.located).map((p) => [p.lat, p.lon]);
    const home = this.zones.find((z) => z.home);
    if (home) pts.push([home.lat, home.lon]);
    // Small moves inside the frame do not need the map to jump about.
    const key = pts.map(([a, b]) => `${a.toFixed(2)},${b.toFixed(2)}`).join(';');
    if (!force && key === this.fitKey) return;
    const first = !this.fitKey;
    this.fitKey = key;
    const animate = !first;
    if (!pts.length) {
      this.map.setView([20, 0], 2, { animate });
      return;
    }
    const bounds = this.L.latLngBounds(pts);
    if (bounds.getNorthEast().distanceTo(bounds.getSouthWest()) < 300) {
      this.map.setView(bounds.getCenter(), 16, { animate });
      return;
    }
    this.map.fitBounds(bounds, { padding: [48, 48], maxZoom: 17, animate });
  }

  /** Centre the map on one person. */
  focus(id) {
    const p = this.people.find((x) => x.id === id);
    if (!p?.located) return;
    if (!this.map) {
      this.pendingFocus = id;
      return;
    }
    this.auto = false;
    this.map.setView([p.lat, p.lon], Math.max(this.map.getZoom(), 15), { animate: true });
    const pin = this.markers.get(id)?.marker.getElement()?.querySelector('.pmap-pin');
    if (pin) {
      pin.classList.remove('pulse');
      void pin.offsetWidth;
      pin.classList.add('pulse');
    }
  }

  setExpanded(on) {
    this.expanded = on;
    // Full screen lives on <body>: the frosted card around the map would trap a fixed element.
    if (on) document.body.append(this.el);
    else if (this.slot?.isConnected) this.slot.append(this.el);
    else this.el.remove();
    this.el.classList.toggle('expanded', on);
    document.documentElement.classList.toggle('pmap-open', on);
    const b = this.el.querySelector('[data-pmap="expand"]');
    b.innerHTML = icon(on ? 'close' : 'fullscreen');
    b.setAttribute('aria-label', on ? 'Close full screen map' : 'Full screen map');
    if (this.map) {
      // Full screen: one finger pans and the mouse wheel zooms. Inline on a phone they scroll the page.
      for (const h of ['dragging', 'keyboard']) if (!this.fine) this.map[h][on ? 'enable' : 'disable']();
      this.map.scrollWheelZoom[on ? 'enable' : 'disable']();
      requestAnimationFrame(() => {
        this.map.invalidateSize(false);
        if (this.auto) this.fitAll({ force: true });
      });
    }
  }
}

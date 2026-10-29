// What a home needs at a glance, and a room's devices sorted into kinds.
// Rules go by domain, device class and device, never by one home's entity ids, so new blinds,
// switches and power points show up in the right place as soon as Home Assistant has them.
// Pure functions: app.js passes in what it knows about areas and devices.

import {
  domainOf, nameOf, isUnavailable, isCoverDoor, relativeTime,
} from './entities.js';

/**
 * @typedef {object} HomeCtx
 * @property {Map<string, object>} states
 * @property {(id: string) => boolean} listed      shown on the dashboard at all
 * @property {(id: string) => string|null} deviceOf
 * @property {(id: string) => string|null} areaOf
 * @property {(id: string) => object} shown        state with any optimistic change applied
 */

const SAFETY_CLASSES = new Set(['smoke', 'gas', 'carbon_monoxide', 'moisture', 'safety', 'tamper']);
export const OPENING_CLASSES = new Set(['door', 'window', 'opening', 'garage_door']);
export const MOTION_CLASSES = new Set(['motion', 'occupancy', 'presence']);
// Appliances have doors too; a dishwasher left ajar to dry is not news.
const APPLIANCE_WORDS = /dishwasher|washing|washer|dryer|oven|fridge|refrigerator|freezer|microwave|airfryer|air fryer/i;
// Lights that are meant to stay on, so "lights on" is not always one.
const STATUS_LIGHTS = /notification|indicator|status|night ?light|led ring/i;
// Sensors that measure something other than the room.
const NOT_ROOM_TEMP = /fridge|freezer|refrigerat|oven|water|pool|spa|cpu|battery|inverter|probe|heater|outdoor|outside/i;

const isOn = (s) => s?.state === 'on';
const minutesSince = (iso) => (Date.now() - new Date(iso).getTime()) / 60000;

/**
 * When Home Assistant last started, judged from the minute most states last changed in: a restart
 * stamps everything with the same time, which says nothing about when a person walked past.
 */
function restartMinute(states) {
  const counts = new Map();
  for (const s of states.values()) {
    const m = Math.floor(Date.parse(s.last_changed) / 60000);
    if (Number.isFinite(m)) counts.set(m, (counts.get(m) || 0) + 1);
  }
  let best = null;
  let n = 0;
  for (const [m, c] of counts) if (c > n) { best = m; n = c; }
  return n >= Math.max(10, states.size * 0.25) ? best : null;
}

/** Entity ids by device, for pairing a power point with its own power reading. */
export function devicesIndex(ctx) {
  const map = new Map();
  for (const id of ctx.states.keys()) {
    const d = ctx.deviceOf(id);
    if (!d) continue;
    if (!map.has(d)) map.set(d, []);
    map.get(d).push(id);
  }
  return map;
}

/** "Dryer Socket 1" -> "Dryer": the appliance a power point or switch is for. */
export function applianceName(s) {
  return nameOf(s).replace(/\s*(smart\s*)?(socket|plug|outlet|power ?point|gpo|switch|relay)\s*\d*\s*$/i, '').trim();
}

function siblings(id, ctx, devices) {
  const d = ctx.deviceOf(id);
  return d ? (devices.get(d) || []).filter((x) => x !== id) : [];
}

/** The "running" sensor for an appliance: on the same device, or named after it ("Dryer Running"). */
function runningSensorFor(s, ctx, devices) {
  const own = siblings(s.entity_id, ctx, devices).find((x) => domainOf(x) === 'binary_sensor' && /running|in use|active/i.test(nameOf(ctx.states.get(x) || {})));
  if (own) return ctx.states.get(own);
  const base = applianceName(s).toLowerCase();
  if (!base || base === nameOf(s).toLowerCase()) return null;
  for (const r of ctx.states.values()) {
    if (domainOf(r.entity_id) !== 'binary_sensor') continue;
    const n = nameOf(r).toLowerCase();
    if (n.startsWith(base) && /running$/.test(n)) return r;
  }
  return null;
}

/** Live watts drawn through a switch or power point, when it measures them. */
export function powerOf(s, ctx, devices) {
  let id = siblings(s.entity_id, ctx, devices).find((x) => domainOf(x) === 'sensor' && ctx.states.get(x)?.attributes?.device_class === 'power');
  if (!id) {
    const base = applianceName(s).toLowerCase();
    if (base && base !== nameOf(s).toLowerCase()) {
      id = [...ctx.states.values()].find((r) => domainOf(r.entity_id) === 'sensor' && r.attributes?.device_class === 'power'
        && nameOf(r).toLowerCase() === `${base} power`)?.entity_id;
    }
  }
  const r = id && ctx.states.get(id);
  if (!r || isUnavailable(r)) return null;
  const v = Number(r.state);
  if (!Number.isFinite(v)) return null;
  return r.attributes?.unit_of_measurement === 'kW' ? v * 1000 : v;
}

export function fmtWatts(w) {
  if (w == null) return '';
  return Math.abs(w) >= 1000 ? `${(w / 1000).toFixed(1)} kW` : `${Math.round(w)} W`;
}

/** What a switch or power point tile adds to its state: "Running · 450 W". */
export function switchNote(s, ctx, devices) {
  const parts = [];
  const running = runningSensorFor(s, ctx, devices);
  if (isOn(running)) parts.push('Running');
  const w = powerOf(s, ctx, devices);
  if (w != null && (s.state === 'on' || w > 0)) parts.push(fmtWatts(w));
  return parts.join(' · ');
}

// ---------- a room's devices, by kind ----------

const GROUPS = [
  ['alerts', 'Needs attention', 'alert'],
  ['cameras', 'Cameras', 'camera'],
  ['lights', 'Lights', 'light'],
  ['blinds', 'Blinds and curtains', 'cover'],
  ['doors', 'Doors and locks', 'door'],
  ['power', 'Switches and power points', 'outlet'],
  ['climate', 'Climate', 'climate'],
  ['media', 'Media', 'media_player'],
  ['scenes', 'Scenes', 'scene'],
  ['sensors', 'Sensors', 'sensor'],
];

function kindOf(s) {
  const domain = domainOf(s.entity_id);
  const dc = s.attributes?.device_class;
  switch (domain) {
    case 'camera': return 'cameras';
    case 'light': return 'lights';
    case 'cover': return isCoverDoor(s) ? 'doors' : 'blinds';
    case 'lock': return 'doors';
    case 'switch': case 'input_boolean': case 'siren': return 'power';
    case 'climate': case 'fan': case 'humidifier': case 'water_heater': return 'climate';
    case 'media_player': case 'remote': return 'media';
    case 'scene': case 'script': case 'button': case 'input_button': return 'scenes';
    case 'binary_sensor':
      if ((dc === 'problem' || SAFETY_CLASSES.has(dc)) && s.state === 'on') return 'alerts';
      if (OPENING_CLASSES.has(dc) && !APPLIANCE_WORDS.test(nameOf(s))) return 'doors';
      return 'sensors';
    default: return 'sensors';
  }
}

/**
 * A room's devices sorted into kinds, in the order people reach for them.
 * @returns {{key: string, title: string, icon: string, items: object[]}[]}
 */
export function roomGroups(ents) {
  const by = new Map();
  for (const s of ents) {
    const k = kindOf(s);
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(s);
  }
  return GROUPS.filter(([k]) => by.has(k)).map(([key, title, icon]) => ({ key, title, icon, items: by.get(key) }));
}

/** The temperature sensor that stands for the room, skipping fridges, water heaters and the like. */
export function roomTemperature(ents) {
  return ents.find((s) => domainOf(s.entity_id) === 'sensor' && s.attributes?.device_class === 'temperature'
    && s.state !== '' && Number.isFinite(Number(s.state)) && !NOT_ROOM_TEMP.test(nameOf(s))
    && Number(s.state) > -15 && Number(s.state) < 50);
}

export const isStatusLight = (s) => STATUS_LIGHTS.test(nameOf(s));

/** Open blinds, running appliances and live power in a room, for its label on the plan. */
export function roomExtras(ents) {
  const blinds = ents.filter((s) => domainOf(s.entity_id) === 'cover' && !isCoverDoor(s) && !isUnavailable(s));
  const running = ents.filter((s) => domainOf(s.entity_id) === 'binary_sensor' && isOn(s) && /running$/i.test(nameOf(s)));
  return {
    blinds: blinds.length,
    blindsOpen: blinds.filter((s) => s.state !== 'closed').length,
    running: running.length,
  };
}

// ---------- at a glance ----------

/** Fold several items of one kind into the first (most recent first). */
function merge(items, match, fold) {
  const list = items.filter(match).sort((a, b) => (a.age ?? 0) - (b.age ?? 0));
  if (list.length < 2) return;
  const at = items.indexOf(list[0]);
  for (const i of list) items.splice(items.indexOf(i), 1);
  items.splice(at, 0, fold(list));
}

/**
 * The few things worth knowing about the home right now, most pressing first.
 * Each: { key, tone: 'alert'|'warn'|'info'|'ok', icon, text, sub?, open?: entity_id, href?, act?: {label, domain, service, ids} }
 */
export function glanceItems(ctx, { areaName, solar } = {}) {
  const items = [];
  const devices = devicesIndex(ctx);
  const all = [...ctx.states.values()].filter((s) => ctx.listed(s.entity_id) && !isUnavailable(s)).map(ctx.shown);
  const where = (s) => {
    const a = ctx.areaOf(s.entity_id);
    const n = a ? areaName(a) : '';
    return n && !nameOf(s).toLowerCase().includes(n.toLowerCase()) ? n : '';
  };
  const since = (s) => relativeTime(s.last_changed).replace(/^in /, '');
  // Did this change really happen when it says? Seen on in this session, or not stamped by a restart.
  const boot = restartMinute(ctx.states);
  const real = (s) => ctx.seenOn?.(s.entity_id) || boot == null || Math.abs(Math.floor(Date.parse(s.last_changed) / 60000) - boot) > 1;

  const people = all.filter((s) => domainOf(s.entity_id) === 'person');
  const nobodyHome = people.length > 0 && people.every((p) => p.state !== 'home');

  for (const s of all) {
    const domain = domainOf(s.entity_id);
    const dc = s.attributes?.device_class;
    if (domain === 'alarm_control_panel' && s.state === 'triggered') {
      items.push({ key: s.entity_id, tone: 'alert', icon: 'alert', text: `${nameOf(s)} triggered`, open: s.entity_id });
    }
    if (domain === 'binary_sensor' && isOn(s) && (SAFETY_CLASSES.has(dc) || dc === 'problem')) {
      // A fault or leak needs doing something about; "rinse aid nearly empty" can wait for the next shop.
      const tone = SAFETY_CLASSES.has(dc) ? 'alert' : /fail|fault|leak|alarm|error|offline/i.test(nameOf(s)) ? 'warn' : 'info';
      items.push({ key: s.entity_id, tone, icon: 'alert', text: nameOf(s), sub: where(s), open: s.entity_id });
    }
    if (domain === 'cover' && isCoverDoor(s) && s.state !== 'closed') {
      items.push({ key: s.entity_id, tone: 'warn', icon: 'garageOpen', text: `${nameOf(s).replace(/\s+door\s+\d+$/i, ' door')} ${s.state === 'open' ? 'open' : s.state}`, sub: since(s), open: s.entity_id });
    }
    if (domain === 'lock' && (s.state === 'unlocked' || s.state === 'open')) {
      items.push({ key: s.entity_id, tone: 'warn', icon: 'lockOpen', text: `${nameOf(s)} unlocked`, sub: since(s), open: s.entity_id });
    }
    if (domain === 'binary_sensor' && OPENING_CLASSES.has(dc) && isOn(s) && !APPLIANCE_WORDS.test(nameOf(s))) {
      const n = nameOf(s).replace(/\b(door|window)\s+\1\b/i, '$1');
      items.push({ key: s.entity_id, tone: nobodyHome ? 'warn' : 'info', icon: 'door', text: `${n.charAt(0).toUpperCase()}${n.slice(1)} open`, sub: since(s), open: s.entity_id });
    }
    if (domain === 'sensor' && /warnings?$/i.test(nameOf(s)) && Number(s.state) > 0) {
      items.push({ key: s.entity_id, tone: 'warn', icon: 'weather', text: `${s.state} weather ${Number(s.state) === 1 ? 'warning' : 'warnings'}`, open: s.entity_id });
    }
  }

  // Cameras that saw someone in the last ten minutes.
  for (const s of all) {
    if (domainOf(s.entity_id) !== 'binary_sensor' || !MOTION_CLASSES.has(s.attributes?.device_class)) continue;
    const n = nameOf(s);
    if (!/person|people/i.test(n)) continue;
    const mins = minutesSince(s.last_changed);
    if (!isOn(s) && (mins > 10 || !real(s))) continue;
    const place = n.replace(/\s*(person|people)\s*(detected)?\s*$/i, '').trim();
    const cam = siblings(s.entity_id, ctx, devices).find((x) => domainOf(x) === 'camera')
      || [...ctx.states.keys()].find((x) => domainOf(x) === 'camera' && nameOf(ctx.states.get(x)).toLowerCase().startsWith(place.toLowerCase()));
    items.push({
      key: s.entity_id, tone: nobodyHome ? 'warn' : 'info', icon: 'person', age: isOn(s) ? 0 : mins,
      text: `Someone at ${place.replace(/\b([A-Z])([A-Z]+)\b/g, (m, a, b) => a + b.toLowerCase())}`,
      sub: isOn(s) ? 'now' : since(s), open: cam || s.entity_id,
    });
  }

  // Appliances: running now, or finished in the last 45 minutes.
  for (const s of all) {
    if (domainOf(s.entity_id) !== 'binary_sensor' || !/running$/i.test(nameOf(s))) continue;
    const appliance = nameOf(s).replace(/\s*running$/i, '');
    const mins = minutesSince(s.last_changed);
    if (isOn(s)) {
      const left = siblings(s.entity_id, ctx, devices).map((x) => ctx.states.get(x))
        .find((r) => r && /remaining|finish/i.test(nameOf(r)) && !isUnavailable(r));
      let sub = since(s).replace(/ ago$/, '');
      if (left && left.attributes?.device_class === 'timestamp') sub = `done ${relativeTime(left.state)}`;
      items.push({ key: s.entity_id, tone: 'info', icon: 'appliance', text: `${appliance} running`, sub: `for ${sub}`, open: s.entity_id });
    } else if (mins < 45 && real(s)) {
      items.push({ key: s.entity_id, tone: 'ok', icon: 'appliance', text: `${appliance} finished`, sub: since(s), open: s.entity_id, age: mins });
    }
  }

  const lightsOn = all.filter((s) => domainOf(s.entity_id) === 'light' && isOn(s) && !isStatusLight(s));
  if (lightsOn.length) {
    items.push({
      key: 'lights', tone: nobodyHome ? 'warn' : 'info', icon: 'light',
      text: `${lightsOn.length} ${lightsOn.length === 1 ? 'light' : 'lights'} on`,
      sub: lightsOn.length <= 2 ? lightsOn.map(nameOf).join(', ') : '',
      href: '#/entities?domain=light',
      act: { label: 'Turn off', domain: 'light', service: 'turn_off', ids: lightsOn.map((s) => s.entity_id) },
    });
  }

  const sun = ctx.states.get('sun.sun');
  const blindsOpen = all.filter((s) => domainOf(s.entity_id) === 'cover' && !isCoverDoor(s) && s.state === 'open');
  if (blindsOpen.length && sun?.state === 'below_horizon') {
    items.push({
      key: 'blinds', tone: 'info', icon: 'blindOpen', text: `${blindsOpen.length} ${blindsOpen.length === 1 ? 'blind' : 'blinds'} open`,
      sub: 'after dark', href: '#/entities?domain=cover',
      act: { label: 'Close', domain: 'cover', service: 'close_cover', ids: blindsOpen.map((s) => s.entity_id) },
    });
  }

  if (solar) items.push({ key: 'solar', tone: 'ok', icon: 'solar', text: solar.text, sub: solar.sub, href: '#/solar' });

  merge(items, (i) => i.icon === 'person', (list) => ({
    ...list[0], text: `${list[0].text} and ${list.length - 1} more`,
  }));
  merge(items, (i) => i.icon === 'appliance' && / finished$/.test(i.text), (list) => ({
    ...list[0], text: `${list.map((i) => i.text.replace(/ finished$/, '')).join(', ').replace(/, ([^,]*)$/, ' and $1')} finished`,
  }));

  const order = { alert: 0, warn: 1, info: 2, ok: 3 };
  items.sort((a, b) => order[a.tone] - order[b.tone]);
  if (nobodyHome) items.unshift({ key: 'away', tone: 'info', icon: 'home', text: 'Nobody home' });
  if (!items.some((i) => i.tone === 'alert' || i.tone === 'warn' || i.icon === 'door')) {
    items.push({ key: 'quiet', tone: 'ok', icon: 'check', text: 'Doors shut, all quiet' });
  }
  return items;
}

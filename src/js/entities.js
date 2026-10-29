// Helpers for turning raw Home Assistant states into things to display.

export const DOMAIN_LABELS = {
  light: 'Lights',
  switch: 'Switches',
  climate: 'Climate',
  sensor: 'Sensors',
  binary_sensor: 'Binary sensors',
  scene: 'Scenes',
  script: 'Scripts',
  automation: 'Automations',
  cover: 'Blinds and doors',
  fan: 'Fans',
  lock: 'Locks',
  media_player: 'Media',
  person: 'People',
  weather: 'Weather',
  camera: 'Cameras',
  input_boolean: 'Toggles',
  button: 'Buttons',
  vacuum: 'Vacuums',
  alarm_control_panel: 'Alarm',
  update: 'Updates',
  sun: 'Sun',
  calendar: 'Calendars',
  timer: 'Timers',
};

// Most useful first; everything else follows alphabetically.
const DOMAIN_ORDER = [
  'light', 'switch', 'climate', 'cover', 'fan', 'lock', 'media_player', 'scene',
  'script', 'sensor', 'binary_sensor', 'person', 'weather', 'camera', 'vacuum',
  'alarm_control_panel', 'input_boolean', 'button', 'automation',
];

const ACTIVE_STATES = new Set([
  'on', 'open', 'opening', 'closing', 'unlocked', 'unlocking', 'home', 'playing',
  'heat', 'cool', 'heat_cool', 'auto', 'dry', 'fan_only', 'cleaning', 'active',
  'armed_home', 'armed_away', 'armed_night', 'triggered', 'above_horizon',
]);

export const domainOf = (entityId) => entityId.slice(0, entityId.indexOf('.'));

export function domainLabel(domain) {
  return DOMAIN_LABELS[domain] || domain.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

export function compareDomains(a, b) {
  const ia = DOMAIN_ORDER.indexOf(a);
  const ib = DOMAIN_ORDER.indexOf(b);
  if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  return a.localeCompare(b);
}

export const nameOf = (s) => s.attributes?.friendly_name || s.entity_id;

// Scenes and buttons are stateless: their state is the last time they ran, or "unknown" if never.
const STATELESS = new Set(['scene', 'button', 'input_button']);

export const isUnavailable = (s) =>
  s.state === 'unavailable' || (s.state === 'unknown' && !STATELESS.has(domainOf(s.entity_id)));

export const isActive = (s) => ACTIVE_STATES.has(s.state);

export function iconFor(s) {
  const domain = domainOf(s.entity_id);
  const dc = s.attributes?.device_class;
  if (domain === 'light') return isActive(s) ? 'light' : 'lightOff';
  if (domain === 'switch') return dc === 'outlet' ? 'outlet' : isActive(s) ? 'switch' : 'switchOff';
  if (domain === 'climate' && HVAC_ICONS[s.state]) return HVAC_ICONS[s.state];
  if (domain === 'lock') return s.state === 'locked' ? 'lock' : 'lockOpen';
  if (domain === 'cover') {
    const shut = s.state === 'closed';
    if (dc === 'garage' || dc === 'gate' || dc === 'door') return shut ? 'garage' : 'garageOpen';
    return shut ? 'cover' : 'blindOpen';
  }
  if (domain === 'sensor') {
    if (dc === 'temperature') return 'temperature';
    if (dc === 'humidity') return 'humidity';
    if (dc === 'power' || dc === 'energy') return 'power';
    if (dc === 'battery') return 'battery';
  }
  if (domain === 'binary_sensor') {
    if (dc === 'door' || dc === 'window' || dc === 'opening' || dc === 'garage_door') return 'door';
    if (dc === 'occupancy' || dc === 'presence') return 'eye';
  }
  if (domain === 'input_number' || domain === 'number') return 'number';
  if (domain === 'input_select' || domain === 'select') return 'select';
  return domain;
}

const STATE_LABELS = {
  on: 'On', off: 'Off', open: 'Open', closed: 'Closed', opening: 'Opening', closing: 'Closing',
  locked: 'Locked', unlocked: 'Unlocked', home: 'Home', not_home: 'Away',
  playing: 'Playing', paused: 'Paused', idle: 'Idle', standby: 'Standby',
  recording: 'Recording', streaming: 'Streaming',
  unavailable: 'Unavailable', unknown: 'Unknown', heat: 'Heat', cool: 'Cool',
  heat_cool: 'Heat/Cool', auto: 'Auto', dry: 'Dry', fan_only: 'Fan',
  above_horizon: 'Above horizon', below_horizon: 'Below horizon',
};

const WEATHER_LABELS = {
  'clear-night': 'Clear', cloudy: 'Cloudy', exceptional: 'Exceptional', fog: 'Fog', hail: 'Hail',
  lightning: 'Lightning', 'lightning-rainy': 'Storms', partlycloudy: 'Partly cloudy', pouring: 'Pouring',
  rainy: 'Rainy', snowy: 'Snowy', 'snowy-rainy': 'Sleet', sunny: 'Sunny', windy: 'Windy', 'windy-variant': 'Windy',
};

const BINARY_LABELS = {
  door: ['Closed', 'Open'], window: ['Closed', 'Open'], opening: ['Closed', 'Open'],
  garage_door: ['Closed', 'Open'], motion: ['Clear', 'Detected'],
  occupancy: ['Clear', 'Detected'], presence: ['Away', 'Home'], moisture: ['Dry', 'Wet'],
  smoke: ['Clear', 'Detected'], battery: ['Normal', 'Low'], connectivity: ['Offline', 'Online'],
};

export function formatState(s) {
  const domain = domainOf(s.entity_id);
  const a = s.attributes || {};
  if (isUnavailable(s)) return STATE_LABELS[s.state];
  if (STATELESS.has(domain)) return 'Tap to run';
  if (domain === 'script') return s.state === 'on' ? 'Running' : 'Tap to run';
  if (domain === 'weather') {
    const label = WEATHER_LABELS[s.state] || s.state;
    return a.temperature != null ? `${label} · ${a.temperature}°` : label;
  }

  if (domain === 'binary_sensor' && BINARY_LABELS[a.device_class]) {
    return BINARY_LABELS[a.device_class][s.state === 'on' ? 1 : 0];
  }
  if (domain === 'climate' && a.current_temperature != null) {
    return `${STATE_LABELS[s.state] || s.state} · ${a.current_temperature}°`;
  }
  if (domain === 'cover' && a.current_position != null && s.state === 'open') {
    const p = Number(a.current_position);
    return p >= 100 ? 'Open' : `${p}% open`;
  }
  if (domain === 'light' && s.state === 'on' && a.brightness != null) {
    return `${Math.round((a.brightness / 255) * 100)}%`;
  }
  if (domain === 'sensor' && a.device_class === 'timestamp') {
    return relativeTime(s.state);
  }
  const num = Number(s.state);
  if (s.state !== '' && Number.isFinite(num)) {
    const rounded = Math.abs(num) >= 100 ? Math.round(num) : Math.round(num * 10) / 10;
    return a.unit_of_measurement ? `${rounded} ${a.unit_of_measurement}` : String(rounded);
  }
  return STATE_LABELS[s.state] || s.state.replace(/_/g, ' ');
}

export function relativeTime(iso) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const diff = (Date.now() - t) / 1000;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (abs < 45) return 'just now';
  if (abs < 3600) return rtf.format(-Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(-Math.round(diff / 3600), 'hour');
  return rtf.format(-Math.round(diff / 86400), 'day');
}

// ---------- what a tile does when tapped ----------

const TOGGLE_DOMAINS = new Set(['light', 'switch', 'input_boolean', 'fan']);
const RUN_SERVICES = {
  scene: 'turn_on',
  script: 'turn_on',
  button: 'press',
  input_button: 'press',
};

/**
 * The one-tap action for an entity's tile, or null when a tap should open its details.
 * @returns {{kind: 'toggle'|'run', domain: string, service: string} | null}
 */
export function primaryAction(s) {
  if (s.state === 'unavailable') return null;
  const domain = domainOf(s.entity_id);
  if (RUN_SERVICES[domain]) return { kind: 'run', domain, service: RUN_SERVICES[domain] };
  if (domain === 'cover') return coverAction(s);
  if (TOGGLE_DOMAINS.has(domain) && s.state !== 'unknown') {
    return { kind: 'toggle', domain, service: s.state === 'on' ? 'turn_off' : 'turn_on' };
  }
  return null;
}

// ---------- covers: blinds, shades, curtains, garage doors, gates ----------

const COVER_OPEN = 1;
const COVER_CLOSE = 2;
const COVER_STOP = 8;

/** Garage doors and gates: worth a second look before they move, unlike a blind. */
export const isCoverDoor = (s) => ['garage', 'gate', 'door'].includes(s.attributes?.device_class);

/** Which of open, close, stop and position this cover takes (all of them when HA does not say). */
export function coverFeatures(s) {
  const f = s.attributes?.supported_features;
  if (f == null) return { open: true, close: true, stop: true, position: s.attributes?.current_position != null, tilt: s.attributes?.current_tilt_position != null };
  return {
    open: !!(f & COVER_OPEN),
    close: !!(f & COVER_CLOSE),
    stop: !!(f & COVER_STOP),
    position: !!(f & 4) && s.attributes?.current_position != null,
    tilt: !!(f & 128) && s.attributes?.current_tilt_position != null,
  };
}

/** A tap stops a moving blind, otherwise closes an open one and opens a closed one. Garage doors open their sheet instead. */
function coverAction(s) {
  if (s.state === 'unknown' || isCoverDoor(s)) return null;
  const f = coverFeatures(s);
  if ((s.state === 'opening' || s.state === 'closing') && f.stop) return { kind: 'toggle', domain: 'cover', service: 'stop_cover' };
  if (s.state === 'closed' && f.open) return { kind: 'toggle', domain: 'cover', service: 'open_cover' };
  if (s.state === 'open' && f.close) return { kind: 'toggle', domain: 'cover', service: 'close_cover' };
  return null;
}

// ---------- light capabilities ----------

const COLOR_MODES = new Set(['hs', 'rgb', 'rgbw', 'rgbww', 'xy']);

export function lightFeatures(s) {
  const modes = s.attributes?.supported_color_modes || [];
  return {
    brightness: modes.some((m) => m !== 'onoff'),
    colorTemp: modes.includes('color_temp'),
    color: modes.some((m) => COLOR_MODES.has(m)),
  };
}

export const brightnessPct = (s) =>
  s.state === 'on' && s.attributes?.brightness != null ? Math.round((s.attributes.brightness / 255) * 100) : 0;

// ---------- climate ----------

export const HVAC_LABELS = {
  off: 'Off', heat: 'Heat', cool: 'Cool', heat_cool: 'Heat/Cool', auto: 'Auto', dry: 'Dry', fan_only: 'Fan',
};
export const HVAC_ICONS = {
  off: 'power', heat: 'fire', cool: 'snowflake', heat_cool: 'sunSnowflake', auto: 'thermostatAuto',
  dry: 'waterPercent', fan_only: 'fan',
};
const HVAC_ACTION_LABELS = {
  heating: 'Heating', cooling: 'Cooling', drying: 'Drying', fan: 'Fan running', idle: 'Idle',
  off: 'Off', preheating: 'Preheating', defrosting: 'Defrosting',
};

export const hvacActionLabel = (a) => HVAC_ACTION_LABELS[a] || (a ? a.replace(/_/g, ' ') : '');

/** Step for the target temperature buttons: HA's own, else 0.5 for °C and 1 for °F. */
export function tempStep(s, unit) {
  const a = s.attributes || {};
  if (a.target_temp_step) return a.target_temp_step;
  return unit === '°F' ? 1 : 0.5;
}

/** Which setpoints this thermostat uses right now: a single target or a low/high range. */
export function climateTargets(s) {
  const a = s.attributes || {};
  if (a.temperature != null) return { single: a.temperature };
  if (a.target_temp_low != null && a.target_temp_high != null) {
    return { low: a.target_temp_low, high: a.target_temp_high };
  }
  return {};
}

export const fmtTemp = (t) => (t == null ? '–' : `${Number(t).toFixed(Number.isInteger(Number(t)) ? 0 : 1)}°`);

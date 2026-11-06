// Bin night: shows which bins go out next, as little wheelie bins with coloured lids.
// Reads a sensor whose state names the bins by colour ("Red and green") and whose `date` attribute is that
// bin night (YYYY-MM-DD). homeassistant/bin_night.yaml makes one; any sensor with "bin" in its id and a
// `date` attribute works too, and so does `sensor.bin_night` without the date.

const BIN_COLOURS = {
  red: '#d6403a',
  yellow: '#f0c419',
  green: '#3d9b4a',
  lime: '#8cc63f',
  blue: '#2f6fd6',
  purple: '#8a52c9',
  orange: '#ee8a2a',
  black: '#2b2b2b',
  grey: '#8a8f98',
  gray: '#8a8f98',
};

const binPad = (n) => String(n).padStart(2, '0');
const binDayKey = (d) => `${d.getFullYear()}-${binPad(d.getMonth() + 1)}-${binPad(d.getDate())}`;

// The bin night sensor, or null. `states` is the Map of entity_id → state.
export function binSensor(states) {
  const named = states.get('sensor.bin_night');
  if (named) return named;
  for (const s of states.values()) {
    if (s.entity_id.startsWith('sensor.') && /bin/.test(s.entity_id) && /^\d{4}-\d\d-\d\d/.test(s.attributes?.date || '')) return s;
  }
  return null;
}

// { id, colours: [{ name, hex }], when: 'tonight' | 'tomorrow night' | 'Thursday' | '', soon } or null.
export function binNight(states, now = new Date()) {
  const s = binSensor(states);
  if (!s || ['unknown', 'unavailable', ''].includes(s.state)) return null;
  const words = String(s.state).toLowerCase().match(/[a-z]+/g) || [];
  const colours = [...new Set(words.filter((w) => BIN_COLOURS[w]))].map((name) => ({ name, hex: BIN_COLOURS[name] }));
  if (!colours.length) return null;
  const date = String(s.attributes?.date || '').slice(0, 10);
  let when = '';
  let soon = false;
  if (date) {
    const [y, m, d] = date.split('-').map(Number);
    const night = new Date(y, m - 1, d);
    const today = binDayKey(now);
    const tomorrow = binDayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
    if (date === today) { when = 'tonight'; soon = true; }
    else if (date === tomorrow) { when = 'tomorrow night'; soon = true; }
    else if (date > today) when = night.toLocaleDateString(undefined, { weekday: 'long' });
  }
  return { id: s.entity_id, colours, when, soon, text: String(s.state) };
}

// A wheelie bin: dark body, coloured lid.
export function binSvg(hex) {
  return `<svg class="bin-ic" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M6 8.5h12l-1.25 11.1a1.6 1.6 0 0 1-1.6 1.4H8.85a1.6 1.6 0 0 1-1.6-1.4z" fill="var(--bin-body)"/>
    <rect x="4" y="4.5" width="16" height="3.4" rx="1.2" fill="${hex}"/>
    <rect x="9.5" y="2.8" width="5" height="2.2" rx="0.8" fill="${hex}"/>
    <rect x="7.8" y="9.6" width="8.4" height="1.6" rx="0.8" fill="${hex}" opacity="0.85"/>
  </svg>`;
}

const binCap = (t) => t.charAt(0).toUpperCase() + t.slice(1);

// Joined names: "Red and green", "Red, yellow and green".
export function binWords(colours) {
  const n = colours.map((c) => c.name);
  return binCap(n.length > 1 ? `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}` : n[0]);
}

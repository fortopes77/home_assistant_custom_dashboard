// Solar, battery, grid and home power flow, drawn like the Sigen app.
// Works with Sigenergy Cloud or Sigenergy Local Modbus sensors (or any similar ones):
// sensors are found by name, and can be picked by hand in Settings.

import { ICONS } from './icons.js';
import { esc } from './controls.js';

export const ENERGY_ROLES = [
  { key: 'solar', label: 'Solar power' },
  { key: 'grid', label: 'Grid power' },
  { key: 'battery', label: 'Battery power' },
  { key: 'home', label: 'Home use' },
  { key: 'soc', label: 'Battery level' },
];

const ENERGY_MATCH = {
  solar: { test: /\b(pv|solar|photovoltaic)\b/, skip: /string|mppt|daily|today|total|month|annual|year|lifetime|third.?party|rated|max/ },
  grid: { test: /\bgrid\b/, skip: /phase|frequency|voltage|current|reactive|limit|max|rated|daily|today|total/ },
  battery: { test: /\b(battery|bat|ess)\b/, skip: /available|max|rated|limit|capacity|daily|today|total|evdc|dc.?charger/ },
  home: { test: /\b(load|consumption|consumed|house|home)\b/, skip: /daily|today|total|month|annual|limit/ },
};

const ENERGY_TODAY = [
  { key: 'pvToday', label: 'Solar today', test: /(daily|today).*(pv|solar|generation)|(pv|solar).*(daily|today)/, skip: /month|annual|third|import|export|grid|battery|charg|consum|load|home/ },
  { key: 'importToday', label: 'Bought today', test: /(daily|today).*import|import.*(daily|today)/ },
  { key: 'exportToday', label: 'Sold today', test: /(daily|today).*export|export.*(daily|today)/ },
  { key: 'chargeToday', label: 'Charged today', test: /(daily|today).*charg|charg.*(daily|today)/, skip: /discharg|ev|charger/ },
  { key: 'dischargeToday', label: 'Discharged today', test: /(daily|today).*discharg|discharg.*(daily|today)/, skip: /ev|charger/ },
  { key: 'homeToday', label: 'Used today', test: /(daily|today).*(load|consum)|(load|consum).*(daily|today)/ },
];

function enText(s) {
  return `${s.entity_id.replace(/[._]/g, ' ')} ${s.attributes?.friendly_name || ''}`.toLowerCase();
}

function enIsPower(s) {
  const u = s.attributes?.unit_of_measurement;
  return s.entity_id.startsWith('sensor.') && (s.attributes?.device_class === 'power' || u === 'W' || u === 'kW');
}

function enIsEnergy(s) {
  const u = s.attributes?.unit_of_measurement;
  return s.entity_id.startsWith('sensor.') && (u === 'kWh' || u === 'Wh');
}

// Whole-system sensors win over one inverter's: shorter ids, no "_2" copies, Sigenergy "plant" names.
function enScore(s) {
  const id = s.entity_id;
  return id.length + (/_\d+$/.test(id) ? 40 : 0) - (/plant|sigen/.test(id) ? 15 : 0)
    + (/inverter|meter|gateway/.test(enText(s)) ? 30 : 0);
}

function enBest(list) {
  return list.sort((a, b) => enScore(a) - enScore(b))[0]?.entity_id || null;
}

// All power sensors, for the pickers in Settings.
export function energyPowerSensors(states) {
  return [...states.values()].filter(enIsPower);
}

export function energyBatterySensors(states) {
  return [...states.values()].filter((s) => s.entity_id.startsWith('sensor.')
    && s.attributes?.unit_of_measurement === '%'
    && (s.attributes?.device_class === 'battery' || /\b(soc|state of charge)\b/.test(enText(s))));
}

// role -> entity_id the dashboard would use on its own.
export function energyAuto(states) {
  const power = energyPowerSensors(states);
  const found = {};
  for (const [role, m] of Object.entries(ENERGY_MATCH)) {
    found[role] = enBest(power.filter((s) => {
      const t = enText(s);
      return m.test.test(t) && !m.skip.test(t);
    }));
  }
  // The battery level: prefer the solar system's battery over phones and sensors.
  const socs = energyBatterySensors(states).filter((s) => /\b(soc|state of charge|plant|sigen|ess)\b/.test(enText(s)));
  found.soc = enBest(socs);
  return found;
}

export function energyEntities(states, picks = {}) {
  const auto = energyAuto(states);
  const ids = {};
  for (const { key } of ENERGY_ROLES) {
    const p = picks[key];
    ids[key] = p === 'none' ? null : (p && states.has(p) ? p : auto[key]);
  }
  const energy = [...states.values()].filter(enIsEnergy);
  ids.today = {};
  for (const t of ENERGY_TODAY) {
    ids.today[t.key] = enBest(energy.filter((s) => {
      const x = enText(s);
      return t.test.test(x) && !(t.skip && t.skip.test(x));
    }));
  }
  return ids;
}

function enKw(s) {
  if (!s) return null;
  const v = Number(s.state);
  if (!Number.isFinite(v)) return null;
  return s.attributes?.unit_of_measurement === 'W' ? v / 1000 : v;
}

// Which way the grid and battery numbers point varies by integration. With all four powers known,
// the combination that adds up (solar + bought - sold + discharged - charged = home) tells us.
// sign.grid = 1: positive grid means buying; sign.battery = 1: positive battery means charging.
export function energyLearnSigns({ solar, grid, battery, home }) {
  if ([solar, grid, battery, home].some((v) => v === null)) return null;
  const tries = [];
  for (const g of [1, -1]) for (const b of [1, -1]) tries.push({ g, b, err: Math.abs(solar + g * grid - b * battery - home) });
  tries.sort((x, y) => x.err - y.err);
  const scale = Math.max(home, solar, Math.abs(grid), Math.abs(battery), 0.3);
  if (tries[0].err > 0.2 * scale) return null; // the numbers do not add up; don't guess
  const out = {};
  // Only a sign that changes the sum can be learned from this reading.
  if (Math.abs(grid) > 0.1 && Math.abs(grid) > 0.15 * scale) out.grid = tries[0].g;
  if (Math.abs(battery) > 0.1 && Math.abs(battery) > 0.15 * scale) out.battery = tries[0].b;
  if (out.grid && out.battery) {
    const rival = tries.find((t) => t.g !== tries[0].g || t.b !== tries[0].b);
    if (rival.err - tries[0].err < 0.05) return null;
  }
  return Object.keys(out).length ? out : null;
}

// Positive, directional flows in kW, ready to draw.
export function energyFlow(states, ids, sign = {}) {
  const get = (id) => (id ? states.get(id) : null);
  const raw = {
    solar: enKw(get(ids.solar)),
    grid: enKw(get(ids.grid)),
    battery: enKw(get(ids.battery)),
    home: enKw(get(ids.home)),
  };
  const sg = sign.grid || 1;
  const sb = sign.battery || 1;
  const solar = raw.solar === null ? null : Math.max(0, raw.solar);
  let grid = raw.grid === null ? null : sg * raw.grid;           // + buying
  const battery = raw.battery === null ? null : sb * raw.battery; // + charging
  let home = raw.home === null ? null : Math.max(0, raw.home);
  if (home === null && solar !== null && grid !== null) home = Math.max(0, solar + grid - (battery || 0));
  if (grid === null && solar !== null && home !== null) grid = home + (battery || 0) - solar;
  const socState = get(ids.soc);
  const soc = socState && Number.isFinite(Number(socState.state)) ? Number(socState.state) : null;
  const today = {};
  for (const t of ENERGY_TODAY) {
    const s = get(ids.today?.[t.key]);
    const v = s ? Number(s.state) : NaN;
    if (Number.isFinite(v)) today[t.key] = { id: s.entity_id, label: t.label, kwh: s.attributes?.unit_of_measurement === 'Wh' ? v / 1000 : v };
  }
  return {
    raw,
    solar,
    home,
    buying: grid === null ? null : Math.max(0, grid),
    selling: grid === null ? null : Math.max(0, -grid),
    charging: battery === null ? null : Math.max(0, battery),
    discharging: battery === null ? null : Math.max(0, -battery),
    hasGrid: grid !== null,
    hasBattery: battery !== null || soc !== null,
    soc,
    today,
    found: !!(ids.solar || ids.battery || ids.grid),
  };
}

export function energyPower(kw) {
  if (kw === null || kw === undefined) return '–';
  const a = Math.abs(kw);
  if (a < 0.995) return `${Math.round(a * 1000)} W`;
  return `${a.toFixed(a < 10 ? 1 : 0)} kW`;
}

const EN_IDLE = 0.02; // kW; below this a line is drawn still

// Geometry (viewBox 360 x 280): solar on top, grid left, home right, battery below, the inverter in the middle.
const EN_HUB = { x: 180, y: 140 };
const EN_NODES = {
  solar: { x: 180, y: 46 },
  grid: { x: 52, y: 140 },
  home: { x: 308, y: 140 },
  battery: { x: 180, y: 234 },
};
const EN_R = 30;

function enLine(from, to, curve) {
  // From the edge of one circle to the edge of the other, bowed slightly so it reads as flowing.
  const a = EN_NODES[from] || EN_HUB;
  const b = EN_NODES[to] || EN_HUB;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  const ra = EN_NODES[from] ? EN_R + 4 : 6;
  const rb = EN_NODES[to] ? EN_R + 4 : 6;
  const x1 = a.x + (dx / len) * ra;
  const y1 = a.y + (dy / len) * ra;
  const x2 = b.x - (dx / len) * rb;
  const y2 = b.y - (dy / len) * rb;
  const mx = (x1 + x2) / 2 - (dy / len) * curve;
  const my = (y1 + y2) / 2 + (dx / len) * curve;
  return `M${x1.toFixed(1)} ${y1.toFixed(1)}Q${mx.toFixed(1)} ${my.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`;
}

// One leg between a node and the hub. `out` = power flows from the hub to the node.
function enLeg(node, kw, out, cls) {
  const on = kw !== null && kw > EN_IDLE;
  const d = out ? enLine('hub', node, 0) : enLine(node, 'hub', 0);
  // Faster dots for more power.
  const dur = on ? Math.max(0.7, 2.6 - Math.log10(1 + kw * 4) * 1.5) : 0;
  return `<path class="en-track" d="${d}"/>
    ${on ? `<path class="en-flow ${cls}" d="${d}" style="animation-duration:${dur.toFixed(2)}s"/>` : ''}`;
}

const EN_ICON = {
  solar: `<g class="en-glyph" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round">
    <path d="M5 5h14l2.5 10h-19z"/><path d="M3.8 10h16.4M9.7 5l-.8 10M14.3 5l.8 10"/><path d="M12 15v4M8.5 19h7"/></g>`,
  grid: `<g class="en-glyph" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round">
    <path d="M8 22 12 2l4 20"/><path d="M5 6h14M6.8 11h10.4M9 16.5h6"/><path d="M8.6 6l6.6 5M15.4 6l-6.6 5M9.6 11l5.2 5.5M14.4 11l-5.2 5.5"/></g>`,
  home: `<path class="en-glyph" fill="currentColor" d="${ICONS.home}"/>`,
};

function enBatteryIcon(soc) {
  const level = soc === null ? 0 : Math.max(0, Math.min(100, soc));
  const h = (14.5 * level) / 100;
  return `<g class="en-glyph">
    <rect x="9.5" y="1.5" width="5" height="2.2" rx="0.8" fill="currentColor"/>
    <rect x="6.5" y="3.6" width="11" height="18.4" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.6"/>
    ${h > 0.3 ? `<rect class="en-level${level < 15 ? ' low' : ''}" x="8.4" y="${(20.2 - h).toFixed(2)}" width="7.2" height="${h.toFixed(2)}" rx="1"/>` : ''}
  </g>`;
}

function enNode(key, glyph, entity, label, value, sub, labelAt) {
  const n = EN_NODES[key];
  const tag = entity ? `role="button" tabindex="0" data-energy="${esc(entity)}" aria-label="${esc(`${label}: ${value}${sub ? `, ${sub}` : ''}`)}"` : '';
  const anchor = labelAt === 'right' ? 'start' : 'middle';
  const lx = labelAt === 'right' ? n.x + EN_R + 12 : n.x;
  const ly = labelAt === 'right' ? n.y - 6 : n.y + EN_R + 20;
  return `<g class="en-node en-${key}" ${tag}>
    <circle class="en-ring" cx="${n.x}" cy="${n.y}" r="${EN_R}"/>
    <g transform="translate(${n.x - 14.4} ${n.y - 14.4}) scale(1.2)">${glyph}</g>
    <text class="en-label" x="${lx}" y="${ly}" text-anchor="${anchor}">${esc(label)}</text>
    <text class="en-value" x="${lx}" y="${ly + 19}" text-anchor="${anchor}">${esc(value)}</text>
    ${sub ? `<text class="en-sub" x="${lx}" y="${ly + 35}" text-anchor="${anchor}">${esc(sub)}</text>` : ''}
  </g>`;
}

// opts.title: the heading over the card ('' for none); opts.today: today's totals to show (defaults to the sensors').
export function energyHtml(flow, ids, opts = {}) {
  const f = flow;
  const gridKw = f.buying > EN_IDLE ? f.buying : f.selling;
  const gridSub = !f.hasGrid ? '' : f.buying > EN_IDLE ? 'Buying' : f.selling > EN_IDLE ? 'Selling' : 'Idle';
  const batKw = f.charging > EN_IDLE ? f.charging : f.discharging;
  const batSub = f.charging > EN_IDLE ? 'Charging' : f.discharging > EN_IDLE ? 'Discharging' : f.raw.battery !== null ? 'Idle' : '';
  const batValue = f.soc !== null ? `${Math.round(f.soc)}%` : energyPower(batKw);
  const batLine = [f.soc !== null && f.raw.battery !== null ? energyPower(batKw) : '', batSub].filter(Boolean).join(' · ');

  const legs = [
    enLeg('solar', f.solar, false, 'solar'),
    f.hasGrid ? enLeg('grid', gridKw, f.selling > EN_IDLE, f.selling > EN_IDLE ? 'solar' : 'grid') : '',
    f.hasBattery ? enLeg('battery', batKw, f.charging > EN_IDLE, 'battery') : '',
    enLeg('home', f.home, true, 'home'),
  ].join('');

  const today = opts.today || Object.values(f.today);
  const title = opts.title ?? 'Solar and battery';
  return `<section class="energy">
    ${title ? `<h2 class="section-title">${esc(title)}</h2>` : ''}
    <div class="energy-card">
      <svg class="energy-svg" viewBox="0 0 360 280" role="group" aria-label="Power flow">
        ${legs}
        <circle class="en-hub" cx="${EN_HUB.x}" cy="${EN_HUB.y}" r="6"/>
        ${enNode('solar', EN_ICON.solar, ids.solar, 'Solar', energyPower(f.solar), '', 'right')}
        ${f.hasGrid ? enNode('grid', EN_ICON.grid, ids.grid, 'Grid', energyPower(gridKw), gridSub) : ''}
        ${enNode('home', EN_ICON.home, ids.home, 'Home', energyPower(f.home), '')}
        ${f.hasBattery ? enNode('battery', enBatteryIcon(f.soc), ids.soc || ids.battery, 'Battery', batValue, batLine, 'right') : ''}
      </svg>
      ${today.length ? `<div class="energy-today">${today.map(enStat).join('')}</div>` : ''}
    </div>
  </section>`;
}

// One of today's totals: a sensor's (tap for its history) or worked out from the last 24 hours ("est.").
function enStat(t) {
  const value = t.pct !== undefined
    ? `${Math.round(t.pct)}<small>%</small>`
    : `${t.kwh.toFixed(t.kwh < 100 ? 1 : 0)} <small>kWh</small>`;
  const body = `<span class="energy-stat-value">${value}</span>
    <span class="energy-stat-label">${esc(t.label)}${t.est ? ' <small title="Worked out from the power readings">est.</small>' : ''}</span>`;
  return t.id
    ? `<button type="button" class="energy-stat" data-energy="${esc(t.id)}">${body}</button>`
    : `<div class="energy-stat">${body}</div>`;
}

// After drawing: start each moving line where the clock says it should be, so redraws don't make the dots jump.
export function energyAnimate(root) {
  const t = performance.now() / 1000;
  for (const el of root.querySelectorAll('.en-flow')) {
    const dur = parseFloat(el.style.animationDuration) || 1;
    el.style.animationDelay = `${-(t % dur).toFixed(2)}s`;
  }
}

// ---------- the last 24 hours ----------

export const ENERGY_SLOT = 5 * 60_000; // charts and totals work in 5-minute slots

// Readings ([{ t, s }], oldest first) as one value per slot ending at `end`: the slot's readings averaged,
// or the last reading held through a quiet slot. null where the sensor had no number.
function enSlots(points, end, scale, hours = 24) {
  const n = (hours * 3_600_000) / ENERGY_SLOT;
  const start = end - n * ENERGY_SLOT;
  const out = new Array(n).fill(null);
  let i = 0;
  let last = null;
  const val = (p) => { const v = Number(p.s); return Number.isFinite(v) ? v * scale : null; };
  for (let k = 0; k < n; k++) {
    const a = start + k * ENERGY_SLOT;
    const b = a + ENERGY_SLOT;
    while (i < points.length && points[i].t < a) last = val(points[i++]);
    let sum = last ?? 0;
    let cnt = last === null ? 0 : 1;
    while (i < points.length && points[i].t < b) {
      last = val(points[i++]);
      if (last !== null) { sum += last; cnt++; }
    }
    out[k] = cnt && last !== null ? sum / cnt : null;
  }
  return out;
}

/**
 * Slot values for each role from recorded history, with the same signs as the live flow:
 * grid + buying, battery + charging, all in kW (battery level in %). Home is worked out when there is no sensor.
 * hist: role -> [{ t, s }]
 */
export function energyHistoryModel(hist, ids, states, sign, end) {
  const scale = (id) => (states.get(id)?.attributes?.unit_of_measurement === 'W' ? 1 / 1000 : 1);
  const m = { end, start: end - 24 * 3_600_000 };
  for (const role of ['solar', 'grid', 'battery', 'home', 'soc']) {
    if (ids[role] && hist[role]) m[role] = enSlots(hist[role], end, role === 'soc' ? 1 : scale(ids[role]));
  }
  const times = (arr, k) => arr && arr.map((v) => (v === null ? null : v * k));
  m.grid = times(m.grid, sign.grid || 1);
  m.battery = times(m.battery, sign.battery || 1);
  if (m.solar) m.solar = m.solar.map((v) => (v === null ? null : Math.max(0, v)));
  if (!m.home && m.solar && m.grid) {
    m.home = m.solar.map((s, k) => (s === null || m.grid[k] === null ? null : Math.max(0, s + m.grid[k] - (m.battery?.[k] || 0))));
  }
  return m;
}

// kWh since midnight from slot values; part = 1 counts the positive side, -1 the negative side.
function enKwhToday(values, m, part = 1) {
  if (!values) return null;
  const midnight = new Date(m.end - 1);
  midnight.setHours(0, 0, 0, 0);
  const from = Math.max(0, Math.ceil((midnight - m.start) / ENERGY_SLOT));
  let kwh = 0;
  let seen = false;
  for (let k = from; k < values.length; k++) {
    if (values[k] === null) continue;
    seen = true;
    kwh += Math.max(0, part * values[k]) * (ENERGY_SLOT / 3_600_000);
  }
  return seen ? kwh : null;
}

/** Today's totals: the integration's own daily sensors where there are any, else worked out from history. */
export function energyToday(flow, m) {
  const est = m ? {
    pvToday: enKwhToday(m.solar, m),
    importToday: enKwhToday(m.grid, m, 1),
    exportToday: enKwhToday(m.grid, m, -1),
    chargeToday: enKwhToday(m.battery, m, 1),
    dischargeToday: enKwhToday(m.battery, m, -1),
    homeToday: enKwhToday(m.home, m),
  } : {};
  const out = [];
  for (const t of ENERGY_TODAY) {
    if (flow.today[t.key]) out.push(flow.today[t.key]);
    else if (est[t.key] != null) out.push({ id: null, label: t.label, kwh: est[t.key], est: true });
  }
  const get = (k) => out.find((t) => t.label === ENERGY_TODAY.find((x) => x.key === k).label);
  const used = get('homeToday');
  const bought = get('importToday');
  if (used && bought && used.kwh > 0.5) {
    out.push({ id: null, label: 'Self-powered', pct: Math.max(0, Math.min(100, (1 - bought.kwh / used.kwh) * 100)), est: used.est || bought.est });
  }
  return out;
}

const EN_W = 600;
const EN_H = 120;
const enCharts = new Map(); // chart key -> { m, series } for the tap/hover readout

function enNice(v) {
  for (const s of [0.5, 1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50]) if (v <= s) return s;
  return Math.ceil(v / 10) * 10;
}

// Runs of values without gaps, as [[k, v], ...].
function enRuns(values) {
  const runs = [];
  let run = [];
  values.forEach((v, k) => {
    if (v === null) { if (run.length) runs.push(run); run = []; } else run.push([k, v]);
  });
  if (run.length) runs.push(run);
  return runs;
}

function enChart({ key, title, m, series, min, max, unit, summary }) {
  const n = m.start === undefined ? 0 : (m.end - m.start) / ENERGY_SLOT;
  const x = (k) => ((k + 0.5) / n) * EN_W;
  const y = (v) => EN_H - ((Math.max(min, Math.min(max, v)) - min) / (max - min)) * EN_H;
  const base = y(Math.max(min, 0));
  const paths = series.map((s) => enRuns(s.values).map((run) => {
    const line = run.map(([k, v], i) => `${i ? 'L' : 'M'}${x(k).toFixed(1)} ${y(v).toFixed(1)}`).join('');
    const first = x(run[0][0]).toFixed(1);
    const lastX = x(run[run.length - 1][0]).toFixed(1);
    return `${s.area ? `<path class="en-area ${s.cls}" d="M${first} ${base.toFixed(1)}L${line.slice(1)}L${lastX} ${base.toFixed(1)}Z"/>` : ''}
      <path class="en-line ${s.cls}" d="${line}" vector-effect="non-scaling-stroke"/>`;
  }).join('')).join('');
  const axisLabel = (v) => (unit === '%' ? `${v}%` : `${Math.abs(v)} kW`);
  const ticks = [];
  const tick = new Date(m.start);
  tick.setMinutes(0, 0, 0);
  while (+tick < m.end) {
    if (+tick > m.start + 3_600_000 && tick.getHours() % 6 === 0) {
      ticks.push(`<span style="left:${(((+tick - m.start) / (m.end - m.start)) * 100).toFixed(2)}%">${esc(tick.toLocaleTimeString(undefined, { hour: 'numeric' }))}</span>`);
    }
    tick.setHours(tick.getHours() + 1);
  }
  enCharts.set(key, { m, series });
  const legend = series.filter((s) => s.label).map((s) => `<span class="en-key ${s.cls}">${esc(s.label)}</span>`).join('');
  return `<figure class="en-chart" data-chart="${key}">
    <figcaption class="en-chart-head">
      <span class="en-chart-title">${esc(title)}</span>
      <span class="en-chart-info muted">${legend}${summary ? `<span>${esc(summary)}</span>` : ''}</span>
      <span class="en-readout" hidden></span>
    </figcaption>
    <div class="en-plot">
      <svg viewBox="0 0 ${EN_W} ${EN_H}" preserveAspectRatio="none" aria-hidden="true">
        <line class="en-grid-line" x1="0" x2="${EN_W}" y1="0.5" y2="0.5" vector-effect="non-scaling-stroke"/>
        <line class="en-grid-line zero" x1="0" x2="${EN_W}" y1="${base.toFixed(1)}" y2="${base.toFixed(1)}" vector-effect="non-scaling-stroke"/>
        ${min < 0 ? `<line class="en-grid-line" x1="0" x2="${EN_W}" y1="${EN_H - 0.5}" y2="${EN_H - 0.5}" vector-effect="non-scaling-stroke"/>` : ''}
        ${paths}
      </svg>
      <span class="en-y top" style="top:0">${axisLabel(max)}</span>
      ${min < 0 ? `<span class="en-y bottom" style="top:100%">${axisLabel(min)}</span>` : ''}
      <span class="en-cursor" hidden></span>
    </div>
    <div class="en-x muted">${ticks.join('')}</div>
  </figure>`;
}

function enPeak(values) {
  let best = -1;
  values.forEach((v, k) => { if (v !== null && (best < 0 || v > values[best])) best = k; });
  return best;
}

const enTime = (m, k) => new Date(m.start + (k + 0.5) * ENERGY_SLOT).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const enPos = (v) => (v === null ? null : Math.max(0, v));
const enNeg = (v) => (v === null ? null : Math.min(0, v));

/** The 24-hour charts: solar and home use, the grid, the battery. */
export function energyChartsHtml(m, { loading = false, error = '' } = {}) {
  if (loading && !m) return '<div class="chart chart-loading"><div class="spinner" aria-hidden="true"></div></div>';
  if (error && !m) return `<p class="muted">History unavailable (${esc(error)}).</p>`;
  if (!m) return '';
  const top = (...arrs) => enNice(Math.max(0.1, ...arrs.flat().filter((v) => v !== null).map(Math.abs)));
  const charts = [];
  if (m.solar || m.home) {
    const peak = m.solar ? enPeak(m.solar) : -1;
    charts.push(enChart({
      key: 'solar',
      title: 'Solar and home use',
      m,
      series: [
        m.solar && { name: 'Solar', label: 'Solar', cls: 'solar', values: m.solar, area: true, fmt: (v) => `Solar ${energyPower(v)}` },
        m.home && { name: 'Home', label: 'Home', cls: 'home', values: m.home, fmt: (v) => `Home ${energyPower(v)}` },
      ].filter(Boolean),
      min: 0,
      max: top(m.solar || [], m.home || []),
      summary: peak >= 0 && m.solar[peak] > 0.05 ? `Peak ${energyPower(m.solar[peak])} at ${enTime(m, peak)}` : '',
    }));
  }
  if (m.grid) {
    const buy = m.grid.map(enPos);
    const sell = m.grid.map(enNeg);
    const hasSell = sell.some((v) => v !== null && v < -0.01);
    charts.push(enChart({
      key: 'grid',
      title: 'Grid',
      m,
      series: [
        { name: 'Bought', label: 'Bought', cls: 'grid', values: buy, area: true, fmt: (v) => (v > 0.005 ? `Buying ${energyPower(v)}` : null) },
        hasSell && { name: 'Sold', label: 'Sold', cls: 'solar', values: sell, area: true, fmt: (v) => (v < -0.005 ? `Selling ${energyPower(-v)}` : null) },
      ].filter(Boolean),
      min: hasSell ? -top(sell) : 0,
      max: top(buy),
    }));
  }
  if (m.soc) {
    charts.push(enChart({
      key: 'battery',
      title: 'Battery level',
      m,
      series: [{ name: 'Battery', cls: 'battery', values: m.soc, area: true, fmt: (v) => `Battery ${Math.round(v)}%` }],
      min: 0,
      max: 100,
      unit: '%',
    }));
  } else if (m.battery) {
    const lim = top(m.battery);
    charts.push(enChart({
      key: 'battery',
      title: 'Battery',
      m,
      series: [
        { name: 'Charging', label: 'Charging', cls: 'battery', values: m.battery.map(enPos), area: true, fmt: (v) => (v > 0.005 ? `Charging ${energyPower(v)}` : null) },
        { name: 'Discharging', label: 'Discharging', cls: 'home', values: m.battery.map(enNeg), area: true, fmt: (v) => (v < -0.005 ? `Discharging ${energyPower(-v)}` : null) },
      ],
      min: -lim,
      max: lim,
    }));
  }
  if (!charts.length) return '';
  return `<div class="en-charts">${charts.join('')}</div>`;
}

// Touch or hover a chart to read the values at that time; mouse readouts clear on leave, touch ones after a moment.
export function energyChartsWire(root) {
  for (const fig of root.querySelectorAll('.en-chart')) {
    const data = enCharts.get(fig.dataset.chart);
    if (!data) continue;
    const plot = fig.querySelector('.en-plot');
    const cursor = fig.querySelector('.en-cursor');
    const info = fig.querySelector('.en-chart-info');
    const readout = fig.querySelector('.en-readout');
    const n = data.series[0].values.length;
    let timer = 0;
    const hide = () => { cursor.hidden = true; readout.hidden = true; info.hidden = false; };
    const show = (e) => {
      const r = plot.getBoundingClientRect();
      const k = Math.max(0, Math.min(n - 1, Math.floor(((e.clientX - r.left) / r.width) * n)));
      const parts = data.series.map((s) => (s.values[k] === null ? null : s.fmt(s.values[k]))).filter(Boolean);
      readout.textContent = `${enTime(data.m, k)} · ${parts.length ? parts.join(' · ') : (data.series[0].values[k] === null ? 'No reading' : 'Idle')}`;
      cursor.style.left = `${(((k + 0.5) / n) * 100).toFixed(2)}%`;
      cursor.hidden = false;
      readout.hidden = false;
      info.hidden = true;
      clearTimeout(timer);
      if (e.pointerType !== 'mouse') timer = setTimeout(hide, 4000);
    };
    plot.addEventListener('pointerdown', show);
    plot.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse' || e.buttons) show(e); });
    plot.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hide(); });
  }
}

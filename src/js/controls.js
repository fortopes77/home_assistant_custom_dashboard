// Device tiles and the controls inside a device's sheet. Pure HTML builders: main.js wires the
// data-act / data-slide attributes to Home Assistant actions.

import { icon } from './icons.js';
import {
  domainOf, nameOf, isUnavailable, isActive, iconFor, formatState, relativeTime, primaryAction,
  coverFeatures, isCoverDoor, lightFeatures, brightnessPct, climateTargets, fmtTemp, HVAC_LABELS, hvacActionLabel,
} from './entities.js';

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

/** A name without the room it is already listed under ("Kitchen Light" in Kitchen -> "Light"). */
export function shortName(s, room = '') {
  const n = nameOf(s);
  if (!room) return n;
  const cut = n.replace(new RegExp(`^${room.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+`, 'i'), '');
  return cut && cut !== n ? cut.charAt(0).toUpperCase() + cut.slice(1) : n;
}

/**
 * One device as a tile. A tap runs its one-tap action (toggle, run, open/close a blind)
 * or opens its sheet; the corner button always opens the sheet.
 */
export function deviceTile(s, { room = '', note = '', pending = false } = {}) {
  const id = s.entity_id;
  const act = primaryAction(s);
  const on = isActive(s) && !isUnavailable(s);
  const domain = domainOf(id);
  const state = note || formatState(s);
  const cls = ['dev', `dev-${domain}`, on ? 'on' : '', isUnavailable(s) ? 'off-line' : '', pending ? 'pending' : ''].filter(Boolean).join(' ');
  const main = act
    ? `data-act="${act.kind}" aria-pressed="${act.kind === 'toggle' ? on : 'false'}"`
    : 'data-open';
  return `<div class="${cls}" data-entity="${esc(id)}">
    <button type="button" class="dev-main" ${main} aria-label="${esc(`${nameOf(s)}, ${state}`)}">
      <span class="dev-icon">${icon(iconFor(s))}</span>
      <span class="dev-text">
        <span class="dev-name">${esc(shortName(s, room))}</span>
        <span class="dev-state">${esc(state)}</span>
      </span>
    </button>
    ${act ? `<button type="button" class="dev-more" data-open aria-label="${esc(nameOf(s))} settings">${icon('more')}</button>` : ''}
  </div>`;
}

const slider = (name, value, { min = 0, max = 100, step = 1, label, unit = '%' } = {}) => `
  <label class="slide">
    <span class="slide-head"><span>${esc(label)}</span><output>${esc(value)}${unit}</output></span>
    <input type="range" data-slide="${name}" min="${min}" max="${max}" step="${step}" value="${value}">
  </label>`;

const btn = (act, label, ic, { primary = false, on = false } = {}) =>
  `<button type="button" class="btn${primary ? ' primary' : ''}${on ? ' on' : ''}" data-act="${act}">${ic ? icon(ic) : ''}<span>${esc(label)}</span></button>`;

/** The controls in a device's sheet, by kind. */
export function deviceControls(s, { unit = '°C', note = '' } = {}) {
  const id = s.entity_id;
  const domain = domainOf(id);
  const a = s.attributes || {};
  if (isUnavailable(s)) return `<p class="muted">Home Assistant says this is ${esc(s.state)} right now.</p>`;

  const parts = [];
  switch (domain) {
    case 'light': {
      const f = lightFeatures(s);
      parts.push(`<div class="btn-row">${btn('toggle', s.state === 'on' ? 'Turn off' : 'Turn on', 'power', { primary: true, on: s.state === 'on' })}</div>`);
      if (f.brightness) parts.push(slider('brightness', brightnessPct(s), { min: 1, label: 'Brightness' }));
      if (f.colorTemp && a.min_color_temp_kelvin) {
        const k = a.color_temp_kelvin || Math.round((a.min_color_temp_kelvin + a.max_color_temp_kelvin) / 2);
        parts.push(slider('kelvin', k, { min: a.min_color_temp_kelvin, max: a.max_color_temp_kelvin, step: 50, label: 'Warm to cool', unit: ' K' }));
      }
      break;
    }
    case 'switch': case 'input_boolean': case 'fan': case 'siren':
      parts.push(`<div class="btn-row">${btn('toggle', s.state === 'on' ? 'Turn off' : 'Turn on', 'power', { primary: true, on: s.state === 'on' })}</div>`);
      if (note) parts.push(`<p class="sheet-note">${esc(note)}</p>`);
      break;
    case 'cover': {
      const f = coverFeatures(s);
      const door = isCoverDoor(s);
      parts.push(`<div class="btn-row">
        ${f.open ? btn('open_cover', door ? 'Open' : 'Open', 'arrowUp', { primary: door && s.state === 'closed' }) : ''}
        ${f.stop ? btn('stop_cover', 'Stop', 'stop') : ''}
        ${f.close ? btn('close_cover', 'Close', 'arrowDown', { primary: door && s.state !== 'closed' }) : ''}
      </div>`);
      if (f.position) parts.push(slider('position', Number(a.current_position) || 0, { label: 'Position (open %)' }));
      if (f.tilt) parts.push(slider('tilt', Number(a.current_tilt_position) || 0, { label: 'Tilt' }));
      break;
    }
    case 'lock':
      parts.push(`<div class="btn-row">${s.state === 'locked' ? btn('unlock', 'Unlock', 'lockOpen') : btn('lock', 'Lock', 'lock', { primary: true })}</div>`);
      break;
    case 'scene': case 'script': case 'button': case 'input_button':
      parts.push(`<div class="btn-row">${btn('run', 'Run', 'play', { primary: true })}</div>`);
      break;
    case 'climate': {
      const t = climateTargets(s);
      const modes = (a.hvac_modes || []).map((m) => `<button type="button" class="chip${m === s.state ? ' on' : ''}" data-act="hvac" data-mode="${esc(m)}">${esc(HVAC_LABELS[m] || m)}</button>`).join('');
      parts.push(`<div class="climate">
        <span class="climate-now">${fmtTemp(a.current_temperature)}<small>${esc(hvacActionLabel(a.hvac_action) || 'Now')}</small></span>
        ${t.single != null ? `<span class="climate-set">
          <button type="button" class="icon-btn" data-act="temp" data-dir="-1" aria-label="Cooler">${icon('minus')}</button>
          <b>${fmtTemp(t.single)}</b>
          <button type="button" class="icon-btn" data-act="temp" data-dir="1" aria-label="Warmer">${icon('plus')}</button>
        </span>` : ''}
      </div>${modes ? `<div class="chips">${modes}</div>` : ''}`);
      break;
    }
    case 'media_player': {
      const playing = s.state === 'playing';
      const title = [a.media_title, a.media_artist || a.app_name].filter(Boolean).join(' · ');
      if (title) parts.push(`<p class="sheet-note">${esc(title)}</p>`);
      parts.push(`<div class="btn-row">
        ${btn('media_previous_track', '', 'chevronLeft')}
        ${btn('media_play_pause', playing ? 'Pause' : 'Play', 'play', { primary: true })}
        ${btn('media_next_track', '', 'chevronRight')}
        ${s.state !== 'off' ? btn('media_off', 'Off', 'power') : btn('media_on', 'On', 'power')}
      </div>`);
      if (a.volume_level != null) parts.push(slider('volume', Math.round(a.volume_level * 100), { label: 'Volume' }));
      break;
    }
    default:
      break;
  }
  return parts.join('');
}

/** The big reading at the top of a sensor's sheet. */
export function readingHtml(s) {
  return `<div class="reading">
    <span class="reading-value">${esc(formatState(s))}</span>
    <span class="muted">Changed ${esc(relativeTime(s.last_changed))}</span>
  </div>`;
}

// ---------- 24-hour history in a device's sheet ----------

/** A line for numeric sensors, a timeline of "on" spells for binary sensors. h = { points, loading, error }. */
export function historyHtml(s, h) {
  if (!h) return '';
  if (h.loading) return '<div class="hchart hchart-loading"><div class="spinner" aria-hidden="true"></div></div>';
  if (h.error) return `<p class="muted">History unavailable (${esc(h.error)}).</p>`;
  if (domainOf(s.entity_id) === 'binary_sensor') return timelineHtml(s, h.points);
  const pts = h.points.map((p) => ({ t: p.t, v: Number(p.s) })).filter((p) => Number.isFinite(p.v));
  if (pts.length < 2) return '';
  return lineChartHtml(pts, s.attributes?.unit_of_measurement || '');
}

function lineChartHtml(pts, unit) {
  const W = 300;
  const H = 100;
  const now = Date.now();
  const t0 = now - 24 * 3_600_000;
  const vals = pts.map((p) => p.v);
  let min = Math.min(...vals);
  let max = Math.max(...vals);
  if (max - min < 1e-9) { min -= 1; max += 1; }
  const pad = (max - min) * 0.1;
  const x = (t) => (((Math.max(t, t0) - t0) / (now - t0)) * W).toFixed(1);
  const y = (v) => (H - ((v - min + pad) / (max - min + 2 * pad)) * H).toFixed(1);
  // Hold the last value until now so the line reaches the right edge.
  const all = [...pts, { t: now, v: pts[pts.length - 1].v }];
  const line = all.map((p, i) => `${i ? 'L' : 'M'}${x(p.t)},${y(p.v)}`).join('');
  const area = `${line}L${W},${H}L0,${H}Z`;
  const fmt = (v) => `${Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10}${unit ? ` ${unit}` : ''}`;
  return `<figure class="hchart">
    <figcaption class="hchart-head"><span>Last 24 hours</span>
      <span class="muted">Low ${esc(fmt(Math.min(...vals)))} · High ${esc(fmt(Math.max(...vals)))}</span></figcaption>
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="History graph">
      <path class="hchart-area" d="${area}"/>
      <path class="hchart-line" d="${line}" vector-effect="non-scaling-stroke"/>
    </svg>
    <div class="hchart-axis muted"><span>24 h ago</span><span>12 h</span><span>Now</span></div>
  </figure>`;
}

function timelineHtml(s, points) {
  if (!points.length) return '';
  const now = Date.now();
  const t0 = now - 24 * 3_600_000;
  const segs = [];
  points.forEach((p, i) => {
    const start = Math.max(p.t, t0);
    const end = i + 1 < points.length ? points[i + 1].t : now;
    if (p.s === 'on' && end > start) {
      segs.push(`<span style="left:${(((start - t0) / (now - t0)) * 100).toFixed(2)}%;width:${Math.max(0.4, ((end - start) / (now - t0)) * 100).toFixed(2)}%"></span>`);
    }
  });
  const changes = points.filter((p) => p.t >= t0).length;
  return `<figure class="hchart">
    <figcaption class="hchart-head"><span>Last 24 hours</span>
      <span class="muted">${changes} ${changes === 1 ? 'change' : 'changes'}</span></figcaption>
    <div class="htimeline" role="img" aria-label="Times it was ${esc(formatState({ ...s, state: 'on' }))}">${segs.join('')}</div>
    <div class="hchart-axis muted"><span>24 h ago</span><span>12 h</span><span>Now</span></div>
  </figure>`;
}

// The dashboard: Today (the day at a glance, notifications, news), Energy (solar, battery, selling to
// the grid), Places (where everyone is) and Home (floor plan and rooms). Devices are the ones exposed
// to Home Assistant's voice assistant, so the list stays short; Settings can show everything instead.
// Settings also sets up the floor plan, wall mode, the live sky and installing as an app.

import { HAClient } from './ha.js';
import { resolveAuth, loadSettings, saveSettings, defaultUrl } from './auth.js';
import { icon } from './icons.js';
import {
  domainOf, nameOf, isUnavailable, formatState, relativeTime, compareDomains, isCoverDoor, iconFor, domainLabel,
} from './entities.js';
import { esc, deviceTile, deviceControls, readingHtml, historyHtml } from './controls.js';
import { planRooms, matchRooms, planHtml, lightGlowColor } from './plan.js';
import { planStore, loadFloorPlan, planSettingsHtml, wirePlanSettings } from './planset.js';
import { Sky, SKY_PREVIEWS, clockSun } from './sky.js';
import { todayTint } from './tint.js';
import { Wall, IDLE_CHOICES, DIM_CHOICES } from './wall.js';
import { setupInstall, installInfo, promptInstall, onInstallChange } from './install.js';
import { CameraPlayer, cameraStillUrl, streamLabel } from './camera.js';
import {
  peopleOf, zonesOf, placeLabel, distanceKm, formatDistance, avatarHtml, PeopleMap,
} from './people.js';
import {
  energyEntities, energyFlow, energyLearnSigns, energyPower, energyHistoryModel, energyToday, ENERGY_SLOT,
  ENERGY_ROLES, energyAuto, energyPowerSensors, energyBatterySensors,
} from './energy.js';
import {
  calendarsOf, calParse, calOnDay, calStartOfDay, calAddDays, calDayKey, calTimeLabel, CAL_COLORS,
  calGridStart, calMonthHtml, calDaySheetHtml,
} from './calendar.js';
import { weatherWord, greetingFor, dayPart, briefFacts, briefLocal, briefAgents, briefPrompt } from './brief.js';
import { noteFromCall, noteMerge, noteText, noteItems, Ding } from './notify.js';
import {
  roomGroups, roomTemperature, roomExtras, isStatusLight, switchNote, devicesIndex, glanceItems,
  MOTION_CLASSES, OPENING_CLASSES,
} from './home.js';
import { newsItems, newsMerge, newsSources, storyFromEvent, newsHtml } from './news.js';
import { Voice } from './voice.js';

const DASH_BUILD = 'source';
const $ = (sel, root = document) => root.querySelector(sel);

// ---------- state ----------

const PREFS_KEY = 'ha-dash2.prefs';
const DEFAULT_PREFS = {
  exposedOnly: true,     // only devices exposed to the voice assistant
  theme: 'auto',         // auto (phone setting) | sun (dark after sunset) | light | dark
  feedIn: '',            // cents per kWh paid for solar sold to the grid
  buyRate: '',           // cents per kWh paid for power bought
  hiddenPeople: null,    // entity_id -> true; null until first set (then wall tablets are hidden by default)
  calHidden: {},
  news: true,
  shopping: true,
  shopList: '',         // todo.* entity; empty = the first list named like shopping
  newsLimit: 6,
  notifySound: true,
  energyPicks: {},       // role -> entity_id picked by hand ('none' = not shown)
  energyTab: true,       // the Energy page (and the energy card on Today)
  energyGrid: 'auto',    // what a positive grid number means: 'auto' | 'buy' | 'sell'
  energyBattery: 'auto', // what a positive battery number means: 'auto' | 'charge' | 'discharge'
  brief: true,
  briefAgent: '',        // who writes the day summary: '' (automatic), an AI entity, or 'none'
  glance: true,          // "Right now" on Today: open doors, someone at a camera, appliances, lights left on
  calendar: true,
  calView: 'days',       // 'days' (today and tomorrow) or 'month'
  notifications: true,   // the notifications card on Today (the bell is always there)
  todayExtras: false,    // cameras, thermostats and scenes on Today too
  peopleMap: true,       // the Places page and the map on Today
  showHidden: false,     // hidden and diagnostic entities
  showUnavailable: false,
  tint: true,            // a quiet time-of-day and weather colour behind Today
  sky: false,            // live sky background
  skyAnimate: true,
  weatherEntity: '',     // weather for the sky and Today; empty = the first one
  wall: false,           // wall panel: clock screen, dimming, keep the screen on
  idleMinutes: 2,
  dim: 0.55,
  dimNight: true,
  keepAwake: true,
};

function readPrefs() {
  try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY)) }; } catch { return { ...DEFAULT_PREFS }; }
}
function writePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(store.prefs)); } catch { /* private mode */ }
}
function readLocal(key, fallback = null) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function writeLocal(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* full or blocked */ }
}

const store = {
  client: null,
  status: 'connecting',
  statusMessage: '',
  authMode: 'none',
  states: new Map(),
  areas: new Map(),        // area_id -> name
  entityInfo: new Map(),
  entityAreas: {},         // entity_id -> area_id chosen in the old dashboard's Settings
  config: {},
  user: null,              // { name, is_admin }
  exposed: readLocal('ha-dash2.exposed') ? new Set(readLocal('ha-dash2.exposed')) : null,
  exposedFrom: '',         // 'live' | 'shared' | 'cache'
  prefs: readPrefs(),
};

const ui = {
  view: 'today',
  params: {},
  sheet: null,             // { kind: 'device'|'room'|'person'|'notes'|'camera'|'day', id, back }
  calMonth: null,          // first day of the month shown in the month calendar
  homeQuery: '',           // "Find a device" on Home
  pending: new Map(),      // entity_id -> expected state after a tap
  seenOn: new Set(),
  openStory: '',
  dragging: false,
  refreshTimer: 0,
  lastRender: 0,
};

// ---------- helpers ----------

function areaOf(id) {
  return store.entityAreas[id] || store.entityInfo.get(id)?.areaId || null;
}

/** Shown on the dashboard: not hidden in HA, not unavailable, and exposed to Assist (unless all are shown). */
function listed(id) {
  const s = store.states.get(id);
  if (!s || (isUnavailable(s) && !store.prefs.showUnavailable)) return false;
  const info = store.entityInfo.get(id);
  if (info?.hidden && !store.prefs.showHidden) return false;
  if (store.prefs.exposedOnly && store.exposed) return store.exposed.has(id);
  return !info?.category || store.prefs.showHidden; // without the exposed list: leave out config and diagnostic entities
}

function shown(s) {
  const p = ui.pending.get(s.entity_id);
  return p ? { ...s, state: p } : s;
}

let devCache = { key: '', map: new Map() };
function homeCtx() {
  return {
    states: store.states,
    listed,
    seenOn: (id) => ui.seenOn.has(id),
    deviceOf: (id) => store.entityInfo.get(id)?.deviceId || null,
    areaOf,
    shown,
  };
}
function deviceMap() {
  const key = `${store.states.size}:${store.entityInfo.size}`;
  if (devCache.key !== key) devCache = { key, map: devicesIndex(homeCtx()) };
  return devCache.map;
}
function tileNote(s) {
  return domainOf(s.entity_id) === 'switch' ? switchNote(shown(s), homeCtx(), deviceMap()) : '';
}
function tile(s, room = '') {
  return deviceTile(shown(s), { room, note: tileNote(s), pending: ui.pending.has(s.entity_id) });
}

const base = () => store.client?.url || defaultUrl();
const fmtTime = (d) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const tempUnit = () => store.config.unit_system?.temperature || '°C';
const deg = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? '–' : `${Math.round(Number(v))}°`);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const money = (cents) => {
  const c = store.config.currency || 'AUD';
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: c, maximumFractionDigits: 2 }).format(cents / 100);
};

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 3500);
}

// ---------- routing and chrome ----------

const VIEWS_META = {
  today: { title: 'Today', icon: 'today' },
  energy: { title: 'Energy', icon: 'solar' },
  places: { title: 'Places', icon: 'mapMarker' },
  home: { title: 'Home', icon: 'home' },
  settings: { title: 'Settings', icon: 'settings' },
};
const urlParams = new URLSearchParams(location.search);
const kiosk = urlParams.has('kiosk');
const urlWall = kiosk || urlParams.has('wall');
if (kiosk) document.documentElement.classList.add('kiosk');

/** Pages turned off in Settings drop out of the menu. */
function viewOn(v) {
  if (v === 'energy') return store.prefs.energyTab;
  if (v === 'places') return store.prefs.peopleMap;
  return true;
}

function parseRoute() {
  const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const view = VIEWS_META[path] && viewOn(path) ? path : 'today';
  return { view, params: Object.fromEntries(new URLSearchParams(query)) };
}

function renderNav() {
  $('#nav').innerHTML = `<span class="brand" aria-hidden="true">${icon('home')}</span>${Object.entries(VIEWS_META).filter(([v]) => viewOn(v)).map(([v, m]) => `
    <a href="#/${v}" data-view="${v}" class="nav-${v}"${ui.view === v ? ' aria-current="page"' : ''}>${icon(m.icon)}<span>${m.title}</span></a>`).join('')}`;
}

function renderStatus() {
  const el = $('#status');
  el.dataset.status = store.status;
  const text = { connected: 'Live', connecting: 'Connecting…', disconnected: 'Offline', auth_invalid: 'Sign in' }[store.status] || '';
  $('.status-text', el).textContent = text;
  el.title = store.statusMessage || text;
}

function tickClock() {
  const now = new Date();
  $('#clock').textContent = fmtTime(now);
  const big = $('.hero-time');
  if (big) big.textContent = fmtTime(now).replace(/\s?[ap]\.?m\.?$/i, '');
  applyTheme();
  if (!store.states.has('sun.sun')) updateTint();
}

function applyTheme() {
  const t = store.prefs.theme;
  let theme = '';
  if (t === 'light' || t === 'dark') theme = t;
  else if (t === 'sun') theme = store.states.get('sun.sun')?.state === 'below_horizon' ? 'dark' : 'light';
  if ((document.documentElement.dataset.theme || '') !== theme) {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  }
}

// ---------- wall mode: clock screen, dimming, keeping the screen on ----------

let wallMode = null;

function wallPrefs() {
  const p = { ...store.prefs, wall: store.prefs.wall || urlWall };
  // Someone watching a camera is not touching the screen; give them longer before the clock.
  if (camPlayer && p.idleMinutes) p.idleMinutes = Math.max(p.idleMinutes, 10);
  return p;
}

function paintIdle() {
  const now = new Date();
  $('#idle-time').textContent = fmtTime(now);
  $('#idle-date').textContent = now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  const w = weatherEntity();
  $('#idle-weather').textContent = w ? `${deg(w.attributes?.temperature)} · ${weatherWord(w.state)}` : '';
  let lights = 0;
  for (const s of store.states.values()) if (domainOf(s.entity_id) === 'light' && s.state === 'on' && listed(s.entity_id) && !isStatusLight(s)) lights++;
  $('#idle-summary').textContent = store.states.size ? (lights ? plural(lights, 'light') + ' on' : 'All lights off') : '';
}

function renderFullscreenButton() {
  const b = $('#fullscreen');
  b.hidden = !(wallMode?.enabled && Wall.canFullscreen);
  const full = !!(document.fullscreenElement || document.webkitFullscreenElement);
  b.innerHTML = icon(full ? 'fullscreenExit' : 'fullscreen');
  b.setAttribute('aria-label', full ? 'Leave full screen' : 'Full screen');
}

function setupWall() {
  wallMode = new Wall({
    overlay: $('#idle'),
    dimmer: $('#dimmer'),
    prefs: wallPrefs,
    isNight: () => sky?.night ?? (store.states.get('sun.sun')?.state === 'below_horizon' || clockSun().elevation < -4),
    paint: paintIdle,
    onIdle: () => {
      closeSheet();
      if (ui.view !== 'today') location.hash = '#/today';
    },
  });
  wallMode.update();
  $('#fullscreen').addEventListener('click', () => Wall.toggleFullscreen());
  document.addEventListener('fullscreenchange', renderFullscreenButton);
  document.addEventListener('webkitfullscreenchange', renderFullscreenButton);
  renderFullscreenButton();
}

// ---------- live sky background ----------

let sky = null;
let skyPreview = ''; // a look picked in Settings to try; not saved

// The same inputs drive the quiet tint behind Today; it is skipped while the live sky is on.
function updateTint() {
  const root = document.documentElement;
  const on = store.prefs.tint && !store.prefs.sky;
  root.classList.toggle('tint-on', on);
  if (!on) return;
  const sun = store.states.get('sun.sun');
  const a = sun?.attributes || {};
  const fromClock = clockSun();
  const w = weatherEntity();
  const t = todayTint({
    elevation: Number.isFinite(a.elevation) ? a.elevation : fromClock.elevation,
    rising: typeof a.rising === 'boolean' ? a.rising : fromClock.rising,
    condition: w?.state || '',
  });
  root.style.setProperty('--tint-a', t.a);
  root.style.setProperty('--tint-b', t.b);
}

function updateSky({ instant = false } = {}) {
  updateTint();
  if (!sky) return;
  const sun = store.states.get('sun.sun');
  const a = sun?.attributes || {};
  const fromClock = clockSun();
  const w = weatherEntity();
  const wind = Number(w?.attributes?.wind_speed);
  const unit = w?.attributes?.wind_speed_unit;
  const windKmh = unit === 'mph' ? wind * 1.609 : unit === 'm/s' ? wind * 3.6 : wind;
  sky.setInputs({
    elevation: Number.isFinite(a.elevation) ? a.elevation : fromClock.elevation,
    rising: typeof a.rising === 'boolean' ? a.rising : fromClock.rising,
    condition: w ? w.state : (sun?.state === 'below_horizon' ? 'clear-night' : 'sunny'),
    wind: Number.isFinite(windKmh) ? windKmh : 0,
  }, { instant });
}

function applySky() {
  const on = store.prefs.sky;
  document.documentElement.classList.toggle('sky-on', on);
  updateTint();
  if (!on) {
    sky?.destroy();
    sky = null;
    delete document.documentElement.dataset.sky;
    return;
  }
  if (!sky) {
    sky = new Sky($('#sky'), {
      onTone: ({ tone }) => {
        document.documentElement.dataset.sky = tone;
        wallMode?.applyDim();
      },
    });
  }
  sky.animate = store.prefs.skyAnimate;
  sky.setPreview(skyPreview);
  updateSky();
  sky.start();
}

// ---------- rendering ----------

function render() {
  const r = parseRoute();
  if (r.view !== ui.view) closeSheet();
  ui.view = r.view;
  ui.params = r.params;
  document.documentElement.dataset.view = ui.view;
  $('#title').textContent = VIEWS_META[ui.view].title;
  renderNav();
  renderStatus();
  renderBell();
  const view = $('#view');
  const html = VIEWS[ui.view]();
  // Leave the page alone when nothing on it changed, so a tap is never lost to a redraw.
  if (html === ui.viewHtml && view.dataset.view === ui.view) return;
  ui.viewHtml = html;
  view.dataset.view = ui.view;
  const typing = document.activeElement?.matches('#view .shop-add input');
  view.innerHTML = html;
  if (typing) view.querySelector('.shop-add input')?.focus();
  after[ui.view]?.(view);
  ui.lastRender = Date.now();
  paintCameras(view);
}

/** Redraw soon, at most about once a second, and not while a slider is held or a form has focus. */
function queueRefresh() {
  if (ui.refreshTimer) return;
  const wait = Math.max(0, 900 - (Date.now() - ui.lastRender));
  ui.refreshTimer = setTimeout(() => {
    ui.refreshTimer = 0;
    if (ui.dragging) { queueRefresh(); return; }
    if (ui.view === 'settings' && document.activeElement?.matches('input, select, textarea')) return;
    // Don't wipe what someone is typing (e.g. a new shopping item); try again after.
    if (document.activeElement?.matches('#view input[type=text]') && document.activeElement.value) { setTimeout(queueRefresh, 1000); return; }
    render();
    renderSheet();
  }, wait);
}

function notReady() {
  if (store.status === 'auth_invalid' || store.authMode === 'none') {
    return emptyHtml('Connect to Home Assistant', 'Open this page from a Home Assistant dashboard, or add an access token in Settings.', '<a class="btn primary" href="#/settings">Open Settings</a>');
  }
  return emptyHtml('Connecting to Home Assistant…', store.statusMessage || '', '<div class="spinner"></div>');
}

function emptyHtml(title, body, extra = '') {
  return `<div class="empty"><h2>${esc(title)}</h2>${body ? `<p class="muted">${esc(body)}</p>` : ''}${extra}</div>`;
}

const ready = () => store.states.size > 0;

// ============================================================
// Today
// ============================================================

const day = {
  forecast: [],         // daily forecast list
  forecastAt: 0,
  events: [],
  eventsKey: '',
  eventsAt: 0,
  eventsLoading: false,
  eventsError: '',
  brief: readLocal('ha-dash2.brief'),
  briefBusy: false,
  briefTried: '',
};

function weatherEntity() {
  const chosen = store.prefs.weatherEntity && store.states.get(store.prefs.weatherEntity);
  if (chosen && !isUnavailable(chosen)) return chosen;
  const all = [...store.states.values()].filter((s) => domainOf(s.entity_id) === 'weather' && !isUnavailable(s));
  // A daily forecast entity rather than an hourly one.
  return all.find((s) => !/hourly/.test(s.entity_id)) || all[0] || null;
}

async function loadForecast() {
  const w = weatherEntity();
  if (!w || !store.client || Date.now() - day.forecastAt < 30 * 60_000) return;
  day.forecastAt = Date.now();
  try {
    const res = await store.client.send({
      type: 'call_service', domain: 'weather', service: 'get_forecasts', service_data: { type: 'daily' },
      target: { entity_id: w.entity_id }, return_response: true,
    });
    day.forecast = res?.response?.[w.entity_id]?.forecast || [];
  } catch {
    day.forecast = [];
  }
  queueRefresh();
}

function forecastFor(date) {
  const key = calDayKey(date);
  return day.forecast.find((f) => calDayKey(new Date(f.datetime)) === key) || null;
}

function shownCalendars() {
  return calendarsOf(store.states).filter((s) => !store.prefs.calHidden[s.entity_id]);
}
function calColors() {
  return Object.fromEntries(calendarsOf(store.states).map((s, i) => [s.entity_id, CAL_COLORS[i % CAL_COLORS.length]]));
}

function calMonthShown() {
  if (!ui.calMonth) { const n = new Date(); ui.calMonth = new Date(n.getFullYear(), n.getMonth(), 1); }
  return ui.calMonth;
}

async function loadEvents(force = false) {
  const ids = shownCalendars().map((s) => s.entity_id);
  const today = calStartOfDay(new Date());
  let start = today;
  let end = calAddDays(today, 3);
  if (store.prefs.calView === 'month') {
    // The whole month grid, and still today and tomorrow for the summary.
    const grid = calGridStart(calMonthShown());
    if (grid < start) start = grid;
    if (calAddDays(grid, 42) > end) end = calAddDays(grid, 42);
  }
  const key = `${ids.join()}|${+start}`;
  if (!store.client || day.eventsLoading || (!force && key === day.eventsKey && Date.now() - day.eventsAt < 10 * 60_000)) return;
  if (!ids.length) { day.events = []; day.eventsKey = key; return; }
  day.eventsLoading = true;
  try {
    const res = await store.client.send({
      type: 'call_service', domain: 'calendar', service: 'get_events',
      service_data: { start_date_time: start.toISOString(), end_date_time: end.toISOString() },
      target: { entity_id: ids }, return_response: true,
    });
    const r = res?.response || {};
    day.events = ids.flatMap((id) => (r[id]?.events || []).map((e) => calParse(e, id)));
    day.eventsError = '';
  } catch (err) {
    day.eventsError = err?.message || 'Could not load the calendar';
  }
  day.eventsKey = key;
  day.eventsAt = Date.now();
  day.eventsLoading = false;
  queueRefresh();
  updateBrief();
}

/** People to show: everyone except the ones hidden in Settings (wall tablets by default). */
function shownPeople() {
  const hidden = store.prefs.hiddenPeople;
  return peopleOf(store.states).filter((p) => {
    if (p.unavailable && !p.located) return false;
    if (hidden) return !hidden[p.id];
    return !/wall|display|kiosk|tablet|ipad|dashboard/i.test(p.name);
  });
}

function homeZone() {
  return zonesOf(store.states).find((z) => z.home) || null;
}

function personPlace(p) {
  const label = placeLabel(p);
  if (label !== 'Away' || !p.located) return label;
  const home = homeZone();
  return home ? `${formatDistance(distanceKm(home, p), store.config.unit_system?.length || 'km')} away` : 'Away';
}

// ----- the day summary -----

function energyLine() {
  const e = energyNow();
  if (!e.flow.found) return '';
  const parts = [];
  if (e.flow.soc != null) {
    const state = e.flow.charging > 0.05 ? 'charging' : e.flow.discharging > 0.05 ? 'powering the house' : 'resting';
    parts.push(e.flow.soc >= 99.5 ? 'The battery is full' : `The battery is at ${Math.round(e.flow.soc)}% and ${state}`);
  }
  const sold = e.today.sold;
  if (sold?.kwh > 0.05) parts.push(`you've sold ${sold.kwh.toFixed(1)} kWh to the grid today${e.rates.feedIn ? ` (about ${money(sold.kwh * e.rates.feedIn)})` : ''}`);
  if (!parts.length) return '';
  const s = parts.join(', and ');
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}.`;
}

function briefInputs() {
  const fc = forecastFor(new Date());
  return briefFacts({
    now: new Date(),
    place: store.config.location_name || '',
    weather: weatherEntity(),
    unit: tempUnit().replace(/^°.*/, '°'),
    forecast: fc,
    events: day.events,
    calNames: Object.fromEntries(calendarsOf(store.states).map((s) => [s.entity_id, nameOf(s)])),
    people: shownPeople().map((p) => ({ name: p.name, place: personPlace(p) })),
  });
}

/** Who writes the day summary: the one picked in Settings, else the first AI found. */
function briefAgent() {
  const pick = store.prefs.briefAgent;
  if (pick === 'none') return null;
  const agents = briefAgents(store.states);
  return agents.find((a) => a.id === pick) || agents[0] || null;
}

async function updateBrief() {
  if (!store.client || day.briefBusy || !store.prefs.brief) return;
  const agent = briefAgent();
  if (!agent) return;
  const facts = briefInputs();
  if (day.brief?.key === facts.key || day.briefTried === facts.key) return;
  day.briefTried = facts.key;
  day.briefBusy = true;
  try {
    const shared = (await store.client.send({ type: 'frontend/get_user_data', key: 'ha-dash2.brief' }).catch(() => null))?.value;
    let b = shared?.key === facts.key ? shared : null;
    if (!b) {
      let text;
      if (agent.kind === 'ai_task') {
        const res = await store.client.send({
          type: 'call_service', domain: 'ai_task', service: 'generate_data',
          service_data: { task_name: 'Day at a glance', instructions: briefPrompt(facts), entity_id: agent.id }, return_response: true,
        });
        text = res?.response?.data;
      } else {
        const res = await store.client.send({ type: 'conversation/process', text: briefPrompt(facts), agent_id: agent.id });
        text = res?.response?.speech?.plain?.speech;
      }
      if (typeof text !== 'string' || !text.trim()) throw new Error('no answer');
      b = { key: facts.key, text: text.trim().replace(/^["“]|["”]$/g, ''), by: agent.name, at: Date.now() };
      store.client.send({ type: 'frontend/set_user_data', key: 'ha-dash2.brief', value: b }).catch(() => {});
    }
    day.brief = b;
    writeLocal('ha-dash2.brief', b);
  } catch { /* the plain summary stays */ }
  day.briefBusy = false;
  queueRefresh();
}

function summaryText() {
  const facts = briefInputs();
  const ai = briefAgent() && day.brief && day.brief.key === facts.key && calDayKey(new Date(day.brief.at)) === calDayKey(new Date()) ? day.brief : null;
  return { text: [ai ? ai.text : briefLocal(facts), energyLine()].filter(Boolean).join(' '), by: ai?.by || '' };
}

// ----- Today's cards -----

function heroHtml() {
  const now = new Date();
  const w = weatherEntity();
  const a = w?.attributes || {};
  const later = ['evening', 'night'].includes(dayPart(now));
  const fc = forecastFor(later ? calAddDays(now, 1) : now);
  const rain = fc?.precipitation_probability;
  const name = (store.user?.name || '').split(/\s+/)[0];
  const warnings = [...store.states.values()].find((s) => domainOf(s.entity_id) === 'sensor' && /warnings?$/i.test(s.entity_id) && Number(s.state) > 0);
  const { text, by } = summaryText();
  const glance = !store.prefs.glance ? [] : glanceItems(homeCtx(), { areaName: (id) => store.areas.get(id) || '' })
    .slice(0, matchMedia('(min-width: 700px)').matches ? 4 : 5);
  return `<section class="card hero">
    <div class="hero-top">
      <div class="hero-when">
        <p class="hero-greet">${esc(greetingFor(now))}${name ? `, ${esc(name)}` : ''}</p>
        <p class="hero-time">${esc(fmtTime(now).replace(/\s?[ap]\.?m\.?$/i, ''))}</p>
        <p class="hero-date">${esc(now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }))}</p>
      </div>
      ${w ? `<button type="button" class="hero-weather" data-open-entity="${esc(w.entity_id)}" aria-label="Weather">
        <span class="wx-now">${icon('weather')}<b>${deg(a.temperature)}</b></span>
        <span class="wx-cond">${esc(weatherWord(w.state).replace(/^\w/, (c) => c.toUpperCase()))}</span>
        ${fc ? `<span class="wx-fc">${later ? 'Tomorrow ' : ''}${deg(fc.temperature)} / ${deg(fc.templow)}${rain ? ` · ${rain}% rain` : ''}</span>` : ''}
      </button>` : ''}
    </div>
    ${warnings ? `<button type="button" class="warn-banner" data-open-entity="${esc(warnings.entity_id)}">${icon('alert')}${esc(plural(Number(warnings.state), 'weather warning'))} for your area</button>` : ''}
    ${store.prefs.brief ? `<p class="hero-summary">${esc(text)}${by ? `<small> · written by ${esc(by)}</small>` : ''}</p>` : ''}
    ${glance.length ? `<ul class="glance" aria-label="Right now">${glance.map((g) => `
      <li class="glance-item tone-${g.tone}">
        <button type="button" ${g.open ? `data-open-entity="${esc(g.open)}"` : g.href ? `data-href="${esc(g.href === '#/solar' ? '#/energy' : g.href.replace('#/entities', '#/home'))}"` : 'disabled'}>
          ${icon(g.icon)}<span>${esc(g.text)}${g.sub ? `<small>${esc(g.sub)}</small>` : ''}</span>
        </button>
        ${g.act ? `<button type="button" class="glance-act" data-glance-act="${esc(g.key)}">${esc(g.act.label)}</button>` : ''}
      </li>`).join('')}</ul>` : ''}
  </section>`;
}

function agendaHtml() {
  const cals = shownCalendars();
  if (!cals.length || !store.prefs.calendar) return '';
  const month = store.prefs.calView === 'month';
  const now = new Date();
  const today = calStartOfDay(now);
  const colors = calColors();
  const dayBlock = (d, label) => {
    let evs = calOnDay(day.events, d);
    if (+d === +today) evs = evs.filter((ev) => ev.allDay || ev.end > now);
    return `<div class="agenda-day">
      <h3>${esc(label)}</h3>
      ${evs.length ? `<ul class="agenda">${evs.map((ev) => `<li style="--cal:${colors[ev.cal] || 'var(--accent)'}">
        <span class="ev-time">${esc(ev.allDay ? 'All day' : calTimeLabel(ev, d))}</span>
        <span class="ev-title">${esc(ev.title)}${ev.location ? `<small>${esc(ev.location)}</small>` : ''}</span>
      </li>`).join('')}</ul>` : `<p class="muted quiet">${+d === +today ? 'Nothing else on today' : 'Nothing planned'}</p>`}
    </div>`;
  };
  const body = !day.eventsKey ? (day.eventsError ? `<p class="muted">${esc(day.eventsError)}</p>` : '<div class="spinner"></div>')
    : month ? calMonthHtml(day.events, calMonthShown(), { now, colors })
      : `${dayBlock(today, 'Today')}${dayBlock(calAddDays(today, 1), 'Tomorrow')}`;
  return `<section class="card agenda-card${month ? ' month' : ''}">
    <h2 class="card-title">${icon('calendar')}Calendar
      <span class="seg" role="group" aria-label="Calendar view">
        <button type="button" data-cal-view="days" aria-pressed="${!month}">Days</button>
        <button type="button" data-cal-view="month" aria-pressed="${month}">Month</button>
      </span></h2>
    ${body}
  </section>`;
}

function energyMiniHtml() {
  if (!store.prefs.energyTab) return '';
  const e = energyNow();
  if (!e.flow.found) return '';
  const f = e.flow;
  const soc = f.soc;
  const state = f.charging > 0.05 ? `Charging ${energyPower(f.charging)}` : f.discharging > 0.05 ? `Using ${energyPower(f.discharging)}` : soc >= 99.5 ? 'Full' : 'Resting';
  const sold = e.today.sold?.kwh;
  return `<a class="card energy-mini" href="#/energy">
    <h2 class="card-title">${icon('solar')}Energy<span class="card-go">${icon('chevronRight')}</span></h2>
    <div class="em-row">
      ${soc != null ? `<div class="ring" style="--p:${Math.max(0, Math.min(100, soc))}"><b>${Math.round(soc)}%</b><small>${esc(state)}</small></div>` : ''}
      <dl class="em-stats">
        <div><dt>Solar</dt><dd>${energyPower(f.solar)}</dd></div>
        <div><dt>${f.selling > 0.05 ? 'Selling' : f.buying > 0.05 ? 'Buying' : 'Grid'}</dt><dd class="${f.selling > 0.05 ? 'pos' : f.buying > 0.05 ? 'neg' : ''}">${energyPower(f.selling > 0.05 ? f.selling : f.buying || 0)}</dd></div>
        ${sold != null ? `<div><dt>Sold</dt><dd class="pos">${sold.toFixed(1)}<small class="u"> kWh</small>${e.rates.feedIn ? `<small>${money(sold * e.rates.feedIn)}</small>` : ''}</dd></div>` : ''}
        ${e.today.pv ? `<div><dt>Made</dt><dd>${e.today.pv.kwh.toFixed(1)}<small class="u"> kWh</small></dd></div>` : ''}
      </dl>
    </div>
  </a>`;
}

function peopleMiniHtml() {
  const people = shownPeople();
  if (!people.length || !store.prefs.peopleMap) return '';
  return `<section class="card people-mini">
    <h2 class="card-title">${icon('people')}Everyone<a class="card-go" href="#/places" aria-label="Open the map">${icon('chevronRight')}</a></h2>
    <ul class="people-row">${people.map((p) => `<li><button type="button" class="person-chip${p.state === 'home' ? ' home' : ''}" data-person="${esc(p.id)}">
      ${avatarHtml(p, base())}<span><b>${esc(p.name.split(/\s+/)[0])}</b><small>${esc(personPlace(p))}</small></span>
    </button></li>`).join('')}</ul>
    <div class="pmap-slot mini"></div>
  </section>`;
}

function notesCardHtml({ limit = 5 } = {}) {
  if (!store.prefs.notifications) return '';
  const items = noteItems(notes);
  return `<section class="card notes-card" id="notes">
    <h2 class="card-title">${icon('bell')}Notifications${items.length ? `<span class="count">${items.length}</span>` : ''}</h2>
    ${items.length ? notesList(items.slice(0, limit)) : '<p class="muted quiet">Nothing new. Notifications from Home Assistant and your automations show up here.</p>'}
    ${items.length > limit ? `<button type="button" class="link-btn" data-open-notes>See all ${items.length}</button>` : ''}
  </section>`;
}

function notesList(items) {
  return `<ul class="notes">${items.map((n) => `<li class="note ${n.kind}">
    <span class="note-icon">${icon(n.kind === 'ha' ? 'alert' : 'bell')}</span>
    <div class="note-body">
      ${n.title ? `<b>${esc(n.title)}</b>` : ''}
      <p>${esc(n.message)}</p>
      <small class="muted">${esc([relativeTime(n.at), n.kind === 'sent' && n.to ? `to ${n.to}` : n.kind === 'ha' ? 'in Home Assistant' : ''].filter(Boolean).join(' · '))}</small>
    </div>
    ${n.kind === 'ha' ? `<button type="button" class="icon-btn" data-dismiss="${esc(n.id)}" aria-label="Dismiss">${icon('close')}</button>` : ''}
  </li>`).join('')}</ul>`;
}

function newsCardHtml() {
  if (!store.prefs.news) return '';
  const items = newsItems(store.states, news.log);
  const { lists, events } = newsSources(store.states);
  if (!items.length && !lists.length && !events.length) {
    return `<section class="card news-card">
      <h2 class="card-title">${icon('news')}News</h2>
      <p class="muted quiet">No news feed in Home Assistant yet. Settings → News shows how to add one.</p>
    </section>`;
  }
  const wide = matchMedia('(min-width: 700px)').matches;
  return `<section class="card news-card">
    <h2 class="card-title">${icon('news')}News</h2>
    ${items.length ? newsHtml(items, { limit: wide ? store.prefs.newsLimit : Math.min(5, store.prefs.newsLimit), open: ui.openStory })
      : '<p class="muted quiet">Waiting for the next story.</p>'}
  </section>`;
}

// ============================================================
// shopping list: any Home Assistant to-do list (Family Wall has no list integration, so it's HA's own)
// ============================================================

const shop = { id: '', items: null, sub: 0, client: null };
const SHOP_AUTOMATION = 'dashboard_shopping_nearby';

function shopListId() {
  const pick = store.prefs.shopList;
  if (pick && store.states.has(pick)) return pick;
  const lists = [...store.states.keys()].filter((id) => domainOf(id) === 'todo').sort();
  return lists.find((id) => /shop|grocer/i.test(`${id} ${nameOf(store.states.get(id))}`)) || lists[0] || '';
}

/** Follow the list's items; Home Assistant sends the whole list again on every change. */
function watchShopList() {
  const client = store.client;
  const id = store.prefs.shopping ? shopListId() : '';
  if (!client || (id === shop.id && client === shop.client)) return;
  if (shop.sub && shop.client === client) client.unsubscribe(shop.sub);
  Object.assign(shop, { id, items: null, sub: 0, client });
  if (!id) return;
  client.subscribe({ type: 'todo/item/subscribe', entity_id: id }, (ev) => {
    if (shop.id !== id || shop.client !== client) return;
    shop.items = Array.isArray(ev.items) ? ev.items : [];
    queueRefresh();
  }).then((sub) => { shop.sub = sub; }).catch(() => { shop.items = []; queueRefresh(); });
}

function shopAutomation() {
  return [...store.states.values()].find((s) => domainOf(s.entity_id) === 'automation' && s.attributes?.id === SHOP_AUTOMATION) || null;
}

function shopCardHtml() {
  watchShopList();
  if (!shop.id) return '';
  const all = shop.items || [];
  const open = all.filter((i) => i.status !== 'completed');
  const done = all.length - open.length;
  const auto = shopAutomation();
  return `<section class="card shop-card">
    <h2 class="card-title">${icon('cart')}${esc(nameOf(store.states.get(shop.id)))}${open.length ? `<span class="count">${open.length}</span>` : ''}</h2>
    ${shop.items === null ? '<p class="muted quiet">Loading…</p>'
      : open.length ? `<ul class="shop">${open.map((i) => `<li><button type="button" class="shop-item" data-shop-done="${esc(i.uid)}" aria-label="Tick off ${esc(i.summary)}"><span class="tick">${icon('check')}</span><span>${esc(i.summary)}</span></button></li>`).join('')}</ul>`
      : '<p class="muted quiet">Nothing to buy.</p>'}
    <form class="shop-add" data-shop-add><input type="text" name="item" placeholder="Add an item" autocomplete="off" enterkeyhint="done" aria-label="Add an item"><button class="icon-btn" aria-label="Add">${icon('plus')}</button></form>
    ${done || auto ? `<p class="shop-foot muted">${auto?.state === 'on' ? `<span>${icon('mapMarker')}Sent to your phone at the shops</span>` : ''}${done ? `<button type="button" class="link-btn" data-shop-clear>Clear ${done} ticked</button>` : ''}</p>` : ''}
  </section>`;
}

// ============================================================
// Energy
// ============================================================

const SIGN_KEY = 'ha-dash2.energy-sign';
const energy = { sign: readLocal(SIGN_KEY, {}), hist: null, histAt: 0, histKey: '', loading: false, error: '' };

/** Which way the grid and battery numbers point: picked in Settings, else learned from readings. */
function energySigns() {
  const pick = { buy: 1, sell: -1, charge: 1, discharge: -1 };
  return {
    grid: pick[store.prefs.energyGrid] || energy.sign.grid || 1,
    battery: pick[store.prefs.energyBattery] || energy.sign.battery || 1,
  };
}

function energyIds() {
  return energyEntities(store.states, store.prefs.energyPicks);
}

/** Extra Sigenergy-style sensors: stored energy, capacity, month and year totals. */
function energyExtra() {
  const kwh = [...store.states.values()].filter((s) => domainOf(s.entity_id) === 'sensor' && /^k?Wh$/.test(s.attributes?.unit_of_measurement || ''));
  const text = (s) => `${s.entity_id} ${nameOf(s)}`.toLowerCase().replace(/_/g, ' ');
  const find = (re, skip = /$^/) => kwh.filter((s) => re.test(text(s)) && !skip.test(text(s)))
    .sort((a, b) => a.entity_id.length - b.entity_id.length + (/inverter/.test(a.entity_id) ? 30 : 0) - (/inverter/.test(b.entity_id) ? 30 : 0))[0] || null;
  const val = (s) => {
    const v = s ? Number(s.state) : NaN;
    return Number.isFinite(v) ? (s.attributes.unit_of_measurement === 'Wh' ? v / 1000 : v) : null;
  };
  return {
    stored: val(find(/battery.*stored|stored energy/)),
    capacity: val(find(/battery.*(capacity)|rated.*battery/, /available/)),
    exportMonth: val(find(/export.*month|month.*export/)),
    importMonth: val(find(/import.*month|month.*import/)),
    exportYear: val(find(/export.*(year|annual)|(year|annual).*export/)),
    pvMonth: val(find(/(pv|solar).*(month)|month.*(pv|solar)/)),
  };
}

function energyNow() {
  const ids = energyIds();
  const flow = energyFlow(store.states, ids, energySigns());
  const m = energy.hist ? energyHistoryModel(energy.hist, ids, store.states, energySigns(), energy.histAt) : null;
  const list = energyToday(flow, m);
  const by = (label) => list.find((t) => t.label === label);
  const rate = (v) => (Number(v) > 0 ? Number(v) : 0);
  return {
    ids,
    flow,
    m,
    list,
    extra: energyExtra(),
    rates: { feedIn: rate(store.prefs.feedIn), buy: rate(store.prefs.buyRate) },
    today: {
      pv: by('Solar today'), sold: by('Sold today'), bought: by('Bought today'), used: by('Used today'),
      charged: by('Charged today'), discharged: by('Discharged today'), self: by('Self-powered'),
    },
  };
}

/** Learn which way the grid and battery readings point, from now and from the last day's history. */
function learnSigns(flowRaw, hist, ids) {
  const votes = { grid: 0, battery: 0 };
  const add = (r) => {
    const s = energyLearnSigns(r);
    if (s?.grid) votes.grid += s.grid;
    if (s?.battery) votes.battery += s.battery;
  };
  if (flowRaw) add(flowRaw);
  if (hist) {
    const m = energyHistoryModel(hist, ids, store.states, {}, Date.now());
    const n = m.solar?.length || 0;
    for (let k = 0; k < n; k++) {
      const r = { solar: m.solar?.[k] ?? null, grid: m.grid?.[k] ?? null, battery: m.battery?.[k] ?? null, home: m.home?.[k] ?? null };
      if (ids.home && hist.home) add(r);
    }
  }
  let changed = false;
  for (const k of ['grid', 'battery']) {
    if (votes[k] && Math.sign(votes[k]) !== energy.sign[k]) { energy.sign[k] = Math.sign(votes[k]); changed = true; }
  }
  if (changed) writeLocal(SIGN_KEY, energy.sign);
  return changed;
}

async function loadEnergyHistory(force = false) {
  const ids = energyIds();
  const key = ['solar', 'grid', 'battery', 'home', 'soc'].map((r) => ids[r] || '').join();
  if (!store.client || energy.loading || !ids.solar && !ids.soc) return;
  if (!force && key === energy.histKey && Date.now() - energy.histAt < 5 * 60_000) return;
  energy.loading = true;
  try {
    const hist = {};
    await Promise.all(['solar', 'grid', 'battery', 'home', 'soc'].map(async (role) => {
      if (ids[role]) hist[role] = await store.client.history(ids[role], 24);
    }));
    energy.hist = hist;
    energy.histAt = Date.now();
    energy.histKey = key;
    energy.error = '';
    learnSigns(null, hist, ids);
  } catch (err) {
    energy.error = err?.message || 'History unavailable';
  }
  energy.loading = false;
  queueRefresh();
}

function batteryAlert() {
  return [...store.states.values()].find((s) => domainOf(s.entity_id) === 'automation'
    && (s.attributes?.id === 'dashboard_battery_full' || /batter.*(full|charged|100)/i.test(nameOf(s))));
}

function hoursText(h) {
  if (!Number.isFinite(h) || h <= 0) return '';
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 10) return `${Math.floor(h)} h ${String(Math.round((h % 1) * 60)).padStart(2, '0')} min`;
  if (h < 48) return `${Math.round(h)} hours`;
  return `${Math.round(h / 24)} days`;
}

function flowHtml(f) {
  // Each line runs from its node to the middle; `dir` says which way the dots travel.
  const nodes = [
    { key: 'solar', x: 50, y: 13, label: 'Solar', icon: 'solar', kw: f.solar, dir: f.solar > 0.02 ? 'in' : '' },
    { key: 'grid', x: 13, y: 50, label: f.selling > 0.02 ? 'Selling' : f.buying > 0.02 ? 'Buying' : 'Grid', icon: 'grid', kw: f.selling > 0.02 ? f.selling : f.buying, dir: f.selling > 0.02 ? 'out' : f.buying > 0.02 ? 'in' : '', show: f.hasGrid },
    { key: 'home', x: 87, y: 50, label: 'Home', icon: 'home', kw: f.home, dir: f.home > 0.02 ? 'out' : '' },
    { key: 'battery', x: 50, y: 87, label: f.charging > 0.02 ? 'Charging' : f.discharging > 0.02 ? 'Battery out' : 'Battery', icon: 'battery', kw: f.charging > 0.02 ? f.charging : f.discharging, dir: f.charging > 0.02 ? 'out' : f.discharging > 0.02 ? 'in' : '', show: f.hasBattery, soc: f.soc },
  ].filter((n) => n.show !== false);
  const speed = (kw) => Math.max(0.6, 3.2 - Math.min(3, (kw || 0) / 2)).toFixed(2);
  return `<div class="flow" role="img" aria-label="${esc(nodes.map((n) => `${n.label} ${energyPower(n.kw)}`).join(', '))}">
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      ${nodes.map((n) => `<line class="flow-line ${n.key}${n.dir ? ` go ${n.dir}` : ''}" x1="${n.x}" y1="${n.y}" x2="50" y2="50" style="--speed:${speed(n.kw)}s" vector-effect="non-scaling-stroke"/>`).join('')}
    </svg>
    <span class="flow-hub"></span>
    ${nodes.map((n) => `<div class="flow-node ${n.key}${n.dir ? ' active' : ''}" style="left:${n.x}%;top:${n.y}%">
      <span class="fn-icon">${icon(n.icon)}</span>
      <b>${energyPower(n.kw || 0)}</b>
      <small>${esc(n.label)}${n.soc != null ? ` · ${Math.round(n.soc)}%` : ''}</small>
    </div>`).join('')}
  </div>`;
}

const CH_W = 600;
const CH_H = 140;
function chartHtml({ title, m, series, min, max, unit = 'kW', note = '' }) {
  if (!m) return '';
  const n = (m.end - m.start) / ENERGY_SLOT;
  const x = (k) => ((k + 0.5) / n) * CH_W;
  const y = (v) => CH_H - ((Math.max(min, Math.min(max, v)) - min) / (max - min)) * CH_H;
  const zero = y(Math.max(min, 0));
  const paths = series.map((s) => {
    const runs = [];
    let run = [];
    (s.values || []).forEach((v, k) => { if (v == null) { if (run.length) runs.push(run); run = []; } else run.push([k, v]); });
    if (run.length) runs.push(run);
    return runs.map((r) => {
      const line = r.map(([k, v], i) => `${i ? 'L' : 'M'}${x(k).toFixed(1)} ${y(v).toFixed(1)}`).join('');
      const area = s.area ? `<path class="ch-area ${s.cls}" d="M${x(r[0][0]).toFixed(1)} ${zero.toFixed(1)}L${line.slice(1)}L${x(r.at(-1)[0]).toFixed(1)} ${zero.toFixed(1)}Z"/>` : '';
      return `${area}<path class="ch-line ${s.cls}" d="${line}" vector-effect="non-scaling-stroke"/>`;
    }).join('');
  }).join('');
  const ticks = [];
  const t = new Date(m.start);
  t.setMinutes(0, 0, 0);
  for (; +t < m.end; t.setHours(t.getHours() + 1)) {
    if (+t > m.start + 1_800_000 && t.getHours() % 6 === 0) {
      ticks.push(`<span style="left:${(((+t - m.start) / (m.end - m.start)) * 100).toFixed(1)}%">${esc(t.toLocaleTimeString(undefined, { hour: 'numeric' }))}</span>`);
    }
  }
  const lab = (v) => (unit === '%' ? `${v}%` : `${Math.abs(v)} ${unit}`);
  return `<figure class="chart">
    <figcaption><b>${esc(title)}</b>${series.filter((s) => s.label).map((s) => `<span class="key ${s.cls}">${esc(s.label)}</span>`).join('')}${note ? `<span class="muted">${esc(note)}</span>` : ''}</figcaption>
    <div class="ch-plot">
      <svg viewBox="0 0 ${CH_W} ${CH_H}" preserveAspectRatio="none" aria-hidden="true">
        <line class="ch-grid" x1="0" x2="${CH_W}" y1="${zero.toFixed(1)}" y2="${zero.toFixed(1)}" vector-effect="non-scaling-stroke"/>
        ${paths}
      </svg>
      <span class="ch-y" style="top:0">${lab(max)}</span>
      ${min < 0 ? `<span class="ch-y" style="top:calc(100% - 1.1em)">${lab(min)}</span>` : ''}
    </div>
    <div class="ch-x">${ticks.join('')}</div>
  </figure>`;
}

function nice(v) {
  for (const s of [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30]) if (v <= s) return s;
  return Math.ceil(v / 10) * 10;
}

function energyChartsView(m) {
  if (!m) return energy.error ? `<p class="muted">${esc(energy.error)}</p>` : '<div class="spinner"></div>';
  const peak = (...arrs) => Math.max(0.5, ...arrs.flat().filter((v) => v != null).map(Math.abs));
  const out = [];
  if (m.solar || m.home) {
    out.push(chartHtml({ title: 'Solar and home use', m, min: 0, max: nice(peak(m.solar || [], m.home || [])),
      series: [{ values: m.solar, cls: 'solar', area: true, label: 'Solar' }, { values: m.home, cls: 'home', label: 'Home' }] }));
  }
  if (m.grid) {
    const sold = m.grid.map((v) => (v == null ? null : Math.min(0, v)));
    const bought = m.grid.map((v) => (v == null ? null : Math.max(0, v)));
    const top = nice(peak(m.grid));
    out.push(chartHtml({ title: 'Grid', m, min: -top, max: top, note: 'Sold below the line',
      series: [{ values: sold, cls: 'sold', area: true, label: 'Sold' }, { values: bought, cls: 'bought', area: true, label: 'Bought' }] }));
  }
  if (m.soc) out.push(chartHtml({ title: 'Battery level', m, min: 0, max: 100, unit: '%', series: [{ values: m.soc, cls: 'soc', area: true }] }));
  return out.join('');
}

// ============================================================
// Places
// ============================================================

const peopleMap = new PeopleMap({ onPick: (id) => openSheet({ kind: 'person', id }) });

function phoneOf(p) {
  const s = store.states.get(p.id);
  const trackers = domainOf(p.id) === 'person' ? s?.attributes?.device_trackers || [] : [p.id];
  // The tracker it is using now, else the first one.
  const tracker = trackers.find((t) => t === p.source) || trackers[0];
  if (!tracker) return {};
  const dev = store.entityInfo.get(tracker)?.deviceId;
  const sensors = [...store.states.values()].filter((x) => domainOf(x.entity_id) === 'sensor'
    && (dev ? store.entityInfo.get(x.entity_id)?.deviceId === dev : x.entity_id.startsWith(`sensor.${tracker.split('.')[1]}_`)));
  const pick = (re, dc) => sensors.find((x) => (dc && x.attributes?.device_class === dc) || re.test(x.entity_id));
  const battery = pick(/battery_level/, 'battery');
  const charging = pick(/battery_state|charger_type/);
  const address = pick(/geocoded_location/);
  return {
    battery: battery && Number.isFinite(Number(battery.state)) ? Math.round(Number(battery.state)) : null,
    charging: charging ? /charging|full|ac|usb|wireless/i.test(charging.state) && !/not|none|discharging/i.test(charging.state) : false,
    address: address && !isUnavailable(address) ? address.state : '',
  };
}

function personCardHtml(p) {
  const ph = phoneOf(p);
  const since = p.changed ? relativeTime(p.changed) : '';
  return `<li><button type="button" class="person-card${p.state === 'home' ? ' home' : ''}" data-person="${esc(p.id)}">
    ${avatarHtml(p, base())}
    <span class="pc-text">
      <b>${esc(p.name)}</b>
      <span>${esc(personPlace(p))}${since ? ` · since ${esc(since.replace(/ ago$/, ''))}` : ''}</span>
      ${ph.address && p.state !== 'home' ? `<small class="muted">${esc(ph.address.split(',').slice(0, 2).join(','))}</small>` : ''}
    </span>
    ${ph.battery != null ? `<span class="pc-batt${ph.battery < 20 ? ' low' : ''}">${icon(ph.charging ? 'batteryCharging' : 'battery')}${ph.battery}%</span>` : ''}
  </button></li>`;
}

// ============================================================
// Home: floor plan and rooms
// ============================================================

async function dataGet(scope, key) {
  try { return (await store.client.send({ type: `frontend/get_${scope}_data`, key }))?.value ?? null; } catch { return undefined; }
}

// The floor plan lives in planset.js; Home redraws when it changes (Settings redraws its own panel).
planStore.onChange = () => { if (ui.view !== 'settings') queueRefresh(); };

function areaEntities(areaId) {
  return [...store.states.values()]
    .filter((s) => areaOf(s.entity_id) === areaId && listed(s.entity_id))
    .sort((a, b) => compareDomains(domainOf(a.entity_id), domainOf(b.entity_id)) || nameOf(a).localeCompare(nameOf(b)));
}

function roomInfo(name, areaId) {
  const info = { areaId: areaId || null, name, label: name };
  if (!areaId) return info;
  const ents = areaEntities(areaId).map(shown);
  info.count = ents.length;
  const lightsOn = ents.filter((s) => domainOf(s.entity_id) === 'light' && s.state === 'on' && !isStatusLight(s));
  info.lightsOn = lightsOn.length;
  if (lightsOn.length) info.glow = { color: lightGlowColor(lightsOn[0]), strength: 0.8 };
  const temp = roomTemperature(ents);
  if (temp) info.temp = `${Number(Number(temp.state).toFixed(1))}°`;
  const on = (classes) => ents.some((s) => domainOf(s.entity_id) === 'binary_sensor' && classes.has(s.attributes?.device_class) && s.state === 'on');
  info.motion = on(MOTION_CLASSES);
  info.open = on(OPENING_CLASSES) || ents.some((s) => domainOf(s.entity_id) === 'cover' && isCoverDoor(s) && s.state !== 'closed');
  info.cameras = ents.filter((s) => domainOf(s.entity_id) === 'camera').length;
  Object.assign(info, roomExtras(ents));
  return info;
}

function planMapping() {
  return matchRooms(planRooms(planStore.layout), store.areas, {}, {});
}

/** Areas with exposed devices, plan rooms first in plan order, then the rest by name. */
function roomList() {
  const out = [];
  const seen = new Set();
  if (planStore.layout) {
    const map = planMapping();
    for (const r of planRooms(planStore.layout)) {
      const a = map.get(r.id);
      if (!a || seen.has(a)) continue;
      seen.add(a);
      out.push({ areaId: a, name: r.name, info: roomInfo(r.name, a) });
    }
  }
  for (const [id, name] of store.areas) {
    if (seen.has(id)) continue;
    out.push({ areaId: id, name, info: roomInfo(name, id) });
  }
  return out.filter((r) => r.info.count);
}

function roomCardHtml(r) {
  const i = r.info;
  const quick = areaEntities(r.areaId).filter((s) => ['light', 'cover', 'switch', 'fan'].includes(domainOf(s.entity_id)) && !(domainOf(s.entity_id) === 'cover' && isCoverDoor(s))).slice(0, 4);
  const meta = [i.temp, i.lightsOn ? plural(i.lightsOn, 'light') + ' on' : '', i.open ? 'Open' : '', i.running ? 'Running' : '', i.motion ? 'Motion' : '']
    .filter(Boolean).join(' · ');
  return `<li class="room${i.lightsOn ? ' lit' : ''}">
    <button type="button" class="room-head" data-room="${esc(r.areaId)}">
      <b>${esc(r.name)}</b><span class="muted">${esc(meta || plural(i.count, 'device'))}</span>
    </button>
    ${quick.length ? `<div class="room-quick">${quick.map((s) => {
      const v = shown(s);
      return `<button type="button" class="qt${v.state === 'on' || v.state === 'open' ? ' on' : ''}" data-entity="${esc(s.entity_id)}" data-act="toggle" aria-label="${esc(`${nameOf(s)}: ${formatState(v)}`)}">${icon(iconFor(v))}</button>`;
    }).join('')}</div>` : ''}
  </li>`;
}

// ============================================================
// Cameras
// ============================================================

const camThumbs = new Map(); // entity_id -> url of the latest still
let camPlayer = null;

function refreshThumb(id) {
  const s = store.states.get(id);
  const url = s && cameraStillUrl(base(), s, 640);
  if (!url) return;
  const img = new Image();
  img.onload = () => {
    camThumbs.set(id, url);
    document.querySelectorAll(`img[data-cam="${CSS.escape(id)}"]`).forEach((el) => { el.src = url; el.classList.add('ready'); });
  };
  img.src = url;
}

function paintCameras(root) {
  root.querySelectorAll('img[data-cam]').forEach((el) => {
    const u = camThumbs.get(el.dataset.cam);
    if (u) { el.src = u; el.classList.add('ready'); } else refreshThumb(el.dataset.cam);
  });
}
setInterval(() => {
  if (document.hidden) return;
  const ids = new Set([...document.querySelectorAll('img[data-cam]')].map((el) => el.dataset.cam));
  ids.forEach(refreshThumb);
}, 12_000);

/** Thermostats and scenes, for Home (and for Today when Settings asks for them). */
function climateScenesHtml() {
  const ids = [...store.states.keys()].filter(listed);
  const climate = ids.filter((id) => domainOf(id) === 'climate').map((id) => store.states.get(id));
  const scenes = ids.filter((id) => ['scene', 'script'].includes(domainOf(id))).map((id) => store.states.get(id))
    .sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  return `${climate.length ? `<section class="card climate-card"><h2 class="card-title">${icon('climate')}Climate</h2>
      <div class="devs">${climate.map((s) => tile(s)).join('')}</div></section>` : ''}
    ${scenes.length ? `<section class="card scenes-card"><h2 class="card-title">${icon('scene')}Scenes</h2>
      <div class="devs">${scenes.map((s) => tile(s)).join('')}</div></section>` : ''}`;
}

function extrasHtml() {
  const cams = [...store.states.keys()].filter((id) => domainOf(id) === 'camera' && listed(id));
  return `${cams.length ? `<section class="card cams-card"><h2 class="card-title">${icon('camera')}Cameras</h2>${camerasHtml(cams)}</section>` : ''}${climateScenesHtml()}`;
}

/** Devices whose name or id matches what was typed in "Find a device". */
function searchResultsHtml() {
  const q = ui.homeQuery.trim().toLowerCase();
  if (!q) return '';
  const hits = [...store.states.values()].filter((s) => listed(s.entity_id) && (nameOf(s).toLowerCase().includes(q) || s.entity_id.includes(q)))
    .sort((a, b) => nameOf(a).localeCompare(nameOf(b))).slice(0, 40);
  return hits.length ? `<div class="devs">${hits.map((s) => tile(s, store.areas.get(areaOf(s.entity_id)) || '')).join('')}</div>`
    : `<p class="muted">Nothing matches “${esc(ui.homeQuery)}”.</p>`;
}

function camerasHtml(ids) {
  if (!ids.length) return '';
  return `<ul class="cams">${ids.map((id) => {
    const s = store.states.get(id);
    return `<li><button type="button" class="cam" data-open-entity="${esc(id)}">
      <img data-cam="${esc(id)}" alt="" decoding="async"><span class="cam-name">${esc(nameOf(s).replace(/\s*fluent$/i, '').replace(/\b([A-Z])([A-Z]+)\b/g, (m, a, b) => a + b.toLowerCase()))}</span>
    </button></li>`;
  }).join('')}</ul>`;
}

// ============================================================
// the views
// ============================================================

const VIEWS = {
  today() {
    if (!ready()) return notReady();
    loadForecast();
    loadEvents();
    loadEnergyHistory();
    return `<div class="v-today">
      <div class="col col-a">${heroHtml()}</div>
      <div class="col col-b">${energyMiniHtml()}${agendaHtml()}${shopCardHtml()}</div>
      <div class="col col-c">${notesCardHtml({ limit: 3 })}${peopleMiniHtml()}${newsCardHtml()}${store.prefs.todayExtras ? extrasHtml() : ''}</div>
    </div>`;
  },

  energy() {
    if (!ready()) return notReady();
    loadEnergyHistory();
    const e = energyNow();
    const f = e.flow;
    if (!f.found) {
      return emptyHtml('No solar or battery sensors found', 'Pick them in Settings → Energy if they have unusual names.', '<a class="btn" href="#/settings">Settings</a>');
    }
    const x = e.extra;
    const cap = x.capacity;
    const stored = x.stored ?? (cap && f.soc != null ? (cap * f.soc) / 100 : null);
    let eta = '';
    if (f.soc >= 99.5) eta = 'Fully charged';
    else if (f.charging > 0.05 && cap && f.soc != null) eta = `Full in about ${hoursText(((100 - f.soc) / 100) * cap / f.charging)}`;
    else if (f.discharging > 0.05 && stored) eta = `Lasts about ${hoursText(stored / f.discharging)} at this rate`;
    const t = e.today;
    const r = e.rates;
    const kwh = (o) => (o ? `${o.kwh.toFixed(1)}<small> kWh</small>` : '–');
    const est = (o) => (o?.est ? '<i class="est" title="Worked out from the last 24 hours">est.</i>' : '');
    const alert = batteryAlert();
    const lastFull = alert?.attributes?.last_triggered;
    const net = r.feedIn || r.buy ? (t.sold?.kwh || 0) * r.feedIn - (t.bought?.kwh || 0) * r.buy : null;
    return `<div class="v-energy">
      <section class="card battery-card">
        <h2 class="card-title">${icon('battery')}Battery</h2>
        <div class="bat">
          <div class="bat-gauge" style="--p:${Math.max(0, Math.min(100, f.soc ?? 0))}"><span class="bat-fill"></span><b>${f.soc != null ? Math.round(f.soc) : '–'}%</b></div>
          <div class="bat-text">
            <p class="bat-state">${f.charging > 0.05 ? `Charging at ${energyPower(f.charging)}` : f.discharging > 0.05 ? `Powering the house at ${energyPower(f.discharging)}` : f.soc >= 99.5 ? 'Full' : 'Resting'}</p>
            ${eta ? `<p>${esc(eta)}</p>` : ''}
            ${stored != null ? `<p class="muted">${stored.toFixed(1)} kWh stored${cap ? ` of ${cap.toFixed(1)} kWh` : ''}</p>` : ''}
          </div>
        </div>
        <div class="alert-row">
          ${alert ? `<span>${icon('bell')}<span><b>Tell me when it's full</b><small class="muted">${alert.state === 'on' ? `Sends a phone notification at 100%.${lastFull ? ` Last full ${esc(relativeTime(lastFull))}.` : ''}` : 'Switched off'}</small></span></span>
            <button type="button" class="switch${alert.state === 'on' ? ' on' : ''}" role="switch" aria-checked="${alert.state === 'on'}" data-entity="${esc(alert.entity_id)}" data-act="toggle" aria-label="Battery full notification"></button>`
            : `<span>${icon('bell')}<span><b>Battery full notification</b><small class="muted">Not set up in Home Assistant yet. See the README.</small></span></span>`}
        </div>
      </section>

      <section class="card flow-card">
        <h2 class="card-title">${icon('power')}Right now</h2>
        ${flowHtml(f)}
      </section>

      <section class="card today-energy">
        <h2 class="card-title">${icon('today')}Today</h2>
        <dl class="tiles">
          <div class="t-solar"><dt>${icon('solar')}Solar made</dt><dd>${kwh(t.pv)}${est(t.pv)}</dd></div>
          <div class="t-sold"><dt>${icon('cash')}Sold to grid</dt><dd>${kwh(t.sold)}${est(t.sold)}</dd>${t.sold && r.feedIn ? `<small>${money(t.sold.kwh * r.feedIn)} earned</small>` : ''}</div>
          <div class="t-home"><dt>${icon('home')}Home used</dt><dd>${kwh(t.used)}${est(t.used)}</dd>${t.self ? `<small>${Math.round(t.self.pct)}% self-powered</small>` : ''}</div>
          <div class="t-bought"><dt>${icon('grid')}Bought</dt><dd>${kwh(t.bought)}${est(t.bought)}</dd>${t.bought && r.buy ? `<small>${money(t.bought.kwh * r.buy)}</small>` : ''}</div>
          <div class="t-batt"><dt>${icon('batteryCharging')}Battery in / out</dt><dd>${t.charged ? t.charged.kwh.toFixed(1) : '–'} / ${t.discharged ? t.discharged.kwh.toFixed(1) : '–'}<small> kWh</small></dd></div>
          ${net != null ? `<div class="t-net"><dt>${icon('cash')}Net today</dt><dd class="${net >= 0 ? 'pos' : 'neg'}">${net >= 0 ? '+' : '−'}${money(Math.abs(net))}</dd><small>sold minus bought</small></div>` : ''}
        </dl>
        ${!r.feedIn ? '<p class="hint">Add your feed-in rate in <a href="#/settings?section=energy">Settings</a> to see what the solar you sell earns.</p>' : ''}
      </section>

      ${x.exportMonth != null || x.exportYear != null ? `<section class="card month-energy">
        <h2 class="card-title">${icon('cash')}Selling to the grid</h2>
        <dl class="tiles">
          ${x.exportMonth != null ? `<div><dt>This month</dt><dd>${x.exportMonth.toFixed(0)}<small> kWh</small></dd>${r.feedIn ? `<small>${money(x.exportMonth * r.feedIn)}</small>` : ''}</div>` : ''}
          ${x.importMonth != null ? `<div><dt>Bought this month</dt><dd>${x.importMonth.toFixed(0)}<small> kWh</small></dd>${r.buy ? `<small>${money(x.importMonth * r.buy)}</small>` : ''}</div>` : ''}
          ${x.exportYear != null ? `<div><dt>This year</dt><dd>${x.exportYear.toFixed(0)}<small> kWh</small></dd>${r.feedIn ? `<small>${money(x.exportYear * r.feedIn)}</small>` : ''}</div>` : ''}
        </dl>
      </section>` : ''}

      <section class="card charts-card">
        <h2 class="card-title">${icon('timer')}Last 24 hours</h2>
        ${energyChartsView(e.m)}
      </section>
    </div>`;
  },

  places() {
    if (!ready()) return notReady();
    const people = shownPeople();
    return `<div class="v-places">
      <section class="card map-card"><div class="pmap-slot big"></div></section>
      <section class="card people-card">
        <h2 class="card-title">${icon('people')}Household</h2>
        ${people.length ? `<ul class="people-list">${people.map(personCardHtml).join('')}</ul>` : '<p class="muted">No people in Home Assistant yet.</p>'}
      </section>
    </div>`;
  },

  home() {
    if (!ready()) return notReady();
    const rooms = roomList();
    const floors = planStore.layout?.floors || [];
    const floor = floors.find((f) => f.id === planStore.floor) || floors[0];
    let plan = '';
    if (floor) {
      const map = planMapping();
      const infos = new Map(floor.rooms.map((r) => [r.id, roomInfo(r.name, map.get(r.id))]));
      plan = `<section class="card plan-card">
        ${floors.length > 1 ? `<div class="chips">${floors.map((f) => `<button type="button" class="chip${f === floor ? ' on' : ''}" data-floor="${esc(f.id)}">${esc(f.name)}</button>`).join('')}</div>` : ''}
        ${planHtml(floor, (r) => infos.get(r.id), { rotated: matchMedia('(orientation: portrait) and (max-width: 699.98px)').matches, image: planStore.images.get(floor.id) || '' })}
      </section>`;
    }
    const cams = [...store.states.keys()].filter((id) => domainOf(id) === 'camera' && listed(id));
    const count = [...store.states.keys()].filter(listed).length;
    return `<div class="v-home">
      ${plan}
      <section class="card rooms-card">
        <h2 class="card-title">${icon('area')}Rooms</h2>
        <label class="search">${icon('search')}<input type="text" id="home-q" placeholder="Find a device" autocomplete="off" value="${esc(ui.homeQuery)}" aria-label="Find a device"></label>
        <div class="search-results" id="home-results">${searchResultsHtml()}</div>
        ${rooms.length ? `<ul class="rooms">${rooms.map(roomCardHtml).join('')}</ul>` : '<p class="muted">No devices in any room yet.</p>'}
        <p class="hint">${store.prefs.exposedOnly && store.exposed
          ? `Showing the ${count} devices exposed to your voice assistant. <a href="#/settings?section=devices">Change</a>`
          : `Showing all ${count} devices. <a href="#/settings?section=devices">Show only exposed devices</a>`}</p>
      </section>
      ${climateScenesHtml()}
      ${cams.length ? `<section class="card cams-card"><h2 class="card-title">${icon('camera')}Cameras</h2>${camerasHtml(cams)}</section>` : ''}
    </div>`;
  },

  settings() {
    const st = loadSettings();
    const p = store.prefs;
    const embedded = store.authMode === 'embedded';
    const ids = store.states.size ? energyIds() : {};
    const people = peopleOf(store.states);
    const hidden = (pp) => (p.hiddenPeople ? !!p.hiddenPeople[pp.id] : /wall|display|kiosk|tablet|ipad|dashboard/i.test(pp.name));
    const { lists, events } = newsSources(store.states);
    const cals = calendarsOf(store.states);
    const colors = calColors();
    const agents = briefAgents(store.states);
    const weathers = [...store.states.values()].filter((s) => domainOf(s.entity_id) === 'weather');
    const todos = [...store.states.values()].filter((s) => domainOf(s.entity_id) === 'todo');
    const install = installInfo();
    const unavailable = p.showUnavailable ? 0 : [...store.states.values()].filter(isUnavailable).length;
    const exposedNote = store.exposed
      ? `${store.exposed.size} entities are exposed${store.exposedFrom === 'live' ? '' : store.exposedFrom === 'shared' ? ' (list saved by an administrator)' : ' (saved copy)'}.`
      : 'The exposed list could not be read with this login yet; everything is shown until an administrator opens the dashboard once.';
    const check = (pref, title, sub = '', disabled = false) => `<label class="row"><span><b>${title}</b>${sub ? `<small class="muted">${sub}</small>` : ''}</span>
      <input type="checkbox" data-pref="${pref}"${p[pref] ? ' checked' : ''}${disabled ? ' disabled' : ''}></label>`;
    const choose = (pref, title, options, sub = '') => `<label class="row"><span><b>${title}</b>${sub ? `<small class="muted">${sub}</small>` : ''}</span>
      <select data-pref="${pref}">${options.map(([v, l]) => `<option value="${esc(v)}"${String(p[pref]) === String(v) ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
    const auto = energyAuto(store.states);
    const label = (id) => (id && store.states.has(id) ? nameOf(store.states.get(id)) : null);
    const power = energyPowerSensors(store.states).sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
    const levels = energyBatterySensors(store.states).sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
    const signs = energySigns();
    const wallOn = p.wall || urlWall;
    return `<div class="v-settings">
      <section class="card" id="devices">
        <h2 class="card-title">${icon('home')}Devices</h2>
        ${check('exposedOnly', 'Only devices exposed to the voice assistant', `${esc(exposedNote)} Change which ones in Home Assistant: Settings → Voice assistants → Expose.`)}
        ${check('showHidden', 'Show hidden and diagnostic entities')}
        ${check('showUnavailable', 'Show unavailable devices', unavailable ? `${unavailable} hidden now` : '')}
        ${store.user?.is_admin ? `<a class="btn" href="${esc(base())}/config/voice-assistants/expose" target="_top">${icon('openNew')}Open the Expose page</a>` : ''}
      </section>

      <section class="card" id="plan-settings"></section>

      <section class="card" id="entity-rooms"></section>

      <section class="card" id="today">
        <h2 class="card-title">${icon('today')}Today</h2>
        ${check('glance', 'Right now', 'Open doors, someone at a camera, appliances running, lights left on')}
        ${check('brief', 'Summary of the day')}
        ${p.brief ? choose('briefAgent', 'Written by', [['', agents[0] ? `Automatic (${agents[0].name})` : 'Automatic (no AI set up)'],
          ...agents.map((a) => [a.id, `${a.name}${a.kind === 'conversation' ? ' (assistant)' : ''}`]), ['none', 'No AI, a plain summary']],
          agents.length ? 'Written by the AI in your Home Assistant from the weather, the calendar and where everyone is, and shared with your other screens.'
            : 'Add an AI integration (Anthropic, OpenAI or Google Gemini) with an AI Task in Home Assistant to have it written for you.') : ''}
        ${check('calendar', 'Calendar', cals.length ? '' : 'No calendars in Home Assistant yet')}
        ${p.calendar ? cals.map((c) => `<label class="row cal-pick" style="--cal:${colors[c.entity_id]}"><span><b>${esc(nameOf(c))}</b></span><input type="checkbox" data-cal="${esc(c.entity_id)}"${p.calHidden[c.entity_id] ? '' : ' checked'}></label>`).join('') : ''}
        ${todos.length ? `${check('shopping', 'Shopping list', esc(shop.id ? nameOf(store.states.get(shop.id)) : ''))}
          ${todos.length > 1 && p.shopping ? choose('shopList', 'Which list', [['', 'Automatic'], ...todos.map((s) => [s.entity_id, nameOf(s)])]) : ''}` : ''}
        ${check('notifications', 'Notifications card', 'The bell in the top bar always has them')}
        ${check('notifySound', 'Ding for new notifications', 'On an iPad or iPhone it can play only after the screen has been touched once')}
        <button type="button" class="btn" data-test-ding>${icon('bell')}Play the ding</button>
        ${check('news', 'News', lists.length || events.length ? esc([...lists, ...events].map(nameOf).join(', ')) : 'No feed in Home Assistant yet')}
        ${check('todayExtras', 'Cameras, climate and scenes on Today too')}
        ${!lists.length ? `<details><summary>Get more headlines</summary><p class="muted">Your Feedreader feeds only hold their latest story, so this screen collects them as they arrive. For a full list, add a feed sensor to Home Assistant (the dashboard's README has the few lines to paste). News sites don't let a web page read them directly.</p></details>` : ''}
      </section>

      <section class="card" id="energy">
        <h2 class="card-title">${icon('solar')}Energy</h2>
        ${check('energyTab', 'Show the Energy page')}
        <label class="row"><span><b>Feed-in rate</b><small class="muted">Cents you are paid per kWh sold</small></span><input type="number" inputmode="decimal" min="0" step="0.1" data-pref="feedIn" value="${esc(p.feedIn)}" placeholder="e.g. 5"></label>
        <label class="row"><span><b>Price you pay</b><small class="muted">Cents per kWh bought</small></span><input type="number" inputmode="decimal" min="0" step="0.1" data-pref="buyRate" value="${esc(p.buyRate)}" placeholder="e.g. 30"></label>
        <details${Object.keys(p.energyPicks).length || p.energyGrid !== 'auto' || p.energyBattery !== 'auto' ? ' open' : ''}><summary>Sensors and directions</summary>
          <p class="muted">Sensors are found by name (Sigenergy and similar). Pick them here if the Energy page shows the wrong ones.</p>
          ${ENERGY_ROLES.map(({ key, label: roleLabel }) => {
            const list = key === 'soc' ? levels : power;
            const cur = p.energyPicks[key] || '';
            return `<label class="row"><span><b>${esc(roleLabel)}</b><small class="muted">${esc(ids[key] || 'none')}</small></span>
              <select data-energy-role="${key}">
                <option value="">${esc(label(auto[key]) ? `Automatic (${label(auto[key])})` : 'Automatic (none found)')}</option>
                <option value="none"${cur === 'none' ? ' selected' : ''}>Not shown</option>
                ${list.map((x) => `<option value="${esc(x.entity_id)}"${cur === x.entity_id ? ' selected' : ''}>${esc(nameOf(x))}</option>`).join('')}
              </select></label>`;
          }).join('')}
          ${choose('energyGrid', 'A positive grid number means', [['auto', `Automatic (${signs.grid === 1 ? 'buying' : 'selling'})`], ['buy', 'Buying from the grid'], ['sell', 'Selling to the grid']])}
          ${choose('energyBattery', 'A positive battery number means', [['auto', `Automatic (${signs.battery === 1 ? 'charging' : 'discharging'})`], ['charge', 'Charging'], ['discharge', 'Discharging']],
            'Automatic works this out from readings that add up. Change it if the arrows point the wrong way.')}
        </details>
      </section>

      <section class="card" id="people">
        <h2 class="card-title">${icon('people')}People and the map</h2>
        ${check('peopleMap', 'Show the Places page and the map on Today')}
        ${p.peopleMap ? (people.length ? people.map((pp) => `<label class="row"><span><b>${esc(pp.name)}</b><small class="muted">${esc(pp.id)}</small></span>
          <input type="checkbox" data-person-show="${esc(pp.id)}"${hidden(pp) ? '' : ' checked'}></label>`).join('') : '<p class="muted">No people yet.</p>') : ''}
      </section>

      <section class="card" id="look">
        <h2 class="card-title">${icon('sun')}Look</h2>
        ${choose('theme', 'Theme', [['auto', 'Same as this device'], ['sun', 'Dark after sunset'], ['light', 'Light'], ['dark', 'Dark']])}
        ${check('tint', 'Time and weather tint on Today', 'A soft wash of colour that follows the sun and the weather')}
        ${check('sky', 'Live sky background', 'Follows the sun and the weather: sunrise, clouds, rain, storms, stars')}
        ${p.sky ? `${check('skyAnimate', 'Animate rain, snow and clouds', 'Turn off on an older tablet to save power')}
          <div class="row"><span><b>Preview a sky</b><small class="muted">Only for looking; it goes back to live when you reload.</small></span></div>
          <div class="chips wrap">
            <button type="button" class="chip${skyPreview ? '' : ' on'}" data-sky-preview="">Live</button>
            ${Object.entries(SKY_PREVIEWS).map(([k, v]) => `<button type="button" class="chip${skyPreview === k ? ' on' : ''}" data-sky-preview="${k}">${esc(v.label)}</button>`).join('')}
          </div>` : ''}
        ${weathers.length > 1 ? choose('weatherEntity', 'Weather from', [['', `Automatic (${nameOf(weatherEntity() || weathers[0])})`], ...weathers.map((w) => [w.entity_id, nameOf(w)])]) : ''}
      </section>

      <section class="card" id="wall">
        <h2 class="card-title">${icon('fullscreen')}Wall mode</h2>
        <label class="row"><span><b>Use this screen as a wall panel</b><small class="muted">${urlWall ? 'On because of the address.' : 'Saved on this screen only. Adding <code>?wall</code> to the address does the same.'}</small></span>
          <input type="checkbox" data-pref="wall"${wallOn ? ' checked' : ''}${urlWall ? ' disabled' : ''}></label>
        ${wallOn ? `${choose('idleMinutes', 'Clock screen after', IDLE_CHOICES)}
          ${choose('dim', 'Dim the clock screen', DIM_CHOICES)}
          ${check('dimNight', 'Dim more after sunset')}
          ${check('keepAwake', 'Keep the screen on', wallMode && p.keepAwake ? esc(wallMode.wakeLock ? 'The screen is being kept on.' : wallMode.wakeLockError || 'Waiting for the browser to allow it.') : '')}
          <div class="btn-row">
            <button type="button" class="btn" data-wall="idle">Show the clock screen now</button>
            ${Wall.canFullscreen ? `<button type="button" class="btn" data-wall="full">${icon('fullscreen')}Full screen</button>` : ''}
          </div>` : ''}
      </section>

      <section class="card" id="install">
        <h2 class="card-title">${icon('download')}Install as an app</h2>
        <p class="muted">${esc(install.text)}</p>
        ${install.canInstall ? '<button type="button" class="btn primary" data-install>Install app</button>' : ''}
      </section>

      <section class="card" id="connection">
        <h2 class="card-title">${icon('settings')}Connection</h2>
        <p class="muted">${embedded ? 'Signed in through Home Assistant. No token is needed here.' : store.authMode === 'token' ? 'Using an access token.' : 'Not connected.'}
          ${store.user ? ` Logged in as ${esc(store.user.name)}${store.user.is_admin ? ' (administrator)' : ''}.` : ''}</p>
        <form class="conn" data-conn>
          <label>Home Assistant address<input name="url" type="url" value="${esc(st.url || defaultUrl())}" placeholder="http://homeassistant.local:8123"></label>
          <label>Long-lived access token<input name="token" type="password" value="${esc(st.token || '')}" autocomplete="off" placeholder="Only needed outside the Home Assistant app"></label>
          <small class="muted">Create one in Home Assistant under your profile, Security tab. It is stored only on this screen.</small>
          <label class="row"><span>Use the token even inside Home Assistant</span><input type="checkbox" name="forceToken"${st.forceToken ? ' checked' : ''}></label>
          <div class="btn-row">
            <button class="btn primary" type="submit">Save and reconnect</button>
            ${st.token ? '<button class="btn" type="button" data-forget-token>Forget token</button>' : ''}
          </div>
        </form>
        <dl class="facts">
          <dt>Status</dt><dd>${esc(store.status)}${store.statusMessage ? ` (${esc(store.statusMessage)})` : ''}</dd>
          <dt>Home Assistant</dt><dd>${esc(store.client?.haVersion || '—')}</dd>
          <dt>Entities</dt><dd>${store.states.size}</dd>
          <dt>Rooms</dt><dd>${store.areas.size}</dd>
          <dt>Dashboard version</dt><dd>${esc(DASH_BUILD)}</dd>
        </dl>
      </section>
    </div>`;
  },
};

/** After a view's HTML is in: maps and anything else that keeps its own element. */
const after = {
  today(view) {
    const slot = $('.pmap-slot', view);
    if (slot) { peopleMap.attach(slot); syncMap(); }
  },
  places(view) {
    peopleMap.attach($('.pmap-slot', view));
    syncMap();
  },
  settings(view) {
    const plan = $('#plan-settings', view);
    if (plan) { plan.innerHTML = planSettingsHtml(); wirePlanSettings(); }
    renderEntityRooms();
    const sec = ui.params.section && document.getElementById(ui.params.section);
    if (sec && !ui.scrolledTo) { ui.scrolledTo = true; sec.scrollIntoView({ block: 'start' }); }
  },
};

// ---------- Settings: devices without a room ----------

// Whole-home things that do not belong in a room, so they are not offered for one.
const ROOMLESS_DOMAINS = new Set([
  'person', 'device_tracker', 'zone', 'sun', 'weather', 'update', 'automation', 'calendar', 'todo',
  'tts', 'stt', 'conversation', 'wake_word', 'event', 'persistent_notification', 'input_text', 'image',
]);
const roomsUi = { open: new Set(), filter: '' };
const ENTITY_AREAS_KEY = 'ha-dash.entity-areas'; // shared with the first dashboard

/** Rooms to offer: floor plan rooms by their names, then any other Home Assistant areas. */
function roomChoices() {
  const mapping = planMapping();
  const seen = new Set();
  const plan = [];
  for (const r of planRooms(planStore.layout)) {
    const areaId = mapping.get(r.id);
    if (!areaId || seen.has(areaId)) continue;
    seen.add(areaId);
    plan.push([areaId, r.name]);
  }
  plan.sort((a, b) => a[1].localeCompare(b[1]));
  const rest = [...store.areas].filter(([id]) => !seen.has(id)).sort((a, b) => a[1].localeCompare(b[1]));
  return { plan, rest };
}

function entityRoomsHtml() {
  const head = `<h2 class="card-title">${icon('area')}Devices without a room</h2>`;
  if (!store.states.size) return `${head}<p class="muted">Connect to Home Assistant to see devices that are not in a room.</p>`;
  if (!store.areas.size) return `${head}<p class="muted">Home Assistant did not share its areas with this login. Areas need an administrator account.</p>`;
  const picked = store.entityAreas;
  const haArea = (id) => store.entityInfo.get(id)?.areaId || null;
  const candidates = [...store.states.values()].filter((s) => listed(s.entity_id) && !ROOMLESS_DOMAINS.has(domainOf(s.entity_id)) && !haArea(s.entity_id));
  const isPlaced = (s) => picked[s.entity_id] && store.areas.has(picked[s.entity_id]);
  const loose = candidates.filter((s) => !isPlaced(s));
  const placed = candidates.filter(isPlaced).sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  const q = roomsUi.filter.trim().toLowerCase();
  const match = (s) => !q || nameOf(s).toLowerCase().includes(q) || s.entity_id.includes(q);
  const { plan, rest } = roomChoices();
  const options = (cur) => `<option value=""${cur ? '' : ' selected'}>No room</option>
    ${plan.length ? `<optgroup label="Floor plan">${plan.map(([id, name]) => `<option value="${esc(id)}"${cur === id ? ' selected' : ''}>${esc(name)}</option>`).join('')}</optgroup>` : ''}
    ${rest.length ? `<optgroup label="${plan.length ? 'Other areas' : 'Areas'}">${rest.map(([id, name]) => `<option value="${esc(id)}"${cur === id ? ' selected' : ''}>${esc(name)}</option>`).join('')}</optgroup>` : ''}`;
  const row = (s) => `<label class="row"><span><b>${esc(nameOf(s))}</b><small class="muted">${esc(formatState(s))}</small></span>
    <select data-entity-room="${esc(s.entity_id)}" aria-label="Room for ${esc(nameOf(s))}">${options(picked[s.entity_id] || '')}</select></label>`;
  const groups = new Map();
  for (const s of loose.filter(match)) {
    const d = domainOf(s.entity_id);
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d).push(s);
  }
  const shownPlaced = placed.filter(match);
  return `${head}
    <p class="muted">${loose.length ? `${plural(loose.length, 'device')} ${loose.length === 1 ? 'is' : 'are'} not in any room. Pick a room and ${loose.length === 1 ? 'it shows' : 'they show'} up there on Home.`
      : 'Every device is in a room.'} This only changes the dashboard, not Home Assistant, and is saved to your Home Assistant profile.</p>
    ${loose.length + placed.length > 8 ? `<label class="search">${icon('search')}<input id="eroom-q" type="text" placeholder="Search devices" autocomplete="off" value="${esc(roomsUi.filter)}" aria-label="Search devices without a room"></label>` : ''}
    ${[...groups.keys()].sort(compareDomains).map((d) => {
      const list = groups.get(d).sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
      return `<details class="eroom-group" data-eroom-group="${esc(d)}"${q || roomsUi.open.has(d) ? ' open' : ''}>
        <summary>${esc(domainLabel(d))} <span class="muted">${list.length}</span></summary>${list.map(row).join('')}</details>`;
    }).join('')}
    ${shownPlaced.length ? `<details class="eroom-group" data-eroom-group="_placed"${q || roomsUi.open.has('_placed') ? ' open' : ''}>
      <summary>Put in a room here <span class="muted">${shownPlaced.length}</span></summary>${shownPlaced.map(row).join('')}</details>` : ''}
    ${q && !groups.size && !shownPlaced.length ? `<p class="muted">Nothing matches “${esc(roomsUi.filter)}”.</p>` : ''}`;
}

function renderEntityRooms() {
  const panel = $('#entity-rooms');
  if (!panel) return;
  const focused = document.activeElement?.id === 'eroom-q';
  const caret = focused ? document.activeElement.selectionStart : null;
  panel.innerHTML = entityRoomsHtml();
  if (focused) {
    const q = $('#eroom-q');
    q?.focus({ preventScroll: true });
    q?.setSelectionRange(caret, caret);
  }
}

function saveEntityAreas(next) {
  store.entityAreas = next;
  store.client?.send({ type: 'frontend/set_user_data', key: ENTITY_AREAS_KEY, value: next }).catch(() => toast("Couldn't save to Home Assistant"));
}

function syncMap() {
  peopleMap.update({ people: shownPeople(), zones: zonesOf(store.states), base: base() });
}

// ============================================================
// sheets
// ============================================================

/** Fetch a sensor's last 24 hours for its sheet. */
function loadHistory(entityId) {
  const s = store.states.get(entityId);
  const domain = domainOf(entityId);
  const numeric = domain === 'sensor' && s?.state !== '' && Number.isFinite(Number(s?.state));
  if (!store.client || !(numeric || domain === 'binary_sensor')) { ui.history = null; return; }
  ui.history = { entityId, points: [], loading: true };
  store.client.history(entityId).then(
    (points) => { if (ui.history?.entityId === entityId) ui.history = { entityId, points }; },
    (err) => { if (ui.history?.entityId === entityId) ui.history = { entityId, points: [], error: err.message }; },
  ).then(() => { if (ui.sheet?.kind === 'device' && ui.sheet.id === entityId) renderSheet(); });
}

function openSheet(sheet) {
  stopCamera();
  ui.sheetHtml = '';
  ui.sheet = sheet;
  if (sheet.kind === 'device') loadHistory(sheet.id);
  renderSheet();
  const d = $('#sheet');
  if (!d.open) d.showModal();
  d.scrollTop = 0;
}

function closeSheet() {
  stopCamera();
  ui.sheetHtml = '';
  ui.sheet = null;
  const d = $('#sheet');
  if (d.open) d.close();
}

function sheetHead(title, sub, { ic = '', back = false } = {}) {
  return `<header class="sheet-head">
    ${back ? `<button type="button" class="icon-btn" data-back aria-label="Back">${icon('back')}</button>` : ''}
    ${ic ? `<span class="sheet-icon">${icon(ic)}</span>` : ''}
    <div><h2 id="sheet-title">${esc(title)}</h2>${sub ? `<p class="muted">${esc(sub)}</p>` : ''}</div>
    <button type="button" class="icon-btn" data-close aria-label="Close">${icon('close')}</button>
  </header>`;
}

function renderSheet() {
  const sh = ui.sheet;
  const d = $('#sheet');
  if (!sh || !d.open && !d.dataset.opening) {
    if (!sh) return;
  }
  if (ui.dragging) return;
  d.className = `sheet sheet-${sh.kind}`;
  if (sh.kind === 'device') {
    const s = store.states.get(sh.id);
    if (!s) { closeSheet(); return; }
    if (domainOf(sh.id) === 'camera') { renderCameraSheet(s, sh); return; }
    const v = shown(s);
    const area = store.areas.get(areaOf(sh.id)) || '';
    const html = `${sheetHead(nameOf(s), [area, formatState(v)].filter(Boolean).join(' · '), { ic: iconFor(v), back: !!sh.back })}
      <div class="sheet-body">
        ${['sensor', 'binary_sensor', 'weather', 'sun', 'person', 'device_tracker', 'event'].includes(domainOf(sh.id)) ? readingHtml(v) : ''}
        ${historyHtml(v, ui.history?.entityId === sh.id ? ui.history : null)}
        ${domainOf(sh.id) === 'weather' ? forecastListHtml() : ''}
        ${deviceControls(v, { unit: tempUnit(), note: tileNote(s) })}
        <p class="muted small">Last changed ${esc(relativeTime(s.last_changed))}</p>
      </div>`;
    setSheet(d, html);
  } else if (sh.kind === 'room') {
    const name = roomList().find((r) => r.areaId === sh.id)?.name || store.areas.get(sh.id) || 'Room';
    const ents = areaEntities(sh.id);
    const groups = roomGroups(ents.map(shown));
    const info = roomInfo(name, sh.id);
    setSheet(d, `${sheetHead(name, [info.temp, plural(ents.length, 'device')].filter(Boolean).join(' · '), { ic: 'area' })}
      <div class="sheet-body">${groups.map((g) => `<section class="group">
        <h3>${esc(g.title)}</h3>
        ${g.key === 'cameras' ? camerasHtml(g.items.map((s) => s.entity_id))
          : g.key === 'sensors' ? `<details${g.items.length <= 4 ? ' open' : ''}><summary>${plural(g.items.length, 'sensor')}</summary><div class="devs">${g.items.map((s) => tile(store.states.get(s.entity_id), name)).join('')}</div></details>`
            : `<div class="devs">${g.items.map((s) => tile(store.states.get(s.entity_id), name)).join('')}</div>`}
      </section>`).join('') || '<p class="muted">Nothing exposed in this room.</p>'}</div>`);
  } else if (sh.kind === 'person') {
    const p = peopleOf(store.states).find((x) => x.id === sh.id);
    if (!p) { closeSheet(); return; }
    const ph = phoneOf(p);
    setSheet(d, `${sheetHead(p.name, personPlace(p), { ic: 'person' })}
      <div class="sheet-body">
        <dl class="kv-big">
          <div><dt>Where</dt><dd>${esc(placeLabel(p))}${p.changed ? `<small>since ${esc(new Date(p.changed).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }))}</small>` : ''}</dd></div>
          ${ph.address ? `<div><dt>Address</dt><dd>${esc(ph.address)}</dd></div>` : ''}
          ${ph.battery != null ? `<div><dt>Phone battery</dt><dd>${ph.battery}%${ph.charging ? '<small>charging</small>' : ''}</dd></div>` : ''}
        </dl>
        ${p.located ? `<div class="btn-row"><button type="button" class="btn" data-focus-person="${esc(p.id)}">${icon('mapMarker')}Show on the map</button>
          <a class="btn" href="https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lon}" target="_blank" rel="noopener">${icon('directions')}Directions</a></div>` : ''}
      </div>`);
  } else if (sh.kind === 'day') {
    const dayDate = new Date(`${sh.id}T00:00:00`);
    setSheet(d, calDaySheetHtml(day.events, dayDate, {
      colors: calColors(),
      calNames: Object.fromEntries(calendarsOf(store.states).map((c) => [c.entity_id, nameOf(c)])),
    }));
  } else if (sh.kind === 'notes') {
    const items = noteItems(notes);
    setSheet(d, `${sheetHead('Notifications', plural(items.length, 'notification'), { ic: 'bell' })}
      <div class="sheet-body">${items.length ? notesList(items) : '<p class="muted">Nothing new.</p>'}</div>`);
    markNotesSeen();
  }
}

function setSheet(d, html) {
  if (ui.sheetHtml === html && d.childElementCount) return;
  ui.sheetHtml = html;
  d.innerHTML = html;
  paintCameras(d);
}

function forecastListHtml() {
  if (!day.forecast.length) return '';
  return `<ul class="forecast">${day.forecast.slice(0, 7).map((f) => {
    const dt = new Date(f.datetime);
    return `<li><span>${esc(dt.toLocaleDateString(undefined, { weekday: 'short' }))}</span>${icon('weather')}<span>${esc(weatherWord(f.condition))}</span><b>${deg(f.temperature)}</b><span class="muted">${deg(f.templow)}</span>${f.precipitation_probability ? `<small>${f.precipitation_probability}%</small>` : '<small></small>'}</li>`;
  }).join('')}</ul>`;
}

function renderCameraSheet(s, sh) {
  const d = $('#sheet');
  if (camPlayer?.entityId === s.entity_id && $('.cam-stage', d)) return; // keep the video playing
  ui.sheetHtml = '';
  d.innerHTML = `${sheetHead(nameOf(s).replace(/\s*fluent$/i, ''), store.areas.get(areaOf(s.entity_id)) || '', { ic: 'camera', back: !!sh.back })}
    <div class="cam-stage" data-phase="connecting">
      <img class="cam-poster" data-cam="${esc(s.entity_id)}" alt="">
      <div class="cam-status"><div class="spinner"></div><span class="cam-status-text">Connecting…</span>
        <button type="button" class="btn" data-cam="retry">Try again</button></div>
      <span class="cam-kind"></span>
    </div>`;
  paintCameras(d);
  camPlayer = new CameraPlayer({
    client: store.client, entityId: s.entity_id, getState: () => store.states.get(s.entity_id), stage: $('.cam-stage', d),
    onState: ({ phase, kind, message }) => {
      const st = $('#sheet .cam-stage');
      if (!st) return;
      st.dataset.phase = phase;
      $('.cam-status-text', st).textContent = phase === 'failed' ? `No live video. ${message || ''}` : `Connecting${kind ? ` (${streamLabel(kind)})` : ''}…`;
      $('.cam-kind', st).textContent = phase === 'playing' ? `Live · ${streamLabel(kind)}` : '';
    },
  });
  camPlayer.start();
}

function stopCamera() {
  camPlayer?.stop();
  camPlayer = null;
}
document.addEventListener('visibilitychange', () => {
  if (!camPlayer) return;
  if (document.hidden) camPlayer.stop(); else camPlayer.start();
});

// ============================================================
// notifications
// ============================================================

const NOTES_KEY = 'ha-dash.notify-log'; // shared with the old dashboard, so history carries over
const notes = { persistent: [], sent: readLocal(NOTES_KEY, []), canSeeSent: true };
const ding = new Ding();
const SEEN_KEY = 'ha-dash2.notes-seen';

function unseen() {
  const seen = Number(readLocal(SEEN_KEY, 0)) || 0;
  return noteItems(notes).filter((n) => Date.parse(n.at || 0) > seen).length;
}
function markNotesSeen() {
  writeLocal(SEEN_KEY, Date.now());
  renderBell();
}

function renderBell() {
  const b = $('#bell');
  if (!store.client) return;
  b.hidden = false;
  const n = unseen();
  b.innerHTML = `${icon('bell')}${n ? `<span class="badge">${n > 9 ? '9+' : n}</span>` : ''}`;
  b.setAttribute('aria-label', n ? `${plural(n, 'new notification')}` : 'Notifications');
}

function noteArrived() {
  const b = $('#bell');
  b.classList.remove('ring');
  void b.offsetWidth;
  b.classList.add('ring');
  if (store.prefs.notifySound) ding.play();
}

async function subscribeNotes(client) {
  const byId = new Map();
  client.subscribe({ type: 'persistent_notification/subscribe' }, (ev) => {
    if (ev.type === 'current') byId.clear();
    let arrived = false;
    for (const [id, n] of Object.entries(ev.notifications || {})) {
      if (ev.type === 'removed') byId.delete(id);
      else {
        if (ev.type === 'added' && !byId.has(id)) arrived = true;
        byId.set(id, { id, title: noteText(n.title), message: noteText(n.message), at: n.created_at });
      }
    }
    notes.persistent = [...byId.values()];
    queueRefresh();
    if (arrived) noteArrived();
  }).catch(() => {});

  const shared = await dataGet('user', NOTES_KEY);
  if (client !== store.client) return;
  notes.sent = noteMerge(notes.sent, Array.isArray(shared) ? shared : []);
  writeLocal(NOTES_KEY, notes.sent);
  try {
    await client.subscribeEvents('call_service', async (event) => {
      const note = noteFromCall(event);
      if (!note) return;
      const fresh = !notes.sent.some((n) => n.id === note.id);
      notes.sent = noteMerge(notes.sent, [note]);
      if (fresh) noteArrived();
      writeLocal(NOTES_KEY, notes.sent);
      queueRefresh();
      const latest = await dataGet('user', NOTES_KEY);
      notes.sent = noteMerge(notes.sent, Array.isArray(latest) ? latest : []);
      client.send({ type: 'frontend/set_user_data', key: NOTES_KEY, value: notes.sent }).catch(() => {});
    });
  } catch {
    notes.canSeeSent = false; // only administrators can watch actions
  }
  queueRefresh();
}

// ============================================================
// news log: Feedreader's event entities only hold the latest story
// ============================================================

const NEWS_KEY = 'ha-dash2.news';
const news = { log: readLocal(NEWS_KEY, []), saveTimer: 0 };

function newsSeen(s) {
  const st = storyFromEvent(s);
  if (!st || news.log.some((n) => n.id === st.id)) return;
  news.log = newsMerge([st, ...news.log]);
  writeLocal(NEWS_KEY, news.log);
  clearTimeout(news.saveTimer);
  news.saveTimer = setTimeout(async () => {
    const latest = await dataGet('user', NEWS_KEY);
    news.log = newsMerge([...news.log, ...(Array.isArray(latest) ? latest : [])]);
    store.client?.send({ type: 'frontend/set_user_data', key: NEWS_KEY, value: news.log }).catch(() => {});
  }, 1500);
}

async function loadNews() {
  const shared = await dataGet('user', NEWS_KEY);
  news.log = newsMerge([...news.log, ...(Array.isArray(shared) ? shared : [])]);
  for (const s of newsSources(store.states).events) newsSeen(s);
  queueRefresh();
}

// ============================================================
// exposed entities
// ============================================================

const EXPOSED_KEY = 'ha-dash2.exposed';

/** Which entities are exposed to Assist. Administrators read it live and share a copy for other logins. */
async function loadExposed() {
  const client = store.client;
  let ids = null;
  try {
    const res = await client.send({ type: 'homeassistant/expose_entity/list' });
    ids = Object.entries(res?.exposed_entities || {}).filter(([, v]) => v?.conversation).map(([k]) => k).sort();
    store.exposedFrom = 'live';
    const saved = await dataGet('system', EXPOSED_KEY);
    if (JSON.stringify(saved) !== JSON.stringify(ids)) client.send({ type: 'frontend/set_system_data', key: EXPOSED_KEY, value: ids }).catch(() => {});
  } catch {
    const saved = (await dataGet('system', EXPOSED_KEY)) || null;
    if (Array.isArray(saved)) { ids = saved; store.exposedFrom = 'shared'; }
  }
  if (client !== store.client) return;
  if (ids) {
    store.exposed = new Set(ids);
    writeLocal(EXPOSED_KEY, ids);
  } else if (store.exposed) store.exposedFrom = 'cache';
  queueRefresh();
}

// ============================================================
// actions
// ============================================================

async function call(domain, service, data = {}, entityId) {
  try {
    await store.client.callService(domain, service, data, entityId ? { entity_id: entityId } : undefined);
  } catch (err) {
    toast(`Couldn't do that: ${err.message}`);
    if (entityId) { ui.pending.delete(entityId); queueRefresh(); }
  }
}

const EXPECT = { turn_on: 'on', turn_off: 'off', open_cover: 'opening', close_cover: 'closing' };

function act(kind, id, el) {
  const s = store.states.get(id);
  if (!s) return;
  const domain = domainOf(id);
  if (kind === 'toggle') {
    if (domain === 'cover') {
      if (isCoverDoor(s)) { openSheet({ kind: 'device', id }); return; }
      const svc = s.state === 'opening' || s.state === 'closing' ? 'stop_cover' : s.state === 'closed' ? 'open_cover' : 'close_cover';
      call('cover', svc, {}, id);
      return;
    }
    const svc = s.state === 'on' ? 'turn_off' : 'turn_on';
    ui.pending.set(id, EXPECT[svc]);
    setTimeout(() => { if (ui.pending.get(id) === EXPECT[svc]) { ui.pending.delete(id); queueRefresh(); } }, 8000);
    queueRefresh();
    call(['light', 'switch', 'fan', 'input_boolean', 'automation', 'siren'].includes(domain) ? domain : 'homeassistant', svc, {}, id);
    return;
  }
  if (kind === 'run') {
    const svc = { scene: 'turn_on', script: 'turn_on', button: 'press', input_button: 'press' }[domain];
    call(domain, svc, {}, id).then(() => toast(`${nameOf(s)} ran`));
    return;
  }
  if (['open_cover', 'close_cover', 'stop_cover'].includes(kind)) call('cover', kind, {}, id);
  else if (kind === 'lock' || kind === 'unlock') call('lock', kind, {}, id);
  else if (kind === 'hvac') call('climate', 'set_hvac_mode', { hvac_mode: el.dataset.mode }, id);
  else if (kind === 'temp') {
    const cur = Number(s.attributes.temperature);
    const step = Number(s.attributes.target_temp_step) || (tempUnit() === '°F' ? 1 : 0.5);
    if (Number.isFinite(cur)) call('climate', 'set_temperature', { temperature: cur + step * Number(el.dataset.dir) }, id);
  } else if (kind.startsWith('media_')) {
    const svc = { media_on: 'turn_on', media_off: 'turn_off' }[kind] || kind;
    call('media_player', svc, {}, id);
  }
}

const SLIDERS = {
  brightness: (id, v) => call('light', 'turn_on', { brightness_pct: v }, id),
  kelvin: (id, v) => call('light', 'turn_on', { color_temp_kelvin: v }, id),
  position: (id, v) => call('cover', 'set_cover_position', { position: v }, id),
  tilt: (id, v) => call('cover', 'set_cover_tilt_position', { tilt_position: v }, id),
  volume: (id, v) => call('media_player', 'volume_set', { volume_level: v / 100 }, id),
};

function glanceAct(key) {
  const g = glanceItems(homeCtx(), { areaName: (id) => store.areas.get(id) || '' }).find((x) => x.key === key);
  if (g?.act) call(g.act.domain, g.act.service, {}, g.act.ids);
}

// ---------- events ----------

// Long-press (or right-click) a device for its sheet; a tap does its main action.
let press = null;
const cancelPress = () => { if (press) clearTimeout(press.timer); press = null; };
document.addEventListener('pointerdown', (e) => {
  const main = e.target.closest('.dev-main');
  const id = main?.closest('[data-entity]')?.dataset.entity;
  if (!id || e.button > 0) return;
  press = {
    x: e.clientX,
    y: e.clientY,
    timer: setTimeout(() => {
      press = null;
      ui.suppressClick = true;
      navigator.vibrate?.(15);
      openSheet({ kind: 'device', id, back: main.closest('#sheet') ? ui.sheet : null });
    }, 500),
  };
});
document.addEventListener('pointermove', (e) => { if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) cancelPress(); });
document.addEventListener('pointerup', cancelPress);
document.addEventListener('pointercancel', cancelPress);
window.addEventListener('scroll', cancelPress, { passive: true });
document.addEventListener('contextmenu', (e) => {
  const id = e.target.closest('.dev-main')?.closest('[data-entity]')?.dataset.entity;
  if (!id) return;
  e.preventDefault();
  cancelPress();
  openSheet({ kind: 'device', id, back: e.target.closest('#sheet') ? ui.sheet : null });
});

document.addEventListener('click', (e) => {
  const t = e.target;
  if (ui.suppressClick) { ui.suppressClick = false; return; }
  if (handleSettingsClick(t) || handleCalendarClick(t)) return;
  const sheetEl = t.closest('#sheet');
  if (t === $('#sheet')) { closeSheet(); return; } // the backdrop
  if (t.closest('[data-close]')) { closeSheet(); return; }
  if (t.closest('[data-back]')) {
    const back = ui.sheet?.back;
    stopCamera();
    ui.sheet = back || null;
    if (ui.sheet) renderSheet(); else closeSheet();
    return;
  }
  const story = t.closest('[data-story]');
  if (story) { ui.openStory = ui.openStory === story.dataset.story ? '' : story.dataset.story; render(); return; }
  if (t.closest('#bell')) { openSheet({ kind: 'notes' }); return; }
  if (t.closest('[data-open-notes]')) { openSheet({ kind: 'notes' }); return; }
  const tick = t.closest('[data-shop-done]');
  if (tick) {
    const uid = tick.dataset.shopDone;
    tick.closest('li')?.classList.add('done');
    call('todo', 'update_item', { item: uid, status: 'completed' }, shop.id);
    return;
  }
  if (t.closest('[data-shop-clear]')) {
    call('todo', 'remove_completed_items', {}, shop.id);
    return;
  }
  const dis = t.closest('[data-dismiss]');
  if (dis) {
    notes.persistent = notes.persistent.filter((n) => n.id !== dis.dataset.dismiss);
    call('persistent_notification', 'dismiss', { notification_id: dis.dataset.dismiss });
    render(); renderSheet();
    return;
  }
  const href = t.closest('[data-href]');
  if (href) { location.hash = href.dataset.href; return; }
  const ga = t.closest('[data-glance-act]');
  if (ga) { glanceAct(ga.dataset.glanceAct); return; }
  const oe = t.closest('[data-open-entity]');
  if (oe) { openSheet({ kind: 'device', id: oe.dataset.openEntity, back: sheetEl ? ui.sheet : null }); return; }
  const room = t.closest('[data-room]');
  if (room && !t.closest('#sheet')) {
    const id = room.dataset.room;
    // A room on the plan carries its plan id; find its area.
    const areaId = store.areas.has(id) ? id : planMapping().get(id);
    if (areaId) openSheet({ kind: 'room', id: areaId });
    else toast('That room is not linked to a Home Assistant area.');
    return;
  }
  const person = t.closest('[data-person]');
  if (person) { openSheet({ kind: 'person', id: person.dataset.person }); return; }
  const fp = t.closest('[data-focus-person]');
  if (fp) {
    closeSheet();
    if (ui.view !== 'places') location.hash = '#/places';
    setTimeout(() => peopleMap.focus(fp.dataset.focusPerson), 300);
    return;
  }
  const floor = t.closest('[data-floor]');
  if (floor) { planStore.floor = floor.dataset.floor; render(); return; }
  if (t.closest('[data-cam="retry"]')) { camPlayer?.start(); return; }

  const a = t.closest('[data-act]');
  if (a) {
    const id = a.closest('[data-entity]')?.dataset.entity || ui.sheet?.id;
    if (id) act(a.dataset.act, id, a);
    return;
  }
  const open = t.closest('[data-open]');
  if (open) {
    const id = open.closest('[data-entity]')?.dataset.entity;
    if (id) openSheet({ kind: 'device', id, back: sheetEl ? ui.sheet : null });
  }
});

document.addEventListener('keydown', (e) => {
  const room = e.target.closest?.('.plan-room[data-room]');
  if (room && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); room.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
});

$('#sheet').addEventListener('close', () => { stopCamera(); ui.sheet = null; });

// Sliders: show the number while dragging, send it on release.
document.addEventListener('input', (e) => {
  const r = e.target.closest('[data-slide]');
  if (!r) return;
  ui.dragging = true;
  const out = r.closest('.slide')?.querySelector('output');
  if (out) out.textContent = `${r.value}${out.textContent.replace(/^[\d.]+/, '')}`;
});
document.addEventListener('change', (e) => {
  const t = e.target;
  const r = t.closest('[data-slide]');
  if (r) {
    ui.dragging = false;
    const id = ui.sheet?.id;
    if (id) SLIDERS[r.dataset.slide]?.(id, Number(r.value));
    return;
  }
  if (t.dataset.entityRoom) {
    const next = { ...store.entityAreas };
    if (t.value) next[t.dataset.entityRoom] = t.value; else delete next[t.dataset.entityRoom];
    saveEntityAreas(next);
    roomsUi.open.add('_placed');
    toast(t.value ? `Moved to ${t.options[t.selectedIndex].textContent.trim()}` : 'Removed from its room');
    renderEntityRooms();
    return;
  }
  if (t.dataset.energyRole) {
    const picks = { ...store.prefs.energyPicks };
    if (t.value) picks[t.dataset.energyRole] = t.value; else delete picks[t.dataset.energyRole];
    store.prefs.energyPicks = picks;
    writePrefs();
    energy.hist = null;
    energy.histKey = '';
    render();
    return;
  }
  if (t.dataset.pref) {
    const key = t.dataset.pref;
    store.prefs[key] = t.type === 'checkbox' ? t.checked : ['idleMinutes', 'dim'].includes(key) ? Number(t.value) : t.value;
    writePrefs();
    applyTheme();
    if (['wall', 'idleMinutes', 'dim', 'dimNight', 'keepAwake'].includes(key)) { wallMode?.update(); renderFullscreenButton(); }
    if (['tint', 'sky', 'skyAnimate', 'weatherEntity'].includes(key)) applySky();
    if (key === 'calView') loadEvents(true);
    if (t.dataset.pref !== 'feedIn' && t.dataset.pref !== 'buyRate') render();
    return;
  }
  if (t.dataset.personShow) {
    const hidden = store.prefs.hiddenPeople || Object.fromEntries(peopleOf(store.states)
      .filter((p) => /wall|display|kiosk|tablet|ipad|dashboard/i.test(p.name)).map((p) => [p.id, true]));
    if (t.checked) delete hidden[t.dataset.personShow]; else hidden[t.dataset.personShow] = true;
    store.prefs.hiddenPeople = hidden;
    writePrefs();
    return;
  }
  if (t.dataset.cal) {
    if (t.checked) delete store.prefs.calHidden[t.dataset.cal]; else store.prefs.calHidden[t.dataset.cal] = true;
    writePrefs();
    loadEvents(true);
  }
});
function handleSettingsClick(t) {
  if (t.closest('[data-test-ding]')) { ding.play(); return true; }
  const prev = t.closest('[data-sky-preview]');
  if (prev) {
    skyPreview = prev.dataset.skyPreview;
    applySky();
    ui.viewHtml = '';
    render();
    return true;
  }
  const w = t.closest('[data-wall]');
  if (w) {
    if (w.dataset.wall === 'idle') wallMode?.sleep(); else Wall.toggleFullscreen();
    return true;
  }
  if (t.closest('[data-install]')) { promptInstall(); return true; }
  if (t.closest('[data-forget-token]')) {
    saveSettings({ ...loadSettings(), token: '' });
    toast('Token forgotten on this screen');
    start();
    return true;
  }
  return false;
}

function handleCalendarClick(t) {
  const v = t.closest('[data-cal-view]');
  if (v) {
    store.prefs.calView = v.dataset.calView;
    writePrefs();
    loadEvents(true);
    render();
    return true;
  }
  const m = t.closest('[data-cal-month]');
  if (m) {
    const step = Number(m.dataset.calMonth);
    const cur = calMonthShown();
    const n = new Date();
    ui.calMonth = step ? new Date(cur.getFullYear(), cur.getMonth() + step, 1) : new Date(n.getFullYear(), n.getMonth(), 1);
    loadEvents(true);
    render();
    return true;
  }
  const d = t.closest('[data-cal-day]');
  if (d) { openSheet({ kind: 'day', id: d.dataset.calDay }); return true; }
  return false;
}

// Typing in a search box redraws only its own results, so the box keeps focus.
document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'home-q') {
    ui.homeQuery = t.value;
    const out = $('#home-results');
    if (out) { out.innerHTML = searchResultsHtml(); paintCameras(out); }
  } else if (t.id === 'eroom-q') {
    roomsUi.filter = t.value;
    renderEntityRooms();
  }
});
// Remember which "Devices without a room" groups are open, so redraws keep the list where it was.
document.addEventListener('toggle', (e) => {
  const g = e.target.dataset?.eroomGroup;
  if (!g || roomsUi.filter) return;
  if (e.target.open) roomsUi.open.add(g); else roomsUi.open.delete(g);
}, true);

document.addEventListener('pointerup', () => { if (ui.dragging) setTimeout(() => { ui.dragging = false; }, 300); });

document.addEventListener('submit', (e) => {
  if (e.target.matches('[data-shop-add]')) {
    e.preventDefault();
    const input = e.target.querySelector('input');
    const item = input.value.trim();
    if (item && shop.id) call('todo', 'add_item', { item }, shop.id);
    input.value = '';
    return;
  }
  if (!e.target.matches('[data-conn]')) return;
  e.preventDefault();
  const f = new FormData(e.target);
  saveSettings({ url: String(f.get('url') || '').trim().replace(/\/+$/, ''), token: String(f.get('token') || '').trim(), forceToken: f.get('forceToken') === 'on' });
  start();
});

window.addEventListener('hashchange', () => { ui.scrolledTo = false; render(); window.scrollTo(0, 0); });
window.addEventListener('resize', () => { clearTimeout(ui.resizeTimer); ui.resizeTimer = setTimeout(render, 250); });

// ============================================================
// connection
// ============================================================

async function start() {
  store.client?.close();
  store.client = null;
  store.status = 'connecting';
  render();
  const auth = await resolveAuth();
  store.authMode = auth.mode;
  if (auth.mode === 'none') {
    store.status = 'auth_invalid';
    store.statusMessage = 'No access token';
    render();
    return;
  }
  const client = new HAClient({ url: auth.url, getToken: auth.getToken });
  store.client = client;
  voice.attach(client);
  client.addEventListener('status', (e) => {
    if (client !== store.client) return;
    store.status = e.detail.status;
    store.statusMessage = e.detail.message;
    renderStatus();
    if (!ready()) render();
  });
  client.addEventListener('ready', async (e) => {
    if (client !== store.client) return;
    const { states, config, areas, entityInfo } = e.detail;
    store.states = new Map(states.map((s) => [s.entity_id, s]));
    store.config = config || {};
    store.areas = new Map(areas.map((a) => [a.area_id, a.name]));
    store.entityInfo = entityInfo;
    devCache.key = '';
    render();
    client.send({ type: 'auth/current_user' }).then((u) => { store.user = u; queueRefresh(); }).catch(() => {});
    loadExposed();
    planStore.areas = store.areas;
    loadFloorPlan(client);
    updateSky({ instant: true });
    subscribeNotes(client);
    loadNews();
    dataGet('user', ENTITY_AREAS_KEY).then((v) => { if (v && typeof v === 'object') { store.entityAreas = v; queueRefresh(); } });
  });
  client.addEventListener('state', (e) => {
    if (client !== store.client) return;
    const { entityId, newState } = e.detail;
    if (newState) store.states.set(entityId, newState); else store.states.delete(entityId);
    if (ui.pending.has(entityId)) ui.pending.delete(entityId);
    if (newState?.state === 'on' && domainOf(entityId) === 'binary_sensor') ui.seenOn.add(entityId);
    if (domainOf(entityId) === 'event' && newState) newsSeen(newState);
    if (entityId === 'sun.sun' || domainOf(entityId) === 'weather') updateSky();
    if (domainOf(entityId) === 'sensor' && /power|state_of_charge/.test(entityId)) {
      const f = energyFlow(store.states, energyIds(), {});
      learnSigns(f.raw, null, energyIds());
    }
    if (ui.view === 'settings') return;
    queueRefresh();
  });
  client.connect();
}

// ============================================================
// updates: reload when a newer build is uploaded next to this page
// ============================================================

async function checkForUpdate() {
  if (DASH_BUILD === 'source' || document.hidden) return;
  let latest;
  try {
    const res = await fetch(new URL(`version.json?t=${Date.now()}`, location.href), { cache: 'no-store' });
    if (!res.ok) return;
    latest = (await res.json())?.build;
  } catch { return; }
  if (!latest || latest === DASH_BUILD) return;
  // Try each new build once every 10 minutes, so a half-finished upload can't loop.
  const tried = readLocal('ha-dash2.update-tried', {});
  if (tried.build === latest && Date.now() - tried.at < 600_000) return;
  writeLocal('ha-dash2.update-tried', { build: latest, at: Date.now() });
  const url = new URL(location.href);
  url.searchParams.set('v', latest.replace(/\W+/g, ''));
  location.replace(url.href);
}

// ============================================================
// boot
// ============================================================

const voice = new Voice();
renderNav();
render();
tickClock();
setInterval(tickClock, 15_000);
setInterval(() => { if (!document.hidden && ui.view !== 'settings') queueRefresh(); }, 60_000);
setInterval(checkForUpdate, 5 * 60_000);
document.addEventListener('visibilitychange', checkForUpdate);
setupWall();
setupInstall();
onInstallChange(() => { if (ui.view === 'settings') { ui.viewHtml = ''; render(); } });
applySky();
start();

// Floor plan: each home's own plan (a picture uploaded in Settings with rooms drawn over it,
// or rooms alone drawn as raised walls), how its rooms match Home Assistant areas, and the
// SVG for it. Pure rendering; app.js supplies what is on in each room.
//
// A layout is { v: 1, floors: [floor] }. A floor is
//   { id, name, w, h, style: 'picture' | 'drawn', img: revision of its picture or '',
//     crop: true to show just the part with rooms, invert: true to darken the picture in dark mode,
//     labels: false to leave room names off, rooms: [room], furniture: [...] (drawn plans only) }
// and a room is { id, name, points: [[x, y], ...], label?: [x, y], area?: area_id | 'none',
//   outdoor?, fixed? (drawn but not tappable, like a linen cupboard), compact?, aliases? }.
// Points are pixels on the floor's picture (or on a w × h sheet when it has none).

import { icon } from './icons.js';
import { esc } from './controls.js';

export const PLAN_LAYOUT_VERSION = 1;
export const PLAN_MAX_FLOORS = 4;
export const PLAN_MAX_ROOMS = 60;

const normName = (s) => String(s).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');

// Common other names for rooms, so a room called "Lounge" finds an area called "Living room".
const ROOM_WORDS = [
  ['lounge', 'loungeroom', 'sitting', 'sittingroom', 'tvroom', 'media', 'mediaroom', 'theatre', 'theater', 'rumpus', 'rumpusroom'],
  ['living', 'livingroom', 'family', 'familyroom', 'livinganddining', 'greatroom'],
  ['dining', 'diningroom', 'meals', 'mealsarea'],
  ['kitchen', 'kitch', 'kitchenette'],
  ['laundry', 'ldry', 'laundryroom', 'utility', 'utilityroom'],
  ['pantry', 'butlerspantry', 'scullery'],
  ['mudroom', 'mud', 'dropzone', 'bootroom'],
  ['garage', 'doublegarage', 'carport'],
  ['entry', 'entrance', 'foyer', 'entryhall', 'frontentry'],
  ['hall', 'hallway', 'corridor', 'passage', 'landing'],
  ['masterbed', 'masterbedroom', 'master', 'mainbedroom', 'mainbed', 'bedroom1', 'bed1', 'primarybedroom'],
  ['ensuite', 'ens', 'masterbath', 'masterbathroom', 'ensuitebathroom'],
  ['wir', 'walkinrobe', 'walkin', 'walkinwardrobe', 'walkincloset', 'robe', 'wardrobe', 'closet', 'dressing', 'dressingroom'],
  ['bathroom', 'bath', 'mainbathroom', 'familybathroom', 'kidsbathroom'],
  ['toilet', 'wc', 'powderroom', 'powder', 'restroom'],
  ['study', 'office', 'homeoffice', 'den', 'library'],
  ['porch', 'frontporch', 'frontdoor', 'frontyard', 'veranda', 'verandah'],
  ['alfresco', 'patio', 'deck', 'outdoor', 'outdoors', 'backyard', 'pergola', 'backpatio', 'garden', 'terrace', 'balcony'],
  ['nursery', 'babyroom'],
  ['gym', 'homegym', 'exercise'],
  ...[2, 3, 4, 5, 6].map((n) => [`bed${n}`, `bedroom${n}`]),
];

export function aliasesOf(room) {
  const own = (room.aliases || []).map(normName);
  const n = normName(room.name);
  const words = ROOM_WORDS.find((group) => group.includes(n)) || [];
  return [...new Set([...own, ...words])].filter((a) => a && a !== n);
}

/** Every room people can tap, on every floor, each with its floor's id. */
export function planRooms(layout) {
  return (layout?.floors || []).flatMap((f) => f.rooms.filter((r) => !r.fixed).map((r) => ({ ...r, floorId: f.id })));
}

/**
 * Which area each room shows.
 * @param {object[]} rooms            from planRooms()
 * @param {Map<string,string>} areas  area_id -> name
 * @param {object} overrides          roomId -> area_id, or 'none' to leave the room unlinked
 * @param {object} names              roomId -> a name given to the room on this device (older versions)
 * @returns {Map<string,string|null>} roomId -> area_id (null when nothing matches)
 */
export function matchRooms(rooms, areas, overrides = {}, names = {}) {
  const result = new Map();
  const taken = new Set();
  for (const r of rooms) {
    const o = overrides[r.id] || r.area;
    if (o === 'none') result.set(r.id, null);
    else if (o && areas.has(o)) {
      result.set(r.id, o);
      taken.add(o);
    }
  }
  const byName = new Map();
  for (const [id, name] of areas) {
    const n = normName(name);
    if (!byName.has(n)) byName.set(n, id);
  }
  const open = () => rooms.filter((r) => !result.has(r.id));
  const claim = (room, areaId) => {
    result.set(room.id, areaId);
    taken.add(areaId);
  };
  // Exact names first, best alias of every room before anyone's second best, so "Lounge"
  // goes to the lounge before the living room can claim it as an alias.
  const tries = new Map(rooms.map((r) => [r.id, [names[r.id] ? normName(names[r.id]) : '', normName(r.name), ...aliasesOf(r)]]));
  const longest = Math.max(0, ...[...tries.values()].map((t) => t.length));
  for (let rank = 0; rank < longest; rank++) {
    for (const r of open()) {
      const alias = tries.get(r.id)[rank];
      const id = alias && byName.get(alias);
      if (id && !taken.has(id)) claim(r, id);
    }
  }
  // Then looser: an area whose name contains a distinctive alias ("Kids bathroom", "Front porch light").
  for (const r of open()) {
    for (const alias of tries.get(r.id).filter((a) => a.length >= 5)) {
      const hit = [...areas].find(([id, name]) => !taken.has(id) && normName(name).includes(alias));
      if (hit) {
        claim(r, hit[0]);
        break;
      }
    }
  }
  for (const r of open()) result.set(r.id, null);
  return result;
}

// ---------- shapes ----------

function bbox(points) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

export function pointInPolygon([x, y], points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Where a room's name goes: its own spot, else the middle of its widest part. */
export function roomLabelPoint(room) {
  if (room.label) return room.label;
  const pts = room.points;
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const f = pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
    a += f;
    cx += (pts[j][0] + pts[i][0]) * f;
    cy += (pts[j][1] + pts[i][1]) * f;
  }
  if (Math.abs(a) > 1e-6) {
    const c = [cx / (3 * a), cy / (3 * a)];
    if (pointInPolygon(c, pts)) return c;
  }
  // An L shape whose centre falls outside: the middle of the widest stretch across it.
  const b = bbox(pts);
  let best = [b.x + b.w / 2, b.y + b.h / 2];
  let bestW = -1;
  for (let k = 1; k < 10; k++) {
    const y = b.y + (b.h * k) / 10;
    const xs = [];
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [x1, y1] = pts[j];
      const [x2, y2] = pts[i];
      if ((y1 > y) !== (y2 > y)) xs.push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1));
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      if (xs[i + 1] - xs[i] > bestW) {
        bestW = xs[i + 1] - xs[i];
        best = [(xs[i] + xs[i + 1]) / 2, y];
      }
    }
  }
  return best;
}

/**
 * The part of the floor that is shown: the whole picture, or just the rooms with a little margin.
 * With `outside`, a wider margin leaves room for camera markers around the house.
 */
export function planBox(floor, outside = false) {
  const all = floor.rooms.flatMap((r) => r.points);
  let b;
  if (floor.box) b = floor.box;
  else if (!all.length || (floor.style === 'picture' && floor.img && !floor.crop)) b = { x: 0, y: 0, w: floor.w, h: floor.h };
  else {
    const r = bbox(all);
    const m = Math.max(8, Math.round(Math.max(r.w, r.h) * 0.025));
    const x = Math.max(0, r.x - m);
    const y = Math.max(0, r.y - m);
    b = { x, y, w: Math.min(floor.w, r.x + r.w + m) - x, h: Math.min(floor.h, r.y + r.h + m) - y };
  }
  if (!outside) return b;
  const m = Math.round(Math.max(b.w, b.h) * 0.06);
  const x = Math.max(0, b.x - m);
  const y = Math.max(0, b.y - m);
  return { x, y, w: Math.min(floor.w, b.x + b.w + m) - x, h: Math.min(floor.h, b.y + b.h + m) - y };
}

// ---------- cameras around the house ----------

// Words in a camera's name that point at a room even when the names differ.
const CAM_HINTS = [
  [['driveway', 'drive', 'carport', 'car', 'garagedoor'], ['garage', 'carport']],
  [['frontdoor', 'front', 'doorbell', 'door', 'porch', 'entry'], ['porch', 'entry', 'frontdoor']],
  [['deck', 'patio', 'backyard', 'back', 'yard', 'garden', 'pool', 'alfresco'], ['alfresco', 'deck', 'patio', 'outdoor']],
];

/** The room a camera most likely watches, from its area first and then the words in its name. */
export function cameraRoom(floor, name, areaRoom) {
  const rooms = floor.rooms.filter((r) => !r.fixed);
  if (areaRoom && rooms.some((r) => r.id === areaRoom)) return areaRoom;
  const words = String(name).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const keys = new Set([...words, ...words.slice(1).map((w, i) => words[i] + w), words.join('')].map(normName));
  const names = (r) => [normName(r.name), ...aliasesOf(r)];
  const hit = (want) => rooms.find((r) => names(r).some((n) => want.has(n)));
  let room = hit(keys);
  for (const [from, to] of CAM_HINTS) {
    if (room) break;
    if (from.some((w) => keys.has(w))) room = hit(new Set(to));
  }
  return room?.id || null;
}

/**
 * Suggested spots for cameras nobody has placed yet: just outside the house on the side nearest
 * the room each one watches, and cameras with no room spread evenly around the rest of the outside.
 * @param {object} floor
 * @param {Array<{id, room}>} cams  room is a room id or null
 * @param {Array<[number, number]>} taken  spots already used by placed cameras
 * @returns {Map<string, [number, number]>}
 */
export function suggestCamSpots(floor, cams, taken = []) {
  const out = new Map();
  const all = floor.rooms.flatMap((r) => r.points);
  if (!all.length) return out;
  const house = bbox(all);
  const box = planBox(floor, true);
  const size = Math.max(house.w, house.h);
  const off = size * 0.035;
  const gap = size * 0.11;
  // The ring the markers sit on, clamped to what is shown.
  const L = Math.max(box.x + off * 0.6, house.x - off);
  const R = Math.min(box.x + box.w - off * 0.6, house.x + house.w + off);
  const T = Math.max(box.y + off * 0.6, house.y - off);
  const B = Math.min(box.y + box.h - off * 0.6, house.y + house.h + off);
  const used = taken.map((p) => [...p]);
  const free = (p) => used.every((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) >= gap);
  const round = (p) => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10];
  // Walk round the ring: t in [0, perimeter) to a point.
  const sides = [R - L, B - T, R - L, B - T];
  const per = sides.reduce((a, b) => a + b, 0);
  const ringAt = (t) => {
    t = ((t % per) + per) % per;
    if (t < sides[0]) return [L + t, T];
    t -= sides[0];
    if (t < sides[1]) return [R, T + t];
    t -= sides[1];
    if (t < sides[2]) return [R - t, B];
    return [L, B - (t - sides[2])];
  };
  const ringOf = ([px, py]) => {
    const d = [py - T, R - px, B - py, px - L].map(Math.abs);
    const side = d.indexOf(Math.min(...d));
    const cx = Math.min(R, Math.max(L, px));
    const cy = Math.min(B, Math.max(T, py));
    return [cx - L, sides[0] + (cy - T), sides[0] + sides[1] + (R - cx), sides[0] + sides[1] + sides[2] + (B - cy)][side];
  };
  const place = (id, t0) => {
    for (let i = 0; i < 40; i++) {
      const step = Math.ceil(i / 2) * gap * 0.5 * (i % 2 ? 1 : -1);
      const p = ringAt(t0 + step);
      if (free(p)) { used.push(p); out.set(id, round(p)); return; }
    }
    const p = ringAt(t0);
    used.push(p);
    out.set(id, round(p));
  };
  const byId = new Map(floor.rooms.map((r) => [r.id, r]));
  const rest = [];
  for (const c of cams) {
    const room = c.room && byId.get(c.room);
    if (room) place(c.id, ringOf(roomLabelPoint(room)));
    else rest.push(c);
  }
  for (const c of rest) {
    // The point on the ring furthest from every camera already there.
    let best = 0;
    let bestD = -1;
    for (let t = 0; t < per; t += per / 96) {
      const p = ringAt(t);
      const d = used.length ? Math.min(...used.map((q) => Math.hypot(p[0] - q[0], p[1] - q[1]))) : 0;
      if (d > bestD + 0.01) { bestD = d; best = t; }
    }
    place(c.id, best);
  }
  return out;
}

/** A point on the drawn plan (fractions of its width and height) back in the floor's own pixels. */
export function planPointAt(floor, { rotated = false, outside = false } = {}, fx, fy) {
  const { x, y, w, h } = planBox(floor, outside);
  rotated = rotated && planCanRotate(floor);
  const W = rotated ? h : w;
  const H = rotated ? w : h;
  const X = Math.min(1, Math.max(0, fx)) * W;
  const Y = Math.min(1, Math.max(0, fy)) * H;
  const p = rotated ? [Y + x, y + h - X] : [X + x, Y + y];
  return p.map((n) => Math.round(n * 10) / 10);
}

/** Phones turn a wide plan on its side; a plan that is already tall stays as it is. */
export function planCanRotate(floor) {
  const b = planBox(floor);
  return b.w > b.h * 1.15;
}

// ---------- checking layouts (saved, or imported from a file) ----------

const planNum = (v) => (v !== null && v !== '' && Number.isFinite(Number(v)) ? Math.round(Number(v) * 10) / 10 : null);
const planPt = (p) => (Array.isArray(p) && p.length === 2 && planNum(p[0]) != null && planNum(p[1]) != null ? [planNum(p[0]), planNum(p[1])] : null);
const planStr = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const planSafeId = (v) => String(v ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);

/** A layout made safe to use, or null when it is not one. */
export function cleanLayout(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.floors)) return null;
  const ids = new Set();
  const floors = [];
  for (const f of raw.floors.slice(0, PLAN_MAX_FLOORS)) {
    if (!f || typeof f !== 'object') continue;
    const w = planNum(f.w);
    const h = planNum(f.h);
    if (!(w > 0 && h > 0)) continue;
    let id = planSafeId(f.id) || `f${floors.length + 1}`;
    while (ids.has(id)) id += 'x';
    ids.add(id);
    const rooms = [];
    for (const r of (Array.isArray(f.rooms) ? f.rooms : []).slice(0, PLAN_MAX_ROOMS)) {
      const points = (Array.isArray(r?.points) ? r.points : []).map(planPt).filter(Boolean).slice(0, 64);
      if (points.length < 3) continue;
      let rid = planSafeId(r.id) || `r${rooms.length + 1}`;
      while (ids.has(rid)) rid += 'x';
      ids.add(rid);
      const room = { id: rid, name: planStr(r.name, 40) || 'Room', points };
      if (planPt(r.label)) room.label = planPt(r.label);
      if (typeof r.area === 'string' && r.area) room.area = planStr(r.area, 80);
      for (const k of ['outdoor', 'fixed', 'compact']) if (r[k]) room[k] = true;
      if (Array.isArray(r.aliases)) room.aliases = r.aliases.map((a) => normName(a)).filter(Boolean).slice(0, 20);
      rooms.push(room);
    }
    const floor = {
      id, name: planStr(f.name, 30) || `Floor ${floors.length + 1}`, w, h,
      style: f.style === 'drawn' ? 'drawn' : 'picture',
      img: typeof f.img === 'string' ? planSafeId(f.img) : '',
      crop: !!f.crop, invert: f.invert !== false, labels: f.labels !== false, rooms,
    };
    if (f.box && [f.box.x, f.box.y, f.box.w, f.box.h].every((v) => planNum(v) != null) && f.box.w > 0 && f.box.h > 0) {
      floor.box = { x: planNum(f.box.x), y: planNum(f.box.y), w: planNum(f.box.w), h: planNum(f.box.h) };
    }
    if (f.cams && typeof f.cams === 'object') {
      const cams = {};
      for (const [cid, at] of Object.entries(f.cams).slice(0, 60)) {
        if (!/^camera\.[a-z0-9_]{1,80}$/.test(cid)) continue;
        if (at === false) cams[cid] = false;
        else if (planPt(at)) cams[cid] = planPt(at);
      }
      if (Object.keys(cams).length) floor.cams = cams;
    }
    if (Array.isArray(f.furniture)) {
      floor.furniture = f.furniture.slice(0, 200).map((it) => {
        const rect = Array.isArray(it?.rect) && it.rect.length === 4 ? it.rect.map(planNum) : null;
        if (!rect || rect.some((v) => v == null)) return null;
        return { rect, ...(planNum(it.r) ? { r: planNum(it.r) } : {}), ...(it.round ? { round: true } : {}),
          ...(/^(soft|pillow|bench|dark|car|glass)$/.test(it.kind) ? { kind: it.kind } : {}) };
      }).filter(Boolean);
    }
    floors.push(floor);
  }
  return floors.length ? { v: PLAN_LAYOUT_VERSION, floors } : null;
}

// ---------- drawing ----------

/**
 * One floor as HTML: the picture (or floors and raised walls), lit rooms glowing, names laid over it.
 * Portrait phones get a wide plan turned a quarter clockwise so it fills the screen.
 * @param {object} floor
 * @param {(room) => object} info  { areaId, glow: {color, strength}, temp, lightsOn, motion, open, cameras, label, name }
 * @param {object} opts            rotated, image (data URL of the floor's picture),
 *                                 cams: [{ id, at: [x, y], name, alert, picked }] markers round the house,
 *                                 outside: leave room round the house for camera markers
 */
export function planHtml(floor, info, { rotated = false, image = '', cams = [], outside = cams.length > 0 } = {}) {
  const { x, y, w, h } = planBox(floor, outside);
  rotated = rotated && planCanRotate(floor);
  const W = rotated ? h : w;
  const H = rotated ? w : h;
  const at = rotated ? ([px, py]) => [y + h - py, px - x] : ([px, py]) => [px - x, py - y];
  const pts = (points) => points.map((p) => at(p).map((n) => Math.round(n * 10) / 10).join(',')).join(' ');
  const pct = (v, of) => `${((v / of) * 100).toFixed(2)}%`;
  const picture = floor.style === 'picture' && !!image;
  const area = w * h;
  const fid = floor.id;

  const defs = [];
  const floors = [];
  const glows = [];
  const walls = [];
  const porches = [];
  const labels = [];

  for (const r of floor.rooms) {
    const poly = pts(r.points);
    if (!picture) (r.outdoor ? porches : walls).push(`<polygon points="${poly}"/>`);
    if (r.fixed) {
      if (!picture) floors.push(`<polygon class="plan-fixed" points="${poly}"/>`);
      continue;
    }
    const d = info(r);
    const classes = ['plan-room'];
    if (r.outdoor) classes.push('outdoor');
    if (!d.areaId) classes.push('unlinked');
    if (d.glow) classes.push('lit');
    const b = bbox(r.points.map(at));
    const [lx, ly] = at(roomLabelPoint(r));

    if (d.glow) {
      defs.push(`<clipPath id="plan-clip-${fid}-${r.id}"><polygon points="${poly}"/></clipPath>
        <radialGradient id="plan-glow-${fid}-${r.id}">
          <stop offset="0" stop-color="${d.glow.color}" stop-opacity="${(0.3 + 0.6 * d.glow.strength).toFixed(2)}"/>
          <stop offset="1" stop-color="${d.glow.color}" stop-opacity="0"/>
        </radialGradient>`);
      glows.push(`<ellipse class="plan-glow" clip-path="url(#plan-clip-${fid}-${r.id})" fill="url(#plan-glow-${fid}-${r.id})"
        cx="${Math.round(lx)}" cy="${Math.round(ly)}" rx="${Math.round(b.w * 0.8 + 20)}" ry="${Math.round(b.h * 0.8 + 20)}"/>`);
    }
    const spoken = [d.label, d.lightsOn ? `${d.lightsOn} ${d.lightsOn === 1 ? 'light' : 'lights'} on` : '', d.temp,
      d.open ? 'open' : '', d.motion ? 'motion' : '', d.blindsOpen ? `${d.blindsOpen} ${d.blindsOpen === 1 ? 'blind' : 'blinds'} open` : '',
      d.running ? `${d.running} running` : '', d.cameras ? `${d.cameras} ${d.cameras === 1 ? 'camera' : 'cameras'}` : '', d.areaId ? '' : 'not linked to an area'].filter(Boolean).join(', ');
    floors.push(`<g class="${classes.join(' ')}" data-room="${esc(r.id)}" role="button" tabindex="0" aria-label="${esc(spoken)}">
      <polygon class="plan-shape" points="${poly}"/>
    </g>`);

    const named = floor.labels !== false;
    if (!named && !d.lightsOn && !d.temp && !d.open && !d.cameras && !d.motion && !d.blindsOpen && !d.running) continue;
    // Small rooms get a smaller name and no readings, so they do not spill into their neighbours.
    const compact = r.compact ?? (b.w * b.h) / area < 0.022;
    const fit = b.w * 0.92; // wrap long names inside narrow rooms
    const meta = [
      d.temp ? `<span>${esc(d.temp)}</span>` : '',
      d.lightsOn ? `<span class="plan-lights">${icon('light')}${d.lightsOn}</span>` : '',
      d.open ? `<span class="plan-open">${icon('door')}</span>` : '',
      d.blindsOpen ? `<span class="plan-blinds">${icon('blindOpen')}${d.blinds > 1 ? d.blindsOpen : ''}</span>` : '',
      d.running ? `<span class="plan-running">${icon('appliance')}</span>` : '',
      d.cameras ? `<span class="plan-cam">${icon('camera')}</span>` : '',
    ].join('');
    const title = named || d.motion ? `<strong>${d.motion ? '<i class="plan-motion"></i>' : ''}${named ? esc(d.name || r.name) : ''}</strong>` : '';
    labels.push(`<div class="plan-label${compact ? ' compact' : ''}${d.areaId ? '' : ' unlinked'}${d.glow ? ' lit' : ''}" style="left:${pct(lx, W)};top:${pct(ly, H)};max-width:${pct(fit, W)}" aria-hidden="true">
      ${title}
      ${meta ? `<span class="plan-meta">${meta}</span>` : ''}
    </div>`);
  }

  const furniture = picture ? '' : (floor.furniture || []).map((f) => {
    const [fx, fy, fw, fh] = f.rect;
    const b = bbox([at([fx, fy]), at([fx + fw, fy + fh])]);
    const cls = `plan-furn${f.kind ? ` ${f.kind}` : ''}`;
    if (f.round) return `<circle class="${cls}" cx="${b.x + b.w / 2}" cy="${b.y + b.h / 2}" r="${b.w / 2}"/>`;
    return `<rect class="${cls}" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${f.r || 0}"/>`;
  }).join('');

  // The picture sits in the floor's own pixels; turn and shift it the same way as the rooms.
  const imgMatrix = rotated ? `matrix(0 1 -1 0 ${y + h} ${-x})` : `translate(${-x} ${-y})`;
  const art = picture
    ? `<g clip-path="url(#plan-crop-${fid})">
        <image class="plan-img" href="${esc(image)}" x="0" y="0" width="${floor.w}" height="${floor.h}" preserveAspectRatio="none" transform="${imgMatrix}"/>
      </g>
      <g class="plan-glows" aria-hidden="true">${glows.join('')}</g>
      <g class="plan-floors">${floors.join('')}</g>`
    // Walls are drawn three times: a soft cast shadow, a darker side face nudged down and
    // right, and the lighter top. Together they read as walls standing up off the floor.
    : `<g class="plan-floors" filter="url(#plan-float)">${floors.join('')}</g>
      <g class="plan-furniture" aria-hidden="true" filter="url(#plan-lift)">${furniture}</g>
      <g class="plan-glows" aria-hidden="true">${glows.join('')}</g>
      <g class="plan-porches" aria-hidden="true">${porches.join('')}</g>
      <g class="plan-wall-cast" aria-hidden="true" filter="url(#plan-cast)" transform="translate(4 6)">${walls.join('')}</g>
      <g class="plan-wall-side" aria-hidden="true" transform="translate(1.6 2.6)">${walls.join('')}</g>
      <g class="plan-wall-top" aria-hidden="true">${walls.join('')}</g>`;

  const markers = cams.map((c) => {
    const [cx, cy] = at(c.at);
    return `<button type="button" class="plan-camera${c.alert ? ' alert' : ''}${c.picked ? ' picked' : ''}" data-open-entity="${esc(c.id)}" data-plan-cam="${esc(c.id)}"
      style="left:${pct(cx, W)};top:${pct(cy, H)}" aria-label="${esc(`${c.name} camera${c.alert ? ', someone there' : ''}`)}">
      <i>${icon('camera')}</i><span>${esc(c.name)}</span>
    </button>`;
  }).join('');

  // Wall thickness follows the plan's size, so a big plan's walls look as thick as a small one's.
  const scale = Math.max(w, h) / 1000;
  return `<div class="plan${rotated ? ' rotated' : ''}${picture ? ' picture' : ' drawn'}${picture && floor.invert !== false ? ' invert-dark' : ''}" data-floor="${esc(fid)}"
      style="--ar:${W} / ${H};--ar-n:${(W / H).toFixed(4)};--wall:${(5.5 * scale).toFixed(2)}px">
    <svg viewBox="0 0 ${W} ${H}" role="group" aria-label="${esc(floor.name)} floor plan">
      <defs>
        <clipPath id="plan-crop-${fid}"><rect x="0" y="0" width="${W}" height="${H}"/></clipPath>
        <filter id="plan-cast" x="-10%" y="-10%" width="120%" height="120%">
          <feGaussianBlur stdDeviation="3"/>
        </filter>
        <filter id="plan-float" x="-10%" y="-10%" width="120%" height="130%">
          <feDropShadow dx="0" dy="8" stdDeviation="9" flood-color="#000" flood-opacity="0.38"/>
        </filter>
        <filter id="plan-lift" x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="1.5" dy="2.5" stdDeviation="1.6" flood-color="#000" flood-opacity="0.35"/>
        </filter>
        <filter id="plan-invert" color-interpolation-filters="sRGB">
          <feColorMatrix type="matrix" values="-1 0 0 0 1  0 -1 0 0 1  0 0 -1 0 1  0 0 0 1 0"/>
          <feColorMatrix type="hueRotate" values="180"/>
          <feComponentTransfer><feFuncR type="linear" slope="0.8" intercept="0.09"/><feFuncG type="linear" slope="0.8" intercept="0.1"/><feFuncB type="linear" slope="0.8" intercept="0.13"/></feComponentTransfer>
        </filter>
        ${defs.join('')}
      </defs>
      ${art}
    </svg>
    ${labels.join('')}
    ${markers}
  </div>`;
}

/** Glow colour for a light that is on: its own colour, or warm/cool white from its temperature. */
export function lightGlowColor(s) {
  const a = s.attributes || {};
  if (Array.isArray(a.rgb_color) && a.color_mode && !['color_temp', 'brightness', 'onoff', 'white'].includes(a.color_mode)) {
    return `rgb(${a.rgb_color.map((n) => Math.round(n)).join(' ')})`;
  }
  const k = Number(a.color_temp_kelvin);
  if (Number.isFinite(k)) {
    // 2200 K amber through to 6500 K cool white.
    const t = Math.min(1, Math.max(0, (k - 2200) / 4300));
    const mix = (from, to) => Math.round(from + (to - from) * t);
    return `rgb(${mix(255, 236)} ${mix(170, 242)} ${mix(80, 255)})`;
  }
  return 'rgb(255 190 100)';
}

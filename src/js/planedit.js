// Floor plan set-up in Settings: checking and shrinking an uploaded picture, and the editor
// where rooms are drawn over it (rectangles or any shape), named and linked to areas.
// The editor changes the floor it is given in place and calls onChange after each edit.

import { icon } from './icons.js';
import { esc } from './controls.js';
import { roomLabelPoint, pointInPolygon, PLAN_MAX_ROOMS } from './plan.js';

// What a floor plan picture has to be. Settings shows these, and readPlanPicture enforces them.
export const PLAN_RULES = {
  types: { 'image/png': 'PNG', 'image/jpeg': 'JPG', 'image/webp': 'WebP', 'image/svg+xml': 'SVG' },
  accept: '.png,.jpg,.jpeg,.webp,.svg,image/png,image/jpeg,image/webp,image/svg+xml',
  maxFileMB: 10,     // bigger files are refused
  minSide: 800,      // pixels on the longest side, so walls are sharp on a tablet
  maxRatio: 3,       // no longer than 3 times as wide as it is tall, or the other way round
  keepSide: 2000,    // bigger pictures are shrunk to this many pixels on the longest side
  keepBytes: 1_400_000, // what is saved in Home Assistant, as a data URL (its messages top out at 4 MB)
};

const typeOfFile = (file) => {
  if (PLAN_RULES.types[file.type]) return file.type;
  const ext = (file.name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml' }[ext] || '';
};

function readAs(file, how) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('That file could not be read.'));
    r[how](file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('That file is not a picture this browser can open.'));
    img.src = src;
  });
}

/**
 * Check an uploaded floor plan picture against PLAN_RULES and shrink it to fit Home Assistant.
 * @returns {Promise<{data: string, w: number, h: number, note: string}>}  w × h is the floor's sheet size
 * @throws  Error with a message for people when the picture breaks a rule
 */
export async function readPlanPicture(file) {
  const type = typeOfFile(file);
  if (!type) {
    if (/heic|heif/i.test(file.type) || /\.hei[cf]$/i.test(file.name)) {
      throw new Error('iPhone photos (HEIC) cannot be used. Take a screenshot of the plan, or share it as a JPG, and upload that.');
    }
    if (/pdf/i.test(file.type) || /\.pdf$/i.test(file.name)) {
      throw new Error('PDFs cannot be used. Open the PDF, take a screenshot of the floor you want (or export the page as PNG), and upload that.');
    }
    throw new Error(`That is not a floor plan picture. Use a ${Object.values(PLAN_RULES.types).join(', ').replace(/, (\w+)$/, ' or $1')} file.`);
  }
  if (file.size > PLAN_RULES.maxFileMB * 1024 * 1024) {
    throw new Error(`That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. Use one under ${PLAN_RULES.maxFileMB} MB (a screenshot of the plan is usually much smaller).`);
  }
  const url = await readAs(file, 'readAsDataURL');
  const img = await loadImage(url);
  let w = img.naturalWidth;
  let h = img.naturalHeight;
  const svg = type === 'image/svg+xml';
  if (svg && !(w && h)) {
    // An SVG without a size: use its viewBox.
    const vb = (await readAs(file, 'readAsText')).match(/viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
    w = Number(vb?.[1]) || 0;
    h = Number(vb?.[2]) || 0;
  }
  if (!(w > 0 && h > 0)) throw new Error('That picture has no size, so it cannot be used. Try exporting it as PNG.');
  const long = Math.max(w, h);
  const ratio = long / Math.min(w, h);
  if (ratio > PLAN_RULES.maxRatio) {
    throw new Error(`That picture is ${ratio.toFixed(1)} times as ${w > h ? 'wide as it is tall' : 'tall as it is wide'}. Crop it closer to the house so it is no more than ${PLAN_RULES.maxRatio} times.`);
  }
  if (!svg && long < PLAN_RULES.minSide) {
    throw new Error(`That picture is only ${w} × ${h} pixels, so walls would look blurry. Use one at least ${PLAN_RULES.minSide} pixels on its longest side.`);
  }
  // Vector pictures get a sheet of the usual size; their own units can be anything.
  const scaleSheet = svg ? PLAN_RULES.keepSide / long : 1;
  if (svg && url.length <= PLAN_RULES.keepBytes) {
    return { data: url, w: Math.round(w * scaleSheet), h: Math.round(h * scaleSheet), note: '' };
  }
  // PNG and WebP that are already small enough are kept exactly as they are. Photos (JPG) are
  // always redrawn, which also turns them the right way up.
  if (!svg && type !== 'image/jpeg' && long <= PLAN_RULES.keepSide && url.length <= PLAN_RULES.keepBytes) {
    return { data: url, w, h, note: '' };
  }
  let scale = svg ? scaleSheet : Math.min(1, PLAN_RULES.keepSide / long);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  for (let round = 0; round < 6; round++) {
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const tries = [['image/png'], ['image/webp', 0.86], ['image/jpeg', 0.86], ['image/jpeg', 0.72]];
    for (const [t, q] of tries) {
      ctx.fillStyle = '#fff'; // JPG has no see-through parts; a plan's background is usually white anyway
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      let data;
      try { data = canvas.toDataURL(t, q); } catch { throw new Error('This browser would not let the picture be resized. Try a PNG or JPG instead.'); }
      if (!data.startsWith(`data:${t}`)) continue; // that format is not supported here
      if (data.length <= PLAN_RULES.keepBytes) {
        const shrunk = canvas.width < w;
        return {
          data, w: canvas.width, h: canvas.height,
          note: shrunk && !svg ? `Shrunk from ${w} × ${h} to ${canvas.width} × ${canvas.height} pixels to fit in Home Assistant.` : '',
        };
      }
    }
    scale *= 0.8;
    if (Math.max(canvas.width, canvas.height) * 0.8 < PLAN_RULES.minSide) break;
  }
  throw new Error('That picture has too much detail to save in Home Assistant, even shrunk. Crop it closer to the house, or use a simpler plan (black lines on white work best).');
}

// ---------- the editor ----------

const SNAP_PX = 12;   // how close (on screen) a corner has to come to another to snap to it
const HANDLE_PX = 9;  // corner handle radius on screen
const UNDO_MAX = 40;

const newRoomId = (floor) => {
  const used = new Set(floor.rooms.map((r) => r.id));
  let id;
  do id = `r${Math.random().toString(36).slice(2, 7)}`; while (used.has(id));
  return id;
};
const round1 = (n) => Math.round(n * 10) / 10;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const polyArea = (pts) => Math.abs(pts.reduce((s, p, i) => {
  const q = pts[(i + 1) % pts.length];
  return s + p[0] * q[1] - q[0] * p[1];
}, 0) / 2);

/** Everything the editor remembers between Settings redraws. */
export const planEditState = { floorId: null, selected: null, mode: 'select', vertex: null, undo: [] };

export class PlanEditor {
  /**
   * @param {HTMLElement} host
   * @param {object} opts  floor, image (data URL or ''), areas (Map area_id -> name),
   *                       autoArea(room) -> area name it matches by itself or '', onChange()
   */
  constructor(host, { floor, image, areas, autoArea, onChange }) {
    this.host = host;
    this.floor = floor;
    this.image = image;
    this.areas = areas;
    this.autoArea = autoArea;
    this.onChange = onChange;
    this.draft = null;   // corners placed so far while drawing a shape
    this.drag = null;
    this.hover = null;
    const st = planEditState;
    if (st.floorId !== floor.id) Object.assign(st, { floorId: floor.id, selected: null, vertex: null, mode: 'select', undo: [] });
    if (st.selected && !floor.rooms.some((r) => r.id === st.selected)) st.selected = null;
    this.view = this.viewBox();
    this.render();
  }

  get st() { return planEditState; }
  get room() { return this.floor.rooms.find((r) => r.id === this.st.selected) || null; }

  /** The part of the sheet the editor shows: all of a picture, or the rooms with room to add more. */
  viewBox() {
    const f = this.floor;
    if (this.image || !f.rooms.length) return { x: 0, y: 0, w: f.w, h: f.h };
    const pts = f.rooms.flatMap((r) => r.points);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const bw = Math.max(...xs) - Math.min(...xs);
    const bh = Math.max(...ys) - Math.min(...ys);
    const m = Math.max(bw, bh) * 0.12;
    const x = Math.max(0, Math.min(...xs) - m);
    const y = Math.max(0, Math.min(...ys) - m);
    return { x, y, w: Math.min(f.w, Math.max(...xs) + m) - x, h: Math.min(f.h, Math.max(...ys) + m) - y };
  }

  render() {
    const { mode } = this.st;
    const room = this.room;
    const drawing = mode === 'shape' && this.draft?.length;
    const full = this.floor.rooms.length >= PLAN_MAX_ROOMS;
    const tool = (m, label, ic) => `<button type="button" class="chip${mode === m ? ' on' : ''}" data-pe-mode="${m}" aria-pressed="${mode === m}" ${m !== 'select' && full ? 'disabled' : ''}>${icon(ic)}${label}</button>`;
    this.host.innerHTML = `
      <div class="pe-tools" role="toolbar" aria-label="Floor plan tools">
        ${tool('select', 'Select', 'cursor')}
        ${tool('rect', 'Rectangle', 'rect')}
        ${tool('shape', 'Any shape', 'shape')}
        <button type="button" class="chip" data-pe="undo" ${this.st.undo.length ? '' : 'disabled'}>${icon('undo')}Undo</button>
      </div>
      <p class="pe-hint muted" aria-live="polite">${esc(this.hint())}</p>
      ${drawing ? `<div class="pe-tools pe-draft">
        <button type="button" class="btn primary" data-pe="finish" ${this.draft.length >= 3 ? '' : 'disabled'}>Finish room</button>
        <button type="button" class="btn" data-pe="unpoint">Remove last corner</button>
        <button type="button" class="btn" data-pe="cancel">Cancel</button>
      </div>` : ''}
      <div class="pe-stage${this.image ? ' has-picture' : ''}" style="--ar:${this.view.w} / ${this.view.h}">
        <svg viewBox="${this.view.x} ${this.view.y} ${this.view.w} ${this.view.h}" class="pe-svg" data-mode="${mode}"></svg>
      </div>
      <div class="pe-rooms" role="list" aria-label="Rooms on this floor">
        ${this.floor.rooms.map((r) => `<button type="button" role="listitem" class="chip${r.id === this.st.selected ? ' on' : ''}" data-pe-room="${esc(r.id)}">${esc(r.name)}${r.fixed ? '' : this.areaBadge(r)}</button>`).join('')
          || '<span class="muted">No rooms yet. Pick Rectangle and drag across a room on the plan.</span>'}
      </div>
      ${room ? this.roomFormHtml(room) : ''}`;
    this.svg = this.host.querySelector('.pe-svg');
    this.drawSvg();
    this.wire();
  }

  areaBadge(r) {
    if (r.area === 'none') return ' <small class="muted">· not linked</small>';
    if (r.area && this.areas.has(r.area)) return '';
    return this.autoArea(r) ? '' : ' <small class="pe-warn">· no area</small>';
  }

  hint() {
    const { mode } = this.st;
    if (mode === 'rect') return 'Drag from one corner of a room to the opposite corner.';
    if (mode === 'shape') {
      return this.draft?.length
        ? `${this.draft.length} ${this.draft.length === 1 ? 'corner' : 'corners'}. Tap the next corner, or tap the first one to finish.`
        : 'Tap each corner of the room in turn, then tap the first corner again to finish.';
    }
    if (this.room) return 'Drag a corner to move it, drag a small dot to add a corner, or drag inside the room to move it all. Corners snap to nearby corners.';
    return this.floor.rooms.length ? 'Tap a room to change it.' : 'Pick Rectangle (or Any shape for L-shaped rooms) to draw your first room.';
  }

  roomFormHtml(room) {
    const auto = this.autoArea(room);
    const sorted = [...this.areas].sort((a, b) => a[1].localeCompare(b[1]));
    const cur = room.area || '';
    return `<div class="pe-room form" data-pe-form="${esc(room.id)}">
      <label class="field"><span>Room name</span>
        <input type="text" id="pe-name" maxlength="40" autocomplete="off" value="${esc(room.name)}">
      </label>
      ${room.fixed ? '' : `<label class="field"><span>Home Assistant area</span>
        ${this.areas.size ? `<select class="select" id="pe-area">
          <option value="">${esc(auto ? `Automatic (${auto})` : 'Automatic (no match)')}</option>
          <option value="none" ${cur === 'none' ? 'selected' : ''}>Not linked</option>
          ${sorted.map(([id, name]) => `<option value="${esc(id)}" ${cur === id ? 'selected' : ''}>${esc(name)}</option>`).join('')}
        </select>` : '<small class="muted">Connect with an administrator login to link rooms to areas.</small>'}
      </label>`}
      <label class="check"><input type="checkbox" id="pe-outdoor" ${room.outdoor ? 'checked' : ''}><span>Outdoors (porch, deck, yard)</span></label>
      <label class="check"><input type="checkbox" id="pe-fixed" ${room.fixed ? 'checked' : ''}><span>Just part of the drawing (a cupboard or stairs, not tappable)</span></label>
      <div class="form-actions">
        <button type="button" class="btn" data-pe="unvertex" ${this.st.vertex != null && room.points.length > 3 ? '' : 'disabled'}>Remove selected corner</button>
        <button type="button" class="btn" data-pe="label-reset" ${room.label ? '' : 'disabled'}>Centre the name</button>
        <button type="button" class="btn danger" data-pe="delete">Delete room</button>
      </div>
    </div>`;
  }

  /** Screen pixels to sheet pixels. */
  get unit() {
    const w = this.svg?.getBoundingClientRect().width || 600;
    return this.view.w / w;
  }

  drawSvg() {
    const u = this.unit;
    const { selected, vertex, mode } = this.st;
    const pts = (p) => p.map((q) => q.join(',')).join(' ');
    const parts = [];
    if (this.image) parts.push(`<image href="${esc(this.image)}" x="0" y="0" width="${this.floor.w}" height="${this.floor.h}" preserveAspectRatio="none"/>`);
    else parts.push(`<rect class="pe-sheet" x="0" y="0" width="${this.floor.w}" height="${this.floor.h}"/>`);
    for (const r of this.floor.rooms) {
      const on = r.id === selected;
      parts.push(`<polygon class="pe-room-shape${on ? ' on' : ''}${r.fixed ? ' fixed' : ''}${r.outdoor ? ' outdoor' : ''}" points="${pts(r.points)}"/>`);
    }
    for (const r of this.floor.rooms) {
      const [lx, ly] = roomLabelPoint(r);
      parts.push(`<text class="pe-name${r.id === selected ? ' on' : ''}" x="${lx}" y="${ly}" font-size="${(13 * u).toFixed(1)}">${esc(r.name)}</text>`);
    }
    const room = this.room;
    if (room && mode === 'select') {
      const n = room.points.length;
      room.points.forEach((p, i) => {
        const q = room.points[(i + 1) % n];
        parts.push(`<circle class="pe-mid" data-h="m" data-i="${i}" cx="${(p[0] + q[0]) / 2}" cy="${(p[1] + q[1]) / 2}" r="${(HANDLE_PX * 0.6 * u).toFixed(1)}"/>`);
      });
      room.points.forEach((p, i) => {
        parts.push(`<circle class="pe-vertex${vertex === i ? ' on' : ''}" data-h="v" data-i="${i}" cx="${p[0]}" cy="${p[1]}" r="${(HANDLE_PX * u).toFixed(1)}"/>`);
      });
      const [lx, ly] = roomLabelPoint(room);
      parts.push(`<rect class="pe-label-handle" data-h="label" x="${lx - 9 * u}" y="${ly + 6 * u}" width="${18 * u}" height="${8 * u}" rx="${4 * u}"><title>Drag to move the name</title></rect>`);
    }
    if (this.drag?.kind === 'rect') {
      const [a, b] = [this.drag.start, this.drag.cur];
      parts.push(`<rect class="pe-draft-shape" x="${Math.min(a[0], b[0])}" y="${Math.min(a[1], b[1])}" width="${Math.abs(a[0] - b[0])}" height="${Math.abs(a[1] - b[1])}"/>`);
    }
    if (this.draft?.length) {
      const line = this.hover ? [...this.draft, this.hover] : this.draft;
      parts.push(`<polyline class="pe-draft-shape" points="${pts(line)}"/>`);
      this.draft.forEach((p, i) => parts.push(`<circle class="pe-vertex${i === 0 ? ' first' : ''}" cx="${p[0]}" cy="${p[1]}" r="${(HANDLE_PX * (i === 0 ? 1.2 : 0.8) * u).toFixed(1)}"/>`));
    }
    if (this.snapMark) parts.push(`<circle class="pe-snap" cx="${this.snapMark[0]}" cy="${this.snapMark[1]}" r="${(HANDLE_PX * 1.6 * u).toFixed(1)}"/>`);
    this.svg.innerHTML = parts.join('');
  }

  toSheet(e) {
    const m = this.svg.getScreenCTM();
    if (!m) return [0, 0];
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return [Math.min(this.floor.w, Math.max(0, p.x)), Math.min(this.floor.h, Math.max(0, p.y))];
  }

  /** Snap to a nearby corner of any room, else line up with one across or down. */
  snap(p, skip = null) {
    const near = SNAP_PX * this.unit;
    const corners = this.floor.rooms.flatMap((r) => r.points.filter((q, i) => !(skip && skip.room === r && skip.i === i)));
    if (this.draft) corners.push(...this.draft);
    let best = null;
    for (const q of corners) {
      const d = dist(p, q);
      if (d <= near && (!best || d < best.d)) best = { q, d };
    }
    this.snapMark = best ? best.q : null;
    if (best) return [...best.q];
    let [x, y] = p;
    let bx = near;
    let by = near;
    for (const q of corners) {
      if (Math.abs(q[0] - p[0]) < bx) { bx = Math.abs(q[0] - p[0]); x = q[0]; }
      if (Math.abs(q[1] - p[1]) < by) { by = Math.abs(q[1] - p[1]); y = q[1]; }
    }
    return [round1(x), round1(y)];
  }

  roomAt(p) {
    // The smallest room under the finger, so a room drawn inside a bigger one can still be picked.
    return this.floor.rooms.filter((r) => pointInPolygon(p, r.points))
      .sort((a, b) => polyArea(a.points) - polyArea(b.points))[0] || null;
  }

  remember() {
    this.st.undo.push(JSON.stringify(this.floor.rooms));
    if (this.st.undo.length > UNDO_MAX) this.st.undo.shift();
  }

  changed() {
    this.render();
    this.onChange();
  }

  addRoom(points) {
    this.remember();
    const n = this.floor.rooms.length + 1;
    const room = { id: newRoomId(this.floor), name: `Room ${n}`, points };
    this.floor.rooms.push(room);
    Object.assign(this.st, { selected: room.id, vertex: null, mode: 'select' });
    this.draft = null;
    this.changed();
    // Straight to naming it.
    const name = this.host.querySelector('#pe-name');
    name?.focus();
    name?.select();
  }

  wire() {
    const host = this.host;
    host.onclick = (e) => {
      const mode = e.target.closest('[data-pe-mode]');
      if (mode) {
        this.draft = null;
        this.hover = null;
        Object.assign(this.st, { mode: mode.dataset.peMode, vertex: null });
        if (mode.dataset.peMode !== 'select') this.st.selected = null;
        this.render();
        return;
      }
      const pick = e.target.closest('[data-pe-room]');
      if (pick) {
        Object.assign(this.st, { selected: pick.dataset.peRoom, vertex: null, mode: 'select' });
        this.draft = null;
        this.render();
        return;
      }
      const act = e.target.closest('[data-pe]')?.dataset.pe;
      if (!act) return;
      const room = this.room;
      if (act === 'undo' && this.st.undo.length) {
        this.floor.rooms = JSON.parse(this.st.undo.pop());
        if (!this.room) this.st.selected = null;
        this.st.vertex = null;
        this.changed();
      } else if (act === 'finish' && this.draft?.length >= 3) {
        this.addRoom(this.draft);
      } else if (act === 'unpoint') {
        this.draft?.pop();
        this.render();
      } else if (act === 'cancel') {
        this.draft = null;
        this.render();
      } else if (act === 'delete' && room) {
        this.remember();
        this.floor.rooms = this.floor.rooms.filter((r) => r !== room);
        this.st.selected = null;
        this.changed();
      } else if (act === 'unvertex' && room && this.st.vertex != null && room.points.length > 3) {
        this.remember();
        room.points.splice(this.st.vertex, 1);
        this.st.vertex = null;
        this.changed();
      } else if (act === 'label-reset' && room) {
        this.remember();
        delete room.label;
        this.changed();
      }
    };
    const form = host.querySelector('[data-pe-form]');
    if (form) {
      const room = this.room;
      const name = form.querySelector('#pe-name');
      name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); });
      name.addEventListener('change', () => {
        const v = name.value.replace(/\s+/g, ' ').trim();
        if (!v || v === room.name) {
          name.value = room.name;
          return;
        }
        this.remember();
        room.name = v;
        this.changed();
      });
      form.querySelector('#pe-area')?.addEventListener('change', (e) => {
        this.remember();
        const v = e.target.value;
        if (v) room.area = v;
        else delete room.area;
        // A room still called "Room 3" takes the area's name.
        if (/^Room \d+$/.test(room.name) && this.areas.has(v)) room.name = this.areas.get(v);
        this.changed();
      });
      for (const [id, key] of [['#pe-outdoor', 'outdoor'], ['#pe-fixed', 'fixed']]) {
        form.querySelector(id).addEventListener('change', (e) => {
          this.remember();
          if (e.target.checked) room[key] = true;
          else delete room[key];
          this.changed();
        });
      }
    }

    const svg = this.svg;
    svg.addEventListener('pointerdown', (e) => this.down(e));
    svg.addEventListener('pointermove', (e) => this.move(e));
    svg.addEventListener('pointerup', (e) => this.up(e));
    svg.addEventListener('pointercancel', () => {
      if (this.drag?.before) this.floor.rooms = JSON.parse(this.drag.before);
      this.drag = null;
      this.snapMark = null;
      this.drawSvg();
    });
    svg.addEventListener('pointerleave', () => {
      if (this.hover && !this.drag) {
        this.hover = null;
        this.snapMark = null;
        this.drawSvg();
      }
    });
  }

  down(e) {
    if (e.button > 0) return;
    const p = this.toSheet(e);
    const { mode } = this.st;
    this.svg.setPointerCapture(e.pointerId);
    if (mode === 'rect') {
      const s = this.snap(p);
      this.drag = { kind: 'rect', start: s, cur: s };
      return;
    }
    if (mode === 'shape') {
      this.drag = { kind: 'tap', at: [e.clientX, e.clientY] };
      return;
    }
    const h = e.target.closest?.('[data-h]');
    const room = this.room;
    const before = JSON.stringify(this.floor.rooms);
    if (room && h?.dataset.h === 'v') {
      this.st.vertex = Number(h.dataset.i);
      this.drag = { kind: 'vertex', room, i: this.st.vertex, before, moved: false };
      this.drawSvg();
      return;
    }
    if (room && h?.dataset.h === 'm') {
      const i = Number(h.dataset.i) + 1;
      room.points.splice(i, 0, this.snap(p));
      this.st.vertex = i;
      this.drag = { kind: 'vertex', room, i, before, moved: true };
      this.drawSvg();
      return;
    }
    if (room && h?.dataset.h === 'label') {
      this.drag = { kind: 'label', room, before, moved: false };
      return;
    }
    const hit = this.roomAt(p);
    if (!hit) {
      this.drag = null;
      if (this.st.selected) {
        Object.assign(this.st, { selected: null, vertex: null });
        this.render();
      }
      return;
    }
    const was = this.st.selected;
    Object.assign(this.st, { selected: hit.id, vertex: hit.id === was ? this.st.vertex : null });
    this.drag = { kind: 'move', room: hit, start: p, at: [e.clientX, e.clientY], orig: hit.points.map((q) => [...q]), label: hit.label && [...hit.label], before, moved: false, reselect: hit.id !== was };
    if (hit.id !== was) this.drawSvg();
  }

  move(e) {
    const p = this.toSheet(e);
    const d = this.drag;
    if (!d) {
      if (this.st.mode === 'shape' && this.draft?.length) {
        this.hover = this.snap(p);
        this.drawSvg();
      }
      return;
    }
    if (d.kind === 'rect') {
      d.cur = this.snap(p);
    } else if (d.kind === 'vertex') {
      d.room.points[d.i] = this.snap(p, { room: d.room, i: d.i });
      d.moved = true;
    } else if (d.kind === 'label') {
      d.room.label = [round1(p[0]), round1(p[1])];
      d.moved = true;
    } else if (d.kind === 'move') {
      if (!d.moved && Math.hypot(e.clientX - d.at[0], e.clientY - d.at[1]) < 5) return;
      d.moved = true;
      let dx = p[0] - d.start[0];
      let dy = p[1] - d.start[1];
      // Snap the whole room by whichever of its corners lands near another room's corner.
      const near = SNAP_PX * this.unit;
      const others = this.floor.rooms.filter((r) => r !== d.room).flatMap((r) => r.points);
      let best = null;
      for (const q of d.orig) {
        for (const o of others) {
          const g = Math.hypot(q[0] + dx - o[0], q[1] + dy - o[1]);
          if (g <= near && (!best || g < best.g)) best = { g, dx: o[0] - q[0], dy: o[1] - q[1], o };
        }
      }
      if (best) ({ dx, dy } = best);
      this.snapMark = best ? best.o : null;
      d.room.points = d.orig.map(([x, y]) => [round1(x + dx), round1(y + dy)]);
      if (d.label) d.room.label = [round1(d.label[0] + dx), round1(d.label[1] + dy)];
    } else if (d.kind === 'tap') {
      this.hover = this.snap(p);
    }
    this.drawSvg();
  }

  up(e) {
    const d = this.drag;
    this.drag = null;
    this.snapMark = null;
    if (!d) return;
    if (d.kind === 'rect') {
      const [a, b] = [d.start, d.cur];
      const u = this.unit;
      if (Math.abs(a[0] - b[0]) < 12 * u || Math.abs(a[1] - b[1]) < 12 * u) {
        this.drawSvg();
        return;
      }
      const [x1, x2] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])];
      const [y1, y2] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])];
      this.addRoom([[x1, y1], [x2, y1], [x2, y2], [x1, y2]]);
      return;
    }
    if (d.kind === 'tap') {
      if (Math.hypot(e.clientX - d.at[0], e.clientY - d.at[1]) > 10) return;
      const p = this.snap(this.toSheet(e));
      this.snapMark = null;
      this.draft ||= [];
      if (this.draft.length >= 3 && dist(p, this.draft[0]) <= SNAP_PX * 1.5 * this.unit) {
        this.addRoom(this.draft);
        return;
      }
      if (!this.draft.length || dist(p, this.draft.at(-1)) > 2 * this.unit) this.draft.push(p);
      this.hover = null;
      this.render();
      return;
    }
    if (d.moved) {
      this.st.undo.push(d.before);
      if (this.st.undo.length > UNDO_MAX) this.st.undo.shift();
      this.changed();
    } else if (d.reselect || d.kind === 'vertex') {
      this.render();
    }
  }
}

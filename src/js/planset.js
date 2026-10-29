// The floor plan: loading and saving it in Home Assistant, and setting it up in Settings
// (upload a picture, draw rooms, link areas, floors, export and import).
// Administrators save it in system data so every login sees it; other logins and older
// Home Assistant versions keep their own copy in user data.

import { icon } from './icons.js';
import { esc } from './controls.js';
import { planRooms, matchRooms, cleanLayout, PLAN_MAX_FLOORS } from './plan.js';
import { PLAN_RULES, readPlanPicture, PlanEditor, planEditState } from './planedit.js';

const PLAN_LAYOUT_KEY = 'ha-dash.floorplan';
const planImageKey = (floorId) => `ha-dash.floorplan.img.${floorId}`;
const PLAN_FILE_KIND = 'ha-dash-floorplan';

function planReadLocal(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function planWriteLocal(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch { /* full or blocked: Home Assistant still has it */ }
}

export const planStore = {
  layout: cleanLayout(planReadLocal(PLAN_LAYOUT_KEY)),
  images: new Map(),   // floor id -> picture as a data URL
  source: planReadLocal(`${PLAN_LAYOUT_KEY}.source`) || 'local', // 'system', 'user' or 'local'
  scope: '',           // where saving works: 'system', 'user', or '' until tried
  saveTimer: 0,
  message: '',         // last outcome shown in Settings
  error: false,
  busy: false,
  floorId: '',         // floor open in Settings
  floor: '',           // floor shown on Home
  client: null,
  areas: new Map(),
  onChange: () => {},  // the layout or a picture changed: redraw what shows it
};
for (const f of planStore.layout?.floors || []) {
  const cached = f.img && planReadLocal(planImageKey(f.id));
  if (cached?.rev === f.img && typeof cached.data === 'string') planStore.images.set(f.id, cached.data);
}

const validPicture = (data) => typeof data === 'string' && /^data:image\/(png|jpeg|webp|svg\+xml)[;,]/.test(data) && data.length <= PLAN_RULES.keepBytes * 1.1;

async function planGet(client, scope, key) {
  try {
    return (await client.send({ type: `frontend/get_${scope}_data`, key }))?.value ?? null;
  } catch {
    return undefined; // not supported (older Home Assistant)
  }
}

/** Save to system data when allowed, else to this login's user data. Returns where it went. */
async function planPut(key, value) {
  const client = planStore.client;
  if (!client) return 'local';
  if (planStore.scope !== 'user') {
    try {
      await client.send({ type: 'frontend/set_system_data', key, value });
      planStore.scope = 'system';
      return 'system';
    } catch (err) {
      if (!['unauthorized', 'unknown_command', 'invalid_format'].includes(err.code)) throw err;
    }
  }
  await client.send({ type: 'frontend/set_user_data', key, value });
  planStore.scope = 'user';
  return 'user';
}

function setLayout(layout, source) {
  planStore.layout = layout;
  planStore.source = source;
  planWriteLocal(PLAN_LAYOUT_KEY, layout);
  planWriteLocal(`${PLAN_LAYOUT_KEY}.source`, source);
  for (const id of [...planStore.images.keys()]) {
    if (!layout?.floors.some((f) => f.id === id && f.img)) planStore.images.delete(id);
  }
}

/** Fetch each floor's picture that this device does not have yet, from wherever it was saved. */
async function loadPlanImages(client) {
  let got = false;
  for (const f of planStore.layout?.floors || []) {
    if (!f.img || planStore.images.has(f.id)) continue;
    const cached = planReadLocal(planImageKey(f.id));
    let pic = cached?.rev === f.img ? cached : null;
    for (const scope of planStore.source === 'user' ? ['user', 'system'] : ['system', 'user']) {
      if (pic) break;
      const v = await planGet(client, scope, planImageKey(f.id));
      if (v?.rev === f.img && validPicture(v.data)) pic = v;
    }
    if (client !== planStore.client) return;
    if (pic && validPicture(pic.data)) {
      planStore.images.set(f.id, pic.data);
      planWriteLocal(planImageKey(f.id), { rev: pic.rev, data: pic.data });
      got = true;
    }
  }
  if (got) planStore.onChange();
}

function applyRemoteLayout(raw, source, client) {
  const layout = cleanLayout(raw);
  if (JSON.stringify(layout) === JSON.stringify(cleanLayout(planStore.layout))) return false;
  if (planStore.saveTimer) return false; // an edit here is about to be saved over it
  setLayout(layout, source);
  loadPlanImages(client);
  return true;
}

/** Load the plan for this login and follow changes made on other screens. */
export async function loadFloorPlan(client) {
  planStore.client = client;
  planStore.scope = '';
  const mine = await planGet(client, 'user', PLAN_LAYOUT_KEY);
  const shared = mine ? null : await planGet(client, 'system', PLAN_LAYOUT_KEY);
  if (client !== planStore.client) return;
  let changed = false;
  if (mine) changed = applyRemoteLayout(mine, 'user', client);
  else if (shared) changed = applyRemoteLayout(shared, 'system', client);
  else if (planStore.layout && planStore.source === 'local') savePlanSoon(0); // set up before connecting: share it now
  else if (planStore.layout && mine !== undefined) {
    setLayout(null, 'local'); // removed on another screen
    changed = true;
  }
  if (changed) planStore.onChange();
  loadPlanImages(client);
  for (const scope of ['user', 'system']) {
    client.subscribe({ type: `frontend/subscribe_${scope}_data`, key: PLAN_LAYOUT_KEY }, (ev) => {
      if (client !== planStore.client || !ev?.value) return;
      if (scope === 'system' && planStore.source === 'user') return; // this login has its own copy
      if (applyRemoteLayout(ev.value, scope, client)) planStore.onChange();
    }).catch(() => {});
  }
}

function savePlanSoon(delay = 700) {
  clearTimeout(planStore.saveTimer);
  planWriteLocal(PLAN_LAYOUT_KEY, planStore.layout);
  planStore.saveTimer = setTimeout(saveLayoutNow, delay);
}

async function saveLayoutNow() {
  clearTimeout(planStore.saveTimer);
  planStore.saveTimer = 0;
  const layout = cleanLayout(planStore.layout);
  planWriteLocal(PLAN_LAYOUT_KEY, layout);
  try {
    const where = await planPut(PLAN_LAYOUT_KEY, layout);
    if (where === 'system' && planStore.source === 'user') {
      // An administrator saved it for everyone: drop this login's own older copy.
      planStore.client?.send({ type: 'frontend/set_user_data', key: PLAN_LAYOUT_KEY, value: null }).catch(() => {});
    }
    if (where === 'user' && planStore.source === 'system') {
      // Not allowed to change the shared plan: this login now has its own copy, pictures included.
      for (const f of layout?.floors || []) {
        if (f.img && planStore.images.has(f.id)) await planPut(planImageKey(f.id), { rev: f.img, data: planStore.images.get(f.id) });
      }
    }
    planStore.source = where;
    planWriteLocal(`${PLAN_LAYOUT_KEY}.source`, where);
    planNote(where === 'system' ? 'Saved for everyone in Home Assistant.'
      : where === 'user' ? 'Saved for your Home Assistant login. Sign in as an administrator to share it with everyone.'
      : 'Saved on this device. Connect to Home Assistant to share it.');
  } catch (err) {
    planNote(`Could not save the floor plan: ${err.message}`, true);
  }
  planStore.onChange();
}

/**
 * Put camera markers on a floor: { camera id: [x, y] in the floor's pixels, false to take it off
 * the plan, or null to hand it back to its suggested spot }. Saved like the rest of the plan.
 */
export function setPlanCams(floorId, spots) {
  const floors = planStore.layout?.floors || [];
  const floor = floors.find((f) => f.id === floorId);
  for (const [id, at] of Object.entries(spots)) {
    for (const f of floors) if (f.cams) delete f.cams[id];
    if (floor && at != null) floor.cams = { ...(floor.cams || {}), [id]: at };
  }
  for (const f of floors) if (f.cams && !Object.keys(f.cams).length) delete f.cams;
  savePlanSoon();
}

/** Every camera back to its suggested spot. */
export function resetPlanCams() {
  for (const f of planStore.layout?.floors || []) delete f.cams;
  savePlanSoon();
}

/** Store a floor's picture; the layout then points at it by its revision. */
async function savePlanImage(floor, data) {
  const rev = Math.random().toString(36).slice(2, 10);
  planStore.images.set(floor.id, data);
  planWriteLocal(planImageKey(floor.id), { rev, data });
  if (planStore.client) await planPut(planImageKey(floor.id), { rev, data });
  floor.img = rev;
}

function planNote(message, error = false) {
  planStore.message = message;
  planStore.error = error;
  const el = document.querySelector('#plan-msg');
  if (el) {
    el.textContent = message;
    el.classList.toggle('error', error);
  }
}

function planFloorOpen() {
  const floors = planStore.layout?.floors || [];
  return floors.find((f) => f.id === planStore.floorId) || floors[0] || null;
}

function newFloorId() {
  const used = new Set((planStore.layout?.floors || []).map((f) => f.id));
  let id;
  do id = `f${Math.random().toString(36).slice(2, 6)}`; while (used.has(id));
  return id;
}

function planRulesHtml(open) {
  const types = Object.values(PLAN_RULES.types);
  return `<details class="plan-rules" ${open ? 'open' : ''}>
    <summary>What picture to use</summary>
    <ul>
      <li><strong>File type:</strong> ${types.slice(0, -1).join(', ')} or ${types.at(-1)}. Not PDF or iPhone HEIC photos; take a screenshot of those instead.</li>
      <li><strong>File size:</strong> up to ${PLAN_RULES.maxFileMB} MB. Big pictures are shrunk to ${PLAN_RULES.keepSide} pixels on the longest side.</li>
      <li><strong>Sharpness:</strong> at least ${PLAN_RULES.minSide} pixels on the longest side, so walls stay crisp on a tablet.</li>
      <li><strong>Shape:</strong> no more than ${PLAN_RULES.maxRatio} times as wide as it is tall (or tall as it is wide).</li>
      <li><strong>One floor per picture</strong>, seen from above. Add a floor for each storey.</li>
      <li><strong>Crop close to the house.</strong> Titles, notes and measurements around the edge waste space; or turn on "Crop to the rooms" after drawing them.</li>
      <li>A builder's plan, a real estate floor plan or a neat drawing all work. Dark lines on a light background look best, and are darkened to match dark mode.</li>
    </ul>
  </details>`;
}

/** The inside of Settings → Floor plan. */
export function planSettingsHtml() {
  const layout = planStore.layout;
  const title = `<h2 class="card-title">${icon('floorplan')}Floor plan</h2>`;
  const msg = `<p id="plan-msg" class="plan-msg${planStore.error ? ' error' : ''}" role="status">${esc(planStore.message)}</p>`;
  const files = `<input type="file" id="plan-file" accept="${PLAN_RULES.accept}" hidden>
    <input type="file" id="plan-import-file" accept=".json,application/json" hidden>`;
  if (!layout) {
    return `${title}
      <p class="muted panel-text">Show your home as it really is: upload a picture of your floor plan, draw the rooms over it, and link each room to a Home Assistant area. Lights glow in their rooms, and tapping a room opens its devices.${planStore.client ? ' The plan is saved in Home Assistant, so every screen in the house shows it.' : ''}</p>
      ${planRulesHtml(true)}
      <div class="form-actions">
        <button type="button" class="btn primary" data-plan-act="upload">${icon('upload')}Upload a floor plan picture</button>
        <button type="button" class="btn" data-plan-act="blank">Draw rooms without a picture</button>
        <button type="button" class="btn" data-plan-act="import">Import a floor plan file</button>
      </div>
      ${msg}${files}`;
  }
  const floor = planFloorOpen();
  const image = planStore.images.get(floor.id) || '';
  const where = planStore.source === 'system' ? 'Shared with everyone in Home Assistant.'
    : planStore.source === 'user' ? 'Saved for your Home Assistant login only.'
    : 'Saved on this device only.';
  return `${title}
    <p class="muted panel-text">Draw each room over the plan and link it to a Home Assistant area. Changes save as you go. ${where}</p>
    <div class="chips wrap plan-floor-tabs" role="tablist" aria-label="Floors">
      ${layout.floors.map((f) => `<button type="button" class="chip${f === floor ? ' on' : ''}" role="tab" aria-selected="${f === floor}" data-plan-edit-floor="${esc(f.id)}">${esc(f.name)}</button>`).join('')}
      ${layout.floors.length < PLAN_MAX_FLOORS ? `<button type="button" class="chip" data-plan-act="add-floor">${icon('plus')}Add a floor</button>` : ''}
    </div>
    <div class="form plan-floor-form">
      <label class="field"><span>Floor name</span>
        <input type="text" id="plan-floor-name" maxlength="30" autocomplete="off" value="${esc(floor.name)}">
      </label>
      <label class="field"><span>Look</span>
        <select class="select" id="plan-style">
          <option value="picture" ${floor.style === 'picture' ? 'selected' : ''} ${image ? '' : 'disabled'}>Your picture</option>
          <option value="drawn" ${floor.style === 'drawn' || !image ? 'selected' : ''}>Drawn 3D walls</option>
        </select>
      </label>
      <div class="plan-checks">
        <label class="check"><input type="checkbox" id="plan-crop" ${floor.crop ? 'checked' : ''} ${image && floor.style === 'picture' ? '' : 'disabled'}><span>Crop to the rooms</span></label>
        <label class="check"><input type="checkbox" id="plan-invert" ${floor.invert !== false ? 'checked' : ''} ${image && floor.style === 'picture' ? '' : 'disabled'}><span>Darken the picture in dark mode</span></label>
        <label class="check"><input type="checkbox" id="plan-labels" ${floor.labels !== false ? 'checked' : ''}><span>Show room names on the plan</span></label>
      </div>
      <p class="muted panel-text">Cameras sit round the outside of the house on Home; tap one to watch it. <a href="#/home?cams=edit">Move cameras on the plan</a></p>
      <div class="form-actions">
        <button type="button" class="btn" data-plan-act="upload">${icon('upload')}${image ? 'Replace picture' : floor.img ? 'Upload the picture again' : 'Add a picture'}</button>
        ${floor.img ? '<button type="button" class="btn" data-plan-act="remove-picture">Remove picture</button>' : ''}
      </div>
    </div>
    <div class="plan-editor" id="plan-editor"></div>
    ${msg}
    <div class="form-actions plan-file-actions">
      <button type="button" class="btn" data-plan-act="export">${icon('download')}Export to a file</button>
      <button type="button" class="btn" data-plan-act="import">Import a file</button>
      ${layout.floors.length > 1 ? `<button type="button" class="btn danger" data-plan-act="delete-floor">${icon('delete')}Delete ${esc(floor.name)}</button>` : ''}
      <button type="button" class="btn danger" data-plan-act="delete-all">${icon('delete')}Remove the floor plan</button>
    </div>
    <small class="muted">Export saves the plan and its pictures to a file, to keep as a backup or to load into another Home Assistant.</small>
    ${planRulesHtml(false)}
    ${files}`;
}

/** Redraw Settings → Floor plan in place (the rest of Settings is left alone). */
export function redrawPlanPanel() {
  const panel = document.querySelector('#plan-settings');
  if (!panel) return;
  panel.innerHTML = planSettingsHtml();
  wirePlanSettings();
}

/** Hook up Settings → Floor plan after it has been drawn. */
export function wirePlanSettings() {
  const panel = document.querySelector('#plan-settings');
  if (!panel) return;
  const $ = (sel) => panel.querySelector(sel);
  const floor = planFloorOpen();
  if (floor) {
    new PlanEditor($('#plan-editor'), {
      floor,
      image: planStore.images.get(floor.id) || '',
      areas: planStore.areas,
      // What "Automatic" would pick for a room: matched by name, as if no area were chosen for it.
      autoArea: (room) => {
        const rooms = planRooms(planStore.layout).map((r) => (r.id === room.id ? { ...r, area: undefined } : r));
        const id = matchRooms(rooms, planStore.areas, {}, {}).get(room.id);
        return id ? planStore.areas.get(id) : '';
      },
      onChange: () => {
        planStore.message = '';
        savePlanSoon();
      },
    });
  }
  const redraw = redrawPlanPanel;
  const changeFloor = (fn) => {
    fn(floor);
    savePlanSoon();
    redraw();
  };
  $('#plan-floor-name')?.addEventListener('change', (e) => {
    const v = e.target.value.replace(/\s+/g, ' ').trim();
    if (v) changeFloor((f) => { f.name = v; });
    else e.target.value = floor.name;
  });
  $('#plan-floor-name')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
  $('#plan-style')?.addEventListener('change', (e) => changeFloor((f) => { f.style = e.target.value; }));
  $('#plan-crop')?.addEventListener('change', (e) => changeFloor((f) => { f.crop = e.target.checked; }));
  $('#plan-invert')?.addEventListener('change', (e) => changeFloor((f) => { f.invert = e.target.checked; }));
  $('#plan-labels')?.addEventListener('change', (e) => changeFloor((f) => { f.labels = e.target.checked; }));

  const pick = $('#plan-file');
  let pickFor = 'replace';
  panel.onclick = async (e) => {
    const tab = e.target.closest('[data-plan-edit-floor]');
    if (tab) {
      planStore.floorId = tab.dataset.planEditFloor;
      redraw();
      return;
    }
    const act = e.target.closest('[data-plan-act]')?.dataset.planAct;
    if (!act || planStore.busy) return;
    if (act === 'upload') {
      pickFor = planStore.layout ? 'replace' : 'new';
      pick.value = '';
      pick.click();
    } else if (act === 'blank') {
      const id = newFloorId();
      planStore.layout = { v: 1, floors: [{ id, name: 'Ground floor', w: 1200, h: 800, style: 'drawn', img: '', crop: true, invert: true, labels: true, rooms: [] }] };
      planStore.floorId = id;
      Object.assign(planEditState, { floorId: id, mode: 'rect', selected: null, undo: [] });
      savePlanSoon(0);
      redraw();
    } else if (act === 'add-floor') {
      // A new floor starts as a blank sheet; "Add a picture" then puts its plan under it.
      const id = newFloorId();
      planStore.layout.floors.push({ id, name: `Floor ${planStore.layout.floors.length + 1}`, w: 1200, h: 800, style: 'drawn', img: '', crop: true, invert: true, labels: true, rooms: [] });
      planStore.floorId = id;
      savePlanSoon(0);
      redraw();
      planNote('Floor added. Add a picture of it, or draw its rooms straight onto the sheet.');
    } else if (act === 'remove-picture') {
      if (!confirm(`Remove the picture from ${floor.name}? The rooms you drew stay, drawn as walls.`)) return;
      floor.img = '';
      floor.style = 'drawn';
      planStore.images.delete(floor.id);
      planWriteLocal(planImageKey(floor.id), null);
      planPut(planImageKey(floor.id), null).catch(() => {});
      savePlanSoon(0);
      redraw();
    } else if (act === 'delete-floor') {
      if (!confirm(`Delete ${floor.name} and the rooms drawn on it?`)) return;
      planStore.layout.floors = planStore.layout.floors.filter((f) => f !== floor);
      if (floor.img) planPut(planImageKey(floor.id), null).catch(() => {});
      planWriteLocal(planImageKey(floor.id), null);
      planStore.floorId = '';
      savePlanSoon(0);
      redraw();
    } else if (act === 'delete-all') {
      if (!confirm('Remove the floor plan, its pictures and all the rooms drawn on it? Export it to a file first if you might want it back.')) return;
      for (const f of planStore.layout.floors) {
        planWriteLocal(planImageKey(f.id), null);
        if (f.img) planPut(planImageKey(f.id), null).catch(() => {});
      }
      setLayout(null, planStore.source);
      try { await planPut(PLAN_LAYOUT_KEY, null); } catch { /* removed here at least */ }
      planStore.message = 'Floor plan removed. Home shows your rooms as cards instead.';
      planStore.error = false;
      planStore.onChange();
      redraw();
    } else if (act === 'export') {
      exportFloorPlan();
    } else if (act === 'import') {
      $('#plan-import-file').value = '';
      $('#plan-import-file').click();
    }
  };

  pick?.addEventListener('change', async () => {
    const file = pick.files?.[0];
    if (!file) return;
    planStore.busy = true;
    planNote('Checking the picture…');
    try {
      const pic = await readPlanPicture(file);
      let target;
      if (pickFor === 'new') {
        const id = newFloorId();
        target = { id, name: 'Ground floor', w: pic.w, h: pic.h, style: 'picture', img: '', crop: false, invert: true, labels: true, rooms: [] };
        planStore.layout = { v: 1, floors: [target] };
        planStore.floorId = id;
        Object.assign(planEditState, { floorId: id, mode: 'rect', selected: null, undo: [] });
      } else {
        target = floor;
        // Rooms already drawn stretch with the new picture; their corners may need a nudge.
        const sx = pic.w / target.w;
        const sy = pic.h / target.h;
        if (target.rooms.length && (Math.abs(sx - 1) > 0.001 || Math.abs(sy - 1) > 0.001)) {
          for (const r of target.rooms) {
            r.points = r.points.map(([x, y]) => [Math.round(x * sx * 10) / 10, Math.round(y * sy * 10) / 10]);
            if (r.label) r.label = [Math.round(r.label[0] * sx * 10) / 10, Math.round(r.label[1] * sy * 10) / 10];
          }
          for (const it of target.furniture || []) it.rect = [it.rect[0] * sx, it.rect[1] * sy, it.rect[2] * sx, it.rect[3] * sy];
          delete target.box;
        }
        target.w = pic.w;
        target.h = pic.h;
        target.style = 'picture';
      }
      planNote('Saving the picture…');
      await savePlanImage(target, pic.data);
      await saveLayoutNow();
      const drawn = target.rooms.length ? 'Check the rooms still line up with it.' : 'Now pick Rectangle and drag across each room.';
      planStore.message = `${pic.note ? `${pic.note} ` : ''}${planStore.message} ${drawn}`;
    } catch (err) {
      planStore.message = err.message;
      planStore.error = true;
    } finally {
      planStore.busy = false;
    }
    redraw();
  });

  $('#plan-import-file')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (file) await importFloorPlan(file);
  });
}

async function exportFloorPlan() {
  const layout = cleanLayout(planStore.layout);
  if (!layout) return;
  const images = {};
  for (const f of layout.floors) {
    if (f.img && planStore.images.has(f.id)) images[f.id] = { rev: f.img, data: planStore.images.get(f.id) };
  }
  const blob = new Blob([JSON.stringify({ kind: PLAN_FILE_KIND, v: 1, layout, images })], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `floor-plan-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  planNote('Floor plan exported.');
}

async function importFloorPlan(file) {
  try {
    if (file.size > 30 * 1024 * 1024) throw new Error('That file is too big to be a floor plan export.');
    let raw;
    try { raw = JSON.parse(await file.text()); } catch { throw new Error('That file is not a floor plan export (it is not JSON).'); }
    const layout = cleanLayout(raw?.kind === PLAN_FILE_KIND ? raw.layout : raw);
    if (!layout) throw new Error('That file has no floor plan in it.');
    if (planStore.layout && !confirm('Replace the floor plan you have now with the one in this file?')) return;
    planStore.busy = true;
    planNote('Importing…');
    const old = planStore.layout?.floors || [];
    const pictures = [];
    for (const f of layout.floors) {
      const pic = raw?.images?.[f.id];
      if (f.img && validPicture(pic?.data)) pictures.push([f, pic.data]);
      else {
        f.img = '';
        if (f.style === 'picture') f.style = 'drawn';
      }
    }
    setLayout(layout, planStore.source);
    for (const [f, data] of pictures) await savePlanImage(f, data);
    for (const f of old) {
      if (f.img && !layout.floors.some((n) => n.id === f.id)) planPut(planImageKey(f.id), null).catch(() => {});
    }
    planStore.floorId = '';
    await saveLayoutNow();
    const rooms = planRooms(layout).length;
    planStore.message = `Imported ${layout.floors.length} ${layout.floors.length === 1 ? 'floor' : 'floors'} with ${rooms} ${rooms === 1 ? 'room' : 'rooms'}. ${planStore.message}`;
  } catch (err) {
    planStore.message = err.message;
    planStore.error = true;
  } finally {
    planStore.busy = false;
  }
  redrawPlanPanel();
}

// TV home screen extras: which room the TV is in, the doorbell pop-up's sensors, the peak / off-peak tariff,
// and Jellyfin's "continue watching" list. Drawn in main.js.

import { domainOf, isUnavailable } from './entities.js';
import { MOTION_CLASSES } from './home.js';

export const SAVER_CHOICES = [[0, 'Never'], [2, 'After 2 min'], [5, 'After 5 min'], [10, 'After 10 min'], [20, 'After 20 min']];
export const POPUP_CHOICES = [['person', 'People and the doorbell'], ['motion', 'Any motion'], ['off', 'Off']];

const slug = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * The area the TV is in. A pick (?room= in the address, or Settings) can be an area id or its name; otherwise
 * it's the area of the TV's own device in Home Assistant (the Home Assistant app on the TV, named by ?open=).
 */
export function pickRoom({ pick, areas, states, areaOf, tvDevice }) {
  if (pick) {
    if (areas.has(pick)) return pick;
    const want = slug(pick);
    for (const [id, name] of areas) if (slug(id) === want || slug(name) === want) return id;
  }
  if (tvDevice) {
    for (const id of states.keys()) {
      const obj = id.slice(id.indexOf('.') + 1);
      if (obj !== tvDevice && !obj.startsWith(`${tvDevice}_`)) continue;
      const area = areaOf(id);
      if (area) return area;
    }
  }
  return '';
}

const DOORBELL_ID = /_(person|visitor|doorbell|ding|ring|ringing)$/;

/** A sensor that should pop the camera up: people and doorbells, or (mode 'motion') any movement. */
export function popupSensor(s, mode) {
  if (mode === 'off' || isUnavailable(s)) return false;
  const d = domainOf(s.entity_id);
  if (d === 'event') return s.attributes?.device_class === 'doorbell';
  if (d !== 'binary_sensor') return false;
  if (DOORBELL_ID.test(s.entity_id) || /\b(person|visitor|doorbell)\b/i.test(s.attributes?.friendly_name || '')) return true;
  return mode === 'motion' && (MOTION_CLASSES.has(s.attributes?.device_class) || /_(motion|vehicle|animal|pet)$/.test(s.entity_id));
}

/** "Peak", "Off-peak" or "Shoulder" from a utility meter's tariff select, or '' when there isn't one. */
export function tariffNow(states) {
  for (const s of states.values()) {
    if (domainOf(s.entity_id) !== 'select' || isUnavailable(s)) continue;
    const opts = (s.attributes?.options || []).map((o) => String(o).toLowerCase());
    if (!opts.some((o) => /peak/.test(o))) continue;
    const v = String(s.state).toLowerCase();
    if (/off.?peak/.test(v)) return 'Off-peak';
    if (/peak/.test(v)) return 'Peak';
    return v.replace(/^\w/, (c) => c.toUpperCase());
  }
  return '';
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** Jellyfin's own API, with an API key (Jellyfin → Dashboard → API keys). */
export class Jellyfin {
  constructor({ url, key, user }) {
    this.url = String(url || '').replace(/\/+$/, '');
    this.key = key;
    this.user = user;
    this.uid = '';
  }

  get ok() { return !!(this.url && this.key); }

  headers() {
    return { Authorization: `MediaBrowser Client="Home dashboard", Device="TV", DeviceId="ha-dash-tv", Version="1", Token="${this.key}"` };
  }

  async req(path, opts = {}) {
    const r = await fetch(this.url + path, { ...opts, headers: this.headers() });
    if (!r.ok) throw new Error(`Jellyfin said ${r.status}`);
    return r.status === 204 ? null : r.json().catch(() => null);
  }

  async userId() {
    if (this.uid) return this.uid;
    const users = await this.req('/Users');
    const want = slug(this.user);
    const u = (want && users.find((x) => slug(x.Name) === want)) || users.find((x) => x.Policy?.IsAdministrator) || users[0];
    if (!u) throw new Error('No Jellyfin users');
    this.uid = u.Id;
    return this.uid;
  }

  image(it) {
    const at = (id, kind) => `${this.url}/Items/${id}/Images/${kind}?maxWidth=560&quality=85`;
    if (it.ImageTags?.Thumb) return at(it.Id, 'Thumb');
    if (it.ParentThumbItemId) return at(it.ParentThumbItemId, 'Thumb');
    if (it.BackdropImageTags?.length) return at(it.Id, 'Backdrop');
    if (it.ParentBackdropItemId) return at(it.ParentBackdropItemId, 'Backdrop');
    return at(it.Id, 'Primary');
  }

  /** What's part-watched, most recent first. */
  async resume(limit = 12) {
    const uid = await this.userId();
    const q = `Limit=${limit}&MediaTypes=Video&EnableImageTypes=Thumb,Backdrop,Primary&ImageTypeLimit=1&Fields=ParentId`;
    let res;
    try { res = await this.req(`/UserItems/Resume?userId=${uid}&${q}`); } catch { res = await this.req(`/Users/${uid}/Items/Resume?${q}`); }
    return (res?.Items || []).map((it) => ({
      id: it.Id,
      title: it.SeriesName || it.Name,
      sub: it.SeriesName ? `${it.ParentIndexNumber != null && it.IndexNumber != null ? `S${it.ParentIndexNumber} E${it.IndexNumber} · ` : ''}${it.Name}` : String(it.ProductionYear || ''),
      progress: Math.round(it.UserData?.PlayedPercentage || 0),
      ticks: it.UserData?.PlaybackPositionTicks || 0,
      image: this.image(it),
    }));
  }

  /**
   * Plays an item on the Jellyfin app on the TV once it shows up as a session (call after opening the app).
   * Returns false if no TV session appears in time; the app is open anyway.
   */
  async playOnTv(itemId, ticks, { since = Date.now(), wait = 15_000 } = {}) {
    const uid = await this.userId();
    const end = Date.now() + wait;
    while (Date.now() < end) {
      const sessions = await this.req(`/Sessions?controllableByUserId=${uid}`).catch(() => []);
      const tv = (sessions || [])
        .filter((s) => s.SupportsRemoteControl && /android ?tv|google ?tv/i.test(`${s.Client} ${s.DeviceName}`)
          && new Date(s.LastActivityDate).getTime() >= since - 5000)
        .sort((a, b) => String(b.LastActivityDate).localeCompare(String(a.LastActivityDate)))[0];
      if (tv) {
        await this.req(`/Sessions/${tv.Id}/Playing?playCommand=PlayNow&itemIds=${itemId}&startPositionTicks=${ticks || 0}`, { method: 'POST' });
        return true;
      }
      await sleep(1000);
    }
    return false;
  }
}

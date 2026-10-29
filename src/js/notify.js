// Recent Home Assistant notifications for Home: the ones waiting in Home Assistant's own notification
// list (persistent notifications) and the ones automations sent to phones (notify.* actions).

import { esc } from './controls.js';
import { icon } from './icons.js';
import { relativeTime } from './entities.js';

export const NOTE_KEEP = 25;           // sent notifications remembered
const NOTE_DAYS = 7;                   // and for how long

/** Markdown (as Home Assistant notifications often use) to plain text. */
export function noteText(s) {
  return String(s ?? '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]{1,3}([^*_`]+)[*_`]{1,3}/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/<[^>]+>/g, '')
    .trim();
}

/** Who a notify action went to: "Sam Pixel" for notify.mobile_app_sam_pixel, "Everyone" for notify.notify. */
function noteTarget(service, data) {
  if (service === 'send_message') {
    const ids = [].concat(data?.entity_id || []);
    return ids.length ? ids.map((id) => id.replace(/^notify\./, '')).join(', ').replace(/_/g, ' ') : '';
  }
  if (service === 'notify') return 'Everyone';
  return service.replace(/^mobile_app_/, '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** A notify.* call_service event as a remembered notification, or null for ones not worth showing. */
export function noteFromCall(event) {
  const d = event?.data || {};
  if (d.domain !== 'notify') return null;
  const sd = d.service_data || {};
  const message = noteText(sd.message);
  // Phone commands ("clear_notification", "request_location_update"…) are not notifications.
  if (!message || /^(clear_notification|request_location_update|command_\w+|remove_channel)$/.test(message)) return null;
  return {
    id: event.context?.id || `${event.time_fired}-${d.service}`,
    title: noteText(sd.title),
    message,
    to: noteTarget(d.service, sd),
    at: event.time_fired || new Date().toISOString(),
  };
}

/** Keep the newest, drop duplicates (every open screen records the same event) and old ones. */
export function noteMerge(...lists) {
  const cutoff = Date.now() - NOTE_DAYS * 86_400_000;
  const byId = new Map();
  for (const n of lists.flat()) if (n?.id && Date.parse(n.at) > cutoff) byId.set(n.id, n);
  return [...byId.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, NOTE_KEEP);
}

/** Both kinds of notification, newest first. */
export function noteItems({ persistent = [], sent = [] } = {}) {
  return [
    ...persistent.map((n) => ({ ...n, kind: 'ha' })),
    ...sent.map((n) => ({ ...n, kind: 'sent' })),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** The list of notifications (or a note that there are none), as used on Home and in the bell's popup. */
export function notesListHtml({ persistent = [], sent = [], canSeeSent = true, limit = 8 } = {}) {
  const items = noteItems({ persistent, sent }).slice(0, limit);
  const row = (n) => `<li class="note ${n.kind}">
      <span class="note-icon">${icon(n.kind === 'ha' ? 'alert' : 'bell')}</span>
      <div class="note-body">
        ${n.title ? `<strong>${esc(n.title)}</strong>` : ''}
        <p>${esc(n.message)}</p>
        <small class="muted">${esc(relativeTime(n.at))}${n.kind === 'sent' && n.to ? ` · to ${esc(n.to)}` : n.kind === 'ha' ? ' · in Home Assistant' : ''}</small>
      </div>
      ${n.kind === 'ha' ? `<button type="button" class="icon-btn note-dismiss" data-note-dismiss="${esc(n.id)}" aria-label="Dismiss">${icon('close')}</button>` : ''}
    </li>`;
  return items.length ? `<ul class="notes">${items.map(row).join('')}</ul>`
    : `<p class="muted notes-empty">No notifications in the last week.${canSeeSent ? '' : ' Notifications sent to phones show here for administrator logins.'}</p>`;
}

export function notesHtml(opts = {}) {
  return `<section class="notes-wrap">
    <h2 class="section-title">Notifications</h2>
    <div class="notes-card">${notesListHtml(opts)}</div>
  </section>`;
}

/**
 * A soft bell "ding", made with Web Audio so there is no sound file to upload.
 * Safari (and the Home Assistant app on iPad and iPhone) only lets a page make sound after it has
 * been tapped, so the sound is switched on by the first tap anywhere; until then play() returns false.
 */
export class Ding {
  constructor() {
    this.ctx = null;
    this.AC = window.AudioContext || window.webkitAudioContext;
    // Leave navigator.audioSession alone: 'playback' would stop the voice assistant's microphone on iPad.
    const unlock = () => this.unlock();
    for (const ev of ['pointerdown', 'touchend', 'keydown']) document.addEventListener(ev, unlock, { capture: true, passive: true });
  }

  get supported() { return !!this.AC; }
  get ready() { return this.ctx?.state === 'running'; }

  /** Call from a tap: creates or wakes the audio (Safari suspends it again when the page is hidden). */
  unlock() {
    if (!this.AC || this.ready) return;
    try {
      if (!this.ctx) this.ctx = new this.AC();
      // A silent blip inside the tap is what actually unlocks iOS.
      const buf = this.ctx.createBuffer(1, 1, 22050);
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.ctx.destination);
      src.start(0);
      this.ctx.resume?.().catch(() => {});
    } catch { /* ignore */ }
  }

  /** Ring once. Returns false when the browser has not allowed sound yet. */
  play(volume = 0.5) {
    if (!this.ready) return false;
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.02;
    const out = ctx.createGain();
    out.gain.value = volume;
    out.connect(ctx.destination);
    // A struck bell: a fundamental and a few inharmonic partials that die away at different rates.
    for (const [ratio, gain, decay] of [[1, 0.6, 1.6], [2.0, 0.22, 0.9], [2.76, 0.14, 0.6], [5.4, 0.05, 0.25]]) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 1046.5 * ratio; // C6
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
      osc.connect(g).connect(out);
      osc.start(t);
      osc.stop(t + decay + 0.05);
    }
    return true;
  }
}

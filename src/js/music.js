// Music on Today: Spotify (or anything Home Assistant can play) on the house's speakers and on this
// screen itself.
//
// Best with Music Assistant: it signs in to Spotify, plays to the Nest hubs and TVs, and this page can
// be one of its speakers (a Sendspin player, the same web player Music Assistant's own app uses), so a
// wall iPad plays music from the page with no other app. Without Music Assistant the card drives Home
// Assistant's Spotify integration (Spotify Connect speakers), or else whatever speaker is playing.
// HTML builders plus the on-screen player; main.js wires the taps.

import { icon } from './icons.js';
import { esc } from './controls.js';
import { nameOf, isUnavailable } from './entities.js';

// media_player supported_features bits
const MF = { PAUSE: 1, VOLUME_SET: 4, PREVIOUS: 16, NEXT: 32, PLAY_MEDIA: 512, PLAY: 16384 };
const mpHas = (s, f) => (Number(s?.attributes?.supported_features) & f) === f;

const isMassPlayer = (s, platform) => platform === 'music_assistant' || s.attributes?.mass_player_type != null;
const isSpotifyAccount = (s, platform) => platform === 'spotify' || /^media_player\.spotify(_|$)/.test(s.entity_id);
// Browsers and apps that register themselves as players are never speakers.
const NOT_A_SPEAKER = /\b(chrome|chromium|edge|firefox|safari|browser|seerr)\b/i;

/**
 * The players the card offers, as { kind: 'mass'|'spotify'|'plain', speakers, account }.
 * `ok(id)` says whether the dashboard lists that entity, `platform(id)` names its integration,
 * `hidden` holds the ones turned off in Settings.
 */
export function musicPlayers(states, { ok = () => true, platform = () => '', hidden = {} } = {}) {
  const all = [...states.values()].filter((s) => s.entity_id.startsWith('media_player.') && !hidden[s.entity_id]);
  const pf = (s) => platform(s.entity_id);
  // Music Assistant's players are listed whether or not they're exposed to Assist: they're the speakers.
  const mass = all.filter((s) => isMassPlayer(s, pf(s)) && !isUnavailable(s));
  if (mass.length) return { kind: 'mass', speakers: mass, account: null };
  const account = all.find((s) => isSpotifyAccount(s, pf(s)) && s.state !== 'unavailable') || null;
  if (account) return { kind: 'spotify', speakers: [], account };
  const speakers = all.filter((s) => !isUnavailable(s) && ok(s.entity_id)
    && (mpHas(s, MF.PAUSE) || mpHas(s, MF.PLAY) || mpHas(s, MF.VOLUME_SET)) && !NOT_A_SPEAKER.test(nameOf(s)));
  return { kind: 'plain', speakers, account: null };
}

/** Which player the card shows: Spotify's account, else the one picked here, else whatever is playing. */
export function musicMain(players, picked = '', hereId = '') {
  if (players.account) return players.account;
  const sp = players.speakers;
  return sp.find((s) => s.entity_id === picked)
    || sp.find((s) => s.state === 'playing')
    || sp.find((s) => s.state === 'paused')
    || sp.find((s) => s.entity_id === hereId)
    || sp[0] || null;
}

/** This screen's own Music Assistant player in Home Assistant, found by the name it registered with. */
export function musicHereEntity(players, name) {
  if (!name) return null;
  const n = name.trim().toLowerCase();
  return players.speakers.find((s) => nameOf(s).trim().toLowerCase() === n) || null;
}

/** Time into the track now, in seconds, from Home Assistant's last report. */
function musicPosition(s, now = Date.now()) {
  const a = s?.attributes || {};
  const pos = Number(a.media_position);
  if (!Number.isFinite(pos)) return null;
  const at = Date.parse(a.media_position_updated_at || '');
  const run = s.state === 'playing' && Number.isFinite(at) ? Math.max(0, (now - at) / 1000) : 0;
  const dur = Number(a.media_duration);
  return Number.isFinite(dur) && dur > 0 ? Math.min(dur, pos + run) : pos + run;
}

/**
 * The card. opts: lists (playlists [{ title, thumb, id, type }] or null), art(url) for a full address,
 * here ({ on, entity, needsTap, status, pin }) for this screen's own player.
 */
export function musicCardHtml(players, main, { lists = null, art = (u) => u, here = null, hereLabel = 'This screen' } = {}) {
  const hereOn = here?.on;
  if (!main && !hereOn) return '';
  const { kind } = players;
  const a = main?.attributes || {};
  const live = main && ['playing', 'paused', 'buffering'].includes(main.state) && a.media_title;
  const playing = main && (main.state === 'playing' || main.state === 'buffering');
  const isHere = main && here?.entity && main.entity_id === here.entity.entity_id;
  const where = !main ? hereLabel : kind === 'spotify' ? a.source || '' : isHere ? hereLabel : nameOf(main);
  const pic = live && (a.entity_picture_local || a.entity_picture);
  const sub = [a.media_artist || a.media_album_artist || (a.app_name && a.app_name !== a.media_title ? a.app_name : ''), a.media_album_name]
    .filter(Boolean).join(' · ');
  const dur = Number(a.media_duration);
  const bar = live && Number.isFinite(dur) && dur > 0 && a.media_position != null
    ? '<div class="music-bar" data-music-bar><i></i></div>' : ''; // painted by paintMusicBar, so position ticks don't change the HTML

  const ctlBtn = (act, ic, label, extra = '') =>
    `<button type="button" class="icon-btn music-btn${extra}" data-act="${act}" aria-label="${esc(label)}">${icon(ic)}</button>`;
  const controls = main ? `<div class="music-ctl">
    ${mpHas(main, MF.PREVIOUS) ? ctlBtn('media_previous_track', 'skipPrev', 'Previous') : ''}
    ${ctlBtn('media_play_pause', playing ? 'pause' : 'play', playing ? 'Pause' : 'Play', ' big')}
    ${mpHas(main, MF.NEXT) ? ctlBtn('media_next_track', 'skipNext', 'Next') : ''}
  </div>` : '';

  const volPct = Math.round(Number(a.volume_level) * 100);
  const vol = main && a.volume_level != null && mpHas(main, MF.VOLUME_SET)
    ? `<label class="slide music-vol"><span class="slide-head"><span>Volume</span><output>${volPct}%</output></span>
        <input type="range" data-slide="volume" min="0" max="100" step="1" value="${volPct}" aria-label="Volume"></label>` : '';

  // Speakers: Spotify Connect devices for the Spotify account, otherwise the players themselves.
  let chips = '';
  if (kind === 'spotify') {
    const list = Array.isArray(a.source_list) ? a.source_list : [];
    chips = list.map((name) => `<button type="button" class="chip${name === a.source ? ' on' : ''}" data-music-source="${esc(name)}">${icon('speaker')}${esc(name)}</button>`).join('');
  } else if (players.speakers.length > 1 || (hereOn && !here.entity)) {
    chips = players.speakers.map((s) => {
      const mine = here?.entity?.entity_id === s.entity_id;
      return `<button type="button" class="chip${s === main ? ' on' : ''}" data-music-pick="${esc(s.entity_id)}">${icon(s.state === 'playing' ? 'play' : mine ? 'tablet' : 'speaker')}${esc(mine ? hereLabel : nameOf(s))}</button>`;
    }).join('');
  }

  const canLists = main && kind !== 'plain' && mpHas(main, MF.PLAY_MEDIA);
  const listsHtml = canLists && lists?.length
    ? `<div class="music-lists">${lists.map((l, i) => `<button type="button" class="music-list" data-music-play="${i}" aria-label="Play ${esc(l.title)}">
          <span class="music-list-art">${l.thumb ? `<img src="${esc(art(l.thumb))}" alt="" loading="lazy">` : icon('music')}</span><span class="music-list-name">${esc(l.title)}</span></button>`).join('')}</div>`
    : '';

  // This screen's own player: one tap lets it make sound (an iPad rule), and Music Assistant may ask for a PIN.
  let hereNote = '';
  if (hereOn) {
    if (here.pin) hereNote = `<p class="music-here-note">${icon('tablet')}<span>To add ${esc(hereLabel.replace(/^This/, 'this'))} as a speaker, enter <b>${esc(here.pin)}</b> in Music Assistant.</span></p>`;
    else if (here.status === 'error') hereNote = `<p class="music-here-note warn">${icon('alert')}<span>${esc(here.error || "Can't reach Music Assistant.")}</span></p>`;
    else if (here.status === 'waiting') hereNote = `<p class="music-here-note">${icon('tablet')}<span>In Music Assistant, open <b>Settings → Players</b> and add <b>${esc(here.name)}</b> (Connect unpaired).</span></p>`;
    else if (here.needsTap) hereNote = `<button type="button" class="btn primary music-here-tap" data-music-unlock>${icon('volumeHigh')}<span>Tap to play on ${esc(hereLabel.replace(/^This/, 'this'))}</span></button>`;
  }

  const hint = kind === 'plain' && !live
    ? '<p class="muted quiet music-hint">Add Music Assistant to Home Assistant to play Spotify playlists here and on your speakers.</p>' : '';

  return `<section class="card music-card${playing ? ' playing' : ''}"${main ? ` data-entity="${esc(main.entity_id)}"` : ''}>
    <h2 class="card-title">${icon('music')}Music${where ? `<span class="music-where">${icon(isHere ? 'tablet' : 'speaker')}${esc(where)}</span>` : ''}</h2>
    <div class="music-now">
      <span class="music-art">${pic ? `<img src="${esc(art(pic))}" alt="">` : icon('music')}</span>
      <span class="music-text">
        <b>${esc(live ? a.media_title : main?.state === 'off' ? 'Off' : 'Nothing playing')}</b>
        ${live && sub ? `<span class="muted">${esc(sub)}</span>` : !live && canLists ? '<span class="muted">Pick a playlist below</span>' : ''}
        ${bar}
      </span>
    </div>
    ${controls}
    ${hereNote}
    ${vol}
    ${chips ? `<div class="chips music-speakers" aria-label="Speakers">${chips}</div>` : ''}
    ${listsHtml}
    ${hint}
  </section>`;
}

/** Playlists from Home Assistant's media browser: the root, then its "Playlists" folder. */
export async function loadPlaylists(client, entityId, limit = 12) {
  const browse = (extra = {}) => client.send({ type: 'media_player/browse_media', entity_id: entityId, ...extra });
  const root = await browse();
  const kids = root?.children || [];
  const folder = kids.find((c) => c.can_expand && /playlist/i.test(`${c.title} ${c.media_content_id} ${c.media_content_type}`));
  const page = folder ? await browse({ media_content_id: folder.media_content_id, media_content_type: folder.media_content_type }) : root;
  return (page?.children || []).filter((c) => c.can_play).slice(0, limit)
    .map((c) => ({ title: c.title, thumb: c.thumbnail || '', id: c.media_content_id, type: c.media_content_type }));
}

/** Keep the progress bar moving between Home Assistant's updates. */
export function paintMusicBar(root, s) {
  const el = root.querySelector('[data-music-bar]');
  const a = s?.attributes || {};
  const dur = Number(a.media_duration);
  if (!el || !(dur > 0)) return;
  const playing = s.state === 'playing' || s.state === 'buffering';
  const key = `${a.media_position}|${a.media_position_updated_at}|${dur}|${playing}`;
  if (el.dataset.key === key) return; // already running from this report
  el.dataset.key = key;
  const i = el.querySelector('i');
  const pos = musicPosition({ state: playing ? 'playing' : 'paused', attributes: a }) ?? 0;
  i.style.transition = 'none';
  i.style.width = `${Math.min(100, (pos / dur) * 100).toFixed(2)}%`;
  if (!playing) return;
  void i.offsetWidth; // apply the start before animating to the end
  i.style.transition = `width ${Math.max(0, dur - pos).toFixed(1)}s linear`;
  i.style.width = '100%';
}

// ---------- this screen as a speaker ----------

// Music Assistant's web player library (Sendspin). 5.0.0 is what Music Assistant 2.10's own web app uses.
export const SENDSPIN_JS = 'https://cdn.jsdelivr.net/npm/@sendspin/sendspin-js@5.0.0/+esm';

/** Where Music Assistant listens for players: the Home Assistant host, port 8927. */
export function musicServerUrl(pref, haUrl) {
  if (pref) return /^\w+:\/\//.test(pref) ? pref : `http://${pref}`;
  const u = new URL(haUrl || location.href);
  return `http://${u.hostname}:8927`;
}

const SPEAKER_STORAGE = {
  getItem: (k) => { try { return localStorage.getItem(`ha-dash2.speaker.${k}`); } catch { return null; } },
  setItem: (k, v) => { try { localStorage.setItem(`ha-dash2.speaker.${k}`, v); } catch { /* private mode */ } },
};

/**
 * This page as a Music Assistant speaker. `onChange` runs whenever its state changes.
 * status: 'off' | 'loading' | 'waiting' (connected, not yet added in Music Assistant) | 'ready' | 'error'
 */
export class ScreenSpeaker {
  constructor(onChange) {
    this.onChange = onChange;
    this.player = null;
    this.status = 'off';
    this.error = '';
    this.pin = '';
    this.name = '';
    this.playing = false;
    this.key = '';
    this._unlockOnce = (e) => this.unlock(e);
  }

  /** Start (or restart, when the address or name changed) the player. */
  async start({ url, name, lib = SENDSPIN_JS }) {
    const key = `${url}|${name}`;
    if (this.player && key === this.key) return;
    this.stop();
    this.key = key;
    this.name = name;
    this._set({ status: 'loading', error: '' });
    let mod;
    try {
      mod = await import(lib);
    } catch {
      this._set({ status: 'error', error: "Couldn't load Music Assistant's player. Check the internet connection." });
      return;
    }
    if (this.key !== key) return;
    const player = new mod.SendspinPlayer({
      baseUrl: url,
      clientName: name,
      // Its own identity: Music Assistant's web app (same site when opened through Home Assistant) keeps one
      // under the library's default keys, and two players sharing one id keep pushing each other off.
      storage: SPEAKER_STORAGE,
      productName: 'Home dashboard',
      codecs: ['pcm', 'opus'], // plain PCM first: nothing to decode on an old iPad, and fine on home Wi-Fi
      correctionMode: 'quality-local',
      onStateChange: (st) => { this._set({ playing: !!st.isPlaying }); this._check(); },
      onPairingPin: (pin) => this._set({ pin: pin || '' }),
      reconnect: {
        maxDelayMs: 30_000,
        onReconnecting: () => { this.connected = false; this._check(); },
        onReconnected: () => { this.connected = true; if (this.status === 'error') this.status = 'loading'; this._check(); },
      },
    });
    this.player = player;
    // Any touch on the page lets it make sound (iPads need a tap before audio can start).
    document.addEventListener('click', this._unlockOnce, true);
    document.addEventListener('touchend', this._unlockOnce, true);
    // Music Assistant gives the player its roles once it has been added there as a speaker.
    clearInterval(this.timer);
    this.timer = setInterval(() => this._check(), 2000);
    try {
      await player.connect();
      this.connected = this.player === player;
      this._check();
    } catch {
      if (this.player === player) this._set({ status: 'error', error: `Can't reach Music Assistant at ${url}.` });
    }
  }

  /** Connected and added in Music Assistant ('ready'), or connected and waiting to be added. */
  _check() {
    const p = this.player;
    if (!p || this.status === 'error') return;
    const roles = p.core?.protocolHandler?.activeRoles;
    if (roles && [...roles].some((r) => r.startsWith('player'))) this._set({ status: 'ready', pin: '' });
    else if (this.connected) this._set({ status: 'waiting' });
    else if (this.status !== 'loading') this._set({ status: 'loading' });
  }

  stop() {
    clearInterval(this.timer);
    document.removeEventListener('click', this._unlockOnce, true);
    document.removeEventListener('touchend', this._unlockOnce, true);
    try { this.player?.disconnect('user_request'); } catch { /* already gone */ }
    this.player = null;
    this.key = '';
    this.connected = false;
    this._set({ status: 'off', playing: false, pin: '', error: '' });
  }

  /** True while the browser still needs a tap before this screen can make sound. */
  get needsTap() {
    const sc = this.player?.scheduler;
    if (!this.player) return false;
    if (!sc?.audioContext || sc.audioContext.state !== 'running') return true;
    return !!(sc.audioElement && sc.audioElement.paused && this.playing);
  }

  /** Call straight from a tap: wakes the audio before anything else is awaited. */
  unlock() {
    const p = this.player;
    if (!p) return;
    const before = this.needsTap;
    try {
      p.unlock().then(() => this.onChange?.(), () => {});
      // Audio that started before the first tap left its <audio> element paused; start it in the gesture.
      const el = p.scheduler?.audioElement;
      if (el?.paused && (el.srcObject || el.src)) el.play().catch(() => {});
    } catch { /* not ready */ }
    if (before) setTimeout(() => this.onChange?.(), 300);
  }

  _set(patch) {
    const before = `${this.status}|${this.pin}|${this.playing}|${this.error}`;
    Object.assign(this, patch);
    if (`${this.status}|${this.pin}|${this.playing}|${this.error}` !== before) this.onChange?.();
  }
}

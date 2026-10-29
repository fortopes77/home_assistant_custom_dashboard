// Wall mode for an always-on tablet: a clock screen after a spell without touches, software
// dimming (more at night), keeping the screen awake, and full screen.

export const IDLE_CHOICES = [[0, 'Never'], [1, '1 min'], [2, '2 min'], [5, '5 min'], [10, '10 min']];
export const DIM_CHOICES = [[0, 'Off'], [0.35, 'Low'], [0.55, 'Medium'], [0.75, 'High']];

export class Wall {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.overlay  The clock screen element.
   * @param {HTMLElement} opts.dimmer   Full-screen black layer used for dimming.
   * @param {() => object} opts.prefs   Returns { wall, idleMinutes, dim, dimNight, keepAwake }.
   * @param {() => boolean} opts.isNight
   * @param {() => void} opts.onIdle    Called as the clock screen appears (e.g. go back to Home).
   * @param {() => void} opts.onWake    Called when a touch dismisses it.
   * @param {() => void} opts.paint     Fills in the clock screen's content.
   */
  constructor(opts) {
    Object.assign(this, opts);
    this.idle = false;
    this.lastActivity = Date.now();
    this.wakeLock = null;
    this.wakeLockError = '';
    this.shiftTimer = null;

    const activity = () => { this.lastActivity = Date.now(); };
    for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
      document.addEventListener(ev, activity, { capture: true, passive: true });
    }
    // The touch that wakes the screen should not also press whatever is underneath.
    this.overlay.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.wake();
    });
    document.addEventListener('keydown', () => this.idle && this.wake(), true);
    document.addEventListener('visibilitychange', () => this.applyWakeLock());
    setInterval(() => this.check(), 5000);
  }

  get enabled() {
    return !!this.prefs().wall;
  }

  /** Re-read the settings: call after they change. */
  update() {
    if (!this.enabled && this.idle) this.wake();
    document.documentElement.classList.toggle('wall', this.enabled);
    this.applyDim();
    this.applyWakeLock();
  }

  check() {
    const { idleMinutes } = this.prefs();
    if (this.idle) {
      this.paint();
      this.applyDim();
      return;
    }
    if (!this.enabled || !idleMinutes || document.hidden) return;
    if (Date.now() - this.lastActivity >= idleMinutes * 60_000) this.sleep();
  }

  sleep() {
    if (this.idle) return;
    this.idle = true;
    this.onIdle?.();
    this.paint();
    this.overlay.hidden = false;
    document.documentElement.classList.add('is-idle');
    this.shift();
    this.shiftTimer = setInterval(() => this.shift(), 60_000);
    this.applyDim();
  }

  wake() {
    if (!this.idle) return;
    this.idle = false;
    this.lastActivity = Date.now();
    this.overlay.hidden = true;
    document.documentElement.classList.remove('is-idle');
    clearInterval(this.shiftTimer);
    this.applyDim();
    this.onWake?.();
  }

  // Nudge the clock a little each minute so nothing sits in one spot all night.
  shift() {
    const x = (Math.random() - 0.5) * 8;
    const y = (Math.random() - 0.5) * 8;
    this.overlay.style.setProperty('--shift', `translate(${x.toFixed(1)}vw, ${y.toFixed(1)}vh)`);
  }

  applyDim() {
    const { dim = 0, dimNight } = this.prefs();
    let level = this.idle ? dim : 0;
    if (this.idle && dimNight && this.isNight()) level = Math.min(0.8, Math.max(level, 0.5) + 0.2);
    this.dimmer.style.opacity = String(level);
  }

  async applyWakeLock() {
    const want = this.enabled && this.prefs().keepAwake && document.visibilityState === 'visible';
    if (!want) {
      this.wakeLock?.release().catch(() => {});
      this.wakeLock = null;
      return;
    }
    if (this.wakeLock || !('wakeLock' in navigator)) {
      if (!('wakeLock' in navigator)) {
        this.wakeLockError = window.isSecureContext
          ? 'This browser cannot keep the screen on.'
          : 'Keeping the screen on needs the https address of Home Assistant.';
      }
      return;
    }
    try {
      const lock = await navigator.wakeLock.request('screen');
      this.wakeLock = lock;
      this.wakeLockError = '';
      lock.addEventListener('release', () => {
        if (this.wakeLock === lock) this.wakeLock = null;
      });
    } catch (err) {
      this.wakeLockError = err.message || 'The browser refused to keep the screen on.';
    }
  }

  static get canFullscreen() {
    const el = document.documentElement;
    return !!(el.requestFullscreen || el.webkitRequestFullscreen);
  }

  static toggleFullscreen() {
    const el = document.documentElement;
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    } else {
      (el.requestFullscreen || el.webkitRequestFullscreen).call(el)?.catch?.(() => {});
    }
  }
}

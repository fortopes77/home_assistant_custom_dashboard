// Live sky background, drawn on one canvas behind the page.
// The gradient follows the sun (elevation, and whether it is rising or setting) and the weather
// entity adds clouds, rain, snow, hail, fog and lightning. Colours ease towards their targets, so
// the sky drifts continuously through the day instead of jumping between fixed looks.

const skyClamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const skyLerp = (a, b, t) => a + (b - a) * t;
const skyHex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const skyMix = (c1, c2, t) => c1.map((v, i) => skyLerp(v, c2[i], t));
const skyRgb = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const skyLum = (c) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;

// [sun elevation in degrees, [top, middle, horizon]]. Mornings run cool (rose, peach, gold);
// evenings run hot (tangerine, crimson, violet).
const NIGHT = ['#03071a', '#081130', '#111b40'];
const DAY_HIGH = ['#1c6ad8', '#4896ee', '#a2cfff'];
const RISING = [
  [-18, NIGHT],
  [-11, ['#0a1232', '#1a2453', '#36386a']],
  [-6, ['#18275a', '#4f4f8e', '#b98196']],
  [-2, ['#2f4b8a', '#a98bb4', '#ffb592']],
  [2, ['#4673bd', '#e9b4a8', '#ffd98f']],
  [8, ['#3b84dc', '#97c2ef', '#ffe7bf']],
  [20, ['#2479e2', '#5ca7f3', '#b5dcff']],
  [55, DAY_HIGH],
].map(([e, c]) => [e, c.map(skyHex)]);
const SETTING = [
  [-18, NIGHT],
  [-11, ['#0b0d2e', '#24194d', '#432657']],
  [-6, ['#191a4d', '#5c2b69', '#c24a4d']],
  [-2, ['#29296a', '#b0426a', '#ff7430']],
  [2, ['#36559f', '#e2735a', '#ffad42']],
  [8, ['#3679cf', '#93b6e4', '#ffcf8f']],
  [20, ['#2479e2', '#5ca7f3', '#b5dcff']],
  [55, DAY_HIGH],
].map(([e, c]) => [e, c.map(skyHex)]);

// How each weather condition changes the sky. grey: how far colours fade to an overcast grey.
const WEATHER_FX = {
  sunny: {}, 'clear-night': {},
  partlycloudy: { cloud: 0.4 },
  cloudy: { cloud: 0.85, grey: 0.6 },
  fog: { cloud: 0.3, grey: 0.6, fog: 1, pale: 0.35 },
  rainy: { cloud: 0.9, grey: 0.7, rain: 0.5, dark: 0.15 },
  pouring: { cloud: 1, grey: 0.85, rain: 1, dark: 0.3 },
  lightning: { cloud: 1, grey: 0.8, lightning: 0.6, dark: 0.3 },
  'lightning-rainy': { cloud: 1, grey: 0.85, rain: 0.85, lightning: 1, dark: 0.4 },
  snowy: { cloud: 0.9, grey: 0.65, snow: 0.8, pale: 0.4 },
  'snowy-rainy': { cloud: 0.9, grey: 0.7, rain: 0.35, snow: 0.45, pale: 0.15 },
  hail: { cloud: 1, grey: 0.8, hail: 0.8, dark: 0.2 },
  windy: { cloud: 0.35, wind: 1 },
  'windy-variant': { cloud: 0.7, grey: 0.35, wind: 1 },
  exceptional: { cloud: 0.7, grey: 0.5 },
};

// Scenes for Settings, so every look can be seen without waiting for the weather.
// sweep: [from, to, seconds] moves the sun so sunrise visibly rises and sunset visibly sets.
export const SKY_PREVIEWS = {
  sunrise: { label: 'Sunrise', rising: true, condition: 'sunny', sweep: [-9, 6, 40] },
  day: { label: 'Clear day', elevation: 50, rising: true, condition: 'sunny' },
  partly: { label: 'Partly cloudy', elevation: 35, rising: false, condition: 'partlycloudy' },
  sunset: { label: 'Sunset', rising: false, condition: 'sunny', sweep: [6, -9, 40] },
  night: { label: 'Night', elevation: -30, rising: false, condition: 'clear-night' },
  rain: { label: 'Rain', elevation: 30, rising: true, condition: 'rainy' },
  storm: { label: 'Storm', elevation: 20, rising: false, condition: 'lightning-rainy' },
  snow: { label: 'Snow', elevation: 20, rising: true, condition: 'snowy' },
  fog: { label: 'Fog', elevation: 6, rising: true, condition: 'fog' },
  rainynight: { label: 'Rainy night', elevation: -25, rising: false, condition: 'pouring' },
};

function samplePalette(table, elevation) {
  if (elevation <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    const [e1, c1] = table[i];
    if (elevation <= e1) {
      const [e0, c0] = table[i - 1];
      const t = (elevation - e0) / (e1 - e0);
      return c0.map((c, j) => skyMix(c, c1[j], t));
    }
  }
  return table[table.length - 1][1];
}

/** Rough sun position from the clock, for when Home Assistant has no sun.sun entity. */
export function clockSun(date = new Date()) {
  const h = date.getHours() + date.getMinutes() / 60;
  return { elevation: 62 * Math.sin((Math.PI * (h - 6.5)) / 12.5) - 4, rising: h < 12.75 };
}

export class Sky {
  constructor(canvas, { onTone } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onTone = onTone;
    this.inputs = { ...clockSun(), condition: 'sunny' };
    this.preview = null;
    this.previewStart = 0;
    this.animate = true;
    this.running = false;
    this.cur = null;
    this.tone = null;
    this.night = null;
    this.t = 0;
    this.last = 0;
    this.lastDraw = 0;
    this.flash = 0;
    this.nextFlash = 3;
    this.bolt = null;
    this.cloudSprites = [];
    this.spriteColor = null;
    this.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

    this.stars = Array.from({ length: 140 }, () => ({
      x: Math.random(), y: Math.random() ** 1.4 * 0.75, r: 0.4 + Math.random() ** 3 * 1.4, p: Math.random() * 6.28,
    }));
    this.clouds = Array.from({ length: 9 }, (_, i) => ({
      x: Math.random() * 1.4 - 0.2, y: 0.04 + (i % 5) * 0.11 + Math.random() * 0.05,
      s: 0.55 + Math.random() * 0.8, v: 0.6 + Math.random() * 0.8, k: i % 4,
    }));
    this.drops = [];
    this.flakes = [];

    this._frame = (now) => this._loop(now);
    this._onResize = () => this.resize();
    this._onVisible = () => (document.hidden ? this.stop() : this.start());
  }

  start() {
    if (this.running || document.hidden) return;
    if (!this.listening) {
      this.listening = true;
      window.addEventListener('resize', this._onResize);
      document.addEventListener('visibilitychange', this._onVisible);
      this.resize();
    }
    this.running = true;
    this.last = performance.now();
    requestAnimationFrame(this._frame);
  }

  stop() {
    this.running = false;
  }

  destroy() {
    this.stop();
    this.listening = false;
    window.removeEventListener('resize', this._onResize);
    document.removeEventListener('visibilitychange', this._onVisible);
  }

  /** elevation (deg), rising (bool), condition (HA weather state), wind (km/h, optional). */
  setInputs(inputs, { instant = false } = {}) {
    this.inputs = { ...this.inputs, ...inputs };
    // The first real reading replaces the clock-based guess at once rather than fading over.
    if (instant && this.cur) this.cur.snap = 1;
  }

  setPreview(key) {
    this.preview = SKY_PREVIEWS[key] || null;
    this.previewStart = this.t;
    // Jump close to the new scene so the preview responds straight away.
    if (this.cur) this.cur.snap = 0.85;
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = window.innerWidth;
    const h = Math.max(window.innerHeight, document.documentElement.clientHeight);
    // Keep the canvas to about 1.2 million pixels; the sky is soft, so more buys little.
    const scale = Math.min(dpr, Math.sqrt(1_200_000 / (w * h)));
    this.canvas.width = Math.round(w * scale);
    this.canvas.height = Math.round(h * scale);
    this.scale = scale;
    this.w = w;
    this.h = h;
    this.lastDraw = 0;
    if (!this.running) this._loop(performance.now(), true);
  }

  /** The look the sky is easing towards. */
  _target() {
    let { elevation, rising, condition, wind } = this.inputs;
    if (this.preview) {
      ({ rising, condition } = this.preview);
      const sw = this.preview.sweep;
      if (sw) {
        const p = ((this.t - this.previewStart) / sw[2]) % 1;
        elevation = skyLerp(sw[0], sw[1], p);
      } else {
        elevation = this.preview.elevation;
      }
      wind = 0;
    }
    const fx = { cloud: 0, grey: 0, rain: 0, snow: 0, hail: 0, fog: 0, lightning: 0, wind: 0, dark: 0, pale: 0, ...WEATHER_FX[condition] };
    if (wind > 30) fx.wind = Math.max(fx.wind, skyClamp((wind - 30) / 30));

    let stops = samplePalette(rising ? RISING : SETTING, elevation);
    const daylight = skyClamp((elevation + 10) / 25);
    if (fx.grey) {
      // Fade towards a grey of the same brightness, a touch blue, darker for heavy rain.
      stops = stops.map((c) => {
        const l = skyLum(c) * 255 * (1 - fx.dark);
        return skyMix(c, [l * 0.94, l * 0.98, l * 1.06], fx.grey);
      });
    }
    if (fx.pale) stops = stops.map((c) => skyMix(c, [214, 222, 232], fx.pale * daylight));

    // Warm glow around sunrise and sunset, strongest with the sun on the horizon.
    const glow = Math.exp(-(((elevation - 0.5) / 6) ** 2)) * (1 - fx.cloud * 0.75);
    const cloudy = fx.cloud;
    return {
      stops,
      elevation,
      rising: rising ? 1 : 0,
      glow,
      sunVis: skyClamp((elevation + 5) / 4) * (1 - cloudy) ** 1.5,
      stars: skyClamp((-elevation - 5) / 8) * (1 - cloudy * 0.95),
      moon: skyClamp((-elevation - 7) / 6) * (1 - cloudy * 0.8),
      cloud: fx.cloud,
      rain: fx.rain, snow: fx.snow, hail: fx.hail, fog: fx.fog, lightning: fx.lightning, wind: fx.wind,
      daylight,
    };
  }

  _ease(target, dt) {
    if (!this.cur) {
      this.cur = target;
      return;
    }
    const c = this.cur;
    // Ease over a few seconds, faster right after a preview change.
    const k = c.snap || 1 - Math.exp(-dt / 3);
    c.snap = 0;
    for (const key of Object.keys(target)) {
      if (key === 'stops') c.stops = c.stops.map((col, i) => skyMix(col, target.stops[i], k));
      else if (key === 'rising') c.rising = target.rising;
      else c[key] = skyLerp(c[key], target[key], k);
    }
  }

  _loop(now, once = false) {
    if (!once && !this.running) return;
    const still = !this.animate || this.reducedMotion.matches;
    const busy = this.cur && (this.cur.rain > 0.05 || this.cur.snow > 0.05 || this.cur.hail > 0.05 || this.cur.lightning > 0.05);
    // 30 fps for falling rain and snow, 20 for drifting clouds, a still frame every few seconds otherwise.
    const interval = still ? 4000 : busy ? 1000 / 30 : 1000 / 20;
    if (once || now - this.lastDraw >= interval - 4) {
      const elapsed = this.lastDraw ? Math.min(0.1, (now - this.lastDraw) / 1000) : 0;
      if (!still) this.t += elapsed;
      this._ease(this._target(), still ? 10 : elapsed);
      this._draw(still ? 0 : elapsed, still);
      this.lastDraw = now;
    }
    this.last = now;
    if (!once) requestAnimationFrame(this._frame);
  }

  _draw(dt, still) {
    const { ctx, cur: c } = this;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const S = this.scale;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    // The smooth layers (gradient, glow, sun, moon) change slowly, so they are painted at half
    // size a few times a second and stretched; only the moving details are drawn every frame.
    if (!this.base || this.t - this.baseAt > 0.2 || this.t < this.baseAt || still || this.base.width !== Math.ceil(W / 2)) {
      this._drawBase(Math.ceil(W / 2), Math.ceil(H / 2), S / 2);
      this.baseAt = this.t;
    }
    ctx.drawImage(this.base, 0, 0, W, H);

    // Stars.
    if (c.stars > 0.01) {
      ctx.fillStyle = '#fff';
      for (const s of this.stars) {
        const tw = 0.55 + 0.45 * Math.sin(this.t * 1.3 + s.p * 7);
        ctx.globalAlpha = c.stars * tw * (0.5 + s.r / 3);
        ctx.beginPath();
        ctx.arc(s.x * W, s.y * H, s.r * S, 0, 6.283);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    // 5. Clouds, lit by the sky: white by day, pink at dawn and dusk, slate in the rain and at night.
    if (c.cloud > 0.02) {
      const base = skyMix([255, 255, 255], skyMix(c.stops[2], [255, 255, 255], 0.35), c.glow * 0.8);
      const dim = skyLerp(0.18, 1, Math.max(c.daylight, c.glow * 0.85)) * (1 - c.rain * 0.35 - c.lightning * 0.2);
      const col = base.map((v) => v * dim);
      this._ensureSprites(col);
      const count = Math.round(c.cloud * this.clouds.length);
      const speed = (6 + c.wind * 40) * S;
      for (let i = 0; i < this.clouds.length; i++) {
        const cl = this.clouds[i];
        cl.x += (dt * speed * cl.v) / W;
        if (cl.x > 1.25) cl.x = -0.45;
        const vis = skyClamp(c.cloud * this.clouds.length - i);
        if (i >= count + 1 || vis <= 0) continue;
        const spr = this.cloudSprites[cl.k];
        const w = W * 0.5 * cl.s;
        const h = (w * spr.height) / spr.width;
        ctx.globalAlpha = vis * skyLerp(0.75, 0.95, c.cloud);
        ctx.drawImage(spr, cl.x * W - w / 2, cl.y * H, w, h);
      }
      ctx.globalAlpha = 1;
    }

    // 6. Fog: wide pale bands rolling slowly across the lower sky.
    if (c.fog > 0.02) {
      for (let i = 0; i < 4; i++) {
        const y = H * (0.45 + i * 0.15);
        const x = W * (((this.t * (0.012 + i * 0.004) + i * 0.37) % 1.6) - 0.3);
        const fg = ctx.createRadialGradient(x, y, 0, x, y, W * 0.8);
        fg.addColorStop(0, skyRgb([235, 238, 242], 0.35 * c.fog));
        fg.addColorStop(1, skyRgb([235, 238, 242], 0));
        ctx.save();
        ctx.translate(0, y);
        ctx.scale(1, 0.3);
        ctx.translate(0, -y);
        ctx.fillStyle = fg;
        ctx.fillRect(0, y - H * 2, W, H * 4);
        ctx.restore();
      }
    }

    // 7. Rain, slanting with the wind.
    const area = (this.w * this.h) / 1800;
    this._fill(this.drops, Math.round(area * c.rain), () => ({
      x: Math.random() * 1.2 - 0.1, y: Math.random(), l: 0.5 + Math.random() * 0.8, v: 0.8 + Math.random() * 0.5,
    }));
    if (this.drops.length && c.rain > 0.01) {
      const slant = 0.12 + c.wind * 0.3;
      const night = 1 - c.daylight;
      ctx.strokeStyle = skyRgb(skyMix([210, 222, 238], [150, 170, 205], night), 0.45);
      ctx.lineWidth = 1.2 * S;
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (const d of this.drops) {
        d.y += dt * d.v * 1.6;
        d.x += dt * d.v * 1.6 * slant * (this.h / this.w);
        if (d.y > 1.05) { d.y = -0.05; d.x = Math.random() * 1.2 - 0.15; }
        const len = d.l * 26 * S;
        const x = d.x * W;
        const y = d.y * H;
        ctx.moveTo(x, y);
        ctx.lineTo(x - len * slant, y - len);
      }
      ctx.stroke();
    }

    // 8. Snow and hail.
    const flakes = Math.round(area * 0.45 * c.snow) + Math.round(area * 0.6 * c.hail);
    this._fill(this.flakes, flakes, () => ({
      x: Math.random(), y: Math.random(), r: 1 + Math.random() * 2.4, v: 0.5 + Math.random() * 0.6, p: Math.random() * 6.28,
    }));
    if (this.flakes.length) {
      const hail = c.hail > c.snow;
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath();
      for (const f of this.flakes) {
        f.y += dt * f.v * (hail ? 1.1 : 0.09);
        f.x += dt * (Math.sin(this.t * 0.9 + f.p) * (hail ? 0 : 0.012) + c.wind * 0.05);
        if (f.y > 1.03) { f.y = -0.03; f.x = Math.random(); }
        if (f.x > 1.02) f.x -= 1.04;
        const r = (hail ? f.r * 0.6 : f.r) * S;
        ctx.moveTo(f.x * W + r, f.y * H);
        ctx.arc(f.x * W, f.y * H, r, 0, 6.283);
      }
      ctx.fill();
    }

    // 9. Lightning: an occasional flicker across the whole sky, sometimes with a bolt.
    if (c.lightning > 0.3 && !still) {
      this.nextFlash -= dt;
      if (this.nextFlash <= 0) {
        this.flash = 1;
        this.nextFlash = 4 + Math.random() * 9 / c.lightning;
        this.bolt = Math.random() < 0.6 ? this._makeBolt(W, H) : null;
      }
    }
    if (this.flash > 0.01) {
      const f = this.flash * (0.6 + 0.4 * Math.sin(this.flash * 40));
      ctx.fillStyle = `rgba(225,232,255,${0.45 * f})`;
      ctx.fillRect(0, 0, W, H);
      if (this.bolt) {
        ctx.strokeStyle = `rgba(255,255,255,${f})`;
        ctx.lineWidth = 2.2 * S;
        ctx.shadowColor = 'rgba(190,210,255,0.9)';
        ctx.shadowBlur = 18 * S;
        ctx.beginPath();
        this.bolt.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.stroke();
        ctx.shadowBlur = 0;
      }
      this.flash = Math.max(0, this.flash - dt * 2.4);
    }

    this._report();
  }

  _drawBase(W, H, S) {
    if (!this.base) this.base = document.createElement('canvas');
    if (this.base.width !== W || this.base.height !== H) {
      this.base.width = W;
      this.base.height = H;
    }
    const ctx = this.base.getContext('2d');
    const c = this.cur;
    // 1. Base gradient. The middle stop breathes slowly so the sky never sits completely still.
    const breathe = Math.sin(this.t / 23) * 0.06;
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, skyRgb(c.stops[0]));
    g.addColorStop(skyClamp(0.55 + breathe, 0.3, 0.8), skyRgb(c.stops[1]));
    g.addColorStop(1, skyRgb(c.stops[2]));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // Sun position: low on the left in the morning, low on the right in the evening, high mid-sky.
    const lift = skyClamp((c.elevation + 6) / 60);
    const sunX = W * (c.rising ? skyLerp(0.18, 0.5, lift) : skyLerp(0.82, 0.5, lift));
    const sunY = H * (0.92 - lift * 0.82);

    // 2. Sunrise / sunset glow, with soft bands of light that drift up at dawn and sink at dusk.
    if (c.glow > 0.01) {
      const warm = c.rising ? [255, 196, 140] : [255, 128, 52];
      const gy = Math.max(sunY, H * 0.8);
      const rg = ctx.createRadialGradient(sunX, gy, 0, sunX, gy, Math.max(W, H) * 0.85);
      rg.addColorStop(0, skyRgb(warm, 0.75 * c.glow));
      rg.addColorStop(0.35, skyRgb(warm, 0.28 * c.glow));
      rg.addColorStop(1, skyRgb(warm, 0));
      ctx.fillStyle = rg;
      ctx.fillRect(0, 0, W, H);

      for (let i = 0; i < 3; i++) {
        const p = (this.t / 18 + i / 3) % 1;
        const by = c.rising ? H * (0.95 - p * 0.5) : H * (0.5 + p * 0.45);
        const a = Math.sin(p * Math.PI) * 0.16 * c.glow;
        const band = ctx.createRadialGradient(sunX, by, 0, sunX, by, W * 0.9);
        band.addColorStop(0, skyRgb(c.rising ? [255, 226, 180] : [255, 150, 90], a));
        band.addColorStop(1, skyRgb([255, 200, 150], 0));
        ctx.save();
        ctx.translate(0, by);
        ctx.scale(1, 0.22);
        ctx.translate(0, -by);
        ctx.fillStyle = band;
        ctx.fillRect(0, by - H * 3, W, H * 6);
        ctx.restore();
      }
    }

    // Moon.
    if (c.moon > 0.01) {
      const mx = W * 0.8;
      const my = H * 0.16;
      const mr = Math.min(W, H) * 0.035 + 10 * S;
      const mg = ctx.createRadialGradient(mx, my, mr * 0.5, mx, my, mr * 5);
      mg.addColorStop(0, skyRgb([220, 228, 255], 0.22 * c.moon));
      mg.addColorStop(1, skyRgb([220, 228, 255], 0));
      ctx.fillStyle = mg;
      ctx.fillRect(mx - mr * 5, my - mr * 5, mr * 10, mr * 10);
      ctx.globalAlpha = c.moon;
      ctx.fillStyle = '#eef1fb';
      ctx.beginPath();
      ctx.arc(mx, my, mr, 0, 6.283);
      ctx.fill();
      ctx.fillStyle = skyRgb(c.stops[0]);
      ctx.globalAlpha = c.moon * 0.92;
      ctx.beginPath();
      ctx.arc(mx + mr * 0.45, my - mr * 0.2, mr * 0.9, 0, 6.283);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // 4. Sun, yellow-white overhead and deep orange on the horizon.
    if (c.sunVis > 0.01) {
      const low = 1 - skyClamp((c.elevation + 2) / 22);
      const core = skyMix([255, 250, 228], c.rising ? [255, 196, 120] : [255, 120, 40], low);
      const r = Math.min(W, H) * 0.045 + 8 * S;
      const sg = ctx.createRadialGradient(sunX, sunY, r * 0.6, sunX, sunY, r * 7);
      sg.addColorStop(0, skyRgb(core, 0.55 * c.sunVis));
      sg.addColorStop(0.25, skyRgb(core, 0.18 * c.sunVis));
      sg.addColorStop(1, skyRgb(core, 0));
      ctx.fillStyle = sg;
      ctx.fillRect(sunX - r * 7, sunY - r * 7, r * 14, r * 14);
      ctx.globalAlpha = c.sunVis;
      ctx.fillStyle = skyRgb(core);
      ctx.beginPath();
      ctx.arc(sunX, sunY, r, 0, 6.283);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

  }

  _fill(list, n, make) {
    while (list.length < n) list.push(make());
    if (list.length > n) list.length = n;
  }

  _makeBolt(W, H) {
    const pts = [];
    let x = W * (0.2 + Math.random() * 0.6);
    let y = 0;
    while (y < H * (0.35 + Math.random() * 0.25)) {
      pts.push([x, y]);
      x += (Math.random() - 0.5) * W * 0.06;
      y += H * (0.03 + Math.random() * 0.04);
    }
    return pts;
  }

  // Cloud sprites are drawn once per colour, not every frame.
  _ensureSprites(col) {
    const key = col.map((v) => Math.round(v / 10)).join();
    if (key === this.spriteColor) return;
    this.spriteColor = key;
    const shade = col.map((v) => v * 0.78);
    this.cloudSprites = [0, 1, 2, 3].map((k) => {
      const cv = document.createElement('canvas');
      cv.width = 360;
      cv.height = 200;
      const x = cv.getContext('2d');
      const grad = x.createLinearGradient(0, 30, 0, 140);
      grad.addColorStop(0, skyRgb(col));
      grad.addColorStop(1, skyRgb(shade));
      x.fillStyle = grad;
      x.filter = 'blur(6px)';
      const puffs = [
        [[80, 100, 48], [150, 72, 62], [230, 88, 52], [290, 108, 38], [180, 112, 50]],
        [[70, 104, 40], [130, 84, 50], [200, 64, 58], [270, 92, 46], [180, 112, 52]],
        [[90, 96, 54], [170, 78, 60], [250, 102, 44], [140, 114, 46]],
        [[60, 110, 34], [120, 92, 46], [190, 80, 52], [260, 98, 44], [310, 114, 30], [190, 116, 48]],
      ][k];
      x.beginPath();
      for (const [px, py, r] of puffs) {
        x.moveTo(px + r, py);
        x.arc(px, py, r, 0, 6.283);
      }
      x.fill();
      return cv;
    });
  }

  // Tell the page whether text on the sky should be light or dark, and whether it is night.
  _report() {
    const c = this.cur;
    const l = skyLum(c.stops[0]) * 0.55 + skyLum(c.stops[1]) * 0.45 + c.fog * 0.1;
    let tone = this.tone;
    if (tone !== 'light' && l > 0.6) tone = 'light';
    else if (tone !== 'dark' && l < 0.52) tone = 'dark';
    else if (!tone) tone = l > 0.56 ? 'light' : 'dark';
    const night = c.elevation < -4;
    if (tone !== this.tone || night !== this.night) {
      this.tone = tone;
      this.night = night;
      this.onTone?.({ tone, night, top: skyRgb(c.stops[0]) });
    }
  }
}

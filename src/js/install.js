// "Install as an app": a web app manifest and icons, generated in the page so the dashboard
// still ships as one index.html. Browsers only offer to install a page served over https.

import { ICONS } from './icons.js';

const installState = { prompt: null, installed: false, listeners: new Set() };

function appIcon(size, maskable = false) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 0, size);
  g.addColorStop(0, '#2b6c74');
  g.addColorStop(0.6, '#3f8a86');
  g.addColorStop(1, '#e0912a');
  x.fillStyle = g;
  if (maskable) {
    x.fillRect(0, 0, size, size);
  } else {
    const r = size * 0.22;
    x.beginPath();
    x.roundRect ? x.roundRect(0, 0, size, size, r) : x.rect(0, 0, size, size);
    x.fill();
  }
  // The house from the favicon, centred inside the maskable safe zone.
  const s = (size * (maskable ? 0.5 : 0.62)) / 24;
  x.translate((size - 24 * s) / 2, (size - 24 * s) / 2);
  x.scale(s, s);
  x.fillStyle = '#ffffff';
  x.fill(new Path2D(ICONS.home));
  return c.toDataURL('image/png');
}

export function setupInstall() {
  const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  installState.installed = !!isStandalone;

  // Opened inside Home Assistant (an iframe), installing makes no sense.
  if (window.top === window) {
    const here = location.origin + location.pathname;
    const name = document.title || 'Home';
    const manifest = {
      name,
      short_name: name.slice(0, 12),
      id: here,
      start_url: here + location.search,
      scope: here.replace(/[^/]*$/, ''),
      display: 'standalone',
      orientation: 'any',
      background_color: '#f3f1ec',
      theme_color: '#2b6c74',
      icons: [
        { src: appIcon(192), sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: appIcon(512), sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: appIcon(512, true), sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    };
    const link = document.createElement('link');
    link.rel = 'manifest';
    link.href = `data:application/manifest+json,${encodeURIComponent(JSON.stringify(manifest))}`;
    document.head.append(link);

    const touch = document.createElement('link');
    touch.rel = 'apple-touch-icon';
    touch.href = appIcon(180, true);
    document.head.append(touch);
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installState.prompt = e;
    notifyInstall();
  });
  window.addEventListener('appinstalled', () => {
    installState.prompt = null;
    installState.installed = true;
    notifyInstall();
  });
}

function notifyInstall() {
  for (const fn of installState.listeners) fn();
}

export function onInstallChange(fn) {
  installState.listeners.add(fn);
}

/** What Settings should say about installing, and whether it can show an Install button. */
export function installInfo() {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (window.top !== window) {
    return { text: 'You are viewing this inside Home Assistant. Open the dashboard address directly in the browser to install it as an app.' };
  }
  if (installState.installed) return { text: 'Running as an installed app.' };
  if (installState.prompt) return { canInstall: true, text: 'Install the dashboard as an app with its own icon, full screen and no browser bars.' };
  if (ios) return { text: 'In Safari, tap Share and then Add to Home Screen. It opens full screen like an app.' };
  if (!window.isSecureContext) {
    return { text: 'Browsers only install apps from https addresses. Open the dashboard through your https Home Assistant address (for example Home Assistant Cloud) to install it. On http you can still use Add to Home screen in the browser menu for a shortcut.' };
  }
  return { text: 'Use Install app or Add to Home screen in the browser menu.' };
}

export async function promptInstall() {
  const p = installState.prompt;
  if (!p) return false;
  p.prompt();
  const { outcome } = await p.userChoice;
  installState.prompt = null;
  notifyInstall();
  return outcome === 'accepted';
}

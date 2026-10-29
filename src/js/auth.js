// Works out how to authenticate, in order of preference:
//  1. Embedded in Home Assistant (a "Webpage" dashboard in the app or browser):
//     reuse the logged-in session of the parent Home Assistant page. No token needed.
//  2. A long-lived access token in the address (?token=...), e.g. for casting with catt to a
//     Nest Hub, which has no keyboard to type one into Settings. It is taken out of the
//     address bar straight away and kept for this tab only (reloads keep working).
//  3. A long-lived access token saved on this device in Settings.

const SETTINGS_KEY = 'ha-dash.settings';
const URL_TOKEN_KEY = 'ha-dash.url-token';

/** Reads ?token= (or ?access_token=) once, removes it from the address, keeps it for this tab. */
function takeUrlToken() {
  let token = '';
  try {
    const params = new URLSearchParams(location.search);
    token = params.get('token') || params.get('access_token') || '';
    if (token) {
      params.delete('token');
      params.delete('access_token');
      const q = params.toString().replace(/=(?=&|$)/g, ''); // keep ?wall, not ?wall=
      history.replaceState(history.state, '', location.pathname + (q ? `?${q}` : '') + location.hash);
    }
  } catch {
    /* no history API; leave the address as it is */
  }
  try {
    if (token) sessionStorage.setItem(URL_TOKEN_KEY, token);
    else token = sessionStorage.getItem(URL_TOKEN_KEY) || '';
  } catch {
    /* storage unavailable; the token still works until the page reloads */
  }
  return token;
}
const urlToken = takeUrlToken();

export function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
  } catch {
    return {};
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* storage unavailable (private mode); settings last for this session only */
  }
}

/** Default HA address: the server this page is served from, when that is HA itself. */
export function defaultUrl() {
  return /^https?:$/.test(location.protocol) ? location.origin : '';
}

async function parentHassAuth() {
  if (window.parent === window) return null;
  try {
    // Throws for a cross-origin parent; only works when served from HA's /local/.
    const promise = window.parent.hassConnection;
    if (!promise) return null;
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 5000));
    const result = await Promise.race([promise, timeout]);
    return result?.auth || null;
  } catch {
    return null;
  }
}

/**
 * @returns {Promise<{mode: 'embedded'|'token'|'none', url: string, getToken?: () => Promise<string>}>}
 */
export async function resolveAuth() {
  const settings = loadSettings();

  if (!settings.forceToken && !urlToken) {
    const auth = await parentHassAuth();
    if (auth) {
      return {
        mode: 'embedded',
        url: location.origin, // same origin as the parent, or we could not have read it
        getToken: async () => {
          if (auth.expired) await auth.refreshAccessToken();
          return auth.accessToken;
        },
      };
    }
  }

  const url = settings.url || defaultUrl();
  if (urlToken && url) {
    return { mode: 'token', url, getToken: async () => urlToken };
  }
  if (settings.token && url) {
    return { mode: 'token', url, getToken: async () => settings.token };
  }
  return { mode: 'none', url };
}

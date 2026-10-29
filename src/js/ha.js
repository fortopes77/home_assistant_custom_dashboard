// Minimal Home Assistant WebSocket client.
// Protocol: https://developers.home-assistant.io/docs/api/websocket
//
// Events dispatched (EventTarget):
//   "status"   detail: { status, message }   status: connecting | connected | disconnected | auth_invalid
//   "ready"    detail: { states, areas, entityAreas, config }
//   "state"    detail: { entityId, newState }  (newState is null when an entity is removed)

const PING_INTERVAL = 30_000;
const PONG_TIMEOUT = 10_000;
const MAX_BACKOFF = 30_000;

export class HAClient extends EventTarget {
  /**
   * @param {object} opts
   * @param {string} opts.url       Base URL of Home Assistant, e.g. http://homeassistant.local:8123
   * @param {() => Promise<string>} opts.getToken  Returns a valid access token.
   */
  constructor({ url, getToken }) {
    super();
    this.url = url.replace(/\/+$/, '');
    this.getToken = getToken;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.eventHandlers = new Map();
    this.status = 'idle';
    this.retries = 0;
    this.stopped = false;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.haVersion = null;

    this._onVisible = () => {
      if (document.visibilityState === 'visible') this._reconnectNowIfDown();
    };
    this._onOnline = () => this._reconnectNowIfDown();
    document.addEventListener('visibilitychange', this._onVisible);
    window.addEventListener('online', this._onOnline);
  }

  get wsUrl() {
    return this.url.replace(/^http/i, 'ws') + '/api/websocket';
  }

  async connect() {
    this.stopped = false;
    clearTimeout(this.reconnectTimer);
    this._setStatus('connecting');

    let token;
    try {
      token = await this.getToken();
    } catch (err) {
      this._setStatus('auth_invalid', err.message || 'Could not get an access token');
      return;
    }
    if (!token) {
      this._setStatus('auth_invalid', 'No access token set');
      return;
    }

    let ws;
    try {
      ws = new WebSocket(this.wsUrl);
    } catch (err) {
      this._setStatus('disconnected', err.message);
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      // HA may batch several messages into one frame (coalesce_messages).
      for (const m of Array.isArray(msg) ? msg : [msg]) this._handle(ws, m, token);
    };
    ws.onclose = () => this._onClose(ws);
  }

  /** Stop and do not reconnect. */
  close() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.pingTimer);
    document.removeEventListener('visibilitychange', this._onVisible);
    window.removeEventListener('online', this._onOnline);
    if (this.ws) this.ws.close();
  }

  /** Send a command and resolve with its result. */
  send(payload) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Not connected'));
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, ...payload }));
    });
  }

  /** Subscribe to an event bus event. Returns the subscription id. */
  subscribeEvents(eventType, handler) {
    return this.subscribe({ type: 'subscribe_events', event_type: eventType }, handler);
  }

  /** Send a command whose events keep arriving under its id (e.g. a camera's WebRTC offer). */
  async subscribe(payload, handler) {
    const id = this.nextId; // id that send() is about to use
    this.eventHandlers.set(id, handler);
    try {
      await this.send(payload);
    } catch (err) {
      this.eventHandlers.delete(id);
      throw err;
    }
    return id;
  }

  unsubscribe(id) {
    this.eventHandlers.delete(id);
    return this.send({ type: 'unsubscribe_events', subscription: id }).catch(() => {});
  }

  callService(domain, service, serviceData = {}, target) {
    const payload = { type: 'call_service', domain, service, service_data: serviceData };
    if (target) payload.target = target;
    return this.send(payload);
  }

  /**
   * Recorded history of one entity, oldest first, as [{ t: ms, s: state }].
   * Uses the compact format HA's own history graphs use (no attributes).
   */
  async history(entityId, hours = 24) {
    const result = await this.send({
      type: 'history/history_during_period',
      start_time: new Date(Date.now() - hours * 3_600_000).toISOString(),
      entity_ids: [entityId],
      minimal_response: true,
      no_attributes: true,
      significant_changes_only: false,
      include_start_time_state: true,
    });
    return (result?.[entityId] || []).map((p) => ({ t: (p.lu ?? p.lc) * 1000, s: p.s }));
  }

  // ---- internals ----

  _handle(ws, msg, token) {
    switch (msg.type) {
      case 'auth_required':
        ws.send(JSON.stringify({ type: 'auth', access_token: token }));
        break;
      case 'auth_ok':
        this.haVersion = msg.ha_version;
        this._onAuthenticated();
        break;
      case 'auth_invalid':
        this.stopped = true; // retrying with the same token will not help
        this._setStatus('auth_invalid', msg.message || 'Access token rejected');
        ws.close();
        break;
      case 'result': {
        const p = this.pending.get(msg.id);
        if (!p) break;
        this.pending.delete(msg.id);
        if (msg.success) p.resolve(msg.result);
        else p.reject(Object.assign(new Error(msg.error?.message || 'Command failed'), { code: msg.error?.code }));
        break;
      }
      case 'pong': {
        const p = this.pending.get(msg.id);
        if (p) { this.pending.delete(msg.id); p.resolve(); }
        break;
      }
      case 'event': {
        const handler = this.eventHandlers.get(msg.id);
        if (handler) handler(msg.event);
        break;
      }
    }
  }

  async _onAuthenticated() {
    this.retries = 0;
    this._startPing();
    try {
      // Subscribe before fetching states so no change is missed in between.
      await this.subscribeEvents('state_changed', (event) => {
        const { entity_id: entityId, new_state: newState } = event.data;
        this.dispatchEvent(new CustomEvent('state', { detail: { entityId, newState } }));
      });
      const [states, config, registry] = await Promise.all([
        this.send({ type: 'get_states' }),
        this.send({ type: 'get_config' }).catch(() => ({})),
        this._loadRegistries(),
      ]);
      this._setStatus('connected');
      this.dispatchEvent(new CustomEvent('ready', { detail: { states, config, ...registry } }));
    } catch (err) {
      this._setStatus('disconnected', err.message);
      this.ws?.close();
    }
  }

  // Areas are optional: some registry commands need an admin user, so any failure
  // just means entities are grouped by type instead of by room.
  async _loadRegistries() {
    const safe = (p) => p.catch(() => null);
    const [areas, entities, devices] = await Promise.all([
      safe(this.send({ type: 'config/area_registry/list' })),
      safe(this.send({ type: 'config/entity_registry/list_for_display' })),
      safe(this.send({ type: 'config/device_registry/list' })),
    ]);
    const deviceArea = new Map();
    for (const d of devices || []) if (d.area_id) deviceArea.set(d.id, d.area_id);

    // entityInfo: entity_id -> { areaId, hidden, category, deviceId }
    const entityInfo = new Map();
    const categories = entities?.entity_categories || {};
    for (const e of entities?.entities || []) {
      entityInfo.set(e.ei, {
        areaId: e.ai || (e.di && deviceArea.get(e.di)) || null,
        hidden: !!e.hb,
        category: e.ec !== undefined ? categories[e.ec] : null,
        deviceId: e.di || null,
      });
    }
    return { areas: areas || [], entityInfo };
  }

  _startPing() {
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const timeout = setTimeout(() => ws.close(), PONG_TIMEOUT);
      this.send({ type: 'ping' }).then(() => clearTimeout(timeout), () => {});
    }, PING_INTERVAL);
  }

  _onClose(ws) {
    if (ws !== this.ws) return;
    clearInterval(this.pingTimer);
    for (const p of this.pending.values()) p.reject(new Error('Connection lost'));
    this.pending.clear();
    this.eventHandlers.clear();
    this.ws = null;
    if (this.stopped) return;
    this._setStatus('disconnected');
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    const delay = Math.min(MAX_BACKOFF, 1000 * 2 ** this.retries++);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  _reconnectNowIfDown() {
    if (this.stopped || this.ws || this.status === 'connecting') return;
    this.retries = 0;
    this.connect();
  }

  _setStatus(status, message = '') {
    this.status = status;
    this.dispatchEvent(new CustomEvent('status', { detail: { status, message } }));
  }
}

// Camera pictures and live video, using Home Assistant's own camera APIs and the existing sign-in.
//
//  - Stills come from the camera's entity_picture (/api/camera_proxy/<id>?token=…). Home Assistant
//    rotates that token every few minutes and sends the new one with the camera's state, so the
//    address works in a plain <img> without any headers.
//  - Live video tries, in order, what the camera offers: WebRTC (go2rtc, Nest and others; lowest
//    delay), then HLS (the stream integration), then the Motion JPEG proxy every camera has.

const HLS_JS = 'https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js';
const KIND_LABELS = { web_rtc: 'WebRTC', hls: 'HLS', mjpeg: 'MJPEG' };

export const streamLabel = (kind) => KIND_LABELS[kind] || kind;

/** Address of a camera's current picture, `width` pixels wide where the camera can resize. */
export function cameraStillUrl(base, s, width) {
  const pic = s?.attributes?.entity_picture;
  if (!pic) return '';
  const u = new URL(pic, `${base}/`);
  if (width) u.searchParams.set('width', String(width));
  u.searchParams.set('t', String(Date.now())); // a fresh picture, not the browser's copy
  return u.href;
}

let hlsLoading = null;
function loadHlsJs() {
  if (window.Hls) return Promise.resolve(window.Hls);
  hlsLoading ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = HLS_JS;
    s.onload = () => (window.Hls ? resolve(window.Hls) : reject(new Error('hls.js did not load')));
    s.onerror = () => { hlsLoading = null; reject(new Error('Could not load the HLS player')); };
    document.head.append(s);
  });
  return hlsLoading;
}

const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function haAtLeast(version, year, month) {
  const [y, m] = String(version || '').split('.').map(Number);
  if (!y) return true; // unknown: assume current
  return y > year || (y === year && m >= month);
}

function waitIceGathered(pc, ms) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); } };
    const t = setTimeout(resolve, ms);
    pc.addEventListener('icegatheringstatechange', done);
  });
}

/**
 * Plays one camera's live video into `stage`, falling back through the stream types.
 * onState({ phase: 'connecting' | 'playing' | 'failed', kind, message })
 */
export class CameraPlayer {
  constructor({ client, entityId, getState, stage, onState }) {
    this.client = client;
    this.getState = getState;
    this.entityId = entityId;
    this.stage = stage;
    this.onState = onState;
    this.run = 0;
    this.kind = null;
    this.media = null;
    this.muted = true;
  }

  get video() {
    return this.media?.tagName === 'VIDEO' ? this.media : null;
  }

  async start() {
    this.stop();
    const run = ++this.run;
    const kinds = [...(await this._streamKinds()), 'mjpeg'];
    let lastError = null;
    for (const kind of kinds) {
      if (run !== this.run) return;
      this.kind = kind;
      this.onState({ phase: 'connecting', kind });
      try {
        await this[`_${kind}`](run);
        if (run !== this.run) return;
        this.onState({ phase: 'playing', kind });
        return;
      } catch (err) {
        lastError = err;
        this._teardown();
      }
    }
    if (run === this.run) this.onState({ phase: 'failed', kind: null, message: lastError?.message || 'No live video' });
  }

  stop() {
    this.run++;
    this._teardown();
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.video) {
      this.video.muted = muted;
      if (!muted) this.video.play().catch(() => {});
    }
  }

  get hasAudio() {
    const v = this.video;
    if (!v) return false;
    if (v.srcObject) return v.srcObject.getAudioTracks().length > 0;
    return this.hls ? !!this.hls.audioTracks?.length || this.hls.levels?.some((l) => l.audioCodec) : true;
  }

  // ---- internals ----

  async _streamKinds() {
    const s = this.getState();
    let types;
    try {
      const res = await this.client.send({ type: 'camera/capabilities', entity_id: this.entityId });
      types = res?.frontend_stream_types;
    } catch {
      // Older Home Assistant: the camera says in its attributes, else try HLS and see.
      const attr = s?.attributes?.frontend_stream_type;
      types = attr ? [attr] : ['hls'];
    }
    return ['web_rtc', 'hls'].filter((k) => types?.includes(k));
  }

  _teardown() {
    clearTimeout(this.timer);
    if (this.sub != null) {
      this.client.unsubscribe?.(this.sub);
      this.sub = null;
    }
    this.pc?.close();
    this.pc = null;
    this.hls?.destroy();
    this.hls = null;
    const m = this.media;
    if (m) {
      if (m.tagName === 'VIDEO') {
        m.pause();
        m.srcObject = null;
        m.removeAttribute('src');
        m.load();
      } else {
        m.src = ''; // closes the Motion JPEG connection
      }
      m.remove();
    }
    this.media = null;
  }

  _newVideo() {
    const v = document.createElement('video');
    v.className = 'cam-media';
    v.muted = this.muted;
    v.autoplay = true;
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.disablePictureInPicture = false;
    this.stage.prepend(v);
    this.media = v;
    return v;
  }

  // Resolves once frames are on screen; rejects on `failed`, or when nothing shows within `ms`.
  _whenPlaying(el, ms, failed) {
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (err) => {
        if (done) return;
        done = true;
        clearInterval(poll);
        clearTimeout(this.timer);
        err ? reject(err) : resolve();
      };
      const shown = () => (el.tagName === 'VIDEO' ? el.videoWidth > 0 && el.readyState >= 2 : el.naturalWidth > 0);
      const poll = setInterval(() => shown() && finish(), 150);
      this.timer = setTimeout(() => finish(new Error('The camera did not send any video')), ms);
      el.addEventListener('playing', () => shown() && finish());
      el.addEventListener('error', () => finish(new Error('The video could not be played')));
      failed?.catch((err) => finish(err));
      if (el.tagName === 'VIDEO') el.play().catch(() => {});
    });
  }

  async _web_rtc(run) {
    if (!window.RTCPeerConnection) throw new Error('This browser has no WebRTC');
    const { client, entityId } = this;
    let cfg = {};
    try {
      cfg = (await client.send({ type: 'camera/webrtc/get_client_config', entity_id: entityId })) || {};
    } catch { /* older Home Assistant: no extra settings */ }
    if (run !== this.run) return;

    const pc = new RTCPeerConnection(cfg.configuration || {});
    this.pc = pc;
    if (cfg.dataChannel) pc.createDataChannel(cfg.dataChannel);
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });
    const stream = new MediaStream();
    pc.addEventListener('track', (e) => stream.addTrack(e.track));
    const video = this._newVideo();
    video.srcObject = stream;

    await pc.setLocalDescription(await pc.createOffer());
    if (cfg.getCandidatesUpfront) await waitIceGathered(pc, 3000);
    if (run !== this.run) return;

    // Home Assistant 2024.11 sent ICE candidates as bare strings; later versions as objects.
    const objects = haAtLeast(client.haVersion, 2024, 12);
    let session = null;
    const outbox = [];
    const remote = [];
    let answered = false;
    const sendCandidate = (c) => client.send({
      type: 'camera/webrtc/candidate', entity_id: entityId, session_id: session,
      candidate: objects ? c : c.candidate,
    }).catch(() => {});
    pc.addEventListener('icecandidate', (e) => {
      if (cfg.getCandidatesUpfront || !e.candidate?.candidate) return;
      const c = e.candidate.toJSON();
      if (session) sendCandidate(c);
      else outbox.push(c);
    });
    const addRemote = (c) => pc.addIceCandidate(typeof c === 'string' ? { candidate: c, sdpMid: '0' } : c).catch(() => {});

    const failed = new Promise((_, reject) => {
      pc.addEventListener('connectionstatechange', () => {
        if (pc.connectionState === 'failed') reject(new Error('Could not reach the camera over WebRTC'));
      });
      const onEvent = async (ev) => {
        switch (ev.type) {
          case 'session':
            session = ev.session_id;
            outbox.splice(0).forEach(sendCandidate);
            break;
          case 'answer':
            try {
              await pc.setRemoteDescription({ type: 'answer', sdp: ev.answer });
              answered = true;
              remote.splice(0).forEach(addRemote);
            } catch (err) { reject(err); }
            break;
          case 'candidate':
            if (answered) addRemote(ev.candidate);
            else remote.push(ev.candidate);
            break;
          case 'error':
            reject(new Error(ev.message || ev.code || 'The camera refused the video call'));
            break;
        }
      };
      client.subscribe({ type: 'camera/webrtc/offer', entity_id: entityId, offer: pc.localDescription.sdp }, onEvent)
        .then((id) => {
          if (run === this.run) this.sub = id;
          else client.unsubscribe(id);
        })
        .catch(async (err) => {
          if (err.code !== 'unknown_command') { reject(err); return; }
          // Before 2024.11: one request with the full offer, one answer back.
          try {
            await waitIceGathered(pc, 3000);
            const res = await client.send({ type: 'camera/web_rtc_offer', entity_id: entityId, offer: pc.localDescription.sdp });
            await pc.setRemoteDescription({ type: 'answer', sdp: res.answer });
          } catch (e) { reject(e); }
        });
    });
    failed.catch(() => {});
    await this._whenPlaying(video, 15_000, failed);
  }

  async _hls(run) {
    const { client, entityId } = this;
    const res = await client.send({ type: 'camera/stream', entity_id: entityId, format: 'hls' });
    if (run !== this.run) return;
    const src = new URL(res.url, `${client.url}/`).href;
    const video = this._newVideo();
    // Like Home Assistant's own player: hls.js where the browser has Media Source (it copes
    // better with live streams), the built-in player on iPhone and iPad.
    let Hls = null;
    if (!isIOS && window.MediaSource) Hls = await loadHlsJs().catch(() => null);
    if (run !== this.run) return;
    let failed = null;
    if (Hls?.isSupported()) {
      const hls = new Hls({
        backBufferLength: 60, fragLoadingTimeOut: 30_000, manifestLoadingTimeOut: 30_000,
        levelLoadingTimeOut: 30_000, maxLiveSyncPlaybackRate: 2, lowLatencyMode: true,
      });
      this.hls = hls;
      failed = new Promise((_, reject) => {
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (data.fatal) reject(new Error(`HLS: ${data.details}`));
        });
      });
      failed.catch(() => {});
      hls.loadSource(src);
      hls.attachMedia(video);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src;
    } else {
      throw new Error('This browser cannot play HLS');
    }
    await this._whenPlaying(video, 30_000, failed);
  }

  async _mjpeg() {
    const s = this.getState();
    const pic = s?.attributes?.entity_picture;
    const token = pic ? new URL(pic, `${this.client.url}/`).searchParams.get('token') : '';
    if (!token) throw new Error('The camera has no picture address');
    const img = document.createElement('img');
    img.className = 'cam-media';
    img.alt = '';
    img.src = `${this.client.url}/api/camera_proxy_stream/${encodeURIComponent(this.entityId)}?token=${encodeURIComponent(token)}`;
    this.stage.prepend(img);
    this.media = img;
    await this._whenPlaying(img, 15_000);
  }
}

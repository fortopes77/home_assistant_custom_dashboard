// Talk to Home Assistant's Assist, the voice assistant set up in Home Assistant (Settings → Voice assistants).
// Speech goes to Home Assistant over the same WebSocket (assist_pipeline/run): Home Assistant turns it into
// text, hands it to the conversation agent (its own, or an AI such as Claude, OpenAI or Gemini) and speaks
// the answer back. Typed questions take the same route without the speech parts.

import { icon } from './icons.js';
import { esc } from './controls.js';

const VOICE_KEY = 'ha-dash.voice';
const VOICE_RATE = 16000;          // what Home Assistant's speech-to-text expects: 16 kHz, 16-bit, mono
const VOICE_MAX_MS = 15_000;       // stop listening after this even if Home Assistant hears no end
const VOICE_CLOSE_MS = 60_000;     // close the panel this long after the last answer (the wall clock screen goes over it)

const VOICE_PATHS = {
  mic: 'M12,2A3,3 0 0,1 15,5V11A3,3 0 0,1 12,14A3,3 0 0,1 9,11V5A3,3 0 0,1 12,2M19,11C19,14.53 16.39,17.44 13,17.93V21H11V17.93C7.61,17.44 5,14.53 5,11H7A5,5 0 0,0 12,16A5,5 0 0,0 17,11H19Z',
  micOff: 'M19,11C19,12.19 18.66,13.3 18.1,14.28L16.87,13.05C17.14,12.43 17.3,11.74 17.3,11H19M15,11.16L9,5.18V5A3,3 0 0,1 12,2A3,3 0 0,1 15,5V11L15,11.16M4.27,3L21,19.73L19.73,21L15.54,16.81C14.77,17.27 13.91,17.58 13,17.72V21H11V17.72C7.72,17.23 5,14.41 5,11H6.7C6.7,14 9.24,16.1 12,16.1C12.81,16.1 13.6,15.91 14.31,15.58L12.65,13.92L12,14A3,3 0 0,1 9,11V10.28L3,4.27L4.27,3Z',
  send: 'M2,21L23,12L2,3V10L17,12L2,14V21Z',
  stop: 'M18,18H6V6H18V18Z',
};
const voiceIcon = (name, cls = 'icon') =>
  `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${VOICE_PATHS[name]}"/></svg>`;

// Styles live here rather than in styles.css, so the voice assistant stays one self-contained file.
const VOICE_CSS = `
.voice-btn .icon { width: 22px; height: 22px; fill: currentColor; }
.sheet.voice { flex-direction: column; overflow: hidden; }
.sheet.voice[open] { display: flex; height: min(560px, 85dvh); }
.voice-head { position: static; }
.voice-head h2 { margin: 0; }
.voice-head .select { min-height: 32px; padding: 4px 8px; margin-top: 4px; font-size: 0.85rem; width: auto; max-width: 100%; }
.voice-head p { margin: 2px 0 0; font-size: 0.85rem; }
.voice-badge { display: grid; place-items: center; width: 40px; height: 40px; border-radius: 50%; background: var(--primary); color: var(--primary-text); }
.voice-badge .icon { width: 22px; height: 22px; fill: currentColor; }
.voice-log { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 8px; }
.voice-hint { margin: auto 0; text-align: center; }
.voice-msg { margin: 0; padding: 10px 14px; border-radius: 18px; max-width: 85%; line-height: 1.35; white-space: pre-wrap; overflow-wrap: anywhere; }
.voice-msg.you { align-self: flex-end; background: var(--primary); color: var(--primary-text); border-bottom-right-radius: 6px; }
.voice-msg.ha { align-self: flex-start; background: var(--surface-2); border-bottom-left-radius: 6px; }
.voice-msg.error { background: color-mix(in srgb, var(--danger) 14%, var(--surface)); color: var(--text); }
.voice-note { margin: 0 16px 8px; font-size: 0.85rem; color: var(--muted); }
.voice-foot {
  display: grid; grid-template-columns: auto 1fr; grid-template-areas: "mic state" "form form";
  align-items: center; gap: 10px 14px;
  padding: 12px 16px calc(16px + var(--safe-bottom, 0px)); border-top: 1px solid var(--border);
}
.voice-mic {
  --level: 0;
  grid-area: mic; display: grid; place-items: center; width: 64px; height: 64px;
  border: 0; border-radius: 50%; background: var(--primary); color: var(--primary-text); cursor: pointer;
  box-shadow: 0 0 0 calc(4px + var(--level) * 14px) color-mix(in srgb, var(--primary) 25%, transparent);
  transition: box-shadow 0.08s linear, background 0.2s;
}
.voice-mic .icon { width: 30px; height: 30px; fill: currentColor; }
.voice-mic:disabled { background: var(--surface-2); color: var(--muted); box-shadow: none; cursor: default; }
.voice[data-phase="listening"] .voice-mic { background: var(--danger); box-shadow: 0 0 0 calc(4px + var(--level) * 14px) color-mix(in srgb, var(--danger) 28%, transparent); }
.voice[data-phase="thinking"] .voice-mic { animation: voice-pulse 1s ease-in-out infinite; }
@keyframes voice-pulse { 50% { opacity: 0.55; } }
.voice-state { grid-area: state; font-weight: 600; color: var(--muted); }
.voice-form { grid-area: form; display: flex; gap: 8px; margin: 0; }
.voice-text {
  flex: 1; min-width: 0; min-height: 44px; padding: 8px 14px;
  border: 1px solid var(--border); border-radius: 22px; background: var(--bg); color: var(--text);
  font: inherit; font-size: 16px; /* 16px stops iOS zooming in on the box */
}
.voice-form .icon { width: 20px; height: 20px; fill: currentColor; }
`;

const VOICE_ERRORS = {
  'stt-no-text-recognized': "Sorry, I didn't catch that.",
  'stt-stream-failed': 'Home Assistant could not turn the speech into text.',
  'stt-provider-missing': 'This assistant has no speech-to-text set up in Home Assistant.',
  'pipeline-not-found': 'That assistant no longer exists in Home Assistant. Pick another one.',
  'intent-failed': 'The assistant could not answer.',
  'tts-failed': 'Home Assistant could not speak the answer.',
  timeout: 'The assistant took too long to answer.',
};

// Records the microphone as 16 kHz 16-bit PCM in an AudioWorklet (on the audio thread), or a
// ScriptProcessor where worklets are missing. Resampling is done here, as Safari ignores a 16 kHz context
// for microphone input.
const VOICE_WORKLET = `
class VoiceCapture extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('voice-capture', VoiceCapture);`;

/** Downsamples Float32 chunks at `rate` to 16 kHz Int16, averaging the samples that fold into each one. */
export function voiceResampler(rate) {
  const step = rate / VOICE_RATE;
  let pos = 0; // position of the next output sample, in input samples, relative to this chunk
  let carry = new Float32Array(0);
  return (chunk) => {
    const input = new Float32Array(carry.length + chunk.length);
    input.set(carry);
    input.set(chunk, carry.length);
    const out = [];
    while (pos + step <= input.length) {
      const a = Math.floor(pos);
      const b = Math.min(input.length, Math.max(a + 1, Math.floor(pos + step)));
      let sum = 0;
      for (let i = a; i < b; i++) sum += input[i];
      const v = Math.max(-1, Math.min(1, sum / (b - a)));
      out.push(v < 0 ? v * 0x8000 : v * 0x7fff);
      pos += step;
    }
    const keep = Math.floor(pos);
    carry = input.slice(keep);
    pos -= keep;
    return Int16Array.from(out);
  };
}

/** Why the microphone cannot be used here, or '' when it can be tried. */
export function micBlockedReason() {
  // Browsers hide the microphone from http pages, unless told to trust the address (Chrome can be,
  // see below), so try whenever it is on offer rather than going by the address.
  if (!navigator.mediaDevices?.getUserMedia) {
    if (!window.isSecureContext) {
      const origin = `${location.protocol}//${location.host}`;
      return `The browser keeps the microphone from http addresses like ${origin}. `
        + `In Chrome on a computer or Android, open chrome://flags/#unsafely-treat-insecure-origin-as-secure, `
        + `add ${origin}, set it to Enabled and relaunch Chrome. On an iPad or iPhone (Chrome and Safari alike) `
        + 'it needs an https address. You can still type below.';
    }
    return 'This browser does not offer the microphone to web pages. You can still type below.';
  }
  if (!(window.AudioContext || window.webkitAudioContext)) return 'This browser cannot record audio. You can still type below.';
  return '';
}

export class Voice {
  constructor() {
    this.client = null;
    this.pipelines = [];
    this.preferred = null;
    this.settings = (() => { try { return JSON.parse(localStorage.getItem(VOICE_KEY)) || {}; } catch { return {}; } })();
    this.log = [];              // [{ who: 'you'|'ha', text, error }]
    this.phase = 'idle';        // idle | listening | thinking | speaking
    this.conversationId = null;
    this.ctx = null;            // AudioContext, created on the first tap (iOS only allows it in a tap)
    this.audioEl = null;        // fallback player, unlocked in the same tap
    this.run = null;            // the pipeline run in progress
    this.level = 0;
    this.closeTimer = null;

    const style = document.createElement('style');
    style.textContent = VOICE_CSS;
    document.head.append(style);

    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.className = 'icon-btn voice-btn';
    this.button.setAttribute('aria-label', 'Talk to the assistant');
    this.button.innerHTML = voiceIcon('mic');
    this.button.hidden = true;
    this.button.addEventListener('click', () => this.open({ listen: true }));
    const actions = document.querySelector('.topbar-actions');
    actions?.insertBefore(this.button, actions.querySelector('.status'));

    this.dialog = document.createElement('dialog');
    this.dialog.className = 'sheet voice';
    this.dialog.setAttribute('aria-label', 'Assistant');
    document.body.append(this.dialog);
    this.dialog.addEventListener('close', () => this._onClosed());
    this.dialog.addEventListener('click', (e) => {
      if (e.target === this.dialog) { this.dialog.close(); return; } // tap on the backdrop
      if (e.target.closest('[data-voice-close]')) this.dialog.close();
      else if (e.target.closest('[data-voice-mic]')) this.toggleListening();
    });
    this.dialog.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = this.dialog.querySelector('.voice-text');
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      this.ask(text);
    });
    this.dialog.addEventListener('change', (e) => {
      if (!e.target.matches('.voice-pipeline')) return;
      this.settings.pipeline = e.target.value;
      try { localStorage.setItem(VOICE_KEY, JSON.stringify(this.settings)); } catch { /* ignore */ }
      this.conversationId = null;
      this._render();
    });
  }

  /** Follow a (new) Home Assistant connection: the button shows while it is connected. */
  attach(client) {
    this.client = client;
    this._stop('');
    const sync = () => {
      if (client !== this.client) return;
      const up = client.status === 'connected';
      this.button.hidden = !up;
      if (up) this._loadPipelines();
      else if (this.run) this._stop('Lost the connection to Home Assistant. It will reconnect by itself.');
    };
    client.addEventListener('status', sync);
    sync();
  }

  get pipeline() {
    const want = this.settings.pipeline || this.preferred;
    return this.pipelines.find((p) => p.id === want) || this.pipelines.find((p) => p.id === this.preferred) || this.pipelines[0] || null;
  }

  get canSpeak() {
    // No list (not allowed to read it): try anyway, Home Assistant says if speech is not set up.
    return !this.pipelines.length || !!this.pipeline?.stt_engine;
  }

  async _loadPipelines() {
    const client = this.client;
    try {
      const res = await client.send({ type: 'assist_pipeline/pipeline/list' });
      if (client !== this.client) return;
      this.pipelines = res?.pipelines || [];
      this.preferred = res?.preferred_pipeline || null;
    } catch {
      this.pipelines = [];
    }
    if (this.dialog.open) this._render();
  }

  open({ listen = false } = {}) {
    // Everything that needs a tap on iOS happens here, before anything waits.
    this._unlockAudio();
    if (!this.dialog.open) {
      this.dialog.showModal();
      this._render();
    }
    if (listen && this.phase === 'idle' && this.canSpeak && !micBlockedReason()) this.listen();
    else this.dialog.querySelector('.voice-text')?.focus({ preventScroll: true });
  }

  toggleListening() {
    this._unlockAudio();
    if (this.phase === 'listening') this._endAudio();
    else if (this.phase === 'speaking') this._stopSpeaking();
    else if (this.phase === 'idle') this.listen();
  }

  _unlockAudio() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC && !this.ctx) {
      try { this.ctx = new AC(); } catch { /* no audio */ }
    }
    if (this.ctx?.state === 'suspended') this.ctx.resume().catch(() => {});
    if (!this.audioEl) {
      this.audioEl = new Audio();
      this.audioEl.playsInline = true;
      // A moment of silence, so later answers may play without another tap.
      this.audioEl.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';
      this.audioEl.play().catch(() => {});
    }
    if (window.speechSynthesis && !this.ttsUnlocked) {
      this.ttsUnlocked = true;
      try { speechSynthesis.speak(new SpeechSynthesisUtterance('')); } catch { /* ignore */ }
    }
  }

  // ---------- one question ----------

  /** Ask out loud: record until Home Assistant hears the end, then think and speak. */
  async listen() {
    const blocked = micBlockedReason();
    if (blocked) { this._say('ha', blocked, true); return; }
    if (!this.client || this.client.status !== 'connected') { this._say('ha', 'Not connected to Home Assistant.', true); return; }
    clearTimeout(this.closeTimer);

    const run = { handler: null, queue: [], pending: [], pendingLen: 0, ended: false, stream: null, nodes: [], subId: null, voice: true };
    this.run = run;
    this._setPhase('listening');

    // Ask Home Assistant first; the microphone starts while it gets ready and the first words are queued.
    const pipeline = this.pipeline;
    const tts = !this.pipelines.length || !!pipeline?.tts_engine;
    this._start(run, {
      start_stage: 'stt',
      end_stage: tts ? 'tts' : 'intent',
      input: { sample_rate: VOICE_RATE },
    });

    // Safari (iPad and iPhone) refuses to record unless the page's audio session allows recording.
    try { if (navigator.audioSession) navigator.audioSession.type = 'play-and-record'; } catch { /* ignore */ }
    try {
      run.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      if (this.run !== run) return;
      const denied = err?.name === 'NotAllowedError' || err?.name === 'SecurityError';
      this._stop(denied
        ? 'Microphone access is blocked. On an iPad allow it in Settings → Safari → Microphone (or tap aA → Website Settings), then try again. You can still type below.'
        : `The microphone could not start (${err?.message || err?.name || 'unknown error'}).`);
      return;
    }
    if (this.run !== run || run.ended) { this._releaseMic(run); return; }

    const ctx = this.ctx;
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    const source = ctx.createMediaStreamSource(run.stream);
    const resample = voiceResampler(ctx.sampleRate);
    const onChunk = (floats) => {
      if (this.run !== run || run.ended) return;
      let peak = 0;
      for (let i = 0; i < floats.length; i += 8) peak = Math.max(peak, Math.abs(floats[i]));
      this.level = this.level * 0.7 + peak * 0.3;
      // Send about a tenth of a second at a time, not one tiny frame per audio block.
      const pcm = resample(floats);
      run.pending.push(pcm);
      run.pendingLen += pcm.length;
      if (run.pendingLen >= VOICE_RATE / 10) this._flushAudio(run);
    };
    let node;
    try {
      if (!ctx.audioWorklet) throw new Error('no worklet');
      if (!this.workletReady) {
        const url = URL.createObjectURL(new Blob([VOICE_WORKLET], { type: 'application/javascript' }));
        this.workletReady = ctx.audioWorklet.addModule(url);
      }
      await this.workletReady;
      node = new AudioWorkletNode(ctx, 'voice-capture');
      node.port.onmessage = (e) => onChunk(e.data);
      source.connect(node);
    } catch {
      node = ctx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = (e) => onChunk(e.inputBuffer.getChannelData(0));
      source.connect(node);
      node.connect(ctx.destination); // a ScriptProcessor only runs while connected; it outputs silence
    }
    run.nodes = [source, node];
    if (this.run !== run || run.ended) { this._releaseMic(run); return; }
    run.maxTimer = setTimeout(() => this._endAudio(), VOICE_MAX_MS);
    this._meter(run);
  }

  /** Ask in writing: the same assistant, answered on screen. */
  async ask(text) {
    if (!this.client || this.client.status !== 'connected') { this._say('ha', 'Not connected to Home Assistant.', true); return; }
    if (this.run) this._stop('');
    clearTimeout(this.closeTimer);
    this._say('you', text);
    const run = { handler: null, queue: [], pending: [], pendingLen: 0, ended: true, nodes: [], subId: null, voice: false, text };
    this.run = run;
    this._setPhase('thinking');
    this._start(run, { start_stage: 'intent', end_stage: 'intent', input: { text } });
  }

  async _start(run, payload) {
    const pipeline = this.pipeline;
    const msg = { type: 'assist_pipeline/run', ...payload, timeout: 60 };
    if (pipeline && this.pipelines.length > 1) msg.pipeline = pipeline.id;
    if (this.conversationId) msg.conversation_id = this.conversationId;
    try {
      run.subId = await this.client.subscribe(msg, (event) => this._onEvent(run, event));
    } catch (err) {
      if (this.run !== run) return;
      if (!run.voice && err.code === 'unknown_command') return this._askOld(run); // Home Assistant before Assist pipelines
      this._stop(err.message || 'The assistant did not answer.');
    }
  }

  async _askOld(run) {
    try {
      const msg = { type: 'conversation/process', text: run.text, language: navigator.language };
      if (this.conversationId) msg.conversation_id = this.conversationId;
      const res = await this.client.send(msg);
      if (this.run !== run) return;
      this.conversationId = res?.conversation_id || null;
      this._say('ha', res?.response?.speech?.plain?.speech || 'Done.', res?.response?.response_type === 'error');
      this._finish(run);
    } catch (err) {
      if (this.run === run) this._stop(err.message || 'The assistant did not answer.');
    }
  }

  _onEvent(run, event) {
    if (this.run !== run) return;
    const d = event.data || {};
    switch (event.type) {
      case 'run-start':
        run.handler = d.runner_data?.stt_binary_handler_id ?? null;
        if (run.handler != null) {
          for (const pcm of run.queue) this._sendAudio(run, pcm);
          run.queue = [];
          if (run.ended) this._sendEnd(run);
        }
        break;
      case 'stt-vad-end':
      case 'stt-end':
        if (!run.ended) this._endAudio();
        if (event.type === 'stt-end') {
          const heard = d.stt_output?.text?.trim();
          if (heard) this._say('you', heard);
        }
        this._setPhase('thinking');
        break;
      case 'intent-end': {
        const out = d.intent_output || {};
        this.conversationId = out.conversation_id || this.conversationId;
        run.continue = !!out.continue_conversation;
        const speech = out.response?.speech?.plain?.speech || '';
        run.speech = speech;
        this._say('ha', speech || 'Done.', out.response?.response_type === 'error');
        break;
      }
      case 'tts-end': {
        const url = d.tts_output?.url;
        if (url) run.ttsUrl = new URL(url, this.client.url + '/').href;
        break;
      }
      case 'run-end':
        this._finish(run);
        break;
      case 'error':
        this._stop(VOICE_ERRORS[d.code] || d.message || 'The assistant ran into a problem.');
        break;
    }
  }

  async _finish(run) {
    this._release(run);
    if (this.run !== run) return;
    if (run.voice && (run.ttsUrl || run.speech)) {
      this._setPhase('speaking');
      await this._speak(run);
      if (this.run !== run) return;
    }
    this.run = null;
    this._setPhase('idle');
    // The assistant asked something back: listen for the answer straight away.
    if (run.voice && run.continue && this.dialog.open) this.listen();
    else this._scheduleClose();
  }

  // ---------- audio ----------

  _sendAudio(run, pcm) {
    if (run.handler == null) { run.queue.push(pcm); return; }
    const ws = this.client?.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const frame = new Uint8Array(1 + pcm.byteLength);
    frame[0] = run.handler;
    frame.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), 1);
    ws.send(frame);
  }

  _flushAudio(run) {
    if (!run.pendingLen) return;
    const pcm = new Int16Array(run.pendingLen);
    let at = 0;
    for (const part of run.pending) { pcm.set(part, at); at += part.length; }
    run.pending = [];
    run.pendingLen = 0;
    this._sendAudio(run, pcm);
  }

  _sendEnd(run) {
    this._flushAudio(run);
    if (run.handler == null || run.endSent) return;
    run.endSent = true;
    const ws = this.client?.ws;
    if (ws?.readyState === WebSocket.OPEN) ws.send(new Uint8Array([run.handler]));
  }

  /** Done speaking: stop the microphone and tell Home Assistant the audio is over. */
  _endAudio() {
    const run = this.run;
    if (!run || run.ended) return;
    run.ended = true;
    this._releaseMic(run);
    this._sendEnd(run);
    if (this.phase === 'listening') this._setPhase('thinking');
  }

  _releaseMic(run) {
    clearTimeout(run.maxTimer);
    for (const n of run.nodes) { try { n.disconnect(); } catch { /* ignore */ } }
    if (run.nodes[1]?.port) run.nodes[1].port.onmessage = null;
    run.nodes = [];
    for (const t of run.stream?.getTracks() || []) t.stop(); // iOS plays answers quietly while the mic is open
    run.stream = null;
    // Back to normal playback, so answers and the notification ding use the loudspeaker as usual.
    try { if (navigator.audioSession?.type === 'play-and-record') navigator.audioSession.type = 'auto'; } catch { /* ignore */ }
  }

  _release(run) {
    this._releaseMic(run);
    if (run.subId != null && this.client) {
      // The run is over on Home Assistant's side; only forget the handler here.
      this.client.eventHandlers.delete(run.subId);
      run.subId = null;
    }
  }

  async _speak(run) {
    if (run.ttsUrl) {
      try {
        await this._playUrl(run.ttsUrl);
        return;
      } catch { /* fall back to the device's own voice */ }
    }
    if (run.speech && window.speechSynthesis) {
      await new Promise((resolve) => {
        const u = new SpeechSynthesisUtterance(run.speech);
        u.lang = this.pipeline?.language || navigator.language;
        u.onend = u.onerror = resolve;
        this.stopSpeaking = () => { speechSynthesis.cancel(); resolve(); };
        speechSynthesis.speak(u);
      });
    }
  }

  async _playUrl(url) {
    // Through the audio context first: it was unlocked by the tap, so iOS lets it play.
    if (this.ctx) {
      try {
        const buf = await (await fetch(url)).arrayBuffer();
        const audio = await new Promise((res, rej) => this.ctx.decodeAudioData(buf, res, rej));
        if (this.ctx.state === 'suspended') await this.ctx.resume();
        await new Promise((resolve) => {
          const src = this.ctx.createBufferSource();
          src.buffer = audio;
          src.connect(this.ctx.destination);
          src.onended = resolve;
          this.stopSpeaking = () => { try { src.stop(); } catch { /* ignore */ } resolve(); };
          src.start();
        });
        return;
      } catch { /* try the audio element */ }
    }
    const el = this.audioEl || new Audio();
    await new Promise((resolve, reject) => {
      el.onended = resolve;
      el.onerror = () => reject(new Error('Could not play the answer'));
      this.stopSpeaking = () => { el.pause(); resolve(); };
      el.src = url;
      el.play().catch(reject);
    });
  }

  _stopSpeaking() {
    this.stopSpeaking?.();
    this.stopSpeaking = null;
  }

  _meter(run) {
    const ring = this.dialog.querySelector('.voice-mic');
    if (this.run !== run || this.phase !== 'listening' || !ring) {
      ring?.style.setProperty('--level', 0);
      return;
    }
    ring.style.setProperty('--level', Math.min(1, this.level * 3).toFixed(2));
    requestAnimationFrame(() => this._meter(run));
  }

  /** Abandon whatever is going on; `message` explains why (nothing for a quiet stop). */
  _stop(message) {
    const run = this.run;
    this.run = null;
    if (run) {
      if (!run.ended) { run.ended = true; this._sendEnd(run); }
      // Unsubscribing cancels the run in Home Assistant.
      if (run.subId != null) this.client?.unsubscribe(run.subId);
      run.subId = null;
      this._release(run);
    }
    this._stopSpeaking();
    if (message) this._say('ha', message, true);
    this._setPhase('idle');
    if (message) this._scheduleClose();
  }

  _onClosed() {
    clearTimeout(this.closeTimer);
    this._stop('');
    this.conversationId = null;
    this.log = [];
  }

  _scheduleClose() {
    clearTimeout(this.closeTimer);
    this.closeTimer = setTimeout(() => {
      if (this.phase === 'idle' && !this.dialog.querySelector('.voice-text')?.value) this.dialog.close();
    }, VOICE_CLOSE_MS);
  }

  // ---------- drawing ----------

  _say(who, text, error = false) {
    this.log.push({ who, text, error });
    if (this.log.length > 30) this.log.shift();
    this._render();
  }

  _setPhase(phase) {
    this.phase = phase;
    this.dialog.dataset.phase = phase;
    this._render();
  }

  _render() {
    if (!this.dialog.open) return;
    const blocked = micBlockedReason();
    const noStt = !blocked && !this.canSpeak;
    const choices = this.pipelines.length > 1
      ? `<select class="select voice-pipeline" aria-label="Assistant">${this.pipelines.map((p) =>
        `<option value="${esc(p.id)}" ${p.id === this.pipeline?.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>`
      : `<p class="muted">${esc(this.pipeline?.name || 'Home Assistant')}</p>`;
    const label = {
      idle: blocked || noStt ? '' : 'Tap to talk',
      listening: 'Listening…',
      thinking: 'Thinking…',
      speaking: 'Speaking…',
    }[this.phase];
    const micIcon = this.phase === 'listening' || this.phase === 'speaking' ? 'stop' : (blocked || noStt ? 'micOff' : 'mic');
    const hint = this.log.length ? '' : `<p class="voice-hint muted">Try “Turn off the kitchen lights”, “What's the temperature outside?” or “Is the garage door open?”</p>`;
    const note = blocked ? `<p class="voice-note">${esc(blocked)}</p>`
      : noStt ? `<p class="voice-note">This assistant has no speech-to-text, so it can only be typed to. Add one in Home Assistant under Settings → Voice assistants.</p>` : '';
    const html = `
      <div class="sheet-head voice-head">
        <span class="voice-badge">${voiceIcon('mic')}</span>
        <div><h2>Assist</h2>${choices}</div>
        <button type="button" class="icon-btn" data-voice-close aria-label="Close">${icon('close')}</button>
      </div>
      <div class="voice-log" aria-live="polite">${hint}${this.log.map((m) =>
        `<p class="voice-msg ${m.who}${m.error ? ' error' : ''}">${esc(m.text)}</p>`).join('')}</div>
      ${note}
      <div class="voice-foot">
        <button type="button" class="voice-mic" data-voice-mic ${blocked || noStt ? 'disabled' : ''}
          aria-label="${this.phase === 'listening' ? 'Stop listening' : this.phase === 'speaking' ? 'Stop speaking' : 'Talk'}">${voiceIcon(micIcon)}</button>
        <span class="voice-state">${label}</span>
        <form class="voice-form">
          <input class="voice-text" type="text" enterkeyhint="send" autocomplete="off" placeholder="Or type a question" aria-label="Question">
          <button type="submit" class="icon-btn" aria-label="Send">${voiceIcon('send')}</button>
        </form>
      </div>`;
    // Keep the text box (and what is being typed in it) across redraws.
    const typed = this.dialog.querySelector('.voice-text');
    const focused = typed && document.activeElement === typed;
    if (!typed) { this.dialog.innerHTML = html; return; }
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    this.dialog.querySelector('.voice-head').replaceWith(tmp.querySelector('.voice-head'));
    this.dialog.querySelector('.voice-log').replaceWith(tmp.querySelector('.voice-log'));
    this.dialog.querySelector('.voice-note')?.remove();
    const newNote = tmp.querySelector('.voice-note');
    if (newNote) this.dialog.querySelector('.voice-foot').before(newNote);
    this.dialog.querySelector('.voice-mic').replaceWith(tmp.querySelector('.voice-mic'));
    this.dialog.querySelector('.voice-state').replaceWith(tmp.querySelector('.voice-state'));
    if (focused) typed.focus({ preventScroll: true });
    const log = this.dialog.querySelector('.voice-log');
    log.scrollTop = log.scrollHeight;
  }
}

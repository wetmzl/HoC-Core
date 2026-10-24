import type { PluginSound } from "./plugin-audio";
import { SOUND_SOURCES, SOUND_VOLUME, type SoundCue } from "./sound-resources";

type AudioContextConstructor = typeof AudioContext;

interface WindowWithWebkitAudio extends Window {
  webkitAudioContext?: AudioContextConstructor;
}

/**
 * Presentation-only audio service. Short effects use decoded Web Audio buffers
 * for low latency; long BGM tracks are streamed by HTMLAudioElement to keep memory
 * use reasonable on Android devices.
 */
export class SoundPlayer {
  private enabled = true;
  private unlocked = false;
  private context?: AudioContext;
  private output?: GainNode;
  private readonly encodedAudio = new Map<SoundCue, ArrayBuffer>();
  private readonly pendingAudio = new Map<SoundCue, Promise<ArrayBuffer | null>>();
  private readonly buffers = new Map<SoundCue, AudioBuffer>();
  private readonly pendingBuffers = new Map<SoundCue, Promise<AudioBuffer | null>>();
  private criticalSoundsWarmed = false;
  private heartbeatRequested = false;
  private heartbeatSource?: AudioBufferSourceNode;
  private fallbackHeartbeat?: HTMLAudioElement;
  private readonly fetchControllers = new Set<AbortController>();
  private readonly fallbackVoices = new Set<HTMLAudioElement>();
  private readonly fallbackTimers = new Set<number>();
  private generation = 0;

  private readonly effects = new Set<{ stop(): void; dispose(): void }>();

  createEffect(url: string, release: () => void): PluginSound {
    let disposed = false;
    const voices = new Set<() => void>();
    const stop = () => { for (const stopVoice of [...voices]) stopVoice(); };
    const effect: PluginSound & { stop(): void } = {
      stop,
      play: (options = {}) => {
        if (disposed || !this.enabled || !this.unlocked || options.signal?.aborted) return;
        const volume = options.volume ?? 1;
        if (!Number.isFinite(volume) || volume < 0 || volume > 1) return;
        const audio = new Audio(url);
        audio.volume = volume;
        let finished = false;
        const cleanup = () => {
          if (finished) return;
          finished = true;
          audio.pause();
          audio.removeAttribute("src");
          audio.load();
          options.signal?.removeEventListener("abort", cleanup);
          audio.removeEventListener("ended", cleanup);
          audio.removeEventListener("error", cleanup);
          voices.delete(cleanup);
        };
        voices.add(cleanup);
        options.signal?.addEventListener("abort", cleanup, { once: true });
        audio.addEventListener("ended", cleanup, { once: true });
        audio.addEventListener("error", cleanup, { once: true });
        void audio.play().catch(cleanup);
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        stop();
        this.effects.delete(effect);
        release();
      }
    };
    this.effects.add(effect);
    return effect;
  }

  configure(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.effects.forEach((effect) => effect.stop());
      this.stopHeartbeat();
      return;
    }
    if (this.unlocked) {
      void this.resumeContext();
      this.warmCriticalSounds();
    }
  }

  /** Ensures table music and compressed cues are ready when a match is entered. */
  preloadMatch(): void {
    if (!this.enabled) return;
    for (const cue of Object.keys(SOUND_SOURCES) as SoundCue[]) void this.loadEncodedAudio(cue);
  }

  /** Must be called from a trusted pointer or keyboard event on mobile browsers. */
  unlock(): void {
    const wasUnlocked = this.unlocked;
    this.unlocked = true;
    void this.resumeContext();
    if (this.enabled && !wasUnlocked) {
      this.warmCriticalSounds();
    }
  }

  play(cue: Exclude<SoundCue, "heartbeat">, delayMs = 0): void {
    if (!this.enabled || !this.unlocked) return;
    const context = this.ensureContext();
    if (!context) {
      this.playFallback(cue, false, delayMs);
      return;
    }
    void this.resumeContext();
    const generation = this.generation;
    void this.loadBuffer(cue, context).then((buffer) => {
      if (generation !== this.generation || context !== this.context) return;
      if (!buffer || !this.enabled || !this.unlocked) {
        if (!buffer) this.playFallback(cue, false, delayMs);
        return;
      }
      const source = context.createBufferSource();
      const gain = context.createGain();
      source.buffer = buffer;
      gain.gain.value = SOUND_VOLUME[cue];
      source.connect(gain);
      gain.connect(this.output ?? context.destination);
      source.start(context.currentTime + Math.max(0, delayMs) / 1000);
    });
  }

  startHeartbeat(): boolean {
    if (!this.enabled || !this.unlocked || this.heartbeatRequested) return false;
    this.heartbeatRequested = true;
    const context = this.ensureContext();
    if (!context) {
      this.playFallback("heartbeat", true);
      return true;
    }
    void this.resumeContext();
    const generation = this.generation;
    void this.loadBuffer("heartbeat", context).then((buffer) => {
      if (generation !== this.generation || context !== this.context) return;
      if (!buffer) {
        if (this.enabled && this.heartbeatRequested && !this.fallbackHeartbeat) this.playFallback("heartbeat", true);
        return;
      }
      if (!this.enabled || !this.heartbeatRequested || this.heartbeatSource) return;
      const source = context.createBufferSource();
      const gain = context.createGain();
      source.buffer = buffer;
      source.loop = true;
      gain.gain.value = SOUND_VOLUME.heartbeat;
      source.connect(gain);
      gain.connect(this.output ?? context.destination);
      source.addEventListener("ended", () => {
        if (this.heartbeatSource === source) this.heartbeatSource = undefined;
      }, { once: true });
      this.heartbeatSource = source;
      source.start();
    });
    return true;
  }

  resume(): void { void this.resumeContext(); }

  stopHeartbeat(): void {
    this.heartbeatRequested = false;
    if (this.heartbeatSource) {
      try { this.heartbeatSource.stop(); } catch { /* The source may already have ended. */ }
      this.heartbeatSource.disconnect();
      this.heartbeatSource = undefined;
    }
    if (this.fallbackHeartbeat) {
      this.fallbackHeartbeat.pause();
      this.fallbackHeartbeat.currentTime = 0;
      this.fallbackHeartbeat = undefined;
    }
  }

  private ensureContext(): AudioContext | undefined {
    if (this.context) return this.context;
    const AudioCtor = window.AudioContext ?? (window as WindowWithWebkitAudio).webkitAudioContext;
    if (!AudioCtor) return undefined;
    this.context = new AudioCtor({ latencyHint: "interactive" });
    this.output = this.context.createGain();
    this.output.connect(this.context.destination);
    return this.context;
  }

  private async resumeContext(): Promise<void> {
    const context = this.ensureContext();
    if (context?.state === "suspended") {
      try { await context.resume(); } catch { /* Audio remains best-effort. */ }
    }
  }

  private warmCriticalSounds(): void {
    if (this.criticalSoundsWarmed) return;
    const context = this.ensureContext();
    if (!context) return;
    this.criticalSoundsWarmed = true;
    // Decode sequentially to keep UI work responsive while ensuring the whole
    // draw reveal and confirm → heartbeat → revolver path are ready before use.
    void (async () => {
      const generation = this.generation;
      for (const cue of ["skillDraw", "stand", "heartbeat", "dryFire", "misfire", "gunshot"] as const) {
        if (generation !== this.generation) return;
        await this.loadBuffer(cue, context);
      }
    })();
  }

  private loadBuffer(cue: SoundCue, context: AudioContext): Promise<AudioBuffer | null> {
    const decoded = this.buffers.get(cue);
    if (decoded) return Promise.resolve(decoded);
    const pending = this.pendingBuffers.get(cue);
    if (pending) return pending;
    const generation = this.generation;
    const request = this.loadEncodedAudio(cue)
      .then((data) => data ? context.decodeAudioData(data.slice(0)) : null)
      .then((buffer) => {
        if (buffer && generation === this.generation) this.buffers.set(cue, buffer);
        return buffer;
      })
      .catch(() => null)
      .finally(() => { if (this.pendingBuffers.get(cue) === request) this.pendingBuffers.delete(cue); });
    this.pendingBuffers.set(cue, request);
    return request;
  }

  private loadEncodedAudio(cue: SoundCue): Promise<ArrayBuffer | null> {
    const encoded = this.encodedAudio.get(cue);
    if (encoded) return Promise.resolve(encoded);
    const pending = this.pendingAudio.get(cue);
    if (pending) return pending;
    const controller = new AbortController();
    this.fetchControllers.add(controller);
    const generation = this.generation;
    const request = fetch(SOUND_SOURCES[cue], { cache: "force-cache", signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Audio request failed: ${response.status}`);
        return response.arrayBuffer();
      })
      .then((data) => {
        if (generation === this.generation) this.encodedAudio.set(cue, data);
        return data;
      })
      .catch(() => null)
      .finally(() => {
        this.fetchControllers.delete(controller);
        if (this.pendingAudio.get(cue) === request) this.pendingAudio.delete(cue);
      });
    this.pendingAudio.set(cue, request);
    return request;
  }

  private playFallback(cue: SoundCue, loop: boolean, delayMs = 0): void {
    const generation = this.generation;
    const sample = new Audio(SOUND_SOURCES[cue]);
    this.fallbackVoices.add(sample);
    sample.addEventListener?.("ended", () => this.fallbackVoices.delete(sample), { once: true });
    sample.loop = loop;
    sample.volume = SOUND_VOLUME[cue];
    if (cue === "heartbeat") this.fallbackHeartbeat = sample;
    const start = () => {
      if (generation !== this.generation || !this.enabled || !this.unlocked) return;
      void sample.play().catch(() => undefined);
    };
    if (delayMs > 0) {
      const timer = window.setTimeout(() => {
        this.fallbackTimers.delete(timer);
        start();
      }, delayMs);
      this.fallbackTimers.add(timer);
    }
    else start();
  }

  async dispose(): Promise<void> {
    for (const effect of [...this.effects]) effect.dispose();
    this.generation += 1;
    this.stopHeartbeat();
    for (const timer of this.fallbackTimers) globalThis.clearTimeout(timer);
    this.fallbackTimers.clear();
    for (const voice of this.fallbackVoices) voice.pause();
    this.fallbackVoices.clear();
    for (const controller of this.fetchControllers) controller.abort();
    this.fetchControllers.clear();
    this.encodedAudio.clear();
    this.pendingAudio.clear();
    this.buffers.clear();
    this.pendingBuffers.clear();
    this.unlocked = false;
    this.criticalSoundsWarmed = false;
    const context = this.context;
    this.context = undefined;
    this.output = undefined;
    if (context && context.state !== "closed") await context.close().catch(() => undefined);
  }
}

import type { PluginSound } from "./plugin-audio";
import { LOBBY_BGM_URL, TABLE_BGM_URL } from "../resources/cache-policy";

export const SOUND_SOURCES = {
  shuffle: "/assets/audio/sfx/card-shuffle.mp3",
  cardFlip: "/assets/audio/sfx/card-flip.ogg",
  blackjack: "/assets/audio/sfx/blackjack.ogg",
  bust: "/assets/audio/sfx/bust.ogg",
  compare: "/assets/audio/sfx/compare.ogg",
  result: "/assets/audio/sfx/result.ogg",
  stand: "/assets/audio/sfx/stand.ogg",
  /** Dedicated routing keys; replace these assets when the final skill SFX are available. */
  skillDraw: "/assets/audio/sfx/stand.ogg",
  skillUse: "/assets/audio/sfx/stand.ogg",
  heartbeat: "/assets/audio/sfx/heartbeat.ogg",
  dryFire: "/assets/audio/sfx/revolver-dry-fire.ogg",
  /** Dedicated routing key; replace this asset when the final misfire SFX is available. */
  misfire: "/assets/audio/sfx/revolver-dry-fire.ogg",
  gunshot: "/assets/audio/sfx/revolver-gunshot.ogg"
} as const;

export type SoundCue = keyof typeof SOUND_SOURCES;

const SOUND_VOLUME: Readonly<Record<SoundCue, number>> = {
  shuffle: 0.56,
  cardFlip: 0.62,
  blackjack: 0.66,
  bust: 0.7,
  compare: 0.64,
  result: 0.74,
  stand: 0.76,
  skillDraw: 0.76,
  skillUse: 0.76,
  heartbeat: 0.34,
  dryFire: 0.72,
  misfire: 0.72,
  gunshot: 0.78
};

const BGM_VOLUME = 0.18;
const DUCKED_BGM_VOLUME = 0.08;
const BGM_FADE_DURATION_MS = 800;
const BGM_FADE_STEP_MS = 40;
const TABLE_BGM_PRELOAD_DELAY_MS = 1200;

export type BgmScene = "lobby" | "match";

const BGM_SOURCES: Readonly<Record<BgmScene, string>> = {
  lobby: LOBBY_BGM_URL,
  match: TABLE_BGM_URL
};

type AudioContextConstructor = typeof AudioContext;

interface WindowWithWebkitAudio extends Window {
  webkitAudioContext?: AudioContextConstructor;
}

/**
 * Presentation-only audio service. Short effects use decoded Web Audio buffers
 * for low latency; long BGM tracks are streamed by HTMLAudioElement to keep memory
 * use reasonable on Android devices.
 */
export class GameAudio {
  private enabled = true;
  private unlocked = false;
  private context?: AudioContext;
  private output?: GainNode;
  private readonly bgm = new Map<BgmScene, HTMLAudioElement>();
  private readonly requestedBgmLoads = new Set<BgmScene>();
  private desiredBgmScene: BgmScene = "lobby";
  private activeBgmScene?: BgmScene;
  private bgmVolume = BGM_VOLUME;
  private bgmFadeTimer?: ReturnType<typeof setInterval>;
  private bgmTransitionId = 0;
  private tableBgmPreloadScheduled = false;
  private tableBgmPreloadTimer?: ReturnType<typeof globalThis.setTimeout>;
  private readonly encodedAudio = new Map<SoundCue, ArrayBuffer>();
  private readonly pendingAudio = new Map<SoundCue, Promise<ArrayBuffer | null>>();
  private readonly buffers = new Map<SoundCue, AudioBuffer>();
  private readonly pendingBuffers = new Map<SoundCue, Promise<AudioBuffer | null>>();
  private criticalSoundsWarmed = false;
  private heartbeatRequested = false;
  private heartbeatSource?: AudioBufferSourceNode;
  private fallbackHeartbeat?: HTMLAudioElement;
  private readonly fetchControllers = new Set<AbortController>();
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
    const wasEnabled = this.enabled;
    this.enabled = enabled;
    if (!enabled) {
      this.effects.forEach((effect) => effect.stop());
      this.stopHeartbeat();
      this.pauseBgm();
      return;
    }
    if (this.unlocked) {
      void this.resumeContext();
      this.warmCriticalSounds();
      this.playBgm();
    }
    if (!wasEnabled) this.preloadLobby();
  }

  /** Gives the lobby track a head start, then includes the table track in the initial load stage. */
  preloadLobby(): void {
    if (!this.enabled) return;
    this.requestBgmLoad("lobby");
    if (this.tableBgmPreloadScheduled || this.requestedBgmLoads.has("match")) return;
    this.tableBgmPreloadScheduled = true;
    this.tableBgmPreloadTimer = globalThis.setTimeout(() => {
      this.tableBgmPreloadTimer = undefined;
      this.tableBgmPreloadScheduled = false;
      if (this.enabled) this.requestBgmLoad("match");
    }, TABLE_BGM_PRELOAD_DELAY_MS);
  }

  /** Ensures table music and compressed cues are ready when a match is entered. */
  preloadMatch(): void {
    if (!this.enabled) return;
    this.requestBgmLoad("match");
    for (const cue of Object.keys(SOUND_SOURCES) as SoundCue[]) void this.loadEncodedAudio(cue);
  }

  setBgmScene(scene: BgmScene): void {
    const changed = this.desiredBgmScene !== scene;
    this.desiredBgmScene = scene;
    if (!this.enabled) return;
    this.requestBgmLoad(scene);
    if (this.unlocked && (changed || this.ensureBgm(scene).paused)) this.playBgm();
  }

  /** Must be called from a trusted pointer or keyboard event on mobile browsers. */
  unlock(): void {
    const wasUnlocked = this.unlocked;
    this.unlocked = true;
    void this.resumeContext();
    if (this.enabled && !wasUnlocked) {
      this.warmCriticalSounds();
      this.playBgm();
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
    void this.loadBuffer(cue, context).then((buffer) => {
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

  startHeartbeat(): void {
    if (!this.enabled || !this.unlocked || this.heartbeatRequested) return;
    this.heartbeatRequested = true;
    this.setBgmVolume(DUCKED_BGM_VOLUME);
    const context = this.ensureContext();
    if (!context) {
      this.playFallback("heartbeat", true);
      return;
    }
    void this.resumeContext();
    void this.loadBuffer("heartbeat", context).then((buffer) => {
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
  }

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
    this.setBgmVolume(BGM_VOLUME);
  }

  pauseBgm(): void {
    this.cancelBgmFade();
    for (const bgm of this.bgm.values()) bgm.pause();
  }

  restoreBgm(): void {
    if (!this.unlocked || !this.enabled) return;
    void this.resumeContext();
    this.playBgm();
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
    // confirm → heartbeat → revolver path is ready well before it is reached.
    void (async () => {
      for (const cue of ["stand", "heartbeat", "dryFire", "misfire", "gunshot"] as const) await this.loadBuffer(cue, context);
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
      .finally(() => this.pendingBuffers.delete(cue));
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
        this.pendingAudio.delete(cue);
      });
    this.pendingAudio.set(cue, request);
    return request;
  }

  private ensureBgm(scene: BgmScene): HTMLAudioElement {
    const existing = this.bgm.get(scene);
    if (existing) return existing;
    const bgm = new Audio(BGM_SOURCES[scene]);
    bgm.loop = true;
    bgm.preload = "auto";
    bgm.volume = scene === this.desiredBgmScene ? this.bgmVolume : 0;
    this.bgm.set(scene, bgm);
    return bgm;
  }

  private requestBgmLoad(scene: BgmScene): void {
    if (this.requestedBgmLoads.has(scene)) return;
    this.requestedBgmLoads.add(scene);
    this.ensureBgm(scene).load();
  }

  private playBgm(): void {
    if (!this.enabled || !this.unlocked || document.hidden) return;
    const scene = this.desiredBgmScene;
    const bgm = this.ensureBgm(scene);
    this.requestBgmLoad(scene);
    if (!bgm.paused && this.activeBgmScene === scene) {
      bgm.volume = this.bgmVolume;
      return;
    }
    const transitionId = ++this.bgmTransitionId;
    const wasPaused = bgm.paused;
    if (wasPaused) bgm.volume = 0;
    let playback: Promise<void>;
    try { playback = Promise.resolve(bgm.play()); }
    catch { return; }
    void playback.then(() => {
      if (transitionId !== this.bgmTransitionId || scene !== this.desiredBgmScene || !this.enabled || document.hidden) return;
      this.activeBgmScene = scene;
      this.fadeToBgm(scene);
    }).catch(() => undefined);
  }

  private setBgmVolume(volume: number): void {
    this.bgmVolume = volume;
    const active = this.bgm.get(this.desiredBgmScene);
    if (active && !active.paused) active.volume = volume;
  }

  private fadeToBgm(scene: BgmScene): void {
    this.cancelBgmFade();
    const next = this.ensureBgm(scene);
    const previous = [...this.bgm.entries()].filter(([candidate, bgm]) => candidate !== scene && !bgm.paused);
    const nextStartVolume = next.volume;
    const previousStartVolumes = previous.map(([, bgm]) => bgm.volume);
    let elapsed = 0;
    this.bgmFadeTimer = globalThis.setInterval(() => {
      elapsed += BGM_FADE_STEP_MS;
      const progress = Math.min(1, elapsed / BGM_FADE_DURATION_MS);
      next.volume = nextStartVolume + (this.bgmVolume - nextStartVolume) * progress;
      previous.forEach(([, bgm], index) => { bgm.volume = previousStartVolumes[index] * (1 - progress); });
      if (progress < 1) return;
      this.cancelBgmFade();
      previous.forEach(([, bgm]) => bgm.pause());
    }, BGM_FADE_STEP_MS);
  }

  private cancelBgmFade(): void {
    this.bgmTransitionId += 1;
    if (this.bgmFadeTimer === undefined) return;
    globalThis.clearInterval(this.bgmFadeTimer);
    this.bgmFadeTimer = undefined;
  }

  private playFallback(cue: SoundCue, loop: boolean, delayMs = 0): void {
    const sample = new Audio(SOUND_SOURCES[cue]);
    sample.loop = loop;
    sample.volume = SOUND_VOLUME[cue];
    if (cue === "heartbeat") this.fallbackHeartbeat = sample;
    const start = () => {
      if (!this.enabled || !this.unlocked) return;
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
    this.pauseBgm();
    this.cancelBgmFade();
    if (this.tableBgmPreloadTimer !== undefined) globalThis.clearTimeout(this.tableBgmPreloadTimer);
    this.tableBgmPreloadTimer = undefined;
    this.tableBgmPreloadScheduled = false;
    for (const timer of this.fallbackTimers) globalThis.clearTimeout(timer);
    this.fallbackTimers.clear();
    for (const controller of this.fetchControllers) controller.abort();
    this.fetchControllers.clear();
    for (const bgm of this.bgm.values()) {
      bgm.pause();
      bgm.removeAttribute("src");
      bgm.load();
    }
    this.bgm.clear();
    this.requestedBgmLoads.clear();
    this.encodedAudio.clear();
    this.pendingAudio.clear();
    this.buffers.clear();
    this.pendingBuffers.clear();
    this.activeBgmScene = undefined;
    this.desiredBgmScene = "lobby";
    this.unlocked = false;
    this.criticalSoundsWarmed = false;
    const context = this.context;
    this.context = undefined;
    this.output = undefined;
    if (context && context.state !== "closed") await context.close().catch(() => undefined);
  }
}

export const gameAudio = new GameAudio();

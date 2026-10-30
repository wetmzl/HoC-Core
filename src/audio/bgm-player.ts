import { LOBBY_BGM_URL, TABLE_BGM_URL } from "../resources/cache-policy";
import { DEFAULT_MUSIC_VOLUME } from "./music-volume";

const DUCKED_BGM_VOLUME = 0.08;
const BGM_FADE_DURATION_MS = 800;
const BGM_FADE_STEP_MS = 40;
const TABLE_BGM_PRELOAD_DELAY_MS = 1200;

export type BgmScene = "lobby" | "match";

export class BgmPlayer {
  private enabled = true;
  private unlocked = false;
  private readonly bgm = new Map<string, HTMLAudioElement>();
  private readonly bgmGains = new Map<string, number>();
  private readonly requestedBgmLoads = new Set<string>();
  private readonly failedSources = new Set<string>();
  private matchSources: readonly string[] = [TABLE_BGM_URL];
  private desiredBgmScene: BgmScene = "lobby";
  private activeBgmUrl?: string;
  private musicVolume = DEFAULT_MUSIC_VOLUME;
  private ducked = false;
  private bgmVolume = DEFAULT_MUSIC_VOLUME;
  private bgmFadeTimer?: ReturnType<typeof setInterval>;
  private bgmTransitionId = 0;
  private tableBgmPreloadTimer?: ReturnType<typeof globalThis.setTimeout>;

  /** URLs are owned by the content runtime. This player only owns media elements. */
  setMatchMusic(sources: readonly string[] = []): void {
    const next = [...new Set([...sources.filter(source => source && source !== TABLE_BGM_URL), TABLE_BGM_URL])];
    if (next.length === this.matchSources.length && next.every((url, index) => url === this.matchSources[index])) return;
    this.matchSources = next;
    this.failedSources.clear();
    if (this.desiredBgmScene === "match") {
      if (this.enabled) this.requestBgmLoad("match");
      if (this.enabled && this.unlocked) this.playBgm();
    }
    this.pruneBgm();
  }

  preloadLobby(): void {
    if (!this.enabled) return;
    this.requestBgmLoad("lobby");
    if (this.tableBgmPreloadTimer !== undefined) return;
    this.tableBgmPreloadTimer = globalThis.setTimeout(() => {
      this.tableBgmPreloadTimer = undefined;
      if (this.enabled) this.requestBgmLoad("match");
    }, TABLE_BGM_PRELOAD_DELAY_MS);
  }

  setBgmScene(scene: BgmScene): void {
    this.desiredBgmScene = scene;
    if (!this.enabled) return;
    this.requestBgmLoad(scene);
    if (this.unlocked) this.playBgm();
  }

  pauseBgm(): void {
    this.cancelBgmFade();
    for (const bgm of this.bgm.values()) bgm.pause();
    this.pruneBgm();
  }

  restoreBgm(): void {
    if (this.unlocked && this.enabled) this.playBgm();
  }

  configure(enabled: boolean): void {
    const wasEnabled = this.enabled;
    this.enabled = enabled;
    if (!enabled) this.pauseBgm();
    else {
      if (!wasEnabled) this.preloadLobby();
      if (this.unlocked) this.playBgm();
    }
  }
  unlock(): void { this.unlocked = true; if (this.enabled) this.playBgm(); }
  preloadMatch(): void { if (this.enabled) this.requestBgmLoad("match"); }
  setMusicVolume(volume = DEFAULT_MUSIC_VOLUME): void {
    if (!Number.isFinite(volume) || volume < 0 || volume > 1) return;
    this.musicVolume = volume;
    this.updateBgmVolume();
  }
  duck(active: boolean): void { this.ducked = active; this.updateBgmVolume(); }

  private source(scene: BgmScene): string | undefined {
    return (scene === "lobby" ? [LOBBY_BGM_URL] : this.matchSources).find(url => !this.failedSources.has(url));
  }

  private ensureBgm(url: string): HTMLAudioElement {
    const existing = this.bgm.get(url);
    if (existing) return existing;
    const bgm = new Audio(url);
    bgm.loop = true;
    bgm.preload = "auto";
    bgm.volume = 0;
    bgm.onerror = () => this.failSource(url, bgm);
    this.bgm.set(url, bgm);
    this.bgmGains.set(url, 0);
    return bgm;
  }

  private requestBgmLoad(scene: BgmScene): void {
    const url = this.source(scene);
    if (!url || this.requestedBgmLoads.has(url)) return;
    this.requestedBgmLoads.add(url);
    this.ensureBgm(url).load();
  }

  private failSource(url: string, element: HTMLAudioElement): void {
    if (this.bgm.get(url) !== element || this.failedSources.has(url)) return;
    const wasDesired = this.source(this.desiredBgmScene) === url;
    this.failedSources.add(url);
    if (wasDesired) this.cancelBgmFade();
    element.pause();
    this.releaseBgm(url, element);
    if (wasDesired && this.enabled) {
      this.requestBgmLoad(this.desiredBgmScene);
      if (this.unlocked) this.playBgm();
    }
  }

  private playBgm(): void {
    if (!this.enabled || !this.unlocked || document.hidden) return;
    const url = this.source(this.desiredBgmScene);
    if (!url) { this.pauseBgm(); return; }
    const bgm = this.ensureBgm(url);
    if (!bgm.paused && this.activeBgmUrl === url) {
      if (this.bgmFadeTimer === undefined) this.setBgmGain(url, 1);
      return;
    }
    this.cancelBgmFade();
    const transitionId = this.bgmTransitionId;
    this.requestBgmLoad(this.desiredBgmScene);
    if (bgm.paused) this.setBgmGain(url, 0);
    const failed = (error: unknown) => {
      // Autoplay policy requires a later user gesture, not a different song.
      if ((error as { name?: string } | null)?.name === "NotSupportedError") this.failSource(url, bgm);
    };
    let playback: Promise<void>;
    try { playback = Promise.resolve(bgm.play()); }
    catch (error) { failed(error); return; }
    void playback.then(() => {
      if (this.bgm.get(url) !== bgm || transitionId !== this.bgmTransitionId || url !== this.source(this.desiredBgmScene) || !this.enabled || document.hidden) {
        if (this.bgm.get(url) !== bgm || url !== this.source(this.desiredBgmScene) || !this.enabled || document.hidden) bgm.pause();
        this.pruneBgm();
        return;
      }
      this.activeBgmUrl = url;
      this.fadeToBgm(url);
    }).catch(failed);
  }

  private updateBgmVolume(): void {
    this.bgmVolume = this.musicVolume * (this.ducked ? DUCKED_BGM_VOLUME / DEFAULT_MUSIC_VOLUME : 1);
    for (const [url, bgm] of this.bgm) bgm.volume = this.bgmVolume * (this.bgmGains.get(url) ?? 0);
  }

  private setBgmGain(url: string, gain: number): void {
    this.bgmGains.set(url, gain);
    this.bgm.get(url)!.volume = this.bgmVolume * gain;
  }

  private fadeToBgm(url: string): void {
    this.ensureBgm(url);
    const previous = [...this.bgm.entries()].filter(([candidate, bgm]) => candidate !== url && !bgm.paused);
    const nextStartGain = this.bgmGains.get(url) ?? 0;
    const previousStartGains = previous.map(([candidate]) => this.bgmGains.get(candidate) ?? 0);
    let elapsed = 0;
    this.bgmFadeTimer = globalThis.setInterval(() => {
      elapsed += BGM_FADE_STEP_MS;
      const progress = Math.min(1, elapsed / BGM_FADE_DURATION_MS);
      this.setBgmGain(url, nextStartGain + (1 - nextStartGain) * progress);
      previous.forEach(([candidate], index) => { this.setBgmGain(candidate, previousStartGains[index] * (1 - progress)); });
      if (progress < 1) return;
      this.cancelBgmFade();
      previous.forEach(([, bgm]) => bgm.pause());
      this.pruneBgm();
    }, BGM_FADE_STEP_MS);
  }

  private cancelBgmFade(): void {
    this.bgmTransitionId += 1;
    if (this.bgmFadeTimer === undefined) return;
    globalThis.clearInterval(this.bgmFadeTimer);
    this.bgmFadeTimer = undefined;
  }

  private releaseBgm(url: string, bgm: HTMLAudioElement): void {
    bgm.onerror = null;
    bgm.pause();
    bgm.removeAttribute("src");
    bgm.load();
    this.bgm.delete(url);
    this.bgmGains.delete(url);
    this.requestedBgmLoads.delete(url);
    if (this.activeBgmUrl === url) this.activeBgmUrl = undefined;
  }

  private pruneBgm(): void {
    for (const [url, bgm] of this.bgm) {
      if (bgm.paused && url !== LOBBY_BGM_URL && url !== this.source("match")) this.releaseBgm(url, bgm);
    }
  }

  dispose(): void {
    this.pauseBgm();
    if (this.tableBgmPreloadTimer !== undefined) globalThis.clearTimeout(this.tableBgmPreloadTimer);
    this.tableBgmPreloadTimer = undefined;
    for (const [url, bgm] of this.bgm) this.releaseBgm(url, bgm);
    this.failedSources.clear(); this.matchSources = [TABLE_BGM_URL];
    this.desiredBgmScene = "lobby"; this.musicVolume = this.bgmVolume = DEFAULT_MUSIC_VOLUME; this.ducked = false; this.unlocked = false;
  }
}

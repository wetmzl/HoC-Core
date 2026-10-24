import type { PluginSound } from "./plugin-audio";
import { BgmPlayer, type BgmScene } from "./bgm-player";
import { SoundPlayer } from "./sound-player";
import type { SoundCue } from "./sound-resources";
export { SOUND_SOURCES, type SoundCue } from "./sound-resources";
export type { BgmScene } from "./bgm-player";

/** Stable audio facade shared by the runtime and package-owned effects. */
export class GameAudio {
  private readonly music = new BgmPlayer();
  private readonly sounds = new SoundPlayer();
  createEffect(url: string, release: () => void): PluginSound { return this.sounds.createEffect(url, release); }
  configure(enabled: boolean): void { this.sounds.configure(enabled); this.music.configure(enabled); if (!enabled) this.music.duck(false); }
  preloadLobby(): void { this.music.preloadLobby(); }
  preloadMatch(): void { this.music.preloadMatch(); this.sounds.preloadMatch(); }
  setMatchMusic(sources: readonly string[] = []): void { this.music.setMatchMusic(sources); }
  setBgmScene(scene: BgmScene): void { this.music.setBgmScene(scene); }
  unlock(): void { this.sounds.unlock(); this.music.unlock(); }
  play(cue: Exclude<SoundCue, "heartbeat">, delayMs = 0): void { this.sounds.play(cue, delayMs); }
  startHeartbeat(): void { if (this.sounds.startHeartbeat()) this.music.duck(true); }
  stopHeartbeat(): void { this.sounds.stopHeartbeat(); this.music.duck(false); }
  pauseBgm(): void { this.music.pauseBgm(); }
  restoreBgm(): void { this.sounds.resume(); this.music.restoreBgm(); }
  async dispose(): Promise<void> { this.music.dispose(); await this.sounds.dispose(); }
}
export const gameAudio = new GameAudio();

import { MusicDirector } from "./music-director";
import type { InstalledMusicResource } from "../content/packages/music";
import type { GameEvent, MatchState } from "../core/match/types";
import type { MatchFactBatch } from "../core/events";
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
  readonly musicDirector = new MusicDirector(candidates => this.music.setCandidates(this.musicDirector.status().scene, candidates, {
    failed: track => this.musicDirector.failedTrack(track), ended: id => this.musicDirector.ended(id), playing: candidate => this.musicDirector.playing(candidate)
  }));
  private musicMatchId?: string;
  installMusic(resources: readonly InstalledMusicResource[]): void { this.musicDirector.install(resources); }
  updateMusicContext(match?: MatchState, events: readonly GameEvent[] = [], restored = false): void {
    if (this.musicMatchId !== match?.id) this.music.resetPositions();
    this.musicMatchId = match?.id;
    this.musicDirector.updateMatch(match, events, restored);
  }
  updateMusicFacts(batch: MatchFactBatch): void {
    this.updateMusicContext(batch.after, batch.facts.map(fact => fact.event), batch.restored);
  }
  createEffect(url: string, release: () => void): PluginSound { return this.sounds.createEffect(url, release); }
  configure(enabled: boolean, musicVolume?: number): void { if (musicVolume !== undefined) this.music.setMusicVolume(musicVolume); this.sounds.configure(enabled); this.music.configure(enabled); if (!enabled) this.music.duck(false); }
  setMusicVolume(volume: number): void { this.music.setMusicVolume(volume); }
  preloadLobby(): void { this.music.preloadLobby(); }
  preloadMatch(): void { this.music.preloadMatch(); this.sounds.preloadMatch(); }
  setMatchMusic(sources: readonly string[] = [], priorities?: readonly ("character" | "faction")[]): void { this.musicDirector.setLegacy(sources, priorities); }
  setBgmScene(scene: BgmScene): void { this.musicDirector.setScene(scene); this.music.setBgmScene(scene); }
  unlock(): void { this.sounds.unlock(); this.music.unlock(); }
  play(cue: Exclude<SoundCue, "heartbeat">, delayMs = 0): void { this.sounds.play(cue, delayMs); }
  playAchievementUnlock(): void {
    if (typeof document !== "undefined" && document.hidden) return;
    this.sounds.stop("achievementUnlock");
    this.sounds.play("achievementUnlock");
  }
  stopAchievementUnlock(): void { this.sounds.stop("achievementUnlock"); }
  startHeartbeat(): void { if (this.sounds.startHeartbeat()) this.music.duck(true); }
  stopHeartbeat(): void { this.sounds.stopHeartbeat(); this.music.duck(false); }
  pauseBgm(): void { this.stopAchievementUnlock(); this.music.pauseBgm(); }
  restoreBgm(): void { this.sounds.resume(); this.music.restoreBgm(); }
  async dispose(): Promise<void> { this.music.dispose(); this.musicDirector.dispose(); this.musicMatchId = undefined; await this.sounds.dispose(); }
}
export const gameAudio = new GameAudio();

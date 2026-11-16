/** Narrow presentation contracts for independently built plugins. */
export interface PluginSoundOptions { readonly volume?: number; readonly signal?: AbortSignal; readonly loop?: boolean }
export interface PluginSound {
  play(options?: PluginSoundOptions): void;
  /** Completion includes blocked autoplay, disabled sound and cancellation. */
  playAndWait?(options?: PluginSoundOptions): Promise<void>;
  setPaused?(paused: boolean): void;
  dispose(): void;
}
export interface PluginAudio {
  setBgmScene(scene: "lobby" | "match"): void;
}
export interface PluginSoundFactory { createEffect(path: string): Promise<PluginSound> }

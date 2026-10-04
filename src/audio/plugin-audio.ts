/** Narrow presentation contracts for independently built plugins. */
export interface PluginSoundOptions { readonly volume?: number; readonly signal?: AbortSignal }
export interface PluginSound {
  play(options?: PluginSoundOptions): void;
  dispose(): void;
}
export interface PluginAudio {
  setBgmScene(scene: "lobby" | "match"): void;
}
export interface PluginSoundFactory { createEffect(path: string): Promise<PluginSound> }

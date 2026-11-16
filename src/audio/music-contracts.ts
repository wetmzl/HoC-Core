import type { DeepReadonly } from "../dialogue/types";
import type { GameEvent, MatchState } from "../core/match/types";

export const MUSIC_PRIORITIES = { core: 0, background: 10, faction: 20, character: 30, override: 40, conditional: 50, temporary: 60 } as const;
export type MusicPriority = keyof typeof MUSIC_PRIORITIES;
export type PluginMusicPriority = "background" | "override" | "conditional" | "temporary";
export type MusicScene = "lobby" | "match";
export interface MusicRequest {
  /** Qualified track identity: author/package#resource/track. */
  readonly track: string;
  readonly priority: PluginMusicPriority;
  readonly scope: "scene" | "match" | "runtime";
  readonly loop?: boolean;
  readonly transitionMs?: number;
  readonly restart?: boolean;
}
export interface MusicContext {
  readonly scene: MusicScene;
  readonly match?: DeepReadonly<MatchState>;
  readonly characterId?: string;
  readonly events: readonly DeepReadonly<GameEvent>[];
  readonly restored: boolean;
}
export interface PluginMusicApi {
  set(id: string, request: MusicRequest): void;
  release(id: string): void;
  /** Immediate snapshot has no historical events. The runtime always owns cleanup. */
  subscribeContext(listener: (context: MusicContext) => void, options?: { readonly signal?: AbortSignal }): () => void;
}
export interface MusicCandidate {
  readonly id: string;
  readonly track: string;
  readonly url: string;
  readonly title: string;
  readonly packageId: string;
  readonly priority: MusicPriority;
  readonly order: number;
  readonly loop: boolean;
  readonly transitionMs: number;
  readonly restart?: boolean;
}
export interface MusicStatus {
  readonly scene: MusicScene;
  readonly current?: MusicCandidate;
  readonly candidates: readonly MusicCandidate[];
  readonly failedTracks: readonly string[];
  readonly packages: readonly { readonly id: string; readonly title: string }[];
}

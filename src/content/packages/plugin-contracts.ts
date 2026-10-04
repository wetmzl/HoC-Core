import type { GameEvent } from "../../core/match/types";
import type { PluginAudio, PluginSoundFactory } from "../../audio/plugin-audio";
import type { HapticsApi } from "../../presentation/haptic-service";
import type { CharacterDefinition, CharacterMetadata } from "../characters";
import type { MatchHistoryRecord } from "../../core/match/history";
import type { LongTermSave } from "../../persistence/schema";
import type { ResourceLoader } from "../../resources/resource-loader";
import type { SkillTag } from "../../core/skills/types";
import type { MountedScreen } from "../../runtime/contracts";
import type { HocpkgResourceHandler, ExtensionResource } from "./resources";

export interface PluginHostApi {
  getCharacterMetadata(id: string): CharacterMetadata | undefined;
  loadCharacter(id: string): Promise<CharacterDefinition>;
  readonly haptics: HapticsApi;
  readonly audio: PluginSoundFactory;
  resolveAsset(path: string): Promise<string>;
}

export interface PluginRuntimeContext {
  readonly root: HTMLDivElement;
  readonly audio: PluginAudio;
  readonly resources: ResourceLoader;
  getSave(): LongTermSave;
  navigateToHistory(): Promise<void>;
  navigateToExtension(route: string): Promise<void>;
}

export interface PluginMatchEvents {
  readonly opponentId: string;
  readonly events: readonly GameEvent[];
}

export interface PluginSkillSelection {
  readonly tag: SkillTag;
  readonly selected: boolean;
}

export interface PluginRuntimeContribution {
  /** Emitted only when a user changes a skill archetype selection; cancelled on runtime exit. */
  presentSkillSelection?(context: PluginSkillSelection, signal: AbortSignal): void | Promise<void>;
  presentMatchEvents?(context: PluginMatchEvents, signal: AbortSignal): void | Promise<void>;
  readonly skillArchetypeArt?: Partial<Record<SkillTag, { readonly default?: string; readonly selected?: string }>>;
  enhanceHistory?(context: PluginRuntimeContext, signal: AbortSignal): void | (() => void);
  mountHistoryDetail?(context: PluginRuntimeContext, content: HTMLElement, record: MatchHistoryRecord, signal: AbortSignal): void | (() => void) | Promise<void | (() => void)>;
  readonly routes?: Readonly<Record<string, (context: PluginRuntimeContext, signal: AbortSignal) => Promise<MountedScreen>>>;
  saveCoverCandidates?(save: LongTermSave): Promise<readonly string[]>;
}

export interface PluginRegistration {
  readonly handlers: readonly HocpkgResourceHandler[];
  createRuntime(extensions: Readonly<Record<string, readonly ExtensionResource[]>>): PluginRuntimeContribution;
}

export interface PluginModule {
  register(host: PluginHostApi): PluginRegistration | Promise<PluginRegistration>;
}

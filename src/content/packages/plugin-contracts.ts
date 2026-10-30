import type { DialoguePrimitive, DialogueSelection } from "../../dialogue/types";
import type { GameEvent } from "../../core/match/types";
import type { PluginAudio, PluginSoundFactory } from "../../audio/plugin-audio";
import type { HapticsApi } from "../../presentation/haptic-service";
import type { CharacterAppearance, CharacterDefinition, CharacterMetadata } from "../characters";
import type { MatchHistoryRecord } from "../../core/match/history";
import type { LongTermSave } from "../../persistence/schema";
import type { ResourceLoader } from "../../resources/resource-loader";
import type { SkillTag } from "../../core/skills/types";
import type { MountedScreen } from "../../runtime/contracts";
import type { HocpkgResourceHandler, ExtensionResource } from "./resources";
import type { PluginSettingsApi } from "./plugin-declarations";

export interface PluginHostApi {
  /** Package-scoped preferences. API v3 declarations are validated before registration. */
  readonly settings?: PluginSettingsApi;
  getCharacterMetadata(id: string): CharacterMetadata | undefined;
  loadCharacter(id: string): Promise<CharacterDefinition>;
  readonly haptics: HapticsApi;
  readonly audio: PluginSoundFactory;
  resolveAsset(path: string): Promise<string>;
}

/** Presentation preferences are independent of match state and plugin settings. */
export interface PluginCharacterPresentationApi {
  /** Returns a detached snapshot; missing characters or catalogs return undefined. */
  get(characterId: string): CharacterAppearance | undefined;
  /**
   * Prepares and durably commits a skin, then rebuilds plugin contributions.
   * Cancellation before activation rolls back. Activation may end the caller's
   * runtime subscription without rejecting a committed selection. Existing
   * contributed pages refresh themselves after resolution; their media remains
   * available until signal ends. Active matches reject changes.
   */
  select(characterId: string, skinId: string, signal: AbortSignal): Promise<void>;
}

export interface PluginRuntimeContext {
  /** Core-owned durable skin progress (API 12). Only the initial skin is unlocked by default. */
  readonly characterSkinUnlocks?: PluginCharacterSkinUnlocksApi;
  /** Available when this runtime can prepare character appearances (API 11). */
  readonly characterPresentation?: PluginCharacterPresentationApi;
  readonly root: HTMLDivElement;
  readonly audio: PluginAudio;
  readonly resources: ResourceLoader;
  getSave(): LongTermSave;
  navigateToHistory(): Promise<void>;
  navigateToExtension(route: string): Promise<void>;
}

export interface PluginCharacterSkinUnlockState {
  readonly id: string;
  readonly name: string;
  readonly unlocked: boolean;
  readonly unlock?: import("../characters/skin-unlock").SkinUnlockCondition;
}

export interface PluginCharacterSkinUnlocksApi {
  /** Detached catalog snapshot; unavailable characters return undefined. */
  get(characterId: string): readonly PluginCharacterSkinUnlockState[] | undefined;
  /** Unknown characters/skins return false. */
  isUnlocked(characterId: string, skinId: string): boolean;
  /** Atomic batch: unknown skins and locking the equipped skin reject without writing. */
  setMany(characterId: string, changes: Readonly<Record<string, boolean>>): Promise<void>;
  setUnlocked(characterId: string, skinId: string, unlocked: boolean): Promise<void>;
  unlock(characterId: string, skinId: string): Promise<void>;
  lock(characterId: string, skinId: string): Promise<void>;
  /** Restore initial-skin-only access; switch to the initial skin first. */
  reset(characterId: string): Promise<void>;
}

export interface PluginMatchEvents {
  readonly opponentId: string;
  readonly events: readonly GameEvent[];
}

export interface PluginSkillSelection {
  readonly tag: SkillTag;
  readonly selected: boolean;
}

/** A committed visible selection; restored sessions are marked so effects can stay silent. */
export interface PluginDialoguePresentation extends DialogueSelection {
  readonly matchId: string;
  readonly characterId: string;
  readonly restored: boolean;
}

export interface PluginGameRuntimeContext extends PluginRuntimeContext {
  /** Available to API 10 modules; completion and requests belong to this package. */
  readonly tutorials?: import("./plugin-tutorials").PluginTutorialApi;
  readonly game: {
    getMatch(): import("../../core/match/types").MatchState | undefined;
    subscribe(listener: () => void): () => void;
    configureAbility(binding: import("../../core/abilities/types").AbilityBinding): void;
    invokeAbility(definitionId: string, parameters: Readonly<Record<string, string | number | boolean>>): void;
    pauseAutoActions(): () => void;
  };
  onVersionClick(listener: () => void): () => void;
  confirm(title: string, message: string, confirmLabel: string): Promise<boolean>;
  alert(title: string, message: string): Promise<void>;
}

export interface PluginRuntimeContribution {
  presentDialogue?(context: PluginDialoguePresentation, signal: AbortSignal): void | Promise<void>;
  readonly uiActions?: readonly import("./plugin-ui").PluginUiAction[];
  mountRuntime?(context: PluginGameRuntimeContext, signal: AbortSignal): void | (() => void) | Promise<void | (() => void)>;
  initialAbilities?(): readonly import("../../core/abilities/types").AbilityBinding[];
  readonly dialogueSource?: MountedDialogueSource;
  /** Emitted only when a user changes a skill archetype selection; cancelled on runtime exit. */
  presentSkillSelection?(context: PluginSkillSelection, signal: AbortSignal): void | Promise<void>;
  presentMatchEvents?(context: PluginMatchEvents, signal: AbortSignal): void | Promise<void>;
  readonly skillArchetypeArt?: Partial<Record<SkillTag, { readonly default?: string; readonly selected?: string }>>;
  enhanceHistory?(context: PluginRuntimeContext, signal: AbortSignal): void | (() => void);
  mountHistoryDetail?(context: PluginRuntimeContext, content: HTMLElement, record: MatchHistoryRecord, signal: AbortSignal): void | (() => void) | Promise<void | (() => void)>;
  readonly routes?: Readonly<Record<string, (context: PluginRuntimeContext, signal: AbortSignal) => Promise<MountedScreen>>>;
  /** Ordered cover overrides; unavailable or absent candidates fall back to the built-in save card. */
  saveCoverCandidates?(save: LongTermSave): Promise<readonly string[]>;
}

export interface PluginRegistration {
  mountDialogueSource?(context: DialogueSourceContext, signal: AbortSignal): void | (() => void);
  readonly dialoguePrimitives?: readonly DialoguePrimitive[];
  readonly handlers: readonly HocpkgResourceHandler[];
  createRuntime(extensions: Readonly<Record<string, readonly ExtensionResource[]>>): PluginRuntimeContribution;
}

export interface PluginModule {
  register(host: PluginHostApi): PluginRegistration | Promise<PluginRegistration>;
}

export interface CharacterInteraction {
  readonly characterId: string;
  readonly image: { readonly packageId: string; readonly path: string };
  readonly x: number | null; readonly y: number | null;
}
export interface DialogueSourceContext {
  readonly matchId: string; readonly characterId: string; readonly restored: boolean;
  getMatch(): import("../../dialogue/types").DeepReadonly<import("../../core/match/types").MatchState>;
  /** State is owned by this package, validated and copied at both boundaries. */
  getPresentation(): unknown;
  setPresentation(state: unknown): void;
  publish(id: string, apiVersion: number, data: Readonly<Record<string, unknown>>): void;
  subscribeDialogueEvents(listener: (event: import("../../dialogue/types").DialogueEvent) => void): () => void;
  subscribeCharacterInteraction(listener: (interaction: CharacterInteraction) => void): () => void;
}
export interface MountedDialogueSource {
  readonly signal?: AbortSignal;
  readonly packageId: string;
  readonly declaration: import("./plugin-declarations").PresentationDeclaration;
  mount(context: DialogueSourceContext, signal: AbortSignal): void | (() => void);
}

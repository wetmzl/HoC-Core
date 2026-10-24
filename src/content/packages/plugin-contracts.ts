import type { DialoguePrimitive, DialogueSelection } from "../../dialogue/types";
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

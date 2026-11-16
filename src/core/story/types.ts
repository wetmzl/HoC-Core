import type { PublicCondition, PublicTriggerSpec } from "../events/triggers";
import type { PublicQuery, PublicQueryContext } from "../events/public-queries";

export const STORY_API_VERSION = 1;
export type StoryScalar = string | number | boolean | null;
export type StoryValue = { readonly type: "literal"; readonly value: StoryScalar } | { readonly type: "variable"; readonly key: string } | { readonly type: "query"; readonly query: PublicQuery };
export type StoryCondition = { readonly type: "all" | "any"; readonly conditions: readonly StoryCondition[] }
  | { readonly type: "not"; readonly condition: StoryCondition }
  | { readonly type: "public"; readonly condition: PublicCondition }
  | { readonly type: "compare"; readonly left: StoryValue; readonly operator: "eq" | "neq" | "lt" | "lte" | "gt" | "gte"; readonly right: StoryValue };
export interface StoryTransform { readonly x?: number; readonly y?: number; readonly scale?: number; readonly rotation?: number; readonly opacity?: number }
export interface StoryActorState extends Required<StoryTransform> { readonly id: string; readonly image?: string; readonly visible: boolean; readonly anchorX: number; readonly anchorY: number; readonly layer: number }
export interface StoryStage { readonly background?: string | null; readonly overlay: number; readonly actors: Readonly<Record<string, StoryActorState>> }
export interface StoryActorDefinition { readonly name: string; readonly image?: string; readonly images?: Readonly<Record<string, string>>; /** Default size, retained across expression changes unless an action overrides it. */ readonly scale?: number }
export type StoryTextSegment = { readonly text: string } | { readonly pauseMs: number };
export type StoryAction = { readonly type: "sequence" | "parallel"; readonly actions: readonly StoryAction[] }
  | { readonly type: "wait"; readonly durationMs: number }
  | { readonly type: "stage"; readonly background?: string | null; readonly overlay?: number; readonly actors?: readonly (StoryTransform & { readonly id: string; readonly image?: string; readonly visible?: boolean; readonly anchorX?: number; readonly anchorY?: number; readonly layer?: number })[]; readonly remove?: readonly string[] }
  | { readonly type: "animate"; readonly actor: string; readonly durationMs: number; readonly delayMs?: number; readonly easing?: "linear" | "ease" | "ease-in" | "ease-out" | "ease-in-out"; readonly keyframes: readonly (StoryTransform & { readonly offset?: number })[] }
  | { readonly type: "audio"; readonly channel: "sound" | "voice" | "music"; readonly operation: "play" | "stop"; readonly src?: string; readonly volume?: number; readonly loop?: boolean; readonly fadeMs?: number; readonly wait?: boolean }
  | { readonly type: "extension"; readonly typeId: string; readonly apiVersion: number; readonly args: Readonly<Record<string, unknown>>; readonly required?: boolean };
interface StoryNodeBase { readonly id: string }
export interface StorySayNode extends StoryNodeBase { readonly type: "say"; readonly speaker?: string; readonly segments: readonly StoryTextSegment[]; /** Characters per second; defaults to 32. */ readonly speed?: number; readonly next: string }
export interface StoryChoiceOption { readonly id: string; readonly text: string; readonly when?: StoryCondition; readonly enabledWhen?: StoryCondition; readonly disabledReason?: string; readonly next: string }
export interface StoryChoiceNode extends StoryNodeBase { readonly type: "choice"; readonly prompt?: string; readonly options: readonly StoryChoiceOption[]; readonly required?: boolean; readonly skipTo?: string }
export interface StoryPresentNode extends StoryNodeBase { readonly type: "present"; readonly action: StoryAction; readonly next: string }
export interface StoryCommand { readonly type: string; readonly apiVersion: number; readonly args: Readonly<Record<string, unknown>> }
export interface StoryCommandNode extends StoryNodeBase { readonly type: "command"; readonly command: StoryCommand; /** Defaults to execute; omit also applies to an already waiting command. */ readonly onSkip?: "omit"; readonly next: string }
export type StoryNode = StorySayNode | StoryChoiceNode | StoryPresentNode | StoryCommandNode
  | (StoryNodeBase & { readonly type: "branch"; readonly branches: readonly { readonly when: StoryCondition; readonly next: string }[]; readonly otherwise: string })
  | (StoryNodeBase & { readonly type: "set"; readonly values: Readonly<Record<string, StoryValue>>; readonly next: string })
  | (StoryNodeBase & { readonly type: "call"; readonly sceneId: string; readonly entry?: string; readonly next: string })
  | (StoryNodeBase & { readonly type: "return" })
  | (StoryNodeBase & { readonly type: "end"; readonly result?: StoryScalar });
export interface StoryScene { readonly title?: string; readonly description?: string; /** Package-owned archive image; defaults to the package cover. */ readonly cover?: string; /** Read-only progress condition for notebook access; never queues playback or consumes a trigger. */ readonly archiveUnlock?: PublicCondition; readonly entry: string; readonly variables?: Readonly<Record<string, StoryScalar>>; readonly actors?: Readonly<Record<string, StoryActorDefinition>>; readonly nodes: readonly StoryNode[] }
export interface StoryBinding { readonly sceneId: string; readonly trigger: PublicTriggerSpec; readonly frequency?: "always" | "round" | "match" | "flow" | "game" | "save"; readonly priority?: number; readonly queue?: "append" | "replace-pending" | "drop-if-busy"; readonly recheck?: boolean; readonly scope?: "global" | "match" | "flow" }
export interface StoryChoiceView { readonly id: string; readonly text: string; readonly enabled: boolean; readonly disabledReason?: string }
export interface StoryCommandIntent extends StoryCommand { readonly id: string }
export type StoryWaiting = { readonly type: "say"; readonly node: StorySayNode }
  | { readonly type: "choice"; readonly node: StoryChoiceNode; readonly options: readonly StoryChoiceView[] }
  | { readonly type: "presentation"; readonly node: StoryPresentNode; readonly action: StoryAction }
  | { readonly type: "command"; readonly node: StoryCommandNode; readonly intent: StoryCommandIntent };
export interface StoryCommandReceipt { readonly id: string; readonly result?: Readonly<Record<string, StoryScalar>> }
export interface StoryRun { readonly id: string; readonly sceneId: string; readonly cursor: string; readonly stack: readonly { readonly sceneId: string; readonly cursor: string }[]; readonly variables: Readonly<Record<string, StoryScalar>>; readonly stage: StoryStage; /** Most recent visible portrait speaker in this scene. */ readonly lastSpeaker?: { readonly sceneId: string; readonly actorId: string }; readonly status: "running" | "waiting" | "completed" | "skipped" | "interrupted" | "failed"; readonly waiting?: StoryWaiting; readonly skipping: boolean; readonly sequence: number; readonly choices: readonly { readonly sceneId: string; readonly nodeId: string; readonly optionId: string }[]; readonly receipts: readonly StoryCommandReceipt[]; readonly error?: string; readonly result?: StoryScalar }
export interface StoryExtensionSchema { safeParse(value: unknown): { success: boolean; data?: unknown; error?: unknown } }
export interface StoryExtensionContext { readonly runId: string; readonly signal: AbortSignal; /** Host-owned elapsed time since the previous tick, frozen while paused. */ readonly clock?: { readonly paused: boolean; subscribe(tick: (deltaMs: number) => void): () => void } }
/** Presentation extensions own their media clock, never the game's domain state. */
export interface StoryActionExtension { readonly type: string; readonly apiVersion: number; readonly schema: StoryExtensionSchema; execute(args: unknown, context: StoryExtensionContext): void | Promise<void>; fastForward(args: unknown, context: StoryExtensionContext): void | Promise<void>; restore(args: unknown, context: StoryExtensionContext): void | Promise<void>; cancel(args: unknown, context: StoryExtensionContext): void | Promise<void> }
/** Describes a host-owned legal command. Projection and atomic persistence belong to the host. */
export interface StoryCommandExtension { readonly type: string; readonly apiVersion: number; readonly schema: StoryExtensionSchema }
export interface StoryExtensionRegistry { action(type: string, apiVersion: number): StoryActionExtension | undefined; command(type: string, apiVersion: number): StoryCommandExtension | undefined }
export interface StoryEngineContext { resolveScene(id: string): StoryScene | undefined; readonly publicContext?: PublicQueryContext; readonly extensions?: StoryExtensionRegistry; readonly stepBudget?: number }

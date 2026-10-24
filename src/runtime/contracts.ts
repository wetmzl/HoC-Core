import type { LongTermSave } from "../persistence/schema";

export type RuntimeScreenId = "lobby" | "history" | "match";

export interface RuntimeNavigation {
  readonly id: RuntimeScreenId;
  readonly params?: Readonly<Record<string, unknown>>;
}

export interface MountedScreen {
  dispose(): void | Promise<void>;
}

export interface RuntimeScreenContext {
  readonly root: HTMLDivElement;
  getSave(): LongTermSave;
  navigate(destination: RuntimeNavigation): Promise<void>;
  reportNavigationError(message: string): void;
}

export interface RuntimeScreenModule {
  mount(context: RuntimeScreenContext, signal: AbortSignal, params?: Readonly<Record<string, unknown>>): Promise<MountedScreen>;
}

export type RuntimeScreenLoader = () => Promise<RuntimeScreenModule>;

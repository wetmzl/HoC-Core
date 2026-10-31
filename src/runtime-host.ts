import type { PluginSettingsSession } from "./content/packages/plugin-settings";
import type { PluginRuntimeContribution } from "./content/packages/plugin-contracts";

export interface GameRuntimeHandle {
  dispose(): Promise<void>;
}

export interface PreparedGamePresentation {
  readonly characters: readonly import("./content/characters").CharacterDefinition[];
  readonly contributions: readonly PluginRuntimeContribution[];
  activate(): void;
  rollback(): void;
  dispose(): void;
  retirePrevious(): void;
}
export interface MountGameRuntimeOptions {
  readonly telemetryPackages?: Readonly<Record<string, { package_id: string; package_version: string; package_name?: string }>>;
  readonly preparePresentation?: (preferences: import("./content/packages/character-presentation").CharacterSkinPreferences, unlocks?: import("./persistence/skin-unlocks").CharacterSkinUnlocks) => Promise<PreparedGamePresentation>;
  readonly characterSkinUnlocks?: import("./persistence/skin-unlocks").CharacterSkinUnlocks;
  readonly loadSkinPreviews?: (characterKey: string, signal: AbortSignal) => Promise<import("./content/packages/skin-previews").SkinPreviews>;
  readonly characterSkins?: import("./content/packages/character-presentation").CharacterSkinPreferences;
  readonly root: HTMLDivElement;
  readonly contributions?: readonly PluginRuntimeContribution[];
  readonly pluginSettings?: PluginSettingsSession;
  readonly pluginCredits?: readonly import("./content/packages/plugin-credits").PluginCreditsSection[];
  readonly onExitRequest?: () => Promise<void>;
}

let activeModule: typeof import("./match-screen") | undefined;

export async function requestGameRuntimeExit(): Promise<void> {
  if (!activeModule) throw new Error("游戏运行时尚未启动。");
  await activeModule.requestGameRuntimeExit();
}

export async function mountGameRuntime(options: MountGameRuntimeOptions): Promise<GameRuntimeHandle> {
  const module = await import("./match-screen");
  const runtime = await module.mountGameRuntime(options);
  activeModule = module;
  return {
    async dispose() {
      await runtime.dispose();
      if (activeModule === module) activeModule = undefined;
    }
  };
}

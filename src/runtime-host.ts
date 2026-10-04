import type { PluginRuntimeContribution } from "./content/packages/plugin-contracts";

export interface GameRuntimeHandle {
  dispose(): Promise<void>;
}

export interface MountGameRuntimeOptions {
  readonly root: HTMLDivElement;
  readonly contributions?: readonly PluginRuntimeContribution[];
  readonly onExitRequest?: () => Promise<void>;
}

let activeModule: typeof import("./match-screen") | undefined;

export async function requestGameRuntimeExit(): Promise<void> {
  if (!activeModule) throw new Error("游戏运行时尚未启动。");
  await activeModule.requestGameRuntimeExit();
}

export async function mountGameRuntime(options: MountGameRuntimeOptions): Promise<GameRuntimeHandle> {
  const module = await import("./match-screen");
  activeModule = module;
  const runtime = await module.mountGameRuntime(options);
  return {
    async dispose() {
      try { await runtime.dispose(); }
      finally { if (activeModule === module) activeModule = undefined; }
    }
  };
}

import { createGameRuntime } from "./runtime/create-game-runtime";
import type { RuntimeController } from "./runtime/game-runtime";
import type { GameRuntimeHandle, MountGameRuntimeOptions } from "./runtime-host";
import { mountAchievementUi } from "./presentation/achievement-ui";
export type { GameRuntimeHandle, MountGameRuntimeOptions } from "./runtime-host";

let active: RuntimeController | undefined;
let mounting = false;

/** Compatibility entry point. Mutable game state belongs to the runtime instance. */
export async function mountGameRuntime(options: MountGameRuntimeOptions): Promise<GameRuntimeHandle> {
  if (mounting || active) throw new Error("游戏运行时已经存在。");
  mounting = true;
  let disposeAchievements: (() => void) | undefined;
  try {
    disposeAchievements = mountAchievementUi(options.root);
    const runtime = createGameRuntime();
    const handle = await runtime.mountGameRuntime(options);
    active = runtime;
    let disposal: Promise<void> | undefined;
    return { dispose: () => {
      if (disposal) return disposal;
      disposal = handle.dispose().then(() => { disposeAchievements?.(); if (active === runtime) active = undefined; }).catch(error => {
        disposal = undefined;
        throw error;
      });
      return disposal;
    } };
  } catch (error) { disposeAchievements?.(); throw error; }
  finally { mounting = false; }
}
export async function requestGameRuntimeExit(): Promise<void> {
  if (!active) throw new Error("游戏运行时尚未启动。");
  await active.requestGameRuntimeExit();
}

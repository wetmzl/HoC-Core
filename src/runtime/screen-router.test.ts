import { describe, expect, it, vi } from "vitest";
import { createDefaultSave } from "../persistence/boot";
import type { MountedScreen, RuntimeScreenContext, RuntimeScreenModule } from "./contracts";
import { RuntimeScreenRouter } from "./screen-router";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function harness() {
  const errors: string[] = [];
  const context: RuntimeScreenContext = {
    root: {} as HTMLDivElement,
    getSave: () => createDefaultSave("2026-09-20T00:00:00.000Z"),
    navigate: async () => undefined,
    reportNavigationError: (message) => errors.push(message)
  };
  return { context, errors };
}

function screen(name: string, events: string[]): RuntimeScreenModule {
  return {
    async mount(_context, signal) {
      events.push(`mount:${name}`);
      signal.addEventListener("abort", () => { events.push(`abort:${name}`); }, { once: true });
      return { dispose: () => { events.push(`dispose:${name}`); } } satisfies MountedScreen;
    }
  };
}

describe("RuntimeScreenRouter", () => {
  it("caches successfully loaded modules and disposes the previous screen before mounting", async () => {
    const { context } = harness();
    const events: string[] = [];
    const lobbyLoader = vi.fn(async () => screen("lobby", events));
    const historyLoader = vi.fn(async () => screen("history", events));
    const router = new RuntimeScreenRouter(context, { lobby: lobbyLoader, history: historyLoader });

    await router.navigate({ id: "lobby" });
    await router.navigate({ id: "history" });
    await router.navigate({ id: "lobby" });

    expect(lobbyLoader).toHaveBeenCalledTimes(1);
    expect(historyLoader).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      "mount:lobby", "abort:lobby", "dispose:lobby",
      "mount:history", "abort:history", "dispose:history", "mount:lobby"
    ]);
  });

  it("keeps the current screen when an import fails and retries the failed loader", async () => {
    const { context, errors } = harness();
    const events: string[] = [];
    const historyLoader = vi.fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(screen("history", events));
    const router = new RuntimeScreenRouter(context, {
      lobby: async () => screen("lobby", events),
      history: historyLoader
    });

    await router.navigate({ id: "lobby" });
    await router.navigate({ id: "history" });
    expect(events).toEqual(["mount:lobby"]);
    expect(errors).toEqual(["页面加载失败，请重试。"]);

    await router.navigate({ id: "history" });
    expect(historyLoader).toHaveBeenCalledTimes(2);
    expect(events).toContain("mount:history");
  });

  it("ignores a slow stale import and disposes the final mounted screen", async () => {
    const { context } = harness();
    const events: string[] = [];
    const slow = deferred<RuntimeScreenModule>();
    const router = new RuntimeScreenRouter(context, {
      lobby: async () => screen("lobby", events),
      history: () => slow.promise,
      match: async () => screen("match", events)
    });

    await router.navigate({ id: "lobby" });
    const staleNavigation = router.navigate({ id: "history" });
    await router.navigate({ id: "match" });
    slow.resolve(screen("history", events));
    await staleNavigation;
    await router.dispose();

    expect(events).not.toContain("mount:history");
    expect(events.slice(-2)).toEqual(["abort:match", "dispose:match"]);
  });
});

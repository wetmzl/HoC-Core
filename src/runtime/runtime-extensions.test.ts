import { describe, expect, it, vi } from "vitest";
import type { PluginGameRuntimeContext, PluginRuntimeContribution } from "../content/packages/plugin-contracts";
import { createDefaultSave } from "../persistence/boot";
import { RuntimeExtensions } from "./runtime-extensions";
import { bindPluginTutorialIdentity, type PluginTutorialApi } from "../content/packages/plugin-tutorials";

function extensions(contributions: readonly PluginRuntimeContribution[], createTutorialApi?: (packageId: string, signal: AbortSignal) => PluginTutorialApi) {
  return new RuntimeExtensions({
    context: {
      root: new EventTarget() as HTMLDivElement,
      audio: { setBgmScene() {} },
      resources: {} as never,
      getSave: () => createDefaultSave(),
      navigateToHistory: async () => {},
      navigateToExtension: async () => {}
    },
    contributions,
    createTutorialApi,
    getMatch: () => undefined,
    dispatch: vi.fn(),
    autoActionsChanged: vi.fn()
  });
}

describe("RuntimeExtensions cleanup", () => {
  it("attempts every release once in reverse order and clears subscriptions even when releases throw", async () => {
    const order: string[] = [];
    const firstError = new Error("first cleanup failed");
    const lastError = new Error("last cleanup failed");
    const subscriber = vi.fn();
    let signal!: AbortSignal;
    let context!: PluginGameRuntimeContext;
    const runtime = extensions([
      { mountRuntime(current, currentSignal) {
        context = current;
        signal = currentSignal;
        context.game.subscribe(subscriber);
        context.game.pauseAutoActions();
        return () => { order.push("first"); throw firstError; };
      } },
      { mountRuntime: () => () => { order.push("middle"); } },
      { mountRuntime: () => () => { order.push("last"); throw lastError; } }
    ]);
    await runtime.mount();
    expect(runtime.paused).toBe(true);

    let failure: unknown;
    try { runtime.dispose(); } catch (error) { failure = error; }

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([lastError, firstError]);
    expect(order).toEqual(["last", "middle", "first"]);
    expect(signal.aborted).toBe(true);
    expect(runtime.paused).toBe(false);
    runtime.notify();
    expect(subscriber).not.toHaveBeenCalled();
    context.game.pauseAutoActions();
    expect(runtime.paused).toBe(false);
    expect(() => runtime.dispose()).not.toThrow();
    expect(order).toEqual(["last", "middle", "first"]);
  });

  it("preserves the mount failure alongside cleanup failures and releases earlier plugins", async () => {
    const mountError = new Error("plugin mount failed");
    const cleanupError = new Error("plugin cleanup failed");
    const firstRelease = vi.fn();
    const failingRelease = vi.fn(() => { throw cleanupError; });
    const laterMount = vi.fn();
    const runtime = extensions([
      { mountRuntime: () => firstRelease },
      { mountRuntime: () => failingRelease },
      { mountRuntime: () => { throw mountError; } },
      { mountRuntime: laterMount }
    ]);

    const failure = await runtime.mount().catch(error => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors[0]).toBe(mountError);
    expect(failure.errors[1]).toBeInstanceOf(AggregateError);
    expect(failure.errors[1].errors).toEqual([cleanupError]);
    expect(firstRelease).toHaveBeenCalledOnce();
    expect(failingRelease).toHaveBeenCalledOnce();
    expect(laterMount).not.toHaveBeenCalled();
    runtime.dispose();
    expect(firstRelease).toHaveBeenCalledOnce();
    expect(failingRelease).toHaveBeenCalledOnce();
  });

  it("releases a late mount result after disposal without rerunning earlier releases", async () => {
    let finish!: (release: () => void) => void;
    const firstRelease = vi.fn();
    const lateRelease = vi.fn();
    const runtime = extensions([
      { mountRuntime: () => firstRelease },
      { mountRuntime: () => new Promise(resolve => { finish = resolve; }) }
    ]);
    const mounting = runtime.mount();
    await vi.waitFor(() => expect(finish).toBeDefined());
    runtime.dispose();
    finish(lateRelease);
    await mounting;
    runtime.dispose();
    expect(firstRelease).toHaveBeenCalledOnce();
    expect(lateRelease).toHaveBeenCalledOnce();
  });
});

it("provides separate package-scoped tutorial contexts only to loader-bound API 10 modules", async () => {
  const contexts: PluginGameRuntimeContext[] = [];
  const mount = (context: PluginGameRuntimeContext) => { contexts.push(context); };
  const identities: string[] = [];
  const signals: AbortSignal[] = [];
  const show = vi.fn();
  const runtime = extensions([
    bindPluginTutorialIdentity({ mountRuntime: mount }, { packageId: "one/guide", apiVersion: 10 }),
    bindPluginTutorialIdentity({ mountRuntime: mount }, { packageId: "two/guide", apiVersion: 10 }),
    bindPluginTutorialIdentity({ mountRuntime: mount }, { packageId: "old/guide", apiVersion: 9 }),
    { mountRuntime: mount, packageId: "forged/guide", apiVersion: 10 } as PluginRuntimeContribution
  ], (packageId, signal) => {
    identities.push(packageId); signals.push(signal);
    return { show: definition => { show(packageId, definition.id); return () => {}; }, isCompleted: () => false };
  });
  await runtime.mount();
  expect(identities).toEqual(["one/guide", "two/guide"]);
  expect(new Set(contexts).size).toBe(4);
  expect(contexts[0].tutorials).not.toBe(contexts[1].tutorials);
  expect("tutorials" in contexts[2]).toBe(false);
  expect("tutorials" in contexts[3]).toBe(false);
  const tutorial = { id: "intro", title: "Guide", pages: [{ body: "Explanation" }] } as const;
  contexts[0].tutorials!.show(tutorial);
  contexts[1].tutorials!.show(tutorial);
  expect(show.mock.calls).toEqual([["one/guide", "intro"], ["two/guide", "intro"]]);
  runtime.dispose();
  expect(signals.every(signal => signal.aborted)).toBe(true);
});

it("shares host modal and plugin auto-action pauses and releases each token once", async () => {
  let context!: PluginGameRuntimeContext;
  const runtime = extensions([{ mountRuntime: current => { context = current; } }]);
  await runtime.mount();
  const hostRelease = runtime.pauseAutoActions();
  const pluginRelease = context.game.pauseAutoActions();
  expect(runtime.paused).toBe(true);
  hostRelease(); hostRelease();
  expect(runtime.paused).toBe(true);
  pluginRelease();
  expect(runtime.paused).toBe(false);
  runtime.dispose();
  runtime.pauseAutoActions();
  expect(runtime.paused).toBe(false);
});
